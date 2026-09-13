"""
One unhealthy data source must not take the graph down for the other four.

Every graph request checks out a GRAPH_READ DB session in
``get_context_engine`` and holds it across the whole outbound FalkorDB call.
That pool is per process and SHARED BY EVERY DATA SOURCE — 10+10 sessions by
default. A data source that is merely slow is deliberately never gated (that
was the "graph is offline" false positive), so its requests keep arriving and
each one pins a session for up to its 20s query budget. Five sources
configured, one slow: it fills all 20 sessions on a worker, and requests for
the four healthy sources wait ``DB_POOL_TIMEOUT_SECS`` (10s) for a session
that never frees, then fail with a generic 503.

The gate these tests pin admits at the door, BEFORE a session is taken, and
gives every source a reserved share it is never refused:

  1. A saturated source is shed with ProviderBusy (429 + Retry-After), which
     the canvas retries in place.
  2. Its neighbours keep being admitted — that is the whole point.
  3. Nothing is admitted past the hard ceiling, which stays under the pool so
     a checkout never waits on the 10s pool timeout.
  4. The gate runs before the session dependency, and releases on every exit
     path including an exception.
"""
from __future__ import annotations

import asyncio
import time

import pytest

from backend.app.providers import manager as manager_mod
from backend.app.providers.manager import ProviderManager
from backend.common.adapters import ProviderBusy


@pytest.fixture
def limits(monkeypatch):
    """Small, explicit limits: ceiling 14, reserved share 2."""
    monkeypatch.setattr(manager_mod, "_graph_inflight_limits", lambda: (14, 2))


def _admit_n(mgr: ProviderManager, key: str, n: int) -> None:
    for _ in range(n):
        mgr.admit_graph_request(key)


# ── 1. A source over its share is shed, not queued ─────────────────────


def _seen(mgr: ProviderManager, *sources: str) -> None:
    """Make each source one this process serves, with nothing in flight — a
    workspace whose users are between clicks."""
    for source in sources:
        mgr.admit_graph_request(source)
        mgr.release_graph_request(source)


def test_a_source_over_its_share_is_shed_while_neighbours_need_room(limits) -> None:
    mgr = ProviderManager()
    # Four neighbours this process serves: their reserves (4 × 2 = 8) are held
    # back, leaving 6 of the ceiling's 14 for the bursting source.
    _seen(mgr, "ws1/dsB", "ws2/dsC", "ws3/dsD", "ws4/dsE")
    _admit_n(mgr, "ws1/dsA", 6)

    with pytest.raises(ProviderBusy) as exc_info:
        mgr.admit_graph_request("ws1/dsA")

    assert exc_info.value.retry_after_seconds == 1
    assert "share" in exc_info.value.reason
    assert mgr.stats["graph_shed_over_share"] == 1


def test_one_source_alone_uses_the_whole_ceiling(limits) -> None:
    """Nothing is held back for neighbours that do not exist: the common
    single-source deployment must not be throttled by the isolation gate."""
    mgr = ProviderManager()
    _admit_n(mgr, "ws1/only", 14)

    with pytest.raises(ProviderBusy) as exc_info:
        mgr.admit_graph_request("ws1/only")
    assert "maximum number of graph reads" in exc_info.value.reason
    assert mgr.stats["graph_shed_over_share"] == 0, "the shed is the ceiling, not a share"


def test_a_source_below_its_reserved_share_is_never_refused(limits) -> None:
    """The guarantee, in the reported shape: one source saturates first and
    the neighbours arrive COLD afterwards — which is what happens when a data
    source has been slow for a while before anyone opens a view on another.
    Each still gets its full reserved share."""
    mgr = ProviderManager()
    _seen(mgr, "ws1/dsB", "ws2/dsC", "ws3/dsD", "ws4/dsE")
    _admit_n(mgr, "ws1/dsA", 6)
    with pytest.raises(ProviderBusy):
        mgr.admit_graph_request("ws1/dsA")

    for source in ("ws1/dsB", "ws2/dsC", "ws3/dsD", "ws4/dsE"):
        _admit_n(mgr, source, 2)
        assert mgr._graph_inflight[source] == 2

    assert mgr._graph_inflight_total == 14
    assert mgr.stats["graph_shed_over_share"] == 1


def test_the_hard_ceiling_stops_even_reserved_admissions(limits) -> None:
    """The pool invariant: nothing is admitted past hard, so a checkout never
    waits on the 10s pool timeout — not even a source claiming its share."""
    mgr = ProviderManager()
    _admit_n(mgr, "ws1/dsA", 6)
    for source in ("ws1/dsB", "ws1/dsC", "ws1/dsD", "ws1/dsE"):
        _admit_n(mgr, source, 2)        # four reserved shares → total 14 = hard

    with pytest.raises(ProviderBusy) as exc_info:
        mgr.admit_graph_request("ws1/dsF")   # nothing in flight, still refused
    assert "maximum number of graph reads" in exc_info.value.reason
    assert mgr.stats["graph_shed_process_full"] == 1
    assert mgr._graph_inflight_total == 14


def test_a_source_that_goes_quiet_stops_holding_capacity(limits) -> None:
    """The reserve is sized from the sources this process actually serves. One
    removed from the deployment — or simply unused — must stop holding room
    within the recency window, or a shrinking fleet would keep the survivors
    throttled forever."""
    mgr = ProviderManager()
    _seen(mgr, "ws1/dsB")
    _admit_n(mgr, "ws1/dsA", 12)          # 14 − 1 neighbour × 2
    with pytest.raises(ProviderBusy):
        mgr.admit_graph_request("ws1/dsA")

    # dsB's last request ages out of the window.
    mgr._graph_recent["ws1/dsB"] = time.monotonic() - manager_mod._GRAPH_SOURCE_RECENT_S - 1
    mgr.admit_graph_request("ws1/dsA")
    assert mgr._graph_inflight["ws1/dsA"] == 13
    assert "ws1/dsB" not in mgr._graph_recent, "the stale entry is pruned on the same pass"


# ── 2. Release ─────────────────────────────────────────────────────────


def test_release_frees_capacity_for_the_same_source(limits) -> None:
    mgr = ProviderManager()
    _admit_n(mgr, "ws1/dsA", 14)
    with pytest.raises(ProviderBusy):
        mgr.admit_graph_request("ws1/dsA")

    mgr.release_graph_request("ws1/dsA")
    mgr.admit_graph_request("ws1/dsA")   # room again
    assert mgr._graph_inflight["ws1/dsA"] == 14


def test_release_drops_the_key_and_never_goes_negative(limits) -> None:
    mgr = ProviderManager()
    mgr.admit_graph_request("ws1/dsA")
    mgr.release_graph_request("ws1/dsA")
    assert "ws1/dsA" not in mgr._graph_inflight
    assert mgr._graph_inflight_total == 0

    mgr.release_graph_request("ws1/dsA")   # unpaired release must not underflow
    assert mgr._graph_inflight_total == 0


def test_peak_is_recorded_for_the_health_endpoint(limits) -> None:
    mgr = ProviderManager()
    _admit_n(mgr, "ws1/dsA", 3)
    _admit_n(mgr, "ws1/dsB", 2)
    for _ in range(5):
        mgr.release_graph_request("ws1/dsA")
    assert mgr.stats["graph_inflight_peak"] == 5


# ── 3. The derived limits stay inside the pool ─────────────────────────


def test_limits_are_derived_from_the_graph_read_pool_and_stay_under_it() -> None:
    """Derived, not hard-coded, so resizing the pool moves the gate with it —
    and hard must stay strictly under the pool or the gate would admit a
    request that then blocks on pool_timeout."""
    from backend.app.db.engine import graph_read_pool_capacity

    pool = graph_read_pool_capacity()
    hard, reserved = manager_mod._graph_inflight_limits()

    assert hard < pool, "the hard ceiling must leave the pool headroom"
    assert 1 <= reserved < hard


def test_a_saturated_source_cannot_starve_its_neighbours_at_shipped_defaults() -> None:
    """The reported shape, with no monkeypatched limits: five data sources,
    one slow enough to occupy everything it is allowed. The other four must
    still be admitted."""
    hard, reserved = manager_mod._graph_inflight_limits()
    mgr = ProviderManager()
    _seen(mgr, "ws1/a", "ws1/b", "ws1/c", "ws1/d")

    for _ in range(hard):
        try:
            mgr.admit_graph_request("ws1/slow")
        except ProviderBusy:
            break
    with pytest.raises(ProviderBusy):
        mgr.admit_graph_request("ws1/slow")

    for source in ("ws1/a", "ws1/b", "ws1/c", "ws1/d"):
        for _ in range(reserved):
            mgr.admit_graph_request(source)     # must not raise
        assert mgr._graph_inflight[source] == reserved


def test_limits_honour_explicit_operator_overrides(monkeypatch) -> None:
    monkeypatch.setenv("GRAPH_INFLIGHT_HARD_MAX", "40")
    monkeypatch.setenv("PROVIDER_SOURCE_RESERVED", "7")
    assert manager_mod._graph_inflight_limits() == (40, 7)


def test_a_nonsensical_override_is_clamped_under_the_ceiling(monkeypatch) -> None:
    """A reserved share at or above the shared ceiling would admit past it."""
    monkeypatch.setenv("GRAPH_INFLIGHT_HARD_MAX", "10")
    monkeypatch.setenv("PROVIDER_SOURCE_RESERVED", "50")
    hard, reserved = manager_mod._graph_inflight_limits()
    assert hard == 10 and reserved == 10


# ── 4. The FastAPI dependency ──────────────────────────────────────────


async def test_dependency_releases_on_success_and_on_failure(limits, monkeypatch) -> None:
    from backend.app.api.v1.endpoints import graph as graph_mod

    mgr = ProviderManager()
    monkeypatch.setattr(graph_mod, "provider_manager", mgr)

    gen = graph_mod._admit_graph_request(ws_id="ws1", dataSourceId="dsA")
    await gen.asend(None)
    assert mgr._graph_inflight_total == 1
    with pytest.raises(StopAsyncIteration):
        await gen.asend(None)
    assert mgr._graph_inflight_total == 0, "released on the normal path"

    gen = graph_mod._admit_graph_request(ws_id="ws1", dataSourceId="dsA")
    await gen.asend(None)
    with pytest.raises(RuntimeError):
        await gen.athrow(RuntimeError("handler blew up"))
    assert mgr._graph_inflight_total == 0, "released when the handler raises"


async def test_dependency_counts_data_sources_apart_within_one_workspace(limits, monkeypatch) -> None:
    from backend.app.api.v1.endpoints import graph as graph_mod

    mgr = ProviderManager()
    monkeypatch.setattr(graph_mod, "provider_manager", mgr)

    a = graph_mod._admit_graph_request(ws_id="ws1", dataSourceId="dsA")
    b = graph_mod._admit_graph_request(ws_id="ws1", dataSourceId="dsB")
    await a.asend(None)
    await b.asend(None)

    assert mgr._graph_inflight == {"ws1/dsA": 1, "ws1/dsB": 1}


def test_the_gate_runs_before_the_graph_read_session_is_checked_out() -> None:
    """Load-bearing ordering: FastAPI resolves sub-dependencies in declaration
    order, so a shed request must never have taken a session."""
    from fastapi.dependencies.utils import get_dependant

    from backend.app.api.v1.endpoints.graph import get_context_engine

    order = [d.call.__name__ for d in get_dependant(path="/x", call=get_context_engine).dependencies]
    assert order.index("_admit_graph_request") < order.index("get_graph_read_db_session")


# ── 5. A wedged close must not freeze the fleet's control plane ────────


class _WedgedProvider:
    """A provider whose ``close()`` never returns — a blackholed host."""

    def __init__(self) -> None:
        self.close_started = False

    def inflight_ops(self) -> int:
        return 0

    async def close(self) -> None:
        self.close_started = True
        await asyncio.Event().wait()


async def test_a_wedged_close_is_abandoned_instead_of_hanging_the_caller(monkeypatch) -> None:
    """``_close_and_forget`` runs on two process-wide SERIAL paths — the warmup
    cycle's idle reap and the cross-process invalidation listener — and both
    walk providers one at a time. Unbounded, one blackholed host stopped the
    warmup cycle (so every provider's verdict went stale) and blocked every
    other provider's invalidation. It must give up and move on."""
    monkeypatch.setattr(manager_mod, "_PROVIDER_CLOSE_TIMEOUT_S", 0.05)
    mgr = ProviderManager()
    wedged = _WedgedProvider()
    key = ("prov_bad", "g1")
    mgr._providers[key] = wedged

    await asyncio.wait_for(mgr._close_and_forget(key), timeout=2.0)

    assert wedged.close_started, "the close was attempted"
    assert key not in mgr._providers, "the handle is dropped either way"
    assert mgr.stats["provider_close_timeouts"] == 1


async def test_closing_one_wedged_provider_leaves_the_others_closable(monkeypatch) -> None:
    """The property that matters: the fleet's other providers still close."""
    monkeypatch.setattr(manager_mod, "_PROVIDER_CLOSE_TIMEOUT_S", 0.05)
    mgr = ProviderManager()
    closed: list[str] = []

    class _Healthy:
        def __init__(self, name: str) -> None:
            self.name = name

        def inflight_ops(self) -> int:
            return 0

        async def close(self) -> None:
            closed.append(self.name)

    mgr._providers[("bad", "g")] = _WedgedProvider()
    mgr._providers[("good1", "g")] = _Healthy("good1")
    mgr._providers[("good2", "g")] = _Healthy("good2")

    for key in (("bad", "g"), ("good1", "g"), ("good2", "g")):
        await asyncio.wait_for(mgr._close_and_forget(key), timeout=2.0)

    assert closed == ["good1", "good2"]
    assert mgr._providers == {}


def test_v2_graph_engine_uses_the_same_two_gates_as_v1() -> None:
    """v2 took a WEB-pool session — the pool that serves auth and navigation —
    so a hung provider there would starve far more than graph reads. It is not
    mounted today; this keeps it correct for the day it is."""
    from fastapi.dependencies.utils import get_dependant

    from backend.app.api.v2.endpoints.graph import get_context_engine as v2_engine

    order = [d.call.__name__ for d in get_dependant(path="/x", call=v2_engine).dependencies]
    assert "get_graph_read_db_session" in order, "must not use the WEB pool"
    assert order.index("_admit_graph_request") < order.index("get_graph_read_db_session")


# ── 6. One admission means one pooled session ──────────────────────────


def _walk(dep):
    for sub in dep.dependencies:
        yield sub
        yield from _walk(sub)


@pytest.mark.parametrize(
    "endpoint_path",
    ["canvas_bootstrap", "get_top_level_nodes", "search_advanced", "search_explain"],
)
def test_an_endpoint_checks_out_one_graph_read_session_not_two(endpoint_path) -> None:
    """These four took a session of their own ALONGSIDE the engine's, so one
    request held two of the pool's 20 connections — halving its depth for the
    canvas's hottest calls, and breaking the accounting the admission gate
    rests on (one admission is meant to bound one session). They now share the
    engine's session via ``get_engine_session``.

    FastAPI caches a dependency per request, so the engine (and therefore its
    session) is solved once even though two dependants ask for it; this
    asserts BOTH halves of that — the shared dependency and the caching that
    makes sharing real.
    """
    from fastapi.dependencies.utils import get_dependant

    from backend.app.api.v1.endpoints import canvas as canvas_mod
    from backend.app.api.v1.endpoints import graph as graph_mod

    fn = getattr(canvas_mod, endpoint_path, None) or getattr(graph_mod, endpoint_path)
    deps = list(_walk(get_dependant(path="/x", call=fn)))
    names = [d.call.__name__ for d in deps]

    assert "get_engine_session" in names, "must reuse the engine's session"
    assert all(d.use_cache for d in deps), (
        "an uncached dependency would resolve the engine twice and check out "
        "a second session"
    )
    # Every request-cached path to a session goes through the one engine.
    assert names.count("get_context_engine") == names.count("get_engine_session") + 1
