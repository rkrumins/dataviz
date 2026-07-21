"""Unit tests for the loader convergence helper
(``backend.scripts.signal_data_changed``): the reusable core that POSTs the
unified ``refresh`` verb, plus the best-effort ``emit_after_load`` /
``emit_after_load_async`` wrappers the seed/import scripts call after a direct
FalkorDB load. httpx + the ds-id resolution are faked; what's under test is
the URL/payload shaping, graph→ds resolution, and the never-raise contract.
"""
import asyncio

import pytest

from backend.scripts import signal_data_changed as sdc


def _run(coro):
    return asyncio.run(coro)


class _FakeResp:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data or {}
        self.text = text

    def json(self):
        return self._json


def _patch_client(monkeypatch, resp):
    """Replace httpx.AsyncClient with a stand-in that records the POST and
    returns ``resp``; returns the captured-call dict."""
    captured: dict = {}

    class _Client:
        def __init__(self, *a, headers=None, **k):
            captured["headers"] = headers

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None, timeout=None):
            captured["url"] = url
            captured["json"] = json
            captured["timeout"] = timeout
            return resp

    monkeypatch.setattr(sdc.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(sdc, "internal_auth_headers", lambda: {"Authorization": "Bearer x"})
    return captured


# ── core: signal_data_changed ───────────────────────────────────────────


def test_posts_refresh_for_data_source_id(monkeypatch):
    cap = _patch_client(monkeypatch, _FakeResp(200, {"changed": True, "jobId": "job-1"}))
    out = _run(sdc.signal_data_changed(
        data_source_id="ds-1", scope="auto", reason="external_load",
    ))
    assert out == {"changed": True, "jobId": "job-1"}
    assert cap["url"].endswith("/aggregation/data-sources/ds-1/refresh")
    assert cap["json"] == {
        "scope": "auto", "reason": "external_load", "force": False,
        "origin": "script",
    }
    assert cap["headers"] == {"Authorization": "Bearer x"}


def test_resolves_graph_name_to_ds_id(monkeypatch):
    async def _resolve(graph):
        return "ds-42" if graph == "mygraph" else None
    monkeypatch.setattr(sdc, "_resolve_ds_id", _resolve)
    cap = _patch_client(monkeypatch, _FakeResp(200, {"changed": True}))

    _run(sdc.signal_data_changed(graph_name="mygraph", force=True))

    assert cap["url"].endswith("/aggregation/data-sources/ds-42/refresh")
    assert cap["json"]["force"] is True


def test_unresolved_graph_name_raises_lookuperror(monkeypatch):
    async def _resolve(graph):
        return None
    monkeypatch.setattr(sdc, "_resolve_ds_id", _resolve)
    _patch_client(monkeypatch, _FakeResp(200, {}))
    with pytest.raises(LookupError):
        _run(sdc.signal_data_changed(graph_name="ghost"))


def test_missing_target_raises_valueerror(monkeypatch):
    _patch_client(monkeypatch, _FakeResp(200, {}))
    with pytest.raises(ValueError):
        _run(sdc.signal_data_changed())


def test_http_error_status_raises_runtimeerror(monkeypatch):
    _patch_client(monkeypatch, _FakeResp(500, {}, text="boom"))
    with pytest.raises(RuntimeError):
        _run(sdc.signal_data_changed(data_source_id="ds-1"))


# ── best-effort wrappers: emit_after_load[_async] ───────────────────────


def test_emit_after_load_returns_true_on_success(monkeypatch):
    async def _ok(**kwargs):
        return {"changed": True}
    monkeypatch.setattr(sdc, "signal_data_changed", _ok)
    monkeypatch.delenv("DATAVIZ_SKIP_LOAD_SIGNAL", raising=False)
    assert sdc.emit_after_load(data_source_id="ds-1") is True


def test_emit_after_load_swallows_errors(monkeypatch):
    async def _boom(**kwargs):
        raise RuntimeError("control plane down")
    monkeypatch.setattr(sdc, "signal_data_changed", _boom)
    monkeypatch.delenv("DATAVIZ_SKIP_LOAD_SIGNAL", raising=False)
    # A dead control plane must NOT fail the load — returns False, never raises.
    assert sdc.emit_after_load(graph_name="g") is False


def test_emit_after_load_skips_when_env_set(monkeypatch):
    called = {"n": 0}

    async def _sig(**kwargs):
        called["n"] += 1
        return {"changed": True}
    monkeypatch.setattr(sdc, "signal_data_changed", _sig)
    monkeypatch.setenv("DATAVIZ_SKIP_LOAD_SIGNAL", "1")
    assert sdc.emit_after_load(graph_name="g") is False
    assert called["n"] == 0  # opt-out: the signal is never attempted


def test_emit_after_load_async_swallows_errors(monkeypatch):
    async def _boom(**kwargs):
        raise RuntimeError("x")
    monkeypatch.setattr(sdc, "signal_data_changed", _boom)
    monkeypatch.delenv("DATAVIZ_SKIP_LOAD_SIGNAL", raising=False)
    assert _run(sdc.emit_after_load_async(graph_name="g")) is False
