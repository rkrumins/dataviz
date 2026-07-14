"""A health probe that can't authenticate reports a healthy service as DOWN.
Both probe clients must carry the same credentials/TLS as the real clients."""
import pytest


def test_cache_probe_carries_cache_auth_and_tls(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._cache_redis_client = None          # reset the module singleton
    assert probes._cache_redis() is not None

    assert captured["host"] == "cache.internal"
    assert captured["username"] == "cache-user"
    assert captured["password"] == "cache-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"


def test_falkor_node_probe_carries_falkordb_auth(monkeypatch):
    """The FalkorDB node probe built a bare Redis(host, port) and would fail on an
    authenticated instance."""
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._build_falkor_probe_client("fdb-host", 6379,
                                      username="graph", password="graph-pw")
    assert captured["username"] == "graph"
    assert captured["password"] == "graph-pw"
