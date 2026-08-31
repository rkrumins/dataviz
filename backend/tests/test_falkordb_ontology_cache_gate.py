"""Regression tests for the two halves of the ontology-cache poisoning fix.

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

The first half of the fix records whether containment was actually configured
(`containment_configured`) and gates the shared-cache write on it. The
provisional answer is still returned to the caller that asked for it; it is
only withheld from the shared key.

That gate separates a configured writer from an unconfigured one and nothing
else, so it leaves two *correctly injected* callers with different ontologies
still overwriting each other on the same (host, port, graph_name) key. The
second half folds a digest of the injected ontology into the key
(`_ontology_cache_key`, now `{ns}:ontology_cache:{digest}`), so each
configuration caches under its own key and an ontology edit lands on a new one
instead of waiting out the TTL.

No live FalkorDB required — the graph query layer is monkeypatched, mirroring
tests/test_falkordb_clear_content_caches.py's fake-Redis-on-instance style.
"""
import asyncio
import os

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

    assert redis.setex_calls == [p._ontology_cache_key()]
    assert redis.setex_calls[0].startswith(f"{p._cache_ns}:ontology_cache:")


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


# ---------------------------------------------------------------------------
# The other half of the same bug: the gate above only separates a CONFIGURED
# writer from an unconfigured one. Two correctly-configured providers with
# DIFFERENT ontologies are both entitled to write, and a (host, port,
# graph_name) key cannot tell them apart. The fix folds a digest of the
# injected ontology into the key, so each configuration gets its own.
# ---------------------------------------------------------------------------


def test_two_injected_ontologies_do_not_overwrite_each_other():
    """Same host/port/graph, two providers, two ontologies, both properly
    injected. Reachable two ways: two data sources pointing at the same
    FalkorDB + graph_name from different workspaces (the DB uniqueness
    constraint is per-workspace), and one data source whose ontology is
    edited inside the 300s TTL. Neither is helped by the configured-ness
    gate — both writes are legitimate — so the key has to say WHICH
    ontology produced the value."""
    redis = _FakeCacheRedis()

    a = _make_provider(redis)
    a.set_containment_edge_types(["HAS"], from_ontology=True)
    _run(a.get_ontology_metadata())

    b = _make_provider(redis)
    b.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    meta = _run(b.get_ontology_metadata())

    # The physical-graph namespace is identical by construction — it was
    # the only thing the old key encoded.
    assert a._cache_ns == b._cache_ns
    assert list(meta.containment_edge_types) == ["CONTAINS"]


def _configured(**overrides):
    """A fully-injected provider, one setter per ontology input, so a
    variant can change exactly one of them."""
    p = _make_provider(_FakeCacheRedis())
    p.set_containment_edge_types(overrides.get("containment", ["HAS"]), from_ontology=True)
    p.set_resolved_edge_metadata(
        overrides.get("edge_metadata", {"FLOWS_TO": {"direction": "source-to-target"}}),
        overrides.get("lineage", ["FLOWS_TO"]),
    )
    p.set_entity_type_levels(overrides.get("levels", {"table": 2}))
    p.set_source_type_aliases(overrides.get("rel_aliases", {}), overrides.get("entity_aliases", {}))
    p.set_node_identity(overrides.get("identity", "urn"), overrides.get("name", "name"))
    return p


def test_ontology_cache_key_separates_every_injected_input():
    """Each ontology-injection setter's stored state must move the key.
    Enumerated one input at a time so a digest that quietly drops one
    fails by name here rather than as a stale answer months later."""
    base = _configured()._ontology_cache_key()

    assert _configured(containment=["CONTAINS"])._ontology_cache_key() != base
    assert _configured(lineage=["DERIVES_FROM"])._ontology_cache_key() != base
    assert _configured(
        edge_metadata={"FLOWS_TO": {"direction": "child-to-parent"}})._ontology_cache_key() != base
    assert _configured(levels={"table": 3})._ontology_cache_key() != base
    assert _configured(rel_aliases={"HAS": ["has"]})._ontology_cache_key() != base
    assert _configured(entity_aliases={"TABLE": ["table"]})._ontology_cache_key() != base
    assert _configured(identity="guid")._ontology_cache_key() != base
    assert _configured(name="title")._ontology_cache_key() != base

    # An identical configuration must reuse the same key, or the cache is
    # disabled rather than scoped.
    assert _configured()._ontology_cache_key() == base


def test_uninjected_key_differs_from_an_explicitly_empty_containment():
    """"Never configured" and "resolved to a flat graph with no
    containment" are different states that produce different answers, so
    they must not share a key — belt to the configured-ness gate's
    braces."""
    never = _make_provider(_FakeCacheRedis())
    flat = _make_provider(_FakeCacheRedis())
    flat.set_containment_edge_types([], from_ontology=True)

    assert never._ontology_cache_key() != flat._ontology_cache_key()


_DIGEST_PROBE = """
from backend.app.providers.falkordb_provider import FalkorDBProvider

p = FalkorDBProvider(host="x", graph_name="g")
p.set_containment_edge_types(["HAS", "CONTAINS", "OWNS", "PART_OF"], from_ontology=True)
p.set_resolved_edge_metadata(
    {"FLOWS_TO": {"direction": "source-to-target"}, "HAS": {"direction": "parent-to-child"}},
    ["FLOWS_TO", "DERIVES_FROM", "READS"],
)
p.set_entity_type_levels({"table": 2, "database": 0, "schema": 1, "column": 3})
p.set_source_type_aliases({"HAS": ["has", "Has"]}, {"TABLE": ["table", "Table"]})
p.set_node_identity("guid", "title")
print(p._ontology_cache_key())
"""


def test_ontology_cache_key_is_stable_across_interpreter_processes():
    """The digest must come from `hashlib` over SORTED collections, never
    from `hash()` or bare set/frozenset iteration: both vary per process
    with PYTHONHASHSEED. A seed-dependent digest fails nothing — it
    silently gives every worker its own key, which disables the cache and
    leaves a dead key per process behind. Two fresh interpreters, two
    different seeds, one digest.

    No in-process assertion can see this: within one interpreter the same
    set contents always iterate the same way."""
    import subprocess
    import sys

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    def _key_under(seed: str) -> str:
        env = dict(os.environ, PYTHONHASHSEED=seed, PYTHONPATH=repo_root)
        done = subprocess.run(
            [sys.executable, "-c", _DIGEST_PROBE],
            cwd=repo_root, env=env, capture_output=True, text=True, timeout=180,
        )
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    assert _key_under("0") == _key_under("987654321")
