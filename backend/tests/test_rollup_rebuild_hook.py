"""The projector's rollup hand-off, as the app layer wires it (``projection_target``).

An in-source data source keeps its rollups in its own graph: the projector maintains them and
hands the job only what it can't, as a run queued per projected commit. A dedicated source keeps
them in ``{graph_name}_proj``, which only the aggregation job writes, so the projector maintains
nothing there and hands over every window that changes them — signalled as a load into the source
is (change-gated, marked stale until rebuilt, one rebuild per cooldown), never a run per publish,
and never a rebuild in the wrong graph.
"""
import asyncio
import contextlib
from types import SimpleNamespace

import httpx

from backend.app.services import projection_target as pt


class _Agg:
    def __init__(self):
        self.signals, self.triggers = [], []

    async def signal_source_changed(self, ds_id, session, **kw):
        self.signals.append((ds_id, kw))

    async def trigger(self, ds_id, request, trigger_source, session):
        self.triggers.append((ds_id, request, trigger_source))


def _wire(monkeypatch, mode):
    async def _graph(self, graph_id):
        return {"data_source_id": "ds1"}

    async def _watermark(self, graph_id):
        return {"projected": 7}

    async def _mode(ds_id):
        return mode

    @contextlib.asynccontextmanager
    async def _session():
        yield object()

    monkeypatch.setattr(pt.GraphVersioningService, "get_graph", _graph)
    monkeypatch.setattr(pt.GraphVersioningService, "projection_watermark", _watermark)
    monkeypatch.setattr(pt, "_projection_mode", _mode)
    monkeypatch.setattr(pt, "get_async_session", _session)


def test_a_dedicated_source_signals_the_change_instead_of_queueing_a_run(monkeypatch):
    _wire(monkeypatch, "dedicated")
    agg = _Agg()
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: agg)("g1"))
    assert agg.signals == [("ds1", {"reason": "versioned_publish"})]
    assert agg.triggers == []


def test_an_in_source_source_still_queues_a_run_per_projected_commit(monkeypatch):
    _wire(monkeypatch, "in_source")
    agg = _Agg()
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: agg)("g1"))
    [(ds_id, request, source)] = agg.triggers
    assert (ds_id, request.idempotency_key, source) == ("ds1", "gv-rollup-rebuild:g1:7", "api")
    assert agg.signals == []


def test_without_a_service_here_the_control_plane_is_signalled(monkeypatch):
    _wire(monkeypatch, "dedicated")
    posted = []

    def _handler(request: httpx.Request):
        posted.append((request.url.path, request.content))
        return httpx.Response(200, json={})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(_handler), **kw))
    monkeypatch.setattr("backend.app.services.aggregation.internal_auth.internal_auth_headers",
                        lambda: {})
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: None)("g1"))
    assert posted == [("/aggregation/data-sources/ds1/source-changed",
                       b'{"reason":"versioned_publish"}')]


def test_a_dedicated_source_gets_the_edge_types_to_hand_over_and_no_level_map(monkeypatch):
    _wire(monkeypatch, "dedicated")

    async def _resolve(self, **kw):
        return SimpleNamespace(containment_edge_types=["CONTAINS"],
                               lineage_edge_types=["FLOWS_TO"])

    monkeypatch.setattr("backend.app.ontology.service.LocalOntologyService.resolve", _resolve)
    got = asyncio.run(pt.resolve_aggregation_edge_types(pt.GraphVersioningService(), "g1"))
    assert tuple(got) == (["CONTAINS"], ["FLOWS_TO"], {}, False)
    assert got.in_graph is False
