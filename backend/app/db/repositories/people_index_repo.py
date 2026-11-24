"""People analytics' index — built from history, then kept up.

Two jobs, both backfills on their first run and incremental after that, both resumable from a
cursor (``people_index_cursors``) and both safe to run twice:

1. **Attribute.** ``product_events.workspace_id`` for the usage signals recorded without one,
   which is every one recorded before the client started sending it:

   * a view open belongs to its view's workspace — a fact, looked up once per view;
   * a trace, a search or an export belongs to the workspace of the view the same person
     opened LAST, if that was within ``INFER_WINDOW`` — an inference, and the same one a
     person reading the log would make: traces and searches happen on the canvas of a view
     someone just opened. A signal with no such open stays unattributed rather than guessed.

   Rows are walked oldest first in keyset order, so a restart resumes where it stopped and
   the cursor says how far history has been attributed.

2. **Roll up.** ``person_workspace_activity``: when each person joined each workspace, and
   was first and last active in it (and on the platform as a whole, ``workspace_id = ''``).
   Read from all three activity stores in time slices; joins from role bindings, group
   membership and the ledger's member events. Every column only moves one way — earlier for
   ``joined_at``/``first_active_at``, later for ``last_active_at`` — so each write is a
   min/max upsert, and a slice processed twice changes nothing.

Rows newer than ``LAG`` are left for the next pass, so a transaction still committing when a
slice is read is not skipped. Every read is one table; ids are stitched in Python.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from sqlalchemy import and_, bindparam, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AuthAuditLogORM,
    GroupMemberORM,
    PeopleIndexCursorORM,
    PersonWorkspaceActivityORM,
    ProductEventORM,
    RoleBindingORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
)
from backend.app.db.repositories.analytics_repo import (
    GRAPH_EXPORT,
    SEARCH_MISS,
    SEARCH_RUN,
    TRACE_EMPTY,
    TRACE_RUN,
    VIEW_OPENED,
    _chunked,
)
from backend.app.services.activity import catalogue
from backend.common.service_accounts import is_person, is_service_account

#: ``person_workspace_activity.workspace_id`` for the platform as a whole.
PLATFORM = ""

CURSOR_ATTRIBUTE = "attribute"
CURSOR_USAGE = "rollup.usage"
CURSOR_EDITS = "rollup.edits"
CURSOR_LEDGER = "rollup.ledger"
CURSOR_JOINS = "joins"
ROLLUP_CURSORS = (CURSOR_USAGE, CURSOR_EDITS, CURSOR_LEDGER)

#: Left for the next pass: long enough for any request's transaction to have committed.
LAG = timedelta(minutes=2)

#: How long after opening a view a trace or search is taken to have happened in it.
INFER_WINDOW = timedelta(minutes=30)

ATTRIBUTE_BATCH = 5_000

#: One rollup step reads this much history from each source. A day of a busy platform is a
#: few hundred thousand rows grouped to a few thousand, which keeps a step to well under a
#: second and its transaction short.
ROLLUP_SLICE = timedelta(days=1)

_BY_VIEW = (VIEW_OPENED,)
_INFERRED = (TRACE_RUN, TRACE_EMPTY, SEARCH_RUN, SEARCH_MISS, GRAPH_EXPORT)

#: The usage signals that count as someone being active. Docs and tours count too — they
#: are someone using the product — but section moves are presence, not activity.
_ACTIVE_USAGE = (
    VIEW_OPENED, TRACE_RUN, TRACE_EMPTY, SEARCH_RUN, SEARCH_MISS, GRAPH_EXPORT,
    "docs.feedback", "docs.search_miss", "tour.completed", "tour.skipped", "onboarding.step",
)

_SIGN_IN = "user.logged_in"
_MIRRORED = "visualization.view."
_ADMIN_VIEWED = "admin_viewed"
_MEMBER_EVENTS = ("rbac.workspace.member_bound", "rbac.workspace.member_joined")

_UPSERT_CHUNK = 500


def _iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat()


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        at = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def _insert(session: AsyncSession):
    if session.get_bind().dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert


# ── Cursors ───────────────────────────────────────────────────────────


async def get_cursor(session: AsyncSession, name: str) -> Optional[PeopleIndexCursorORM]:
    return await session.get(PeopleIndexCursorORM, name)


async def _advance(
    session: AsyncSession, name: str, through: str, *, through_id: Optional[str] = None,
    started_at: Optional[str] = None,
) -> None:
    row = await session.get(PeopleIndexCursorORM, name)
    now = _iso(datetime.now(timezone.utc))
    if row is None:
        session.add(PeopleIndexCursorORM(
            name=name, through=through, through_id=through_id,
            started_at=started_at or through, updated_at=now,
        ))
    else:
        row.through = through
        row.through_id = through_id
        if started_at and not row.started_at:
            row.started_at = started_at
        row.updated_at = now
    await session.flush()


# ── Upsert ────────────────────────────────────────────────────────────


def _earlier(current, incoming):
    return case(
        (incoming.is_(None), current), (current.is_(None), incoming),
        (incoming < current, incoming), else_=current,
    )


def _later(current, incoming):
    return case(
        (incoming.is_(None), current), (current.is_(None), incoming),
        (incoming > current, incoming), else_=current,
    )


async def upsert(session: AsyncSession, rows: Iterable[dict]) -> int:
    """Fold ``rows`` into ``person_workspace_activity``, moving each column only its own way.

    Rows go in key order, so two writers with overlapping batches take their row locks in the
    same order and cannot deadlock (the indexer's advisory lock should make that moot)."""
    merged: dict[tuple[str, str], dict] = {}
    for r in rows:
        uid, ws = r.get("user_id"), r.get("workspace_id")
        if not uid or ws is None or is_service_account(uid):
            continue
        cur = merged.setdefault((uid, ws), {"user_id": uid, "workspace_id": ws,
                                            "joined_at": None, "first_active_at": None,
                                            "last_active_at": None})
        for key, pick in (("joined_at", min), ("first_active_at", min), ("last_active_at", max)):
            value = r.get(key)
            if value:
                cur[key] = value if cur[key] is None else pick(cur[key], value)
    if not merged:
        return 0
    now = _iso(datetime.now(timezone.utc))
    T = PersonWorkspaceActivityORM.__table__
    insert = _insert(session)
    ordered = [merged[k] | {"updated_at": now} for k in sorted(merged)]
    for start in range(0, len(ordered), _UPSERT_CHUNK):
        stmt = insert(T).values(ordered[start:start + _UPSERT_CHUNK])
        ex = stmt.excluded
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "workspace_id"],
            set_={
                "joined_at": _earlier(T.c.joined_at, ex.joined_at),
                "first_active_at": _earlier(T.c.first_active_at, ex.first_active_at),
                "last_active_at": _later(T.c.last_active_at, ex.last_active_at),
                "updated_at": ex.updated_at,
            },
        )
        await session.execute(stmt)
    return len(ordered)


# ── 1. Attribute ──────────────────────────────────────────────────────


async def _view_homes(session: AsyncSession, view_ids: Iterable[str]) -> dict[str, str]:
    """``{view_id: workspace_id}``, deleted views included — their opens happened."""
    out: dict[str, str] = {}
    for chunk in _chunked(sorted({v for v in view_ids if v})):
        out.update({
            vid: ws for vid, ws in (await session.execute(
                select(ViewORM.id, ViewORM.workspace_id).where(ViewORM.id.in_(chunk))
            )).all() if ws
        })
    return out


async def attribute_batch(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Attribute the next batch of unattributed signals. Returns how many rows it looked at;
    0 means attribution has caught up to ``now - LAG``."""
    now = now or datetime.now(timezone.utc)
    upper = _iso(now - LAG)
    T = ProductEventORM
    cursor = await get_cursor(session, CURSOR_ATTRIBUTE)
    where = [
        T.event_type.in_(_BY_VIEW + _INFERRED), T.workspace_id.is_(None),
        T.actor_id.is_not(None), T.created_at <= upper,
    ]
    if cursor and cursor.through:
        where.append(or_(
            T.created_at > cursor.through,
            and_(T.created_at == cursor.through, T.id > (cursor.through_id or "")),
        ))
    rows = (await session.execute(
        select(T.id, T.created_at, T.event_type, T.actor_id, T.subject_id)
        .where(*where).order_by(T.created_at, T.id).limit(ATTRIBUTE_BATCH)
    )).all()
    if not rows:
        # Nothing left up to the lag line: the cursor still moves, so "attributed through"
        # reads as current rather than as the time of the last signal that needed it.
        if not cursor or not cursor.through or cursor.through < upper:
            await _advance(session, CURSOR_ATTRIBUTE, upper, through_id="")
        return 0

    inferred = [r for r in rows if r.event_type in _INFERRED]
    opens: dict[str, list[tuple[str, str]]] = defaultdict(list)
    if inferred:
        first = _parse(inferred[0].created_at)
        lo = _iso(first - INFER_WINDOW) if first else inferred[0].created_at
        hi = inferred[-1].created_at
        for chunk in _chunked(sorted({r.actor_id for r in inferred})):
            for actor, at, subject in (await session.execute(
                select(T.actor_id, T.created_at, T.subject_id)
                .where(T.event_type == VIEW_OPENED, T.actor_id.in_(chunk),
                       T.created_at >= lo, T.created_at <= hi, T.subject_id.is_not(None))
                .order_by(T.created_at)
            )).all():
                opens[actor].append((at, subject))

    homes = await _view_homes(
        session,
        [r.subject_id for r in rows if r.event_type == VIEW_OPENED]
        + [s for pairs in opens.values() for _, s in pairs],
    )
    stamps = {actor: [at for at, _ in pairs] for actor, pairs in opens.items()}

    updates = []
    for r in rows:
        ws = None
        if r.event_type == VIEW_OPENED:
            ws = homes.get(r.subject_id)
        else:
            pairs = opens.get(r.actor_id)
            if pairs:
                i = bisect_right(stamps[r.actor_id], r.created_at) - 1
                if i >= 0:
                    opened_at, subject = pairs[i]
                    gap = (_parse(r.created_at) or now) - (_parse(opened_at) or now)
                    if gap <= INFER_WINDOW:
                        ws = homes.get(subject)
        if ws:
            updates.append({"row_id": r.id, "ws": ws})
    if updates:
        table = T.__table__
        await session.execute(
            update(table).where(table.c.id == bindparam("row_id"))
            .values(workspace_id=bindparam("ws")),
            updates,
        )
    last = rows[-1]
    await _advance(session, CURSOR_ATTRIBUTE, last.created_at, through_id=last.id,
                   started_at=rows[0].created_at)
    return len(rows)


# ── 2. Roll up ────────────────────────────────────────────────────────


async def _slice(
    session: AsyncSession, name: str, ts_col, *, upper: str, first_where: list,
) -> Optional[tuple[str, str, bool]]:
    """The next (start, end, inclusive_start) slice of one source, or ``None`` when it has
    caught up. The very first slice starts AT the oldest row; later ones just after the last
    slice's end."""
    cursor = await get_cursor(session, name)
    if cursor and cursor.through:
        start, inclusive = cursor.through, False
    else:
        start = (await session.execute(
            select(func.min(ts_col)).where(*first_where))).scalar()
        if start is None:
            await _advance(session, name, upper)
            return None
        inclusive = True
    begin = _parse(start)
    if begin is None or start >= upper:
        return None
    end = min(_iso(begin + ROLLUP_SLICE), upper)
    return start, end, inclusive


def _range(col, start: str, end: str, inclusive: bool) -> list:
    return [(col >= start) if inclusive else (col > start), col <= end]


def _rows_for(grouped: Iterable[tuple], *, workspace_ok=lambda *_: True) -> list[dict]:
    """(actor, workspace, first, last[, audience]) groups → upsert rows: one per workspace
    the person was active in, and one for the platform as a whole."""
    out: list[dict] = []
    for actor, ws, first, last, *extra in grouped:
        if not actor or is_service_account(actor):
            continue
        out.append({"user_id": actor, "workspace_id": PLATFORM,
                    "first_active_at": first, "last_active_at": last})
        if ws and workspace_ok(*extra):
            out.append({"user_id": actor, "workspace_id": ws,
                        "first_active_at": first, "last_active_at": last})
    return out


async def rollup_usage_slice(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """One slice of usage signals into the rollup. Waits for attribution: a slice is only
    read once every row in it has been given its workspace."""
    now = now or datetime.now(timezone.utc)
    attributed = await get_cursor(session, CURSOR_ATTRIBUTE)
    if not attributed or not attributed.through:
        return 0
    upper = min(attributed.through, _iso(now - LAG))
    T = ProductEventORM
    active = [T.event_type.in_(_ACTIVE_USAGE), T.actor_id.is_not(None), is_person(T.actor_id)]
    window = await _slice(session, CURSOR_USAGE, T.created_at, upper=upper, first_where=active)
    if window is None:
        return 0
    start, end, inclusive = window
    grouped = (await session.execute(
        select(T.actor_id, T.workspace_id, func.min(T.created_at), func.max(T.created_at))
        .where(*active, *_range(T.created_at, start, end, inclusive))
        .group_by(T.actor_id, T.workspace_id)
    )).all()
    await upsert(session, _rows_for(grouped))
    await _advance(session, CURSOR_USAGE, end, started_at=start)
    return 1


async def rollup_edits_slice(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    now = now or datetime.now(timezone.utc)
    T = ViewActivityLogORM
    # An admin opening a private view is auditor-only; it moves no workspace's timeline.
    active = [T.actor.is_not(None), is_person(T.actor), T.action != _ADMIN_VIEWED]
    window = await _slice(session, CURSOR_EDITS, T.created_at, upper=_iso(now - LAG),
                          first_where=active)
    if window is None:
        return 0
    start, end, inclusive = window
    grouped = (await session.execute(
        select(T.actor, T.workspace_id, func.min(T.created_at), func.max(T.created_at))
        .where(*active, *_range(T.created_at, start, end, inclusive))
        .group_by(T.actor, T.workspace_id)
    )).all()
    await upsert(session, _rows_for(grouped))
    await _advance(session, CURSOR_EDITS, end, started_at=start)
    return 1


async def rollup_ledger_slice(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """One slice of the ledger. Sliced by ``recorded_at`` — when the relay wrote the row,
    which only moves forward — and folded by ``occurred_at``, when it happened.

    A workspace's timeline takes only its workspace-audience rows: the timeline is read by
    that workspace's admins, and these are the rows the Activity explorer shows them."""
    now = now or datetime.now(timezone.utc)
    T = AuthAuditLogORM
    active = [
        T.actor_kind == "user", T.actor_id.is_not(None), is_person(T.actor_id),
        T.event_type != _SIGN_IN, ~T.event_type.startswith(_MIRRORED, autoescape=True),
    ]
    window = await _slice(session, CURSOR_LEDGER, T.recorded_at, upper=_iso(now - LAG),
                          first_where=active)
    if window is None:
        return 0
    start, end, inclusive = window
    grouped = (await session.execute(
        select(T.actor_id, T.workspace_id, func.min(T.occurred_at), func.max(T.occurred_at),
               T.audience)
        .where(*active, *_range(T.recorded_at, start, end, inclusive))
        .group_by(T.actor_id, T.workspace_id, T.audience)
    )).all()
    await upsert(session, _rows_for(
        grouped, workspace_ok=lambda audience: audience == catalogue.AUDIENCE_WORKSPACE))
    await _advance(session, CURSOR_LEDGER, end, started_at=start)
    return 1


async def join_candidates(
    session: AsyncSession, *, since: Optional[str] = None, upper: Optional[str] = None,
    workspace_id: Optional[str] = None, user_id: Optional[str] = None,
) -> dict[tuple[str, str], str]:
    """When each person got access to each workspace, from what grants it TODAY and from the
    ledger's memory of what granted it before.

    * a binding of the person: when it was granted;
    * a binding of a group they are in: the later of the group's grant and their joining the
      group — they had access from whichever came second;
    * ``rbac.workspace.member_bound`` / ``member_joined`` in the ledger: kept after a binding
      is removed, so someone who left and came back is shown when they FIRST joined.

    ``since``/``upper`` restrict to what changed in that span (the indexer); without them,
    everything current (a read that must not wait for the indexer). Expired grants still
    count: having joined is a fact about the past.
    """
    RB, GM, L = RoleBindingORM, GroupMemberORM, AuthAuditLogORM
    out: dict[tuple[str, str], str] = {}

    def offer(uid: Optional[str], ws: Optional[str], at: Optional[str]) -> None:
        if not (uid and ws and at) or is_service_account(uid):
            return
        if user_id and uid != user_id:
            return
        key = (uid, ws)
        if key not in out or at < out[key]:
            out[key] = at

    def span(col) -> list:
        return ([col > since] if since else []) + ([col <= upper] if upper else [])

    ws_scope = [RB.scope_type == "workspace", RB.scope_id.is_not(None)]
    if workspace_id:
        ws_scope.append(RB.scope_id == workspace_id)

    direct = [*ws_scope, RB.subject_type == "user", *span(RB.granted_at)]
    if user_id:
        direct.append(RB.subject_id == user_id)
    for uid, ws, at in (await session.execute(
        select(RB.subject_id, RB.scope_id, RB.granted_at).where(*direct)
    )).all():
        offer(uid, ws, at)

    # Through a group: from the later of the group's grant and the person joining the group.
    # Incrementally that is two reads of what changed — groups newly granted a workspace (all
    # their members), and people newly added to a group (all that group's grants) — rather
    # than every membership in the tenancy on every pass.
    group_scope = [*ws_scope, RB.subject_type == "group"]

    async def _members(group_ids: list[str], extra: list) -> list[tuple]:
        rows: list[tuple] = []
        for chunk in _chunked(sorted(set(group_ids))):
            where = [GM.group_id.in_(chunk), *extra]
            if user_id:
                where.append(GM.user_id == user_id)
            rows += (await session.execute(
                select(GM.group_id, GM.user_id, GM.added_at).where(*where))).all()
        return rows

    def _fold(grants: list[tuple], members: list[tuple]) -> None:
        by_group: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for gid, ws, granted in grants:
            by_group[gid].append((ws, granted))
        for gid, uid, added in members:
            for ws, granted in by_group.get(gid, ()):
                offer(uid, ws, max(granted or "", added or ""))

    new_grants = (await session.execute(
        select(RB.subject_id, RB.scope_id, RB.granted_at)
        .where(*group_scope, *span(RB.granted_at))
    )).all()
    if new_grants:
        _fold(new_grants, await _members([g for g, _, _ in new_grants], []))
    if since:
        joined_groups = await _members_added(session, since=since, upper=upper, user_id=user_id)
        if joined_groups:
            grants: list[tuple] = []
            for chunk in _chunked(sorted({g for g, _, _ in joined_groups})):
                grants += (await session.execute(
                    select(RB.subject_id, RB.scope_id, RB.granted_at)
                    .where(*group_scope, RB.subject_id.in_(chunk))
                )).all()
            _fold(grants, joined_groups)

    ledger = [L.event_type.in_(_MEMBER_EVENTS), L.workspace_id.is_not(None),
              L.subject_id.is_not(None), *span(L.recorded_at)]
    if workspace_id:
        ledger.append(L.workspace_id == workspace_id)
    if user_id:
        ledger.append(L.subject_id == user_id)
    for uid, ws, at in (await session.execute(
        select(L.subject_id, L.workspace_id, L.occurred_at).where(*ledger)
    )).all():
        offer(uid, ws, at)
    return out


async def _members_added(
    session: AsyncSession, *, since: str, upper: Optional[str], user_id: Optional[str],
) -> list[tuple]:
    GM = GroupMemberORM
    where = [GM.added_at > since] + ([GM.added_at <= upper] if upper else [])
    if user_id:
        where.append(GM.user_id == user_id)
    return (await session.execute(
        select(GM.group_id, GM.user_id, GM.added_at).where(*where))).all()


async def joins_pass(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """Fold every grant made since the last pass into ``joined_at``."""
    now = now or datetime.now(timezone.utc)
    upper = _iso(now - LAG)
    cursor = await get_cursor(session, CURSOR_JOINS)
    since = cursor.through if cursor else None
    if since and since >= upper:
        return 0
    found = await join_candidates(session, since=since, upper=upper)
    # A ledger member event can name a group, not a person; keep the people.
    real: set[str] = set()
    for chunk in _chunked(sorted({uid for uid, _ in found})):
        real.update((await session.execute(
            select(UserORM.id).where(UserORM.id.in_(chunk)))).scalars().all())
    written = await upsert(session, (
        {"user_id": uid, "workspace_id": ws, "joined_at": at}
        for (uid, ws), at in found.items() if uid in real
    ))
    await _advance(session, CURSOR_JOINS, upper, started_at=since or upper)
    return written


# ── Reads ─────────────────────────────────────────────────────────────


def _row(r: PersonWorkspaceActivityORM) -> dict:
    return {"joinedAt": r.joined_at, "firstActiveAt": r.first_active_at,
            "lastActiveAt": r.last_active_at}


async def timeline_for_workspace(
    session: AsyncSession, workspace_id: str, user_ids: Optional[Iterable[str]] = None,
) -> dict[str, dict]:
    """``{user_id: {joinedAt, firstActiveAt, lastActiveAt}}`` for one workspace (``''`` for the
    platform), optionally for the given people only."""
    T = PersonWorkspaceActivityORM
    out: dict[str, dict] = {}
    if user_ids is None:
        for r in (await session.execute(
            select(T).where(T.workspace_id == workspace_id))).scalars().all():
            out[r.user_id] = _row(r)
        return out
    for chunk in _chunked(sorted({u for u in user_ids if u})):
        for r in (await session.execute(
            select(T).where(T.workspace_id == workspace_id, T.user_id.in_(chunk))
        )).scalars().all():
            out[r.user_id] = _row(r)
    return out


async def timeline_for_person(session: AsyncSession, user_id: str) -> dict[str, dict]:
    """``{workspace_id: {...}}`` for one person, the platform row under ``''``."""
    T = PersonWorkspaceActivityORM
    return {
        r.workspace_id: _row(r)
        for r in (await session.execute(select(T).where(T.user_id == user_id))).scalars().all()
    }


async def coverage(session: AsyncSession, *, now: Optional[datetime] = None) -> dict:
    """How far the index has got, for the page to say so while a backfill runs.

    ``through`` is the oldest of the rollup cursors — the instant up to which every source
    has been indexed. ``None`` everywhere means the indexer has never run here (it runs on
    the scheduler-owner role), and the page falls back to what it can read live."""
    now = now or datetime.now(timezone.utc)
    rows = {
        r.name: r for r in (await session.execute(select(PeopleIndexCursorORM))).scalars().all()
    }

    def at(name: str) -> Optional[str]:
        return rows[name].through if name in rows else None

    rolled = [at(n) for n in ROLLUP_CURSORS]
    through = min(rolled) if all(rolled) else None
    started = [rows[n].started_at for n in rows if rows[n].started_at]
    since = min(started) if started else None
    lagging = through is None or (_parse(through) or now) < now - timedelta(hours=1)
    progress = None
    if since and through:
        begin, end = _parse(since), _parse(through)
        if begin and end and now > begin:
            progress = round(max(0.0, min(1.0, (end - begin) / (now - begin))), 3)
    return {
        "attributedThrough": at(CURSOR_ATTRIBUTE),
        "activityThrough": through,
        "joinsThrough": at(CURSOR_JOINS),
        "historyFrom": since,
        "backfilling": bool(rows) and lagging,
        "running": bool(rows),
        "progress": progress,
    }


def merge_join(timeline: dict, current: Optional[str]) -> Optional[str]:
    """The earlier of the indexed join and what current grants say — so a member added a
    minute ago, before the indexer has seen them, still shows when they joined."""
    indexed = timeline.get("joinedAt") if timeline else None
    if indexed and current:
        return min(indexed, current)
    return indexed or current


__all__: list[Any] = [
    "PLATFORM", "attribute_batch", "rollup_usage_slice", "rollup_edits_slice",
    "rollup_ledger_slice", "joins_pass", "join_candidates", "timeline_for_workspace",
    "timeline_for_person", "coverage", "merge_join", "upsert",
]
