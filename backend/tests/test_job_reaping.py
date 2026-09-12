"""Reaping a run whose worker is already gone.

Every terminal path inside the worker passes through one ``finally``, which
seals the step ledger, releases the source on both mirrors and emits the
terminal event. Nothing reaches it when the worker itself is gone — an
OOM-killed pod, an evicted node, a lost dispatch — and those runs are reaped
from another process that holds no ledger and no emitter.

Those reapers used to write ``job.status`` and little else, which left two
records lying, both of which these tests pin:

* the ledger kept a step marked ``running``, so ``failed_stage`` — and the
  UI's ``stoppedStage``, which is the same rule — reported NO failure stage
  for exactly the runs an operator most needs named, and the per-source
  failure-pattern tally skipped them;
* the source row kept ``aggregation_status`` at ``running``, which the
  freshness column reads straight off and the stale-marker reconciler treats
  as in-flight — so a source reaped this way was deferred every tick,
  forever. ``AggregationService.cancel`` already documented this rule and
  followed it; these paths did not.
"""
from __future__ import annotations

import asyncio
import json
import types

import pytest

from backend.app.services.aggregation import reap as reap_mod
from backend.app.services.aggregation.reap import (
    NEVER_DISPATCHED, WORKER_LOST, reap_job, release_source,
)
from backend.app.services.aggregation.service import classify_failure
from backend.app.services.aggregation.steps import (
    StepLedger, failed_stage, open_step, seal_steps,
)


def _run(coro):
    return asyncio.run(coro)


def _ledger_mid_apply():
    """A run that got most of the way through APPLY and then stopped."""
    led = StepLedger()
    led.enter("preparing")
    led.enter("extracting")
    led.note(done=1200, total=1200, unit="lineage edges")
    led.enter("computing")
    led.enter("applying")
    led.note(done=9000, total=12000, unit="aggregated edges")
    return led


def _job(**over):
    doc = {"steps": _ledger_mid_apply().snapshot(), "writes": 9000}
    fields = dict(
        id="J", data_source_id="ds", status="running",
        run_stats=json.dumps(doc), started_at="2026-01-01T00:00:00+00:00",
        completed_at=None, updated_at=None, error_message=None,
        last_cursor="v3:1:apply:9000",
    )
    fields.update(over)
    return types.SimpleNamespace(**fields)


class _State:
    def __init__(self, last_aggregated_at="2026-01-01T00:00:00+00:00"):
        self.data_source_id = "ds"
        self.aggregation_status = "running"
        self.last_aggregated_at = last_aggregated_at


class _Session:
    """Only the aggregation-owned state row exists — the public mirror is
    absent, as in a split-DB topology where the event listener owns it."""

    def __init__(self, state=None):
        self.state = state
        self.gets: list = []

    async def get(self, orm, key):
        self.gets.append(getattr(orm, "__name__", str(orm)))
        name = getattr(orm, "__name__", "")
        return self.state if name.endswith("StateORM") else None


# ── the ledger is sealed, so the run names the stage it died in ─────────


def test_a_reaped_run_names_the_stage_it_died_in():
    job = _job()
    steps = json.loads(job.run_stats)["steps"]
    assert failed_stage(steps) is None          # the bug, before the fix

    _run(reap_job(_Session(_State()), job, status="failed",
                  error_message=f"{WORKER_LOST} the pod went away"))

    steps = json.loads(job.run_stats)["steps"]
    assert failed_stage(steps) == "applying"
    assert open_step(steps) is None


def test_the_sealed_stage_keeps_how_far_it_got():
    """The stage rail draws "9,000 of 12,000" for the stage a run died in.
    Sealing must close the step, not blank it."""
    job = _job()
    _run(reap_job(_Session(_State()), job, status="failed"))
    entry = next(
        s for s in json.loads(job.run_stats)["steps"] if s["id"] == "applying"
    )
    assert entry["state"] == "failed"
    assert (entry["done"], entry["total"]) == (9000, 12000)
    assert entry["unit"] == "aggregated edges"
    assert entry["secs"] >= 0
    assert entry["waiting_for"] is None


def test_reaping_keeps_the_rest_of_the_run_record():
    """``run_stats.writes`` is what the scheduler's converging check reads
    off a failed job to decide whether the breaker should count it."""
    job = _job()
    _run(reap_job(_Session(_State()), job, status="failed"))
    assert json.loads(job.run_stats)["writes"] == 9000


def test_a_cancelled_run_seals_as_cancelled_not_failed():
    job = _job()
    _run(reap_job(_Session(_State()), job, status="cancelled"))
    steps = json.loads(job.run_stats)["steps"]
    assert failed_stage(steps) == "applying"
    assert next(s for s in steps if s["id"] == "applying")["state"] == "cancelled"


def test_sealing_is_idempotent_and_survives_a_junk_record():
    job = _job()
    assert seal_steps(job, "failed") is True
    assert seal_steps(job, "failed") is False       # nothing left open
    assert seal_steps(types.SimpleNamespace(run_stats="not json"), "failed") is False
    assert seal_steps(types.SimpleNamespace(run_stats=None), "failed") is False
    assert seal_steps(types.SimpleNamespace(), "failed") is False   # no column


def test_a_run_with_no_ledger_reaps_without_complaint():
    """Legacy rows, and any job reaped before its first checkpoint."""
    job = _job(run_stats=None)
    _run(reap_job(_Session(_State()), job, status="failed", error_message="gone"))
    assert job.status == "failed" and job.error_message == "gone"


# ── the source is handed back to automation ────────────────────────────


def test_the_source_leaves_in_flight():
    state = _State()
    job = _job()
    _run(reap_job(_Session(state), job, status="failed"))
    assert state.aggregation_status == "failed"


def test_a_job_that_never_started_on_a_never_built_source_goes_back_to_none():
    """The same rule ``cancel()`` applies: ``none`` is what lets the
    sweeper's never-built detector queue a FIRST build again. Anything else
    would leave a source that has never aggregated permanently failed."""
    state = _State(last_aggregated_at=None)
    job = _job(started_at=None)
    _run(reap_job(_Session(state), job, status="failed"))
    assert state.aggregation_status == "none"


@pytest.mark.parametrize("started_at,last_agg,expected", [
    ("2026-01-01T00:00:00+00:00", None, "failed"),          # it did start
    (None, "2026-01-01T00:00:00+00:00", "failed"),          # it has built before
    (None, None, "none"),                                    # neither
])
def test_the_never_ran_rule(started_at, last_agg, expected):
    state = _State(last_aggregated_at=last_agg)
    _run(reap_job(
        _Session(state), _job(started_at=started_at), status="failed",
    ))
    assert state.aggregation_status == expected


def test_a_missing_source_row_is_not_an_error():
    job = _job()
    _run(reap_job(_Session(None), job, status="failed"))
    assert job.status == "failed"


def test_a_reap_never_raises_on_a_broken_session():
    """A reaper that raises leaves the row ``running`` — the exact state it
    exists to clear — so every read it makes fails open."""
    class _Broken:
        async def get(self, orm, key):
            raise RuntimeError("db gone")

    job = _job()
    _run(release_source(_Broken(), job, "failed"))       # must not raise
    _run(reap_job(_Broken(), job, status="failed", error_message="x"))
    assert job.status == "failed"


def test_the_row_is_stamped_terminal():
    job = _job()
    _run(reap_job(_Session(_State()), job, status="failed",
                  error_message="x" * 5000, now_iso="2026-06-01T12:00:00+00:00"))
    assert job.status == "failed"
    assert job.completed_at == "2026-06-01T12:00:00+00:00"
    assert job.updated_at == "2026-06-01T12:00:00+00:00"
    assert len(job.error_message) == 2000        # bounded, like every other path


def test_an_omitted_message_leaves_the_previous_one_standing():
    job = _job(error_message="the pipeline's own last word")
    _run(reap_job(_Session(_State()), job, status="failed"))
    assert job.error_message == "the pipeline's own last word"


# ── the two infrastructure categories ──────────────────────────────────


def test_a_dead_worker_is_not_a_timeout():
    """"timeout" sends an operator to raise the stall window. No time limit
    brings back an evicted pod, and the run itself was healthy."""
    assert classify_failure(
        f"{WORKER_LOST} no checkpoint update in 14400s. The worker died; "
        f"resume from last_cursor is possible."
    ) == "worker_lost"


def test_a_row_nothing_ever_claimed_says_so():
    assert classify_failure(
        f"{NEVER_DISPATCHED} queued for 900s with no aggregation worker "
        f"registered on the job bus."
    ) == "never_dispatched"


def test_the_markers_are_a_prefix_contract_not_a_phrase_search():
    """Keyed off the marker the reaper writes, in the convention
    ``write budget:`` established — never off prose, which is free to
    change, and never off a phrase that could appear mid-message."""
    assert classify_failure(f"something else. {WORKER_LOST} nope") != "worker_lost"
    assert classify_failure(f"   {WORKER_LOST} leading space is fine") == "worker_lost"


def test_the_older_categories_are_untouched():
    assert classify_failure("write budget: 4GB needed, 1GB free") == "write_budget"
    assert classify_failure("Provider 'x' unavailable: OOM") == "out_of_memory"
    assert classify_failure("mem consumption exceeded capacity") == "query_memory"
    assert classify_failure("Connection refused") == "provider_unavailable"
    assert classify_failure(None) is None


def test_the_markers_read_as_english_in_the_message():
    """The marker is the first word of the sentence an operator reads, so it
    has to be prose as well as a key."""
    for marker in (WORKER_LOST, NEVER_DISPATCHED):
        assert marker.endswith(":") and marker.islower()


def test_the_public_mirror_is_synced_too():
    """The scheduler's watchdog used to write the aggregation-owned column
    and leave the viz-service's copy saying "running" forever."""
    seen: list = []

    async def _fake(session, ds_id, **fields):
        seen.append((ds_id, fields))

    original = reap_mod.sync_workspace_row
    reap_mod.sync_workspace_row = _fake
    try:
        _run(reap_job(_Session(_State()), _job(), status="failed"))
    finally:
        reap_mod.sync_workspace_row = original
    assert seen == [("ds", {"aggregation_status": "failed"})]
