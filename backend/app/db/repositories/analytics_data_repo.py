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

import logging
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataSourceCountRollupORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
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


async def _sources(session: AsyncSession) -> dict[str, _Source]:
    """Every data source ever registered, removed ones included: history
    needs to know when they arrived and when they left."""
    rows = (await session.execute(
        select(
            WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id,
            WorkspaceDataSourceORM.provider_id, WorkspaceDataSourceORM.label,
            WorkspaceDataSourceORM.graph_name, WorkspaceDataSourceORM.created_at,
            WorkspaceDataSourceORM.deleted_at,
        )
    )).all()
    return {
        r[0]: _Source(
            id=r[0], workspace_id=r[1], provider_id=r[2],
            name=r[3] or r[4] or r[0], created_at=r[5], deleted_at=r[6],
        )
        for r in rows
    }


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

    names = await _workspace_names(
        session,
        set(head) | {sources[ds].workspace_id for ds, _, _ in movers if ds in sources}
        | {g.workspace_of.get(ds) for ds, _, _ in movers},
    )

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
    doc["redaction"] = {
        "applied": True,
        "reportsAllWorkspaces": scope.reports_all_workspaces,
    }
    return doc
