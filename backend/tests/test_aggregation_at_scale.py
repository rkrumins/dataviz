"""Densely connected graphs: half a million lineage edges must aggregate,
and must not take a day doing it.

Three things used to make a dense graph the pathological case, and none of
them were about the graph store at all:

  * **The same ancestry, walked over and over.** A leaf's ancestor closure
    was evicted from the memo the moment it was computed, so the memo could
    never grow with leaf count. On a sparse graph that is free. On a dense
    one an endpoint shared by ten thousand lineage edges had its ancestry
    walked ten thousand times, because the raw PAIRS are distinct even
    though the endpoints repeat.
  * **A counting scan whose answer nobody was allowed to use.** Forced full
    detail with no measured cell ratio for the source is explicitly not
    allowed to refuse on the estimate — and still read every lineage edge a
    second time to compute it.
  * **A ceiling that answered the wrong question.** Whether a graph got full
    detail was decided by a fixed cell count chosen before any of the
    measurement existed. What actually matters is whether the shard can hold
    the cube (the write budget knows) and whether the job can finish writing
    it (the apply rate knows).

And one that was: a rebuild that idles half the time on a node with room to
spare finishes in twice the wall clock for no one's benefit.
"""
from __future__ import annotations

import asyncio
import types

import pytest

import test_falkordb_materialize as base
from backend.app.providers import falkordb_materialize as mat
from backend.app.providers import shard_capacity as sc
from backend.common.providers import pair_rules

GB = 1024 ** 3


def _budget_with(free_gb: float):
    """A write budget over a measured shard with ``free_gb`` to spare."""
    used = int((40 - free_gb) * GB)
    shard = sc.ShardMemory(
        "10.0.0.1:6379", used, 40 * GB, "noeviction", 0.0, "measured",
    )
    return sc.compute_write_budget(
        shard, reserve_pct=0, bytes_per_edge=512, bpe_source="default",
        explicit_ceiling=None, static_cap=25_000_000,
    )


def _run(coro):
    return asyncio.run(coro)


# ── walking the same ancestry once ───────────────────────────────────────


def _dense(*, leaves: int, containers: int = 4):
    """A pipeline over a containment chain of ``containers`` levels with
    ``leaves`` leaf nodes hanging off the deepest one."""
    pipe = base._make_pipeline()
    parents = {}
    for level in range(1, containers):
        parents[-level] = (-(level + 1),)          # c1 -> c2 -> ... -> cN
    deepest = -1
    for leaf in range(1, leaves + 1):
        parents[leaf] = (deepest,)
    pipe._parents = parents
    pipe._closure_memo = {}
    pipe._rep_memo = {}
    pipe._depth_memo = {}
    pipe._struct_parents = {p for ps in parents.values() for p in ps}
    return pipe


def test_an_endpoint_shared_by_many_edges_has_its_ancestry_walked_once(monkeypatch):
    """The dense case, in one assertion. 200 leaves in 20,000 raw pairs:
    the ancestry walk is paid per NODE, not per pair."""
    walks = {"n": 0}
    real = pair_rules.ancestor_closure

    def _counted(parents, node, memo=None):
        walks["n"] += 1
        return real(parents, node, memo=memo)

    monkeypatch.setattr(mat, "ancestor_closure", _counted)
    pipe = _dense(leaves=200)
    for src in range(1, 201):
        for dst in range(1, 101):
            pipe._rep_set(src)
            pipe._rep_set(dst)
    assert walks["n"] == 200                      # once per distinct node
    # And the answer is the same one the rule would have got each time.
    assert pipe._rep_set(7) == {-1: 3, -2: 2, -3: 1, -4: 0}


def test_the_memo_stops_growing_at_its_bound(monkeypatch):
    """Bounded on any graph: past the bound the old eviction resumes, so a
    graph with more endpoints than the bound cannot inflate the worker."""
    monkeypatch.setattr(mat, "_CLOSURE_MEMO_MAX", 8)
    pipe = _dense(leaves=40)
    for leaf in range(1, 41):
        pipe._rep_set(leaf)
    assert len(pipe._rep_memo) <= 9
    assert len(pipe._closure_memo) <= 9 + len(pipe._struct_parents)
    # Correct past the bound, just not free.
    assert pipe._rep_set(40) == {-1: 3, -2: 2, -3: 1, -4: 0}


def test_a_container_closure_is_memoized_whatever_the_bound(monkeypatch):
    monkeypatch.setattr(mat, "_CLOSURE_MEMO_MAX", 0)
    pipe = _dense(leaves=5)
    pipe._closure(-1)
    assert -1 in pipe._closure_memo                # a container is never evicted
    pipe._closure(3)
    assert 3 not in pipe._closure_memo             # a leaf past the bound is


# ── the counting scan that could not refuse ──────────────────────────────


class _CountingProvider:
    """A provider that records how many times the lineage edges are scanned."""

    def __init__(self):
        self.scans = 0


def _pipeline_for_decision(*, forced=True, ratio=None, edges_before=0):
    pipe = base._make_pipeline()
    pipe._parents = {1: (-1,), 2: (-1,)}
    pipe._closure_memo, pipe._rep_memo, pipe._depth_memo = {}, {}, {}
    pipe._tuning = dict(pipe._tuning)
    pipe._tuning["materialize_fine_pairs"] = True if forced else "auto"
    pipe._capacity_hints = (
        {"cell_ratio_observed": ratio} if ratio is not None else {}
    )
    pipe._effective_types = ["FLOWS"]
    pipe._edges_before = edges_before
    return pipe


def test_forced_full_detail_with_nothing_measured_defers_the_counting_pass():
    """Its verdict could not be acted on, and on a 500k-edge graph it is a
    second full read of every lineage edge. It is not dropped, though — the
    count is what MEASURES the source's cell ratio, and without it the
    source could never be calibrated and no later run could refuse early."""
    pipe = _pipeline_for_decision(forced=True, ratio=None)
    scans = {"n": 0}

    async def _scan(_safe):
        scans["n"] += 1
        yield 0, [(1, 2)]

    pipe._scan_type_ranges = _scan
    _run(pipe._decide_materialization_mode())
    assert pipe._cube_mode is True
    assert scans["n"] == 0                         # no second pass over the edges
    assert pipe._estimate_in_extract is True       # counted during the real one
    assert pipe._cube_estimate_upper is None       # not yet — the scan has not run


def test_the_deferred_count_lands_on_the_run_so_the_source_calibrates(monkeypatch):
    """The whole point of keeping it: this run's bound plus this run's exact
    cell count are what teach the source its ratio, and the ratio is what
    lets the NEXT run refuse a cube before computing it."""
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    fake = base._FakeFalkor()
    levels = base._seed_two_chain_graph(fake)
    monkeypatch.setattr(
        mat, "read_shard_memory",
        base._ShardFake(fake, base_used=0, maxmemory=40 * GB),
    )
    result = _run(base._materialize(
        base._make_provider(fake, levels),
        tuning={"materialize_fine_pairs": True, "shard_reserve_pct": 0},
    ))
    stats = result["run_stats"]
    assert stats["cube_estimate_upper"] >= stats["cells_exact"] > 0
    assert 0 < stats["cell_ratio_observed"] <= 1.0
    # And the run says what the cube would have cost in time.
    assert stats["cube_projection"]["cells"] > 0
    assert stats["cube_projection"]["rate"] == "default"


def test_forced_full_detail_with_a_measured_ratio_still_estimates_and_can_refuse(monkeypatch):
    pipe = _pipeline_for_decision(forced=True, ratio=0.5)
    scans = {"n": 0}

    async def _scan(_safe):
        scans["n"] += 1
        for _ in range(200):
            yield 0, [(1, 2)] * 50

    pipe._scan_type_ranges = _scan

    async def _shard_full():
        return _budget_with(0.001)             # the shard is full

    pipe._budget = _shard_full
    with pytest.raises(mat.MaterializationBudgetExceeded) as info:
        _run(pipe._decide_materialization_mode())
    assert scans["n"] == 1
    assert "upper-bound estimate" in str(info.value)


# ── the clock, not a cell count ──────────────────────────────────────────


def test_the_apply_rate_prefers_this_run_then_the_last_then_the_default():
    pipe = base._make_pipeline()
    assert pipe._apply_rate() == (mat._APPLY_ROWS_PER_S_DEFAULT, "default")
    pipe._capacity_hints = {"apply_rows_per_s_observed": 900}
    assert pipe._apply_rate() == (900.0, "last run")
    pipe._pace.note(rows=500, batch_s=0.5, ack_s=0.0, sleep_s=0.5,
                    batch_max=500, target_s=1.0, ratio=1.0)
    rate, source = pipe._apply_rate()
    assert source == "measured" and rate == pytest.approx(500.0)
    # A junk hint falls through rather than dividing by nothing.
    pipe._pace = mat._PaceMeter()
    pipe._capacity_hints = {"apply_rows_per_s_observed": "soon"}
    assert pipe._apply_rate()[1] == "default"


def test_the_projection_is_cells_over_the_rate_and_the_budget_is_what_is_left():
    pipe = base._make_pipeline()
    pipe._capacity_hints = {"apply_rows_per_s_observed": 1000}
    assert pipe._projected_apply_secs(3_600_000) == (3600.0, "last run")
    # The wall budget is a SHARE of what the job has left, never negative.
    pipe._tuning = {**pipe._tuning, "max_wall_secs": 3_600}
    assert pipe._apply_wall_budget_s() == pytest.approx(3_600 * mat._APPLY_WALL_SHARE, rel=0.01)


def test_auto_steps_off_a_cube_the_job_could_not_finish_writing():
    """The gate a cell count cannot be: the shard can hold it and the job
    cannot land it, which is a rebuild that gets cancelled and retried
    forever."""
    pipe = _pipeline_for_decision(forced=False, ratio=1.0)
    pipe._capacity_hints = {"cell_ratio_observed": 1.0, "apply_rows_per_s_observed": 100}
    pipe._tuning = {**pipe._tuning, "max_wall_secs": 3_600}

    # 100k lineage edges, two ancestors a side: ~400k cells, which at the
    # 100 rows/s this source measured last run is over an hour of writing —
    # more than the share of a one-hour wall clock the apply may have.
    async def _scan(_safe):
        for _ in range(200):
            yield 0, [(1, 2)] * 500

    pipe._scan_type_ranges = _scan

    async def _shard_roomy():
        return _budget_with(30)                # the shard has plenty of room

    pipe._budget = _shard_roomy
    _run(pipe._decide_materialization_mode())
    assert pipe._cube_mode is False
    assert "to write" in pipe._degraded_reason
    proj = pipe._cube_projection
    assert proj["rate"] == "last run" and proj["seconds"] > proj["wall_budget_s"]


def test_the_appetite_ceiling_defaults_to_its_bound_so_it_does_not_decide(monkeypatch):
    monkeypatch.delenv("AGGREGATION_MAX_CUBE_EDGES", raising=False)
    assert mat._max_cube_edges() == 50_000_000
    monkeypatch.setenv("AGGREGATION_MAX_CUBE_EDGES", "1000000")
    assert mat._max_cube_edges() == 1_000_000     # an operator's ceiling still binds


# ── a retry that wrote is converging, not stuck ──────────────────────────


class _Rows:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class _Session:
    """A session that answers one SELECT with a fixed row."""

    def __init__(self, row=None, raises=False):
        self._row, self._raises = row, raises

    async def execute(self, _stmt):
        if self._raises:
            raise RuntimeError("the jobs table is not answering")
        return _Rows(self._row)


def _state(ds="ds_1"):
    return types.SimpleNamespace(data_source_id=ds)


def test_a_failed_run_that_wrote_rollup_edges_reads_as_converging():
    """The distinction the breaker needs. A rebuild of a graph too large for
    one wall clock fails in exactly the same SHAPE every time and is the
    opposite of stuck: APPLY writes only the cells the reconcile scan did
    not find, and the writes are durable, so every attempt writes strictly
    less than the last."""
    from backend.app.services.aggregation.scheduler import _converging

    assert _run(_converging(_Session(("failed", '{"writes": 41000}')), _state())) is True
    assert _run(_converging(_Session(("cancelled", '{"writes": 7}')), _state())) is True
    # Wrote nothing: the attempt achieved nothing, and the breaker counts it.
    assert _run(_converging(_Session(("failed", '{"writes": 0}')), _state())) is False
    assert _run(_converging(_Session(("failed", "{}")), _state())) is False
    assert _run(_converging(_Session(("failed", None)), _state())) is False
    # A run that SUCCEEDED is not a retry at all.
    assert _run(_converging(_Session(("completed", '{"writes": 9}')), _state())) is False


def test_the_progress_lookup_never_breaks_the_tick():
    """Unreadable reads as "not converging" — the conservative direction,
    where the breaker still bounds the retries."""
    from backend.app.services.aggregation.scheduler import _converging

    assert _run(_converging(_Session(raises=True), _state())) is False
    assert _run(_converging(_Session(("failed", "not json")), _state())) is False
    assert _run(_converging(_Session(None), _state())) is False
    assert _run(_converging(_Session(("failed", '{"writes": 1}')), None)) is False


def test_the_breaker_asks_whether_the_source_is_converging_first():
    """Structural: the suspend branch and the retry count both sit behind
    it, so a source cannot be suspended for making progress."""
    import inspect

    from backend.app.services.aggregation import scheduler

    src = inspect.getsource(scheduler.AggregationScheduler._reconcile_stale_markers)
    assert "converging = retrying and await _converging(s2, state)" in src
    assert "and not converging" in src
    assert src.index("converging = retrying") < src.index(">= breaker_cap")
