"""A graph request that only waits holds nothing while it waits
(``services/graph_waits``): its admission is given back and its connection
returned to the pool, for a wait on a scan or an answer another request does."""
from __future__ import annotations

import asyncio

import pytest

from backend.app.providers.manager import ProviderManager
from backend.app.services import graph_waits


@pytest.fixture
def limits(monkeypatch):
    from backend.app.providers import manager as manager_mod

    monkeypatch.setattr(manager_mod, "_graph_inflight_limits", lambda: (2, 1))


async def _admitted(monkeypatch, mgr, ws="ws1", ds="dsA"):
    """A request's admission dependency, entered: what a route runs inside."""
    from backend.app.api.v1.endpoints import graph as graph_mod

    monkeypatch.setattr(graph_mod, "provider_manager", mgr)
    gen = graph_mod._admit_graph_request(ws_id=ws, dataSourceId=ds)
    await gen.asend(None)
    return gen


async def _finish(gen):
    with pytest.raises(StopAsyncIteration):
        await gen.asend(None)


class _Session:
    def __init__(self, *, pending=False):
        self.new = {object()} if pending else set()
        self.dirty: set = set()
        self.deleted: set = set()
        self.open = True
        self.commits = 0

    def in_transaction(self):
        return self.open

    async def commit(self):
        self.commits += 1
        self.open = False


async def test_outside_a_request_a_wait_holds_and_lets_go_of_nothing():
    async with graph_waits.waiting():
        pass


async def test_a_waiting_request_gives_its_admission_back_and_takes_it_again(monkeypatch):
    from backend.app.providers import manager as manager_mod

    monkeypatch.setattr(manager_mod, "_graph_inflight_limits", lambda: (1, 1))   # room for one
    mgr = ProviderManager()
    gen = await _admitted(monkeypatch, mgr)
    assert mgr._graph_inflight_total == 1
    async with graph_waits.waiting():
        assert mgr._graph_inflight_total == 0, "held while it only waited"
        # Another request is admitted into the room it left.
        mgr.admit_graph_request("ws1/dsB")
    # Taken back without being refused, though the room is full now.
    assert mgr._graph_inflight_total == 2
    await _finish(gen)
    assert mgr._graph_inflight == {"ws1/dsB": 1}


async def test_a_wait_inside_a_wait_gives_nothing_back_twice(limits, monkeypatch):
    mgr = ProviderManager()
    gen = await _admitted(monkeypatch, mgr)
    async with graph_waits.waiting():
        async with graph_waits.waiting():
            assert mgr._graph_inflight_total == 0
        assert mgr._graph_inflight_total == 0
    assert mgr._graph_inflight_total == 1
    await _finish(gen)
    assert mgr._graph_inflight_total == 0


async def test_a_request_that_ends_mid_wait_releases_once(limits, monkeypatch):
    mgr = ProviderManager()
    gen = await _admitted(monkeypatch, mgr)
    with pytest.raises(asyncio.CancelledError):
        async with graph_waits.waiting():
            raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await gen.athrow(asyncio.CancelledError())
    assert mgr._graph_inflight_total == 0 and mgr._graph_inflight == {}


async def test_its_connection_goes_back_to_the_pool_when_nothing_is_pending():
    clean, busy = _Session(), _Session(pending=True)
    token = graph_waits.hold(graph_waits.session_step_out(clean))
    graph_waits.hold(graph_waits.session_step_out(busy))
    try:
        async with graph_waits.waiting():
            assert not clean.in_transaction() and clean.commits == 1
            # Unflushed changes are the route's to commit, never a wait's.
            assert busy.in_transaction() and busy.commits == 0
    finally:
        graph_waits.let_go(token)
    async with graph_waits.waiting():
        pass
    assert clean.commits == 1, "let go of: no longer this request's"


async def test_a_wait_on_another_requests_scan_holds_nothing(limits, monkeypatch):
    from backend.app.providers.falkordb_search.session import wait_for_commit

    mgr = ProviderManager()
    gen = await _admitted(monkeypatch, mgr)
    seen = []

    class _Store:
        async def load(self, sid):
            seen.append(mgr._graph_inflight_total)

    import time
    await wait_for_commit(_Store(), "s1", None, time.monotonic() + 0.05, poll_s=0.01)
    assert seen and set(seen) == {0}
    assert mgr._graph_inflight_total == 1
    await _finish(gen)


async def test_riding_another_requests_compute_holds_nothing(monkeypatch):
    """The graph cache's followers in this process wait on the leader's compute
    holding no admission; the leader keeps its own."""
    import fakeredis.aioredis

    from backend.app.providers import manager as manager_mod
    from backend.app.services import graph_cache as graph_cache_mod
    from backend.app.services.graph_cache import CacheScope, GraphCache
    from backend.common.models.graph import GraphNode  # any model the cache can carry

    monkeypatch.setattr(manager_mod, "_graph_inflight_limits", lambda: (8, 2))
    monkeypatch.setitem(graph_cache_mod._ENABLED_ENDPOINTS, graph_cache_mod.ENDPOINT_TOP_LEVEL, True)
    mgr = ProviderManager()
    cache = GraphCache(fakeredis.aioredis.FakeRedis())
    started = asyncio.Event()
    release = asyncio.Event()
    seen = []

    async def compute():
        started.set()
        await release.wait()
        return GraphNode(urn="urn:x", entity_type="t", display_name="x")

    scope = CacheScope(workspace_id="ws1", data_source_id="dsA")

    async def request():
        gen = await _admitted(monkeypatch, mgr)
        try:
            return await cache.get_or_compute(scope=scope, endpoint=graph_cache_mod.ENDPOINT_TOP_LEVEL,
                                              params={"u": "x"}, compute=compute, model_cls=GraphNode)
        finally:
            await _finish(gen)

    leader = asyncio.ensure_future(request())
    await started.wait()
    follower = asyncio.ensure_future(request())
    await asyncio.sleep(0.05)
    seen.append(mgr._graph_inflight_total)
    release.set()
    assert (await leader).urn == (await follower).urn == "urn:x"
    assert seen == [1], "only the leader, computing, is admitted"
    assert mgr._graph_inflight_total == 0
    graph_cache_mod.reset_graph_cache_for_tests()
