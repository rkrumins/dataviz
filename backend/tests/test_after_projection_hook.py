"""Every read cache converges once committed main lands in FalkorDB — whatever put it there.

The response cache was bumped at COMMIT time by the publish endpoints, before the projection
ran: a read in between recomputed from the still-old graph and cached that under the new
generation for an hour. Bulk ingest and sync commits never bumped at all, and a rebuild or heal
never did either. The projector's post-projection hook is the one place every such path ends,
so that is where the content generation is bumped, and the insights refresh
(which also marks the materialised top-level payload dirty) is nudged.
"""
import asyncio

from backend.app.services import projection_target as pt


class _Cache:
    def __init__(self):
        self.content, self.rollup = [], []

    async def bump_generation(self, scope):
        self.content.append((scope.workspace_id, scope.data_source_id))

    async def bump_rollup_generation(self, scope):
        self.rollup.append((scope.workspace_id, scope.data_source_id))


def test_a_landed_projection_invalidates_every_cached_read(monkeypatch):
    cache = _Cache()
    nudged = []

    async def _ws_of(ds):
        return "ws1"

    async def _nudge(ds):
        nudged.append(ds)

    monkeypatch.setattr(pt, "_workspace_of", _ws_of)
    monkeypatch.setattr(pt, "nudge_stats_after_projection", _nudge)
    monkeypatch.setattr("backend.app.services.graph_cache.get_graph_cache", lambda: cache)
    asyncio.run(pt.after_projection("ds1"))
    # One content bump: rollup-endpoint keys embed the content counter ("content.rollup").
    assert cache.content == [("ws1", "ds1")] and cache.rollup == []
    assert nudged == ["ds1"]


def test_a_cache_failure_never_escapes(monkeypatch):
    async def _ws_of(ds):
        return "ws1"

    async def _nudge(ds):
        return None

    def _broken():
        raise ConnectionError("cache down")

    monkeypatch.setattr(pt, "_workspace_of", _ws_of)
    monkeypatch.setattr(pt, "nudge_stats_after_projection", _nudge)
    monkeypatch.setattr("backend.app.services.graph_cache.get_graph_cache", _broken)
    asyncio.run(pt.after_projection("ds1"))
