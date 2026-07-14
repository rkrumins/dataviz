"""The cache must NOT inherit FalkorDB's TLS. Old behaviour:
 - FalkorDB TLS off + rediss:// cache  -> silently used the system trust store
 - FalkorDB TLS on  + redis://  cache  -> NO TLS at all
Both are undiagnosable. The cache now owns its TLS."""
import pytest

from backend.app.providers.falkordb_connection import build_cache_client


def test_cache_uses_its_own_tls_not_falkordbs(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")
    # FalkorDB's own TLS — must NOT reach the cache client.
    monkeypatch.setenv("FALKORDB_TLS_ENABLED", "true")
    monkeypatch.setenv("FALKORDB_TLS_CA_CERTS", "/certs/graph/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    client = build_cache_client(provider_id="p1", extra_config={}, credentials={})
    assert client is not None
    assert captured["host"] == "cache.internal"
    assert captured["password"] == "cache-pw"
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"   # NOT /certs/graph/ca.crt


def test_provider_override_beats_the_global_cache(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "global-cache")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    build_cache_client(
        provider_id="acme",
        extra_config={"cacheConnection": {"host": "acme-cache", "port": 6380}},
        credentials={"cache_username": "acme", "cache_password": "acme-pw"},
    )
    assert captured["host"] == "acme-cache"
    assert captured["port"] == 6380
    assert captured["username"] == "acme"
    assert captured["password"] == "acme-pw"


def test_no_cache_configured_returns_none(monkeypatch):
    for v in ("CACHE_REDIS_URL", "REDIS_CACHE_HOST"):
        monkeypatch.delenv(v, raising=False)
    assert build_cache_client(provider_id="p", extra_config={}, credentials={}) is None
