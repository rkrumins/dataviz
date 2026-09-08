"""The worker's half of the measured write budget.

The pipeline measures the shard; the worker supplies the one thing the shard
cannot say before a run — what a previous rebuild of THIS graph cost per new
edge — and records what this run measured for the next one.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import types

import pytest

from backend.app.services.aggregation.worker import AggregationWorker


def _worker() -> AggregationWorker:
    return AggregationWorker(session_factory=None, registry=None, event_publisher=None)


class _Session:
    def __init__(self, state=None, *, raise_exc=None):
        self._state, self._raise = state, raise_exc
        self.committed = False

    async def get(self, orm, key):
        if self._raise:
            raise self._raise
        return self._state

    async def commit(self):
        self.committed = True

    def add(self, obj):
        pass


def _run(coro):
    return asyncio.run(coro)


def test_hints_carry_the_calibrated_figure_and_nothing_else():
    state = types.SimpleNamespace(observed_bytes_per_edge=777)
    assert _run(_worker()._capacity_hints(_Session(state), "ds")) == {"bytes_per_edge_observed": 777}


@pytest.mark.parametrize("state", [
    None,                                                   # no state row yet
    types.SimpleNamespace(observed_bytes_per_edge=None),    # never calibrated
    types.SimpleNamespace(observed_bytes_per_edge=0),       # never a real figure
    types.SimpleNamespace(),                                # column not there (old schema)
])
def test_no_calibration_means_no_hint(state):
    assert _run(_worker()._capacity_hints(_Session(state), "ds")) == {}


def test_a_failing_read_never_blocks_the_run():
    session = _Session(None, raise_exc=RuntimeError("db down"))
    assert _run(_worker()._capacity_hints(session, "ds")) == {}


def test_the_pipeline_call_passes_the_hints_beside_tuning_never_inside_it():
    """The hint is evidence, not a setting: it must reach the pipeline as its
    own argument so the operator's ``bytesPerEdge`` in tuning can win over it,
    and so it never appears on the job as if someone had configured it."""
    src = inspect.getsource(AggregationWorker._materialize_with_checkpoints)
    assert "capacity_hints=capacity_hints" in src
    assert "job_tuning[" not in src


def test_a_measured_figure_lands_on_the_state_row_and_none_leaves_it_alone():
    state = types.SimpleNamespace(observed_bytes_per_edge=640, aggregation_status="pending")
    session = _Session(state)
    _run(_worker()._update_ds_state(session, "ds", aggregation_status="ready",
                                     observed_bytes_per_edge=None))
    assert state.observed_bytes_per_edge == 640          # None never overwrites
    _run(_worker()._update_ds_state(session, "ds", aggregation_status="ready",
                                     observed_bytes_per_edge=900))
    assert state.observed_bytes_per_edge == 900


def test_the_success_path_persists_what_the_run_measured():
    src = inspect.getsource(AggregationWorker.run)
    assert 'observed_bytes_per_edge=' in src
    assert '"bytes_per_edge_observed"' in src


# ── learn and remember: what the last run needed under pressure ────────


def test_learned_state_is_handed_over_as_observed_hints():
    state = types.SimpleNamespace(
        observed_bytes_per_edge=None,
        observed_tuning=json.dumps({
            "scan_width": 12_500, "extract_concurrency": 1,
            "reconcile_strategy": "keys_only", "write_batch": 60,
            "delete_chunk": 500, "observed_at": "2026-09-09T10:00:00+00:00",
            "job_id": "agg_1",
        }),
    )
    assert _run(_worker()._capacity_hints(_Session(state), "ds")) == {
        "scan_width_observed": 12_500,
        "extract_concurrency_observed": 1,
        "reconcile_strategy_observed": "keys_only",
        "write_batch_observed": 60,
        "delete_chunk_observed": 500,
    }


@pytest.mark.parametrize("observed_tuning", [None, "", "{}", "not json", '{"scan_width": 0}'])
def test_nothing_learned_means_no_hint(observed_tuning):
    state = types.SimpleNamespace(observed_bytes_per_edge=None, observed_tuning=observed_tuning)
    assert _run(_worker()._capacity_hints(_Session(state), "ds")) == {}


def test_learned_from_reads_this_runs_pressure_only():
    from backend.app.services.aggregation.worker import _learned_from

    # A clean run teaches nothing — and CLEARS the previous lesson.
    assert _learned_from({"writes": 5}) == {}
    assert _learned_from({"adapted": {"from_last_run": {"scan_width": 500}}}) == {}
    assert _learned_from(None) == {}

    learned = _learned_from({"adapted": {
        "pressure": [{"scan": "extract:FLOWS", "kind": "memory"}],
        "scan_width_min": 12_500, "scan_width": 25_000,
        "extract_concurrency": 1, "reconcile_strategy": "keys_only",
        "write_batch_min": 60, "write_batch": 120, "delete_chunk_min": 500,
    }}, job_id="agg_9")
    assert learned["scan_width"] == 12_500 and learned["write_batch"] == 60
    assert learned["extract_concurrency"] == 1 and learned["reconcile_strategy"] == "keys_only"
    assert learned["delete_chunk"] == 500 and learned["job_id"] == "agg_9"
    assert learned["observed_at"]


def test_a_clean_run_clears_the_lesson_with_an_empty_object_not_none():
    """``_update_ds_state`` skips None, so "nothing learned" must travel as
    the string "{}" to overwrite what the previous run stored."""
    state = types.SimpleNamespace(observed_tuning='{"scan_width": 500}', aggregation_status="pending")
    session = _Session(state)
    _run(_worker()._update_ds_state(session, "ds", aggregation_status="ready", observed_tuning="{}"))
    assert state.observed_tuning == "{}"
    src = inspect.getsource(AggregationWorker.run)
    assert "observed_tuning=json.dumps(" in src
