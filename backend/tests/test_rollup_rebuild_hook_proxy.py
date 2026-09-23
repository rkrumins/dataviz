"""The projector's rollup hand-off must reach the aggregation service in EVERY runtime.

In the deployed topology the web tier runs aggregation in proxy mode: it holds no
AggregationService, only the control plane's URL. The hook used to log "not auto-queued"
there and do nothing — so after the 2026-09-22 heal the rollups were never rebuilt, and the
reconcile sweeper skipped the source too, trusting the projector to have queued it.
With no in-process service the hook now queues the job on the control plane, over the
same internal-auth HTTP route the insights purge uses.
"""
import asyncio

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
            return {"data_source_id": "ds_1"}

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


def test_dedicated_mode_still_queues_nothing(monkeypatch):
    _patch(monkeypatch, mode="dedicated")
    asyncio.run(pt.make_rollup_rebuild_hook(lambda: None)("graph_1"))
    assert [c for c in _Client.calls if c[0] == "post"] == []
