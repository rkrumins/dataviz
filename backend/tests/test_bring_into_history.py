"""Bring into history: what a versioned graph's own FalkorDB graph holds goes into history.

Something else may keep writing to a graph enabled in place (an ETL). The projection keeps what
history doesn't hold and flags it (``externalDrift``); ``POST /graph/resync`` brings it in. It must
read the graph itself — the key the projection publishes into — not whatever serves reads now: a
main the projection lags reads Postgres, and a re-sync from that holds nothing new. Then the flag
goes, and the lineage summaries are rebuilt, since the publish that follows moves them by
relationships the batch job may already have counted from the graph.
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
    from backend.app.api.v1.endpoints import graph
    from backend.app.main import app
    from backend.app.services import node_identity, projection_target
    from backend.app.services.context_engine import ContextEngine
    from backend.app.services.versioning.service import GraphVersioningService

    seen = {"steps": []}
    own = types.SimpleNamespace(manager_cache_key=("prov_b", "g_b"))
    wm = {"fresh": True, "status": "idle", "falkor_provider": "prov_b",
          "falkor_graph_name": "g_b"}

    async def resolve(self, **_k):
        return {"graph_id": "vg_b"}

    async def watermark(self, _gid):
        return dict(wm)

    async def resync(self, **k):
        seen["steps"].append("resync")
        seen["resync"] = k
        return {"commit_id": "c_b", "commit_seq": 9}

    async def clear(self, gid):
        seen["steps"].append("clear")
        seen["cleared"] = gid

    async def for_the_graph(cls, _ws_id, _registry, session, ds_id):
        return types.SimpleNamespace(provider=own, _data_source_id=ds_id, _db_session=session)

    async def stamp(_ds_id):
        seen["steps"].append("stamp")
        return {"property": "urn", "stamped": 0}

    async def rules(_engine, **_k):
        return "the source's rules"

    def hook(_get_service):
        async def _hook(gid):
            seen["steps"].append("rebuild")
            seen["rebuilt"] = gid
        return _hook

    monkeypatch.setattr(GraphVersioningService, "resolve_graph", resolve)
    monkeypatch.setattr(GraphVersioningService, "projection_watermark", watermark)
    monkeypatch.setattr(GraphVersioningService, "resync_from_provider", resync)
    monkeypatch.setattr(GraphVersioningService, "clear_external_changes", clear, raising=False)
    monkeypatch.setattr(ContextEngine, "for_the_graph", classmethod(for_the_graph))
    monkeypatch.setattr(node_identity, "stamp_identity_for_enable", stamp)
    monkeypatch.setattr(graph, "_resolve_ontology_rules", rules)
    monkeypatch.setattr(projection_target, "make_rollup_rebuild_hook", hook)
    # What serves reads now: a main the projection lags reads Postgres.
    reads = types.SimpleNamespace(provider="the Postgres reader", _db_session=db_session)
    monkeypatch.setitem(app.dependency_overrides, graph.get_context_engine, lambda: reads)
    return seen, own, wm


async def test_it_reads_the_graph_itself_then_clears_the_flag_and_rebuilds_the_summaries(
        test_client, source, versioning_on, world):
    seen, own, _ = world
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 200, resp.text
    k = seen["resync"]
    assert k["provider"] is own, "it read what serves reads now, not the graph"
    assert (k["holds_main"], k["ontology_rules"], k["allow_curation_risk"]) == (
        True, "the source's rules", False)
    assert seen["steps"] == ["stamp", "resync", "clear", "rebuild"]
    assert seen["cleared"] == seen["rebuilt"] == "vg_b"


async def test_a_projection_behind_main_is_not_taken_for_it(test_client, source, versioning_on,
                                                            world):
    """Commits the projection hasn't published are not in the graph, so people's edits can
    still read back as old values: the curation check stays."""
    seen, _, wm = world
    wm["fresh"] = False
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 200, resp.text
    assert seen["resync"]["holds_main"] is False


@pytest.mark.parametrize("change", [{"status": "evicted"}, {"status": "rebuilding"},
                                    {"falkor_graph_name": "g_moved"}])
async def test_a_graph_evicted_rebuilt_or_moved_is_not_read(test_client, source, versioning_on,
                                                            world, change):
    """An evicted key is gone and one being reseeded is partial: a re-sync would take what is
    missing for deletions. A key the projection moved off is not the graph."""
    seen, _, wm = world
    wm.update(change)
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["type"] == "not_ready"
    assert seen["steps"] == []


async def test_nothing_to_bring_in_clears_the_flag_and_rebuilds_nothing(
        test_client, source, versioning_on, world, monkeypatch):
    from backend.app.services.versioning.service import GraphVersioningService

    seen, _, _ = world

    async def nothing(self, **_k):
        seen["steps"].append("resync")
        return {"commit_id": None, "applied": 0}

    monkeypatch.setattr(GraphVersioningService, "resync_from_provider", nothing)
    resp = await test_client.post(f"{GRAPH}/resync?dataSourceId=ds_b")
    assert resp.status_code == 200, resp.text
    assert seen["steps"] == ["stamp", "resync", "clear"]
