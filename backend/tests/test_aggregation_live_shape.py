"""Going gentler on a RUNNING job.

Beside the time limits, an operator can change the scan shape of a job that
is still going — a pacing ratio, a cap on read concurrency, a cap on the scan
width — through the same ``live`` dict the worker refreshes from the row.
These tests pin how the pipeline honours each: the width cap bounds every
sub-range on read and never touches the ladder's own sticky width, the
concurrency cap shrinks the next wave and never raises it, the pacing ratio
applies to the next write (0 = no pacing), and the run's record says what was
in force.
"""
from __future__ import annotations

import asyncio
import time

import pytest

import test_falkordb_materialize as base
from test_aggregation_scan_shrink import _TimeoutFake
from backend.app.providers import falkordb_materialize as mat


def _run(coro):
    return asyncio.run(coro)


async def _materialize_live(p, live):
    return await mat.materialize_aggregated_edges(
        p, containment_edge_types=["CONTAINS"], lineage_edge_types=["FLOWS"],
        last_cursor=None, progress_callback=None, intra_batch_callback=None,
        should_cancel=None, tuning={"materialize_fine_pairs": False}, live_limits=live,
    )


def test_a_live_scan_width_caps_every_sub_range_and_the_result_says_so():
    fake = _TimeoutFake()
    levels = base._seed_two_chain_graph(fake)
    result = _run(_materialize_live(base._make_provider(fake, levels), {"scan_width": 4}))
    assert result["errors"] == 0
    assert fake.edge_scan_widths and max(fake.edge_scan_widths) <= 4
    assert result["run_stats"]["adapted"]["live"] == {"scan_width": 4}
    # The same weights as an uncapped run, which scanned far wider.
    plain = _TimeoutFake()
    base._seed_two_chain_graph(plain)
    _run(base._materialize(base._make_provider(plain, levels)))
    assert {k: v["weight"] for k, v in fake.agg.items()} == {k: v["weight"] for k, v in plain.agg.items()}
    assert max(plain.edge_scan_widths) > 4


def test_live_concurrency_pacing_and_width_are_read_from_the_shared_dict(monkeypatch):
    monkeypatch.setenv("AGGREGATION_EXTRACT_CONCURRENCY", "4")
    pipe = base._make_pipeline()
    assert pipe._effective_conc() == 4
    pipe._live["extract_concurrency"] = 1
    assert pipe._effective_conc() == 1
    pipe._live["extract_concurrency"] = 8                    # a cap, never a raise
    assert pipe._effective_conc() == 4
    pipe._live["extract_concurrency"] = "two"
    assert pipe._effective_conc() == 4

    assert pipe._live_pacing_ratio() == pipe._pacing_ratio
    pipe._live["write_pacing_ratio"] = 2.5
    assert pipe._live_pacing_ratio() == 2.5
    pipe._live["write_pacing_ratio"] = 0
    assert pipe._live_pacing_ratio() == 0.0
    pipe._live["write_pacing_ratio"] = 99
    assert pipe._live_pacing_ratio() == 10.0

    ceiling = pipe._knob_int("scan_range_width", mat._scan_range_width, 10_000, 5_000_000)
    assert pipe._live_scan_width() is None
    pipe._live["scan_width"] = 5_000
    assert pipe._live_scan_width() == 5_000
    pipe._live["scan_width"] = 10 ** 9
    assert pipe._live_scan_width() == ceiling
    pipe._live["scan_width"] = 0
    assert pipe._live_scan_width() is None
    pipe._live["scan_width"] = "junk"
    assert pipe._live_scan_width() is None

    pipe._live.clear()
    pipe._live.update({"scan_width": 5_000, "write_pacing_ratio": 2.0, "junk": [1]})
    assert pipe._adapted_snapshot()["live"] == {"scan_width": 5_000, "write_pacing_ratio": 2.0}
    assert pipe._result(0)["run_stats"]["adapted"]["live"] == {"scan_width": 5_000, "write_pacing_ratio": 2.0}
    pipe._live.clear()
    assert "adapted" not in pipe._result(0)["run_stats"]


def test_live_pacing_applies_to_the_next_write(monkeypatch):
    pipe = base._make_pipeline()
    # The ratio alone: the floor under the pause (the minimum gap) is the
    # steady-load scheduler's own test, and would otherwise hide a ratio of 0.
    pipe._write_min_gap_ms = 0
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(mat.asyncio, "sleep", fake_sleep)

    async def write():
        time.sleep(0.02)
        return "ok"

    pipe._live["write_pacing_ratio"] = 2.0
    elapsed, result = _run(pipe._paced_write(write))
    assert result == "ok" and elapsed >= 0.02
    assert len(sleeps) == 1 and sleeps[0] == pytest.approx(elapsed * 2.0, rel=0.05)
    pipe._live["write_pacing_ratio"] = 0                      # no pacing from the next write
    _run(pipe._paced_write(write))
    assert len(sleeps) == 1
    pipe._live.pop("write_pacing_ratio")                      # cleared: the knob again
    _run(pipe._paced_write(write))
    assert len(sleeps) == 2 and sleeps[1] > 0
