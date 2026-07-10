"""Range scans must SHRINK on a per-query timeout, not fail the run.

F4 audit finding: scan timeouts (deliberately never retried at the
connection layer — a genuine slow query must not be multiplied) failed
the whole run, so a busy server or one dense ID range sent the job back
through worker retry into a full EXTRACT re-run, repeatedly. The
pipeline now halves the failing range recursively down to a floor
(sticky for the rest of the run, re-growing after sustained successes);
only a floor-width range that still times out — a real outage, not a
payload problem — propagates.
"""
import asyncio

import pytest

# Same-directory test module (pytest inserts the tests dir on sys.path):
# reuse the in-memory FalkorDB fake + seed helpers.
import test_falkordb_materialize as base

from backend.app.providers import falkordb_materialize as mat


def _run(coro):
    return asyncio.run(coro)


class _TimeoutFake(base._FakeFalkor):
    """Times out any ID-range scan wider than `narrow` (None = never),
    recording every executed range width."""

    def __init__(self, narrow_edges=None, narrow_agg=None):
        super().__init__()
        self.narrow_edges = narrow_edges
        self.narrow_agg = narrow_agg
        self.edge_scan_widths = []
        self.agg_scan_widths = []

    async def ro_query(self, cypher, params=None, **kw):
        params = params or {}
        if "WHERE ID(r) >= $lo AND ID(r) < $hi" in cypher:
            width = params["hi"] - params["lo"]
            if "r:AGGREGATED" in cypher:
                self.agg_scan_widths.append(width)
                if self.narrow_agg is not None and width > self.narrow_agg:
                    raise asyncio.TimeoutError()
            else:
                self.edge_scan_widths.append(width)
                if self.narrow_edges is not None and width > self.narrow_edges:
                    raise asyncio.TimeoutError()
        return await super().ro_query(cypher, params, **kw)


def test_scan_timeouts_shrink_until_the_run_completes(monkeypatch):
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "2")
    fake = _TimeoutFake(narrow_edges=4)
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
    monkeypatch.setenv("AGGREGATION_SCAN_SHRINK_FLOOR", "64")
    fake = _TimeoutFake(narrow_edges=0)          # every scan times out
    levels = base._seed_two_chain_graph(fake)
    p = base._make_provider(fake, levels)

    with pytest.raises(asyncio.TimeoutError):
        _run(base._materialize(p))


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
