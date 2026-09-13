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


# ── invalidate once per change, not once per detection ──────────────────
#
# `graph_fingerprint` only advances when a rebuild COMPLETES. While one is
# deferred by the rebuild cooldown the change gate keeps answering "changed"
# on every reconcile sweep, and each pass used to bump the cache generation
# again — making every entry re-warmed since unreachable. Against a 30s tick
# and a 900s cooldown that is thirty invalidations for one change, and a
# cache whose effective life is the detection cadence rather than its TTL.


def test_the_same_change_is_only_invalidated_for_once():
    import inspect

    from backend.app.services.aggregation.service import AggregationService

    src = inspect.getsource(AggregationService.signal_source_changed)
    flat = " ".join(src.split())

    # The decision reads what we already threw the cache away for…
    assert "already = getattr(state, \"invalidated_fingerprint\", None)" in flat
    assert "reinvalidate = force or not fingerprints_match(already, current_fp)" in flat
    # …and BOTH cache-clearing actions are gated on it.
    assert "if provider is not None and reinvalidate:" in flat
    assert "if workspace_id and reinvalidate:" in flat
    # …and the fingerprint is recorded when we do invalidate, or the next
    # tick repeats it.
    assert "state.invalidated_fingerprint = current_fp" in flat


def test_a_forced_signal_still_invalidates():
    """`force` is the operator saying "do it anyway" — it bypasses the
    cooldown, and it has to bypass this too or a manual Refresh caches on an
    unchanged source would do nothing."""
    import inspect

    from backend.app.services.aggregation.service import AggregationService

    flat = " ".join(inspect.getsource(AggregationService.signal_source_changed).split())
    assert "reinvalidate = force or not" in flat


def test_the_marker_and_the_rebuild_are_not_gated_on_it():
    """Only the cache bump is skipped. The stale marker must stay set and the
    rebuild must still be queued when the cooldown allows, or a deferred
    source would stop being honestly stale."""
    import inspect

    from backend.app.services.aggregation.service import AggregationService

    src = inspect.getsource(AggregationService.signal_source_changed)
    gate = src.index("reinvalidate = force or not")
    assert src.index("mark_source_stale") < gate, "the marker is set before the gate"
    assert src.index("self._within_rebuild_cooldown") > gate, (
        "the rebuild decision is downstream and untouched"
    )
