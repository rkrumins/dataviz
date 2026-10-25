"""A data source's refresh that waits for its rebuild gets an answer, not a 504.

``"wait": "complete"`` holds the answer while the queued rebuild runs (up to
``_REFRESH_WAIT_TIMEOUT_S``). Through the control plane, the proxied call is given longer than the
client's 30s for that refresh only, and the route's own deadline outlasts both: the wait ends
first, then the proxied call, then the route.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import httpx

from backend.app.api.v1.endpoints import aggregation, freshness
from backend.app.main import _TimeoutMiddleware
from backend.app.services.aggregation import service

DEFAULT = {"connect": 5.0, "read": 30.0, "write": 30.0, "pool": 30.0}


def _control_plane(monkeypatch):
    """The proxy client as built, pointed at a control plane that records each call."""
    calls = []

    def answer(request: httpx.Request) -> httpx.Response:
        calls.append((json.loads(request.content), request.extensions["timeout"]))
        return httpx.Response(200, json={"outcome": "job:completed"})

    client = httpx.AsyncClient(base_url="http://control-plane", transport=httpx.MockTransport(answer),
                               timeout=httpx.Timeout(30.0, connect=5.0))
    monkeypatch.setattr(aggregation, "_httpx_client", client)
    monkeypatch.setattr(freshness, "_PROXY_ENABLED", True)
    return calls


async def _refresh(body: dict):
    async def read():
        return json.dumps(body).encode()

    request = SimpleNamespace(body=read, query_params={})
    return await freshness.refresh_data_source("ds_1", request, user=SimpleNamespace(id="usr_ada"),
                                               svc=None, session=None)


async def test_a_refresh_that_waits_gives_the_control_plane_longer(monkeypatch):
    calls = _control_plane(monkeypatch)
    r = await _refresh({"scope": "rollups", "wait": "complete"})
    assert r.status_code == 200
    forwarded, timeout = calls[0]
    assert forwarded["wait"] == "complete" and forwarded["actor"] == "usr_ada"
    assert timeout == {"connect": 5.0, "read": 75.0, "write": 75.0, "pool": 75.0}


async def test_a_refresh_that_doesnt_wait_keeps_the_clients_timeout(monkeypatch):
    calls = _control_plane(monkeypatch)
    await _refresh({"scope": "rollups"})
    await _refresh({"scope": "rollups", "wait": "none"})
    assert [timeout for _, timeout in calls] == [DEFAULT, DEFAULT]


def test_the_wait_ends_before_the_proxied_call_and_the_proxied_call_before_the_route(monkeypatch):
    monkeypatch.delenv("HTTP_TIMEOUT_AGGREGATION_SECS", raising=False)
    route = _TimeoutMiddleware(None)._resolve_timeout("/api/v1/admin/data-sources/ds_1/refresh")
    assert service._REFRESH_WAIT_TIMEOUT_S < freshness._WAIT_COMPLETE_TIMEOUT.read < route
