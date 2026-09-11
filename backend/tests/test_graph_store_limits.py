"""The graph store's own per-query limits, adjusted from the UI.

``TIMEOUT_MAX`` and ``QUERY_MEM_CAPACITY`` accept ``GRAPH.CONFIG SET`` at
runtime. These tests pin the contract of doing that from Infrastructure:
the node is read first and every refusal comes before anything is set; a
cap never goes below the node's default; raising the memory ceiling needs
the container limit and is refused with the shortfall when the deployment
guide's formula says the container cannot back it; what was set is read
back and verified; every provider already built on the node learns the new
cap; the fleet snapshot is dropped; the change is logged with its actor; and
the route is system-admin only, with the actor taken from the session, never
the body.

The node is now located in the graph store topology and reached over a
short-lived one-node client built from its instance's own settings — so a
node that holds no graph with rollups (and a replica, which nothing writes
to) is as adjustable as the busiest master. It used to have to be a node
some provider's rollups happened to live on.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import types

import pytest
from pydantic import ValidationError

from backend.app.providers import shard_capacity as sc
from backend.app.services.aggregation import capacity as cap
from backend.app.services.aggregation import graph_store_limits as gsl
from backend.app.services.aggregation.schemas import GraphStoreLimitsPatch

GB = 2 ** 30
MB = 2 ** 20
ENDPOINT = "falkor:6379"


def _run(coro):
    return asyncio.run(coro)


class _Node:
    def __init__(self, host, port=6379):
        self.host, self.port = host, port


class _Conn:
    """One node: INFO memory, ``GRAPH.CONFIG GET *`` from a mutable config,
    a SET that changes it (unless ``sticky``), everything recorded."""

    def __init__(self, *, used=10 * GB, maxmemory=40 * GB, config=None, sticky=False):
        self.config = dict(config if config is not None else {
            "TIMEOUT_MAX": 180_000, "TIMEOUT_DEFAULT": 30_000, "THREAD_COUNT": 4,
            "QUERY_MEM_CAPACITY": 512 * MB,
        })
        self.used, self.maxmemory, self.sticky = used, maxmemory, sticky
        self.sets = []
        self.connection_pool = types.SimpleNamespace(
            connection_kwargs={"host": "falkor", "port": 6379},
        )

    async def info(self, *sections):
        return {
            "used_memory": self.used, "maxmemory": self.maxmemory,
            "maxmemory_policy": "noeviction", "run_id": "r1", "uptime_in_seconds": 100,
        }

    async def execute_command(self, *args, **kw):
        if args == ("GRAPH.CONFIG", "GET", "*"):
            return [[k, v] for k, v in self.config.items()]
        if args[:2] == ("GRAPH.CONFIG", "SET"):
            self.sets.append((args[2], args[3], kw.get("target_nodes")))
            if not self.sticky:
                self.config[args[2]] = args[3]
            return "OK"
        raise AssertionError(args)


_CFG = types.SimpleNamespace(
    mode="cluster", probe_deadline_s=None, socket_connect_timeout=None,
)


class _Provider:
    """A provider already built in this process — it may be TOLD the new cap
    but is never asked to carry the change."""

    def __init__(self):
        self.noted = []

    def note_server_limits(self, endpoint, **limits):
        self.noted.append((endpoint, limits))


def _node(endpoint, *, role="master"):
    from backend.app.services.graph_store.schemas import GraphStoreNode

    return GraphStoreNode(endpoint=endpoint, role=role)


def _instance(endpoints, *, providers=("p1",)):
    """One instance whose masters are ``endpoints`` (an endpoint given as
    ``(master, replica)`` gets that replica)."""
    from backend.app.services.graph_store.schemas import (
        GraphStoreInstance, GraphStoreShard, ProviderRef,
    )

    shards = []
    for i, entry in enumerate(endpoints):
        master, replicas = (entry, ()) if isinstance(entry, str) else entry
        shards.append(GraphStoreShard(
            index=i, master=_node(master),
            replicas=[_node(r, role="replica") for r in replicas],
        ))
    return GraphStoreInstance(
        id="i1", mode="cluster", shards=shards,
        providers=[ProviderRef(id=pid, name="Falkor") for pid in providers],
    )


def _wire(monkeypatch, clients, *, endpoints=None, providers=()):
    """The topology, reduced to what a limits change needs: which instance
    holds a node, how to reach it, and one client per node."""
    from backend.app.services.graph_store import discovery
    import backend.app.services.graph_store.topology as topo
    from backend.app.services.graph_store.schemas import GraphStoreTopologyResponse
    from backend.app.providers.manager import provider_manager

    instance = _instance(endpoints or list(clients))
    snapshot = GraphStoreTopologyResponse(instances=[instance], measuredAt="t")
    closed = []

    async def get_snapshot(*, fresh=False):
        return snapshot

    def client_for(cfg, host, port, *, socket_timeout):
        return clients[f"{host}:{port}"]

    async def _closer(client):
        closed.append(client)

    async def stored(session):
        return {}

    # Each fake answers as the node it is dialled as — the reading names
    # its own endpoint, like a real client does.
    for endpoint, client in clients.items():
        host, _, port = endpoint.rpartition(":")
        client.connection_pool = types.SimpleNamespace(
            connection_kwargs={"host": host, "port": int(port)},
        )

    monkeypatch.setattr(topo, "get_topology_snapshot", get_snapshot)
    monkeypatch.setattr(topo, "conn_config_of", lambda iid: _CFG)
    monkeypatch.setattr(discovery, "node_client", client_for)
    monkeypatch.setattr(discovery, "_aclose", _closer)
    monkeypatch.setattr(cap, "_stored_tuning", stored)
    monkeypatch.setattr(
        provider_manager, "instantiated",
        lambda pid: list(providers) if pid == "p1" else [],
    )
    cap._cache = (0.0, "a cached snapshot")
    return closed


def _patch(**kw):
    return GraphStoreLimitsPatch(**kw)


def _apply(endpoint, patch):
    return _run(gsl.apply_graph_store_limits(object(), endpoint, patch))


# ── the change ───────────────────────────────────────────────────────


def test_raising_the_time_cap_sets_verifies_tells_providers_and_drops_the_cache(monkeypatch, caplog):
    conn = _Conn()
    p = _Provider()
    _wire(monkeypatch, {ENDPOINT: conn}, providers=[p])
    with caplog.at_level(logging.INFO, logger="backend.app.services.aggregation.graph_store_limits"):
        out = _apply(ENDPOINT, _patch(timeoutMaxMs=300_000, actor="ops@example.com"))
    assert conn.sets == [("TIMEOUT_MAX", 300_000, None)]
    assert out.previous == {"TIMEOUT_MAX": 180_000} and out.applied == {"TIMEOUT_MAX": 300_000}
    assert out.applied_to == [ENDPOINT] and out.args_fragment == "TIMEOUT_MAX 300000"
    assert out.shard.timeout_max_ms == 300_000 and out.shard.thread_count == 4 and out.shard.measurable
    assert p.noted[-1] == (ENDPOINT, {
        "timeout_max_ms": 300_000, "query_mem_capacity": 512 * MB, "thread_count": 4, "timeout_default_ms": 30_000,
    })
    assert cap._cache is None
    assert "ops@example.com" in caplog.text and "TIMEOUT_MAX 300000" in caplog.text
    # The container need is reported for the resulting ceiling, at THREAD_COUNT.
    assert out.container_needed_bytes == sc.container_memory_needed(40 * GB, 4, 512 * MB)
    assert out.concurrent_queries == 4 and out.thread_count_assumed is False


def test_a_cap_below_the_nodes_default_is_refused_before_anything_is_set(monkeypatch):
    conn = _Conn()
    _wire(monkeypatch, {ENDPOINT: conn})
    with pytest.raises(gsl.GraphStoreLimitsError) as exc:
        _apply(ENDPOINT, _patch(timeoutMaxMs=20_000))
    assert "20 s" in str(exc.value) and "30 s" in str(exc.value)
    assert conn.sets == []


def test_raising_the_ceiling_needs_the_container_limit_and_refuses_a_shortfall_with_the_numbers(monkeypatch):
    conn = _Conn(maxmemory=6 * GB)
    _wire(monkeypatch, {ENDPOINT: conn})
    with pytest.raises(gsl.GraphStoreLimitsError, match="containerMemoryBytes"):
        _apply(ENDPOINT, _patch(queryMemCapacity=GB))
    assert conn.sets == []
    # 1.25 × 6 GiB + 4 × 1.3 × 1 GiB + 256 MiB ≈ 12.95 GiB does not fit 11 GiB …
    with pytest.raises(gsl.GraphStoreLimitsError) as exc:
        _apply(ENDPOINT, _patch(queryMemCapacity=GB, containerMemoryBytes=11 * GB))
    msg = str(exc.value)
    assert "short by" in msg and "4 concurrent queries" in msg and "11.0 GB" in msg and "6.0 GB maxmemory" in msg
    assert conn.sets == []
    # … while planning for 2 concurrent queries (the guide's figure, ≈ 10.35 GiB) does.
    out = _apply(ENDPOINT, _patch(queryMemCapacity=GB, containerMemoryBytes=11 * GB, concurrentQueries=2))
    assert conn.sets == [("QUERY_MEM_CAPACITY", GB, None)]
    assert out.concurrent_queries == 2
    assert out.container_needed_bytes == sc.container_memory_needed(6 * GB, 2, GB)
    assert out.args_fragment == "QUERY_MEM_CAPACITY 1073741824" and out.previous == {"QUERY_MEM_CAPACITY": 512 * MB}


def test_concurrency_is_capped_at_the_thread_count_and_an_unreported_thread_count_is_assumed(monkeypatch):
    conn = _Conn(maxmemory=6 * GB, config={"TIMEOUT_MAX": 180_000, "QUERY_MEM_CAPACITY": 256 * MB})
    _wire(monkeypatch, {ENDPOINT: conn})
    out = _apply(ENDPOINT, _patch(queryMemCapacity=512 * MB, containerMemoryBytes=64 * GB, concurrentQueries=16))
    assert out.thread_count_assumed is True and out.concurrent_queries == gsl.THREAD_COUNT_ASSUMED
    assert out.container_needed_bytes == sc.container_memory_needed(
        6 * GB, gsl.THREAD_COUNT_ASSUMED, 512 * MB)
    with pytest.raises(gsl.GraphStoreLimitsError,
                       match=f"assumed {gsl.THREAD_COUNT_ASSUMED}"):
        _apply(ENDPOINT, _patch(queryMemCapacity=8 * GB, containerMemoryBytes=10 * GB))


def test_a_node_without_maxmemory_cannot_have_its_ceiling_raised(monkeypatch):
    conn = _Conn(maxmemory=0)
    _wire(monkeypatch, {ENDPOINT: conn})
    with pytest.raises(gsl.GraphStoreLimitsError, match="no maxmemory"):
        _apply(ENDPOINT, _patch(queryMemCapacity=GB, containerMemoryBytes=64 * GB))
    assert conn.sets == []
    # Lowering, and the time cap, still work there.
    out = _apply(ENDPOINT, _patch(queryMemCapacity=256 * MB, timeoutMaxMs=240_000))
    assert conn.sets == [("TIMEOUT_MAX", 240_000, None), ("QUERY_MEM_CAPACITY", 256 * MB, None)]
    assert out.container_needed_bytes is None and out.args_fragment == "TIMEOUT_MAX 240000 QUERY_MEM_CAPACITY 268435456"


def test_lowering_the_ceiling_needs_nothing_and_zero_is_refused(monkeypatch):
    conn = _Conn()
    _wire(monkeypatch, {ENDPOINT: conn})
    out = _apply(ENDPOINT, _patch(queryMemCapacity=256 * MB))
    assert conn.sets == [("QUERY_MEM_CAPACITY", 256 * MB, None)]
    assert out.previous == {"QUERY_MEM_CAPACITY": 512 * MB}
    with pytest.raises(ValidationError):                    # the schema's bound
        _patch(queryMemCapacity=0)
    # And the validator refuses it for a caller that bypassed the schema.
    reading = sc.ShardMemory("e", 1, 2, "p", 0.0, "measured", None, 512 * MB, 180_000, 30_000, 4)
    raw = GraphStoreLimitsPatch.model_construct(
        timeout_max_ms=None, query_mem_capacity=0, container_memory_bytes=None,
        concurrent_queries=None, apply_to_all_nodes=False, actor=None,
    )
    with pytest.raises(gsl.GraphStoreLimitsError, match="unlimited"):
        gsl.validate_limits(reading, raw)


def test_an_empty_patch_is_refused_by_the_schema():
    with pytest.raises(ValidationError, match="at least one limit"):
        _patch(actor="x")
    with pytest.raises(ValidationError):
        _patch(timeoutMaxMs=500)                            # under 1 s


def test_an_unknown_node_is_not_found_and_an_unreadable_one_changes_nothing(monkeypatch):
    _wire(monkeypatch, {ENDPOINT: _Conn()})
    with pytest.raises(gsl.GraphStoreEndpointNotFound, match="known: falkor:6379"):
        _apply("10.9.9.9:6379", _patch(timeoutMaxMs=300_000))

    class _Dead(_Conn):
        async def info(self, *sections):
            raise ConnectionError("refused")

    dead = _Dead()
    _wire(monkeypatch, {ENDPOINT: dead})
    with pytest.raises(gsl.GraphStoreLimitsError, match="could not be read"):
        _apply(ENDPOINT, _patch(timeoutMaxMs=300_000))
    assert dead.sets == []


def test_a_value_that_does_not_read_back_is_an_error(monkeypatch):
    conn = _Conn(sticky=True)
    _wire(monkeypatch, {ENDPOINT: conn})
    with pytest.raises(gsl.GraphStoreLimitsError, match="reads back as 180000"):
        _apply(ENDPOINT, _patch(timeoutMaxMs=300_000))
    assert cap._cache is not None                           # nothing verified, nothing dropped


def test_a_change_reaches_one_node_or_every_node_of_its_instance(monkeypatch):
    """Replicas included when all nodes are asked: a promoted replica that
    never got the limit un-applies the change at the worst possible moment,
    and the old path could not reach a replica at all."""
    m1, m2, r1 = _Conn(), _Conn(), _Conn()
    clients = {"10.0.0.1:6379": m1, "10.0.0.2:6379": m2, "10.0.0.9:6379": r1}
    closed = _wire(monkeypatch, clients,
                   endpoints=[("10.0.0.1:6379", ("10.0.0.9:6379",)), "10.0.0.2:6379"])

    out = _apply("10.0.0.1:6379", _patch(timeoutMaxMs=300_000))
    assert [(n, v, t) for n, v, t in m1.sets] == [("TIMEOUT_MAX", 300_000, None)]
    assert m2.sets == [] and r1.sets == []
    assert out.applied_to == ["10.0.0.1:6379"] and out.shard.endpoint == "10.0.0.1:6379"

    m1.sets.clear()
    out = _apply("10.0.0.1:6379", _patch(timeoutMaxMs=240_000, applyToAllNodes=True))
    assert out.applied_to == ["10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.9:6379"]
    assert len(m1.sets) == 1 and len(m2.sets) == 1 and len(r1.sets) == 1
    # Every one-node client is closed behind it — a page of changes must not
    # leak a socket per node.
    assert len(closed) >= 5


def test_a_node_with_no_rollups_on_it_is_still_adjustable(monkeypatch):
    """The old rule — "only a node that holds a graph with rollups" — meant
    a fresh shard, or one whose sources had not been aggregated yet, could
    not be prepared before it took traffic."""
    empty = _Conn()
    _wire(monkeypatch, {"10.0.0.5:6379": empty})
    out = _apply("10.0.0.5:6379", _patch(timeoutMaxMs=300_000))
    assert out.applied_to == ["10.0.0.5:6379"] and len(empty.sets) == 1


def test_a_refused_set_names_what_already_landed(monkeypatch):
    m1, m2 = _Conn(), _Conn()

    async def refuse(*args, **kw):
        raise RuntimeError("ERR read-only replica")

    m2.execute_command = refuse
    _wire(monkeypatch, {"10.0.0.1:6379": m1, "10.0.0.2:6379": m2})
    with pytest.raises(gsl.GraphStoreLimitsError) as exc:
        _apply("10.0.0.1:6379", _patch(timeoutMaxMs=300_000, applyToAllNodes=True))
    assert "10.0.0.2:6379" in str(exc.value) and "Already applied on 10.0.0.1:6379" in str(exc.value)


def test_a_partly_applied_change_still_drops_the_snapshot(monkeypatch):
    """What DID land changed what a sweep would read. Invalidating only on
    success leaves the page showing the old limits for the nodes that took
    the change, so an operator re-reads, sees no effect, and applies it
    again."""
    from backend.app.services.aggregation import capacity

    dropped = {"n": 0}
    monkeypatch.setattr(capacity, "invalidate_fleet_cache",
                        lambda: dropped.__setitem__("n", dropped["n"] + 1))

    m1, m2 = _Conn(), _Conn()

    async def refuse(*args, **kw):
        raise RuntimeError("ERR read-only replica")

    m2.execute_command = refuse
    _wire(monkeypatch, {"10.0.0.1:6379": m1, "10.0.0.2:6379": m2})
    with pytest.raises(gsl.GraphStoreLimitsError):
        _apply("10.0.0.1:6379", _patch(timeoutMaxMs=300_000, applyToAllNodes=True))
    assert len(m1.sets) == 1                          # the first node took it
    assert dropped["n"] == 1                          # …so the snapshot went


# ── the routes ───────────────────────────────────────────────────────


def _dep_calls(dependant):
    out = [dependant.call]
    for d in dependant.dependencies:
        out += _dep_calls(d)
    return out


def test_the_web_route_is_system_admin_only_and_takes_the_actor_from_the_session(monkeypatch):
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    route = next(
        r for r in agg_mod.router.routes
        if r.path == "/graph-store/{endpoint}/limits" and "PATCH" in r.methods
    )
    assert agg_mod._REQUIRE_SYSTEM_ADMIN in _dep_calls(route.dependant)

    seen = {}

    async def applied(session, endpoint, patch):
        seen.update(endpoint=endpoint, actor=patch.actor)
        return "done"

    monkeypatch.setattr(gsl, "apply_graph_store_limits", applied)
    # Proxy mode makes no difference: the change goes out from the web tier,
    # which has the topology and the instance's own settings.
    monkeypatch.setattr(agg_mod, "_PROXY_ENABLED", True)
    out = asyncio.run(agg_mod.set_graph_store_limits(
        "10.0.0.1:6379", _patch(timeoutMaxMs=300_000, actor="spoofed"),
        admin=types.SimpleNamespace(id="admin-1"), session=None,
    ))
    assert out == "done"
    assert seen == {"endpoint": "10.0.0.1:6379", "actor": "admin-1"}


def test_the_web_route_maps_refusals_to_422_and_unknown_nodes_to_404(monkeypatch):
    from fastapi import HTTPException
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    async def refuse(session, endpoint, patch):
        raise gsl.GraphStoreLimitsError("short by 1.0 GB")

    monkeypatch.setattr(gsl, "apply_graph_store_limits", refuse)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(agg_mod.set_graph_store_limits(
            "n1", _patch(queryMemCapacity=GB), admin=types.SimpleNamespace(id="a"), session=None,
        ))
    assert exc.value.status_code == 422 and "short by" in exc.value.detail

    async def missing(session, endpoint, patch):
        raise gsl.GraphStoreEndpointNotFound("no such node")

    monkeypatch.setattr(gsl, "apply_graph_store_limits", missing)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(agg_mod.set_graph_store_limits(
            "n1", _patch(queryMemCapacity=GB), admin=types.SimpleNamespace(id="a"), session=None,
        ))
    assert exc.value.status_code == 404


def test_the_capacity_routes_are_served_in_process_in_every_mode(monkeypatch):
    """They read the topology snapshot the web tier builds for itself, so
    forwarding to the control plane would only add a hop and a second cache
    — and in proxy mode the capacity card used to depend on a service that
    does not hold the snapshot at all."""
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    monkeypatch.setattr(agg_mod, "_PROXY_ENABLED", True)

    async def never(*a, **kw):
        raise AssertionError("proxied a route that reads the local snapshot")

    monkeypatch.setattr(agg_mod, "_proxy", never)

    from backend.app.services.aggregation import capacity as cap_mod

    async def fleet(session, *, fresh=False):
        return "fleet"

    async def one(session, ds_id):
        return "source"

    monkeypatch.setattr(cap_mod, "assemble_fleet_capacity", fleet)
    monkeypatch.setattr(cap_mod, "assemble_source_capacity", one)
    assert asyncio.run(agg_mod.get_aggregation_capacity(session=None, fresh=False)) == "fleet"
    assert asyncio.run(agg_mod.get_data_source_capacity("ds-1", session=None)) == "source"


def test_the_control_plane_route_takes_the_patch_body():
    from backend.app.services.aggregation import controlplane as cp
    assert "patch" in inspect.signature(cp.set_graph_store_limits).parameters
