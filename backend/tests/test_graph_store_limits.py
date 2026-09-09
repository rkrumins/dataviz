"""The graph store's own per-query limits, adjusted from the UI.

``TIMEOUT_MAX`` and ``QUERY_MEM_CAPACITY`` accept ``GRAPH.CONFIG SET`` at
runtime. These tests pin the contract of doing that from Infrastructure:
the node is read first and every refusal comes before anything is set; a
cap never goes below the node's default; raising the memory ceiling needs
the container limit and is refused with the shortfall when the deployment
guide's formula says the container cannot back it; what was set is read
back and verified; every provider on the node learns the new cap; the fleet
snapshot is dropped; the change is logged with its actor; and the route is
system-admin only, with the actor taken from the session, never the body.
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

    async def info(self, section=None):
        return {"used_memory": self.used, "maxmemory": self.maxmemory, "maxmemory_policy": "noeviction"}

    async def execute_command(self, *args, **kw):
        if args == ("GRAPH.CONFIG", "GET", "*"):
            return [[k, v] for k, v in self.config.items()]
        if args[:2] == ("GRAPH.CONFIG", "SET"):
            self.sets.append((args[2], args[3], kw.get("target_nodes")))
            if not self.sticky:
                self.config[args[2]] = args[3]
            return "OK"
        raise AssertionError(args)


class _ClusterConn(_Conn):
    """Cluster: INFO and CONFIG target a node; two primaries, the first owns
    the graph."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.primaries = [_Node("10.0.0.1"), _Node("10.0.0.2")]
        self.nodes_manager = types.SimpleNamespace(
            get_node_from_slot=lambda slot: self.primaries[0], slots_cache={1: []},
        )

    async def initialize(self):
        pass

    def keyslot(self, key):
        return 1

    def get_primaries(self):
        return list(self.primaries)

    async def execute_command(self, *args, target_nodes=None):
        if args == ("INFO", "memory"):
            return await self.info("memory")
        return await super().execute_command(*args, target_nodes=target_nodes)


class _Provider:
    def __init__(self, conn, *, mode="standalone", graph="g"):
        self._db = types.SimpleNamespace(connection=conn)
        self._conn_cfg = types.SimpleNamespace(mode=mode)
        self._graph_name = graph
        self.noted = []

    def note_server_limits(self, endpoint, **limits):
        self.noted.append((endpoint, limits))


def _wire(monkeypatch, endpoint, holders):
    """The capacity sweep, reduced to what the change needs from it."""
    async def assemble(session, registry, *, ds_id=None):
        return {"providers_by_endpoint": {endpoint: holders}, "limits": cap.effective_limits({})}

    async def stored(session):
        return {}

    monkeypatch.setattr(cap, "_assemble", assemble)
    monkeypatch.setattr(cap, "_stored_tuning", stored)
    cap._cache = (0.0, "a cached snapshot")


def _patch(**kw):
    return GraphStoreLimitsPatch(**kw)


def _apply(endpoint, patch):
    return _run(gsl.apply_graph_store_limits(object(), object(), endpoint, patch))


# ── the change ───────────────────────────────────────────────────────


def test_raising_the_time_cap_sets_verifies_tells_providers_and_drops_the_cache(monkeypatch, caplog):
    conn = _Conn()
    p = _Provider(conn)
    _wire(monkeypatch, ENDPOINT, [(p, "g")])
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
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
    with pytest.raises(gsl.GraphStoreLimitsError) as exc:
        _apply(ENDPOINT, _patch(timeoutMaxMs=20_000))
    assert "20 s" in str(exc.value) and "30 s" in str(exc.value)
    assert conn.sets == []


def test_raising_the_ceiling_needs_the_container_limit_and_refuses_a_shortfall_with_the_numbers(monkeypatch):
    conn = _Conn(maxmemory=6 * GB)
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
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
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
    out = _apply(ENDPOINT, _patch(queryMemCapacity=512 * MB, containerMemoryBytes=64 * GB, concurrentQueries=16))
    assert out.thread_count_assumed is True and out.concurrent_queries == gsl.THREAD_COUNT_ASSUMED
    assert out.container_needed_bytes == sc.container_memory_needed(6 * GB, 4, 512 * MB)
    with pytest.raises(gsl.GraphStoreLimitsError, match="assumed 4"):
        _apply(ENDPOINT, _patch(queryMemCapacity=8 * GB, containerMemoryBytes=10 * GB))


def test_a_node_without_maxmemory_cannot_have_its_ceiling_raised(monkeypatch):
    conn = _Conn(maxmemory=0)
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
    with pytest.raises(gsl.GraphStoreLimitsError, match="no maxmemory"):
        _apply(ENDPOINT, _patch(queryMemCapacity=GB, containerMemoryBytes=64 * GB))
    assert conn.sets == []
    # Lowering, and the time cap, still work there.
    out = _apply(ENDPOINT, _patch(queryMemCapacity=256 * MB, timeoutMaxMs=240_000))
    assert conn.sets == [("TIMEOUT_MAX", 240_000, None), ("QUERY_MEM_CAPACITY", 256 * MB, None)]
    assert out.container_needed_bytes is None and out.args_fragment == "TIMEOUT_MAX 240000 QUERY_MEM_CAPACITY 268435456"


def test_lowering_the_ceiling_needs_nothing_and_zero_is_refused(monkeypatch):
    conn = _Conn()
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
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
    _wire(monkeypatch, ENDPOINT, [(_Provider(_Conn()), "g")])
    with pytest.raises(gsl.GraphStoreEndpointNotFound, match="known: falkor:6379"):
        _apply("10.9.9.9:6379", _patch(timeoutMaxMs=300_000))

    class _Dead(_Conn):
        async def info(self, section=None):
            raise ConnectionError("refused")

    dead = _Dead()
    _wire(monkeypatch, ENDPOINT, [(_Provider(dead), "g")])
    with pytest.raises(gsl.GraphStoreLimitsError, match="could not be read"):
        _apply(ENDPOINT, _patch(timeoutMaxMs=300_000))
    assert dead.sets == []


def test_a_value_that_does_not_read_back_is_an_error(monkeypatch):
    conn = _Conn(sticky=True)
    _wire(monkeypatch, ENDPOINT, [(_Provider(conn), "g")])
    with pytest.raises(gsl.GraphStoreLimitsError, match="reads back as 180000"):
        _apply(ENDPOINT, _patch(timeoutMaxMs=300_000))
    assert cap._cache is not None                           # nothing verified, nothing dropped


def test_cluster_mode_sets_the_owning_node_or_every_primary(monkeypatch):
    conn = _ClusterConn()
    p = _Provider(conn, mode="cluster")
    _wire(monkeypatch, "10.0.0.1:6379", [(p, "g")])
    out = _apply("10.0.0.1:6379", _patch(timeoutMaxMs=300_000))
    assert [(n, v, t.host) for n, v, t in conn.sets] == [("TIMEOUT_MAX", 300_000, "10.0.0.1")]
    assert out.applied_to == ["10.0.0.1:6379"] and out.shard.endpoint == "10.0.0.1:6379"
    conn.sets.clear()
    out = _apply("10.0.0.1:6379", _patch(timeoutMaxMs=240_000, applyToAllNodes=True))
    assert [t.host for _, _, t in conn.sets] == ["10.0.0.1", "10.0.0.2"]
    assert out.applied_to == ["10.0.0.1:6379", "10.0.0.2:6379"]


def test_a_refused_set_names_what_already_landed(monkeypatch):
    conn = _ClusterConn()
    seen = {"sets": 0}
    orig = conn.execute_command

    async def flaky(*args, target_nodes=None):
        if args[:2] == ("GRAPH.CONFIG", "SET"):
            seen["sets"] += 1
            if seen["sets"] == 2:
                raise RuntimeError("ERR read-only replica")
        return await orig(*args, target_nodes=target_nodes)

    conn.execute_command = flaky
    _wire(monkeypatch, "10.0.0.1:6379", [(_Provider(conn, mode="cluster"), "g")])
    with pytest.raises(gsl.GraphStoreLimitsError) as exc:
        _apply("10.0.0.1:6379", _patch(timeoutMaxMs=300_000, applyToAllNodes=True))
    assert "10.0.0.2:6379" in str(exc.value) and "Already applied on 10.0.0.1:6379" in str(exc.value)


# ── the routes ───────────────────────────────────────────────────────


def _dep_calls(dependant):
    out = [dependant.call]
    for d in dependant.dependencies:
        out += _dep_calls(d)
    return out


def test_the_web_route_is_system_admin_only_and_proxies_with_the_actor(monkeypatch):
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    route = next(
        r for r in agg_mod.router.routes
        if r.path == "/graph-store/{endpoint}/limits" and "PATCH" in r.methods
    )
    assert agg_mod._REQUIRE_SYSTEM_ADMIN in _dep_calls(route.dependant)

    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured.update(method=method, path=path, body=body)
        return "proxied"

    monkeypatch.setattr(agg_mod, "_proxy", _fake_proxy)
    monkeypatch.setattr(agg_mod, "_PROXY_ENABLED", True)
    out = asyncio.run(agg_mod.set_graph_store_limits(
        "10.0.0.1:6379", _patch(timeoutMaxMs=300_000, actor="spoofed"),
        types.SimpleNamespace(query_params={}), admin=types.SimpleNamespace(id="admin-1"),
        svc=None, session=None,
    ))
    assert out == "proxied" and captured["method"] == "PATCH"
    assert captured["path"] == "/aggregation/graph-store/10.0.0.1%3A6379/limits"
    assert json.loads(captured["body"]) == {"timeoutMaxMs": 300_000, "applyToAllNodes": False, "actor": "admin-1"}


def test_the_web_route_maps_refusals_to_422_and_unknown_nodes_to_404(monkeypatch):
    from fastapi import HTTPException
    from backend.app.api.v1.endpoints import aggregation as agg_mod

    monkeypatch.setattr(agg_mod, "_PROXY_ENABLED", False)
    request = types.SimpleNamespace(query_params={})
    svc = types.SimpleNamespace(_registry=None)

    async def refuse(session, registry, endpoint, patch):
        raise gsl.GraphStoreLimitsError("short by 1.0 GB")

    monkeypatch.setattr(gsl, "apply_graph_store_limits", refuse)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(agg_mod.set_graph_store_limits(
            "n1", _patch(queryMemCapacity=GB), request, admin=types.SimpleNamespace(id="a"), svc=svc, session=None,
        ))
    assert exc.value.status_code == 422 and "short by" in exc.value.detail

    async def missing(session, registry, endpoint, patch):
        raise gsl.GraphStoreEndpointNotFound("no such node")

    monkeypatch.setattr(gsl, "apply_graph_store_limits", missing)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(agg_mod.set_graph_store_limits(
            "n1", _patch(queryMemCapacity=GB), request, admin=types.SimpleNamespace(id="a"), svc=svc, session=None,
        ))
    assert exc.value.status_code == 404


def test_the_control_plane_route_takes_the_patch_body():
    from backend.app.services.aggregation import controlplane as cp
    assert "patch" in inspect.signature(cp.set_graph_store_limits).parameters
