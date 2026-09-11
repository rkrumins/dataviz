"""REFRESHING A CACHE FROM THE UI IS A LOADED GUN, SO THE DEFAULTS MATTER.

`POST /graph-store/cache/refresh` makes the next read of every view on a data
source rebuild from the store. That is the right tool when something changed
the graph WITHOUT going through the app — a direct GRAPH.QUERY, an external
loader, a restore — because those are exactly the writes that do not bump the
generation on their own.

Two properties decide whether it is safe to put in front of an operator:

* It must INVALIDATE, not delete. A generation bump makes every entry
  unreachable at once, so there is no window where some pods answer from the
  old generation and others from the new, and no SCAN over the keyspace.
* It must KEEP the last-known-good snapshots by default. The LKG is what
  answers a read while the provider cannot; dropping it turns the next
  outage from a stale answer into an error. Clearing it is a separate,
  deliberate choice.
"""
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.api.v1.endpoints import graph_store as gs


class _Cache:
    def __init__(self):
        self.bumped = []
        self.purged_scopes = []

    async def bump_generation(self, scope):
        self.bumped.append(scope)

    async def purge_lkg_scope(self, scope, **kw):
        self.purged_scopes.append(scope)
        return 7


@pytest.mark.asyncio
async def test_refresh_bumps_the_generation_for_the_branchless_scope():
    cache = _Cache()
    with patch.object(gs, "get_graph_cache", return_value=cache):
        out = await gs.refresh_cache(workspaceId="ws1", dataSourceId="ds1")

    assert len(cache.bumped) == 1
    scope = cache.bumped[0]
    assert (scope.workspace_id, scope.data_source_id, scope.branch_id) == ("ws1", "ds1", "")
    assert out["invalidated"] is True


@pytest.mark.asyncio
async def test_the_outage_fallback_survives_by_default():
    """The default has to be the safe one. An operator reaching for 'refresh'
    wants the next read to be fresh — not to discover during the next incident
    that the thing which would have answered is gone."""
    cache = _Cache()
    with patch.object(gs, "get_graph_cache", return_value=cache):
        out = await gs.refresh_cache(workspaceId="ws1", dataSourceId="ds1")

    assert cache.purged_scopes == [], "LKG must not be purged unless asked"
    assert out["fallbackEntriesPurged"] == 0

    # Calling the handler directly bypasses FastAPI's default resolution, so
    # the DECLARED default is what an operator actually gets — assert that.
    import inspect

    declared = inspect.signature(gs.refresh_cache).parameters["keepFallback"].default
    assert getattr(declared, "default", declared) is True, (
        "keepFallback must default to True: an operator reaching for 'refresh' "
        "wants the next read fresh, not to discover during the next incident "
        "that the thing which would have answered is gone"
    )


@pytest.mark.asyncio
async def test_clearing_the_fallback_is_possible_and_reported():
    """There is a real case for it — genuinely wrong data that must not be
    served again, from any path — so it exists, says what it did, and is
    never the default."""
    cache = _Cache()
    with patch.object(gs, "get_graph_cache", return_value=cache):
        out = await gs.refresh_cache(
            workspaceId="ws1", dataSourceId="ds1", keepFallback=False,
        )

    assert len(cache.purged_scopes) == 1
    assert out["fallbackKept"] is False
    assert out["fallbackEntriesPurged"] == 7


@pytest.mark.asyncio
async def test_refresh_does_not_scan_or_delete_the_primary_keyspace():
    """Invalidation is a single INCR. A refresh that SCANned and DELETEd would
    cost the bus proportionally to how much was cached — worst on the busiest
    source, which is the one most likely to be refreshed."""
    cache = _Cache()
    cache.scan = AsyncMock(side_effect=AssertionError("must not scan"))
    cache.delete = AsyncMock(side_effect=AssertionError("must not delete"))
    with patch.object(gs, "get_graph_cache", return_value=cache):
        await gs.refresh_cache(workspaceId="ws1", dataSourceId="ds1")


def test_the_route_is_admin_gated():
    route = next(r for r in gs.router.routes if getattr(r, "path", "") == "/cache/refresh")
    assert "POST" in route.methods
    assert route.dependencies, "cache refresh must not be reachable unauthenticated"
