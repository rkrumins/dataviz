"""Unit tests for the FalkorDB connection factory (standalone / Sentinel /
Cluster). These mock the redis + falkordb clients so they run without any
live FalkorDB — they verify mode dispatch, node resolution, and config
parsing, not actual network behavior."""
import sys
import types

import pytest

from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    _parse_nodes,
    build_cache_redis_fallback,
    build_graph_client,
    load_connection_config,
    resolve_cluster_node_for_key,
)
from backend.common.interfaces.provider import ProviderConfigurationError


# ── config parsing ──────────────────────────────────────────────────

def test_parse_nodes_csv_string():
    assert _parse_nodes("h1:26379, h2:26379") == [("h1", 26379), ("h2", 26379)]


def test_parse_nodes_pairs_and_objects():
    assert _parse_nodes([["a", 1], {"host": "b", "port": 2}]) == [("a", 1), ("b", 2)]


def test_parse_nodes_skips_garbage():
    assert _parse_nodes(["nohost", ["x", "notint"], ["y", 5]]) == [("y", 5)]


def test_load_config_defaults_to_standalone():
    cfg = load_connection_config(None, host="h", port=6379, username=None, password=None)
    assert cfg.mode == "standalone"
    assert cfg.host == "h" and cfg.port == 6379


def test_load_config_unknown_mode_falls_back(caplog):
    cfg = load_connection_config({"mode": "bogus"}, host="h", port=1, username=None, password=None)
    assert cfg.mode == "standalone"


def test_load_config_env_fallback(monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "sentinel")
    monkeypatch.setenv("FALKORDB_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("FALKORDB_SENTINEL_NODES", "s1:26379,s2:26379")
    cfg = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert cfg.mode == "sentinel"
    assert cfg.sentinel_master == "mymaster"
    assert cfg.sentinel_nodes == [("s1", 26379), ("s2", 26379)]


def test_explicit_config_wins_over_env(monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    cfg = load_connection_config({"mode": "standalone"}, host="h", port=1, username=None, password=None)
    assert cfg.mode == "standalone"


def test_load_config_parses_advanced_knobs():
    cfg = load_connection_config(
        {"mode": "cluster", "cluster": {"startupNodes": [["n", 7000]]},
         "socketTimeout": "30", "graphPoolSize": 48},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_timeout == 30.0
    assert cfg.graph_pool_size == 48


def test_load_config_ignores_bad_knobs():
    cfg = load_connection_config(
        {"socketTimeout": "abc", "graphPoolSize": "xyz"},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_timeout is None
    assert cfg.graph_pool_size is None


# ── graph client construction (mocked) ──────────────────────────────

@pytest.fixture
def fake_redis_and_falkor(monkeypatch):
    """Install fake redis.asyncio + falkordb.asyncio modules so the factory
    can import them. Returns a registry capturing what got constructed."""
    captured = {}

    class FakePool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            captured.setdefault("pools", []).append(self)

    class FakeRedis:
        def __init__(self, connection_pool=None, **kwargs):
            self.connection_pool = connection_pool
            self.kwargs = kwargs

    class FakeMaster:
        def __init__(self):
            self.connection_pool = FakePool(role="sentinel-master")

    class FakeSentinel:
        def __init__(self, nodes, **kwargs):
            captured["sentinel_nodes"] = nodes
            captured["sentinel_kwargs"] = kwargs

        def master_for(self, name, **kwargs):
            captured["master_for"] = name
            return FakeMaster()

    class FakeFalkorDB:
        def __init__(self, connection_pool=None, **kwargs):
            self.connection_pool = connection_pool
            captured["falkordb"] = self

    # redis.asyncio
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.ConnectionPool = FakePool
    redis_asyncio.Redis = FakeRedis
    sentinel_mod = types.ModuleType("redis.asyncio.sentinel")
    sentinel_mod.Sentinel = FakeSentinel

    redis_pkg = types.ModuleType("redis")
    redis_asyncio_pkg = types.ModuleType("redis.asyncio")
    redis_asyncio_pkg.ConnectionPool = FakePool
    redis_asyncio_pkg.Redis = FakeRedis

    falkor_asyncio = types.ModuleType("falkordb.asyncio")
    falkor_asyncio.FalkorDB = FakeFalkorDB
    falkor_pkg = types.ModuleType("falkordb")

    monkeypatch.setitem(sys.modules, "redis", redis_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", sentinel_mod)
    monkeypatch.setitem(sys.modules, "falkordb", falkor_pkg)
    monkeypatch.setitem(sys.modules, "falkordb.asyncio", falkor_asyncio)
    captured["FakePool"] = FakePool
    return captured


@pytest.mark.asyncio
async def test_build_graph_client_standalone(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="standalone", host="gx", port=6400)
    db, pool = await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "decode_responses": True},
    )
    assert db.connection_pool is pool
    assert pool.kwargs["host"] == "gx" and pool.kwargs["port"] == 6400


@pytest.mark.asyncio
async def test_build_graph_client_sentinel(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster",
        sentinel_nodes=[("s1", 26379), ("s2", 26379)],
    )
    db, pool = await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "max_connections": 24},
    )
    # FalkorDB must be handed the sentinel master's pool.
    assert db.connection_pool is pool
    assert fake_redis_and_falkor["master_for"] == "mymaster"
    assert fake_redis_and_falkor["sentinel_nodes"] == [("s1", 26379), ("s2", 26379)]


@pytest.mark.asyncio
async def test_build_graph_client_sentinel_requires_master(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="sentinel", sentinel_master=None, sentinel_nodes=[("s1", 1)])
    with pytest.raises(ProviderConfigurationError):
        await build_graph_client(cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0})


@pytest.mark.asyncio
async def test_build_graph_client_cluster_routes_to_owning_node(fake_redis_and_falkor, monkeypatch):
    cfg = FalkorDBConnConfig(mode="cluster", cluster_nodes=[("n1", 7000), ("n2", 7001)])

    async def fake_resolve(_cfg, graph_name, socket_timeout):
        assert graph_name == "g"
        return ("ownernode", 7001)

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_cluster_node_for_key",
        fake_resolve,
    )
    db, pool = await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "decode_responses": True},
    )
    assert pool.kwargs["host"] == "ownernode" and pool.kwargs["port"] == 7001
    assert db.connection_pool is pool


@pytest.mark.asyncio
async def test_cache_fallback_cluster_returns_none(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="cluster", cluster_nodes=[("n1", 7000)])
    assert build_cache_redis_fallback(cfg, pool_kwargs={"socket_timeout": 3.0}) is None


@pytest.mark.asyncio
async def test_cache_fallback_standalone_builds_client(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="standalone", host="h", port=6379)
    client = build_cache_redis_fallback(cfg, pool_kwargs={"socket_timeout": 3.0, "decode_responses": True})
    assert client is not None
