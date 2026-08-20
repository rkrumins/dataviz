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
from typing import Any, Iterable, Optional, Sequence

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    CatalogItemORM,
    ContextModelORM,
    GroupMemberORM,
    GroupORM,
    OntologyORM,
    OutboxEventORM,
    ProductEventORM,
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

logger = logging.getLogger(__name__)

#: Event type appended by ``view_repo.record_view_visit`` on every view open.
VIEW_OPENED = "view.opened"

#: Windows at or below this many days get one bucket per day; longer windows
#: bucket by week, so a 365-day chart plots 53 marks instead of 365.
_DAILY_BUCKET_MAX_DAYS = 31

#: How many rows a leaderboard returns.
TOP_N = 10

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


def build_window(days: int, *, now: Optional[datetime] = None) -> Window:
    now = now or datetime.now(timezone.utc)
    start_dt = now - timedelta(days=days)
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
        end=now.isoformat(),
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
    session: AsyncSession, *, days: int, now: Optional[datetime] = None,
) -> dict:
    """Everything the platform-wide Analytics dashboard renders, for one window."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, now=now)

    live_user = [UserORM.deleted_at.is_(None)]
    live_ws = [WorkspaceORM.deleted_at.is_(None)]
    live_view = [ViewORM.deleted_at.is_(None)]
    live_ds = [WorkspaceDataSourceORM.deleted_at.is_(None)]

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

    return {
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
        },
        "engagement": await _engagement(
            session, w, now=now, dau=dau, wau=wau, mau=mau,
            active_now=active_now, active_prev=active_prev,
        ),
        "breakdowns": await _breakdowns(session, w, opens=opens),
        "leaderboards": await _leaderboards(session, w, opens=opens),
        "graph": await _graph_scale(session),
        "coverage": {
            "viewOpenTrackingSince": await _first_open_at(session),
        },
    }


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


async def _engagement(
    session: AsyncSession, w: Window, *, now: datetime,
    dau: int, wau: int, mau: int,
    active_now: set[str], active_prev: set[str],
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
        "activationRate": round(len(funnel_created) / len(cohort), 3) if cohort else None,
        "medianDaysToFirstView": await _median_time_to_value(session, w),
        "funnel": [
            _stage("Signed up", len(cohort)),
            _stage("Became active", len(funnel_active)),
            _stage("Opened a view", len(funnel_opened)),
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
    session: AsyncSession, *, days: int, now: Optional[datetime] = None,
) -> list[dict]:
    """One aggregate row per live workspace — the Workspaces tab's table.

    Every count is its own grouped query rather than a per-workspace fan-out:
    a platform with 40 workspaces would otherwise cost 200 round-trips for a
    table that fits on one screen.
    """
    now = now or datetime.now(timezone.utc)
    w = build_window(days, now=now)

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
        })
    return rows


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
    session: AsyncSession, workspace_id: str, *, days: int,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Full insights for one workspace. ``None`` when it doesn't exist."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, now=now)

    workspace = (await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == workspace_id, WorkspaceORM.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if workspace is None:
        return None

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

    return {
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
