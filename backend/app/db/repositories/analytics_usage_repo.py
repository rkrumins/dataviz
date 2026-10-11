"""Platform analytics — how the platform is used.

Backs ``/api/v1/admin/analytics/usage``: who looks at what (unique viewers,
how far views reach, what is opened against what is built, how soon a new
view is first opened), when people are around (presence and a weekday × hour
punchcard), how ingestion is driven (runs started by people against runs
started by automation) and how alive each workspace is, bucket by bucket.
Same house rules as :mod:`analytics_repo`: single-table reads stitched by id,
ISO ``TEXT`` day keys.

Nothing here names a person. Presence is counted, never listed, and the
operations section — which says how often people rebuild what — follows the
summary's rule and is withheld below the posture that shows operations.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AuthAuditLogORM,
    ProductEventORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    view_is_live,
)
from backend.app.db.repositories.activity_repo import _cadence, _punchcard
from backend.app.db.repositories.analytics_repo import (
    REDACTED_WORKSPACE,
    VIEW_OPENED,
    _chunked,
    _count_group,
    _distinct_by_day,
    _metric,
    _scalar,
    build_window,
)

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.app.services.analytics_scope import ViewerScope

#: Workspaces drawn in the pulse; the table below it carries every workspace.
_PULSE_WORKSPACES = 12

#: How many people a view reached, as the reach chart groups it.
_REACH_BANDS = (("1", 1, 1), ("2–5", 2, 5), ("6–20", 6, 20), ("21+", 21, None))

#: Ceiling on the rows the per-source cadence reads, as the activity summary.
_CADENCE_ROWS = 10_000

#: Who started a run, by its trigger source. A run a person started by hand
#: carries their id from the release that recorded it; before that, and for
#: the older ``manual`` trigger, the trigger source is all there is.
_AUTOMATIC = frozenset({"schedule", "drift", "reconcile", "auto", "post_purge"})
ORIGINS = ("byHand", "automatic", "onboarding", "other")


def run_origin(trigger_source: Optional[str], by_person: bool) -> str:
    if by_person or trigger_source == "manual":
        return "byHand"
    if trigger_source in _AUTOMATIC:
        return "automatic"
    if trigger_source == "onboarding":
        return "onboarding"
    return "other"


def _iso_days_before(now: datetime, days: int) -> str:
    return (now - timedelta(days=days)).isoformat()


async def platform_usage(
    session: AsyncSession, *,
    days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> dict:
    """Consumption, presence, how ingestion is driven, and workspace pulse."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    opens = [ProductEventORM.event_type == VIEW_OPENED]

    def in_window(col) -> list:
        return [col >= w.start, col < w.end]

    # ── Content ──────────────────────────────────────────────────────
    viewers_by_day = await _distinct_by_day(
        session, ProductEventORM.created_at, ProductEventORM.actor_id,
        since=w.start, until=w.end, where=opens,
    )
    viewers_per_bucket: dict[str, set[str]] = {b: set() for b in w.buckets}
    for day, actors in viewers_by_day.items():
        bucket = w.bucket_of(day)
        if bucket is not None:
            viewers_per_bucket[bucket] |= actors
    viewers_now = set().union(*viewers_by_day.values()) if viewers_by_day else set()
    viewers_prev = await _scalar(session, select(
        func.count(func.distinct(ProductEventORM.actor_id))
    ).where(
        *opens, ProductEventORM.created_at >= w.previous_start,
        ProductEventORM.created_at < w.start,
    ))

    reach_rows = (await session.execute(
        select(
            ProductEventORM.subject_id,
            func.count(func.distinct(ProductEventORM.actor_id)),
            func.count(),
        )
        .where(*opens, *in_window(ProductEventORM.created_at), ProductEventORM.subject_id.is_not(None))
        .group_by(ProductEventORM.subject_id)
    )).all()
    opened = {vid: (int(people), int(n)) for vid, people, n in reach_rows if vid}
    view_meta: dict[str, tuple] = {}
    for chunk in _chunked(sorted(opened)):
        for vid, vtype, visibility, ws in (await session.execute(
            select(ViewORM.id, ViewORM.view_type, ViewORM.visibility, ViewORM.workspace_id)
            .where(ViewORM.id.in_(chunk))
        )).all():
            view_meta[vid] = (vtype or "unknown", visibility or "unknown", ws)

    built_where = [view_is_live(), *in_window(ViewORM.created_at)]
    built_by_type = dict(await _count_group(session, ViewORM.view_type, where=built_where))
    built_by_visibility = dict(await _count_group(session, ViewORM.visibility, where=built_where))
    opens_by_type: Counter = Counter()
    opens_by_visibility: Counter = Counter()
    for vid, (_, n) in opened.items():
        vtype, visibility, _ = view_meta.get(vid, ("unknown", "unknown", None))
        opens_by_type[vtype] += n
        opens_by_visibility[visibility] += n

    def built_vs_opened(built: dict[str, int], opened_by: Counter) -> list[dict]:
        keys = sorted(set(built) | set(opened_by), key=lambda k: -(built.get(k, 0) + opened_by.get(k, 0)))
        return [{"key": k, "built": int(built.get(k, 0)), "opens": int(opened_by.get(k, 0))} for k in keys]

    # How soon a new view is first opened by someone other than its author.
    new_views = (await session.execute(
        select(ViewORM.id, ViewORM.created_at, ViewORM.created_by).where(*built_where)
    )).all()
    first_open: dict[str, str] = {}
    authors = {vid: by for vid, _, by in new_views}
    for chunk in _chunked(sorted(authors)):
        for vid, actor, at in (await session.execute(
            select(ProductEventORM.subject_id, ProductEventORM.actor_id, func.min(ProductEventORM.created_at))
            .where(*opens, ProductEventORM.subject_id.in_(chunk))
            .group_by(ProductEventORM.subject_id, ProductEventORM.actor_id)
        )).all():
            if actor and actor != authors.get(vid) and (vid not in first_open or at < first_open[vid]):
                first_open[vid] = at
    waits = []
    for vid, created, _ in new_views:
        if vid in first_open:
            try:
                hours = (datetime.fromisoformat(first_open[vid]) - datetime.fromisoformat(created)).total_seconds() / 3600
            except (TypeError, ValueError):
                continue
            waits.append(max(0.0, hours))

    # ── Engagement ───────────────────────────────────────────────────
    week, month = _iso_days_before(now, 7), _iso_days_before(now, 30)
    presence_kind = case(
        (UserORM.last_active_at >= week, "active"),
        (UserORM.last_seen_at >= week, "seen"),
        (UserORM.last_seen_at >= month, "recent"),
        (UserORM.last_login_at >= month, "recent"),
        (UserORM.last_seen_at.is_not(None), "dormant"),
        (UserORM.last_login_at.is_not(None), "dormant"),
        else_="never",
    ).label("k")
    presence = dict((await session.execute(
        select(presence_kind, func.count()).where(UserORM.deleted_at.is_(None)).group_by("k")
    )).all())
    by_hour = dict((await session.execute(
        select(func.substr(ProductEventORM.created_at, 1, 13).label("h"), func.count())
        .where(*in_window(ProductEventORM.created_at))
        .group_by("h")
    )).all())

    # ── How ingestion is driven ──────────────────────────────────────
    from backend.app.services.aggregation.models import AggregationJobORM as J

    by_person = J.triggered_by.is_not(None)
    job_rows = (await session.execute(
        select(func.substr(J.created_at, 1, 10).label("d"), J.trigger_source, by_person, J.status, func.count())
        .where(*in_window(J.created_at))
        .group_by("d", J.trigger_source, by_person, J.status)
    )).all()
    prev_rows = (await session.execute(
        select(J.trigger_source, by_person, func.count())
        .where(J.created_at >= w.previous_start, J.created_at < w.start)
        .group_by(J.trigger_source, by_person)
    )).all()
    runs_by_origin: dict[str, Counter] = {o: Counter() for o in ORIGINS}
    totals = Counter()
    outcomes = Counter()
    for day, trigger, person, status, n in job_rows:
        origin = run_origin(trigger, bool(person))
        runs_by_origin[origin][day] += int(n)
        totals[origin] += int(n)
        outcomes[status] += int(n)
    previous_by_hand = sum(int(n) for trigger, person, n in prev_rows if run_origin(trigger, bool(person)) == "byHand")
    all_runs = sum(totals.values())
    finished = outcomes.get("completed", 0) + outcomes.get("failed", 0)

    ops = [
        AuthAuditLogORM.category == "operations", AuthAuditLogORM.actor_kind == "user",
        AuthAuditLogORM.data_source_id.is_not(None), *in_window(AuthAuditLogORM.occurred_at),
    ]
    cadence = _cadence([
        (ds, ws, at) for ds, ws, at in (await session.execute(
            select(AuthAuditLogORM.data_source_id, AuthAuditLogORM.workspace_id, AuthAuditLogORM.occurred_at)
            .where(*ops)
            .order_by(AuthAuditLogORM.occurred_at.desc())
            .limit(_CADENCE_ROWS)
        )).all()
    ])[:10]
    source_names = {}
    for chunk in _chunked(sorted({c["dataSourceId"] for c in cadence})):
        source_names.update({
            ds: label or graph for ds, label, graph in (await session.execute(
                select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label, WorkspaceDataSourceORM.graph_name)
                .where(WorkspaceDataSourceORM.id.in_(chunk))
            )).all()
        })

    # ── Workspace pulse ──────────────────────────────────────────────
    # One pass over the workspace-audience ledger serves both the pulse and
    # the hands-on counts. Reading it through its partial index is what makes
    # this affordable: on a 10M-row ledger the same question asked with
    # "workspace_id IS NOT NULL" took over a minute for 30 days, this way a
    # third of a second. Platform-audience events carry no workspace anyway.
    pulse: dict[str, Counter] = defaultdict(Counter)
    hands_on: dict[str, Counter] = defaultdict(Counter)
    by_user = (AuthAuditLogORM.actor_kind == "user").label("u")
    for ws, day, category, user_did_it, n in (await session.execute(
        select(
            AuthAuditLogORM.workspace_id,
            func.substr(AuthAuditLogORM.occurred_at, 1, 10).label("d"),
            AuthAuditLogORM.category, by_user, func.count(),
        )
        .where(
            AuthAuditLogORM.audience == "workspace",
            AuthAuditLogORM.workspace_id.is_not(None),
            *in_window(AuthAuditLogORM.occurred_at),
        )
        .group_by(AuthAuditLogORM.workspace_id, "d", AuthAuditLogORM.category, by_user)
    )).all():
        pulse[ws][day] += int(n)
        if user_did_it and category in ("operations", "access"):
            hands_on[ws][category] += int(n)
    for ws, day, n in (await session.execute(
        select(ViewActivityLogORM.workspace_id, func.substr(ViewActivityLogORM.created_at, 1, 10).label("d"), func.count())
        .where(ViewActivityLogORM.workspace_id.is_not(None), *in_window(ViewActivityLogORM.created_at))
        .group_by(ViewActivityLogORM.workspace_id, "d")
    )).all():
        pulse[ws][day] += int(n)
    for vid, day, n in (await session.execute(
        select(ProductEventORM.subject_id, func.substr(ProductEventORM.created_at, 1, 10).label("d"), func.count())
        .where(*opens, *in_window(ProductEventORM.created_at), ProductEventORM.subject_id.is_not(None))
        .group_by(ProductEventORM.subject_id, "d")
    )).all():
        ws = (view_meta.get(vid) or (None, None, None))[2]
        if ws:
            pulse[ws][day] += int(n)
    live_workspaces = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.deleted_at.is_(None))
    )).all())
    ranked = sorted(
        (ws for ws in pulse if ws in live_workspaces),
        key=lambda ws: sum(pulse[ws].values()), reverse=True,
    )

    doc = {
        "windowDays": days,
        "generatedAt": now.isoformat(),
        "range": {
            "from": w.start, "to": w.end,
            "previousFrom": w.previous_start, "previousTo": w.start,
        },
        "bucket": w.granularity,
        "content": {
            "buckets": w.buckets,
            "uniqueViewers": [len(viewers_per_bucket[b]) for b in w.buckets],
            "viewers": _metric(len(viewers_now), len(viewers_now), viewers_prev),
            "viewsOpened": len(opened),
            "reach": [
                {"key": label, "count": sum(
                    1 for people, _ in opened.values()
                    if people >= low and (high is None or people <= high))}
                for label, low, high in _REACH_BANDS
            ],
            "byType": built_vs_opened(built_by_type, opens_by_type),
            "byVisibility": built_vs_opened(built_by_visibility, opens_by_visibility),
            "firstOpen": {
                "medianHours": round(statistics.median(waits), 1) if waits else None,
                "withinWeek": sum(1 for h in waits if h <= 24 * 7),
                "opened": len(waits),
                "built": len(new_views),
            },
        },
        "engagement": {
            "presence": [{"key": k, "count": int(presence.get(k, 0))} for k in ("active", "seen", "recent", "dormant", "never")],
            "punchcard": _punchcard(by_hour),
        },
        "health": {
            "buckets": w.buckets,
            "runs": [{"key": o, "values": w.align(runs_by_origin[o])} for o in ORIGINS],
            "totals": {o: totals.get(o, 0) for o in ORIGINS},
            "byHand": _metric(totals.get("byHand", 0), totals.get("byHand", 0), previous_by_hand),
            "manualShare": round(totals.get("byHand", 0) / all_runs, 4) if all_runs else None,
            "failureRate": round(outcomes.get("failed", 0) / finished, 4) if finished else None,
            "handsOnSources": [
                {**c, "name": source_names.get(c["dataSourceId"])} for c in cadence
            ],
        },
        "workspaces": {
            "buckets": w.buckets,
            "pulse": [
                {
                    "workspaceId": ws, "name": live_workspaces.get(ws),
                    "values": w.align(pulse[ws]), "total": sum(pulse[ws].values()),
                    "canOpen": True,
                }
                for ws in ranked[:_PULSE_WORKSPACES]
            ],
            "rows": [
                {
                    "workspaceId": ws,
                    "activity": sum(pulse[ws].values()),
                    "manualOperations": hands_on[ws].get("operations", 0),
                    "accessChanges": hands_on[ws].get("access", 0),
                }
                for ws in live_workspaces
            ],
        },
    }
    return redact_usage(doc, scope) if scope is not None else doc


def redact_usage(doc: dict, scope) -> dict:
    """Apply ``scope``. Content and presence are counts and stay; the
    operations section follows the summary's ``shows_operations`` rule; a
    workspace the reader cannot see keeps its numbers and loses its name, and
    its hands-on counts, which describe what the people in it are doing."""
    if scope is None or scope.privileged:
        return doc
    doc = dict(doc)
    hidden = []
    if not scope.shows_operations:
        doc.pop("health", None)
        hidden.append("operations")
    elif "health" in doc:
        health = dict(doc["health"])
        health["handsOnSources"] = [
            s if scope.can_see(s.get("workspaceId"))
            else {**s, "dataSourceId": None, "workspaceId": None, "name": None, "redacted": True}
            for s in health.get("handsOnSources", [])
        ]
        doc["health"] = health
    workspaces = dict(doc["workspaces"])
    workspaces["pulse"] = [
        {**p, "canOpen": scope.can_open(p["workspaceId"])} if scope.can_see(p["workspaceId"])
        else {**p, "name": REDACTED_WORKSPACE, "redacted": True, "canOpen": False}
        for p in workspaces.get("pulse", [])
    ]
    workspaces["rows"] = [
        r if scope.can_see(r["workspaceId"]) and scope.shows_operations
        else {**r, "manualOperations": None, "accessChanges": None}
        for r in workspaces.get("rows", [])
    ]
    doc["workspaces"] = workspaces
    doc["redaction"] = {
        "applied": True,
        "showsOperations": scope.shows_operations,
        "hidden": hidden,
    }
    return doc
