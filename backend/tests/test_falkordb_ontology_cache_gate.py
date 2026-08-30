"""Regression test for the ontology-cache poisoning fix (T-Q).

`get_ontology_metadata` (falkordb/stats.py) does two different jobs and used
to cache the combination: introspection (which edge types exist — a fact
about the graph) and containment/lineage classification (a function of the
ontology injected into THIS PROVIDER INSTANCE — not a fact about the graph).
`ContextEngine._resolve_ontology` calls this method on a fresh, uninjected
provider *before* `_inject_resolved` runs the setters, by design (see
stats.py's own comment above the `ProviderConfigurationError` fallback). With
no gate, that call's provisional, unconfigured classification (containment
empty, everything falls out as lineage, no entity hierarchy, no root types)
used to get written to the shared `{ns}:ontology_cache` Redis key, poisoning
every later — correctly injected — reader for the whole TTL: a flat graph.

The fix records whether containment was actually configured
(`containment_configured`) and gates the shared-cache write on it. The
provisional answer is still returned to the caller that asked for it; it is
only withheld from the shared key.

No live FalkorDB required — the graph query layer is monkeypatched, mirroring
tests/test_falkordb_clear_content_caches.py's fake-Redis-on-instance style.
"""
import asyncio

from backend.app.providers.falkordb.errors import _EmptyResult
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


async def _noop_connect():
    return None


async def _no_rows(*a, **k):
    return _EmptyResult()


class _FakeCacheRedis:
    """Minimal get/setex fake over an in-memory dict, recording every setex
    call so a test can assert on whether one happened."""

    def __init__(self):
        self.store = {}
        self.setex_calls = []

    async def get(self, key):
        return self.store.get(key)

    async def setex(self, key, ttl, value):
        self.setex_calls.append(key)
        self.store[key] = value


def _make_provider(redis):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = redis
    p._ensure_connected = _noop_connect
    p._ro_query = _no_rows
    return p


def test_uninjected_caller_does_not_poison_the_shared_cache():
    """The `_resolve_ontology` shape: get_ontology_metadata() called before
    set_containment_edge_types() has ever run on this instance. containment
    stays provisional, so it must never reach the shared key."""
    redis = _FakeCacheRedis()
    p = _make_provider(redis)

    _run(p.get_ontology_metadata())

    assert redis.setex_calls == []


def test_injected_caller_does_populate_the_shared_cache():
    """The correctly-configured shape: set_containment_edge_types() ran
    first, as `_inject_resolved` does. This classification is real and
    worth sharing, so the fix must not over-gate and suppress it too."""
    redis = _FakeCacheRedis()
    p = _make_provider(redis)
    p.set_containment_edge_types(["HAS"], from_ontology=True)

    _run(p.get_ontology_metadata())

    assert redis.setex_calls == [f"{p._cache_ns}:ontology_cache"]


def test_injected_reader_after_uninjected_warmup_is_not_poisoned():
    """End-to-end shape from the bug report: an uninjected provider (the
    ContextEngine's own resolution path) calls get_ontology_metadata()
    first; a second, correctly-injected provider reading the SAME shared
    Redis afterwards must compute and see its own real classification,
    not a cached provisional one."""
    redis = _FakeCacheRedis()

    uninjected = _make_provider(redis)
    _run(uninjected.get_ontology_metadata())

    injected = _make_provider(redis)
    injected.set_containment_edge_types(["HAS"], from_ontology=True)
    meta = _run(injected.get_ontology_metadata())

    assert list(meta.containment_edge_types) == ["HAS"]
