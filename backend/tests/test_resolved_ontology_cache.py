"""Process-wide resolved-ontology cache (WS1): the per-request resolution tax
— provider introspection, Postgres resolve, ~40 CREATE INDEX round-trips, and
the alignment persistence WRITE — must run once per generation per pod, while
every request (hit or miss) still gets the full provider injection contract
(containment types, rules, edge metadata, levels, and ALWAYS-RESET alias maps).

No live services: provider/ontology-service/redis are all fakes.
"""
import asyncio

import pytest

from backend.app.ontology.models import ResolvedOntology
from backend.app.services import resolved_ontology_cache as ont_cache
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import OntologyMetadata


# ── Fakes ────────────────────────────────────────────────────────────


class _FakeRedis:
    def __init__(self):
        self.store = {}
        self.fail = False

    async def get(self, key):
        if self.fail:
            raise ConnectionError("redis down")
        return self.store.get(key)

    async def incr(self, key):
        if self.fail:
            raise ConnectionError("redis down")
        self.store[key] = int(self.store.get(key) or 0) + 1
        return self.store[key]


class _RecordingProvider:
    """Only the surface _resolve_ontology touches."""

    def __init__(self):
        self.ensure_indices_calls = 0
        self.alias_calls = []
        self.containment_calls = []
        self.introspection_calls = 0

    async def get_ontology_metadata(self):
        self.introspection_calls += 1
        return OntologyMetadata(
            containmentEdgeTypes=["HAS"],
            lineageEdgeTypes=["FLOWS_TO"],
            edgeTypeMetadata={"has": {}},
            entityTypeHierarchy={"table": {}},
            rootEntityTypes=["table"],
        )

    def set_containment_edge_types(self, types, from_ontology=False):
        self.containment_calls.append(list(types))

    def set_ontology_rules(self, rules):
        pass

    def set_resolved_edge_metadata(self, meta, lineage):
        pass

    def set_entity_type_levels(self, levels):
        pass

    def set_source_type_aliases(self, rel_map, ent_map):
        self.alias_calls.append((dict(rel_map), dict(ent_map)))

    async def ensure_indices(self, entity_types):
        self.ensure_indices_calls += 1


class _FakeOntologyService:
    def __init__(self):
        self.resolve_calls = 0

    async def resolve(self, workspace_id, data_source_id,
                      introspected_entity_ids=None, introspected_rel_ids=None):
        self.resolve_calls += 1
        return ResolvedOntology(
            entity_type_definitions={"table": None},
            relationship_type_definitions={},
            containment_edge_types=["HAS"],
            lineage_edge_types=["FLOWS_TO"],
            edge_type_metadata={"HAS": {}},
            entity_type_hierarchy={"table": {}},
            root_entity_types=["table"],
            resolution_sources={"table": "system_default"},
        )


@pytest.fixture()
def fake_redis(monkeypatch):
    r = _FakeRedis()
    monkeypatch.setattr(ont_cache, "_redis", lambda: r)
    ont_cache.reset_for_tests()
    yield r
    ont_cache.reset_for_tests()


@pytest.fixture()
def no_db(monkeypatch):
    """The alignment DB step must not reach the real dev Postgres from tests."""
    def _raise():
        raise RuntimeError("no db in unit test")
    monkeypatch.setattr("backend.app.db.engine.get_session_factory", _raise)


def _make_engine(svc, provider):
    e = ContextEngine(provider=provider, ontology_service=svc)
    e._workspace_id = "ws1"
    e._data_source_id = "ds1"
    return e


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── Tests ────────────────────────────────────────────────────────────


def test_second_engine_hits_shared_cache(fake_redis, no_db):
    svc = _FakeOntologyService()

    async def _scenario():
        p1 = _RecordingProvider()
        await _make_engine(svc, p1)._resolve_ontology()
        p2 = _RecordingProvider()
        await _make_engine(svc, p2)._resolve_ontology()
        return p1, p2

    p1, p2 = _run(_scenario())
    assert svc.resolve_calls == 1  # full pipeline once
    assert p1.introspection_calls == 1 and p2.introspection_calls == 0
    assert p1.ensure_indices_calls == 1 and p2.ensure_indices_calls == 0  # no DDL on hit
    # Injection contract holds on the HIT engine too
    assert p2.containment_calls == [["HAS"]]
    assert p2.alias_calls, "alias maps must be re-injected on a cache hit"


def test_generation_bump_forces_full_re_resolve(fake_redis, no_db):
    svc = _FakeOntologyService()

    async def _scenario():
        await _make_engine(svc, _RecordingProvider())._resolve_ontology()
        await ont_cache.bump_ontology_generation("ws1", "ds1")
        p = _RecordingProvider()
        await _make_engine(svc, p)._resolve_ontology()
        return p

    p = _run(_scenario())
    assert svc.resolve_calls == 2
    assert p.ensure_indices_calls == 1  # miss path re-ran DDL


def test_ttl_backstop_expires_entries(fake_redis, no_db, monkeypatch):
    svc = _FakeOntologyService()
    monkeypatch.setattr(ont_cache, "TTL_SECS", 0.0)  # everything instantly stale

    async def _scenario():
        await _make_engine(svc, _RecordingProvider())._resolve_ontology()
        await _make_engine(svc, _RecordingProvider())._resolve_ontology()

    _run(_scenario())
    assert svc.resolve_calls == 2


def test_redis_down_bypasses_shared_cache_without_failing(fake_redis, no_db):
    svc = _FakeOntologyService()
    fake_redis.fail = True

    async def _scenario():
        e1 = _make_engine(svc, _RecordingProvider())
        r1 = await e1._resolve_ontology()
        e2 = _make_engine(svc, _RecordingProvider())
        r2 = await e2._resolve_ontology()
        return r1, r2

    r1, r2 = _run(_scenario())
    assert r1 is not None and r2 is not None
    assert svc.resolve_calls == 2  # no shared caching, previous per-request behaviour


def test_bump_survives_redis_failure(fake_redis, no_db):
    fake_redis.fail = True
    _run(ont_cache.bump_ontology_generation("ws1", "ds1"))  # must not raise


def test_stale_generation_store_never_serves_across_bump(fake_redis, no_db):
    """A bump that lands while a resolve is in flight leaves the stored entry
    stale — the next lookup misses instead of serving pre-bump config."""
    svc = _FakeOntologyService()

    async def _scenario():
        gen = await ont_cache.current_generation("ws1", "ds1")
        # Simulate: resolve finished under `gen`, but a bump raced it.
        await ont_cache.bump_ontology_generation("ws1", "ds1")
        resolved = ResolvedOntology()
        ont_cache.store("ws1", "ds1", gen, resolved, None)
        return await ont_cache.lookup("ws1", "ds1")

    assert _run(_scenario()) is None


# ── Write-path cache bumps (regression coverage) ─────────────────────


def test_data_source_evict_bumps_generation(monkeypatch):
    """Deleting a data source must bump the resolved-ontology generation so
    other pods stop serving its cached resolution. Regression: the bump was
    called with a stray ``session`` argument, raising a TypeError that the
    surrounding best-effort except swallowed — the bump silently never ran."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints import workspaces as ws_ep

    calls = []

    async def fake_bump(workspace_id, data_source_id):
        calls.append((workspace_id, data_source_id))

    monkeypatch.setattr(
        "backend.app.services.resolved_ontology_cache.bump_ontology_generation",
        fake_bump,
    )

    async def fake_evict(provider_id, graph_name):
        return None

    monkeypatch.setattr(ws_ep.provider_registry, "evict_data_source", fake_evict)

    ds = SimpleNamespace(id="ds1", provider_id="p1", graph_name="g1")
    _run(ws_ep._evict(ds, "ws1", session=None))
    assert calls == [("ws1", "ds1")]
