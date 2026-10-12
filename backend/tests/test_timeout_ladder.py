"""THE LONGER BUDGETS ONLY HELP IF THE LADDER STILL NESTS.

The read and search budgets were raised so a 10 s+ query on a very large graph
finishes instead of failing. Each raise moves a number that some other layer is
sized against, and the rule that has to survive it is the one every deadline in
this stack follows: the innermost layer that can explain a failure fires first.

    per-query budget  <  engine request cap  <  ASGI tier  <  browser  <  nginx
                  and every per-query budget < the server's TIMEOUT_MAX

These pin the backend's side of that. The browser's side is pinned by
``frontend/src/config/__tests__/timeouts.budgets.test.ts``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

import backend.app.config.resilience as R
from backend.app.main import _TimeoutMiddleware, _search_failed_handler, app
from backend.app.providers import manager as M
from backend.app.providers.falkordb_search import engine as E
from backend.app.services.deep_search import SearchFailed, get_deep_search_settings
from backend.common.adapters.circuit import CircuitBreakerProxy
from backend.common.models.search import SearchOptions

_REPO = Path(__file__).resolve().parents[2]
_CLUSTER_SHARDS = (_REPO / "deploy/k8s/overlays/production-cluster/resources"
                   / "falkordb-cluster-statefulsets.yaml")
_TIER_ENV = (
    "HTTP_TIMEOUT_HEALTH_SECS", "HTTP_TIMEOUT_AGGREGATION_SECS",
    "HTTP_TIMEOUT_TRACE_SECS", "HTTP_TIMEOUT_GRAPH_SECS",
    "HTTP_TIMEOUT_VERSIONING_SECS", "HTTP_TIMEOUT_VIEW_TRANSFER_SECS",
    "HTTP_TIMEOUT_DEFAULT_SECS",
)


@pytest.fixture
def tiers(monkeypatch) -> _TimeoutMiddleware:
    """The middleware at its shipped defaults."""
    for name in _TIER_ENV:
        monkeypatch.delenv(name, raising=False)
    return _TimeoutMiddleware(lambda *_: None)


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.delenv("DEEP_SEARCH_CHUNK_TIMEOUT_MS", raising=False)
    get_deep_search_settings.cache_clear()
    yield get_deep_search_settings()
    get_deep_search_settings.cache_clear()


def test_the_search_ladder_nests(tiers, settings):
    """A unit that is cut to fit the request stops being the budget operators
    set, and a request that outlives its tier is cancelled with its answer
    already read — the 504 then replaces the partial page it was about to
    send."""
    graph_tier = tiers._resolve_timeout("/api/v1/ws-1/graph/search/advanced")
    unit_s = settings.chunk_timeout_ms / 1000.0

    # The chunk budget is the unit's budget, and a request still has time to
    # start units before its last one has to finish.
    assert unit_s < E._REQUEST_S - 2 * E._GRACE_S
    assert E.unit_budget(settings) == unit_s
    # The request, then its page's hydration and paths, all inside the tier.
    assert E._REQUEST_S + E._HYDRATE_FLOOR_S + E._PATHS_FLOOR_S < graph_tier
    # The legacy engine and the path/aggregate templates run for the soft
    # deadline itself.
    assert SearchOptions().soft_deadline_ms / 1000.0 < graph_tier
    assert settings.chunk_timeout_ms < 120_000


def test_every_per_query_budget_is_under_the_cluster_timeout_max(settings):
    """The provider clamps a query's TIMEOUT to the server's TIMEOUT_MAX, so a
    budget above it is not rejected — it is silently cut to the cap, and the
    number an operator reads in resilience.py is no longer the one that runs.
    The production-cluster shards run the lowest cap that ships."""
    shipped = {int(v) for v in re.findall(r"\bTIMEOUT_MAX (\d+)", _CLUSTER_SHARDS.read_text())}
    assert len(shipped) == 1, f"the cluster shards disagree on TIMEOUT_MAX: {shipped}"
    timeout_max_s = shipped.pop() / 1000.0

    budgets = {
        "FALKORDB_QUERY_TIMEOUT": R.FALKORDB_QUERY_TIMEOUT_SECS,
        "FALKORDB_CHILDREN_QUERY_TIMEOUT": R.FALKORDB_CHILDREN_QUERY_TIMEOUT_SECS,
        "FALKORDB_NODES_QUERY_TIMEOUT": R.FALKORDB_NODES_QUERY_TIMEOUT_SECS,
        "FALKORDB_TOP_LEVEL_QUERY_TIMEOUT": R.FALKORDB_TOP_LEVEL_QUERY_TIMEOUT_SECS,
        "FALKORDB_EDGES_BETWEEN_TIMEOUT": R.FALKORDB_EDGES_BETWEEN_TIMEOUT_SECS,
        "FALKORDB_AGGREGATED_READ_TIMEOUT_SECS": R.FALKORDB_AGGREGATED_READ_TIMEOUT_SECS,
        "trace engine": R.TRACE_TIMEOUT_SECS - R.TRACE_ENGINE_HEADROOM_SECS,
        "DEEP_SEARCH_CHUNK_TIMEOUT_MS": settings.chunk_timeout_ms / 1000.0,
        "softDeadlineMs": SearchOptions().soft_deadline_ms / 1000.0,
    }
    over = {k: v for k, v in budgets.items() if v >= timeout_max_s}
    assert not over, f"budgets at or over TIMEOUT_MAX {timeout_max_s}s: {over}"


def test_resilience_and_the_tier_table_agree():
    """main.py reads the same env vars with its own defaults; a deployer who
    trusts resilience.py must get the tier it states. (Built from the same
    environment resilience.py was imported under, so the defaults are what is
    compared whenever the knobs are unset.)"""
    tiers = _TimeoutMiddleware(lambda *_: None)
    assert tiers._resolve_timeout("/api/v1/ws-1/graph/nodes/query") == R.HTTP_TIMEOUT_GRAPH_SECS
    assert tiers._resolve_timeout("/api/v1/ws-1/graph/trace/v2") == R.HTTP_TIMEOUT_TRACE_SECS
    assert (tiers._resolve_timeout("/api/v1/ws-1/graph/edges/aggregated")
            == R.HTTP_TIMEOUT_AGGREGATION_SECS)


def test_a_fleet_slot_outlives_every_tier_that_can_hold_one(tiers):
    """A slot still counted past ``_FLEET_SLOT_STALE_S`` is reclaimed as a
    dead process's. Were that shorter than a tier, a live, slow request would
    lose its slot mid-call and the fleet would admit past the node's threads."""
    longest = max(timeout for _prefix, timeout in tiers._tiers)
    assert M._FLEET_SLOT_STALE_S > longest


class _Provider:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def name(self) -> str:
        return "p"

    async def deep_search_session(self, *_args, **_kwargs):
        self.calls += 1
        raise SearchFailed("search failed: a walk unit ran out of time")


async def test_a_failed_search_does_not_open_the_breaker():
    """Three slow searches in a row used to open the breaker for every graph
    read on the source for 30 s. A search that could not finish is a slow
    query, not an unreachable store."""
    target = _Provider()
    proxy = CircuitBreakerProxy(target, name="p", fail_max=1)

    for _ in range(3):
        with pytest.raises(SearchFailed):
            await proxy.deep_search_session()
    assert proxy.breaker_state == "closed"
    assert target.calls == 3, "no fast-fail: every call must reach the provider"


async def test_a_failed_search_is_answered_as_a_rejected_query():
    """No longer wrapped as PROVIDER_UNAVAILABLE, a failed search must not
    fall to the catch-all (an ERROR with a traceback, a reason-less 500). It
    keeps the 500, which the client neither counts nor retries, and says why."""
    assert app.exception_handlers[SearchFailed] is _search_failed_handler
    request = SimpleNamespace(url=SimpleNamespace(path="/api/v1/ws-1/graph/search/advanced"))
    response = await _search_failed_handler(
        request, SearchFailed("search failed: a walk unit ran out of time"))

    assert response.status_code == 500
    detail = json.loads(response.body)["detail"]
    assert detail["code"] == "SEARCH_FAILED"
    assert detail["technical"] == "search failed: a walk unit ran out of time"
