"""The Neo4j provider had its OWN cache client from extra_config['redisUrl'] with no
auth and no TLS — a third divergent path."""
import pytest


def test_neo4j_cache_goes_through_the_central_factory(monkeypatch):
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.graph.adapters.neo4j_provider import build_neo4j_cache_client
    build_neo4j_cache_client(provider_id="n1", extra_config={}, credentials={})
    assert captured["host"] == "cache.internal"
    assert captured["password"] == "cache-pw"


def test_neo4j_legacy_redis_url_still_works(monkeypatch):
    """A pre-existing Neo4j provider row with only extra_config['redisUrl'] set
    must keep working with zero config change."""
    monkeypatch.delenv("REDIS_CACHE_HOST", raising=False)
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.graph.adapters.neo4j_provider import build_neo4j_cache_client
    client = build_neo4j_cache_client(
        provider_id="n1",
        extra_config={"redisUrl": "redis://:legacy-pw@legacy-host:6399/2"},
        credentials={},
    )
    assert client is not None
    assert captured["host"] == "legacy-host"
    assert captured["port"] == 6399
    assert captured["db"] == 2
    assert captured["password"] == "legacy-pw"


def test_neo4j_explicit_cache_redis_url_wins_over_legacy_extra_config(monkeypatch):
    """If credentials already carries cache_redis_url, extra_config['redisUrl']
    must NOT override it."""
    monkeypatch.delenv("REDIS_CACHE_HOST", raising=False)
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.graph.adapters.neo4j_provider import build_neo4j_cache_client
    build_neo4j_cache_client(
        provider_id="n1",
        extra_config={"redisUrl": "redis://ignored-host:6379/0"},
        credentials={"cache_redis_url": "redis://explicit-host:6400/0"},
    )
    assert captured["host"] == "explicit-host"
    assert captured["port"] == 6400


def test_neo4j_no_cache_configured_returns_none(monkeypatch):
    for v in ("CACHE_REDIS_URL", "REDIS_CACHE_HOST"):
        monkeypatch.delenv(v, raising=False)

    from backend.graph.adapters.neo4j_provider import build_neo4j_cache_client
    result = build_neo4j_cache_client(provider_id="n1", extra_config={}, credentials={})
    assert result is None
