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


def _split_endpoint(endpoint: str) -> Tuple[str, int]:
    host, _, port = endpoint.rpartition(":")
    return host or endpoint, int(port or 6379)


async def _targets(snapshot: Any, endpoint: str, *, all_nodes: bool) -> List[str]:
    """The endpoints to SET on: this node, or every node of its instance
    (masters first) when asked.

    Replicas included on purpose: a promoted replica must already carry the
    limit, or the change quietly un-applies itself the next time the cluster
    fails over — which is exactly when the store is under stress.
    """
    from backend.app.services.graph_store.topology import instance_of_endpoint, nodes_of

    instance = instance_of_endpoint(snapshot, endpoint)
    if instance is None:
        return []
    if not all_nodes:
        return [endpoint]
    return [node.endpoint for node in nodes_of(instance)]


class _Direct:
    """``read_shard_memory`` reads ``db.connection``; a one-node client IS
    the connection, so this is the whole adapter."""

    def __init__(self, client: Any) -> None:
        self.connection = client


async def apply_graph_store_limits(
    session: AsyncSession, endpoint: str, patch: GraphStoreLimitsPatch,
) -> GraphStoreLimitsResponse:
    """Set ``patch`` on the node ``endpoint`` (``host:port``) and verify it.
    Raises :class:`GraphStoreEndpointNotFound` (404) when the topology has no
    such node, :class:`GraphStoreLimitsError` (422) when the change is
    refused or did not land."""
    from backend.app.providers.manager import provider_manager
    from backend.app.services.graph_store import discovery
    from backend.app.services.graph_store.topology import (
        conn_config_of, get_topology_snapshot, instance_of_endpoint,
    )
    from .capacity import (
        _now_iso, _stored_tuning, effective_limits, invalidate_fleet_cache, shard_row,
    )

    snapshot = await get_topology_snapshot()
    instance = instance_of_endpoint(snapshot, endpoint)
    cfg = conn_config_of(instance.id) if instance is not None else None
    if instance is None or cfg is None:
        known = sorted(
            node.endpoint
            for inst in snapshot.instances
            for shard in inst.shards
            for node in (shard.master, *shard.replicas)
        )
        raise GraphStoreEndpointNotFound(
            f"No graph store node {endpoint!r} is in the topology"
            + (f" (known: {', '.join(known)})" if known else "")
            + ". Open Admin → Graph store to see the nodes this deployment has."
        )
    from backend.app.providers.falkordb_connection import connect_verify_budget

    # A limits change is a write with a person waiting: the same window a
    # node read gets, extended for a provider configured for a slow hop.
    timeout = connect_verify_budget(cfg, 3.0)

    # One short-lived client per node, built from the instance's own
    # settings: a node with no graph on it is as adjustable as one with a
    # hundred, and a replica is reachable even though nothing writes to it.
    async def _read(target: str) -> ShardMemory:
        host, port = _split_endpoint(target)
        client = discovery.node_client(cfg, host, port, socket_timeout=timeout)
        try:
            return await read_shard_memory(
                _Direct(client), mode=None, graph_key="", timeout=timeout,
            )
        finally:
            await discovery._aclose(client)

    current = await _read(endpoint)
    if current.source != "measured":
        raise GraphStoreLimitsError(
            f"{endpoint} could not be read right now ({current.note or 'no reading'}); "
            f"nothing was changed. Try again once the node answers."
        )
    validated = validate_limits(current, patch)
    previous = {name: _reading_value(current, name) for name, _ in validated.pairs}

    targets = await _targets(snapshot, endpoint, all_nodes=patch.apply_to_all_nodes)
    applied_to: List[str] = []
    for target_endpoint in targets:
        host, port = _split_endpoint(target_endpoint)
        client = discovery.node_client(cfg, host, port, socket_timeout=timeout)
        try:
            await set_graph_config(client, None, validated.pairs)
        except Exception as exc:                          # noqa: BLE001 — reported, with what already landed
            raise GraphStoreLimitsError(
                f"GRAPH.CONFIG SET failed on {target_endpoint}: {exc}. "
                + (f"Already applied on {', '.join(applied_to)}." if applied_to else "Nothing was changed.")
            ) from exc
        finally:
            await discovery._aclose(client)
        applied_to.append(target_endpoint)

    after = await _read(endpoint)
    for name, value in validated.pairs:
        seen = _reading_value(after, name)
        if seen != value:
            raise GraphStoreLimitsError(
                f"{name} was set to {value} on {endpoint} but reads back as "
                f"{seen if seen is not None else 'unlimited or unreadable'}; check the node."
            )
    for ref in instance.providers:
        for held in provider_manager.instantiated(ref.id):
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
