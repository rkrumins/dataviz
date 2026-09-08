"""Capacity: what the write budget measures, on demand, for people.

The rebuild reads the shard that owns a graph before it writes rollups and
budgets by that shard's real headroom (``providers.shard_capacity``). Until
now that reading lived in one place a person never looks: the run's
``run_stats`` on success, the refusal text on failure. This module takes the
SAME reading and the SAME arithmetic and assembles it for the surfaces where
an operator decides things — the Freshness page (every shard, every source
on it, how many more rollup edges fit), the per-source drawer and the
re-trigger dialog (this source's footprint and whether Full detail would fit
before the job is queued).

Shape, so it stays cheap on a large fleet and honest on a broken one:

* One SQL pass over aggregated sources (bounded), the freshness views' own
  state/failure/latest-run maps, and the stored Defaults row.
* Providers are resolved once per ``(provider_id, graph_name)`` — the
  manager's own cache key — and every graph is mapped to its owning node
  with ``owner_endpoint`` so the sweep pays ONE ``INFO memory`` per node,
  however many graphs share it.
* The whole sweep runs under a deadline and never raises: a provider that
  cannot be resolved, a node that cannot be read, or a source the deadline
  cut off lands in ``unresolved`` with a coarse reason.
* The fleet snapshot is cached briefly in-process (stampede-guarded) so a
  page full of viewers shares one sweep; ``fresh=True`` bypasses it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.providers.shard_capacity import (
    ShardMemory, bytes_per_edge_default, compute_write_budget, owner_endpoint,
    read_shard_memory, shard_reserve_pct_default, estimate_margin_pct_default,
)
from .models import AggregationJobORM, AggregationSettingsORM
from .schemas import (
    AggregationCapacityResponse, AutoPreflight, CapacityLimitValue, CapacityLimits,
    CapacitySource, FullDetailPreflight, ShardCapacity, SourceCapacityResponse,
    UnresolvedSource,
)

logger = logging.getLogger(__name__)

_AGGREGATED_STATUSES = ("ready", "failed", "pending", "running")


def _ttl_s() -> float:
    return float(os.getenv("AGGREGATION_CAPACITY_CACHE_TTL_S", "10"))


def _deadline_s() -> float:
    return float(os.getenv("AGGREGATION_CAPACITY_DEADLINE_S", "8"))


def _max_sources() -> int:
    return max(1, int(os.getenv("AGGREGATION_CAPACITY_MAX_SOURCES", "500")))


def _init_timeout_s() -> float:
    return float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Pure helpers ────────────────────────────────────────────────────────


def _rollup_storage_value(raw: Any) -> Optional[str]:
    """``materialize_fine_pairs`` as stored (bool or "auto") → the wire
    vocabulary ``'auto' | 'true' | 'false'``; None for anything else."""
    if raw is None:
        return None
    if isinstance(raw, str):
        v = raw.strip().lower()
        return v if v in ("auto", "true", "false") else None
    return "true" if raw else "false"


def effective_limits(stored_tuning: Optional[Dict[str, Any]]) -> CapacityLimits:
    """The fleet limits the next rebuild will resolve when its job carries
    no override: the stored Defaults row over the environment, each labelled
    by where it came from. Mirrors ``AggregationPipeline._static_cap``."""
    # Local import: the providers package pulls in the graph client, and
    # this module is imported by the API layer long before it.
    from backend.app.providers.falkordb_materialize import (
        _budget_recheck_edges, _materialize_fine_pairs_mode, _max_cube_edges,
        _max_materialized_edges,
    )

    stored = stored_tuning or {}

    def pick(key: str, env_value: Any) -> CapacityLimitValue:
        value = stored.get(key)
        if value is None:
            return CapacityLimitValue(value=env_value, source="default")
        return CapacityLimitValue(value=value, source="global")

    ceiling_raw = stored.get("max_materialized_edges")
    ceiling: Optional[int] = None
    try:
        ceiling = int(ceiling_raw) if ceiling_raw is not None else None
    except (TypeError, ValueError):
        ceiling = None
    rollup = _rollup_storage_value(stored.get("materialize_fine_pairs"))
    return CapacityLimits(
        shard_reserve_pct=pick("shard_reserve_pct", shard_reserve_pct_default()),
        bytes_per_edge=pick("bytes_per_edge", bytes_per_edge_default()),
        max_materialized_edges=CapacityLimitValue(
            value=ceiling, source="global" if ceiling is not None else "default",
        ),
        rollup_storage=(
            CapacityLimitValue(value=rollup, source="global") if rollup is not None
            else CapacityLimitValue(value=_materialize_fine_pairs_mode(), source="default")
        ),
        estimate_margin_pct=estimate_margin_pct_default(),
        max_cube_edges=_max_cube_edges(),
        static_cap=ceiling if ceiling else _max_materialized_edges(),
        budget_recheck_edges=_budget_recheck_edges(),
    )


def graph_key_of(ds: Any, provider: Any) -> str:
    """The key the rollups land on: the projection graph in dedicated mode
    (which may hash to a different shard than the source graph), else the
    source graph. The data-source row decides the mode — a shared provider
    instance carries whichever mode its last job set."""
    graph = getattr(provider, "_graph_name", None) or getattr(ds, "graph_name", None) or ""
    if getattr(ds, "projection_mode", None) == "dedicated":
        return getattr(ds, "dedicated_graph_name", None) or f"{graph}_proj"
    return graph


def mode_of(provider: Any) -> Optional[str]:
    return getattr(getattr(provider, "_conn_cfg", None), "mode", None)


def client_of(provider: Any) -> Any:
    """The cluster client resolves any key's owner from its slot map, so the
    source graph's client answers for the projection graph too."""
    return getattr(provider, "_db", None)


def _int_or(value: Any, default: int = 0) -> int:
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def shard_row(reading: ShardMemory, limits: CapacityLimits) -> ShardCapacity:
    """One node under the fleet reserve — the pipeline's own budget
    arithmetic at the fleet bytes-per-edge."""
    budget = compute_write_budget(
        reading,
        reserve_pct=_int_or(limits.shard_reserve_pct.value, shard_reserve_pct_default()),
        bytes_per_edge=_int_or(limits.bytes_per_edge.value, bytes_per_edge_default()),
        bpe_source=limits.bytes_per_edge.source,
        explicit_ceiling=(
            int(limits.max_materialized_edges.value)
            if limits.max_materialized_edges.value else None
        ),
        static_cap=limits.static_cap,
    )
    used_pct = None
    if reading.measurable:
        used_pct = round(int(reading.used or 0) * 100.0 / int(reading.maxmemory or 1), 1)
    return ShardCapacity(
        endpoint=reading.endpoint,
        used=reading.used,
        maxmemory=reading.maxmemory,
        policy=reading.policy,
        measurable=reading.measurable,
        why_not=None if reading.measurable else reading.why_not,
        used_pct=used_pct,
        reserve_pct=budget.reserve_pct,
        reserve_bytes=budget.reserve_bytes,
        available_bytes=budget.available_bytes,
        allowed_growth_edges=budget.allowed_growth_edges,
        governed_by=budget.governed_by,
        static_cap=budget.static_cap,
    )


def source_row(
    ds: Any, *, provider_name: Optional[str], graph_key: Optional[str],
    state: Dict[str, Any], stats: Dict[str, Any], failure: Dict[str, Any],
    limits: CapacityLimits,
) -> CapacitySource:
    """What one source costs its shard today, and what its last run learned."""
    edge_count = _int_or(state.get("aggregation_edge_count"))
    if not edge_count:
        edge_count = _int_or(getattr(ds, "aggregation_edge_count", None))
    observed = _int_or(state.get("observed_bytes_per_edge"))
    if observed > 0:
        bpe, bpe_source = observed, "calibrated"
    else:
        bpe, bpe_source = _int_or(limits.bytes_per_edge.value, bytes_per_edge_default()), "default"
    estimate = stats.get("cube_estimate")
    return CapacitySource(
        data_source_id=ds.id,
        label=getattr(ds, "label", None),
        workspace_id=getattr(ds, "workspace_id", None),
        provider_id=getattr(ds, "provider_id", None),
        provider_name=provider_name,
        graph_key=graph_key,
        projection_mode=getattr(ds, "projection_mode", None) or "in_source",
        aggregation_status=getattr(ds, "aggregation_status", None),
        edge_count=edge_count,
        bytes_per_edge=bpe,
        bytes_per_edge_source=bpe_source,
        footprint_bytes=edge_count * bpe,
        last_cube_estimate=int(estimate) if isinstance(estimate, (int, float)) else None,
        last_regime=stats.get("regime") if isinstance(stats.get("regime"), str) else None,
        last_failure_category=failure.get("category"),
    )


def full_detail_preflight(
    reading: ShardMemory, limits: CapacityLimits, *,
    edge_count: int, estimate: Optional[int], bytes_per_edge: int,
) -> FullDetailPreflight:
    """Would a FORCED full cube land today? The pipeline's own verdict on
    the last run's upper-bound estimate — growth over what the graph already
    holds, with the estimate margin — against the live reading."""
    margin = limits.estimate_margin_pct
    if estimate is None:
        return FullDetailPreflight(verdict="unknown", margin_pct=margin)
    budget = compute_write_budget(
        reading,
        reserve_pct=_int_or(limits.shard_reserve_pct.value, shard_reserve_pct_default()),
        bytes_per_edge=bytes_per_edge,
        bpe_source="calibrated",
        explicit_ceiling=(
            int(limits.max_materialized_edges.value)
            if limits.max_materialized_edges.value else None
        ),
        static_cap=limits.static_cap,
    )
    growth = max(0, int(estimate) - int(edge_count))
    verdict = budget.verdict(projected=int(estimate), growth_edges=growth, margin_pct=margin)
    return FullDetailPreflight(
        estimate_edges=int(estimate),
        estimate_source="lastRun",
        growth_edges=growth,
        needed_bytes=verdict.needed_bytes,
        verdict="fits" if verdict.ok else "short",
        blocked_by=verdict.blocked_by,
        shortfall_bytes=verdict.shortfall_bytes,
        shortfall_edges=verdict.shortfall_edges if not verdict.ok else 0,
        margin_pct=margin,
    )


def auto_preflight(
    limits: CapacityLimits, full_detail: FullDetailPreflight,
) -> AutoPreflight:
    """Auto is never refused: it stores the cube only while the cube fits
    both its own ceiling and the shard, else the depth-diagonal."""
    would = None
    if full_detail.estimate_edges is not None:
        would = (
            full_detail.estimate_edges <= limits.max_cube_edges
            and full_detail.verdict == "fits"
        )
    return AutoPreflight(cube_ceiling=limits.max_cube_edges, would_store_cube=would)


# ── Reads ───────────────────────────────────────────────────────────────


def _safe_json(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def latest_completed_stats_map(
    session: AsyncSession, ds_ids: List[str],
) -> Dict[str, Dict[str, Any]]:
    """``{ds_id: run_stats}`` of each source's NEWEST completed job — where
    the cube estimate and the storage regime live (persisted on success
    only). One bounded query; best-effort, never raises."""
    if not ds_ids:
        return {}
    try:
        rows = (await session.execute(
            select(AggregationJobORM.data_source_id, AggregationJobORM.run_stats)
            .where(AggregationJobORM.data_source_id.in_(ds_ids))
            .where(AggregationJobORM.status == "completed")
            .order_by(
                AggregationJobORM.data_source_id,
                AggregationJobORM.updated_at.desc().nullslast(),
            )
        )).all()
    except Exception as exc:
        logger.warning("latest completed-run map failed: %s", exc)
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for ds_id, raw in rows:
        if ds_id not in out:                      # first per source = newest
            out[ds_id] = _safe_json(raw)
    return out


async def _stored_tuning(session: AsyncSession) -> Dict[str, Any]:
    """The Defaults row's tuning, snake_case as stored; ``{}`` when absent
    or unreadable (the environment then governs, as it does for the run)."""
    try:
        row = await session.get(AggregationSettingsORM, "global")
        return _safe_json(getattr(row, "tuning_json", None)) if row is not None else {}
    except Exception as exc:
        logger.warning("capacity: settings read failed (using env defaults): %s", exc)
        return {}


async def _list_sources(
    session: AsyncSession, *, ds_id: Optional[str] = None,
) -> Tuple[List[Tuple[Any, Optional[str]]], int, bool]:
    """``([(data_source_row, provider_name)], total, truncated)`` over the
    sources that have (or are getting) rollups — largest first, so the
    sources that matter most to a shard are the ones a capped sweep keeps."""
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM

    base = (
        select(WorkspaceDataSourceORM, ProviderORM.name)  # noqa: cross-domain (capacity view: read-only admin surface labelling sources by provider; one bounded query, no hot path)
        .join(ProviderORM, ProviderORM.id == WorkspaceDataSourceORM.provider_id, isouter=True)
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )
    if ds_id is not None:
        base = base.where(WorkspaceDataSourceORM.id == ds_id)
    else:
        base = base.where(WorkspaceDataSourceORM.aggregation_status.in_(_AGGREGATED_STATUSES))
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    cap = 1 if ds_id is not None else _max_sources()
    rows = (await session.execute(
        base.order_by(
            WorkspaceDataSourceORM.aggregation_edge_count.desc().nullslast(),
            WorkspaceDataSourceORM.id,
        ).limit(cap)
    )).all()
    return [(r[0], r[1]) for r in rows], int(total), int(total) > len(rows)


# ── Assembly ────────────────────────────────────────────────────────────


class _Sweep:
    """One pass over a set of sources: providers resolved once per cache
    key, nodes read once per endpoint, everything else recorded as
    unresolved with a coarse reason."""

    def __init__(self, session: AsyncSession, registry: Any) -> None:
        self.session = session
        self.registry = registry
        self.providers: Dict[Tuple[str, str], Any] = {}
        self.failed: Dict[Tuple[str, str], str] = {}
        self.readings: Dict[str, ShardMemory] = {}
        self.placed: Dict[str, Tuple[str, str]] = {}     # ds_id → (endpoint, graph_key)
        self.unresolved: Dict[str, str] = {}             # ds_id → why_not

    async def _provider_for(self, ds: Any) -> Any:
        key = (str(getattr(ds, "provider_id", "") or ""), str(getattr(ds, "graph_name", "") or ""))
        if key in self.providers:
            return self.providers[key]
        if key in self.failed:
            raise RuntimeError(self.failed[key])
        if self.registry is None:
            self.failed[key] = "no provider registry"
            raise RuntimeError(self.failed[key])
        try:
            provider = await self.registry.get_provider_for_workspace(
                getattr(ds, "workspace_id", None), self.session, data_source_id=ds.id,
            )
            connect = getattr(provider, "_ensure_connected", None)
            if connect is not None:
                async with asyncio.timeout(_init_timeout_s()):
                    await connect()
        except Exception as exc:                          # noqa: BLE001 — recorded, never raised
            # Coarse on purpose: the raw text carries words the failure
            # classifier keys on, and a person needs the shape, not the trace.
            self.failed[key] = f"provider unavailable ({type(exc).__name__})"
            logger.info("capacity: provider for %s unresolved: %s", ds.id, exc)
            raise RuntimeError(self.failed[key])
        self.providers[key] = provider
        return provider

    async def place(self, ds: Any) -> None:
        """Map one source to its owning node, reading the node once."""
        try:
            provider = await self._provider_for(ds)
        except RuntimeError as exc:
            self.unresolved[ds.id] = str(exc)
            return
        db = client_of(provider)
        if db is None:
            self.unresolved[ds.id] = "provider has no graph client"
            return
        mode = mode_of(provider)
        key = graph_key_of(ds, provider)
        timeout = _init_timeout_s()
        endpoint = await owner_endpoint(db, mode=mode, graph_key=key, timeout=timeout)
        if endpoint == "unknown":
            self.unresolved[ds.id] = "the shard owning this graph could not be determined"
            return
        if endpoint not in self.readings:
            self.readings[endpoint] = await read_shard_memory(
                db, mode=mode, graph_key=key, timeout=timeout,
            )
        self.placed[ds.id] = (endpoint, key)


async def _assemble(
    session: AsyncSession, registry: Any, *, ds_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    sources, total, truncated = await _list_sources(session, ds_id=ds_id)
    if ds_id is not None and not sources:
        return None
    ds_ids = [ds.id for ds, _ in sources]
    # The freshness views' own maps: one query each, never raising.
    from .service import _latest_failure_map, _state_map

    states = await _state_map(session, ds_ids)
    failed_ids = [ds.id for ds, _ in sources if getattr(ds, "aggregation_status", None) == "failed"]
    failures = await _latest_failure_map(session, failed_ids)
    stats = await latest_completed_stats_map(session, ds_ids)
    limits = effective_limits(await _stored_tuning(session))

    sweep = _Sweep(session, registry)
    try:
        async with asyncio.timeout(_deadline_s()):
            for ds, _name in sources:
                await sweep.place(ds)
    except TimeoutError:
        logger.info("capacity sweep hit its %.1fs deadline after %d of %d sources",
                    _deadline_s(), len(sweep.placed) + len(sweep.unresolved), len(sources))
    for ds, _name in sources:
        if ds.id not in sweep.placed and ds.id not in sweep.unresolved:
            sweep.unresolved[ds.id] = "not measured before the deadline"

    by_endpoint: Dict[str, List[CapacitySource]] = {}
    unresolved: List[UnresolvedSource] = []
    rows_by_id: Dict[str, CapacitySource] = {}
    for ds, provider_name in sources:
        if ds.id in sweep.unresolved:
            unresolved.append(UnresolvedSource(
                data_source_id=ds.id, label=getattr(ds, "label", None),
                workspace_id=getattr(ds, "workspace_id", None),
                provider_id=getattr(ds, "provider_id", None),
                why_not=sweep.unresolved[ds.id],
            ))
            continue
        endpoint, key = sweep.placed[ds.id]
        row = source_row(
            ds, provider_name=provider_name, graph_key=key,
            state=states.get(ds.id, {}), stats=stats.get(ds.id, {}),
            failure=failures.get(ds.id, {}), limits=limits,
        )
        rows_by_id[ds.id] = row
        by_endpoint.setdefault(endpoint, []).append(row)

    shards: List[ShardCapacity] = []
    for endpoint, reading in sweep.readings.items():
        shard = shard_row(reading, limits)
        shard.sources = sorted(
            by_endpoint.get(endpoint, []), key=lambda s: -s.footprint_bytes,
        )
        shards.append(shard)
    # Fullest first; the ones the budget cannot govern last.
    shards.sort(key=lambda s: (not s.measurable, -(s.used_pct or 0.0), s.endpoint))
    return {
        "limits": limits, "shards": shards, "unresolved": unresolved,
        "sources_total": total, "truncated": truncated,
        "rows_by_id": rows_by_id, "readings": sweep.readings, "placed": sweep.placed,
        "states": states, "stats": stats,
    }


_cache: Optional[Tuple[float, AggregationCapacityResponse]] = None
_lock = asyncio.Lock()


def _with_age(snapshot: AggregationCapacityResponse, cached_at: float) -> AggregationCapacityResponse:
    return snapshot.model_copy(
        update={"cache_age_ms": int((time.monotonic() - cached_at) * 1000)},
    )


async def assemble_fleet_capacity(
    session: AsyncSession, registry: Any, *, fresh: bool = False,
) -> AggregationCapacityResponse:
    """Every shard with rollups on it, what fits, and the sources on each.
    Cached briefly so a page of viewers shares one sweep; never raises."""
    global _cache
    if not fresh and _cache is not None and time.monotonic() - _cache[0] < _ttl_s():
        return _with_age(_cache[1], _cache[0])
    async with _lock:
        if not fresh and _cache is not None and time.monotonic() - _cache[0] < _ttl_s():
            return _with_age(_cache[1], _cache[0])
        parts = await _assemble(session, registry) or {}
        snapshot = AggregationCapacityResponse(
            limits=parts.get("limits") or effective_limits({}),
            shards=parts.get("shards") or [],
            unresolved=parts.get("unresolved") or [],
            sources_total=parts.get("sources_total") or 0,
            truncated=bool(parts.get("truncated")),
            measured_at=_now_iso(),
        )
        _cache = (time.monotonic(), snapshot)
        return _with_age(snapshot, _cache[0])


async def assemble_source_capacity(
    session: AsyncSession, registry: Any, ds_id: str,
) -> Optional[SourceCapacityResponse]:
    """One source's footprint, its shard's headroom and the pre-flight fit
    for Full detail vs Auto — the same reading the next run will take.
    ``None`` when the source does not exist."""
    parts = await _assemble(session, registry, ds_id=ds_id)
    if parts is None:
        return None
    limits: CapacityLimits = parts["limits"]
    row = parts["rows_by_id"].get(ds_id)
    if row is None:
        # Placed nowhere: still answer, with the shard marked unmeasurable
        # and the reason on it, so the drawer explains instead of erroring.
        why = next((u.why_not for u in parts["unresolved"] if u.data_source_id == ds_id),
                   "the shard owning this graph could not be determined")
        reading = ShardMemory("unknown", None, None, None, time.monotonic(), "unavailable", why)
        ds_rows, _, _ = await _list_sources(session, ds_id=ds_id)
        ds, provider_name = ds_rows[0]
        row = source_row(
            ds, provider_name=provider_name, graph_key=None,
            state=parts["states"].get(ds_id, {}), stats=parts["stats"].get(ds_id, {}),
            failure={}, limits=limits,
        )
        shard = shard_row(reading, limits)
        shard.why_not = why
    else:
        endpoint, _ = parts["placed"][ds_id]
        reading = parts["readings"][endpoint]
        shard = shard_row(reading, limits)
    full = full_detail_preflight(
        reading, limits, edge_count=row.edge_count,
        estimate=row.last_cube_estimate, bytes_per_edge=row.bytes_per_edge,
    )
    return SourceCapacityResponse(
        source=row, shard=shard, limits=limits, full_detail=full,
        auto=auto_preflight(limits, full), measured_at=_now_iso(),
    )
