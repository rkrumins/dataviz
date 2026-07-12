"""Pins the socket-hygiene contract for every raw FalkorDB ConnectionPool.

A GKE node rotation reschedules the FalkorDB pod: established sockets are
black-holed (kernel retransmit can stall 15+ minutes) and pooled idle
sockets die silently. Every pool the backend builds must therefore carry
``resilient_pool_kwargs()`` — connect deadline, socket hang-net, TCP
keepalive, and redis-py's pre-reuse health check. These tests pin that the
helper honors its documented env knobs (backend/app/config/resilience.py)
and that ALL construction sites route through it: the graph registry's
env-default + pinned-provider handles, ``list_graph_keys``'s one-shot
connection, the versioning projector's env factory, and the primary
provider's ``_build_pool_kwargs``.

No live FalkorDB/Redis required — fake modules capture the pool kwargs.
"""
import inspect
import sys
import types

import pytest

from backend.app.config import resilience
from backend.app.providers.falkordb_connection import (
    projection_socket_timeout,
    resilient_pool_kwargs,
)


# ── helper contract ──────────────────────────────────────────────────

def test_resilient_pool_kwargs_defaults():
    kw = resilient_pool_kwargs()
    assert kw == {
        "socket_connect_timeout": resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS,
        "socket_timeout": resilience.FALKORDB_SOCKET_TIMEOUT_SECS,
        "socket_keepalive": resilience.FALKORDB_SOCKET_KEEPALIVE,
        "health_check_interval": resilience.FALKORDB_HEALTH_CHECK_INTERVAL_SECS,
    }
    # Shipped defaults (env-free container): the hang net must be BOUNDED.
    assert kw["socket_connect_timeout"] > 0
    assert kw["socket_timeout"] > 0
    assert kw["health_check_interval"] > 0


def test_resilient_pool_kwargs_honors_config_overrides(monkeypatch):
    # Knobs live in resilience.py (env read at import); override the
    # module attributes the way an operator's env would have set them.
    monkeypatch.setattr(resilience, "FALKORDB_SOCKET_TIMEOUT_SECS", 42.0)
    monkeypatch.setattr(resilience, "FALKORDB_HEALTH_CHECK_INTERVAL_SECS", 7)
    monkeypatch.setattr(resilience, "FALKORDB_SOCKET_KEEPALIVE", False)
    kw = resilient_pool_kwargs()
    assert kw["socket_timeout"] == 42.0
    assert kw["health_check_interval"] == 7
    assert kw["socket_keepalive"] is False


def test_resilient_pool_kwargs_explicit_timeout_wins(monkeypatch):
    monkeypatch.setattr(resilience, "FALKORDB_SOCKET_TIMEOUT_SECS", 42.0)
    assert resilient_pool_kwargs(socket_timeout=5.0)["socket_timeout"] == 5.0


def test_projection_socket_timeout_tracks_write_budget(monkeypatch):
    # Must exceed the projector's server-side write budget by the margin,
    # or the socket hang-net kills legitimate long batched merges.
    monkeypatch.delenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", raising=False)
    margin = resilience.PROJECTION_SOCKET_TIMEOUT_MARGIN_SECS
    assert projection_socket_timeout() == 60.0 + margin
    monkeypatch.setenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "120")
    assert projection_socket_timeout() == 120.0 + margin


# ── construction sites (fake redis/falkordb capture pool kwargs) ─────

@pytest.fixture
def fake_redis_and_falkor(monkeypatch):
    """Install fake redis.asyncio + falkordb.asyncio modules so the lazy
    imports resolve. Returns a registry capturing constructed pools."""
    captured = {}

    class FakePool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            captured.setdefault("pools", []).append(self)

    class FakeFalkorDB:
        def __init__(self, connection_pool=None, **kwargs):
            self.connection_pool = connection_pool

        def select_graph(self, name):
            return ("graph", name)

        async def list_graphs(self):
            return [b"g1", "g2"]

    redis_pkg = types.ModuleType("redis")
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.ConnectionPool = FakePool
    falkor_pkg = types.ModuleType("falkordb")
    falkor_asyncio = types.ModuleType("falkordb.asyncio")
    falkor_asyncio.FalkorDB = FakeFalkorDB

    monkeypatch.setitem(sys.modules, "redis", redis_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "falkordb", falkor_pkg)
    monkeypatch.setitem(sys.modules, "falkordb.asyncio", falkor_asyncio)
    return captured


def _assert_resilient(pool_kwargs: dict, *, socket_timeout: float):
    assert pool_kwargs["socket_connect_timeout"] == \
        resilience.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS
    assert pool_kwargs["socket_timeout"] == socket_timeout
    assert pool_kwargs["socket_keepalive"] is resilience.FALKORDB_SOCKET_KEEPALIVE
    assert pool_kwargs["health_check_interval"] == \
        resilience.FALKORDB_HEALTH_CHECK_INTERVAL_SECS


def test_registry_env_handle_pool_is_resilient(fake_redis_and_falkor, monkeypatch):
    monkeypatch.delenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", raising=False)
    import backend.app.providers.falkor_graph_registry as frg

    frg._env_handle_factory()
    (pool,) = fake_redis_and_falkor["pools"]
    # Projection-capable pool: hang net = write budget (60) + margin.
    _assert_resilient(pool.kwargs, socket_timeout=projection_socket_timeout())
    # Bytes-mode preserved — decoding stays at the call sites.
    assert "decode_responses" not in pool.kwargs


def test_projection_env_factory_pool_is_resilient(fake_redis_and_falkor, monkeypatch):
    monkeypatch.delenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", raising=False)
    from backend.app.services.versioning.projection import make_falkor_graph_factory

    factory = make_falkor_graph_factory()
    (pool,) = fake_redis_and_falkor["pools"]
    _assert_resilient(pool.kwargs, socket_timeout=projection_socket_timeout())
    assert "decode_responses" not in pool.kwargs
    assert factory("g") == ("graph", "g")


@pytest.mark.asyncio
async def test_list_graph_keys_pool_is_resilient(fake_redis_and_falkor, monkeypatch):
    monkeypatch.setenv("FALKORDB_HOST", "gx")
    monkeypatch.setenv("FALKORDB_PORT", "6400")
    import backend.app.providers.falkor_graph_registry as frg

    keys = await frg.list_graph_keys(None)
    assert keys == {"g1", "g2"}
    (pool,) = fake_redis_and_falkor["pools"]
    # One-shot GRAPH.LIST read: default hang net, not the projection budget.
    _assert_resilient(
        pool.kwargs, socket_timeout=resilience.FALKORDB_SOCKET_TIMEOUT_SECS)
    assert "decode_responses" not in pool.kwargs


def test_registry_pinned_handles_route_through_resilient_kwargs():
    # _handle_for is a closure inside make_registry_graph_factory (needs a
    # live registry row to drive) — pin the routing at the source level,
    # same pattern as test_falkordb_host_resolution.py.
    import backend.app.providers.falkor_graph_registry as frg

    src = inspect.getsource(frg.make_registry_graph_factory)
    assert "resilient_pool_kwargs(" in src
    assert "projection_socket_timeout(" in src


def test_primary_provider_pool_kwargs_are_resilient(monkeypatch):
    monkeypatch.delenv("FALKORDB_GRAPH_POOL_SIZE", raising=False)
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider.__new__(FalkorDBProvider)
    provider._conn_cfg = None
    provider._username = None
    provider._password = None
    kw = provider._build_pool_kwargs(10.0)
    _assert_resilient(kw, socket_timeout=10.0)
    # Interactive-tier pool keeps its existing shape.
    assert kw["decode_responses"] is True
    assert kw["max_connections"] == 24
