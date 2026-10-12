"""THE READ LADDER HAD NO WALL CLOCK, SO ITS FLOOR WAS UNREACHABLE.

The aggregated-edge read is a ladder: on per-query pressure it halves the page
and re-issues at the same keyset position, twice, then takes one short floor
retry, then degrades and returns the prefix it has as an honest partial answer.

Every rung started a FRESH per-query budget. At the shipped numbers that is
4 x 30s + 1s = ~121s of wall clock for ONE request, under a 45s ASGI tier. So
the tier cancelled the request before the ladder ever reached the rung that
produces the degraded answer — the answer the whole mechanism exists to
produce — and the abandoned queries went on holding FalkorDB query threads
after the client had gone. Under load that is the shape that takes the store
down: threads spent on results nobody will read.

These tests pin the property rather than the arithmetic: the ladder's total
cost is bounded by ONE budget, that budget sits under the tier above it, and
running out of it degrades rather than starting an attempt that cannot finish.
"""
import backend.app.config.resilience as R


def test_the_read_budget_sits_under_the_asgi_tier():
    """The layering rule: the innermost layer that can explain the failure has
    to be the one that fires. If the read's own budget met or exceeded the
    tier, the tier would cancel first and the client would get an opaque 504
    instead of the provider's structured partial answer."""
    assert R.FALKORDB_AGGREGATED_READ_BUDGET_SECS < R.HTTP_TIMEOUT_AGGREGATION_SECS


def test_one_attempt_still_fits_inside_the_whole_read():
    """A budget below the per-query timeout would mean no rung could ever run
    to completion — the read would degrade before doing any work."""
    assert R.FALKORDB_AGGREGATED_READ_BUDGET_SECS >= R.FALKORDB_AGGREGATED_READ_TIMEOUT_SECS


def test_the_unbounded_ladder_would_have_overrun_the_tier():
    """States the bug as arithmetic, so nobody re-introduces it by raising the
    per-query budget or adding a rung. This is what the ladder used to cost
    when every rung re-armed a full budget."""
    from backend.app.providers.falkordb_provider import (
        _READ_FLOOR_RETRY_S, _READ_TIMEOUT_NARROWINGS,
    )

    rungs = _READ_TIMEOUT_NARROWINGS + 2          # narrowings, floor retry, final
    unbounded = rungs * R.FALKORDB_AGGREGATED_READ_TIMEOUT_SECS + _READ_FLOOR_RETRY_S
    assert unbounded > R.HTTP_TIMEOUT_AGGREGATION_SECS, (
        "if this no longer overruns, the per-query budget changed and this "
        "test has stopped describing the bug it was written for"
    )
    # The bound is what makes the difference, not the rung count.
    assert R.FALKORDB_AGGREGATED_READ_BUDGET_SECS < unbounded


def test_a_final_attempt_is_only_started_if_it_could_finish_something():
    """The degrade threshold has to be a real slice of time. At zero the read
    would start an attempt with milliseconds left, which cannot return a page
    and costs a query thread to learn that."""
    assert R.FALKORDB_AGGREGATED_READ_MIN_ATTEMPT_SECS > 0
    assert (
        R.FALKORDB_AGGREGATED_READ_MIN_ATTEMPT_SECS
        < R.FALKORDB_AGGREGATED_READ_BUDGET_SECS
    )


def test_the_budget_tracks_the_tier_when_the_tier_moves():
    """It is derived, not pinned: an operator who raises the ASGI tier gets a
    read budget that still sits under it, instead of a constant that silently
    stops matching."""
    import importlib
    import os

    prev = os.environ.get("HTTP_TIMEOUT_AGGREGATION_SECS")
    os.environ["HTTP_TIMEOUT_AGGREGATION_SECS"] = "90"
    try:
        reloaded = importlib.reload(R)
        assert reloaded.HTTP_TIMEOUT_AGGREGATION_SECS == 90
        assert reloaded.FALKORDB_AGGREGATED_READ_BUDGET_SECS == 72.0
        assert (
            reloaded.FALKORDB_AGGREGATED_READ_BUDGET_SECS
            < reloaded.HTTP_TIMEOUT_AGGREGATION_SECS
        )
    finally:
        if prev is None:
            os.environ.pop("HTTP_TIMEOUT_AGGREGATION_SECS", None)
        else:
            os.environ["HTTP_TIMEOUT_AGGREGATION_SECS"] = prev
        importlib.reload(R)


def test_an_explicit_budget_overrides_the_derived_one():
    """An operator who has measured their own store can pin it."""
    import importlib
    import os

    os.environ["FALKORDB_AGGREGATED_READ_BUDGET_SECS"] = "12.5"
    try:
        assert importlib.reload(R).FALKORDB_AGGREGATED_READ_BUDGET_SECS == 12.5
    finally:
        os.environ.pop("FALKORDB_AGGREGATED_READ_BUDGET_SECS", None)
        importlib.reload(R)


# ── the loop, not just the constants ─────────────────────────────────────
#
# The constants above only describe intent. This drives the REAL ladder
# against a store that always times out and measures what it spends, because
# the defect was never in the numbers — it was that the loop ignored them.


def _provider():
    """A provider with just enough wired up to run the read."""
    import types

    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider.__new__(FalkorDBProvider)
    p._graph_name = "g"
    p._graph = object()
    p._conn_cfg = types.SimpleNamespace(host="h", port=6379)

    async def _noop(*a, **k):
        return None

    p._ensure_connected = _noop
    p._limits_endpoint = lambda: "h:6379"
    return p


def test_the_ladder_spends_one_budget_across_all_its_rungs():
    """The regression, measured. Every rung used to be handed the full
    per-query timeout, so N rungs cost N x that. Now each is handed what is
    LEFT of the whole-read budget, and the read stops when it is gone."""
    import asyncio
    import time
    import types
    from unittest.mock import patch

    from backend.app.providers import falkordb_provider as fp

    class _ServerTimeout(Exception):
        pass

    p = _provider()
    offered = []

    async def _always_times_out(q, params=None, timeout=None, op=None):
        if op == "agg.cells":
            offered.append(timeout)
            await asyncio.sleep(min(timeout or 0, 0.05))
        raise _ServerTimeout("Query timed out")

    p._proj_ro_query = _always_times_out

    budget, per_query = 0.30, 10.0
    with patch.object(R, "FALKORDB_AGGREGATED_READ_BUDGET_SECS", budget), \
         patch.object(R, "FALKORDB_AGGREGATED_READ_MIN_ATTEMPT_SECS", 0.05), \
         patch.object(fp, "_pressure_kind", lambda e: "timeout"):
        started = time.monotonic()
        result = asyncio.run(fp.FalkorDBProvider.get_aggregated_edges_between(
            p, ["urn:a"], None, types.SimpleNamespace(value="table"), [], [],
            timeout=per_query,
        ))
        elapsed = time.monotonic() - started

    assert offered, "the cell read never ran"
    assert max(offered) <= budget + 0.01, (
        f"a rung re-armed the full per-query budget ({max(offered)}s of an "
        f"offered {per_query}s) instead of drawing from the {budget}s left"
    )
    assert offered == sorted(offered, reverse=True), (
        f"each rung should get LESS than the last as the budget drains: {offered}"
    )
    assert elapsed < budget + 0.25, f"the ladder overran its budget: {elapsed:.2f}s"
    # And the point of stopping early: the honest partial is reachable.
    assert result.degraded_detail, (
        "running out of budget must still produce the degraded partial answer "
        "the ladder exists to produce"
    )
