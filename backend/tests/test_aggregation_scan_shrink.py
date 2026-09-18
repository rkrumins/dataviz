"""Range scans must SHRINK on a per-query timeout, not fail the run.

F4 audit finding: scan timeouts (deliberately never retried at the
connection layer — a genuine slow query must not be multiplied) failed
the whole run, so a busy server or one dense ID range sent the job back
through worker retry into a full EXTRACT re-run, repeatedly. The
pipeline now halves the failing range recursively down to a floor
(sticky for the rest of the run, re-growing after sustained successes);
only a floor-width range that still times out through every backoff
retry — a real outage, not a payload problem — propagates.

Two timeout SIGNALS exist and both must enter the ladder: the client
deadline (``asyncio.TimeoutError``) and, far more often in production, the
server's own ``Query timed out`` refusal — every query goes out with
``TIMEOUT = budget − 500 ms`` so the server aborts first. Until the ladder
listened for the second, a real timeout escaped it entirely.
"""
import asyncio
from unittest.mock import AsyncMock

import pytest

# Same-directory test module (pytest inserts the tests dir on sys.path):
# reuse the in-memory FalkorDB fake + seed helpers.
import test_falkordb_materialize as base

from backend.app.providers import falkordb_materialize as mat


def _run(coro):
    return asyncio.run(coro)


class _TimeoutFake(base._FakeFalkor):
    """Times out any ID-range scan wider than `narrow` (None = never),
    recording every executed range width. ``server_side`` raises the
    engine's own refusal (a plain exception whose MESSAGE is the signal)
    instead of the client deadline."""

    def __init__(self, narrow_edges=None, narrow_agg=None, server_side=False):
        super().__init__()
        self.narrow_edges = narrow_edges
        self.narrow_agg = narrow_agg
        self.server_side = server_side
        self.edge_scan_widths = []
        self.agg_scan_widths = []

    def _timeout(self):
        if self.server_side:
            return Exception("Query timed out")
        return asyncio.TimeoutError()

    async def ro_query(self, cypher, params=None, **kw):
        params = params or {}
        if "WHERE ID(r) >= $lo AND ID(r) < $hi" in cypher:
            width = params["hi"] - params["lo"]
            if "r:AGGREGATED" in cypher:
                self.agg_scan_widths.append(width)
                if self.narrow_agg is not None and width > self.narrow_agg:
                    raise self._timeout()
            else:
                self.edge_scan_widths.append(width)
                if self.narrow_edges is not None and width > self.narrow_edges:
                    raise self._timeout()
        return await super().ro_query(cypher, params, **kw)


@pytest.mark.parametrize("server_side", [False, True], ids=["client-deadline", "server-refusal"])
def test_scan_timeouts_shrink_until_the_run_completes(monkeypatch, server_side):
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "2")
    fake = _TimeoutFake(narrow_edges=4, server_side=server_side)
    levels = base._seed_two_chain_graph(fake)
    p = base._make_provider(fake, levels)

    result = _run(base._materialize(p))

    # Exact same result a timeout-free run produces: the same-level
    # diagonal with weight 2 (two parallel raw edges).
    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}
    # The scan genuinely shrank: sub-floor-width queries were executed.
    assert any(w <= 4 for w in fake.edge_scan_widths), fake.edge_scan_widths
    assert all(w > 0 for w in fake.edge_scan_widths)


def test_floor_width_timeout_propagates(monkeypatch):
    """With no backoff retries allowed, a floor-width timeout is an outage
    at once — and it still surfaces as a TimeoutError (the breaker counts
    it, the worker's transient path resumes from the cursor)."""
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "64")
    monkeypatch.setenv("AGGREGATION_SCAN_TIMEOUT_RETRIES", "0")
    fake = _TimeoutFake(narrow_edges=0)          # every scan times out
    levels = base._seed_two_chain_graph(fake)
    p = base._make_provider(fake, levels)

    with pytest.raises(asyncio.TimeoutError) as exc:
        _run(base._materialize(p))
    assert isinstance(exc.value, mat.MaterializationScanTimedOut)
    assert "extract:" in str(exc.value) and "outage" in str(exc.value)


def test_floor_width_timeout_is_retried_with_backoff_and_heartbeats(monkeypatch):
    """At the floor a timeout is retried — with backoff between attempts
    and a heartbeat before each wait, so a slow store gets more chances
    and the watchdog sees the waiting as progress — before the run gives
    up with a message that names the scan."""
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "64")
    monkeypatch.setenv("AGGREGATION_SCAN_TIMEOUT_RETRIES", "2")
    sleeps = AsyncMock()
    monkeypatch.setattr(mat.asyncio, "sleep", sleeps)
    fake = _TimeoutFake(narrow_edges=0, server_side=True)
    levels = base._seed_two_chain_graph(fake)
    p = base._make_provider(fake, levels)
    beats = []

    async def heartbeat(written):
        beats.append(written)

    with pytest.raises(mat.MaterializationScanTimedOut) as exc:
        _run(mat.materialize_aggregated_edges(
            p, containment_edge_types=["CONTAINS"], lineage_edge_types=["FLOWS"],
            intra_batch_callback=heartbeat, tuning={"materialize_fine_pairs": False},
        ))

    floor_attempts = [w for w in fake.edge_scan_widths if w <= 64]
    # The first floor-width attempt plus the two retries.
    assert len(floor_attempts) == 3, fake.edge_scan_widths
    assert sleeps.await_count == 2
    assert len(beats) >= 2, "each retry must heartbeat before it waits"
    msg = str(exc.value)
    assert "extract:" in msg and "3 times in a row" in msg
    assert "scanTimeoutS" in msg and "Gentle" in msg


def test_reconcile_scan_shrinks_too(monkeypatch):
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "2")
    fake = _TimeoutFake(narrow_agg=4)
    levels = base._seed_two_chain_graph(fake)
    # Stale cell the reconcile must still find and delete precisely.
    fake.seed_aggregated(1, 12, weight=9, latest=1000, agg_key="urn:domain_abc|urn:table_b")
    fake.seed_aggregated(2, 12, weight=7, latest=1000)   # kept, weight fixed to 2
    fake.seed_aggregated(1, 11, weight=2, latest=1000, sl=0, tl=0)
    p = base._make_provider(fake, levels)

    result = _run(base._materialize(p))

    assert result["errors"] == 0
    assert (1, 12) in fake.deleted_pairs                 # stale mixed cell removed
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}
    assert any(w <= 4 for w in fake.agg_scan_widths), fake.agg_scan_widths
