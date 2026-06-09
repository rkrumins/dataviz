"""project_now contract: synchronous read-your-writes projection that NEVER fails the write.

After an interactive main-advancing op (publish / merge / revert) the endpoint calls
``project_now(graph_id)`` to refresh the FalkorDB cache *before returning*, so the change is
visible on the fast read path immediately. It must:
  (a) refresh via the projector on the happy path (no async fallback);
  (b) when FalkorDB is unconfigured, just nudge the async worker;
  (c) on ANY projector failure, swallow the error and nudge — the Postgres commit already
      succeeded, so the op must still return success.

Pure unit test of the helper — no Postgres / FalkorDB needed.
"""
import asyncio

from backend.app.api.v1.endpoints import versioning as V


class _OkProjector:
    def __init__(self):
        self.calls = []

    async def project_graph(self, gid):
        self.calls.append(gid)
        return {"projected": 1, "applied": 1, "noop": False}


class _BoomProjector:
    async def project_graph(self, gid):
        raise RuntimeError("falkor down")


def _patch_nudge(monkeypatch, sink):
    async def _nudge(gid):
        sink.append(gid)
    monkeypatch.setattr(V, "nudge_projection", _nudge)


def test_project_now_success_refreshes_without_nudge(monkeypatch):
    ok, nudged = _OkProjector(), []
    monkeypatch.setattr(V, "_projector", ok)            # projector available + healthy
    _patch_nudge(monkeypatch, nudged)
    asyncio.run(V.project_now("g1"))
    assert ok.calls == ["g1"] and nudged == []          # projected synchronously; no async fallback


def test_project_now_no_falkor_defers_to_async(monkeypatch):
    nudged = []
    monkeypatch.setattr(V, "_projector", None)
    monkeypatch.setattr(V, "get_falkor_read_factory", lambda: None)   # FalkorDB unconfigured
    _patch_nudge(monkeypatch, nudged)
    asyncio.run(V.project_now("g2"))
    assert nudged == ["g2"]                              # nothing to project now → nudge the worker


def test_project_now_failure_swallows_and_nudges(monkeypatch):
    nudged = []
    monkeypatch.setattr(V, "_projector", _BoomProjector())   # projection raises (e.g. FalkorDB down)
    _patch_nudge(monkeypatch, nudged)
    asyncio.run(V.project_now("g3"))                    # MUST NOT raise — the commit already landed
    assert nudged == ["g3"]                              # failure → async fallback
