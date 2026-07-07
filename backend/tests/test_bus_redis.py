"""Unit tests for the aggregation/insights bus Redis builder — Sentinel + TLS,
and the explicit Cluster-not-supported guard. Mocks the redis constructors."""
import sys
import types

import pytest

from backend.common.adapters.redis_bus import BusConfigurationError, build_bus_redis


def _clear_bus_env(monkeypatch):
    for k in (
        "REDIS_SENTINEL_MASTER", "REDIS_SENTINEL_NODES", "REDIS_CLUSTER_NODES",
        "REDIS_TLS_ENABLED", "REDIS_TLS_CA_CERTS", "REDIS_USERNAME", "REDIS_PASSWORD",
    ):
        monkeypatch.delenv(k, raising=False)


def test_cluster_bus_raises(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_CLUSTER_NODES", "n1:7000,n2:7001")
    with pytest.raises(BusConfigurationError):
        build_bus_redis()


def test_single_node_plain(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6399/0")
    captured = {}
    import redis.asyncio as aioredis

    def fake_from_url(url, **kw):
        captured["url"], captured["kw"] = url, kw
        return "CLIENT"

    monkeypatch.setattr(aioredis, "from_url", fake_from_url)
    assert build_bus_redis() == "CLIENT"
    assert captured["url"] == "redis://localhost:6399/0"
    assert "ssl" not in captured["kw"] and "ssl_ca_certs" not in captured["kw"]


def test_single_node_tls_upgrades_scheme_and_adds_certs(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://h:6380/0")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/ca.pem")
    captured = {}
    import redis.asyncio as aioredis

    def fake_from_url(url, **kw):
        captured["url"], captured["kw"] = url, kw
        return "C"

    monkeypatch.setattr(aioredis, "from_url", fake_from_url)
    build_bus_redis()
    assert captured["url"].startswith("rediss://")  # scheme upgraded
    assert captured["kw"]["ssl_ca_certs"] == "/ca.pem"
    assert "ssl" not in captured["kw"]  # scheme already implies ssl


def test_sentinel_mode(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379, s2:26379")
    monkeypatch.setenv("REDIS_PASSWORD", "pw")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["nodes"], captured["kw"] = nodes, kw

        def master_for(self, name, **kw):
            captured["master"], captured["master_kw"] = name, kw
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)

    assert build_bus_redis() == "MASTER"
    assert captured["master"] == "mymaster"
    assert captured["nodes"] == [("s1", 26379), ("s2", 26379)]
    assert captured["kw"]["password"] == "pw"


def test_sentinel_with_tls(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "m")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["kw"] = kw

        def master_for(self, name, **kw):
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)
    build_bus_redis()
    assert captured["kw"]["ssl"] is True
