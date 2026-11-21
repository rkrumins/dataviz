"""Platform analytics — what the platform holds, and how it got there.

Backs ``/api/v1/admin/analytics/data``: how many entities and relationships
the platform holds over time (overall, by workspace, by provider type), which
sources moved most, what was onboarded and how, and how far version control
has been adopted. Same house rules as :mod:`analytics_repo` — single-table
reads stitched by id, ISO ``TEXT`` day keys compared as strings.

**Entities are levels, not flows.** A bucket's figure is what the platform
held at the end of it, read from the daily profiling rollups at the bucket's
closing day. Each source's last known count is carried forward until a newer
one arrives — so a source the profiler missed for a day does not vanish from
that day's total — and stops being carried the day the source was deleted.

**Version control is a second store.** Its graphs live in ``graphver``, read
with a time limit. When that read fails the section says it is unavailable
rather than reporting zero adoption, and nothing else in the document waits
on it or fails with it.
"""
from __future__ import annotations

import json
import logging
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataRequestORM,
    DataSourceContactORM,
    DataSourceCountRollupORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    WorkspaceRequestORM,
)
from backend.app.db.repositories import profiling_repo
from backend.app.db.repositories.analytics_repo import (
    REDACTED_WORKSPACE,
    Window,
    _chunked,
    _delta,
    _metric,
    build_window,
)

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.app.services.analytics_scope import ViewerScope

logger = logging.getLogger(__name__)

_ROLL = DataSourceCountRollupORM

#: How far before a window a source's last count is looked for. A source the
#: profiler has not reported for longer than this has gone quiet rather than
#: stayed the same size, and the bound keeps the lookup an index range rather
#: than a scan of every day ever rolled up.
_BASELINE_LOOKBACK_DAYS = 35

#: Workspaces drawn as their own band; the rest fold into "Other".
_TOP_WORKSPACES = 6

#: Sources listed as the biggest movers.
_TOP_MOVERS = 8

#: A source counts as "under version control" through any of these kinds.
VERSION_KINDS = ("manual", "authoritative", "hybrid", "blank")

#: Seconds the version-control section may wait on its store.
_GRAPHVER_TIMEOUT_SECS = 3.0

REDACTED_SOURCE = "Restricted source"


# ── Growth ───────────────────────────────────────────────────────────

@dataclass
class Growth:
    """Entity and relationship levels over one window, for one scope."""

    entities: list[int]
    relationships: list[int]
    #: Each source's (entities, relationships) when the window opened, and at
    #: its last closing day.
    start: dict[str, tuple[int, int]]
    end: dict[str, tuple[int, int]]
    #: Entities per bucket, per workspace and per provider id.
    by_workspace: dict[str, list[int]] = field(default_factory=dict)
    by_provider: dict[str, list[int]] = field(default_factory=dict)
    workspace_of: dict[str, Optional[str]] = field(default_factory=dict)


async def growth(
    session: AsyncSession, w: Window, *, deleted: dict[str, str],
    workspace_id: Optional[str] = None, moved_away: frozenset[str] = frozenset(),
) -> Growth:
    """Carry each source's daily count across the window's closing days.

    Two reads: the closing-day rows inside the window, and each source's last
    row before it opened. ``deleted`` maps a source to the day it was removed;
    from that day on it no longer counts. For one workspace, ``moved_away``
    names sources that now live elsewhere: they count only up to the last day
    they were seen here.
    """
    closing = w.closing_days()
    first_day = w.start[:10]
    scoped = [_ROLL.workspace_id == workspace_id] if workspace_id else []

    in_window = (await session.execute(
        select(
            _ROLL.data_source_id, _ROLL.bucket_start, _ROLL.node_count,
            _ROLL.edge_count, _ROLL.workspace_id, _ROLL.provider_id,
        )
        .where(_ROLL.grain == "day", _ROLL.bucket_start.in_(closing), *scoped)
    )).all()

    floor = (date.fromisoformat(first_day) - timedelta(days=_BASELINE_LOOKBACK_DAYS)).isoformat()
    latest = (
        select(
            _ROLL.data_source_id.label("ds"),
            func.max(_ROLL.bucket_start).label("b"),
        )
        .where(
            _ROLL.grain == "day", _ROLL.bucket_start < first_day,
            _ROLL.bucket_start >= floor, *scoped,
        )
        .group_by(_ROLL.data_source_id)
        .subquery()
    )
    before = (await session.execute(
        select(
            _ROLL.data_source_id, _ROLL.node_count, _ROLL.edge_count,
            _ROLL.workspace_id, _ROLL.provider_id,
        )
        .join(latest, and_(
            _ROLL.data_source_id == latest.c.ds, _ROLL.bucket_start == latest.c.b,
        ))
        .where(_ROLL.grain == "day")
    )).all()

    level: dict[str, tuple[int, int]] = {}
    workspace_of: dict[str, Optional[str]] = {}
    provider_of: dict[str, Optional[str]] = {}
    for ds, nodes, edges, ws, provider in before:
        level[ds] = (int(nodes or 0), int(edges or 0))
        workspace_of[ds], provider_of[ds] = ws, provider

    observed: dict[str, list[tuple]] = defaultdict(list)
    last_seen: dict[str, str] = {}
    for ds, day, nodes, edges, ws, provider in in_window:
        observed[str(day)[:10]].append((ds, int(nodes or 0), int(edges or 0), ws, provider))
        last_seen[ds] = max(last_seen.get(ds, ""), str(day)[:10])

    def counts(ds: str, day: str) -> bool:
        if _gone(deleted, ds, day):
            return False
        return ds not in moved_away or last_seen.get(ds, "") >= day

    start = {
        ds: lv for ds, lv in level.items()
        if not _gone(deleted, ds, first_day) and (ds not in moved_away or ds in last_seen)
    }

    entities: list[int] = []
    relationships: list[int] = []
    by_workspace: dict[str, list[int]] = defaultdict(lambda: [0] * len(closing))
    by_provider: dict[str, list[int]] = defaultdict(lambda: [0] * len(closing))
    for i, day in enumerate(closing):
        for ds, nodes, edges, ws, provider in observed.get(day, ()):
            level[ds] = (nodes, edges)
            workspace_of[ds], provider_of[ds] = ws, provider
        total_nodes = total_edges = 0
        for ds, (nodes, edges) in level.items():
            if not counts(ds, day):
                continue
            total_nodes += nodes
            total_edges += edges
            by_workspace[workspace_of.get(ds) or "unknown"][i] += nodes
            by_provider[provider_of.get(ds) or "unknown"][i] += nodes
        entities.append(total_nodes)
        relationships.append(total_edges)

    last = closing[-1]
    end = {ds: lv for ds, lv in level.items() if counts(ds, last)}
    return Growth(
        entities=entities, relationships=relationships, start=start, end=end,
        by_workspace=dict(by_workspace), by_provider=dict(by_provider),
        workspace_of=workspace_of,
    )


def _gone(deleted: dict[str, str], ds: str, day: str) -> bool:
    removed = deleted.get(ds)
    return removed is not None and removed <= day


def _level_total(levels: dict[str, tuple[int, int]], index: int) -> int:
    return sum(lv[index] for lv in levels.values())


def _change(start: int, end: int) -> dict[str, Any]:
    return {"start": start, "end": end, "change": end - start, "changePct": _delta(end, start)}


async def workspace_growth(session: AsyncSession, w: Window, workspace_id: str) -> dict:
    """One workspace's entity and relationship levels, for its drill-in."""
    sources = await _sources(session)
    deleted = {s.id: s.deleted_at[:10] for s in sources.values() if s.deleted_at}
    moved_away = frozenset(
        s.id for s in sources.values() if s.workspace_id and s.workspace_id != workspace_id
    )
    g = await growth(
        session, w, deleted=deleted, workspace_id=workspace_id, moved_away=moved_away,
    )
    return {
        "entities": g.entities,
        "relationships": g.relationships,
        "totals": {
            "entities": _change(_level_total(g.start, 0), _level_total(g.end, 0)),
            "relationships": _change(_level_total(g.start, 1), _level_total(g.end, 1)),
        },
    }


# ── Sources ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Source:
    id: str
    workspace_id: Optional[str]
    provider_id: Optional[str]
    name: str
    created_at: Optional[str]
    deleted_at: Optional[str]
    # Its details (``services.data_source_metadata``), for the coverage section.
    description: Optional[str] = None
    tags: Optional[str] = None
    trust_status: Optional[str] = None
    classification: Optional[str] = None
    fork_of: Optional[str] = None


_DS = WorkspaceDataSourceORM
_SOURCE_COLUMNS = (
    _DS.id, _DS.workspace_id, _DS.provider_id, _DS.label, _DS.graph_name, _DS.created_at,
    _DS.deleted_at, _DS.description, _DS.tags, _DS.trust_status, _DS.classification,
    _DS.fork_of_data_source_id,
)


def _source(r) -> _Source:
    return _Source(
        id=r[0], workspace_id=r[1], provider_id=r[2],
        name=r[3] or r[4] or r[0], created_at=r[5], deleted_at=r[6],
        description=r[7], tags=r[8], trust_status=r[9], classification=r[10], fork_of=r[11],
    )


async def _sources(session: AsyncSession) -> dict[str, _Source]:
    """Every data source ever registered, removed ones included: history
    needs to know when they arrived and when they left."""
    rows = (await session.execute(select(*_SOURCE_COLUMNS))).all()
    return {r[0]: _source(r) for r in rows}


async def _provider_types(session: AsyncSession) -> dict[str, str]:
    rows = (await session.execute(select(ProviderORM.id, ProviderORM.provider_type))).all()
    return {pid: ptype or "unknown" for pid, ptype in rows}


async def _workspace_names(session: AsyncSession, ids: set[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    for chunk in _chunked(sorted(i for i in ids if i)):
        names.update(dict((await session.execute(
            select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(chunk))
        )).all()))
    return names


async def _first_builds(session: AsyncSession, ids: list[str]) -> dict[str, str]:
    """When each source's first aggregation completed, if one has."""
    from backend.app.services.aggregation.models import AggregationJobORM

    out: dict[str, str] = {}
    for chunk in _chunked(ids):
        out.update({
            ds: done for ds, done in (await session.execute(
                select(AggregationJobORM.data_source_id, func.min(AggregationJobORM.completed_at))
                .where(
                    AggregationJobORM.data_source_id.in_(chunk),
                    AggregationJobORM.status == "completed",
                    AggregationJobORM.completed_at.is_not(None),
                )
                .group_by(AggregationJobORM.data_source_id)
            )).all() if done
        })
    return out


def _hours_between(earlier: str, later: str) -> Optional[float]:
    try:
        a = datetime.fromisoformat(earlier)
        b = datetime.fromisoformat(later)
    except (TypeError, ValueError):
        return None
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    hours = (b - a).total_seconds() / 3600
    return hours if hours >= 0 else None


def _percentile(values: list[float], pct: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return round(ordered[index], 1)


# ── Details: how well the sources are described ─────────────────────

#: In the order the Data tab draws them; anything else reads as "none".
TRUST_STATUSES = ("certified", "in_review", "deprecated")
CLASSIFICATIONS = ("public", "internal", "confidential", "restricted")

#: Tags kept for the most-used list. More than are shown, so the list still
#: has ten after a reader's redaction drops the ones only others use.
_TOP_TAGS = 20
_SHOWN_TAGS = 10

#: Workspaces given their own coverage row: the ones with the most sources.
_DETAIL_WORKSPACES = 8


def _tags_of(raw: Optional[str]) -> list[str]:
    """A source's tags, as saved (``_clean_tags`` already dropped blanks and
    case-insensitive repeats)."""
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(t).strip() for t in value if str(t).strip()] if isinstance(value, list) else []


def _described(s: _Source) -> bool:
    return bool((s.description or "").strip())


def _coverage(sources: list[_Source], contacted: set[str]) -> dict:
    """How many of ``sources`` say what they are, how they are labelled, who
    to ask, whether to trust them, and how sensitive they are."""
    trust = Counter(s.trust_status if s.trust_status in TRUST_STATUSES else "none" for s in sources)
    classes = Counter(
        s.classification if s.classification in CLASSIFICATIONS else "none" for s in sources)
    return {
        "sources": len(sources),
        "described": sum(1 for s in sources if _described(s)),
        "tagged": sum(1 for s in sources if _tags_of(s.tags)),
        "withContacts": sum(1 for s in sources if s.id in contacted),
        "trust": [{"key": k, "count": trust.get(k, 0)} for k in (*TRUST_STATUSES, "none")],
        "classification": [
            {"key": k, "count": classes.get(k, 0)} for k in (*CLASSIFICATIONS, "none")],
    }


async def _contacted(session: AsyncSession, ids: Optional[list[str]] = None) -> set[str]:
    """Sources that NAME an Owner or a Steward. A source naming nobody has its
    contacts worked out when read; that is a default, not a description."""
    passes = [[]] if ids is None else [
        [DataSourceContactORM.data_source_id.in_(chunk)] for chunk in _chunked(ids)]
    out: set[str] = set()
    for where in passes:
        out.update(ds for (ds,) in (await session.execute(
            select(DataSourceContactORM.data_source_id).where(*where)
            .group_by(DataSourceContactORM.data_source_id)
        )).all())
    return out


def _details(sources: list[_Source], contacted: set[str]) -> dict:
    """The platform's coverage, its most-used tags, and the coverage of the
    workspaces with the most sources."""
    tags: dict[str, dict] = {}
    for s in sources:
        for tag in _tags_of(s.tags):
            entry = tags.setdefault(tag.casefold(), {"key": tag, "count": 0, "workspaceIds": set()})
            entry["count"] += 1
            if s.workspace_id:
                entry["workspaceIds"].add(s.workspace_id)
    by_ws: dict[str, list[_Source]] = defaultdict(list)
    for s in sources:
        if s.workspace_id:
            by_ws[s.workspace_id].append(s)
    ranked = sorted(by_ws, key=lambda ws: (-len(by_ws[ws]), ws))[:_DETAIL_WORKSPACES]
    return {
        **_coverage(sources, contacted),
        "topTags": [
            # Which workspaces use a tag is carried for the redactor: a tag's
            # name says what a source is, so a reader sees only the tags used
            # somewhere they may see.
            {"key": t["key"], "count": t["count"], "workspaceIds": sorted(t["workspaceIds"])}
            for t in sorted(tags.values(), key=lambda t: (-t["count"], t["key"].casefold()))[:_TOP_TAGS]
        ],
        "byWorkspace": [
            {
                "workspaceId": ws,
                "name": None,   # filled in with the document's other names
                "sources": len(by_ws[ws]),
                "described": sum(1 for s in by_ws[ws] if _described(s)),
                "tagged": sum(1 for s in by_ws[ws] if _tags_of(s.tags)),
                "withContacts": sum(1 for s in by_ws[ws] if s.id in contacted),
                "certified": sum(1 for s in by_ws[ws] if s.trust_status == "certified"),
                "canOpen": True,
            }
            for ws in ranked
        ],
    }


async def workspace_source_details(session: AsyncSession, workspace_id: str) -> dict:
    """One workspace's coverage, for its drill-in."""
    sources = [_source(r) for r in (await session.execute(
        select(*_SOURCE_COLUMNS).where(
            _DS.workspace_id == workspace_id, _DS.deleted_at.is_(None),
            _DS.fork_of_data_source_id.is_(None),
        )
    )).all()]
    return _coverage(sources, await _contacted(session, [s.id for s in sources]))


# ── Requests: data asked for, and workspaces asked for ───────────────

#: Most urgent first, as the Data tab lists them.
URGENCIES = ("this_week", "this_month", "no_rush")


async def _asked(session: AsyncSession, col, w: Window) -> dict:
    """All time, this window and the one before, in one read."""
    total, before, now_n = (await session.execute(select(
        func.count(),
        func.sum(case((and_(col >= w.previous_start, col < w.start), 1), else_=0)),
        func.sum(case((and_(col >= w.start, col < w.end), 1), else_=0)),
    ))).one()
    return _metric(int(total or 0), int(now_n or 0), int(before or 0))


async def _decided(
    session: AsyncSession, orm, w: Window, statuses: tuple[str, ...],
) -> tuple[Counter, list[tuple[str, float]]]:
    """Requests decided in the window, by outcome, and how long each waited."""
    outcomes: Counter = Counter()
    waits: list[float] = []
    for status, created, resolved in (await session.execute(
        select(orm.status, orm.created_at, orm.resolved_at).where(
            orm.resolved_at >= w.start, orm.resolved_at < w.end, orm.status.in_(statuses),
        )
    )).all():
        outcomes[status] += 1
        if (hours := _hours_between(created, resolved)) is not None:
            waits.append((status, hours))
    return outcomes, waits


async def _requests(session: AsyncSession, w: Window) -> dict:
    """Data asked to be connected, and workspaces asked for: how many, how
    they were answered in the window, what is waiting now, and how long an
    answer takes."""
    dr, wr = DataRequestORM, WorkspaceRequestORM

    data_out, data_waits = await _decided(session, dr, w, ("connected", "declined"))
    data_open = dict((await session.execute(
        select(dr.urgency, func.count()).where(dr.status.in_(("pending", "in_progress")))
        .group_by(dr.urgency)
    )).all())
    connect_hours = [h for status, h in data_waits if status == "connected"]

    ws_out, ws_waits = await _decided(session, wr, w, ("approved", "declined"))
    ws_open = dict((await session.execute(
        select(wr.status, func.count()).where(wr.status.in_(("pending", "changes_requested")))
        .group_by(wr.status)
    )).all())
    decision_hours = [h for _status, h in ws_waits]

    return {
        "data": {
            "asked": await _asked(session, dr.created_at, w),
            "connected": data_out.get("connected", 0),
            "declined": data_out.get("declined", 0),
            "open": sum(int(n) for n in data_open.values()),
            "openByUrgency": [{"key": u, "count": int(data_open.get(u, 0))} for u in URGENCIES],
            "medianHoursToConnect": round(statistics.median(connect_hours), 1) if connect_hours else None,
        },
        "workspaces": {
            "submitted": await _asked(session, wr.created_at, w),
            "approved": ws_out.get("approved", 0),
            "declined": ws_out.get("declined", 0),
            "open": sum(int(n) for n in ws_open.values()),
            # Waiting on the person who asked, not on an approver.
            "changesRequested": int(ws_open.get("changes_requested", 0)),
            "medianHoursToDecision": round(statistics.median(decision_hours), 1) if decision_hours else None,
        },
    }


# ── The document ─────────────────────────────────────────────────────

async def platform_data(
    session: AsyncSession, *,
    days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> dict:
    """Growth, onboarding and version-control adoption over one window."""
    from backend.app.services.aggregation.reconciler import retention_days as job_retention_days

    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)

    sources = await _sources(session)
    deleted = {s.id: s.deleted_at[:10] for s in sources.values() if s.deleted_at}
    provider_types = await _provider_types(session)

    g = await growth(session, w, deleted=deleted)
    coverage = await profiling_repo.coverage_from(
        session, scope="all", scope_id=None, visible=None,
    )

    # Bands: the largest workspaces at the window's end, the rest as "Other".
    ws_ranked = sorted(g.by_workspace, key=lambda ws: g.by_workspace[ws][-1], reverse=True)
    head, tail = ws_ranked[:_TOP_WORKSPACES], ws_ranked[_TOP_WORKSPACES:]
    by_type: dict[str, list[int]] = defaultdict(lambda: [0] * len(w.buckets))
    for provider_id, values in g.by_provider.items():
        band = by_type[provider_types.get(provider_id, "unknown")]
        for i, v in enumerate(values):
            band[i] += v

    movers = sorted(
        (
            (ds, g.start.get(ds, (0, 0))[0], g.end.get(ds, (0, 0))[0])
            for ds in set(g.start) | set(g.end)
        ),
        key=lambda m: abs(m[2] - m[1]), reverse=True,
    )
    movers = [m for m in movers if m[2] != m[1]][:_TOP_MOVERS]

    # ── Onboarding ──
    created_now = [s for s in sources.values() if s.created_at and w.start <= s.created_at < w.end]
    created_before = [
        s for s in sources.values()
        if s.created_at and w.previous_start <= s.created_at < w.start
    ]
    live_total = sum(1 for s in sources.values() if not s.deleted_at)
    first_builds = await _first_builds(session, [s.id for s in created_now])
    waits = [
        h for s in created_now
        if s.id in first_builds and (h := _hours_between(s.created_at, first_builds[s.id])) is not None
    ]
    awaiting = sum(1 for s in created_now if s.id not in first_builds and not s.deleted_at)

    version_control, versioned = await _version_control(w, sources)

    def onboarded(pick) -> list[int]:
        return w.align(Counter(s.created_at[:10] for s in created_now if pick(s)))

    # Details are measured over the sources people can list: live, and not a
    # fork's row (a fork reads its parent's graph and is never listed).
    listed = [s for s in sources.values() if not s.deleted_at and not s.fork_of]
    details = _details(listed, await _contacted(session))

    names = await _workspace_names(
        session,
        set(head) | {sources[ds].workspace_id for ds, _, _ in movers if ds in sources}
        | {g.workspace_of.get(ds) for ds, _, _ in movers}
        | {row["workspaceId"] for row in details["byWorkspace"]},
    )
    for row in details["byWorkspace"]:
        row["name"] = names.get(row["workspaceId"]) or row["workspaceId"]

    doc = {
        "windowDays": days,
        "generatedAt": now.isoformat(),
        "range": {
            "from": w.start, "to": w.end,
            "previousFrom": w.previous_start, "previousTo": w.start,
        },
        "bucket": w.granularity,
        "coverage": {
            "entitiesSince": coverage[:10] if coverage else None,
            # How far back runs reach, which bounds "time to first build":
            # the prune's own setting, never a copy of its default.
            "jobsKeptDays": job_retention_days(),
        },
        "growth": {
            "buckets": w.buckets,
            "entities": g.entities,
            "relationships": g.relationships,
            "totals": {
                "entities": _change(_level_total(g.start, 0), _level_total(g.end, 0)),
                "relationships": _change(_level_total(g.start, 1), _level_total(g.end, 1)),
                "sources": len(g.end),
            },
            "byWorkspace": [
                {"workspaceId": ws, "name": names.get(ws), "entities": g.by_workspace[ws]}
                for ws in head
            ] + ([{
                "workspaceId": None, "name": "Other",
                "entities": [sum(g.by_workspace[ws][i] for ws in tail) for i in range(len(w.buckets))],
            }] if tail else []),
            "byProviderType": [
                {"key": key, "entities": values}
                for key, values in sorted(by_type.items(), key=lambda kv: kv[1][-1], reverse=True)
            ],
            "movers": [
                {
                    "dataSourceId": ds,
                    "name": sources[ds].name if ds in sources else ds,
                    "workspaceId": (sources[ds].workspace_id if ds in sources else None)
                    or g.workspace_of.get(ds),
                    "workspaceName": names.get(
                        (sources[ds].workspace_id if ds in sources else None)
                        or g.workspace_of.get(ds) or ""),
                    **_change(before_n, after_n),
                    # Whether to link it; the redactor decides per reader.
                    "canOpen": True,
                }
                for ds, before_n, after_n in movers
            ],
        },
        "onboarding": {
            "buckets": w.buckets,
            "total": onboarded(lambda s: True),
            "versioned": onboarded(lambda s: s.id in versioned) if versioned is not None else None,
            "external": onboarded(lambda s: s.id not in versioned) if versioned is not None else None,
            "totals": {"sources": _metric(live_total, len(created_now), len(created_before))},
            "byProviderType": [
                {"key": key, "count": count}
                for key, count in Counter(
                    provider_types.get(s.provider_id or "", "unknown") for s in created_now
                ).most_common()
            ],
            "firstBuild": {
                "medianHours": round(statistics.median(waits), 1) if waits else None,
                "p90Hours": _percentile(waits, 0.9),
                "measured": len(waits),
                "awaiting": awaiting,
            },
        },
        "versionControl": version_control,
        "details": details,
        "requests": await _requests(session, w),
    }
    return redact_data(doc, scope) if scope is not None else doc


async def _version_control(
    w: Window, sources: dict[str, _Source],
) -> tuple[dict, Optional[set[str]]]:
    """The adoption section, and the set of versioned sources — or an
    unavailable section and ``None`` when the store cannot be read."""
    from backend.app.services import versioned_sources

    try:
        rows = await versioned_sources.versioned_graph_rows(timeout_secs=_GRAPHVER_TIMEOUT_SECS)
    except versioned_sources.VersionedLookupUnavailable as exc:
        logger.info("analytics: version-control adoption unavailable: %s", exc)
        return {"available": False}, None

    live = [r for r in rows if not r.deleted_at]
    versioned = {r.data_source_id for r in live}
    live_sources = {s.id for s in sources.values() if not s.deleted_at}
    created = [r for r in rows if r.created_at and w.start <= r.created_at < w.end]
    by_kind = Counter(r.kind for r in live)
    return {
        "available": True,
        "byKind": [{"key": kind, "count": by_kind.get(kind, 0)} for kind in VERSION_KINDS]
        + [{"key": k, "count": n} for k, n in by_kind.items() if k not in VERSION_KINDS],
        "adopted": {
            "buckets": w.buckets,
            "series": [
                {"key": kind, "values": w.align(Counter(
                    r.created_at[:10] for r in created if r.kind == kind))}
                for kind in VERSION_KINDS
            ],
        },
        "share": {
            "versioned": len(versioned & live_sources),
            "total": len(live_sources),
        },
    }, versioned


# ── Redaction ────────────────────────────────────────────────────────

def redact_data(doc: dict, scope) -> dict:
    """Apply ``scope``. Counts are public; what a workspace is called, and what
    its sources are called, is not, unless the reader may see it.

    A source's name says what a private workspace is working on, which is
    exactly what workspace visibility withholds — so a mover in a workspace
    the reader cannot see keeps its numbers and loses its name.
    """
    if scope is None or scope.privileged:
        return doc
    doc = dict(doc)
    growth_doc = dict(doc["growth"])
    growth_doc["byWorkspace"] = [
        b if b.get("workspaceId") is None or scope.can_see(b["workspaceId"])
        else {**b, "name": REDACTED_WORKSPACE, "redacted": True}
        for b in growth_doc.get("byWorkspace", [])
    ]
    growth_doc["movers"] = [
        {**m, "canOpen": scope.can_open(m.get("workspaceId"))}
        if scope.can_see(m.get("workspaceId"))
        else {
            **m, "name": REDACTED_SOURCE, "dataSourceId": None,
            "workspaceName": REDACTED_WORKSPACE, "workspaceId": None,
            "redacted": True, "canOpen": False,
        }
        for m in growth_doc.get("movers", [])
    ]
    doc["growth"] = growth_doc

    # Absent from a document cached before they existed.
    if "details" in doc:
        details = dict(doc["details"])
        details["topTags"] = [
            # A tag is a word about what a source is: shown when it is used
            # somewhere the reader may see. Its count stays platform-wide.
            {"key": t["key"], "count": t["count"]}
            for t in details.get("topTags", [])
            if any(scope.can_see(ws) for ws in t.get("workspaceIds", []))
        ][:_SHOWN_TAGS]
        details["byWorkspace"] = [
            {**r, "canOpen": scope.can_open(r["workspaceId"])} if scope.can_see(r["workspaceId"])
            else {**r, "workspaceId": None, "name": REDACTED_WORKSPACE, "redacted": True, "canOpen": False}
            for r in details.get("byWorkspace", [])
        ]
        doc["details"] = details
    # Who is waiting for data or a workspace is an operator's view, like the
    # summary's access requests: withheld below the posture that shows it.
    if not scope.shows_operations:
        doc.pop("requests", None)

    doc["redaction"] = {
        "applied": True,
        "reportsAllWorkspaces": scope.reports_all_workspaces,
        "showsOperations": scope.shows_operations,
    }
    return doc
