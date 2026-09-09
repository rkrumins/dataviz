"""The graph store's own per-query limits, adjusted from the UI.

Two limits on the store bound every rebuild and every canvas read, and until
now both lived only in the deployment: ``TIMEOUT_MAX`` (the per-query time
cap every timeout knob is clamped to) and ``QUERY_MEM_CAPACITY`` (the
per-query memory ceiling the pressure ladder narrows against — and the one
thing that makes a single row terminal). Both accept ``GRAPH.CONFIG SET`` at
runtime, so an administrator can change them from Infrastructure, guarded
by the same sizing rule the deployment guide asks for by hand.

What a change does, in order — and every step that can refuse, refuses
BEFORE anything is set:

1. A fresh capacity sweep places the endpoint: the node must be one the
   sweep knows (a graph with rollups lives there), through the provider
   client the rollups already write with — no second connection, no
   separate credentials.
2. The node is read: its memory, its ceiling, its cap, its default and its
   thread count.
3. The change is validated against that reading (:func:`validate_limits`):
   a cap is never set below the node's ``TIMEOUT_DEFAULT``; raising the
   ceiling needs the container's memory limit (the app cannot read it) and
   is refused when the formula's need exceeds it, with the shortfall;
   ``0`` (unlimited) is refused; lowering needs nothing.
4. ``GRAPH.CONFIG SET`` on the owning node (or every primary in cluster
   mode when asked), then a fresh read verifies each value landed.
5. Every provider on the node is told, so its per-query clamp follows the
   new cap on the next query; the fleet snapshot is dropped so the next
   view shows the new figures; the change is logged with its actor.

A runtime SET lasts until the server restarts. The response carries the
``FALKORDB_ARGS`` fragment that makes it permanent — handing it over is the
feature, not a footnote.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.providers.shard_capacity import (
    ShardMemory, _owner, container_memory_needed, human_bytes, read_shard_memory,
    set_graph_config,
)
from .schemas import GraphStoreLimitsPatch, GraphStoreLimitsResponse

logger = logging.getLogger(__name__)

#: The planning figure when the node does not report its THREAD_COUNT —
#: the shipped FALKORDB_ARGS value.
THREAD_COUNT_ASSUMED = 4


class GraphStoreLimitsError(ValueError):
    """The change was refused, with the numbers; nothing was set (or the
    message names what was, when a multi-node apply stopped part way)."""


class GraphStoreEndpointNotFound(LookupError):
    """No graph with rollups lives on that node, so there is no client to
    reach it through."""


@dataclass(frozen=True)
class ValidatedLimits:
    pairs: List[Tuple[str, int]]            # in the order to SET
    container_needed_bytes: Optional[int]   # at the resulting ceiling
    concurrent_queries: Optional[int]
    thread_count_assumed: bool


def _ms(ms: int) -> str:
    return f"{ms / 1000:g} s"


def validate_limits(current: ShardMemory, patch: GraphStoreLimitsPatch) -> ValidatedLimits:
    """Pure. What ``patch`` would set on a node that reads as ``current``,
    or :class:`GraphStoreLimitsError` with every number a person needs."""
    pairs: List[Tuple[str, int]] = []
    if patch.timeout_max_ms is not None:
        default_ms = current.timeout_default_ms
        if default_ms and patch.timeout_max_ms < default_ms:
            raise GraphStoreLimitsError(
                f"TIMEOUT_MAX {_ms(patch.timeout_max_ms)} would be below the node's "
                f"TIMEOUT_DEFAULT {_ms(default_ms)}; the store refuses that. Choose at "
                f"least {_ms(default_ms)}."
            )
        pairs.append(("TIMEOUT_MAX", int(patch.timeout_max_ms)))

    needed: Optional[int] = None
    concurrent: Optional[int] = None
    assumed = False
    resulting_cap = patch.query_mem_capacity if patch.query_mem_capacity is not None else current.query_mem_capacity
    threads = current.thread_count
    if threads is None:
        assumed = True
        threads = THREAD_COUNT_ASSUMED
    concurrent = min(int(patch.concurrent_queries or threads), int(threads))
    maxmemory = int(current.maxmemory or 0)
    if resulting_cap and maxmemory > 0:
        needed = container_memory_needed(maxmemory, concurrent, int(resulting_cap))

    if patch.query_mem_capacity is not None:
        new_cap = int(patch.query_mem_capacity)
        if new_cap <= 0:
            raise GraphStoreLimitsError(
                "QUERY_MEM_CAPACITY 0 means unlimited: one query could take the whole "
                "container and the node would be OOM-killed instead of refusing the "
                "query. Set a ceiling instead."
            )
        raising = current.query_mem_capacity is None or new_cap > int(current.query_mem_capacity)
        if raising:
            if patch.container_memory_bytes is None:
                raise GraphStoreLimitsError(
                    f"Raising the per-query memory ceiling to {human_bytes(new_cap)} needs "
                    f"the graph store container's memory limit (containerMemoryBytes): the "
                    f"application cannot read it, and a ceiling the container cannot back "
                    f"turns a refused query into an OOM-killed node. Enter the container "
                    f"limit, or set FALKORDB_CONTAINER_MEMORY_BYTES in the deployment."
                )
            if maxmemory <= 0:
                raise GraphStoreLimitsError(
                    f"{current.endpoint} reports no maxmemory, so the sizing formula "
                    f"(1.25 × maxmemory + queries × 1.3 × ceiling + overhead) cannot be "
                    f"applied. Set maxmemory on the node first."
                )
            assert needed is not None
            container = int(patch.container_memory_bytes)
            if needed > container:
                raise GraphStoreLimitsError(
                    f"A ceiling of {human_bytes(new_cap)} needs a container of at least "
                    f"{human_bytes(needed)}: 1.25 × {human_bytes(maxmemory)} maxmemory + "
                    f"{concurrent} concurrent {'query' if concurrent == 1 else 'queries'} × 1.3 × "
                    f"{human_bytes(new_cap)} + overhead"
                    f"{' (THREAD_COUNT not reported; assumed 4)' if assumed else ''}. The "
                    f"container has {human_bytes(container)} — short by "
                    f"{human_bytes(needed - container)}. Raise the container limit first, "
                    f"lower maxmemory on a fresh node, or choose a smaller ceiling."
                )
        pairs.append(("QUERY_MEM_CAPACITY", new_cap))

    if patch.effects_threshold_us is not None:
        # How this node replicates. Below the threshold FalkorDB ships a
        # write to its replicas by having them RE-RUN it, on their main
        # thread and without a timeout; a rollup batch is thousands of cheap
        # MERGEs and sits well below the 300 µs default, which is what makes
        # a large rebuild stall a shard's replicas. 0 always ships the
        # compact change log instead. Nothing to guard against: it costs no
        # memory and cannot exceed a container.
        pairs.append(("EFFECTS_THRESHOLD", int(patch.effects_threshold_us)))

    if not pairs:
        raise GraphStoreLimitsError(
            "Give at least one limit: timeoutMaxMs, queryMemCapacity or "
            "effectsThresholdUs.")
    return ValidatedLimits(pairs, needed, concurrent, assumed)


def args_fragment(pairs: List[Tuple[str, int]]) -> str:
    return " ".join(f"{name} {value}" for name, value in pairs)


def _reading_value(reading: ShardMemory, name: str) -> Optional[int]:
    return {
        "TIMEOUT_MAX": reading.timeout_max_ms,
        "QUERY_MEM_CAPACITY": reading.query_mem_capacity,
        "EFFECTS_THRESHOLD": reading.effects_threshold_us,
    }[name]


def _node_label(node: Any) -> str:
    return f"{getattr(node, 'host', '?')}:{getattr(node, 'port', '?')}"


async def _targets(conn: Any, mode: Optional[str], graph_key: str, *, all_nodes: bool) -> List[Tuple[str, Any]]:
    """``[(endpoint, node)]`` to SET on: the owning node, or every primary
    in cluster mode when asked. ``node`` is None outside cluster mode."""
    if mode != "cluster":
        endpoint, node = await _owner(conn, mode, graph_key)
        return [(endpoint, node)]
    if all_nodes:
        primaries = conn.get_primaries() if hasattr(conn, "get_primaries") else []
        if primaries:
            return [(_node_label(n), n) for n in primaries]
    endpoint, node = await _owner(conn, mode, graph_key)
    return [(endpoint, node)]


async def apply_graph_store_limits(
    session: AsyncSession, registry: Any, endpoint: str, patch: GraphStoreLimitsPatch,
) -> GraphStoreLimitsResponse:
    """Set ``patch`` on the node ``endpoint`` (``host:port``) and verify it.
    Raises :class:`GraphStoreEndpointNotFound` (404) when the capacity
    sweep knows no such node, :class:`GraphStoreLimitsError` (422) when the
    change is refused or did not land."""
    from .capacity import (
        _assemble, _init_timeout_s, _now_iso, _stored_tuning, client_of, effective_limits,
        invalidate_fleet_cache, mode_of, shard_row,
    )

    parts = await _assemble(session, registry) or {}
    holders: List[Tuple[Any, str]] = (parts.get("providers_by_endpoint") or {}).get(endpoint) or []
    if not holders:
        known = sorted((parts.get("providers_by_endpoint") or {}).keys())
        raise GraphStoreEndpointNotFound(
            f"No graph store node {endpoint!r} is known to the capacity sweep"
            + (f" (known: {', '.join(known)})" if known else "")
            + ". Only a node that holds a graph with rollups can be adjusted here."
        )
    provider, graph_key = holders[0]
    db = client_of(provider)
    mode = mode_of(provider)
    timeout = _init_timeout_s()

    current = await read_shard_memory(db, mode=mode, graph_key=graph_key, timeout=timeout)
    if current.source != "measured":
        raise GraphStoreLimitsError(
            f"{endpoint} could not be read right now ({current.note or 'no reading'}); "
            f"nothing was changed. Try again once the node answers."
        )
    validated = validate_limits(current, patch)
    previous = {name: _reading_value(current, name) for name, _ in validated.pairs}

    conn = getattr(db, "connection", None)
    if conn is None:
        raise GraphStoreLimitsError(f"The provider for {endpoint} holds no client; nothing was changed.")
    targets = await _targets(conn, mode, graph_key, all_nodes=patch.apply_to_all_nodes)
    applied_to: List[str] = []
    for target_endpoint, node in targets:
        try:
            await set_graph_config(conn, node, validated.pairs)
        except Exception as exc:                          # noqa: BLE001 — reported, with what already landed
            raise GraphStoreLimitsError(
                f"GRAPH.CONFIG SET failed on {target_endpoint}: {exc}. "
                + (f"Already applied on {', '.join(applied_to)}." if applied_to else "Nothing was changed.")
            ) from exc
        applied_to.append(target_endpoint)

    after = await read_shard_memory(db, mode=mode, graph_key=graph_key, timeout=timeout)
    for name, value in validated.pairs:
        seen = _reading_value(after, name)
        if seen != value:
            raise GraphStoreLimitsError(
                f"{name} was set to {value} on {endpoint} but reads back as "
                f"{seen if seen is not None else 'unlimited or unreadable'}; check the node."
            )
    for held, _ in holders:
        note = getattr(held, "note_server_limits", None)
        if note is not None:
            note(
                endpoint,
                timeout_max_ms=after.timeout_max_ms,
                query_mem_capacity=after.query_mem_capacity,
                thread_count=after.thread_count,
                timeout_default_ms=after.timeout_default_ms,
            )
    invalidate_fleet_cache()
    fragment = args_fragment(validated.pairs)
    logger.info(
        "graph store limits on %s set by %s: %s (previously %s; applied to %s). Runtime only "
        "— add to FALKORDB_ARGS to keep it across a restart.",
        endpoint, patch.actor or "unknown actor", fragment,
        " ".join(f"{k} {v if v is not None else 'unlimited'}" for k, v in previous.items()),
        ", ".join(applied_to),
    )
    return GraphStoreLimitsResponse(
        shard=shard_row(after, effective_limits(await _stored_tuning(session))),
        previous=previous,
        applied={name: value for name, value in validated.pairs},
        applied_to=applied_to,
        args_fragment=fragment,
        container_needed_bytes=validated.container_needed_bytes,
        concurrent_queries=validated.concurrent_queries,
        thread_count_assumed=validated.thread_count_assumed,
        measured_at=_now_iso(),
    )
