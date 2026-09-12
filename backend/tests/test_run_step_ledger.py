"""The run's step ledger — the record behind "what step is it on, what has
been done, and how much is left".

The ledger is what a run says about itself while it runs AND the history it
leaves behind, so every property here is one an operator reads off the page.
"""
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.aggregation.steps import STEP_IDS, StepLedger

_EPOCH = datetime(2026, 9, 12, tzinfo=timezone.utc)


class _Clock:
    """ISO instants under test control — the ledger stores wall clock, not a
    monotonic counter, because the record is persisted and read back."""

    def __init__(self) -> None:
        self.t = 0

    def __call__(self) -> str:
        return (_EPOCH + timedelta(seconds=self.t)).isoformat()

    def tick(self, secs: int) -> None:
        self.t += secs


def _by_id(ledger):
    return {s["id"]: s for s in ledger.snapshot()}


def test_a_fresh_ledger_claims_nothing():
    ledger = StepLedger()
    snap = ledger.snapshot()
    assert [s["id"] for s in snap] == list(STEP_IDS)
    assert {s["state"] for s in snap} == {"pending"}
    assert ledger.open_step is None


def test_entering_a_step_closes_the_one_before_it_with_its_elapsed():
    clock = _Clock()
    ledger = StepLedger(clock=clock)
    ledger.enter("preparing")
    clock.tick(12)
    ledger.enter("extracting")

    steps = _by_id(ledger)
    assert steps["preparing"]["state"] == "done"
    assert steps["preparing"]["secs"] == 12.0
    assert steps["preparing"]["ended_at"] == (_EPOCH + timedelta(seconds=12)).isoformat()
    assert steps["extracting"]["state"] == "running"
    assert steps["extracting"]["secs"] == 0.0
    assert ledger.open_step == "extracting"


def test_the_open_steps_elapsed_is_not_baked_into_the_snapshot():
    # Otherwise every checkpoint would mark the record dirty and the
    # commit cadence would collapse into one PG write per batch.
    clock = _Clock()
    ledger = StepLedger(clock=clock)
    ledger.enter("extracting")
    first = ledger.snapshot()
    clock.tick(600)
    assert ledger.snapshot() == first
    # The reader has what it needs to add the difference itself.
    assert _by_id(ledger)["extracting"]["started_at"] == _EPOCH.isoformat()


def test_re_entering_the_open_step_does_not_re_count_the_visit():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    assert ledger.enter("extracting") is False
    assert _by_id(ledger)["extracting"]["visits"] == 1


def test_going_back_a_step_un_does_what_came_after_and_keeps_its_time():
    clock = _Clock()
    ledger = StepLedger(clock=clock)
    ledger.enter("extracting")
    clock.tick(30)
    ledger.enter("applying")
    ledger.note(done=400, total=1000, unit="aggregated edges")
    clock.tick(20)
    # A transient failure sends the pipeline back to the cursor: EXTRACT
    # re-runs, and APPLY has NOT been done.
    ledger.enter("extracting")

    steps = _by_id(ledger)
    assert steps["extracting"]["state"] == "running"
    assert steps["extracting"]["visits"] == 2
    assert steps["extracting"]["secs"] == 30.0  # the first pass still counts
    assert steps["applying"]["state"] == "pending"
    assert steps["applying"]["secs"] == 20.0  # so does the abandoned attempt
    assert steps["applying"]["done"] is None  # but its progress does not


def test_a_step_reports_its_own_unit_of_work():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("reconciling")
    assert ledger.note(done=3, total=40, unit="scan ranges") is True
    step = _by_id(ledger)["reconciling"]
    assert (step["done"], step["total"], step["unit"]) == (3, 40, "scan ranges")
    # Same numbers again is not a change — the caller's dirty flag stays honest.
    assert ledger.note(done=3, total=40, unit="scan ranges") is False


def test_units_that_cannot_be_read_as_numbers_are_ignored():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    assert ledger.note(done="not a number", total=None) is False
    assert _by_id(ledger)["extracting"]["done"] is None


def test_a_park_says_what_it_is_waiting_for_and_the_next_progress_clears_it():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    assert ledger.waiting("retry 1/3") is True
    assert ledger.waiting("retry 1/3") is False  # same park, no change
    step = _by_id(ledger)["extracting"]
    assert step["state"] == "waiting"
    assert step["waiting_for"] == "retry 1/3"

    assert ledger.note(done=10, total=100) is True
    step = _by_id(ledger)["extracting"]
    assert step["state"] == "running"
    assert step["waiting_for"] is None


def test_re_entering_a_parked_step_also_clears_the_park():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    ledger.waiting("the provider is quiesced (1/20)")
    assert ledger.enter("extracting") is True
    assert _by_id(ledger)["extracting"]["state"] == "running"
    assert _by_id(ledger)["extracting"]["visits"] == 1


def test_a_parked_step_still_accumulates_its_time_when_it_closes():
    clock = _Clock()
    ledger = StepLedger(clock=clock)
    ledger.enter("extracting")
    ledger.waiting("retry 1/3")
    clock.tick(45)
    ledger.enter("computing")
    assert _by_id(ledger)["extracting"]["secs"] == 45.0


def test_sealing_a_failed_run_names_the_step_it_died_in():
    clock = _Clock()
    ledger = StepLedger(clock=clock)
    ledger.enter("applying")
    clock.tick(90)
    ledger.seal("failed")

    step = _by_id(ledger)["applying"]
    assert step["state"] == "failed"
    assert step["secs"] == 90.0
    assert step["ended_at"] == (_EPOCH + timedelta(seconds=90)).isoformat()
    assert ledger.open_step is None


@pytest.mark.parametrize("status,expected", [
    ("completed", "done"), ("cancelled", "cancelled"), ("failed", "failed"),
])
def test_the_seal_carries_the_runs_terminal_state(status, expected):
    ledger = StepLedger(clock=_Clock())
    ledger.enter("finalizing")
    ledger.seal(status)
    assert _by_id(ledger)["finalizing"]["state"] == expected


def test_an_unknown_step_is_refused_rather_than_invented():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    assert ledger.enter("teleporting") is False
    assert ledger.open_step == "extracting"


def test_notes_before_any_step_opens_go_nowhere():
    ledger = StepLedger(clock=_Clock())
    assert ledger.note(done=1, total=2) is False
    assert ledger.waiting("nothing is running") is False


# ── the pipeline reports each step's own unit of work ────────────────────
#
# ``processed``/``total`` on the progress callback are — and have always
# been — the EXTRACT counters, whatever phase is running. From RECONCILE
# onwards they are frozen by design, which is why a run past the halfway
# mark could only ever show a percentage with no denominator anywhere on
# the page. Each phase already computed its own denominator for that
# percentage; these tests hold it to handing them over.

import asyncio  # noqa: E402  (the pipeline import below needs the path set up)

import test_falkordb_materialize as base  # noqa: E402
from backend.app.providers import falkordb_materialize as mat  # noqa: E402


def _recording_pipeline():
    """A pipeline whose progress callback keeps every checkpoint's stats."""
    pipe = base._make_pipeline()
    seen: list[dict] = []

    async def _cb(processed, total, cursor, aggregated, phase, **kwargs):
        seen.append({"phase": phase, **kwargs})

    pipe._progress_cb = _cb
    pipe._run_start_ms = 1
    return pipe, seen


def test_a_checkpoint_with_no_countable_unit_says_nothing_rather_than_zero():
    pipe, seen = _recording_pipeline()
    asyncio.run(pipe._checkpoint(mat.PHASE_AGGREGATE, 0, phase_label="computing"))
    assert "step" not in seen[0]["stats"]


def test_the_apply_step_counts_the_aggregated_edges_it_is_writing():
    pipe, seen = _recording_pipeline()
    pipe._acc = {k: 1 for k in range(1, 8)}
    pipe._flushed = set()
    pipe._tuning = {"apply_chunk": 1_000}

    async def _no_writes(acc, keys, *, weight_mode):
        return None

    pipe._write_keys = _no_writes
    asyncio.run(pipe._apply_missing(set()))

    applying = [s for s in seen if s["phase"] == "applying"]
    assert applying, "apply must report at least one checkpoint"
    step = applying[-1]["stats"]["step"]
    assert step == {"done": 7, "total": 7, "unit": "aggregated edges"}


def test_the_apply_step_reports_partial_progress_chunk_by_chunk():
    pipe, seen = _recording_pipeline()
    pipe._acc = {k: 1 for k in range(1, 10)}
    pipe._flushed = set()
    pipe._tuning = {"apply_chunk": 1_000}

    async def _no_writes(acc, keys, *, weight_mode):
        return None

    pipe._write_keys = _no_writes
    pipe._knob_int = lambda name, fn, lo, hi: 3  # three keys per chunk
    asyncio.run(pipe._apply_missing(set()))

    progress = [
        (s["stats"]["step"]["done"], s["stats"]["step"]["total"])
        for s in seen if s["phase"] == "applying"
    ]
    assert progress == [(3, 9), (6, 9), (9, 9)]


def test_every_counted_phase_hands_its_denominator_to_the_checkpoint():
    """EXTRACT and RECONCILE checkpoint from inside scan loops that no unit
    test can drive without a live graph, and both already compute the
    denominator one line above the call. Guard the call sites directly:
    dropping the counters there is silent, and the symptom — a percentage
    with no numbers behind it — is exactly what this work set out to fix."""
    import inspect

    src = inspect.getsource(mat.AggregationPipeline._extract_and_compute)
    assert "unit_done=self._scanned," in src
    assert "unit_total=self._total if self._total_counted else None" in src

    src = inspect.getsource(mat.AggregationPipeline._reconcile)
    assert "unit_done=lo // width," in src
    assert "unit_total=total_ranges," in src


# ── the worker folds the ledger into the row's run_stats ────────────────

import json  # noqa: E402

import test_aggregation_run_record as rec  # noqa: E402
from backend.app.jobs import JobScope as PlatformJobScope  # noqa: E402
from backend.app.services.aggregation.worker import AggregationWorker  # noqa: E402


class _PhasedProvider:
    """Drives the progress callback the way the pipeline does — a phase and
    that phase's own unit of work per checkpoint."""

    def __init__(self, checkpoints):
        self._checkpoints = checkpoints

    async def materialize_aggregated_edges_batch(self, **kw):
        cb = kw["progress_callback"]
        for i, (phase, step) in enumerate(self._checkpoints):
            await cb(
                10 * (i + 1), 100, f"v3:{i}", 0, phase,
                progress_pct=10 * (i + 1),
                stats={"writes": 0, "deletes": 0, **({"step": step} if step else {})},
            )
        return {"aggregated_edges_affected": 2, "run_stats": {"writes": 2}}


def _materialize_with(job, provider, ledger, session=None):
    worker = AggregationWorker(session_factory=None, registry=None, event_publisher=None)
    return asyncio.run(worker._materialize_with_checkpoints(
        session=session or rec._Session(), job=job, provider=provider,
        containment_types=["CONTAINS"], lineage_types=["FLOWS"],
        cancel_event=asyncio.Event(), emitter=rec._Emitter(),
        scope=PlatformJobScope(workspace_id="ws", data_source_id="ds_1"),
        ledger=ledger,
    ))


def test_the_checkpoints_move_the_ledger_onto_the_row():
    job, ledger = rec._Job(), StepLedger()
    ledger.enter("preparing")
    _materialize_with(job, _PhasedProvider([
        ("extracting", {"done": 40, "total": 100, "unit": "lineage edges"}),
        ("computing", None),
        ("reconciling", {"done": 2, "total": 8, "unit": "scan ranges"}),
        ("applying", {"done": 900, "total": 1200, "unit": "aggregated edges"}),
    ]), ledger)

    steps = {s["id"]: s for s in json.loads(job.run_stats)["steps"]}
    assert steps["preparing"]["state"] == "done"
    assert steps["extracting"]["state"] == "done"
    assert steps["extracting"]["done"] == 40  # what it got through, in its units
    assert steps["reconciling"]["state"] == "done"
    assert steps["applying"]["state"] == "running"
    assert (steps["applying"]["done"], steps["applying"]["total"]) == (900, 1200)
    assert steps["applying"]["unit"] == "aggregated edges"
    assert steps["finalizing"]["state"] == "pending"


def test_a_pipeline_that_sends_an_unknown_unit_key_does_not_break_the_checkpoint():
    """A rolling deploy can pair this worker with a newer pipeline. A
    TypeError in the ledger would skip the checkpoint's PG commit, not just
    the ledger — the failure mode that once left the bar frozen at zero for
    a whole run."""
    job, session, ledger = rec._Job(), rec._Session(), StepLedger()
    _materialize_with(job, _PhasedProvider([
        ("extracting", {"done": 7, "total": 9, "unit": "lineage edges", "phase_of_the_moon": "gibbous"}),
    ]), ledger, session)

    assert session.commits >= 1
    assert job.processed_edges == 10
    steps = {s["id"]: s for s in json.loads(job.run_stats)["steps"]}
    assert steps["extracting"]["done"] == 7


def test_a_run_with_no_ledger_still_checkpoints():
    """Every other caller of ``_materialize_with_checkpoints`` — and every
    test written before this one — passes no ledger."""
    job, session = rec._Job(), rec._Session()
    _materialize_with(job, _PhasedProvider([("extracting", {"done": 1, "total": 2})]), None, session)
    assert session.commits >= 1
    assert "steps" not in json.loads(job.run_stats or "{}")


# ── the extract stage tells the truth about its denominator ─────────────


def test_extract_announces_its_count_before_it_starts_scanning():
    """Everything before the first scan batch — the containment load, the
    mode decision, the non-leaf ids, the per-type counts — runs inside
    EXTRACT with no checkpoint between the one that opened the stage and the
    first batch of rows. On a large graph that is minutes reporting nothing,
    when the denominator is known part-way through."""
    import inspect

    src = inspect.getsource(mat.AggregationPipeline._extract_and_compute)
    after_count = src.split("self._total_counted = totals > 0")[1]
    assert 'phase_label="extracting"' in after_count.split("# ---- stream")[0]
    assert "unit_total=totals or None" in after_count


def test_the_scan_reports_no_denominator_when_the_count_could_not_answer():
    """``_count_type`` returns 0 for a ``count(r)`` that timed out as well as
    for a type with no edges, and the scan loop then keeps ``_total`` equal
    to ``_scanned`` — a bar drawn from that reads 100% complete for the whole
    scan. Without a denominator the stage reports the edges it has read,
    which is true."""
    import inspect

    src = inspect.getsource(mat.AggregationPipeline._extract_and_compute)
    assert "unit_total=self._total if self._total_counted else None" in src
    assert "unit_total=self._total," not in src   # the unguarded form


def test_a_step_with_a_count_but_no_denominator_still_reports_the_count():
    pipe, seen = _recording_pipeline()
    asyncio.run(pipe._checkpoint(
        mat.PHASE_AGGREGATE, 0, phase_label="extracting",
        unit_done=1_200, unit_total=None, unit="lineage edges",
    ))
    assert seen[0]["stats"]["step"] == {
        "done": 1_200, "total": None, "unit": "lineage edges",
    }


def test_the_ledger_keeps_a_count_with_no_denominator():
    ledger = StepLedger(clock=_Clock())
    ledger.enter("extracting")
    ledger.note(done=1_200, total=None, unit="lineage edges")
    step = {s["id"]: s for s in ledger.snapshot()}["extracting"]
    assert (step["done"], step["total"]) == (1_200, None)


# ── which node a run is writing ──────────────────────────────────────────
#
# "What else is on this shard right now" is asked about RUNNING jobs, long
# before the write-budget check puts the node inside its own record, and it
# has to follow a failover. So the node is on the run's record from the
# first checkpoint that has a measured reading.


def test_a_checkpoint_names_the_node_the_run_is_writing():
    pipe, seen = _recording_pipeline()
    pipe._gov_reading = _measured("10.0.0.4:6379")
    asyncio.run(pipe._checkpoint(mat.PHASE_APPLY, 0, phase_label="applying"))
    assert seen[0]["stats"]["node"] == "10.0.0.4:6379"


def test_an_unmeasured_reading_names_no_node_rather_than_a_wrong_one():
    pipe, seen = _recording_pipeline()
    pipe._gov_reading = None
    asyncio.run(pipe._checkpoint(mat.PHASE_APPLY, 0, phase_label="applying"))
    assert "node" not in seen[0]["stats"]


def test_the_node_lands_on_the_row_and_follows_a_failover(monkeypatch):
    # On the checkpoint cadence, like every other run_stats field: a promoted
    # replica is named on the next commit, not the next batch.
    import backend.app.services.aggregation.worker as worker_mod

    monkeypatch.setattr(worker_mod, "_CHECKPOINT_MAX_BATCHES", 1)
    job, ledger = rec._Job(), StepLedger()
    _materialize_with(job, _NodeProvider(["10.0.0.4:6379", "10.0.0.9:6379"]), ledger)
    assert json.loads(job.run_stats)["node"] == "10.0.0.9:6379"


class _NodeProvider:
    """Checkpoints that name a node — the second one a different node, the
    way a promoted replica answers after a failover."""

    def __init__(self, nodes):
        self._nodes = nodes

    async def materialize_aggregated_edges_batch(self, **kw):
        cb = kw["progress_callback"]
        for i, node in enumerate(self._nodes):
            await cb(
                10 * (i + 1), 100, f"v3:{i}", 0, "applying",
                progress_pct=10 * (i + 1),
                stats={"writes": 0, "deletes": 0, "node": node},
            )
        return {"aggregated_edges_affected": 0, "run_stats": {"writes": 0}}


def _measured(endpoint: str):
    from backend.app.providers.shard_capacity import ShardMemory

    return ShardMemory(endpoint, 1 << 30, 40 << 30, "noeviction", 0.0, "measured")
