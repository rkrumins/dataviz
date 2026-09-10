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

Shape, so it stays cheap on a large fleet, honest on a broken one, and —
the part it did not have — STILL between refreshes:

* One SQL pass over aggregated sources (bounded), the freshness views' own
  state/failure/latest-run maps, and the stored Defaults row.
* Every node figure comes from the graph store topology snapshot
  (``services.graph_store``), which reads all nodes of every instance
  concurrently behind one 30s cache and keeps its last good reading when a
  rebuild fails. Capacity itself now dials nothing.
* Placement is arithmetic, not a round trip: a graph key hashes to a slot
  and the snapshot says which master owns it. So a source whose provider
  happens not to be instantiated in this process still appears — where the
  old per-source provider resolution left it "cannot be measured", and
  differently on every refresh.
* Every master is a row, with or without sources on it; a node the snapshot
  could not read is a row too, marked unreachable with the reason. The
  order is the snapshot's own, so rows never swap places as utilisation
  moves under them.
* The fleet snapshot is cached briefly in-process (stampede-guarded) so a
  page full of viewers shares one assembly; ``fresh=True`` rebuilds the
  topology as well.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.providers.shard_capacity import (
    ShardMemory, bytes_per_edge_default, compute_write_budget,
    shard_reserve_pct_default, estimate_margin_pct_default,
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


def _max_sources() -> int:
    return max(1, int(os.getenv("AGGREGATION_CAPACITY_MAX_SOURCES", "500")))


def _init_timeout_s() -> float:
    return float(os.getenv("FALKORDB_INIT_TIMEOUT", "3"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def container_memory_bytes_env() -> Optional[int]:
    """``FALKORDB_CONTAINER_MEMORY_BYTES``: the graph store container's
    memory limit, which the app cannot read for itself. Optional — it only
    prefills the limits dialog's container field. None when unset or not a
    positive integer."""
    raw = (os.getenv("FALKORDB_CONTAINER_MEMORY_BYTES") or "").strip()
    try:
        n = int(raw) if raw else 0
    except ValueError:
        return None
    return n if n > 0 else None


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

    def knob(key: str, env_value: int, lo: int, hi: int) -> Tuple[int, str]:
        """A fleet knob the pipeline reads with the same bounds
        (``resolve_effective_tuning``): the stored value clamped, else the env."""
        raw = stored.get(key)
        try:
            value = int(raw) if raw is not None else None
        except (TypeError, ValueError):
            value = None
        if value is None:
            return env_value, "default"
        return max(lo, min(hi, value)), "global"

    margin, margin_source = knob("estimate_margin_pct", estimate_margin_pct_default(), 0, 100)
    cube, cube_source = knob("max_cube_edges", _max_cube_edges(), 10_000, 50_000_000)
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
        estimate_margin_pct=margin,
        max_cube_edges=cube,
        estimate_margin_pct_source=margin_source,
        max_cube_edges_source=cube_source,
        static_cap=ceiling if ceiling else _max_materialized_edges(),
        budget_recheck_edges=_budget_recheck_edges(),
        container_memory_bytes=container_memory_bytes_env(),
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


async def reserved_on(endpoint: str) -> Tuple[int, int]:
    """(bytes, jobs) the running rebuilds hold in ``endpoint``'s reservation
    ledger right now — the same ledger the pipeline's budget subtracts.
    Raises on a bus failure; the sweep decides how to fail open."""
    from .admission import read_reservations
    from .redis_client import get_redis

    live = await read_reservations(get_redis(), endpoint)
    return sum(int(entry["bytes"]) for entry in live.values()), len(live)


def shard_row(
    reading: ShardMemory, limits: CapacityLimits, *, reserved: Tuple[int, int] = (0, 0),
) -> ShardCapacity:
    """One node under the fleet reserve — the pipeline's own budget
    arithmetic at the fleet bytes-per-edge, ``reserved`` (bytes, jobs)
    being what running rebuilds hold in the node's ledger."""
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
        reserved_bytes=reserved[0], reserved_count=reserved[1],
    )
    used_pct = None
    if reading.measurable:
        used_pct = round(int(reading.used or 0) * 100.0 / int(reading.maxmemory or 1), 1)
    # Three states, told apart by what is missing: a node that answered but
    # set no maxmemory can still be seen (used, graphs, limits) and merely
    # cannot be governed; one that did not answer shows nothing at all.
    state = (
        "measured" if reading.measurable
        else "ungoverned" if reading.used is not None
        else "unreachable"
    )
    # The coarse reason plus what the node actually said, when it said
    # anything: "could not be measured" alone sent an operator looking for a
    # capacity problem on a node that was simply not running.
    why_not = None
    if not reading.measurable:
        why_not = reading.why_not
        if reading.note:
            why_not = f"{why_not} ({reading.note})"
    return ShardCapacity(
        state=state,
        endpoint=reading.endpoint,
        used=reading.used,
        maxmemory=reading.maxmemory,
        policy=reading.policy,
        measurable=reading.measurable,
        why_not=why_not,
        used_pct=used_pct,
        reserve_pct=budget.reserve_pct,
        reserve_bytes=budget.reserve_bytes,
        available_bytes=budget.available_bytes,
        allowed_growth_edges=budget.allowed_growth_edges,
        governed_by=budget.governed_by,
        static_cap=budget.static_cap,
        reserved_bytes=budget.reserved_bytes,
        reserved_by_jobs=budget.reserved_by_jobs,
        query_mem_capacity=getattr(reading, "query_mem_capacity", None),
        timeout_max_ms=getattr(reading, "timeout_max_ms", None),
        timeout_default_ms=getattr(reading, "timeout_default_ms", None),
        thread_count=getattr(reading, "thread_count", None),
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
    reserved: Tuple[int, int] = (0, 0),
) -> FullDetailPreflight:
    """Would a FORCED full cube land today? The pipeline's own verdict on
    the last run's upper-bound estimate — growth over what the graph already
    holds, with the estimate margin — against the live reading, less what
    running rebuilds hold in the node's ledger (``reserved``)."""
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
        reserved_bytes=reserved[0], reserved_count=reserved[1],
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
    only).

    One query that reads ONE row per source: the newest completed job is
    found by a grouped subquery and joined back, so a source with thousands
    of completed runs costs the same as one with a single run — run_stats
    is a JSON blob, and reading every historical one would make this the
    slowest read on the page. Best-effort, never raises."""
    if not ds_ids:
        return {}
    J = AggregationJobORM
    try:
        newest = (
            select(J.data_source_id.label("ds_id"), func.max(J.updated_at).label("at"))
            .where(J.data_source_id.in_(ds_ids))
            .where(J.status == "completed")
            .group_by(J.data_source_id)
            .subquery()
        )
        rows = (await session.execute(
            select(J.data_source_id, J.run_stats)
            .join(newest, and_(J.data_source_id == newest.c.ds_id, J.updated_at == newest.c.at))
            .where(J.status == "completed")
        )).all()
    except Exception as exc:
        logger.warning("latest completed-run map failed: %s", exc)
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for ds_id, raw in rows:
        if ds_id not in out:                      # two runs sharing an instant: first wins
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


async def _reserved_map(endpoints: List[str]) -> Dict[str, Tuple[int, int]]:
    """What running rebuilds hold in each node's ledger — one bus round trip
    per node, and none at all once one has failed: a deployment without the
    bus must not pay a connect timeout per shard to learn that twice."""
    out: Dict[str, Tuple[int, int]] = {}
    ok = True
    for endpoint in endpoints:
        if not ok:
            out[endpoint] = (0, 0)
            continue
        try:
            async with asyncio.timeout(1.0):
                out[endpoint] = await reserved_on(endpoint)
        except Exception as exc:                          # noqa: BLE001 — fail open, once
            ok = False
            out[endpoint] = (0, 0)
            logger.info("capacity: reservation ledger unreadable (%s) — showing none", exc)
    return out


def _tell_providers(instance: Any, endpoint: str, reading: ShardMemory) -> None:
    """Tell the providers ALREADY built in this process what this node allows.

    Read-only by construction: ``instantiated`` is a dict lookup, so a page
    refresh never dials a store to hand it a limit it can learn on its own
    next time it connects.
    """
    from backend.app.providers.manager import provider_manager

    for ref in instance.providers:
        for provider in provider_manager.instantiated(ref.id):
            note = getattr(provider, "note_server_limits", None)
            if note is not None:
                note(
                    endpoint,
                    timeout_max_ms=reading.timeout_max_ms,
                    query_mem_capacity=reading.query_mem_capacity,
                    thread_count=reading.thread_count,
                    timeout_default_ms=reading.timeout_default_ms,
                )


async def _assemble(
    session: AsyncSession, *, ds_id: Optional[str] = None, fresh: bool = False,
) -> Optional[Dict[str, Any]]:
    from backend.app.services.graph_store.topology import (
        get_topology_snapshot, instance_for_provider, place, reading_of,
    )

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

    snapshot = await get_topology_snapshot(fresh=fresh)

    # Placement first — arithmetic over the snapshot, no I/O at all.
    placed: Dict[str, Tuple[str, str]] = {}               # ds_id → (endpoint, graph_key)
    unresolved_why: Dict[str, str] = {}
    for ds, _name in sources:
        instance = instance_for_provider(snapshot, str(getattr(ds, "provider_id", "") or ""))
        if instance is None:
            unresolved_why[ds.id] = (
                "no graph store instance is configured for this source's provider"
            )
            continue
        if not instance.reachable and not instance.shards:
            unresolved_why[ds.id] = instance.error or "the graph store could not be reached"
            continue
        key = graph_key_of(ds, None)
        if not key:
            unresolved_why[ds.id] = "this source has no graph name"
            continue
        shard, slot = place(instance, key)
        if shard is None:
            unresolved_why[ds.id] = (
                f"no shard of this graph store holds slot {slot}"
            )
            continue
        placed[ds.id] = (shard.master.endpoint, key)

    # One row per MASTER, in the snapshot's order — including the masters
    # with nothing on them and the ones that could not be read, which the
    # per-source sweep never had a way to mention.
    masters: List[Tuple[Any, Any]] = [
        (instance, shard.master)
        for instance in snapshot.instances
        for shard in instance.shards
    ]
    readings: Dict[str, ShardMemory] = {}
    for _instance, node in masters:
        readings.setdefault(node.endpoint, reading_of(node))
    reservations = await _reserved_map(list(readings))
    for instance, node in masters:
        _tell_providers(instance, node.endpoint, readings[node.endpoint])

    by_endpoint: Dict[str, List[CapacitySource]] = {}
    unresolved: List[UnresolvedSource] = []
    rows_by_id: Dict[str, CapacitySource] = {}
    for ds, provider_name in sources:
        if ds.id not in placed:
            unresolved.append(UnresolvedSource(
                data_source_id=ds.id, label=getattr(ds, "label", None),
                workspace_id=getattr(ds, "workspace_id", None),
                provider_id=getattr(ds, "provider_id", None),
                why_not=unresolved_why.get(ds.id, "this source could not be placed"),
            ))
            continue
        endpoint, key = placed[ds.id]
        row = source_row(
            ds, provider_name=provider_name, graph_key=key,
            state=states.get(ds.id, {}), stats=stats.get(ds.id, {}),
            failure=failures.get(ds.id, {}), limits=limits,
        )
        rows_by_id[ds.id] = row
        by_endpoint.setdefault(endpoint, []).append(row)

    shards: List[ShardCapacity] = []
    seen: set = set()
    for _instance, node in masters:
        if node.endpoint in seen:
            continue
        seen.add(node.endpoint)
        shard = shard_row(
            readings[node.endpoint], limits,
            reserved=reservations.get(node.endpoint, (0, 0)),
        )
        shard.sources = sorted(
            by_endpoint.get(node.endpoint, []), key=lambda s: -s.footprint_bytes,
        )
        shards.append(shard)
    return {
        "limits": limits, "shards": shards, "unresolved": unresolved,
        "sources_total": total, "truncated": truncated,
        "rows_by_id": rows_by_id, "readings": readings, "placed": placed,
        "reservations": reservations, "states": states, "stats": stats,
        "stale": snapshot.stale, "last_error": snapshot.last_error,
    }


_cache: Optional[Tuple[float, AggregationCapacityResponse]] = None
_lock: Optional[asyncio.Lock] = None
_lock_loop: Optional[asyncio.AbstractEventLoop] = None


def _build_lock() -> asyncio.Lock:
    """The build lock, bound to the loop that is actually running.

    A module-level ``asyncio.Lock`` binds itself to the first event loop
    that CONTENDS it, and raises ``RuntimeError`` for every loop after
    that. A server is one loop per process, so it never shows there —
    anywhere a second loop runs (a management command, a test that sweeps
    concurrently) it is a hard failure with nothing to do with what the
    caller asked for.
    """
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock = asyncio.Lock()
        _lock_loop = loop
    return _lock


def invalidate_fleet_cache() -> None:
    """Drop the cached fleet snapshot AND the topology reading under it: the
    next view measures again. Called after a limits change so no viewer sees
    the old figures for a TTL."""
    global _cache
    _cache = None
    from backend.app.services.graph_store.topology import invalidate_topology_cache

    invalidate_topology_cache()


def _with_age(snapshot: AggregationCapacityResponse, cached_at: float) -> AggregationCapacityResponse:
    return snapshot.model_copy(
        update={"cache_age_ms": int((time.monotonic() - cached_at) * 1000)},
    )


async def assemble_fleet_capacity(
    session: AsyncSession, *, fresh: bool = False,
) -> AggregationCapacityResponse:
    """Every master of every graph store, what fits, and the sources on each.
    Cached briefly so a page of viewers shares one assembly; never raises."""
    global _cache
    if not fresh and _cache is not None and time.monotonic() - _cache[0] < _ttl_s():
        return _with_age(_cache[1], _cache[0])
    async with _build_lock():
        if not fresh and _cache is not None and time.monotonic() - _cache[0] < _ttl_s():
            return _with_age(_cache[1], _cache[0])
        parts = await _assemble(session, fresh=fresh) or {}
        snapshot = AggregationCapacityResponse(
            limits=parts.get("limits") or effective_limits({}),
            shards=parts.get("shards") or [],
            unresolved=parts.get("unresolved") or [],
            sources_total=parts.get("sources_total") or 0,
            truncated=bool(parts.get("truncated")),
            measured_at=_now_iso(),
            stale=bool(parts.get("stale")),
            last_error=parts.get("last_error"),
        )
        _cache = (time.monotonic(), snapshot)
        return _with_age(snapshot, _cache[0])


async def assemble_source_capacity(
    session: AsyncSession, ds_id: str,
) -> Optional[SourceCapacityResponse]:
    """One source's footprint, its shard's headroom and the pre-flight fit
    for Full detail vs Auto — the same reading the next run will take.
    ``None`` when the source does not exist."""
    parts = await _assemble(session, ds_id=ds_id)
    if parts is None:
        return None
    limits: CapacityLimits = parts["limits"]
    row = parts["rows_by_id"].get(ds_id)
    reserved: Tuple[int, int] = (0, 0)
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
        reserved = parts["reservations"].get(endpoint, (0, 0))
        shard = shard_row(reading, limits, reserved=reserved)
    full = full_detail_preflight(
        reading, limits, edge_count=row.edge_count,
        estimate=row.last_cube_estimate, bytes_per_edge=row.bytes_per_edge,
        reserved=reserved,
    )
    return SourceCapacityResponse(
        source=row, shard=shard, limits=limits, full_detail=full,
        auto=auto_preflight(limits, full), measured_at=_now_iso(),
    )
