"""People analytics' index — built from history, then kept current, one UTC day at a time.

The People roster must cost people × days, not events: at thousands of people and a year's
window, raw events are tens of millions of rows. So the indexer folds each day's raw events —
``product_events``, ``view_activity_log`` and the activity ledger — into a rollup of one row
per (day, person, workspace, kind) (``person_activity_daily``), plus the same day without the
person, by hour and by event type (``people_daily_facets``). Every request-path read of a
roster comes from there.

THE UNIT OF WORK IS A DAY (:func:`index_day`):

1. Give the day's usage signals their workspace. A view open belongs to its view's workspace —
   a fact. A trace, a search or an export belongs to the workspace of the view the same person
   opened last, if within ``INFER_WINDOW`` — an inference, the one a person reading the log
   would make. A signal with no such open stays unattributed rather than guessed.
2. Fold the day's raw events into rollup rows, in memory: one grouped read per store.
3. Replace the day's rows: delete, then insert. A day is always the exact fold of its events,
   never an increment that could drift, so computing it twice changes nothing.
4. Fold the day into ``person_workspace_activity`` (joined / first / last active), whose
   columns only ever move one way, so that is idempotent too.

WHICH DAY NEXT (:func:`step`): joins; then today (every minute) and yesterday (until it has
closed); then days a late ledger row made dirty; then history, newest first — so the ranges
people open first are complete first; then retention. Days older than raw retention are never
recomputed: the raw rows are gone, and recomputing would empty them.

Every read is one table; ids are stitched in Python.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy import case, delete, func, insert as sa_insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AuthAuditLogORM,
    GroupMemberORM,
    PeopleDailyFacetORM,
    PeopleIndexCursorORM,
    PeopleIndexDayORM,
    PersonActivityDailyORM,
    PersonDailyTotalORM,
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
from backend.app.db.repositories.people_kinds import (
    ACTION_KINDS,
    SECTION,
    SECTION_BITS,
    SECTION_KIND_PREFIX,
    USAGE_KINDS,
    _ADMIN_VIEWED,
    _MIRRORED_LEDGER_PREFIX,
    edit_type,
    kind_of,
    ledger_kind,
    section_kind,
)
from backend.app.services.activity import catalogue
from backend.common.service_accounts import is_person, is_service_account

#: ``workspace_id`` for no workspace — the platform as a whole in ``person_workspace_activity``,
#: and events that happened in no workspace in the rollup.
PLATFORM = ""

#: ``workspace_id`` for everywhere in ``person_daily_totals`` and ``people_daily_facets``: the
#: platform's figures, so a platform read never sums over workspaces.
EVERYWHERE = "*"

CURSOR_JOINS = "joins"
#: How far the ledger has been read for rows recorded after their day was computed.
CURSOR_LEDGER = "ledger.recorded"
#: The oldest day computed contiguously back from yesterday; ``started_at`` is history's start.
CURSOR_BACKFILL = "backfill"

#: Left for the next pass: long enough for any request's transaction to have committed.
LAG = timedelta(minutes=2)

#: How long after opening a view a trace or search is taken to have happened in it.
INFER_WINDOW = timedelta(minutes=30)

#: How stale today's rollup may get before the indexer computes it again.
HOT_REFRESH = timedelta(seconds=60)

#: Rollup days older than this are purged: no window or calendar reaches past a year.
ROLLUP_KEEP_DAYS = 400

_INFERRED = (TRACE_RUN, TRACE_EMPTY, SEARCH_RUN, SEARCH_MISS, GRAPH_EXPORT)
_MEMBER_EVENTS = ("rbac.workspace.member_bound", "rbac.workspace.member_joined")
_UPSERT_CHUNK = 500
_INSERT_CHUNK = 1_000


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


def day_bounds(day: str) -> tuple[str, str]:
    """``[since, until)`` instants of one UTC day, in the stores' own ISO form."""
    d = date.fromisoformat(day)
    since = datetime.combine(d, dtime.min, tzinfo=timezone.utc)
    return since.isoformat(), (since + timedelta(days=1)).isoformat()


def _shift(day: str, days: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


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


# ── 1. One day ────────────────────────────────────────────────────────


async def attribute_day(session: AsyncSession, day: str) -> int:
    """Give one day's unattributed usage signals their workspace. Returns rows placed.

    View opens are placed a workspace at a time (one UPDATE per chunk of that workspace's
    views); inferred signals a workspace at a time too, by id — a few statements a day however
    many signals it holds.
    """
    T = ProductEventORM
    since, until = day_bounds(day)
    in_day = [T.created_at >= since, T.created_at < until, T.workspace_id.is_(None)]
    placed = 0

    opened = [
        v for v in (await session.execute(
            select(T.subject_id).where(T.event_type == VIEW_OPENED, T.subject_id.is_not(None), *in_day)
            .distinct()
        )).scalars().all() if v
    ]
    homes = await _view_homes(session, opened)
    by_ws: dict[str, list[str]] = defaultdict(list)
    for vid, ws in homes.items():
        by_ws[ws].append(vid)
    for ws, vids in by_ws.items():
        for chunk in _chunked(sorted(vids)):
            result = await session.execute(
                update(T).where(T.event_type == VIEW_OPENED, T.subject_id.in_(chunk), *in_day)
                .values(workspace_id=ws).execution_options(synchronize_session=False))
            placed += result.rowcount or 0

    inferred = (await session.execute(
        select(T.id, T.created_at, T.actor_id)
        .where(T.event_type.in_(_INFERRED), T.actor_id.is_not(None), *in_day)
        .order_by(T.created_at)
    )).all()
    if not inferred:
        return placed
    lo = _iso((_parse(since) or datetime.now(timezone.utc)) - INFER_WINDOW)
    opens: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for chunk in _chunked(sorted({r.actor_id for r in inferred})):
        for actor, at, subject in (await session.execute(
            select(T.actor_id, T.created_at, T.subject_id)
            .where(T.event_type == VIEW_OPENED, T.actor_id.in_(chunk),
                   T.created_at >= lo, T.created_at < until, T.subject_id.is_not(None))
            .order_by(T.created_at)
        )).all():
            opens[actor].append((at, subject))
    homes.update(await _view_homes(
        session, {s for pairs in opens.values() for _, s in pairs} - set(homes)))
    stamps = {actor: [at for at, _ in pairs] for actor, pairs in opens.items()}
    to_ws: dict[str, list[str]] = defaultdict(list)
    for r in inferred:
        pairs = opens.get(r.actor_id)
        if not pairs:
            continue
        i = bisect_right(stamps[r.actor_id], r.created_at) - 1
        if i < 0:
            continue
        opened_at, subject = pairs[i]
        at, then = _parse(r.created_at), _parse(opened_at)
        ws = homes.get(subject)
        if ws and at and then and at - then <= INFER_WINDOW:
            to_ws[ws].append(r.id)
    for ws, ids in to_ws.items():
        for chunk in _chunked(ids):
            await session.execute(
                update(T).where(T.id.in_(chunk)).values(workspace_id=ws)
                .execution_options(synchronize_session=False))
            placed += len(chunk)
    return placed


class _DayFold:
    """One day's rollup, accumulated in memory before it replaces the stored day."""

    def __init__(self) -> None:
        # (user, workspace, kind) -> [n, n_ws, first, last, first_ws, last_ws]
        self.people: dict[tuple[str, str, str], list] = {}
        # (workspace, facet, value) -> [n, n_ws]
        self.facets: dict[tuple[str, str, str], list] = {}

    def add(self, user: str, ws: Optional[str], kind: str, n: int, first: str, last: str, *,
            visible: bool, type_key: Optional[str], hour: Optional[str]) -> None:
        ws = ws or PLATFORM
        a = self.people.setdefault((user, ws, kind), [0, 0, None, None, None, None])
        a[0] += n
        a[2] = first if a[2] is None or first < a[2] else a[2]
        a[3] = last if a[3] is None or last > a[3] else a[3]
        if visible:
            a[1] += n
            a[4] = first if a[4] is None or first < a[4] else a[4]
            a[5] = last if a[5] is None or last > a[5] else a[5]
        if kind.startswith(SECTION_KIND_PREFIX):
            facets = [("section", kind[len(SECTION_KIND_PREFIX):])]
        else:
            facets = [("kind", kind)] + ([("type", type_key)] if type_key else [])
            if kind != "signin" and hour:
                facets.append(("hour", hour))
        for scope in ((ws, EVERYWHERE) if ws else (EVERYWHERE,)):
            for facet, value in facets:
                f = self.facets.setdefault((scope, facet, value), [0, 0])
                f[0] += n
                if visible:
                    f[1] += n


def _hour_of(col):
    return func.substr(col, 12, 2)


async def fold_day(session: AsyncSession, day: str) -> _DayFold:
    """Read one day of all three stores, grouped in SQL, and fold it into rollup rows."""
    fold = _DayFold()
    since, until = day_bounds(day)

    P = ProductEventORM
    sect = case((P.event_type == SECTION, P.subject_id), else_=None)
    for actor, ws, t, hour, section, n, first, last in (await session.execute(
        select(P.actor_id, P.workspace_id, P.event_type, _hour_of(P.created_at).label("h"),
               sect.label("s"), func.count(), func.min(P.created_at), func.max(P.created_at))
        .where(P.created_at >= since, P.created_at < until,
               P.event_type.in_(list(USAGE_KINDS) + [SECTION]),
               P.actor_id.is_not(None), is_person(P.actor_id))
        .group_by(P.actor_id, P.workspace_id, P.event_type, "h", "s")
    )).all():
        if not actor:
            continue
        if t == SECTION:
            if section:
                fold.add(actor, ws, section_kind(section), int(n), first, last,
                         visible=True, type_key=None, hour=None)
            continue
        fold.add(actor, ws, USAGE_KINDS[t], int(n), first, last,
                 visible=True, type_key=t, hour=hour)

    E = ViewActivityLogORM
    for actor, ws, action, hour, n, first, last in (await session.execute(
        select(E.actor, E.workspace_id, E.action, _hour_of(E.created_at).label("h"),
               func.count(), func.min(E.created_at), func.max(E.created_at))
        .where(E.created_at >= since, E.created_at < until,
               E.actor.is_not(None), is_person(E.actor))
        .group_by(E.actor, E.workspace_id, E.action, "h")
    )).all():
        if not actor:
            continue
        t = edit_type(action)
        # An admin opening a PRIVATE view is auditor-only: never shown to a workspace admin.
        fold.add(actor, ws, kind_of(t), int(n), first, last,
                 visible=action != _ADMIN_VIEWED, type_key=t, hour=hour)

    L = AuthAuditLogORM
    for actor, ws, t, category, audience, hour, n, first, last in (await session.execute(
        select(L.actor_id, L.workspace_id, L.event_type, L.category, L.audience,
               _hour_of(L.occurred_at).label("h"),
               func.count(), func.min(L.occurred_at), func.max(L.occurred_at))
        .where(L.occurred_at >= since, L.occurred_at < until,
               L.actor_kind == "user", L.actor_id.is_not(None), is_person(L.actor_id),
               ~L.event_type.startswith(_MIRRORED_LEDGER_PREFIX, autoescape=True))
        .group_by(L.actor_id, L.workspace_id, L.event_type, L.category, L.audience, "h")
    )).all():
        if not actor:
            continue
        # What a workspace admin may read of their workspace: the Activity explorer's rule.
        visible = bool(ws) and audience == catalogue.AUDIENCE_WORKSPACE
        fold.add(actor, ws, ledger_kind(t, category), int(n), first, last,
                 visible=visible, type_key=t, hour=hour)
    return fold


def _newest(a: Optional[str], b: Optional[str]) -> Optional[str]:
    return b if a is None or (b is not None and b > a) else a


def _totals_rows(day: str, fold: _DayFold) -> list[dict]:
    """The day per person and scope, with no kind: a row for each workspace they did something
    in, and one for everywhere. Sign-ins happened in no workspace, so only the latter has them."""
    out: dict[tuple[str, str], dict] = {}

    def row(ws: str, user: str) -> dict:
        return out.setdefault((ws, user), {
            "workspace_id": ws, "day": day, "user_id": user, "actions": 0, "actions_ws": 0,
            "signins": 0, "sections": 0, "last_action_at": None, "last_action_ws_at": None,
            "last_signin_at": None,
        })

    for (user, ws, kind), (n, n_ws, _first, last, _first_ws, last_ws) in fold.people.items():
        if kind == "signin":
            r = row(EVERYWHERE, user)
            r["signins"] += n
            r["last_signin_at"] = _newest(r["last_signin_at"], last)
            continue
        for r in [row(EVERYWHERE, user)] + ([row(ws, user)] if ws else []):
            if kind in ACTION_KINDS:
                r["actions"] += n
                r["actions_ws"] += n_ws
                r["last_action_at"] = _newest(r["last_action_at"], last)
                r["last_action_ws_at"] = _newest(r["last_action_ws_at"], last_ws)
            else:
                r["sections"] |= SECTION_BITS.get(kind[len(SECTION_KIND_PREFIX):], 0)
    return [out[k] for k in sorted(out)]


async def _replace_day(session: AsyncSession, day: str, fold: _DayFold) -> None:
    A, T, F = (PersonActivityDailyORM.__table__, PersonDailyTotalORM.__table__,
               PeopleDailyFacetORM.__table__)
    for table in (A, T, F):
        await session.execute(delete(table).where(table.c.day == day))
    people = [
        {"day": day, "user_id": u, "workspace_id": ws, "kind": k, "n": v[0], "n_ws": v[1],
         "first_at": v[2], "last_at": v[3], "first_ws_at": v[4], "last_ws_at": v[5]}
        for (u, ws, k), v in sorted(fold.people.items())
    ]
    for start in range(0, len(people), _INSERT_CHUNK):
        await session.execute(sa_insert(A), people[start:start + _INSERT_CHUNK])
    totals = _totals_rows(day, fold)
    for start in range(0, len(totals), _INSERT_CHUNK):
        await session.execute(sa_insert(T), totals[start:start + _INSERT_CHUNK])
    facets = [
        {"day": day, "workspace_id": ws, "facet": f, "value": v, "n": c[0], "n_ws": c[1]}
        for (ws, f, v), c in sorted(fold.facets.items())
    ]
    for start in range(0, len(facets), _INSERT_CHUNK):
        await session.execute(sa_insert(F), facets[start:start + _INSERT_CHUNK])


def _timeline_rows(fold: _DayFold) -> list[dict]:
    """The day's first and last activity per person and workspace, and per person overall.
    A workspace's timeline takes only what its admins may see; the platform's takes all."""
    rows: list[dict] = []
    overall: dict[str, list] = {}
    for (user, ws, kind), (_n, n_ws, first, last, first_ws, last_ws) in fold.people.items():
        if kind not in ACTION_KINDS:
            continue
        o = overall.setdefault(user, [first, last])
        o[0], o[1] = min(o[0], first), max(o[1], last)
        if ws and n_ws:
            rows.append({"user_id": user, "workspace_id": ws,
                         "first_active_at": first_ws, "last_active_at": last_ws})
    rows += [{"user_id": u, "workspace_id": PLATFORM, "first_active_at": f, "last_active_at": l}
             for u, (f, l) in overall.items()]
    return rows


async def index_day(session: AsyncSession, day: str, *, now: Optional[datetime] = None) -> int:
    """Compute one day of the rollup from scratch. Returns how many person rows it holds."""
    now = now or datetime.now(timezone.utc)
    await attribute_day(session, day)
    await session.flush()
    fold = await fold_day(session, day)
    await _replace_day(session, day, fold)
    await upsert(session, _timeline_rows(fold))
    row = await session.get(PeopleIndexDayORM, day)
    if row is None:
        session.add(PeopleIndexDayORM(day=day, computed_at=_iso(now), dirty=False))
    else:
        row.computed_at, row.dirty = _iso(now), False
    await session.flush()
    return len(fold.people)


# ── 2. Which day next ─────────────────────────────────────────────────


def _retention_floor(now: datetime) -> str:
    """The oldest day whose raw events are all still kept. Older days keep the rollup they
    have: recomputing them from what retention left would empty them."""
    from backend.app.services import activity_retention, product_event_gc
    days = product_event_gc.retention_days()
    ledger_days = activity_retention.retention_days()
    if ledger_days is not None:
        days = min(days, ledger_days)
    return (now.date() - timedelta(days=days - 1)).isoformat()


async def _history_start(session: AsyncSession) -> Optional[str]:
    """The first day anything was recorded — three index seeks."""
    firsts = [
        (await session.execute(select(func.min(col)))).scalar()
        for col in (ProductEventORM.created_at, ViewActivityLogORM.created_at,
                    AuthAuditLogORM.occurred_at)
    ]
    days = [f[:10] for f in firsts if f]
    return min(days) if days else None


async def _computed(session: AsyncSession, day: str) -> Optional[PeopleIndexDayORM]:
    return await session.get(PeopleIndexDayORM, day)


async def _mark_ledger_dirty(session: AsyncSession, now: datetime) -> int:
    """Days a ledger row arrived late for: recorded after the day was computed. The relay
    can lag, or catch up after an outage; those days are computed again."""
    upper = _iso(now - LAG)
    cursor = await get_cursor(session, CURSOR_LEDGER)
    if cursor is None or not cursor.through:
        # First run: everything recorded so far is history the backfill will compute.
        await _advance(session, CURSOR_LEDGER, upper)
        return 0
    if cursor.through >= upper:
        return 0
    L = AuthAuditLogORM
    late = (await session.execute(
        select(func.substr(L.occurred_at, 1, 10)).where(
            L.recorded_at > cursor.through, L.recorded_at <= upper,
            L.actor_kind == "user",
        ).distinct()
    )).scalars().all()
    marked = 0
    for day in late:
        row = await _computed(session, day)
        if row is not None and not row.dirty:
            row.dirty = True
            marked += 1
    await _advance(session, CURSOR_LEDGER, upper)
    return marked


async def _next_backfill_day(session: AsyncSession, now: datetime) -> Optional[str]:
    """The newest day not yet computed, walking back from the day before yesterday."""
    start = await _history_start(session)
    if start is None:
        return None
    floor = max(start, _retention_floor(now))
    cursor = await get_cursor(session, CURSOR_BACKFILL)
    oldest_hot = _shift(now.date().isoformat(), -1)
    nxt = _shift(cursor.through, -1) if cursor and cursor.through else _shift(oldest_hot, -1)
    while nxt >= floor:
        if await _computed(session, nxt) is None:
            return nxt
        await _advance(session, CURSOR_BACKFILL, nxt, started_at=start)
        nxt = _shift(nxt, -1)
    return None


async def purge_rollup(session: AsyncSession, *, now: datetime) -> int:
    """Drop one rollup day past ``ROLLUP_KEEP_DAYS``. Returns rows removed."""
    cutoff = (now.date() - timedelta(days=ROLLUP_KEEP_DAYS)).isoformat()
    oldest = (await session.execute(
        select(func.min(PeopleIndexDayORM.day)).where(PeopleIndexDayORM.day < cutoff))).scalar()
    if oldest is None:
        return 0
    A, T, F, D = (PersonActivityDailyORM.__table__, PersonDailyTotalORM.__table__,
                  PeopleDailyFacetORM.__table__, PeopleIndexDayORM.__table__)
    gone = (await session.execute(delete(A).where(A.c.day == oldest))).rowcount or 0
    await session.execute(delete(T).where(T.c.day == oldest))
    await session.execute(delete(F).where(F.c.day == oldest))
    await session.execute(delete(D).where(D.c.day == oldest))
    return gone + 1


async def step(session: AsyncSession, *, now: Optional[datetime] = None) -> int:
    """One unit of the most urgent work. Returns how much was done; 0 means caught up."""
    now = now or datetime.now(timezone.utc)
    done = await joins_pass(session, now=now)

    today = now.date().isoformat()
    yesterday = _shift(today, -1)
    yesterday_closed = _iso(datetime.combine(date.fromisoformat(today), dtime.min,
                                             tzinfo=timezone.utc) + LAG)
    for day, fresh_after in ((today, _iso(now - HOT_REFRESH)), (yesterday, yesterday_closed)):
        row = await _computed(session, day)
        if row is None or row.dirty or (row.computed_at or "") < fresh_after:
            await index_day(session, day, now=now)
            return done + 1

    await _mark_ledger_dirty(session, now)
    floor = _retention_floor(now)
    dirty = (await session.execute(
        select(PeopleIndexDayORM.day)
        .where(PeopleIndexDayORM.dirty.is_(True), PeopleIndexDayORM.day >= floor)
        .order_by(PeopleIndexDayORM.day.desc()).limit(1)
    )).scalar()
    if dirty:
        await index_day(session, dirty, now=now)
        return done + 1

    day = await _next_backfill_day(session, now)
    if day:
        await index_day(session, day, now=now)
        await _advance(session, CURSOR_BACKFILL, day, started_at=await _history_start(session))
        return done + 1

    return done + (1 if await purge_rollup(session, now=now) else 0)


# ── 3. Joins ──────────────────────────────────────────────────────────


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
    """How far the rollup reaches, for the page to say so.

    ``completeFrom`` is the oldest day from which every day up to today is computed and clean
    — a window starting at or after it is exact. ``running`` is whether the indexer has
    computed today recently; when it has not, the rollup is not being kept current here (it
    runs on the scheduler-owner role)."""
    now = now or datetime.now(timezone.utc)
    today = now.date().isoformat()
    rows = {
        d: (c, dirty) for d, c, dirty in (await session.execute(
            select(PeopleIndexDayORM.day, PeopleIndexDayORM.computed_at, PeopleIndexDayORM.dirty)
            .where(PeopleIndexDayORM.day >= _shift(today, -ROLLUP_KEEP_DAYS))
        )).all()
    }
    complete_from: Optional[str] = None
    cursor_day = today
    while cursor_day in rows and not rows[cursor_day][1]:
        complete_from = cursor_day
        cursor_day = _shift(cursor_day, -1)
    backfill = await get_cursor(session, CURSOR_BACKFILL)
    history = (backfill.started_at if backfill else None) or await _history_start(session)
    fresh_at = rows.get(today, (None, False))[0]
    progress = None
    if history and complete_from:
        span = (date.fromisoformat(today) - date.fromisoformat(history)).days
        done = (date.fromisoformat(today) - date.fromisoformat(complete_from)).days
        progress = 1.0 if span <= 0 else round(min(1.0, done / span), 3)
    return {
        "freshAt": fresh_at,
        "completeFrom": complete_from,
        "historyFrom": history,
        "running": bool(fresh_at and fresh_at >= _iso(now - timedelta(minutes=15))),
        "backfilling": bool(history and (complete_from is None or complete_from > history)),
        "progress": progress,
    }


def merge_join(timeline: dict, current: Optional[str]) -> Optional[str]:
    """The earlier of the indexed join and what current grants say — so a member added a
    minute ago, before the indexer has seen them, still shows when they joined."""
    indexed = timeline.get("joinedAt") if timeline else None
    if indexed and current:
        return min(indexed, current)
    return indexed or current
