"""Platform analytics — aggregate reads for the business insights dashboard.

Backs ``/api/v1/admin/analytics``. Answers the growth questions the operational
surfaces don't: how many users signed up this period versus last, how many are
genuinely active, what people actually open, and which workspaces are alive.

Two house rules shape every query in here.

**No cross-domain JOINs.** ``backend/app/db/DOMAIN_OWNERSHIP.md`` forbids joining
tables owned by different logical domains, and
``backend/scripts/check_cross_domain_joins.py`` enforces it. So every aggregate
below is a *single-table* ``GROUP BY``; anything that needs a name is stitched by
ID afterwards — user display names through
:func:`view_repo.resolve_user_ids`, view and workspace names through their own
tables. No query in this module adds to the lint's baseline.

**Bucketing happens in SQL, deliberately.** The house pattern elsewhere
(``product_event_repo.summary``) fetches a window and folds it in Python, on the
stated grounds that "volumes are small". A row per view-open breaks that premise,
so day-bucketing here is ``substr(col, 1, 10)`` — every timestamp column in this
schema is ISO-8601 UTC ``TEXT`` (see ``models._now``), so the first ten characters
are always ``YYYY-MM-DD`` and lexicographic range comparison is ordering-correct.
``substr`` is core SQL and behaves identically on SQLite and Postgres, and the
predicates ride existing indexes.

The one exception is per-view/per-workspace open counts: ``product_events`` keeps
its subject in a JSON ``payload`` column, which no portable SQL can group on. Those
are folded in Python from a single narrow ``SELECT payload`` over the window —
one pass serving every payload-derived ranking.

Buckets are UTC days. This codebase has no viewer-timezone convention to follow.
"""
from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterable, Optional, Sequence

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AccessRequestORM,
    AnnouncementORM,
    CatalogItemORM,
    ContextModelORM,
    GroupMemberORM,
    GroupORM,
    InviteORM,
    InviteRedemptionORM,
    OntologyORM,
    OntologySourceMappingORM,
    OutboxEventORM,
    ProductEventORM,
    RefreshEventORM,
    RoleBindingORM,
    UserORM,
    ViewActivityLogORM,
    ViewFavouriteORM,
    ViewORM,
    ViewVisitORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import stats_repo
from backend.app.db.repositories.view_repo import resolve_user_ids

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.app.services.analytics_scope import ViewerScope

logger = logging.getLogger(__name__)

#: Event type appended by ``view_repo.record_view_visit`` on every view open.
VIEW_OPENED = "view.opened"

#: The product's own actions. These say someone got VALUE out of the platform,
#: as distinct from the ``docs.``/``tour.`` events, which only say we managed to
#: explain ourselves. Emitted by the frontend through
#: ``services/telemetryService.ts`` and allow-listed in
#: ``api/v1/endpoints/telemetry.py``.
TRACE_RUN = "lineage.trace"
TRACE_EMPTY = "lineage.trace_empty"
SEARCH_RUN = "graph.search"
SEARCH_MISS = "graph.search_miss"
GRAPH_EXPORT = "graph.export"
VERSION_PUBLISHED = "version.published"
ONTOLOGY_PUBLISHED = "ontology.published"

#: Feature → the event types that prove somebody used it. Tuple order is the
#: display order of the adoption matrix, deliberately value-first: tracing
#: lineage is what this platform is FOR, so it leads.
FEATURE_EVENTS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("lineage", "Lineage tracing", (TRACE_RUN, TRACE_EMPTY)),
    ("search", "Graph search", (SEARCH_RUN, SEARCH_MISS)),
    ("views", "Saved views", (VIEW_OPENED,)),
    ("export", "Export", (GRAPH_EXPORT,)),
    ("versioning", "Version control", (VERSION_PUBLISHED,)),
    ("ontology", "Semantic layer", (ONTOLOGY_PUBLISHED,)),
)

#: Windows at or below this many days get one bucket per day; longer windows
#: bucket by week, so a 365-day chart plots 53 marks instead of 365.
_DAILY_BUCKET_MAX_DAYS = 31

#: How many rows a leaderboard returns.
TOP_N = 10

#: Hard ceiling on a custom range, matching the ``days`` query cap. Without it
#: an arbitrary 'from' turns the endpoint into an unbounded scan.
_MAX_WINDOW_DAYS = 365

#: Categorical breakdowns fold their tail into "Other" past this many classes —
#: past ~7 classes adjacent colours stop being distinguishable.
_MAX_CLASSES = 6


# ── Window ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Window:
    """The slice every number on the dashboard is measured over.

    ``previous_start``/``start`` bound the immediately-preceding window of equal
    length, so a delta compares like with like rather than against all history.
    """

    days: int
    start: str              # ISO instant, inclusive
    end: str                # ISO instant — "now"
    previous_start: str     # ISO instant, inclusive
    granularity: str        # "day" | "week"
    buckets: list[str]      # bucket keys, ascending, YYYY-MM-DD
    _day_to_bucket: dict[str, str]

    def bucket_of(self, day: str) -> Optional[str]:
        return self._day_to_bucket.get(day)

    def align(self, by_day: dict[str, int]) -> list[int]:
        """Fold a ``{YYYY-MM-DD: count}`` map onto this window's buckets."""
        totals: dict[str, int] = {b: 0 for b in self.buckets}
        for day, count in by_day.items():
            bucket = self._day_to_bucket.get(day)
            if bucket is not None:
                totals[bucket] += count
        return [totals[b] for b in self.buckets]

    def running_total(self, by_day: dict[str, int], baseline: int) -> list[int]:
        """Cumulative curve: ``baseline`` is everything before the window opened."""
        out: list[int] = []
        total = baseline
        for value in self.align(by_day):
            total += value
            out.append(total)
        return out


class InvalidWindow(ValueError):
    """A caller-supplied date range that cannot be measured."""


class WorkspaceForbidden(PermissionError):
    """The workspace exists, and this caller may not see inside it.

    Deliberately distinct from "not found". The workspace-analytics table
    already discloses that it EXISTS (as a locked row), so answering 404 here
    would be a lie that protects nothing — and it would send someone hunting
    for a typo in an id that is perfectly correct.
    """


def previous_window(w: Window) -> Window:
    """The equal-length period immediately before ``w``.

    Used to draw the previous period as a ghost line behind the current one:
    the deltas in the KPI cards say a number moved, and this says what the shape
    of the move was. Aligned by bucket INDEX rather than by date — bucket 3 of
    last month against bucket 3 of this one — which is the only alignment that
    makes two different date ranges comparable on one axis.
    """
    start_day = date.fromisoformat(w.previous_start[:10])
    end_day = date.fromisoformat(w.start[:10]) - timedelta(days=1)
    if end_day < start_day:
        end_day = start_day
    return build_window(start=start_day.isoformat(), end=end_day.isoformat())


def build_window(
    days: Optional[int] = None,
    *,
    start: Optional[str] = None,
    end: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Window:
    """The slice every number is measured over.

    Two ways to say it, and they produce the SAME shape so nothing downstream
    has to care which was used:

      * ``days`` — a trailing window ending now. What the presets send.
      * ``start``/``end`` — explicit ``YYYY-MM-DD`` bounds, both inclusive.
        What a custom range sends. The end date is inclusive because a person
        picking "1–31 March" means all of the 31st, not midnight at its start.

    The comparison window is always the equal-length period immediately before
    ``start``, so a delta compares like with like in both modes.
    """
    now = now or datetime.now(timezone.utc)

    if start is not None or end is not None:
        if start is None or end is None:
            raise InvalidWindow("A custom range needs both 'from' and 'to'.")
        try:
            first_day = date.fromisoformat(start)
            last_day = date.fromisoformat(end)
        except ValueError as exc:
            raise InvalidWindow("Dates must be ISO 'YYYY-MM-DD'.") from exc
        if last_day < first_day:
            raise InvalidWindow("'from' must not be after 'to'.")
        span = (last_day - first_day).days + 1
        if span > _MAX_WINDOW_DAYS:
            raise InvalidWindow(
                f"A range may span at most {_MAX_WINDOW_DAYS} days.",
            )
        start_dt = datetime.combine(
            first_day, datetime.min.time(), tzinfo=timezone.utc)
        # Exclusive upper bound one day past the inclusive end date: every
        # comparison downstream is `< end`, and the alternative (23:59:59.999)
        # silently drops rows stamped in the final millisecond.
        end_dt = datetime.combine(
            last_day + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
        days = span
        previous_dt = start_dt - timedelta(days=span)
    else:
        if days is None:
            raise InvalidWindow("Pass either 'days' or a 'from'/'to' pair.")
        start_dt = now - timedelta(days=days)
        end_dt = now
        previous_dt = start_dt - timedelta(days=days)
        first_day = start_dt.date()
        last_day = now.date()

    all_days = [
        (first_day + timedelta(days=i)).isoformat()
        for i in range((last_day - first_day).days + 1)
    ]

    granularity = "day" if days <= _DAILY_BUCKET_MAX_DAYS else "week"
    day_to_bucket: dict[str, str] = {}
    buckets: list[str] = []
    for day in all_days:
        if granularity == "day":
            key = day
        else:
            # Week buckets anchor on the window's first day, so the leading
            # bucket is never a stub of whatever weekday the range began on.
            offset = (date.fromisoformat(day) - first_day).days
            key = (first_day + timedelta(days=(offset // 7) * 7)).isoformat()
        if not buckets or buckets[-1] != key:
            buckets.append(key)
        day_to_bucket[day] = key

    return Window(
        days=days,
        start=start_dt.isoformat(),
        end=end_dt.isoformat(),
        previous_start=previous_dt.isoformat(),
        granularity=granularity,
        buckets=buckets,
        _day_to_bucket=day_to_bucket,
    )


# ── Query helpers (single-table by construction) ─────────────────────

def _day(col) -> Any:
    """Day bucket key for an ISO-8601 TEXT timestamp column."""
    return func.substr(col, 1, 10)


async def _scalar(session: AsyncSession, stmt: Select) -> int:
    return int((await session.execute(stmt)).scalar() or 0)


async def _count_by_day(
    session: AsyncSession, ts_col, *, since: str, until: Optional[str] = None,
    where: Sequence[Any] = (),
) -> dict[str, int]:
    """``{YYYY-MM-DD: rows}`` for one table over one window."""
    bounds = [ts_col >= since] + ([ts_col < until] if until else [])
    stmt = (
        select(_day(ts_col).label("d"), func.count())
        .where(*bounds, *where)
        .group_by("d")
    )
    return {row[0]: int(row[1]) for row in (await session.execute(stmt)).all() if row[0]}


async def _distinct_by_day(
    session: AsyncSession, ts_col, subject_col, *, since: str,
    until: Optional[str] = None, where: Sequence[Any] = (),
) -> dict[str, set[str]]:
    """``{YYYY-MM-DD: {subject, …}}`` — distinct actors per day, kept as sets so
    callers can union several tables before counting."""
    bounds = [ts_col >= since] + ([ts_col < until] if until else [])
    stmt = (
        select(_day(ts_col).label("d"), subject_col)
        .where(*bounds, subject_col.is_not(None), *where)
        .group_by("d", subject_col)
    )
    out: dict[str, set[str]] = defaultdict(set)
    for day, subject in (await session.execute(stmt)).all():
        if day and subject:
            out[day].add(subject)
    return out


async def _count_group(
    session: AsyncSession, col, *, where: Sequence[Any] = (),
) -> list[tuple[str, int]]:
    """``[(value, count), …]`` descending — one categorical breakdown."""
    stmt = (
        select(col, func.count().label("n"))
        .where(*where)
        .group_by(col)
        .order_by(func.count().desc())
    )
    return [
        (str(value) if value is not None else "unknown", int(n))
        for value, n in (await session.execute(stmt)).all()
    ]


def _fold_tail(pairs: Sequence[tuple[str, int]], limit: int = _MAX_CLASSES) -> list[dict]:
    """Keep the top ``limit`` classes and sum the rest into "Other".

    Categorical colour runs out around seven slots; a generated eighth hue is
    indistinguishable from an existing one, so the tail folds rather than
    inventing colours for it.
    """
    head = list(pairs[:limit])
    tail = pairs[limit:]
    out = [{"key": key, "count": count} for key, count in head]
    if tail:
        out.append({"key": "Other", "count": sum(c for _, c in tail)})
    return out


def _delta(current: int, previous: int) -> Optional[float]:
    """Percent change against the previous window. ``None`` when there is no
    base to compare against — a fabricated "+100%" from zero is noise."""
    if previous <= 0:
        return None
    return round(((current - previous) / previous) * 100, 1)


def _metric(total: int, current: int, previous: int) -> dict:
    return {
        "total": total,
        "current": current,
        "previous": previous,
        "changePct": _delta(current, previous),
    }


def _decode(payload: Optional[str]) -> dict:
    if not payload:
        return {}
    try:
        value = json.loads(payload)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


@dataclass
class _OpenFold:
    """One pass over the windowed ``view.opened`` payloads.

    ``product_events`` keeps its subject in a JSON column, so per-view and
    per-workspace open counts cannot be grouped in portable SQL. Everything
    payload-derived is folded here, once, from a single narrow SELECT.
    """

    by_view: Counter
    by_workspace: Counter
    viewers_by_view: dict[str, set[str]]
    total: int


async def _view_workspaces(session: AsyncSession) -> dict[str, str]:
    """``{view_id: workspace_id}`` for every view, live or soft-deleted.

    Open events carry only the view id, so this is where an open becomes
    attributable to a workspace. Deleted views stay in the map on purpose —
    their opens really did happen, and dropping them would quietly understate
    a workspace's past traffic.
    """
    return {
        vid: ws_id
        for vid, ws_id in (await session.execute(
            select(ViewORM.id, ViewORM.workspace_id)
        )).all()
        if vid and ws_id
    }


async def _fold_opens(
    session: AsyncSession, *, since: str, until: Optional[str] = None,
    workspace_id: Optional[str] = None,
) -> _OpenFold:
    bounds = [ProductEventORM.created_at >= since]
    if until:
        bounds.append(ProductEventORM.created_at < until)
    stmt = (
        select(ProductEventORM.payload, ProductEventORM.actor_id)
        .where(ProductEventORM.event_type == VIEW_OPENED, *bounds)
    )
    view_to_ws = await _view_workspaces(session)

    by_view: Counter = Counter()
    by_workspace: Counter = Counter()
    viewers: dict[str, set[str]] = defaultdict(set)
    total = 0
    for payload, actor in (await session.execute(stmt)).all():
        view_id = _decode(payload).get("viewId")
        if not view_id:
            continue
        ws_id = view_to_ws.get(view_id)
        if workspace_id is not None and ws_id != workspace_id:
            continue
        total += 1
        by_view[view_id] += 1
        if actor:
            viewers[view_id].add(actor)
        if ws_id:
            by_workspace[ws_id] += 1
    return _OpenFold(by_view=by_view, by_workspace=by_workspace,
                     viewers_by_view=viewers, total=total)


# ── Activity actors ─────────────────────────────────────────────────

async def _actors_by_day(
    session: AsyncSession, *, since: str, until: Optional[str] = None,
    workspace_id: Optional[str] = None,
) -> dict[str, set[str]]:
    """Distinct active users per day, unioned across the two signals that carry
    a real actor column.

    Deliberately not sign-ins. ``auth_audit_log`` is filled by the outbox relay,
    which only runs on the scheduler-owner role, so on a web-only replica it is
    empty — and its user id lives inside a JSON payload. Doing something is also
    a truer read on engagement than signing in and bouncing.
    """
    ws_clause = (
        [ViewActivityLogORM.workspace_id == workspace_id] if workspace_id else []
    )
    from_activity = await _distinct_by_day(
        session, ViewActivityLogORM.created_at, ViewActivityLogORM.actor,
        since=since, until=until, where=ws_clause,
    )
    merged: dict[str, set[str]] = {day: set(actors) for day, actors in from_activity.items()}

    if workspace_id is None:
        from_events = await _distinct_by_day(
            session, ProductEventORM.created_at, ProductEventORM.actor_id,
            since=since, until=until,
        )
        for day, actors in from_events.items():
            merged.setdefault(day, set()).update(actors)
    return merged


def _flatten(actors_by_day: dict[str, set[str]], days: Optional[Iterable[str]] = None) -> set[str]:
    if days is None:
        return {a for actors in actors_by_day.values() for a in actors}
    wanted = set(days)
    return {a for day, actors in actors_by_day.items() if day in wanted for a in actors}


def _recent_days(count: int, *, now: datetime) -> list[str]:
    today = now.date()
    return [(today - timedelta(days=i)).isoformat() for i in range(count)]


# ── Platform summary ────────────────────────────────────────────────

async def platform_summary(
    session: AsyncSession, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> dict:
    """Everything the platform-wide Analytics dashboard renders, for one window."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)

    live_user = [UserORM.deleted_at.is_(None)]
    live_ws = [WorkspaceORM.deleted_at.is_(None)]
    live_view = [ViewORM.deleted_at.is_(None)]
    live_ds = [WorkspaceDataSourceORM.deleted_at.is_(None)]

    # One rollup over ``product_events`` feeds the adoption matrix, the value
    # moments, and the funnel's trace stage — three consumers, three queries.
    adoption = await _load_adoption(session, w)

    # ── Totals and per-window counts ────────────────────────────────
    users_total = await _scalar(session, select(func.count()).select_from(UserORM).where(*live_user))
    ws_total = await _scalar(session, select(func.count()).select_from(WorkspaceORM).where(*live_ws))
    views_total = await _scalar(session, select(func.count()).select_from(ViewORM).where(*live_view))
    ds_total = await _scalar(
        session, select(func.count()).select_from(WorkspaceDataSourceORM).where(*live_ds))
    ontologies_total = await _scalar(
        session, select(func.count()).select_from(OntologyORM).where(OntologyORM.deleted_at.is_(None)))
    models_total = await _scalar(session, select(func.count()).select_from(ContextModelORM))
    catalog_total = await _scalar(session, select(func.count()).select_from(CatalogItemORM))
    groups_total = await _scalar(
        session, select(func.count()).select_from(GroupORM).where(GroupORM.deleted_at.is_(None)))

    # Daily series over the window, plus the same tables over the previous
    # window so every KPI can carry an honest period-over-period delta.
    users_by_day = await _count_by_day(session, UserORM.created_at, since=w.start, where=live_user)
    ws_by_day = await _count_by_day(session, WorkspaceORM.created_at, since=w.start, where=live_ws)
    views_by_day = await _count_by_day(session, ViewORM.created_at, since=w.start, where=live_view)
    ds_by_day = await _count_by_day(
        session, WorkspaceDataSourceORM.created_at, since=w.start, where=live_ds)
    opens_by_day = await _count_by_day(
        session, ProductEventORM.created_at, since=w.start,
        where=[ProductEventORM.event_type == VIEW_OPENED],
    )
    activity_by_day = await _count_by_day(
        session, ViewActivityLogORM.created_at, since=w.start)
    signins_by_day = await _count_by_day(
        session, OutboxEventORM.created_at, since=w.start,
        where=[OutboxEventORM.event_type == "user.logged_in"],
    )

    async def _previous(ts_col, where: Sequence[Any] = ()) -> int:
        return await _scalar(
            session,
            select(func.count()).where(
                ts_col >= w.previous_start, ts_col < w.start, *where,
            ),
        )

    # All-time totals for the append-only signals, so a KPI's headline number
    # is a real total rather than the window's subtotal wearing a total's label.
    opens_total = await _scalar(
        session,
        select(func.count()).select_from(ProductEventORM)
        .where(ProductEventORM.event_type == VIEW_OPENED),
    )
    activity_total = await _scalar(
        session, select(func.count()).select_from(ViewActivityLogORM))

    users_prev = await _previous(UserORM.created_at, live_user)
    ws_prev = await _previous(WorkspaceORM.created_at, live_ws)
    views_prev = await _previous(ViewORM.created_at, live_view)
    ds_prev = await _previous(WorkspaceDataSourceORM.created_at, live_ds)
    opens_prev = await _previous(
        ProductEventORM.created_at, [ProductEventORM.event_type == VIEW_OPENED])
    activity_prev = await _previous(ViewActivityLogORM.created_at)

    # The onboarded-entity family: totals plus their own window/previous counts,
    # so "entities onboarded" carries a trend rather than a bare number.
    ontologies_new = await _scalar(session, select(func.count()).where(
        OntologyORM.created_at >= w.start, OntologyORM.deleted_at.is_(None)))
    ontologies_prev = await _previous(
        OntologyORM.created_at, [OntologyORM.deleted_at.is_(None)])
    models_new = await _scalar(session, select(func.count()).where(
        ContextModelORM.created_at >= w.start))
    models_prev = await _previous(ContextModelORM.created_at)
    catalog_new = await _scalar(session, select(func.count()).where(
        CatalogItemORM.created_at >= w.start))
    catalog_prev = await _previous(CatalogItemORM.created_at)
    groups_new = await _scalar(session, select(func.count()).where(
        GroupORM.created_at >= w.start, GroupORM.deleted_at.is_(None)))
    groups_prev = await _previous(GroupORM.created_at, [GroupORM.deleted_at.is_(None)])

    # Everything that existed before the window opened — the baseline the
    # cumulative curves start from, so "total users" is a real total.
    users_before = await _scalar(
        session,
        select(func.count()).where(UserORM.created_at < w.start, *live_user),
    )
    views_before = await _scalar(
        session,
        select(func.count()).where(ViewORM.created_at < w.start, *live_view),
    )
    ws_before = await _scalar(
        session,
        select(func.count()).where(WorkspaceORM.created_at < w.start, *live_ws),
    )

    # ── Activity ────────────────────────────────────────────────────
    actors_window = await _actors_by_day(session, since=w.start)
    actors_previous = await _actors_by_day(
        session, since=w.previous_start, until=w.start)
    active_now = _flatten(actors_window)
    active_prev = _flatten(actors_previous)

    # DAU/WAU/MAU are fixed-span by definition — they do not move with the
    # range picker, or the words would mean something different per range.
    actors_30d = await _actors_by_day(
        session, since=(now - timedelta(days=30)).isoformat())
    dau = len(_flatten(actors_30d, _recent_days(1, now=now)))
    wau = len(_flatten(actors_30d, _recent_days(7, now=now)))
    mau = len(_flatten(actors_30d, _recent_days(30, now=now)))

    # Distinct-per-bucket cannot be summed from a per-day count, so build it
    # from the actor sets directly.
    actors_per_bucket: dict[str, set[str]] = {b: set() for b in w.buckets}
    for day, actors in actors_window.items():
        bucket = w.bucket_of(day)
        if bucket is not None:
            actors_per_bucket[bucket].update(actors)
    active_series = [len(actors_per_bucket[b]) for b in w.buckets]

    opens = await _fold_opens(session, since=w.start)

    doc = {
        "windowDays": days,
        "generatedAt": now.isoformat(),
        "range": {
            "from": w.start,
            "to": w.end,
            "previousFrom": w.previous_start,
            "previousTo": w.start,
        },
        "bucket": w.granularity,
        "totals": {
            "users": _metric(users_total, sum(users_by_day.values()), users_prev),
            "activeUsers": _metric(users_total, len(active_now), len(active_prev)),
            "workspaces": _metric(ws_total, sum(ws_by_day.values()), ws_prev),
            "views": _metric(views_total, sum(views_by_day.values()), views_prev),
            "viewOpens": _metric(opens_total, sum(opens_by_day.values()), opens_prev),
            "dataSources": _metric(ds_total, sum(ds_by_day.values()), ds_prev),
            "activity": _metric(
                activity_total, sum(activity_by_day.values()), activity_prev),
            "ontologies": _metric(ontologies_total, ontologies_new, ontologies_prev),
            "contextModels": _metric(models_total, models_new, models_prev),
            "catalogItems": _metric(catalog_total, catalog_new, catalog_prev),
            "groups": _metric(groups_total, groups_new, groups_prev),
        },
        "series": {
            "buckets": w.buckets,
            "signups": w.align(users_by_day),
            "cumulativeUsers": w.running_total(users_by_day, users_before),
            "activeUsers": active_series,
            "signIns": w.align(signins_by_day),
            "viewsCreated": w.align(views_by_day),
            "cumulativeViews": w.running_total(views_by_day, views_before),
            "workspacesCreated": w.align(ws_by_day),
            "cumulativeWorkspaces": w.running_total(ws_by_day, ws_before),
            "viewOpens": w.align(opens_by_day),
            "activityEvents": w.align(activity_by_day),
            "dataSourcesOnboarded": w.align(ds_by_day),
            # The previous period's shape, aligned by bucket index, for the
            # ghost line drawn behind each series.
            "previous": await _ghost_series(
                session, w, live_user=live_user, live_view=live_view),
        },
        "engagement": await _engagement(
            session, w, now=now, dau=dau, wau=wau, mau=mau,
            active_now=active_now, active_prev=active_prev,
            tracers=adoption.users((TRACE_RUN,)),
        ),
        "breakdowns": await _breakdowns(session, w, opens=opens),
        "leaderboards": await _leaderboards(session, w, opens=opens),
        "graph": await _graph_scale(session),
        "adoption": _adoption_matrix(adoption, active_users=len(active_now)),
        "valueMoments": _value_moments(adoption),
        "health": {
            "reliability": await _reliability(session, w, sources=ds_total),
            "access": await _access_friction(session, w, now=now),
            "semanticLayer": await _semantic_adoption(session, sources=ds_total),
        },
        "annotations": await _annotations(session, w),
        "coverage": {
            "viewOpenTrackingSince": await _first_open_at(session),
            # Per-feature, because each signal starts on the day its
            # instrumentation shipped. A chart that plots zero for every date
            # before that reads as "nobody used it" when the truth is "we
            # weren't counting" — the UI needs to be able to tell them apart.
            "trackingSince": {
                key: adoption.since(types) for key, _label, types in FEATURE_EVENTS
            },
        },
    }
    # Interpretation runs LAST, over the finished document: the rules are a pure
    # function of what the dashboard already says, so they can never disagree
    # with the charts beneath them.
    doc["insights"] = _narrative(doc, window_label=_window_label(w))
    # Redaction is the last thing that happens, over the finished document.
    return redact_summary(doc, scope) if scope is not None else doc


async def _first_open_at(session: AsyncSession) -> Optional[str]:
    """When view-open tracking started producing data.

    View opens are recorded from the day the feature shipped, so a chart that
    silently plots zero for every earlier date would read as "nobody used it"
    rather than "we weren't counting". The UI says which it is.
    """
    return (await session.execute(
        select(func.min(ProductEventORM.created_at))
        .where(ProductEventORM.event_type == VIEW_OPENED)
    )).scalar()


# ── Redaction ────────────────────────────────────────────────────────
# Applied as a LAST PASS over the finished document rather than threaded through
# every query. Two reasons, and both are about the failure mode:
#
#   * A redactor that lives in one place can be read in one sitting and tested
#     on its own. A redaction condition sprinkled across twenty queries is
#     correct only until someone adds the twenty-first.
#   * When it is a filter over a known shape, a field ADDED later is redacted by
#     default only if we say so explicitly — so the allow-lists below name what
#     survives, never what is removed. A new leaderboard is hidden until someone
#     decides otherwise, which is the right way round.

#: What a workspace is called when the viewer may not know its name.
REDACTED_WORKSPACE = "Restricted workspace"
REDACTED_VIEW = "Restricted view"


def _redact_workspace_row(row: dict) -> dict:
    """One workspace the viewer is not a member of.

    The row SURVIVES — that is the whole design. Dropping it would make the
    table disagree with the totals above it, and "12 workspaces, 4 you can open"
    is a more honest picture than a table that quietly shows four. What goes is
    everything that describes the place: its name, its size, who is in it, and
    what they did.
    """
    return {
        "workspaceId": row["workspaceId"],
        "name": REDACTED_WORKSPACE,
        "redacted": True,
        # Age is the one fact kept, and only because the table sorts and groups
        # by it; it says nothing about the work inside.
        "createdAt": row["createdAt"],
        "isActive": row["isActive"],
        "canOpen": False,
        "members": None, "views": None, "newViews": None, "dataSources": None,
        "activity": None, "opens": None, "activeUsers": None,
        "nodes": None, "edges": None,
        "lastActivityAt": None, "dormant": False,
    }


#: Fields of an internal view row that may reach a non-privileged client.
#: An ALLOW-list, not a deny-list, and that is the whole point: the previous
#: version spread ``**row`` and shipped whatever the query happened to select,
#: so adding ``createdBy`` for the creator-reach check silently published every
#: redacted view's author. A field added to the query in future is withheld by
#: default until somebody puts it here on purpose.
_PUBLIC_VIEW_FIELDS = (
    "viewId", "name", "workspaceId", "visibility", "viewType",
    "opens", "uniqueViewers", "favourites",
)


#: Same discipline as ``_PUBLIC_VIEW_FIELDS``: name what may leave, so a column
#: added to the ranking query later cannot ride out with it.
_PUBLIC_WORKSPACE_ENTRY_FIELDS = ("workspaceId", "name", "activity", "opens")


def _redact_workspace_entry(entry: dict, scope) -> dict:
    """One row of the most-active-workspaces ranking."""
    public = {k: entry.get(k) for k in _PUBLIC_WORKSPACE_ENTRY_FIELDS}
    if scope.can_see(entry.get("workspaceId")):
        return {**public, "canOpen": scope.can_open(entry.get("workspaceId"))}
    # The counts stay: an anonymous ranking position names nothing, and
    # dropping the row would make the leaderboard disagree with the totals.
    return {**public, "name": REDACTED_WORKSPACE, "redacted": True, "canOpen": False}


def _redact_view_row(row: dict, scope) -> dict:
    """A popular view. Its NAME leaks what a private workspace is working on —
    unless the reader could already open it, which is more often than the first
    version of this assumed. ``can_see_view`` mirrors
    ``view_access.can_read_view``: enterprise-published views are readable by
    anyone, and a creator keeps reach to their own work.

    ``createdBy`` is read here and never returned. It exists on the internal
    row so the creator-reach rule can be applied; a user id is exactly the
    "individual activity" the strict level withholds, so it must not survive
    into the response even on a view the reader CAN see.
    """
    public = {k: row.get(k) for k in _PUBLIC_VIEW_FIELDS}
    if scope.can_see_view(
        workspace_id=row.get("workspaceId"),
        visibility=row.get("visibility"),
        created_by=row.get("createdBy"),
    ):
        # Named. Whether it also LINKS is the stricter question: an
        # enterprise-published view opens for anyone, a workspace-scoped one
        # only for a member.
        return {
            **public,
            "canOpen": (row.get("visibility") == "enterprise")
            or scope.can_open(row.get("workspaceId")),
        }
    return {
        **public,
        "name": REDACTED_VIEW,
        "redacted": True,
        # Counts stay: they are what makes it "popular", and they name nothing.
        "visibility": "restricted",
        "viewType": "restricted",
        "canOpen": False,
    }


#: A contributor row, minus the address. Same allow-list discipline as the
#: view rows: name what may leave.
_PUBLIC_CONTRIBUTOR_FIELDS = ("userId", "name", "events")


def redact_workspace_detail(doc: dict, scope) -> dict:
    """Apply ``scope`` to one workspace's drill-in.

    This existed as an unredacted hole for one commit, and the shape of the
    mistake is worth naming: the drill-in was treated as an ACCESS decision
    ("may you open this page?") and therefore not as a DOCUMENT ("what may it
    contain?"). Passing the first check told us nothing about the second, and
    the page shipped a roster of contributors with their email addresses to
    anyone the first check let through.

    Contributors are gated on ``can_open`` rather than ``can_see``: an
    operator opening workspace REPORTING wanted figures on a dashboard, not a
    staff list for a team the reader has no part in. Reporting is not a roster.
    """
    if scope is None or scope.privileged:
        return doc

    doc = dict(doc)
    member = scope.can_open(doc.get("workspaceId"))
    show_people = scope.shows_people and member

    contributors = doc.get("topContributors") or []
    doc["topContributors"] = [
        {k: c.get(k) for k in _PUBLIC_CONTRIBUTOR_FIELDS}
        for c in contributors
        # Their own row survives at every level — it is their data.
        if show_people or scope.is_self(c.get("userId"))
    ]
    doc["topViews"] = [_redact_view_row(v, scope) for v in doc.get("topViews", [])]
    doc["redaction"] = {
        "applied": True,
        "showsPeople": show_people,
        "member": member,
    }
    return doc


def redact_workspace_rows(rows: list[dict], scope) -> list[dict]:
    """Apply ``scope`` to the workspaces table.

    A pure projection over finished rows, named rather than inlined because it
    is what the endpoint applies to a cached document — the aggregation is the
    same for everyone, only this last step differs per reader.
    """
    if scope is None or scope.privileged:
        return rows
    return [
        {**r, "canOpen": scope.can_open(r["workspaceId"])}
        if scope.can_see(r["workspaceId"])
        else _redact_workspace_row(r)
        for r in rows
    ]


def redact_summary(doc: dict, scope) -> dict:
    """Apply ``scope`` to a finished platform summary.

    Aggregates are left ALONE — totals, series, breakdowns, adoption, value
    moments and graph scale all describe the platform rather than any person or
    place, and they are the reason a non-privileged viewer is here at all.
    """
    if scope.privileged:
        return doc

    doc = dict(doc)
    boards = doc["leaderboards"]

    # People. Whether colleagues may be named is now the operator's decision
    # (``analyticsPrivacyMode``) rather than a rule this module invented — in a
    # deployment where every reader is an employee, these names are already in
    # the workspace member lists and hiding them protects nobody.
    #
    # Emails are stripped at EVERY level regardless. A display name identifies
    # a colleague; an address is a credential-shaped identifier with no place
    # on a dashboard.
    if scope.shows_people:
        people = [
            {**u, "email": None} for u in boards.get("topUsers", [])
        ]
        creators = list(boards.get("topCreators", []))
    else:
        # Their OWN row survives at every level: it is their data, and hiding
        # it from them protects nobody.
        people = [
            {**u, "email": None} for u in boards.get("topUsers", [])
            if scope.is_self(u.get("userId"))
        ]
        creators = [
            c for c in boards.get("topCreators", [])
            if scope.is_self(c.get("userId"))
        ]

    doc["leaderboards"] = {
        "topUsers": people,
        "topCreators": creators,
        "topViews": [
            _redact_view_row(v, scope) for v in boards.get("topViews", [])
        ],
        "topWorkspaces": [
            _redact_workspace_entry(w, scope)
            for w in boards.get("topWorkspaces", [])
        ],
    }

    # Operations: who is waiting for access, and where the data is unreliable.
    # An operator's view of the platform, and a map of where the gaps are.
    health = dict(doc.get("health") or {})
    if not scope.shows_operations:
        health.pop("access", None)
        health.pop("reliability", None)
    doc["health"] = health

    # Insights are generated FROM the fields above, so any rule that reads a
    # redacted one must not survive. Allow-listed by key rather than filtered by
    # inspection: a new rule is hidden from the public tier until someone has
    # looked at what it says.
    allowed = set(_PUBLIC_INSIGHTS)
    if scope.shows_people:
        allowed |= _PEOPLE_INSIGHTS
    if scope.shows_operations:
        allowed |= _OPERATIONS_INSIGHTS
    doc["insights"] = [i for i in doc.get("insights", []) if i["key"] in allowed]

    doc["redaction"] = {
        "applied": True,
        "mode": scope.privacy.value,
        "showsPeople": scope.shows_people,
        "showsOperations": scope.shows_operations,
        # True when an operator has opened workspace reporting to everyone, so
        # the UI can explain WHY a workspace it cannot open is nonetheless named.
        "reportsAllWorkspaces": scope.reports_all_workspaces,
        "visibleWorkspaces": (
            None if scope.sees_all_workspaces else len(scope.visible_workspaces)
        ),
        # False means we could not resolve the caller's access, so anything
        # locked may be locked wrongly. The UI says so rather than presenting a
        # confident redaction it cannot stand behind.
        "accessResolved": scope.workspaces_known,
        # Named precisely, because a generic "some things are hidden" teaches
        # people the dashboard is unreliable rather than that it is scoped.
        "hidden": [
            *([] if scope.shows_people else ["Individual activity and names"]),
            *([] if scope.sees_all_workspaces
              else ["Names of workspaces you are not in"]),
            *([] if scope.shows_operations
              else ["Access requests, invites and refresh health"]),
        ],
    }
    return doc


#: Insight rules whose text is derived only from platform-wide aggregates.
#: Safe at every level, because they quote counts and rates and nothing else.
_PUBLIC_INSIGHTS = frozenset({
    "signups", "active", "views", "signup-mix", "stickiness",
    "trace-empty", "search-miss", "funnel-leak", "concentration",
    "semantic-coverage",
})

#: Rules that describe the behaviour of individuals in aggregate ("more people
#: went quiet than kept using it"). Nobody is named, but it is a statement
#: about the workforce, so it rides with the people setting.
_PEOPLE_INSIGHTS = frozenset({"dormancy"})

#: Rules quoting operational health — where the data is unreliable, and who is
#: waiting for access.
_OPERATIONS_INSIGHTS = frozenset({
    "refresh-failures", "stale-sources", "access-backlog", "invite-acceptance",
})


# ── Narrative insights ───────────────────────────────────────────────
# A dashboard's failure mode is a wall of correct charts nobody reads. These
# rules do the first pass of interpretation the reader would otherwise do by
# eye: they state what moved, by how much, and whether it is good news.
#
# Every rule is a pure function of the finished summary document — no extra
# queries — and every one is GUARDED: it stays silent unless it has enough data
# to be worth saying. Silence is the correct output on a young install; a strip
# that manufactures five observations from three users teaches people to ignore
# it.

#: Below this many percent, a change is noise dressed as news.
_MATERIAL_CHANGE_PCT = 15.0

#: A rule needs at least this many events before its rate means anything.
_MIN_BASIS = 5

#: How many insights the strip shows. More than this and it is a chart again.
_MAX_INSIGHTS = 5


def _insight(
    key: str, tone: str, headline: str, detail: str, *, score: float,
    tab: Optional[str] = None,
) -> dict:
    """``tone`` drives colour: good | watch | bad | neutral. ``score`` is only
    used to rank; it never reaches the client."""
    return {
        "key": key, "tone": tone, "headline": headline,
        "detail": detail, "tab": tab, "_score": score,
    }


def _pct(value: float) -> str:
    return f"{abs(value):.0f}%"


def _plural(n: int, one: str, many: Optional[str] = None) -> str:
    return one if n == 1 else (many or f"{one}s")


def _window_label(w: Window) -> str:
    """How a sentence refers to this window: "in the last 30 days"."""
    return f"in the last {w.days} {_plural(w.days, 'day')}"


def _narrative(doc: dict, *, window_label: str) -> list[dict]:
    """Rank what changed, most significant first."""
    out: list[dict] = []
    totals = doc["totals"]
    engagement = doc["engagement"]
    breakdowns = doc["breakdowns"]
    health = doc["health"]
    value = doc["valueMoments"]

    def _swing(metric: dict, key: str, noun: str, tab: str) -> None:
        change, current = metric.get("changePct"), metric.get("current") or 0
        if change is None or current < _MIN_BASIS or abs(change) < _MATERIAL_CHANGE_PCT:
            return
        rising = change > 0
        out.append(_insight(
            key, "good" if rising else "watch",
            f"{noun.capitalize()} {'up' if rising else 'down'} {_pct(change)}",
            f"{current:,} {noun} {window_label}, against "
            f"{metric.get('previous', 0):,} in the previous period.",
            score=min(abs(change), 100), tab=tab,
        ))

    _swing(totals["users"], "signups", "new sign-ups", "growth")
    _swing(totals["activeUsers"], "active", "active users", "engagement")
    _swing(totals["views"], "views", "new views", "content")

    # Where growth is actually coming from — a shift in mix is a strategy fact.
    sources = breakdowns.get("usersBySignupSource") or []
    source_total = sum(row["count"] for row in sources)
    if source_total >= _MIN_BASIS and sources:
        lead = max(sources, key=lambda r: r["count"])
        share = lead["count"] / source_total
        if share >= 0.5:
            out.append(_insight(
                "signup-mix", "neutral",
                f"{_SOURCE_LABELS.get(lead['key'], lead['key'])} is "
                f"{share:.0%} of new accounts",
                f"{lead['count']:,} of {source_total:,} accounts created "
                f"{window_label} came in this way.",
                score=40 + share * 20, tab="growth",
            ))

    # Habit vs. visit. The single most diagnostic engagement number there is.
    stickiness, mau = engagement.get("stickiness"), engagement.get("mau") or 0
    if stickiness is not None and mau >= _MIN_BASIS:
        if stickiness >= 0.2:
            out.append(_insight(
                "stickiness", "good", f"Stickiness at {stickiness:.0%}",
                "Daily actives are a fifth of monthly actives — for most "
                "people this is part of the working day, not an occasional "
                "visit.", score=55, tab="engagement",
            ))
        elif stickiness < 0.1:
            out.append(_insight(
                "stickiness", "watch", f"Stickiness at {stickiness:.0%}",
                "People come back, but not often. The platform is a "
                "destination for occasional questions rather than a daily "
                "habit.", score=65, tab="engagement",
            ))

    # The value moment. A trace that returns nothing is a question the product
    # failed to answer, and it is invisible in every other number here.
    traces = value.get("traces") or 0
    rate = value.get("traceSuccessRate")
    if traces >= _MIN_BASIS and rate is not None and rate < 0.7:
        empty = value.get("tracesEmpty") or 0
        out.append(_insight(
            "trace-empty", "bad",
            f"{1 - rate:.0%} of lineage traces come back empty",
            f"{empty:,} of {traces:,} traces {window_label} found no lineage. "
            "People are asking the core question and not getting an answer.",
            score=90, tab="engagement",
        ))

    searches = value.get("searches") or 0
    hit = value.get("searchHitRate")
    if searches >= _MIN_BASIS and hit is not None and hit < 0.7:
        out.append(_insight(
            "search-miss", "watch",
            f"{1 - hit:.0%} of graph searches return nothing",
            f"{value.get('searchMisses', 0):,} of {searches:,} searches "
            f"{window_label} found no match — either the graph is missing "
            "what people expect, or search is not finding it.",
            score=70, tab="engagement",
        ))

    # Where the funnel leaks. Reported as the single largest drop, because
    # naming four mediocre stages is not an insight.
    stages = engagement.get("funnel") or []
    worst, worst_drop = None, 0.0
    for prev_stage, stage in zip(stages, stages[1:]):
        base = prev_stage.get("count") or 0
        if base < _MIN_BASIS:
            continue
        drop = (base - (stage.get("count") or 0)) / base
        if drop > worst_drop:
            worst, worst_drop = (prev_stage, stage), drop
    if worst and worst_drop >= 0.5:
        before, after = worst
        out.append(_insight(
            "funnel-leak", "watch",
            f"{worst_drop:.0%} drop between "
            f"\u201c{before['stage']}\u201d and \u201c{after['stage']}\u201d",
            f"Of {before['count']:,} who reached "
            f"\u201c{before['stage'].lower()}\u201d, only {after['count']:,} "
            "went on to the next step. This is the biggest leak in the funnel.",
            score=75, tab="engagement",
        ))

    # Is the catalogue working, or is everything riding on a handful of views?
    concentration = breakdowns.get("contentConcentration")
    if concentration is not None and concentration >= 0.6 and (totals["viewOpens"].get("current") or 0) >= _MIN_BASIS:
        out.append(_insight(
            "concentration", "watch",
            f"Top views take {concentration:.0%} of all opens",
            "Attention is concentrated in a few views. The rest of the "
            "catalogue is not being discovered.",
            score=50, tab="content",
        ))

    # Data trust. Rising usage on stale data is the worst kind of good news.
    reliability = health["reliability"]
    success = reliability.get("successRate")
    if success is not None and success < 0.95 and (reliability.get("refreshes") or 0) >= _MIN_BASIS:
        out.append(_insight(
            "refresh-failures", "bad",
            f"{reliability['failures']:,} refresh "
            f"{_plural(reliability['failures'], 'failure')} {window_label}",
            f"Only {success:.0%} of refreshes succeeded. People are reading "
            "lineage that may be out of date.",
            score=85, tab="overview",
        ))
    untouched = reliability.get("sourcesUntouched") or 0
    if untouched and (reliability.get("sourcesRefreshed") or 0) > 0:
        out.append(_insight(
            "stale-sources", "watch",
            f"{untouched:,} data {_plural(untouched, 'source')} never refreshed "
            f"{window_label}",
            "No refresh activity at all in this period — staleness hides here.",
            score=45, tab="overview",
        ))

    # Access friction — people who wanted in and are still waiting.
    access = health["access"]
    oldest = access.get("oldestPendingDays")
    if access.get("pending") and oldest is not None and oldest >= 3:
        out.append(_insight(
            "access-backlog", "bad",
            f"{access['pending']:,} access "
            f"{_plural(access['pending'], 'request')} pending",
            f"The oldest has been waiting {oldest:.0f} days. Every one is "
            "someone who wanted to use the platform and cannot.",
            score=80, tab="growth",
        ))
    acceptance = access.get("acceptanceRate")
    if acceptance is not None and acceptance < 0.5 and (access.get("invitesSent") or 0) >= _MIN_BASIS:
        out.append(_insight(
            "invite-acceptance", "watch",
            f"Only {acceptance:.0%} of invites were accepted",
            f"{access['invitesSent']:,} sent, {access['invitesRedeemed']:,} "
            "redeemed. Invitations are going out and not landing.",
            score=60, tab="growth",
        ))

    # Adoption of the differentiator.
    semantic = health["semanticLayer"]
    coverage = semantic.get("coverage")
    if coverage is not None and coverage < 0.5 and (semantic.get("sourcesTotal") or 0) >= 3:
        out.append(_insight(
            "semantic-coverage", "watch",
            f"{coverage:.0%} of sources have a semantic layer",
            f"{semantic['sourcesWithOntology']} of {semantic['sourcesTotal']} "
            "sources have an ontology assigned — the rest show raw technical "
            "metadata only.",
            score=55, tab="content",
        ))

    # Churn signal, stated as people rather than a rate.
    growth = engagement.get("growthAccounting") or {}
    dormant, returning = growth.get("dormant") or 0, growth.get("returning") or 0
    if dormant >= _MIN_BASIS and dormant > returning:
        out.append(_insight(
            "dormancy", "bad",
            f"{dormant:,} active {_plural(dormant, 'user')} went quiet",
            f"More people stopped using the platform this period ({dormant:,}) "
            f"than kept using it ({returning:,}).",
            score=88, tab="engagement",
        ))

    out.sort(key=lambda i: i["_score"], reverse=True)
    for item in out:
        item.pop("_score", None)
    return out[:_MAX_INSIGHTS]


#: Signup-source keys are database enums; these are what a human calls them.
_SOURCE_LABELS = {
    "local_signup": "Self sign-up",
    "sso_jit": "SSO",
    "invite": "Invitations",
    "admin_created": "Admin-created",
    "admin_linked": "Admin-linked",
}


async def _ghost_series(
    session: AsyncSession, w: Window, *, live_user, live_view,
) -> dict[str, list[int]]:
    """The previous period's shape, aligned to the CURRENT window's bucket count.

    The KPI deltas already say a number moved. This says how it moved — whether
    growth is steady, front-loaded, or a single spike — which a percentage
    cannot express and a reader would otherwise have to hold two screenshots
    side by side to see.

    Aligned by bucket INDEX, not by date: bucket 3 of last month sits under
    bucket 3 of this one. Lists are padded or truncated to the current window's
    length so a month boundary (28 vs 31 days) can never make the ghost run off
    the end of the axis.
    """
    prev = previous_window(w)
    width = len(w.buckets)

    def _fit(values: list[int]) -> list[int]:
        # Take the LAST `width` buckets: the ghost's right edge is the moment
        # just before the current window opened, so that is the end to keep.
        trimmed = values[-width:]
        return [0] * (width - len(trimmed)) + trimmed

    bounds = {"since": prev.start, "until": prev.end}
    signups = await _count_by_day(
        session, UserORM.created_at, **bounds, where=live_user)
    views = await _count_by_day(
        session, ViewORM.created_at, **bounds, where=live_view)
    opens = await _count_by_day(
        session, ProductEventORM.created_at, **bounds,
        where=[ProductEventORM.event_type == VIEW_OPENED])

    actors = await _actors_by_day(session, since=prev.start, until=prev.end)
    per_bucket: dict[str, set[str]] = {b: set() for b in prev.buckets}
    for day, people in actors.items():
        bucket = prev.bucket_of(day)
        if bucket is not None:
            per_bucket[bucket].update(people)

    return {
        "signups": _fit(prev.align(signups)),
        "viewsCreated": _fit(prev.align(views)),
        "viewOpens": _fit(prev.align(opens)),
        "activeUsers": _fit([len(per_bucket[b]) for b in prev.buckets]),
    }


# ── Platform health: what blocks growth but never shows on a signup chart ──
# Three tables the dashboard used to ignore entirely. Each answers a question a
# growth chart cannot: is the data trustworthy, can people get IN, and is the
# thing that differentiates us actually switched on?


async def _reliability(session: AsyncSession, w: Window, *, sources: int) -> dict:
    """Refresh outcomes over the window — does the data people see hold up?

    A lineage platform whose sources quietly stop refreshing still shows rising
    view opens right up until someone notices the graph is a month stale. This
    is the counter-signal.
    """
    rows = (await session.execute(
        select(RefreshEventORM.outcome, func.count())
        .where(RefreshEventORM.ts >= w.start, RefreshEventORM.ts < w.end)
        .group_by(RefreshEventORM.outcome)
    )).all()
    by_outcome = {str(outcome or "unknown"): int(n) for outcome, n in rows}
    total = sum(by_outcome.values())
    failed = by_outcome.get("error", 0) + by_outcome.get("failed", 0)
    refreshed = {
        str(ds) for (ds,) in (await session.execute(
            select(RefreshEventORM.data_source_id)
            .where(RefreshEventORM.ts >= w.start, RefreshEventORM.ts < w.end)
            .group_by(RefreshEventORM.data_source_id)
        )).all() if ds
    }
    return {
        "refreshes": total,
        "failures": failed,
        "successRate": round((total - failed) / total, 3) if total else None,
        "sourcesRefreshed": len(refreshed),
        # Live sources that saw no refresh at all in the window. Not "broken",
        # but the population where staleness hides.
        "sourcesUntouched": max(0, sources - len(refreshed)),
        "byOutcome": _fold_tail(
            sorted(by_outcome.items(), key=lambda kv: kv[1], reverse=True)),
    }


async def _access_friction(session: AsyncSession, w: Window, *, now: datetime) -> dict:
    """How hard is it to get in, and how long do people wait?

    Every row here is a person who wanted access and could not have it yet.
    Slow approvals and unredeemed invites throttle growth upstream of anything
    the activation funnel can see.
    """
    requests = (await session.execute(
        select(AccessRequestORM.created_at, AccessRequestORM.resolved_at,
               AccessRequestORM.status)
        .where(AccessRequestORM.created_at >= w.start)
    )).all()
    waits: list[float] = []
    for created, resolved, _status in requests:
        if not resolved:
            continue
        started, finished = _parse(created), _parse(resolved)
        if started and finished and finished >= started:
            waits.append((finished - started).total_seconds() / 3600)

    pending_rows = (await session.execute(
        select(AccessRequestORM.created_at)
        .where(AccessRequestORM.status == "pending")
    )).all()
    oldest_pending = None
    for (created,) in pending_rows:
        started = _parse(created)
        if started:
            age = (now - started).total_seconds() / 86400
            oldest_pending = age if oldest_pending is None else max(oldest_pending, age)

    invites_sent = await _scalar(session, select(func.count()).where(
        InviteORM.created_at >= w.start, InviteORM.created_at < w.end))
    invites_redeemed = await _scalar(session, select(func.count()).where(
        InviteRedemptionORM.redeemed_at >= w.start,
        InviteRedemptionORM.redeemed_at < w.end))

    return {
        "requests": len(requests),
        "pending": len(pending_rows),
        "medianHoursToApprove": round(_median(waits), 1) if waits else None,
        "oldestPendingDays": round(oldest_pending, 1) if oldest_pending is not None else None,
        "invitesSent": invites_sent,
        "invitesRedeemed": invites_redeemed,
        # Deliberately not clamped to the window on the numerator's side: an
        # invite sent on day 1 and redeemed on day 3 is a success for this
        # window, and comparing two window-bounded counts is the honest
        # approximation available without joining the two tables.
        "acceptanceRate": (
            round(min(invites_redeemed / invites_sent, 1.0), 3) if invites_sent else None
        ),
    }


async def _semantic_adoption(session: AsyncSession, *, sources: int) -> dict:
    """Is the differentiator switched on?

    Coverage is measured on ``workspace_data_sources.ontology_id`` — one table,
    no join — rather than through ``ontology_source_mappings``, because the
    question is "does this source have a semantic layer assigned", and that
    column IS the assignment.
    """
    assigned = await _scalar(session, select(func.count()).where(
        WorkspaceDataSourceORM.ontology_id.is_not(None),
        WorkspaceDataSourceORM.deleted_at.is_(None),
    ))
    drifting = await _scalar(session, select(func.count()).select_from(
        OntologySourceMappingORM).where(OntologySourceMappingORM.has_drift.is_(True)))
    return {
        "sourcesWithOntology": assigned,
        "sourcesTotal": sources,
        "coverage": round(assigned / sources, 3) if sources else None,
        "sourcesDrifting": drifting,
    }


async def _annotations(session: AsyncSession, w: Window) -> list[dict]:
    """Announcements inside the window, as timeline markers.

    A spike with no explanation is a mystery; a spike with "v2.1 shipped"
    beside it is a finding. Announcements are the only dated, human-authored
    record of "something happened" the platform already keeps.
    """
    rows = (await session.execute(
        select(AnnouncementORM.created_at, AnnouncementORM.title,
               AnnouncementORM.banner_type)
        .where(AnnouncementORM.created_at >= w.start,
               AnnouncementORM.created_at < w.end)
        .order_by(AnnouncementORM.created_at)
    )).all()
    out = []
    for created, title, banner in rows:
        day = str(created)[:10]
        bucket = w.bucket_of(day)
        if bucket is None:
            continue
        out.append({
            "bucket": bucket, "date": day,
            "title": str(title), "kind": str(banner or "info"),
        })
    return out


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


# ── Feature adoption & value moments ─────────────────────────────────
# Everything below reads ONE table (``product_events``) three times and folds
# every feature out of the result, rather than querying per feature. Six
# features × window/previous/actors would have been eighteen round trips.


@dataclass
class _Adoption:
    """Per-event-type rollup for one window, plus the previous window."""

    counts: dict[str, int]
    previous: dict[str, int]
    actors: dict[str, set[str]]
    first_seen: dict[str, str]

    def total(self, types: Sequence[str]) -> int:
        return sum(self.counts.get(t, 0) for t in types)

    def prev_total(self, types: Sequence[str]) -> int:
        return sum(self.previous.get(t, 0) for t in types)

    def users(self, types: Sequence[str]) -> set[str]:
        out: set[str] = set()
        for t in types:
            out |= self.actors.get(t, set())
        return out

    def since(self, types: Sequence[str]) -> Optional[str]:
        stamps = [self.first_seen[t] for t in types if t in self.first_seen]
        return min(stamps) if stamps else None


async def _load_adoption(session: AsyncSession, w: Window) -> _Adoption:
    async def _counts(since: str, until: Optional[str]) -> dict[str, int]:
        bounds = [ProductEventORM.created_at >= since]
        if until:
            bounds.append(ProductEventORM.created_at < until)
        rows = (await session.execute(
            select(ProductEventORM.event_type, func.count())
            .where(*bounds)
            .group_by(ProductEventORM.event_type)
        )).all()
        return {str(t): int(n) for t, n in rows}

    actor_rows = (await session.execute(
        select(ProductEventORM.event_type, ProductEventORM.actor_id)
        .where(
            ProductEventORM.created_at >= w.start,
            ProductEventORM.actor_id.is_not(None),
        )
        .group_by(ProductEventORM.event_type, ProductEventORM.actor_id)
    )).all()
    actors: dict[str, set[str]] = defaultdict(set)
    for event_type, actor in actor_rows:
        if event_type and actor:
            actors[str(event_type)].add(str(actor))

    first_rows = (await session.execute(
        select(ProductEventORM.event_type, func.min(ProductEventORM.created_at))
        .group_by(ProductEventORM.event_type)
    )).all()

    return _Adoption(
        counts=await _counts(w.start, None),
        previous=await _counts(w.previous_start, w.start),
        actors=actors,
        first_seen={str(t): str(ts) for t, ts in first_rows if t and ts},
    )


def _adoption_matrix(adoption: _Adoption, *, active_users: int) -> list[dict]:
    """One row per feature: how much it was used, by how many, and the trend.

    ``reach`` is the share of ACTIVE users who touched the feature, not of all
    users — "12% of everyone who signed up in 2024" measures dormancy, not
    adoption. A feature with no events yet reports ``since: null`` so the UI can
    say "not measured yet" instead of implying nobody wants it.
    """
    rows = []
    for key, label, types in FEATURE_EVENTS:
        users = len(adoption.users(types))
        events = adoption.total(types)
        rows.append({
            "key": key,
            "label": label,
            "events": events,
            "users": users,
            "previousEvents": adoption.prev_total(types),
            "changePct": _delta(events, adoption.prev_total(types)),
            "reach": round(users / active_users, 3) if active_users else None,
            "since": adoption.since(types),
        })
    return rows


def _value_moments(adoption: _Adoption) -> dict:
    """Did the product answer the question it was asked?

    A trace that returns no lineage and a search that returns no matches are
    both *failed* value moments — the user asked and got nothing. Counting only
    the successes would flatter the product; these two rates are the honest
    version, and they are the reason the ``_empty``/``_miss`` variants are
    separate event types rather than a payload flag.
    """
    traces_ok = adoption.counts.get(TRACE_RUN, 0)
    traces_empty = adoption.counts.get(TRACE_EMPTY, 0)
    traces = traces_ok + traces_empty
    searches_ok = adoption.counts.get(SEARCH_RUN, 0)
    searches_miss = adoption.counts.get(SEARCH_MISS, 0)
    searches = searches_ok + searches_miss
    return {
        "traces": traces,
        "tracesEmpty": traces_empty,
        "traceSuccessRate": round(traces_ok / traces, 3) if traces else None,
        "tracedBy": len(adoption.users((TRACE_RUN, TRACE_EMPTY))),
        "searches": searches,
        "searchMisses": searches_miss,
        "searchHitRate": round(searches_ok / searches, 3) if searches else None,
    }


async def _engagement(
    session: AsyncSession, w: Window, *, now: datetime,
    dau: int, wau: int, mau: int,
    active_now: set[str], active_prev: set[str],
    tracers: set[str],
) -> dict:
    """Habit, activation, and where the funnel leaks."""
    # Cohort = accounts created inside the window. An activation funnel over
    # all-time users would ignore the range picker entirely.
    cohort = {
        uid for (uid,) in (await session.execute(
            select(UserORM.id).where(
                UserORM.created_at >= w.start, UserORM.deleted_at.is_(None),
            )
        )).all()
    }
    signed_in = {
        uid for (uid,) in (await session.execute(
            select(ViewVisitORM.user_id).where(ViewVisitORM.visited_at >= w.start)
        )).all() if uid
    }
    creators = {
        uid for (uid,) in (await session.execute(
            select(ViewORM.created_by).where(
                ViewORM.created_at >= w.start, ViewORM.created_by.is_not(None),
            )
        )).all() if uid
    }
    funnel_active = cohort & active_now
    funnel_opened = cohort & signed_in
    funnel_traced = cohort & tracers
    funnel_created = cohort & creators

    def _stage(label: str, count: int) -> dict:
        base = len(cohort)
        return {
            "stage": label,
            "count": count,
            "rate": round(count / base, 3) if base else None,
        }

    # Growth accounting — the same active users, split by where they came from.
    new_active = {u for u in active_now if u in cohort}
    returning = active_now & active_prev
    resurrected = active_now - active_prev - cohort
    dormant = active_prev - active_now

    return {
        "dau": dau,
        "wau": wau,
        "mau": mau,
        # The one number that says whether this is a habit or a visit.
        "stickiness": round(dau / mau, 3) if mau else None,
        # Activation is TRACING, not authoring. This platform exists to answer
        # "where did this data come from"; the moment someone gets that answer
        # is the moment it became useful to them. Creating a view is a later,
        # heavier commitment and stays in the funnel as its own stage — but
        # scoring activation on it counted investment rather than value, and
        # undercounted every reader who got exactly what they came for.
        "activationRate": round(len(funnel_traced) / len(cohort), 3) if cohort else None,
        "creationRate": round(len(funnel_created) / len(cohort), 3) if cohort else None,
        "medianDaysToFirstView": await _median_time_to_value(session, w),
        "funnel": [
            _stage("Signed up", len(cohort)),
            _stage("Became active", len(funnel_active)),
            _stage("Opened a view", len(funnel_opened)),
            _stage("Traced lineage", len(funnel_traced)),
            _stage("Created a view", len(funnel_created)),
        ],
        "growthAccounting": {
            "new": len(new_active),
            "returning": len(returning),
            "resurrected": len(resurrected),
            "dormant": len(dormant),
        },
        "cohorts": await _retention_cohorts(session, w),
    }


async def _median_time_to_value(session: AsyncSession, w: Window) -> Optional[float]:
    """Median days from signing up to creating a first view.

    Measured over the users whose *first view* landed inside the window — the
    moment value was reached — rather than users who signed up inside it, which
    would score short windows unfairly (nobody who signed up on day 6 of a
    7-day window has had time to build anything).
    """
    first_view: dict[str, str] = {}
    rows = (await session.execute(
        select(ViewORM.created_by, func.min(ViewORM.created_at))
        .where(ViewORM.created_by.is_not(None), ViewORM.deleted_at.is_(None))
        .group_by(ViewORM.created_by)
    )).all()
    for uid, first_at in rows:
        if uid and first_at and first_at >= w.start:
            first_view[uid] = first_at
    if not first_view:
        return None

    signups = dict((await session.execute(
        select(UserORM.id, UserORM.created_at).where(UserORM.id.in_(first_view.keys()))
    )).all())

    deltas: list[float] = []
    for uid, first_at in first_view.items():
        created = signups.get(uid)
        if not created:
            continue
        try:
            gap = datetime.fromisoformat(first_at) - datetime.fromisoformat(created)
        except (ValueError, TypeError):
            continue
        deltas.append(max(0.0, gap.total_seconds() / 86400))
    if not deltas:
        return None
    deltas.sort()
    mid = len(deltas) // 2
    median = deltas[mid] if len(deltas) % 2 else (deltas[mid - 1] + deltas[mid]) / 2
    return round(median, 1)


#: A cohort grid needs enough weeks to have a shape; below this the answer is
#: "pick a longer range", not a one-cell heatmap pretending to be a trend.
_MIN_COHORT_DAYS = 28


async def _retention_cohorts(session: AsyncSession, w: Window) -> list[dict]:
    """Signup-week × weeks-active grid, scoped to the window."""
    if w.days < _MIN_COHORT_DAYS:
        return []

    signups = (await session.execute(
        select(UserORM.id, UserORM.created_at)
        .where(UserORM.created_at >= w.start, UserORM.deleted_at.is_(None))
    )).all()
    if not signups:
        return []

    joined: dict[str, date] = {}
    for uid, created in signups:
        try:
            joined[uid] = date.fromisoformat(str(created)[:10])
        except (ValueError, TypeError):
            continue
    if not joined:
        return []

    actors_by_day = await _actors_by_day(session, since=w.start)
    # {cohort_week_start: {weeks_since_signup: {user, …}}}
    grid: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    for day, actors in actors_by_day.items():
        try:
            active_on = date.fromisoformat(day)
        except (ValueError, TypeError):
            continue
        for uid in actors:
            start = joined.get(uid)
            if start is None or active_on < start:
                continue
            cohort_week = (start - timedelta(days=start.weekday())).isoformat()
            grid[cohort_week][(active_on - start).days // 7].add(uid)

    sizes: Counter = Counter()
    for uid, start in joined.items():
        sizes[(start - timedelta(days=start.weekday())).isoformat()] += 1

    out: list[dict] = []
    for cohort_week in sorted(sizes):
        size = sizes[cohort_week]
        weeks = grid.get(cohort_week, {})
        span = max(weeks.keys(), default=0)
        out.append({
            "cohort": cohort_week,
            "size": size,
            "weeks": [
                {
                    "week": i,
                    "active": len(weeks.get(i, ())),
                    "rate": round(len(weeks.get(i, ())) / size, 3) if size else None,
                }
                for i in range(span + 1)
            ],
        })
    return out


async def _breakdowns(session: AsyncSession, w: Window, *, opens: _OpenFold) -> dict:
    """Categorical splits — who the users are, and what the content looks like."""
    live_user = [UserORM.deleted_at.is_(None)]
    live_view = [ViewORM.deleted_at.is_(None)]

    by_visibility = await _count_group(session, ViewORM.visibility, where=live_view)
    shared = sum(n for key, n in by_visibility if key in ("workspace", "enterprise"))
    total_views = sum(n for _, n in by_visibility)

    top_opens = sum(n for _, n in opens.by_view.most_common(TOP_N))

    return {
        "usersByStatus": _fold_tail(await _count_group(session, UserORM.status, where=live_user)),
        "usersBySignupSource": _fold_tail(
            await _count_group(session, UserORM.signup_source, where=live_user)),
        "viewsByVisibility": _fold_tail(by_visibility),
        "viewsByType": _fold_tail(await _count_group(session, ViewORM.view_type, where=live_view)),
        "activityByAction": _fold_tail(await _count_group(
            session, ViewActivityLogORM.action,
            where=[ViewActivityLogORM.created_at >= w.start],
        )),
        # Is knowledge being shared, or is everyone building in private?
        "collaborationRate": round(shared / total_views, 3) if total_views else None,
        # Is the catalogue being used, or are a handful of views carrying it?
        "contentConcentration": round(top_opens / opens.total, 3) if opens.total else None,
    }


async def _leaderboards(session: AsyncSession, w: Window, *, opens: _OpenFold) -> dict:
    """Who is doing the work, and what people actually reach for."""
    # ── Most active users: activity rows + view opens, both real actor columns.
    activity_per_actor: Counter = Counter(dict((await session.execute(
        select(ViewActivityLogORM.actor, func.count())
        .where(ViewActivityLogORM.created_at >= w.start, ViewActivityLogORM.actor.is_not(None))
        .group_by(ViewActivityLogORM.actor)
    )).all()))
    opens_per_actor: Counter = Counter(dict((await session.execute(
        select(ProductEventORM.actor_id, func.count())
        .where(
            ProductEventORM.created_at >= w.start,
            ProductEventORM.event_type == VIEW_OPENED,
            ProductEventORM.actor_id.is_not(None),
        )
        .group_by(ProductEventORM.actor_id)
    )).all()))
    creations_per_actor: Counter = Counter(dict((await session.execute(
        select(ViewORM.created_by, func.count())
        .where(
            ViewORM.created_at >= w.start,
            ViewORM.created_by.is_not(None),
            ViewORM.deleted_at.is_(None),
        )
        .group_by(ViewORM.created_by)
    )).all()))

    combined: Counter = Counter()
    combined.update(activity_per_actor)
    combined.update(opens_per_actor)
    top_actors = [uid for uid, _ in combined.most_common(TOP_N) if uid]
    # Cross-domain reference resolved by ID, never by JOIN.
    names = await resolve_user_ids(session, set(top_actors))
    top_users = [
        {
            "userId": uid,
            "name": (names.get(uid) or (None, None))[0] or uid,
            "email": (names.get(uid) or (None, None))[1],
            "events": int(combined[uid]),
            "viewsOpened": int(opens_per_actor.get(uid, 0)),
            "viewsCreated": int(creations_per_actor.get(uid, 0)),
        }
        for uid in top_actors
    ]

    # ── Most popular views: opens (from the payload fold) with unique viewers
    #    alongside, so a view opened 200 times by one person reads as such.
    favourites: Counter = Counter(dict((await session.execute(
        select(ViewFavouriteORM.view_id, func.count()).group_by(ViewFavouriteORM.view_id)
    )).all()))
    ranked_view_ids = [vid for vid, _ in opens.by_view.most_common(TOP_N)]
    if not ranked_view_ids:
        # No open history yet (tracking is new). Fall back to the signal that
        # does have history, so the panel is useful on day one.
        ranked_view_ids = [
            vid for vid, _ in Counter(dict((await session.execute(
                select(ViewVisitORM.view_id, func.count())
                .group_by(ViewVisitORM.view_id)
            )).all())).most_common(TOP_N)
        ]
    view_rows = {
        v.id: v for v in (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(ranked_view_ids))
        )).scalars().all()
    } if ranked_view_ids else {}
    top_views = [
        {
            "viewId": vid,
            "name": view_rows[vid].name,
            "workspaceId": view_rows[vid].workspace_id,
            "visibility": view_rows[vid].visibility,
            "viewType": view_rows[vid].view_type,
            # Carried so the redactor can honour the creator's own reach — see
            # `ViewerScope.can_see_view`. Never rendered.
            "createdBy": view_rows[vid].created_by,
            "opens": int(opens.by_view.get(vid, 0)),
            "uniqueViewers": len(opens.viewers_by_view.get(vid, ())),
            "favourites": int(favourites.get(vid, 0)),
        }
        for vid in ranked_view_ids if vid in view_rows
    ]

    # ── Most active workspaces.
    ws_activity: Counter = Counter(dict((await session.execute(
        select(ViewActivityLogORM.workspace_id, func.count())
        .where(
            ViewActivityLogORM.created_at >= w.start,
            ViewActivityLogORM.workspace_id.is_not(None),
        )
        .group_by(ViewActivityLogORM.workspace_id)
    )).all()))
    ws_combined: Counter = Counter()
    ws_combined.update(ws_activity)
    ws_combined.update(opens.by_workspace)
    ranked_ws = [wid for wid, _ in ws_combined.most_common(TOP_N) if wid]
    ws_rows = {
        r.id: r for r in (await session.execute(
            select(WorkspaceORM).where(
                WorkspaceORM.id.in_(ranked_ws), WorkspaceORM.deleted_at.is_(None),
            )
        )).scalars().all()
    } if ranked_ws else {}
    top_workspaces = [
        {
            "workspaceId": wid,
            "name": ws_rows[wid].name,
            "activity": int(ws_activity.get(wid, 0)),
            "opens": int(opens.by_workspace.get(wid, 0)),
        }
        for wid in ranked_ws if wid in ws_rows
    ]

    top_creators = [
        {
            "userId": uid,
            "name": (names.get(uid) or (None, None))[0] or uid,
            "viewsCreated": int(count),
        }
        for uid, count in creations_per_actor.most_common(TOP_N) if uid
    ]
    if top_creators:
        creator_names = await resolve_user_ids(
            session, {c["userId"] for c in top_creators})
        for row in top_creators:
            resolved = creator_names.get(row["userId"])
            if resolved and resolved[0]:
                row["name"] = resolved[0]

    return {
        "topUsers": top_users,
        "topViews": top_views,
        "topWorkspaces": top_workspaces,
        "topCreators": top_creators,
    }


async def _graph_scale(session: AsyncSession) -> dict:
    """Current graph scale across every live data source.

    ``data_source_stats`` is a current-value cache keyed by data source with no
    ``workspace_id`` and no history, so this is a snapshot — the time series
    that *is* honest is "data sources onboarded", which lives in the series block.
    """
    ds_ids = [
        ds_id for (ds_id,) in (await session.execute(
            select(WorkspaceDataSourceORM.id)
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )).all()
    ]
    rows = await stats_repo.list_data_source_stats(session, ds_ids)
    entity_types: set[str] = set()
    for row in rows:
        try:
            entity_types.update(json.loads(row.entity_type_counts or "{}").keys())
        except (ValueError, TypeError):
            continue
    return {
        "nodes": sum(int(r.node_count or 0) for r in rows),
        "edges": sum(int(r.edge_count or 0) for r in rows),
        "entityTypes": len(entity_types),
        "sourcesWithStats": len(rows),
    }


# ── Per-workspace ───────────────────────────────────────────────────

async def _ds_ids_by_workspace(session: AsyncSession) -> dict[str, list[str]]:
    rows = (await session.execute(
        select(WorkspaceDataSourceORM.workspace_id, WorkspaceDataSourceORM.id)
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )).all()
    out: dict[str, list[str]] = defaultdict(list)
    for ws_id, ds_id in rows:
        out[ws_id].append(ds_id)
    return out


async def workspace_rows(
    session: AsyncSession, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> list[dict]:
    """One aggregate row per live workspace — the Workspaces tab's table.

    Every count is its own grouped query rather than a per-workspace fan-out:
    a platform with 40 workspaces would otherwise cost 200 round-trips for a
    table that fits on one screen.
    """
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)

    workspaces = (await session.execute(
        select(WorkspaceORM)
        .where(WorkspaceORM.deleted_at.is_(None))
        .order_by(WorkspaceORM.created_at)
    )).scalars().all()

    views_total = Counter(dict((await session.execute(
        select(ViewORM.workspace_id, func.count())
        .where(ViewORM.deleted_at.is_(None))
        .group_by(ViewORM.workspace_id)
    )).all()))
    views_new = Counter(dict((await session.execute(
        select(ViewORM.workspace_id, func.count())
        .where(ViewORM.deleted_at.is_(None), ViewORM.created_at >= w.start)
        .group_by(ViewORM.workspace_id)
    )).all()))
    activity = Counter(dict((await session.execute(
        select(ViewActivityLogORM.workspace_id, func.count())
        .where(
            ViewActivityLogORM.created_at >= w.start,
            ViewActivityLogORM.workspace_id.is_not(None),
        )
        .group_by(ViewActivityLogORM.workspace_id)
    )).all()))
    last_activity = dict((await session.execute(
        select(ViewActivityLogORM.workspace_id, func.max(ViewActivityLogORM.created_at))
        .where(ViewActivityLogORM.workspace_id.is_not(None))
        .group_by(ViewActivityLogORM.workspace_id)
    )).all())
    members = await _member_counts(session, now=now)

    actors_by_ws = await _actors_by_workspace(session, since=w.start)
    opens = await _fold_opens(session, since=w.start)
    ds_by_ws = await _ds_ids_by_workspace(session)
    all_stats = {
        s.data_source_id: s
        for s in await stats_repo.list_data_source_stats(
            session, [ds for ids in ds_by_ws.values() for ds in ids])
    }

    rows: list[dict] = []
    for ws in workspaces:
        ds_ids = ds_by_ws.get(ws.id, [])
        stats = [all_stats[d] for d in ds_ids if d in all_stats]
        window_activity = int(activity.get(ws.id, 0)) + int(opens.by_workspace.get(ws.id, 0))
        rows.append({
            "workspaceId": ws.id,
            "name": ws.name,
            "createdAt": ws.created_at,
            "isActive": bool(ws.is_active),
            "members": int(members.get(ws.id, 0)),
            "views": int(views_total.get(ws.id, 0)),
            "newViews": int(views_new.get(ws.id, 0)),
            "dataSources": len(ds_ids),
            "activity": int(activity.get(ws.id, 0)),
            "opens": int(opens.by_workspace.get(ws.id, 0)),
            "activeUsers": len(actors_by_ws.get(ws.id, ())),
            "nodes": sum(int(s.node_count or 0) for s in stats),
            "edges": sum(int(s.edge_count or 0) for s in stats),
            "lastActivityAt": last_activity.get(ws.id),
            # Churn risk: it exists, it has content, and nobody touched it.
            "dormant": window_activity == 0,
            "redacted": False,
            # Whether a link into the workspace should be rendered. Stricter
            # than being named: reporting on a workspace is not a door into it.
            "canOpen": True,
        })
    return redact_workspace_rows(rows, scope)


async def _member_counts(
    session: AsyncSession, *, now: datetime,
) -> Counter:
    """Distinct workspace members, counting through groups and honouring expiry.

    ``role_bindings.expires_at`` is never enforced in SQL — the binding repo
    filters it in Python after fetching — so an expired grant would otherwise be
    counted as a live member. Group-scoped bindings stand in for every member of
    that group, so those expand through ``group_members``.
    """
    now_iso = now.isoformat()
    bindings = (await session.execute(
        select(
            RoleBindingORM.scope_id,
            RoleBindingORM.subject_type,
            RoleBindingORM.subject_id,
            RoleBindingORM.expires_at,
        ).where(RoleBindingORM.scope_type == "workspace")
    )).all()

    group_members: dict[str, set[str]] = defaultdict(set)
    if any(subject_type == "group" for _, subject_type, _, _ in bindings):
        for group_id, user_id in (await session.execute(
            select(GroupMemberORM.group_id, GroupMemberORM.user_id)
        )).all():
            group_members[group_id].add(user_id)

    per_ws: dict[str, set[str]] = defaultdict(set)
    for scope_id, subject_type, subject_id, expires_at in bindings:
        if not scope_id or (expires_at and expires_at <= now_iso):
            continue
        if subject_type == "group":
            per_ws[scope_id].update(group_members.get(subject_id, ()))
        elif subject_id:
            per_ws[scope_id].add(subject_id)
    return Counter({ws_id: len(users) for ws_id, users in per_ws.items()})


async def _actors_by_workspace(
    session: AsyncSession, *, since: str,
) -> dict[str, set[str]]:
    rows = (await session.execute(
        select(ViewActivityLogORM.workspace_id, ViewActivityLogORM.actor)
        .where(
            ViewActivityLogORM.created_at >= since,
            ViewActivityLogORM.workspace_id.is_not(None),
            ViewActivityLogORM.actor.is_not(None),
        )
        .group_by(ViewActivityLogORM.workspace_id, ViewActivityLogORM.actor)
    )).all()
    out: dict[str, set[str]] = defaultdict(set)
    for ws_id, actor in rows:
        out[ws_id].add(actor)
    return out


async def workspace_detail(
    session: AsyncSession, workspace_id: str, *,
    days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> Optional[dict]:
    """Full insights for one workspace. ``None`` when it doesn't exist.

    The document is built in full and then filtered through
    :func:`redact_workspace_detail`, so this function has exactly one exit and
    a future field cannot bypass the scope by being added below.
    """
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)

    workspace = (await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == workspace_id, WorkspaceORM.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if workspace is None:
        return None
    # A drill-in is all specifics — names, contributors, what they built. There
    # is no useful redacted version of this page, so refuse rather than render
    # an outline of one.
    if scope is not None and not scope.can_see(workspace_id):
        raise WorkspaceForbidden(workspace_id)

    live_view = [ViewORM.deleted_at.is_(None), ViewORM.workspace_id == workspace_id]
    ws_activity = [ViewActivityLogORM.workspace_id == workspace_id]

    views_total = await _scalar(session, select(func.count()).where(*live_view))
    views_by_day = await _count_by_day(session, ViewORM.created_at, since=w.start, where=live_view)
    views_prev = await _scalar(session, select(func.count()).where(
        ViewORM.created_at >= w.previous_start, ViewORM.created_at < w.start, *live_view))
    activity_by_day = await _count_by_day(
        session, ViewActivityLogORM.created_at, since=w.start, where=ws_activity)
    activity_prev = await _scalar(session, select(func.count()).where(
        ViewActivityLogORM.created_at >= w.previous_start,
        ViewActivityLogORM.created_at < w.start, *ws_activity))
    views_before = await _scalar(
        session, select(func.count()).where(ViewORM.created_at < w.start, *live_view))

    opens = await _fold_opens(session, since=w.start, workspace_id=workspace_id)
    opens_previous = await _fold_opens(
        session, since=w.previous_start, until=w.start, workspace_id=workspace_id)
    opens_prev_total = opens_previous.total

    actors_now = await _actors_by_day(session, since=w.start, workspace_id=workspace_id)
    actors_previous = await _actors_by_day(
        session, since=w.previous_start, until=w.start, workspace_id=workspace_id)
    active_now = _flatten(actors_now)
    active_prev = _flatten(actors_previous)

    actors_per_bucket: dict[str, set[str]] = {b: set() for b in w.buckets}
    for day, actors in actors_now.items():
        bucket = w.bucket_of(day)
        if bucket is not None:
            actors_per_bucket[bucket].update(actors)

    opens_by_day = await _count_by_day(
        session, ProductEventORM.created_at, since=w.start,
        where=[ProductEventORM.event_type == VIEW_OPENED],
    ) if opens.total else {}

    ds_ids = (await _ds_ids_by_workspace(session)).get(workspace_id, [])
    stats = await stats_repo.list_data_source_stats(session, ds_ids)
    entity_types: set[str] = set()
    for row in stats:
        try:
            entity_types.update(json.loads(row.entity_type_counts or "{}").keys())
        except (ValueError, TypeError):
            continue

    members = await _member_counts(session, now=now)
    models_total = await _scalar(
        session,
        select(func.count()).select_from(ContextModelORM)
        .where(ContextModelORM.workspace_id == workspace_id),
    )

    # Per-view opens inside this workspace, ranked; falls back to visit counts
    # while open-tracking history is still short.
    ranked_view_ids = [vid for vid, _ in opens.by_view.most_common(TOP_N)]
    workspace_view_ids = {
        vid for (vid,) in (await session.execute(
            select(ViewORM.id).where(*live_view)
        )).all()
    }
    ranked_view_ids = [vid for vid in ranked_view_ids if vid in workspace_view_ids]
    if not ranked_view_ids:
        visits = Counter(dict((await session.execute(
            select(ViewVisitORM.view_id, func.count()).group_by(ViewVisitORM.view_id)
        )).all()))
        ranked_view_ids = [
            vid for vid, _ in visits.most_common() if vid in workspace_view_ids
        ][:TOP_N]
    view_rows = {
        v.id: v for v in (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(ranked_view_ids))
        )).scalars().all()
    } if ranked_view_ids else {}

    contributors: Counter = Counter(dict((await session.execute(
        select(ViewActivityLogORM.actor, func.count())
        .where(
            ViewActivityLogORM.created_at >= w.start,
            ViewActivityLogORM.actor.is_not(None),
            *ws_activity,
        )
        .group_by(ViewActivityLogORM.actor)
    )).all()))
    names = await resolve_user_ids(session, {a for a, _ in contributors.most_common(TOP_N)})

    detail = {
        "workspaceId": workspace.id,
        "name": workspace.name,
        "description": workspace.description,
        "createdAt": workspace.created_at,
        "isActive": bool(workspace.is_active),
        "windowDays": days,
        "generatedAt": now.isoformat(),
        "range": {
            "from": w.start,
            "to": w.end,
            "previousFrom": w.previous_start,
            "previousTo": w.start,
        },
        "bucket": w.granularity,
        "totals": {
            "views": _metric(views_total, sum(views_by_day.values()), views_prev),
            "viewOpens": _metric(opens.total, opens.total, opens_prev_total),
            "activeUsers": _metric(len(active_now), len(active_now), len(active_prev)),
            "activity": _metric(
                sum(activity_by_day.values()), sum(activity_by_day.values()), activity_prev),
            # Point-in-time counts: there is no "new members this week" here,
            # so they carry a total and no delta rather than a fabricated 0%.
            "members": {"total": int(members.get(workspace_id, 0))},
            "dataSources": {"total": len(ds_ids)},
            "contextModels": {"total": models_total},
        },
        "series": {
            "buckets": w.buckets,
            "viewsCreated": w.align(views_by_day),
            "cumulativeViews": w.running_total(views_by_day, views_before),
            "activityEvents": w.align(activity_by_day),
            "activeUsers": [len(actors_per_bucket[b]) for b in w.buckets],
            "viewOpens": w.align(opens_by_day),
        },
        "breakdowns": {
            "viewsByVisibility": _fold_tail(
                await _count_group(session, ViewORM.visibility, where=live_view)),
            "viewsByType": _fold_tail(
                await _count_group(session, ViewORM.view_type, where=live_view)),
            "activityByAction": _fold_tail(await _count_group(
                session, ViewActivityLogORM.action,
                where=[ViewActivityLogORM.created_at >= w.start, *ws_activity],
            )),
        },
        "topViews": [
            {
                "viewId": vid,
                "name": view_rows[vid].name,
                "workspaceId": view_rows[vid].workspace_id,
                "visibility": view_rows[vid].visibility,
                "viewType": view_rows[vid].view_type,
                "opens": int(opens.by_view.get(vid, 0)),
                "uniqueViewers": len(opens.viewers_by_view.get(vid, ())),
                "favourites": 0,
            }
            for vid in ranked_view_ids if vid in view_rows
        ],
        "topContributors": [
            {
                "userId": uid,
                "name": (names.get(uid) or (None, None))[0] or uid,
                "email": (names.get(uid) or (None, None))[1],
                "events": int(count),
            }
            for uid, count in contributors.most_common(TOP_N) if uid
        ],
        "graph": {
            "nodes": sum(int(s.node_count or 0) for s in stats),
            "edges": sum(int(s.edge_count or 0) for s in stats),
            "entityTypes": len(entity_types),
            "sourcesWithStats": len(stats),
        },
    }
    # One exit, through the redactor. See the note on the function.
    return redact_workspace_detail(detail, scope)
