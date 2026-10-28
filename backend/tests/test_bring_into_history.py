"""Bring into history: what a customer's FalkorDB graph holds that history doesn't goes into it.

Something else may keep writing to a graph enabled in place (an ETL). The projection keeps what
history doesn't hold and flags it (``externalDrift``); ``POST /graph/resync`` brings it in. It reads
the key the projection publishes into, through the projection's pin, and only while that key holds
main: a key behind main, being rebuilt or moved is missing what the projection hasn't written, and
that would read as the graph's own change. A key the platform owns has no other writers, so there
is nothing to bring in. Then the flag goes, and the lineage summaries are rebuilt, since the
publish that follows moves them by relationships the batch job may already have counted.
"""
from __future__ import annotations

import time
import types

import pytest

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.feature_flags import feature_flags

GRAPH = "/api/v1/ws_b/graph"


@pytest.fixture
async def source(db_session):
    db_session.add_all([WorkspaceORM(id="ws_b", name="B"),
                        ProviderORM(id="prov_b", name="P", provider_type="falkordb")])
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id="ds_b", workspace_id="ws_b", provider_id="prov_b",
                                          graph_name="g_b", label="B"))
    await db_session.commit()


@pytest.fixture
def versioning_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture
def world(monkeypatch, db_session):
    """The graph, its watermark, and what each step was handed, in order."""
    from backend.app.api.v1.endpoints import graph, versioning
    from backend.app.main import app
    from backend.app.services import node_identity, projection_target
    from backend.app.services.context_engine import ContextEngine
    from backend.app.services.versioning.service import GraphVersioningService

    seen = {"steps": []}
    wm = {"fresh": True, "status": "idle", "falkor_provider": "prov_b",
          "falkor_graph_name": "g_b", "owns_falkor_graph": False,
          "external_drift": {"at": "t1", "nodes": 2, "edges": 1, "via": "verify"}}

    async def resolve(self, **_k):
        return {"graph_id": "vg_b"}

    async def watermark(self, _gid):
        return dict(wm)

    async def bring_in(self, **k):
        seen["steps"].append("bring")
        seen["bring"] = k
        return {"commit_id": "c_b", "commit_seq": 9, "applied": 3}

    async def clear(self, gid, **k):
        seen["steps"].append("clear")
        seen["cleared"] = gid
        seen["clear"] = k

    async def for_the_graph(cls, _ws_id, _registry, session, ds_id):
        return types.SimpleNamespace(provider="the data source's reader", _data_source_id=ds_id,
                                     _db_session=session)

    async def stamp(_ds_id):
        seen["steps"].append("stamp")
        return {"property": "urn", "stamped": 0}

    async def rules(_engine, **_k):
        return "the source's rules"

    def factory(name, provider_id=None):
        seen["key"] = (name, provider_id)
        return "the graph's client"

    def hook(_get_service):
        async def _hook(gid):
            seen["steps"].append("rebuild")
            seen["rebuilt"] = gid
        return _hook

    monkeypatch.setattr(GraphVersioningService, "resolve_graph", resolve)
    monkeypatch.setattr(GraphVersioningService, "projection_watermark", watermark)
    monkeypatch.setattr(GraphVersioningService, "bring_into_history", bring_in, raising=False)
    monkeypatch.setattr(GraphVersioningService, "clear_external_changes", clear, raising=False)
    monkeypatch.setattr(ContextEngine, "for_the_graph", classmethod(for_the_graph))
    monkeypatch.setattr(node_identity, "stamp_identity_for_enable", stamp)
    monkeypatch.setattr(graph, "_resolve_ontology_rules", rules)
    monkeypatch.setattr(versioning, "get_falkor_read_factory", lambda: factory)
    monkeypatch.setattr(projection_target, "make_rollup_rebuild_hook", hook)
    # What serves reads now: a main the projection lags reads Postgres.
    reads = types.SimpleNamespace(provider="the Postgres reader", _db_session=db_session)
    monkeypatch.setitem(app.dependency_overrides, graph.get_context_engine, lambda: reads)
    return seen, wm


async def test_it_reads_the_projections_key_then_clears_the_flag_and_rebuilds_the_summaries(
        test_client, source, versioning_on, world):
    seen, _ = world
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 200, resp.text
    assert seen["key"] == ("g_b", "prov_b"), "it read something other than the pinned key"
    k = seen["bring"]
    assert (k["graph_id"], k["client"], k["rules"], k["strategy"]) == (
        "vg_b", "the graph's client", "the source's rules", "merge")
    assert seen["steps"] == ["stamp", "bring", "clear", "rebuild"]
    assert seen["cleared"] == seen["rebuilt"] == "vg_b"
    # Only the flag the read began under goes: one raised since may report what it didn't read.
    assert seen["clear"] == {"seen_at": "t1"}


async def test_a_key_the_platform_owns_has_nothing_to_bring_in(test_client, source,
                                                               versioning_on, world):
    """Nothing but the projector writes to a key the platform owns: what it holds that history
    doesn't is the projector's to undo (Rebuild), not history's to take in."""
    seen, wm = world
    wm["owns_falkor_graph"] = True
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["type"] == "platform_copy" and "Rebuild" in detail["message"], detail
    assert seen["steps"] == [] and "key" not in seen


@pytest.mark.parametrize("change", [{"fresh": False}, {"status": "evicted"},
                                    {"status": "rebuilding"}, {"status": "reseeding"}])
async def test_a_key_that_doesnt_hold_main_is_not_read(test_client, source, versioning_on,
                                                       world, change):
    """Behind main, evicted, being rebuilt or moved (reseeding), the key lacks what the
    projection hasn't written yet, or what it held: read now, that would come in as the graph's
    own change."""
    seen, wm = world
    wm.update(change)
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["type"] == "not_ready"
    assert seen["steps"] == [] and "key" not in seen


async def test_with_no_graph_server_it_reads_nothing(test_client, source, versioning_on, world,
                                                     monkeypatch):
    from backend.app.api.v1.endpoints import versioning

    seen, _ = world
    monkeypatch.setattr(versioning, "get_falkor_read_factory", lambda: None)
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 503, resp.text
    assert seen["steps"] == []


async def test_nothing_to_bring_in_clears_the_flag_and_rebuilds_nothing(
        test_client, source, versioning_on, world, monkeypatch):
    from backend.app.services.versioning.service import GraphVersioningService

    seen, _ = world

    async def nothing(self, **_k):
        seen["steps"].append("bring")
        return {"commit_id": None, "applied": 0}

    monkeypatch.setattr(GraphVersioningService, "bring_into_history", nothing, raising=False)
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 200, resp.text
    assert seen["steps"] == ["stamp", "bring", "clear"]
