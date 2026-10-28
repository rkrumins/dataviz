"""The projector's rollup hand-off must reach the aggregation service in EVERY runtime.

In the deployed topology the web tier runs aggregation in proxy mode: it holds no
AggregationService, only the control plane's URL. The hook used to log "not auto-queued"
there and do nothing — so after the 2026-09-22 heal the rollups were never rebuilt, and the
reconcile sweeper skipped the source too, trusting the projector to have queued it.
With no in-process service the hook now queues the job on the control plane, over the
same internal-auth HTTP route the insights purge uses.

And in either placement of the summaries: a data source whose summaries live in a dedicated key,
which the projector never writes, is marked stale after a publish that changes its lineage, and
its rebuild is queued in that mode.
"""
import asyncio
import contextlib
from types import SimpleNamespace

import pytest

from backend.app.services import graph_cache
from backend.app.services import projection_target as pt


class _Resp:
    status_code = 202

    def json(self):
        return {"id": "agg_1"}


class _Client:
    calls: list = []

    def __init__(self, **kw):
        _Client.calls.append(("init", kw))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, params=None, json=None):
        _Client.calls.append(("post", url, params, json))
        return _Resp()


def _patch(monkeypatch, mode="in_source"):
    class _Svc:
        async def get_graph(self, graph_id):
            return {"data_source_id": "ds_1", "workspace_id": "ws_1"}

        async def projection_watermark(self, graph_id):
            return {"projected": 8}

    async def _mode(_ds):
        return mode

    import httpx
    _Client.calls = []
    monkeypatch.setattr(pt, "GraphVersioningService", _Svc)
    monkeypatch.setattr(pt, "_projection_mode", _mode)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    monkeypatch.setenv("AGGREGATION_SERVICE_URL", "http://controlplane:8091")


def test_proxy_mode_queues_the_job_on_the_control_plane(monkeypatch):
    _patch(monkeypatch)
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: None)("graph_1"))
    posts = [c for c in _Client.calls if c[0] == "post"]
    assert posts == [(
        "post", "/aggregation/data-sources/ds_1/jobs", {"triggerSource": "api"},
        {"projectionMode": "in_source", "idempotencyKey": "gv-rollup-rebuild:graph_1:8"},
    )]
    init = [c for c in _Client.calls if c[0] == "init"][0][1]
    assert init["base_url"] == "http://controlplane:8091"
    assert "headers" in init                              # internal service auth


def _marked(monkeypatch):
    marked = []

    async def mark(workspace_id, data_source_id, reason="source_changed"):
        marked.append((workspace_id, data_source_id, reason))

    monkeypatch.setattr(graph_cache, "mark_source_stale", mark)
    return marked


async def _dedicated(svc, graph_id):            # resolve_aggregation_edge_types, for such a source
    return (["CONTAINS"], ["FLOWS"], {}, "dedicated")


def test_a_dedicated_source_is_marked_stale_and_rebuilt_in_its_mode_after_lineage_changes(
        monkeypatch):
    from backend.tests.test_projection_dedicated_rollups import run_window

    _patch(monkeypatch, mode="dedicated")
    marked = _marked(monkeypatch)
    hook = pt.make_rollup_rebuild_hook(lambda: None)
    flows = {"sourceEntityId": "a3", "targetEntityId": "b3", "edgeType": "FLOWS"}

    # A publish that changes no lineage or containment edge: nothing to rebuild.
    run_window(monkeypatch, [("e1", "update", {**flows, "weight": 2})], before={"e1": flows},
               resolver=_dedicated, on_rollups_stale=hook)
    assert [c for c in _Client.calls if c[0] == "post"] == [] and marked == []

    # One that adds a lineage edge: the summaries are behind the graph until the job rebuilds them.
    run_window(monkeypatch, [("e1", "create", flows)], resolver=_dedicated, on_rollups_stale=hook)
    assert marked == [("ws_1", "ds_1", "source_changed")]
    assert [c for c in _Client.calls if c[0] == "post"] == [(
        "post", "/aggregation/data-sources/ds_1/jobs", {"triggerSource": "api"},
        {"projectionMode": "dedicated", "idempotencyKey": "gv-rollup-rebuild:graph_1:8"},
    )]


@pytest.mark.parametrize("mode", ["in_source", "dedicated"])
def test_in_process_the_rebuild_is_queued_in_the_sources_mode(monkeypatch, mode):
    _patch(monkeypatch, mode=mode)
    marked, queued = _marked(monkeypatch), []

    class _Agg:
        async def trigger(self, ds_id, request, trigger_source, session):
            queued.append((ds_id, request.projection_mode, request.idempotency_key,
                           trigger_source))

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(pt, "get_async_session", session)
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: _Agg())("graph_1"))
    assert queued == [("ds_1", mode, "gv-rollup-rebuild:graph_1:8", "api")]
    # In the source's own graph the projector keeps the summaries current, and hands off only
    # what it cannot: no marker there.
    assert marked == ([("ws_1", "ds_1", "source_changed")] if mode == "dedicated" else [])


@pytest.mark.parametrize("mode, types", [
    ("in_source", (["CONTAINS"], ["FLOWS"], {"Dataset": 1})),
    ("dedicated", (["CONTAINS"], ["FLOWS"], {}, "dedicated")),
])
def test_the_edge_types_mark_a_dedicated_source(monkeypatch, mode, types):
    from backend.app.ontology import service as ontology_service
    from backend.app.ontology.adapters import sqlalchemy_repo
    from backend.app.services import ontology_levels

    class _Ontology:
        def __init__(self, repo):
            pass

        async def resolve(self, *, workspace_id, data_source_id):
            return SimpleNamespace(containment_edge_types=["CONTAINS"],
                                   lineage_edge_types=["FLOWS"])

    class _Svc:
        async def get_graph(self, graph_id):
            return {"data_source_id": "ds_1", "workspace_id": "ws_1"}

    async def _mode(_ds):
        return mode

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(pt, "_projection_mode", _mode)
    monkeypatch.setattr(pt, "get_async_session", session)
    monkeypatch.setattr(ontology_service, "LocalOntologyService", _Ontology)
    monkeypatch.setattr(sqlalchemy_repo, "SQLAlchemyOntologyRepository", lambda s: None)
    monkeypatch.setattr(ontology_levels, "derive_level_map", lambda resolved: {"Dataset": 1})
    assert asyncio.run(pt.resolve_aggregation_edge_types(_Svc(), "graph_1")) == types
