"""People analytics — what each person does, day by day, across the platform or in one workspace.

It answers "who signed in, who opened what, and when" from the three stores that already record
people doing things, without adding a fourth:

* ``product_events`` — usage signals: view opens, traces, searches, exports, docs and tours, and
  which section of the app someone moved to (``app.section``).
* ``view_activity_log`` — edits to views. Read HERE rather than as the ledger's
  ``visualization.view.*`` rows, which are the same edits: reading both would count every edit
  twice, and this table does not depend on the outbox relay running.
* ``auth_audit_log`` — the activity ledger: sign-ins, data operations, access changes, semantic
  layer and version-control work.

Every read is one table grouped in SQL by (person, day, type) and stitched together by id in
Python; ``DOMAIN_OWNERSHIP`` forbids cross-domain JOINs. Days and hours are UTC, as everywhere
else in Analytics.

LENSES. A document is built for a lens, never for a reader:

* ``full`` — everything, sign-ins included. For privileged readers, and for a person reading
  their own activity.
* ``workspace`` — what a workspace admin may know about their workspace: its usage signals, its
  view edits, and only the ledger rows the Activity explorer would show them
  (``audience = 'workspace'``). No sign-ins: signing in is a platform event, not any one
  workspace's, and the explorer withholds identity events from workspace admins for that reason.

What one particular reader receives — addresses, view and workspace names — is decided on the
way out by the redactors at the bottom, so one computation serves every reader of a lens.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any, Iterable, Optional, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AuthAuditLogORM,
    ProductEventORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
)
from backend.app.db.repositories import people_index_repo, user_repo
from backend.app.db.repositories.activity_repo import _punchcard
from backend.app.db.repositories.analytics_repo import (
    GRAPH_EXPORT,
    SEARCH_MISS,
    SEARCH_RUN,
    TRACE_EMPTY,
    TRACE_RUN,
    VIEW_OPENED,
    Window,
    _chunked,
    _delta,
    _insight,
    _pct,
    _plural,
    _window_label,
    build_window,
    members_by_workspace,
)
from backend.app.services.activity import catalogue
from backend.common.service_accounts import is_person, is_service_account

FULL = "full"
WORKSPACE = "workspace"
LENSES = (FULL, WORKSPACE)

#: What people do, in the order the charts draw it. Six colour slots and a neutral "Other" —
#: the palette's limit, which is why the tail folds rather than inventing a seventh hue. The
#: client mirrors this list (``activityKinds.ts``) and a test pins the two together.
KINDS: tuple[str, ...] = ("signin", "browse", "trace", "search", "build", "operate", "other")

SIGN_IN = "user.logged_in"
SECTION = "app.section"
_FAILED_SIGN_INS = ("user.login_failed", "user.sso_login_failed")

#: The ``product_events`` read as activity, and what kind each is. Deliberately NOT every
#: allow-listed type: ``version.published``, ``ontology.published``, ``view.import`` and
#: ``view.export`` are the same acts the ledger and ``view_activity_log`` already record, and
#: counting both would credit one publish twice.
USAGE_KINDS: dict[str, str] = {
    VIEW_OPENED: "browse",
    TRACE_RUN: "trace",
    TRACE_EMPTY: "trace",
    SEARCH_RUN: "search",
    SEARCH_MISS: "search",
    GRAPH_EXPORT: "other",
    "docs.feedback": "other",
    "docs.search_miss": "other",
    "tour.completed": "other",
    "tour.skipped": "other",
    "onboarding.step": "other",
}

USAGE_LABELS: dict[str, str] = {
    VIEW_OPENED: "Opened a view",
    TRACE_RUN: "Traced lineage",
    TRACE_EMPTY: "Traced lineage and found none",
    SEARCH_RUN: "Searched the graph",
    SEARCH_MISS: "Searched and found nothing",
    GRAPH_EXPORT: "Exported from the graph",
    "docs.feedback": "Rated a docs page",
    "docs.search_miss": "Searched the docs and found nothing",
    "tour.completed": "Finished a tour",
    "tour.skipped": "Skipped a tour",
    "onboarding.step": "Took an onboarding step",
}

#: ``view_activity_log.action`` → (type key, label, kind). The key is namespaced so it can sit
#: in one distribution with the other two sources without colliding.
_EDIT_META: dict[str, tuple[str, str]] = {
    "created": ("Created a view", "build"),
    "updated": ("Edited a view", "build"),
    "visibility_changed": ("Changed a view's visibility", "build"),
    "shared": ("Shared a view", "build"),
    "unshared": ("Stopped sharing a view", "build"),
    "favourited": ("Favourited a view", "other"),
    "unfavourited": ("Unfavourited a view", "other"),
    "deleted": ("Deleted a view", "build"),
    "restored": ("Restored a view", "build"),
    "data_changed": ("Changed a view's data", "build"),
    "publish_requested": ("Asked to publish a view", "build"),
    "publish_denied": ("Declined a view's publication", "build"),
    "admin_viewed": ("Opened a private view as an admin", "browse"),
    "imported": ("Imported a view", "build"),
    "exported": ("Exported a view", "other"),
    "version_saved": ("Saved a view version", "build"),
    "version_restored": ("Restored a view version", "build"),
    "moved": ("Moved a view", "build"),
}
_EDIT_PREFIX = "edit."

#: An admin opening a PRIVATE view is auditor-only in the ledger, so the workspace lens leaves
#: it out of the edit log too.
_ADMIN_VIEWED = "admin_viewed"

#: The ledger's own copies of the edits read from ``view_activity_log``.
_MIRRORED_LEDGER_PREFIX = "visualization.view."

#: A gap longer than this between two events starts a new session.
SESSION_GAP_MINUTES = 30

#: Rows a single day's timeline returns.
DAY_CAP = 500

#: Event types named individually in a distribution before the tail folds.
_TOP_TYPES = 12

#: Quiet people listed by name on the platform scope (the count is always exact).
_QUIET_LISTED = 200

#: Calendar span, days.
CALENDAR_DAYS = 365


def edit_type(action: str) -> str:
    return f"{_EDIT_PREFIX}{action}"


def ledger_kind(event_type: str, category: Optional[str]) -> str:
    """The kind of one ledger event. Sign-ins first; building next, because ontology and
    version-control work is classified ``content``/``data`` by the ledger and would otherwise
    read as operations."""
    if event_type == SIGN_IN:
        return "signin"
    if event_type.startswith(("ontology.", "workspace.versioning.", "visualization.")):
        return "build"
    if category in ("operations", "data"):
        return "operate"
    return "other"


def kind_of(event_type: str, category: Optional[str] = None) -> str:
    if event_type in USAGE_KINDS:
        return USAGE_KINDS[event_type]
    if event_type.startswith(_EDIT_PREFIX):
        meta = _EDIT_META.get(event_type[len(_EDIT_PREFIX):])
        return meta[1] if meta else "build"
    return ledger_kind(event_type, category)


def label_of(event_type: str) -> str:
    if event_type in USAGE_LABELS:
        return USAGE_LABELS[event_type]
    if event_type.startswith(_EDIT_PREFIX):
        meta = _EDIT_META.get(event_type[len(_EDIT_PREFIX):])
        return meta[0] if meta else "Changed a view"
    return catalogue.label_of(event_type)


# ── Reads ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Row:
    """One grouped row, whichever table it came from.

    ``hour`` is ``YYYY-MM-DDTHH`` in UTC; ``subject`` is the view a ``view.opened`` was about
    or the section an ``app.section`` named; ``workspace`` is where it happened, when known.
    """
    actor: str
    hour: str
    type: str
    kind: str
    count: int
    first: str
    last: str
    subject: Optional[str] = None
    workspace: Optional[str] = None

    @property
    def day(self) -> str:
        return self.hour[:10]


def _hour(col):
    return func.substr(col, 1, 13)


def _bounds(col, since: str, until: Optional[str]) -> list:
    return [col >= since] + ([col < until] if until else [])


async def _workspace_view_ids(session: AsyncSession, workspace_id: str) -> list[str]:
    """Every view the workspace has had, live or not: opens of a since-deleted view really
    did happen in it, and dropping them would understate the workspace's past traffic."""
    return [
        vid for vid in (await session.execute(
            select(ViewORM.id).where(ViewORM.workspace_id == workspace_id)
        )).scalars().all() if vid
    ]


async def _usage_rows(
    session: AsyncSession, *, since: str, until: Optional[str],
    actor: Optional[str] = None, workspace_id: Optional[str] = None,
    ws_view_ids: Optional[Sequence[str]] = None, sections: bool = True,
) -> list[_Row]:
    """Usage signals grouped by (actor, hour, type, subject, workspace).

    Scoped to a workspace two ways, because the two kinds of signal know their workspace
    differently: a view open through its view (``subject_id``, one pass per chunk of the
    workspace's view ids), everything else through ``workspace_id``. For one person the view
    opens are fetched unscoped and placed by the caller instead — their handful of views is far
    smaller than the workspace's catalogue.
    """
    T = ProductEventORM
    types = list(USAGE_KINDS) + ([SECTION] if sections else [])
    base = [*_bounds(T.created_at, since, until), T.actor_id.is_not(None), is_person(T.actor_id)]
    if actor:
        base.append(T.actor_id == actor)

    passes: list[list] = []
    if workspace_id is None or actor:
        passes.append([T.event_type.in_(types)])
    else:
        others = [t for t in types if t != VIEW_OPENED]
        passes.append([T.event_type.in_(others), T.workspace_id == workspace_id])
        for chunk in _chunked(list(ws_view_ids or ())):
            passes.append([T.event_type == VIEW_OPENED, T.subject_id.in_(chunk)])

    rows: list[_Row] = []
    for where in passes:
        stmt = (
            select(
                T.actor_id, _hour(T.created_at).label("h"), T.event_type, T.subject_id,
                T.workspace_id, func.count(), func.min(T.created_at), func.max(T.created_at),
            )
            .where(*base, *where)
            .group_by(T.actor_id, "h", T.event_type, T.subject_id, T.workspace_id)
        )
        for a, h, t, subject, ws, n, first, last in (await session.execute(stmt)).all():
            if not (a and h):
                continue
            rows.append(_Row(
                actor=a, hour=h, type=t, kind=USAGE_KINDS.get(t, "other"), count=int(n),
                first=first, last=last, subject=subject or None, workspace=ws,
            ))
    return rows


async def _edit_rows(
    session: AsyncSession, *, since: str, until: Optional[str], lens: str,
    actor: Optional[str] = None, workspace_id: Optional[str] = None,
) -> list[_Row]:
    T = ViewActivityLogORM
    where = [*_bounds(T.created_at, since, until), T.actor.is_not(None), is_person(T.actor)]
    if actor:
        where.append(T.actor == actor)
    if workspace_id:
        where.append(T.workspace_id == workspace_id)
    if lens == WORKSPACE:
        where.append(T.action != _ADMIN_VIEWED)
    stmt = (
        select(
            T.actor, _hour(T.created_at).label("h"), T.action, T.workspace_id,
            func.count(), func.min(T.created_at), func.max(T.created_at),
        )
        .where(*where)
        .group_by(T.actor, "h", T.action, T.workspace_id)
    )
    out = []
    for a, h, action, ws, n, first, last in (await session.execute(stmt)).all():
        if not (a and h):
            continue
        t = edit_type(action)
        out.append(_Row(actor=a, hour=h, type=t, kind=kind_of(t), count=int(n),
                        first=first, last=last, workspace=ws))
    return out


def _ledger_scope(lens: str, workspace_id: Optional[str]) -> list:
    """The ledger rows a lens may read.

    Platform scope (full lens only): everything people did. Workspace scope: rows in the
    workspace — every audience for the full lens, only the workspace audience for a workspace
    admin, exactly as the Activity explorer serves them. Sign-ins carry no workspace, so a
    full-lens workspace scope adds its people's sign-ins separately (:func:`_signin_rows`).
    """
    T = AuthAuditLogORM
    if workspace_id is None:
        return []
    clause = [T.workspace_id == workspace_id]
    if lens == WORKSPACE:
        clause.append(T.audience == catalogue.AUDIENCE_WORKSPACE)
    return clause


async def _ledger_rows(
    session: AsyncSession, *, since: str, until: Optional[str], lens: str,
    actor: Optional[str] = None, workspace_id: Optional[str] = None,
) -> list[_Row]:
    T = AuthAuditLogORM
    where = [
        *_bounds(T.occurred_at, since, until),
        T.actor_kind == "user", T.actor_id.is_not(None), is_person(T.actor_id),
        ~T.event_type.startswith(_MIRRORED_LEDGER_PREFIX, autoescape=True),
        *_ledger_scope(lens, workspace_id),
    ]
    if actor:
        where.append(T.actor_id == actor)
    stmt = (
        select(
            T.actor_id, _hour(T.occurred_at).label("h"), T.event_type, T.category,
            T.workspace_id, func.count(), func.min(T.occurred_at), func.max(T.occurred_at),
        )
        .where(*where)
        .group_by(T.actor_id, "h", T.event_type, T.category, T.workspace_id)
    )
    out = []
    for a, h, t, category, ws, n, first, last in (await session.execute(stmt)).all():
        if not (a and h):
            continue
        out.append(_Row(actor=a, hour=h, type=t, kind=ledger_kind(t, category),
                        count=int(n), first=first, last=last, workspace=ws))
    return out


async def _signin_rows(
    session: AsyncSession, *, since: str, until: Optional[str], people: Iterable[str],
) -> list[_Row]:
    """Sign-ins of the given people, wherever they happened. For a full-lens workspace scope,
    whose ledger read is confined to the workspace and so sees no sign-in at all."""
    T = AuthAuditLogORM
    out: list[_Row] = []
    for chunk in _chunked(sorted({p for p in people if p and not is_service_account(p)})):
        stmt = (
            select(
                T.actor_id, _hour(T.occurred_at).label("h"), func.count(),
                func.min(T.occurred_at), func.max(T.occurred_at),
            )
            .where(*_bounds(T.occurred_at, since, until), T.event_type == SIGN_IN,
                   T.actor_id.in_(chunk))
            .group_by(T.actor_id, "h")
        )
        for a, h, n, first, last in (await session.execute(stmt)).all():
            if a and h:
                out.append(_Row(actor=a, hour=h, type=SIGN_IN, kind="signin", count=int(n),
                                first=first, last=last))
    return out


async def _users(session: AsyncSession, ids: Iterable[str]) -> dict[str, dict]:
    """The people named in a document, chunked. Same display-name rule as
    ``view_repo.resolve_user_ids``; a deleted account keeps its name and says so."""
    out: dict[str, dict] = {}
    for chunk in _chunked(sorted({i for i in ids if i})):
        for row in (await session.execute(
            select(
                UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email,
                UserORM.status, UserORM.created_at, UserORM.deleted_at,
                UserORM.last_login_at, UserORM.last_seen_at, UserORM.last_active_at,
            ).where(UserORM.id.in_(chunk))
        )).all():
            uid, first, last, email, status, created, deleted, login, seen, active = row
            out[uid] = {
                "name": f"{first or ''} {last or ''}".strip() or email or uid,
                "email": email,
                "status": status,
                "createdAt": created,
                "deleted": deleted is not None,
                "lastLoginAt": login,
                "lastSeenAt": seen,
                "lastActiveAt": active,
            }
    return out


async def _views(session: AsyncSession, ids: Iterable[str]) -> dict[str, dict]:
    """Name, workspace and visibility for the views a document mentions — what the redactor
    needs to decide, per reader, whether the name may leave."""
    out: dict[str, dict] = {}
    for chunk in _chunked(sorted({i for i in ids if i})):
        for vid, name, ws, visibility, created_by, deleted in (await session.execute(
            select(ViewORM.id, ViewORM.name, ViewORM.workspace_id, ViewORM.visibility,
                   ViewORM.created_by, ViewORM.deleted_at)
            .where(ViewORM.id.in_(chunk))
        )).all():
            out[vid] = {"name": name, "workspaceId": ws, "visibility": visibility,
                        "createdBy": created_by, "deleted": deleted is not None}
    return out


async def _coverage(session: AsyncSession, w: Window) -> dict:
    """How far each source can be trusted for this window — so a chart can say "not
    tracked yet" instead of drawing a zero that reads as "nobody did it".

    Each is one indexed seek: the newest ledger row, the first section visit, and the first
    workspace-attributed signal inside the window.
    """
    ledger_through = (await session.execute(
        select(func.max(AuthAuditLogORM.occurred_at))
    )).scalar()
    sections_since = (await session.execute(
        select(func.min(ProductEventORM.created_at))
        .where(ProductEventORM.event_type == SECTION)
    )).scalar()
    attributed_since = (await session.execute(
        select(func.min(ProductEventORM.created_at)).where(
            ProductEventORM.workspace_id.is_not(None),
            ProductEventORM.created_at >= w.start,
        )
    )).scalar()
    return {
        "ledgerThrough": ledger_through,
        "sectionsSince": sections_since,
        "workspaceAttributionSince": attributed_since,
    }


# ── Folding ───────────────────────────────────────────────────────────


@dataclass
class _Person:
    """One person's figures over a window. ``actions`` leaves out sign-ins: signing in and
    leaving is not using the platform, which is the same line ``analytics_repo`` draws for
    active users."""
    actions: int = 0
    sign_ins: int = 0
    kinds: Counter = field(default_factory=Counter)
    types: Counter = field(default_factory=Counter)
    active_days: set = field(default_factory=set)
    sign_in_days: set = field(default_factory=set)
    by_bucket: Counter = field(default_factory=Counter)
    last: Optional[str] = None
    last_sign_in: Optional[str] = None

    def add(self, row: _Row, bucket: Optional[str]) -> None:
        if row.type == SECTION:
            return
        self.kinds[row.kind] += row.count
        self.types[row.type] += row.count
        if row.kind == "signin":
            self.sign_ins += row.count
            self.sign_in_days.add(row.day)
            if not self.last_sign_in or row.last > self.last_sign_in:
                self.last_sign_in = row.last
            return
        self.actions += row.count
        self.active_days.add(row.day)
        if bucket:
            self.by_bucket[bucket] += row.count
        if not self.last or row.last > self.last:
            self.last = row.last


def _top_kind(kinds: Counter) -> Optional[str]:
    actions = {k: v for k, v in kinds.items() if k != "signin" and v}
    if not actions:
        return None
    return max(actions.items(), key=lambda kv: (kv[1], -KINDS.index(kv[0])))[0]


def _kind_list(kinds: Counter, *, lens: str) -> list[dict]:
    return [
        {"kind": k, "count": int(kinds.get(k, 0))}
        for k in KINDS if not (k == "signin" and lens == WORKSPACE)
    ]


def _type_list(types: Counter, kinds: dict[str, str]) -> list[dict]:
    ranked = types.most_common()
    head = ranked[:_TOP_TYPES]
    out = [
        {"type": t, "kind": kinds.get(t) or kind_of(t), "label": label_of(t), "count": int(n)}
        for t, n in head
    ]
    tail = sum(n for _, n in ranked[_TOP_TYPES:])
    if tail:
        out.append({"type": "other", "kind": "other", "label": "Everything else", "count": int(tail)})
    return out


def _sections(rows: Iterable[_Row]) -> list[dict]:
    counts: Counter = Counter()
    people: dict[str, set] = defaultdict(set)
    for r in rows:
        if r.type == SECTION and r.subject:
            counts[r.subject] += r.count
            people[r.subject].add(r.actor)
    return [
        {"section": s, "count": int(n), "people": len(people[s])}
        for s, n in counts.most_common()
    ]


def _punch(rows: Iterable[_Row]) -> list[list[int]]:
    by_hour: Counter = Counter()
    for r in rows:
        if r.type != SECTION and r.kind != "signin":
            by_hour[r.hour] += r.count
    return _punchcard(by_hour)


def _series(rows: Iterable[_Row], w: Window, *, lens: str) -> dict:
    """Per-bucket figures for a window: each kind's events, and how many distinct people were
    active, and signed in, in each bucket."""
    idx = {b: i for i, b in enumerate(w.buckets)}
    by_kind = {k: [0] * len(w.buckets) for k in KINDS}
    active: list[set] = [set() for _ in w.buckets]
    signed: list[set] = [set() for _ in w.buckets]
    for r in rows:
        if r.type == SECTION:
            continue
        b = w.bucket_of(r.day)
        if b is None or b not in idx:
            continue
        i = idx[b]
        by_kind[r.kind][i] += r.count
        (signed if r.kind == "signin" else active)[i].add(r.actor)
    return {
        "buckets": list(w.buckets),
        "byKind": [
            {"kind": k, "values": by_kind[k]}
            for k in KINDS if not (k == "signin" and lens == WORKSPACE)
        ],
        "activePeople": [len(s) for s in active],
        "signedIn": [len(s) for s in signed] if lens == FULL else None,
    }


def _window_doc(w: Window) -> dict:
    return {"days": w.days, "start": w.start, "end": w.end,
            "granularity": w.granularity, "buckets": list(w.buckets)}


def _streaks(days: set[str], *, last_day: str) -> tuple[int, int]:
    """(longest run of consecutive active days, the run ending on ``last_day`` or the day
    before — a streak is not broken by today not being over yet)."""
    if not days:
        return 0, 0
    ordered = sorted(date.fromisoformat(d) for d in days)
    longest = run = 1
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if (cur - prev).days == 1 else 1
        longest = max(longest, run)
    end = date.fromisoformat(last_day)
    current = 0
    cursor = end if end in set(ordered) else end - timedelta(days=1)
    have = set(ordered)
    while cursor in have:
        current += 1
        cursor -= timedelta(days=1)
    return longest, current


def _minute_of_day(ts: str) -> Optional[int]:
    try:
        at = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    at = at.astimezone(timezone.utc) if at.tzinfo else at
    return at.hour * 60 + at.minute


# ── The roster ────────────────────────────────────────────────────────


async def people_doc(
    session: AsyncSession, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None, workspace_id: Optional[str] = None,
    lens: str = FULL, scope: Any = None,
) -> dict:
    """Everyone's activity over one window: the roster, its aggregates, and who has gone quiet.

    ``scope`` is accepted and ignored so the analytics warmer can build this like its other
    surfaces; the document is always unredacted, and redacted per reader by the endpoint.
    """
    del scope
    if lens not in LENSES:
        raise ValueError(f"unknown lens {lens!r}")
    if lens == WORKSPACE and not workspace_id:
        raise ValueError("the workspace lens needs a workspace")
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)

    ws_views = await _workspace_view_ids(session, workspace_id) if workspace_id else None
    members = (
        (await members_by_workspace(session, now=now, workspace_id=workspace_id)).get(
            workspace_id, set())
        if workspace_id else None
    )

    async def _read(since: str, until: Optional[str]) -> list[_Row]:
        rows = await _usage_rows(session, since=since, until=until,
                                 workspace_id=workspace_id, ws_view_ids=ws_views)
        rows += await _edit_rows(session, since=since, until=until, lens=lens,
                                 workspace_id=workspace_id)
        rows += await _ledger_rows(session, since=since, until=until, lens=lens,
                                   workspace_id=workspace_id)
        if workspace_id and lens == FULL:
            people = set(members or ()) | {r.actor for r in rows}
            rows += await _signin_rows(session, since=since, until=until, people=people)
        return rows

    rows = await _read(w.start, w.end)
    # The equal-length window just before, for every delta: the same bounds the rest of
    # Analytics compares against, so a person's "+20%" means what the dashboard's does.
    prev_rows = await _read(w.previous_start, w.start)

    persons: dict[str, _Person] = defaultdict(_Person)
    totals_kinds: Counter = Counter()
    totals_types: Counter = Counter()
    type_kinds: dict[str, str] = {}
    for r in rows:
        if r.type == SECTION:
            continue
        persons[r.actor].add(r, w.bucket_of(r.day))
        totals_kinds[r.kind] += r.count
        totals_types[r.type] += r.count
        type_kinds[r.type] = r.kind

    previous: Counter = Counter()
    prev_signed: set[str] = set()
    for r in prev_rows:
        if r.type == SECTION:
            continue
        if r.kind == "signin":
            prev_signed.add(r.actor)
        else:
            previous[r.actor] += r.count

    users = await _users(session, set(persons) | set(members or ()))
    # All-time, from the index: when each person joined this scope and was first and last
    # active in it. The platform's "joined" is the account's creation.
    scope_key = workspace_id or people_index_repo.PLATFORM
    timeline = await people_index_repo.timeline_for_workspace(
        session, scope_key, set(persons) | set(members or ()))
    joins = (
        {uid: at for (uid, _ws), at in (await people_index_repo.join_candidates(
            session, workspace_id=workspace_id)).items()}
        if workspace_id else {}
    )

    def _joined(uid: str) -> Optional[str]:
        if not workspace_id:
            return users.get(uid, {}).get("createdAt")
        return people_index_repo.merge_join(timeline.get(uid, {}), joins.get(uid))

    if members is not None:
        # People with access today: a binding can outlive its account, and a group can
        # hold a service account, and neither is a member anyone needs to nudge.
        members = {
            m for m in members
            if m in users and not users[m]["deleted"] and not is_service_account(m)
        }
    buckets = list(w.buckets)
    people = []
    for uid, p in persons.items():
        u = users.get(uid, {})
        people.append({
            "userId": uid,
            "name": u.get("name") or uid,
            "email": u.get("email"),
            "deleted": bool(u.get("deleted")),
            "actions": p.actions,
            "previous": int(previous.get(uid, 0)),
            "changePct": _delta(p.actions, int(previous.get(uid, 0))),
            "activeDays": len(p.active_days),
            "signIns": p.sign_ins if lens == FULL else None,
            "signInDays": len(p.sign_in_days) if lens == FULL else None,
            "idleSignInDays": len(p.sign_in_days - p.active_days) if lens == FULL else None,
            "lastActiveAt": p.last,
            "lastSignInAt": (p.last_sign_in or u.get("lastLoginAt")) if lens == FULL else None,
            "kinds": {k: int(v) for k, v in p.kinds.items() if v},
            "topKind": _top_kind(p.kinds),
            "values": [int(p.by_bucket.get(b, 0)) for b in buckets],
            "joinedInWindow": bool(u.get("createdAt") and u["createdAt"] >= w.start),
            "joinedAt": _joined(uid),
            "firstActiveAt": timeline.get(uid, {}).get("firstActiveAt"),
            "lastActiveEverAt": timeline.get(uid, {}).get("lastActiveAt") or p.last,
        })
    people.sort(key=lambda r: (-r["actions"], -(r["signIns"] or 0), r["name"].lower()))

    active_ids = {r["userId"] for r in people if r["actions"]}
    signed_ids = {r["userId"] for r in people if r["signIns"]}
    total_actions = sum(r["actions"] for r in people)
    sign_in_days = sum(r["signInDays"] or 0 for r in people)
    idle_days = sum(r["idleSignInDays"] or 0 for r in people)

    quiet = await _quiet(session, members=members, active=active_ids, users=users, lens=lens,
                         timeline=timeline, joined=_joined, scope_key=scope_key)

    doc = {
        "generatedAt": now.isoformat(),
        "window": _window_doc(w),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "coverage": {**await _coverage(session, w),
                     "index": await people_index_repo.coverage(session, now=now)},
        "totals": {
            "activePeople": _m(len(active_ids), sum(1 for v in previous.values() if v)),
            "signedIn": _m(len(signed_ids), len(prev_signed)) if lens == FULL else None,
            "actions": _m(total_actions, sum(previous.values())),
            "avgActiveDays": (
                round(sum(r["activeDays"] for r in people if r["actions"]) / len(active_ids), 1)
                if active_ids else None
            ),
            "idleSignIns": (
                {"days": idle_days, "signInDays": sign_in_days,
                 "rate": round(idle_days / sign_in_days, 3) if sign_in_days else None}
                if lens == FULL else None
            ),
            "newcomers": sum(1 for r in people if r["joinedInWindow"] and r["actions"]),
            "members": len(members) if members is not None else None,
            "quiet": quiet["count"],
        },
        "series": _series(rows, w, lens=lens),
        "kinds": _kind_list(totals_kinds, lens=lens),
        "types": _type_list(totals_types, type_kinds),
        "punchcard": _punch(rows),
        "sections": _sections(rows),
        "people": people,
        "quiet": quiet,
    }
    doc["insights"] = _people_insights(doc, w)
    return doc


def _m(current: int, previous: int) -> dict:
    return {"current": int(current), "previous": int(previous),
            "changePct": _delta(int(current), int(previous))}


async def _quiet(
    session: AsyncSession, *, members: Optional[set[str]], active: set[str],
    users: dict[str, dict], lens: str, timeline: dict[str, dict], joined,
    scope_key: str,
) -> dict:
    """Who has access and did nothing in the window.

    In a workspace: its members, every one of them, by name — the list a workspace admin acts
    on. Platform-wide: an exact count of live accounts, and the most recently seen of them by
    name, because "everyone who did nothing" on a large tenancy is a list nobody reads past
    the first screen.
    """
    members_scope = members is not None

    def _row(uid: str, u: dict) -> dict:
        # ``lastActiveAt`` is the last time they did something IN THIS SCOPE, from the index —
        # in a workspace, their last activity there. When they last signed in, or did
        # anything anywhere on the platform, is presence a workspace admin is not told.
        here = timeline.get(uid, {}).get("lastActiveAt")
        return {
            "userId": uid, "name": u.get("name") or uid, "email": u.get("email"),
            "joinedAt": joined(uid),
            "lastLoginAt": u.get("lastLoginAt") if lens == FULL else None,
            "lastActiveAt": here or (u.get("lastActiveAt") if lens == FULL and not members_scope
                                     else None),
        }

    if members is not None:
        quiet_ids = sorted(
            (m for m in members if m not in active),
            key=lambda m: (users.get(m, {}).get("lastActiveAt") or ""), reverse=True,
        )
        return {"count": len(quiet_ids),
                "people": [_row(m, users.get(m, {})) for m in quiet_ids]}

    live = [UserORM.deleted_at.is_(None), is_person(UserORM.id),
            UserORM.status == "active", UserORM.is_system_account.is_not(True)]
    total_live = int((await session.execute(
        select(func.count()).select_from(UserORM).where(*live))).scalar() or 0)
    live_active = 0
    for chunk in _chunked(sorted(active)):
        live_active += int((await session.execute(
            select(func.count()).select_from(UserORM).where(*live, UserORM.id.in_(chunk))
        )).scalar() or 0)
    listed: list[dict] = []
    # Over-fetch by the number of active people so the cap survives skipping them, without
    # reading the whole users table.
    candidates = (await session.execute(
        select(UserORM.id).where(*live)
        .order_by(UserORM.last_active_at.desc().nulls_last(), UserORM.id)
        .limit(_QUIET_LISTED + len(active))
    )).scalars().all()
    wanted = [c for c in candidates if c not in active][:_QUIET_LISTED]
    named = await _users(session, wanted)
    timeline.update(await people_index_repo.timeline_for_workspace(session, scope_key, wanted))
    users.update(named)
    listed = [_row(uid, named.get(uid, {})) for uid in wanted]
    return {"count": max(total_live - live_active, 0), "people": listed}


def _people_insights(doc: dict, w: Window) -> list[dict]:
    """What a reader should notice, in sentences. Pure: a function of the finished document,
    so no sentence can contradict the chart beneath it. Every rule is guarded on enough
    people that a young install gets silence rather than findings made of three users."""
    out: list[dict] = []
    totals = doc["totals"]
    label = _window_label(w)

    members, quiet = totals.get("members"), totals.get("quiet")
    if members and members >= 5 and quiet:
        share = quiet / members
        out.append(_insight(
            "people-quiet-members", "watch" if share >= 0.25 else "neutral",
            f"{quiet} of {members} members did nothing here {label}",
            "They still have access. A nudge, or a review of who needs it, is the next step.",
            score=share * 10,
        ))

    idle = totals.get("idleSignIns")
    if idle and idle["signInDays"] >= 20 and idle["rate"] and idle["rate"] >= 0.25:
        out.append(_insight(
            "people-idle-sign-ins", "watch",
            f"{_pct(idle['rate'] * 100)} of sign-in days led to nothing",
            "People signed in and left without opening, tracing or changing anything. "
            "Check what they land on.",
            score=idle["rate"] * 8,
        ))

    active = totals["activePeople"]
    change = active.get("changePct")
    if active["previous"] >= 5 and change is not None and abs(change) >= 15:
        up = change > 0
        out.append(_insight(
            "people-active-change", "good" if up else "bad",
            f"Active people {'up' if up else 'down'} {_pct(change)} {label}",
            f"{active['current']} {_plural(active['current'], 'person', 'people')} did something, "
            f"against {active['previous']} in the period before.",
            score=abs(change) / 10, spark=doc["series"]["activePeople"],
        ))

    people = [p for p in doc["people"] if p["actions"]]
    if len(people) >= 10:
        top = max(1, len(people) // 10)
        share = sum(p["actions"] for p in people[:top]) / max(1, sum(p["actions"] for p in people))
        if share >= 0.5:
            out.append(_insight(
                "people-concentration", "watch",
                f"The most active 10% of people do {_pct(share * 100)} of the work",
                "Usage leans on a few people. If they move on, so does the habit.",
                score=share * 6,
            ))

    grid = doc["punchcard"]
    busiest = max(((d, h, grid[d][h]) for d in range(7) for h in range(24)),
                  key=lambda t: t[2], default=(0, 0, 0))
    if sum(map(sum, grid)) >= 50 and busiest[2] > 0:
        weekday = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                   "Saturday", "Sunday")[busiest[0]]
        out.append(_insight(
            "people-peak-hour", "neutral",
            f"Busiest on {weekday}s around {busiest[1]:02d}:00 UTC",
            "A good time for changes people should see, and a bad time for maintenance.",
            score=1,
        ))

    out.sort(key=lambda i: -i["_score"])
    for item in out:
        item.pop("_score", None)
    return out


# ── One person ────────────────────────────────────────────────────────


async def _person_rows(
    session: AsyncSession, user_id: str, *, since: str, until: Optional[str],
    workspace_id: Optional[str], lens: str,
) -> list[_Row]:
    """One person's rows from all three stores, placed in the scope.

    Their view opens are read unscoped by the person's own index and placed through each
    view's workspace here — a person opens dozens of views, a workspace holds thousands.
    """
    usage = await _usage_rows(session, since=since, until=until, actor=user_id)
    opened = {r.subject for r in usage if r.type == VIEW_OPENED and r.subject}
    homes = {vid: v["workspaceId"] for vid, v in (await _views(session, opened)).items()}
    # A view open's workspace is its view's.
    usage = [
        replace(r, workspace=homes.get(r.subject)) if r.type == VIEW_OPENED else r
        for r in usage
    ]
    if workspace_id:
        usage = [r for r in usage if r.workspace == workspace_id]
    rows = usage
    rows += await _edit_rows(session, since=since, until=until, lens=lens,
                             actor=user_id, workspace_id=workspace_id)
    rows += await _ledger_rows(session, since=since, until=until, lens=lens,
                               actor=user_id, workspace_id=workspace_id)
    if workspace_id and lens == FULL:
        rows += await _signin_rows(session, since=since, until=until, people=[user_id])
    return rows


async def profile(session: AsyncSession, user_id: str) -> Optional[dict]:
    users = await _users(session, [user_id])
    u = users.get(user_id)
    if u is None:
        return None
    return {"userId": user_id, **u}


async def person_doc(
    session: AsyncSession, user_id: str, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None, workspace_id: Optional[str] = None,
    lens: str = FULL,
) -> Optional[dict]:
    """One person over one window. ``None`` when there is no such account."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    who = await profile(session, user_id)
    if who is None:
        return None

    rows = await _person_rows(session, user_id, since=w.start, until=w.end,
                              workspace_id=workspace_id, lens=lens)
    prev_rows = await _person_rows(session, user_id, since=w.previous_start, until=w.start,
                                   workspace_id=workspace_id, lens=lens)

    p = _Person()
    for r in rows:
        p.add(r, w.bucket_of(r.day))
    q = _Person()
    for r in prev_rows:
        q.add(r, None)

    def _count(types: Sequence[str], person: _Person = p) -> int:
        return int(sum(person.types.get(t, 0) for t in types))

    first_by_day: dict[str, str] = {}
    last_by_day: dict[str, str] = {}
    for r in rows:
        if r.type == SECTION or r.kind == "signin":
            continue
        if r.day not in first_by_day or r.first < first_by_day[r.day]:
            first_by_day[r.day] = r.first
        if r.day not in last_by_day or r.last > last_by_day[r.day]:
            last_by_day[r.day] = r.last
    firsts = [m for m in map(_minute_of_day, first_by_day.values()) if m is not None]
    lasts = [m for m in map(_minute_of_day, last_by_day.values()) if m is not None]
    longest, current = _streaks(p.active_days, last_day=w.end[:10])

    # Where their activity landed, and what they opened.
    by_ws: Counter = Counter()
    for r in rows:
        if r.type != SECTION and r.kind != "signin" and r.workspace:
            by_ws[r.workspace] += r.count
    # Every workspace they belong to or were ever active in, with when they joined it and were
    # first and last active there — from the index, so it reaches back past the window and
    # past raw-event retention. The window's actions sit beside it.
    timeline = await people_index_repo.timeline_for_person(session, user_id)
    platform_row = timeline.pop(people_index_repo.PLATFORM, {})
    joins = {ws: at for (_uid, ws), at in (await people_index_repo.join_candidates(
        session, user_id=user_id, workspace_id=workspace_id)).items()}
    ws_ids = set(by_ws) | set(timeline) | set(joins)
    if workspace_id:
        ws_ids &= {workspace_id}
    ws_names = await user_repo.get_workspace_names_by_ids(session, sorted(ws_ids))
    ws_rows = []
    for ws in ws_ids:
        t = timeline.get(ws, {})
        ws_rows.append({
            "workspaceId": ws, "name": ws_names.get(ws), "actions": int(by_ws.get(ws, 0)),
            "joinedAt": people_index_repo.merge_join(t, joins.get(ws)),
            "firstActiveAt": t.get("firstActiveAt"),
            "lastActiveAt": t.get("lastActiveAt"),
            "member": ws in joins,
        })
    # Busiest in the window first, then most recently active.
    ws_rows.sort(key=lambda r: (r["actions"], r["lastActiveAt"] or ""), reverse=True)
    opens: Counter = Counter()
    for r in rows:
        if r.type == VIEW_OPENED and r.subject:
            opens[r.subject] += r.count
    top_views = [vid for vid, _ in opens.most_common(10)]
    view_meta = await _views(session, top_views)

    type_kinds = {r.type: r.kind for r in rows}
    traces = _count((TRACE_RUN, TRACE_EMPTY))
    searches = _count((SEARCH_RUN, SEARCH_MISS))
    doc = {
        "generatedAt": now.isoformat(),
        "window": _window_doc(w),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "coverage": {**await _coverage(session, w),
                     "index": await people_index_repo.coverage(session, now=now)},
        "profile": {**who,
                    "firstActiveAt": platform_row.get("firstActiveAt") if not workspace_id
                    else (timeline.get(workspace_id) or {}).get("firstActiveAt")},
        "totals": {
            "actions": _m(p.actions, q.actions),
            "activeDays": _m(len(p.active_days), len(q.active_days)),
            "signIns": _m(p.sign_ins, q.sign_ins) if lens == FULL else None,
            "idleSignInDays": len(p.sign_in_days - p.active_days) if lens == FULL else None,
            "viewsOpened": _m(_count((VIEW_OPENED,)), _count((VIEW_OPENED,), q)),
            "distinctViews": len(opens),
            "traces": _m(traces, _count((TRACE_RUN, TRACE_EMPTY), q)),
            "traceEmptyRate": round(_count((TRACE_EMPTY,)) / traces, 3) if traces else None,
            "searches": _m(searches, _count((SEARCH_RUN, SEARCH_MISS), q)),
            "searchMissRate": round(_count((SEARCH_MISS,)) / searches, 3) if searches else None,
            "longestStreak": longest,
            "currentStreak": current,
            "lastActiveAt": p.last,
        },
        "series": _series(rows, w, lens=lens),
        "kinds": _kind_list(p.kinds, lens=lens),
        "types": _type_list(p.types, type_kinds),
        "punchcard": _punch(rows),
        "sections": _sections(rows),
        "typicalDay": {
            "firstMinute": int(median(firsts)) if firsts else None,
            "lastMinute": int(median(lasts)) if lasts else None,
            "days": len(firsts),
        },
        "workspaces": ws_rows,
        "views": [
            {"viewId": vid, "opens": int(opens[vid]), **view_meta.get(vid, {"name": None,
             "workspaceId": None, "visibility": None, "createdBy": None, "deleted": True})}
            for vid in top_views
        ],
        "signIns": (await _sign_in_detail(session, user_id, w) if lens == FULL else None),
    }
    return doc


def _method(payload: dict) -> str:
    """How a sign-in happened, as the ledger recorded it: an SSO provider's slug, or how a
    local sign-in got in (``via``), or ``local``."""
    return str(payload.get("provider_slug") or payload.get("via") or payload.get("provider")
               or "local")


async def _sign_in_detail(session: AsyncSession, user_id: str, w: Window) -> dict:
    """Their own sign-ins, how they were made, and the failures against their account. Only on
    the full lens: a workspace admin is told nothing about anyone's sign-ins."""
    T = AuthAuditLogORM
    rows = (await session.execute(
        select(T.occurred_at, T.payload)
        .where(T.actor_id == user_id, T.event_type == SIGN_IN,
               *_bounds(T.occurred_at, w.start, w.end))
        .order_by(T.occurred_at.desc())
        .limit(500)
    )).all()
    methods: Counter = Counter()
    recent = []
    for at, raw in rows:
        try:
            payload = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            payload = {}
        method = _method(payload if isinstance(payload, dict) else {})
        methods[method] += 1
        if len(recent) < 10:
            recent.append({"at": at, "method": method})
    failed = int((await session.execute(
        select(func.count()).select_from(T).where(
            T.subject_id == user_id, T.event_type.in_(_FAILED_SIGN_INS),
            *_bounds(T.occurred_at, w.start, w.end),
        )
    )).scalar() or 0)
    return {
        "methods": [{"key": k, "count": int(n)} for k, n in methods.most_common()],
        "recent": recent,
        "failed": failed,
        "capped": len(rows) >= 500,
    }


async def person_calendar(
    session: AsyncSession, user_id: str, *, now: Optional[datetime] = None,
    workspace_id: Optional[str] = None, lens: str = FULL,
) -> dict:
    """The last year, a day at a time — independent of the range picker, so the calendar on a
    person's page always shows the whole year around whatever window is selected."""
    now = now or datetime.now(timezone.utc)
    last = now.date()
    first = last - timedelta(days=CALENDAR_DAYS - 1)
    since = datetime.combine(first, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    rows = await _person_rows(session, user_id, since=since, until=None,
                              workspace_id=workspace_id, lens=lens)
    actions: Counter = Counter()
    sign_ins: Counter = Counter()
    for r in rows:
        if r.type == SECTION:
            continue
        (sign_ins if r.kind == "signin" else actions)[r.day] += r.count
    days = [(first + timedelta(days=i)).isoformat() for i in range(CALENDAR_DAYS)]
    return {
        "generatedAt": now.isoformat(),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "days": days,
        "actions": [int(actions.get(d, 0)) for d in days],
        "signIns": [int(sign_ins.get(d, 0)) for d in days] if lens == FULL else None,
    }


# ── One person's events ───────────────────────────────────────────────

#: What a feed can be filtered to: the activity kinds, and section moves.
FEED_KINDS: tuple[str, ...] = KINDS + ("section",)

_BUILD_PREFIXES = ("ontology.", "workspace.versioning.", "visualization.")


def _usage_types_for(kinds: Optional[set[str]]) -> list[str]:
    types = [t for t, k in USAGE_KINDS.items() if kinds is None or k in kinds]
    if kinds is None or "section" in kinds:
        types.append(SECTION)
    return types


def _edit_actions_for(kinds: Optional[set[str]]) -> Optional[list[str]]:
    """``None`` for every action; a list (maybe empty) for the kinds asked for."""
    if kinds is None:
        return None
    return [a for a, (_label, k) in _EDIT_META.items() if k in kinds]


def _ledger_kinds_clause(kinds: Optional[set[str]]):
    """:func:`ledger_kind` as SQL, so a filtered feed pages through the ledger in the
    database rather than discarding rows after reading them."""
    if kinds is None:
        return None
    L = AuthAuditLogORM
    build = or_(*[L.event_type.startswith(p, autoescape=True) for p in _BUILD_PREFIXES])
    operating = L.category.in_(("operations", "data"))
    clauses = {
        "signin": L.event_type == SIGN_IN,
        "build": and_(L.event_type != SIGN_IN, build),
        "operate": and_(L.event_type != SIGN_IN, ~build, operating),
        "other": and_(L.event_type != SIGN_IN, ~build,
                      or_(L.category.is_(None), ~operating)),
    }
    picked = [clauses[k] for k in kinds if k in clauses]
    return or_(*picked) if picked else False


def _keyset(ts_col, id_col, before: Optional[tuple[str, str]]) -> list:
    if not before:
        return []
    at, eid = before
    return [or_(ts_col < at, and_(ts_col == at, id_col < eid))]


async def person_events(
    session: AsyncSession, user_id: str, *, since: Optional[str] = None,
    until: Optional[str] = None, before: Optional[tuple[str, str]] = None,
    limit: int = 50, newest_first: bool = True, workspace_id: Optional[str] = None,
    lens: str = FULL, kinds: Optional[set[str]] = None,
) -> tuple[list[dict], Optional[tuple[str, str]]]:
    """One person's individual events from all three stores, merged in time order.

    Keyset-paged on ``(at, id)``: each store is read through its actor index for at most
    ``limit + 1`` rows past the cursor, the merge keeps the first ``limit``, and the next
    cursor is the last row KEPT — so paging can never skip a row or loop, whichever store the
    rows came from. Returns ``(events, next_cursor)``; no cursor means the end.

    In a workspace, a view open with no workspace yet (recorded in the last minutes, before
    the indexer has placed it) is read and then placed through its view, so the feed is
    current without waiting for the index. A page can then come back short; the cursor
    still moves, and the next page carries on.
    """
    direction = (lambda c: c.desc()) if newest_first else (lambda c: c.asc())
    candidates: list[tuple[str, str, str, tuple]] = []

    P = ProductEventORM
    types = _usage_types_for(kinds)
    if types:
        where = [P.actor_id == user_id, P.event_type.in_(types),
                 *_bounds(P.created_at, since or "", until), *_keyset(P.created_at, P.id, before)]
        if workspace_id:
            where.append(or_(P.workspace_id == workspace_id,
                             and_(P.workspace_id.is_(None), P.event_type == VIEW_OPENED)))
        for row in (await session.execute(
            select(P.id, P.created_at, P.event_type, P.subject_id, P.workspace_id)
            .where(*where).order_by(direction(P.created_at), direction(P.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "usage", tuple(row)))

    E = ViewActivityLogORM
    actions = _edit_actions_for(kinds)
    if actions is None or actions:
        where = [E.actor == user_id, *_bounds(E.created_at, since or "", until),
                 *_keyset(E.created_at, E.id, before)]
        if actions is not None:
            where.append(E.action.in_(actions))
        if workspace_id:
            where.append(E.workspace_id == workspace_id)
        if lens == WORKSPACE:
            where.append(E.action != _ADMIN_VIEWED)
        for row in (await session.execute(
            select(E.id, E.created_at, E.action, E.view_id, E.workspace_id, E.summary)
            .where(*where).order_by(direction(E.created_at), direction(E.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "edit", tuple(row)))

    L = AuthAuditLogORM
    kinds_clause = _ledger_kinds_clause(kinds)
    if kinds_clause is not False:
        where = [
            L.actor_id == user_id, L.actor_kind == "user",
            *_bounds(L.occurred_at, since or "", until), *_keyset(L.occurred_at, L.id, before),
            ~L.event_type.startswith(_MIRRORED_LEDGER_PREFIX, autoescape=True),
        ]
        if kinds_clause is not None:
            where.append(kinds_clause)
        if lens == WORKSPACE:
            where.append(L.event_type != SIGN_IN)
        if workspace_id:
            scoped = and_(*_ledger_scope(lens, workspace_id))
            where.append(or_(scoped, L.event_type == SIGN_IN) if lens == FULL else scoped)
        for row in (await session.execute(
            select(L.id, L.occurred_at, L.event_type, L.category, L.target_type, L.target_id,
                   L.target_label, L.workspace_id, L.outcome)
            .where(*where).order_by(direction(L.occurred_at), direction(L.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "ledger", tuple(row)))

    candidates.sort(key=lambda c: (c[0], c[1]), reverse=newest_first)
    kept = candidates[:limit]
    next_cursor = (kept[-1][0], kept[-1][1]) if len(candidates) > limit and kept else None

    opened = {row[3] for _, _, src, row in kept if src == "usage" and row[2] == VIEW_OPENED}
    edited = {row[3] for _, _, src, row in kept if src == "edit" and row[3]}
    views = await _views(session, opened | edited)

    events: list[dict] = []
    for at, eid, src, row in kept:
        if src == "usage":
            _id, _at, t, subject, ws = row
            if t == VIEW_OPENED:
                ws = ws or views.get(subject, {}).get("workspaceId")
            if workspace_id and ws != workspace_id:
                continue
            events.append({
                "id": eid, "at": at, "type": t,
                "kind": "section" if t == SECTION else USAGE_KINDS[t],
                "label": "Went to a section" if t == SECTION else USAGE_LABELS[t],
                "workspaceId": ws,
                "section": subject if t == SECTION else None,
                "viewId": subject if t == VIEW_OPENED else None,
            })
        elif src == "edit":
            _id, _at, action, view_id, ws, summary = row
            t = edit_type(action)
            events.append({
                "id": eid, "at": at, "type": t, "kind": kind_of(t), "label": label_of(t),
                "workspaceId": ws, "viewId": view_id, "summary": summary,
            })
        else:
            _id, _at, t, category, target_type, target_id, target_label, ws, outcome = row
            events.append({
                "id": eid, "at": at, "type": t, "kind": ledger_kind(t, category),
                "label": catalogue.label_of(t), "workspaceId": ws, "outcome": outcome,
                "target": ({"type": target_type, "id": target_id, "label": target_label}
                           if target_type or target_label else None),
            })

    ws_names = await user_repo.get_workspace_names_by_ids(
        session, sorted({e["workspaceId"] for e in events if e.get("workspaceId")}))
    for e in events:
        if e.get("viewId"):
            meta = views.get(e["viewId"], {})
            e["view"] = {"id": e["viewId"], "name": meta.get("name"),
                         "workspaceId": meta.get("workspaceId"),
                         "visibility": meta.get("visibility"),
                         "createdBy": meta.get("createdBy"),
                         "deleted": meta.get("deleted", True)}
        if e.get("workspaceId"):
            e["workspaceName"] = ws_names.get(e["workspaceId"])
    return events, next_cursor


async def person_day(
    session: AsyncSession, user_id: str, day: str, *,
    workspace_id: Optional[str] = None, lens: str = FULL, cap: int = DAY_CAP,
) -> dict:
    """Everything one person did on one UTC day, in order, split into sessions.

    Not cached and not grouped: one person and one day, read through each table's actor
    index — the one place besides the feed where a reader sees individual events."""
    the_day = date.fromisoformat(day)
    since = datetime.combine(the_day, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    until = datetime.combine(the_day + timedelta(days=1), datetime.min.time(),
                             tzinfo=timezone.utc).isoformat()
    events, more = await person_events(
        session, user_id, since=since, until=until, limit=cap, newest_first=False,
        workspace_id=workspace_id, lens=lens,
    )
    return {
        "day": day,
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "events": events,
        "sessions": sessions_of(events),
        "truncated": more is not None,
        "kinds": dict(Counter(e["kind"] for e in events)),
    }


def sessions_of(events: Sequence[dict], *, gap_minutes: int = SESSION_GAP_MINUTES) -> list[dict]:
    """Split a day's events wherever nothing happened for ``gap_minutes``.

    Derived, not tracked: the platform records no "session started", and the gap rule is the
    conventional web-analytics definition. Section moves count toward a session's span — being
    around is being around — but not toward its action count.
    """
    out: list[dict] = []
    gap = timedelta(minutes=gap_minutes)
    current: Optional[dict] = None
    last_at: Optional[datetime] = None
    for e in events:
        try:
            at = datetime.fromisoformat(e["at"])
        except (TypeError, ValueError):
            continue
        if current is None or last_at is None or at - last_at > gap:
            current = {"start": e["at"], "end": e["at"], "actions": 0, "kinds": Counter()}
            out.append(current)
        current["end"] = e["at"]
        if e["kind"] not in ("section", "signin"):
            current["actions"] += 1
        current["kinds"][e["kind"]] += 1
        last_at = at
    for s in out:
        s["kinds"] = dict(s["kinds"])
    return out


# ── Redaction ─────────────────────────────────────────────────────────
#
# Each redactor builds what leaves from an explicit allow-list of fields, never a spread of
# the cached row, so a field added to a builder above is withheld until someone names it here.
# ``viewer`` is an ``analytics_scope.ViewerScope``.

_ROSTER_FIELDS = (
    "userId", "name", "deleted", "actions", "previous", "changePct", "activeDays", "signIns",
    "signInDays", "idleSignInDays", "lastActiveAt", "lastSignInAt", "kinds", "topKind",
    "values", "joinedInWindow", "joinedAt", "firstActiveAt", "lastActiveEverAt",
)
_QUIET_FIELDS = ("userId", "name", "joinedAt", "lastLoginAt", "lastActiveAt")


def _with_email(row: dict, src: dict, viewer) -> dict:
    if viewer.privileged:
        row["email"] = src.get("email")
    return row


def redact_people(doc: dict, viewer) -> dict:
    out = {k: doc[k] for k in ("generatedAt", "window", "scope", "coverage", "totals",
                               "series", "kinds", "types", "punchcard", "sections", "insights")}
    out["people"] = [
        _with_email({k: p.get(k) for k in _ROSTER_FIELDS}, p, viewer) for p in doc["people"]
    ]
    out["quiet"] = {
        "count": doc["quiet"]["count"],
        "people": [
            _with_email({k: q.get(k) for k in _QUIET_FIELDS}, q, viewer)
            for q in doc["quiet"]["people"]
        ],
    }
    return out


def _view_out(meta: dict, viewer) -> dict:
    visible = viewer.can_see_view(
        workspace_id=meta.get("workspaceId"), visibility=meta.get("visibility"),
        created_by=meta.get("createdBy"),
    )
    return {
        "id": meta.get("id") or meta.get("viewId"),
        "name": meta.get("name") if visible else None,
        "locked": not visible,
        "deleted": bool(meta.get("deleted")),
        "workspaceId": meta.get("workspaceId") if visible else None,
        "canOpen": visible and not meta.get("deleted"),
    }


def _workspace_out(ws_id: Optional[str], name: Optional[str], viewer) -> dict:
    visible = viewer.can_see(ws_id)
    return {
        "workspaceId": ws_id if visible else None,
        "name": name if visible else None,
        "locked": not visible,
        "canOpen": viewer.can_open(ws_id),
    }


def redact_person(doc: dict, viewer, *, is_self: bool) -> dict:
    out = {k: doc[k] for k in ("generatedAt", "window", "scope", "coverage", "totals",
                               "series", "kinds", "types", "punchcard", "sections",
                               "typicalDay", "signIns")}
    prof = doc["profile"]
    out["profile"] = {k: prof.get(k) for k in (
        "userId", "name", "status", "createdAt", "deleted", "lastLoginAt", "lastSeenAt",
        "lastActiveAt", "firstActiveAt")}
    if doc["scope"]["lens"] != FULL:
        # Signing in, and being seen or active anywhere on the platform, are not any one
        # workspace's to report. Their activity HERE is in ``totals.lastActiveAt``.
        for key in ("lastLoginAt", "lastSeenAt", "lastActiveAt"):
            out["profile"][key] = None
    if viewer.privileged or is_self:
        out["profile"]["email"] = prof.get("email")
    out["workspaces"] = [
        {**_workspace_out(w["workspaceId"], w["name"], viewer),
         **{k: w.get(k) for k in ("actions", "joinedAt", "firstActiveAt", "lastActiveAt",
                                  "member")}}
        for w in doc["workspaces"]
    ]
    out["views"] = [
        {**_view_out({**v, "id": v["viewId"]}, viewer), "opens": v["opens"]}
        for v in doc["views"]
    ]
    return out


def redact_events(events: Sequence[dict], viewer) -> list[dict]:
    out = []
    for e in events:
        row = {k: e.get(k) for k in ("id", "at", "type", "kind", "label", "section",
                                     "outcome", "target")}
        ws = _workspace_out(e.get("workspaceId"), e.get("workspaceName"), viewer)
        row["workspace"] = ws if e.get("workspaceId") else None
        if e.get("view"):
            row["view"] = _view_out(e["view"], viewer)
            # An edit's summary names the view; it goes where the name goes.
            row["summary"] = e.get("summary") if not row["view"]["locked"] else None
        else:
            row["view"] = None
            row["summary"] = e.get("summary")
        out.append(row)
    return out


def redact_day(doc: dict, viewer) -> dict:
    return {**{k: doc[k] for k in ("day", "scope", "sessions", "truncated", "kinds")},
            "events": redact_events(doc["events"], viewer)}
