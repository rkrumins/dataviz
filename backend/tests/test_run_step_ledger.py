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


# ── how much of a run is left ───────────────────────────────────────────
#
# The ETA this replaces extrapolated ``elapsed * (100 - pct) / pct`` from
# one phase-weighted percentage. That is only right if every stage runs at
# the same rate, which is exactly false — EXTRACT is a scan, APPLY is paced
# writes, and the two bookends are fingerprints. On a RESUMED run it was
# wrong twice over: the percentage was held up by a monotonic clamp while
# the run redid its early stages, and elapsed ran from the FIRST attempt's
# start, so a job redoing two hours of work reported forty minutes left.

from datetime import datetime as _dt, timedelta as _td, timezone as _tz  # noqa: E402

from backend.app.services.aggregation.steps import (  # noqa: E402
    open_step, remaining_secs,
)

_NOW = _dt(2026, 9, 12, 12, 0, 0, tzinfo=_tz.utc)


def _done(step_id: str, secs: float) -> dict:
    return {"id": step_id, "state": "done", "secs": secs,
            "started_at": None, "ended_at": None, "visits": 1,
            "done": None, "total": None, "unit": None, "waiting_for": None}


def _open(step_id: str, *, ago: float, done=None, total=None) -> dict:
    return {"id": step_id, "state": "running", "secs": 0.0,
            "started_at": (_NOW - _td(seconds=ago)).isoformat(),
            "ended_at": None, "visits": 1,
            "done": done, "total": total, "unit": "rows", "waiting_for": None}


_PREVIOUS = [
    _done("preparing", 20), _done("extracting", 100), _done("computing", 40),
    _done("reconciling", 60), _done("applying", 200), _done("finalizing", 30),
]


def test_it_owes_the_rest_of_this_stage_plus_every_stage_after_it():
    left = remaining_secs(
        [_done("preparing", 18), _done("extracting", 90), _done("computing", 30),
         _open("reconciling", ago=10, done=5, total=10)],
        _PREVIOUS, now=_NOW,
    )
    assert left == 30 + 200 + 30       # half of reconcile, then apply + finish


def test_it_counts_the_two_stages_the_percentage_could_never_see():
    # A run sitting in PREPARE owes the WHOLE of the last run. The old
    # estimate had no term for either bookend.
    left = remaining_secs([_open("preparing", ago=5)], _PREVIOUS, now=_NOW)
    assert left == 20 + 100 + 40 + 60 + 200 + 30


def test_a_run_slower_than_last_time_is_projected_from_its_own_rate():
    # A tenth through apply after 300s: this run says 2,700s to go, which
    # beats history's 180s. An estimate that keeps sliding is worse than one
    # that was pessimistic from the start.
    left = remaining_secs(
        [_done("preparing", 20), _done("extracting", 100), _done("computing", 40),
         _done("reconciling", 60), _open("applying", ago=300, done=100, total=1000)],
        _PREVIOUS, now=_NOW,
    )
    assert left == 2_700 + 30


def test_a_resumed_run_is_projected_from_where_it_actually_is():
    """THE case the old estimate got wrong. The run is back in EXTRACT after
    a resume; it owes extract, compute, reconcile, apply and finish again —
    not the sliver its inflated percentage implied."""
    left = remaining_secs([_open("extracting", ago=10)], _PREVIOUS, now=_NOW)
    assert left == 100 + 40 + 60 + 200 + 30


def test_no_comparable_run_means_no_estimate_rather_than_a_guess():
    assert remaining_secs([_open("applying", ago=10)], None, now=_NOW) is None
    assert remaining_secs(None, _PREVIOUS, now=_NOW) is None
    assert remaining_secs([_open("applying", ago=10)], [], now=_NOW) is None
    trivial = [_done(s["id"], 0.2) for s in _PREVIOUS]
    assert remaining_secs([_open("applying", ago=10)], trivial, now=_NOW) is None


def test_a_run_with_nothing_open_owes_nothing_it_can_name():
    assert remaining_secs(_PREVIOUS, _PREVIOUS, now=_NOW) is None


def test_a_ledger_read_back_as_junk_does_not_raise():
    # It comes out of a JSON column written by another process.
    assert remaining_secs("not a list", _PREVIOUS, now=_NOW) is None
    assert remaining_secs([{"id": "teleporting", "state": "running"}], _PREVIOUS, now=_NOW) is None
    assert open_step([1, 2, 3]) is None
    assert open_step(None) is None


def test_a_parked_stage_still_counts_as_the_open_one():
    # Waiting is time the run is spending; it still owes what comes after.
    parked = dict(_open("applying", ago=10), state="waiting", waiting_for="retry 1/3")
    assert remaining_secs([parked], _PREVIOUS, now=_NOW) == 200 + 30


# ── progress is this ATTEMPT's position, not a high-water mark ───────────
#
# It used to be floored at the row's previous value so the bar never moved
# backwards. That put it in permanent disagreement with processed_edges on
# the line below, which was never floored and does reset: a resumed run
# showed a bar at 75% beside "0 / 500,000 edges scanned". The stage rail
# says "restarted x1" now, so a bar that moves back is explained where it
# used to be unexplainable.


class _RestartingProvider:
    """Checkpoints that go FORWARD and then back to the start, the way a
    transient failure or a resume sends the pipeline back to EXTRACT."""

    def __init__(self, pcts):
        self._pcts = pcts

    async def materialize_aggregated_edges_batch(self, **kw):
        cb = kw["progress_callback"]
        for i, (pct, phase, processed) in enumerate(self._pcts):
            await cb(
                processed, 100, f"v3:{i}", 0, phase,
                progress_pct=pct, stats={"writes": 0, "deletes": 0},
            )
        return {"aggregated_edges_affected": 0, "run_stats": {"writes": 0}}


def test_progress_comes_back_down_when_the_run_goes_back_a_stage(monkeypatch):
    import backend.app.services.aggregation.worker as worker_mod

    monkeypatch.setattr(worker_mod, "_CHECKPOINT_MAX_BATCHES", 1)
    job = rec._Job()
    _materialize_with(job, _RestartingProvider([
        (75, "applying", 500),
        (3, "extracting", 20),        # a retry from the cursor: EXTRACT again
    ]), StepLedger())
    assert job.progress == 3
    assert job.processed_edges == 20   # …and the counters agree with it


def test_the_two_numbers_on_the_row_no_longer_contradict_each_other(monkeypatch):
    import backend.app.services.aggregation.worker as worker_mod

    monkeypatch.setattr(worker_mod, "_CHECKPOINT_MAX_BATCHES", 1)
    job = rec._Job()
    job.progress, job.processed_edges = 75, 500_000     # what a resume inherits
    _materialize_with(job, _RestartingProvider([(0, "extracting", 0)]), StepLedger())
    assert (job.progress, job.processed_edges) == (0, 0)


def test_a_run_that_only_moves_forward_is_unaffected(monkeypatch):
    import backend.app.services.aggregation.worker as worker_mod

    monkeypatch.setattr(worker_mod, "_CHECKPOINT_MAX_BATCHES", 1)
    job = rec._Job()
    _materialize_with(job, _RestartingProvider([
        (10, "extracting", 100), (45, "extracting", 450), (75, "applying", 450),
    ]), StepLedger())
    assert job.progress == 75


# ── the ETA the API ships ───────────────────────────────────────────────

from backend.app.services.aggregation.service import _estimate_completion  # noqa: E402


class _Row:
    def __init__(self, **kw):
        self.status = "running"
        self.run_stats = None
        self.started_at = "2026-09-12T10:00:00+00:00"
        self.progress = 50
        self.__dict__.update(kw)


def _ledger(steps):
    return json.dumps({"steps": steps})


def _open_now(step_id: str, *, ago: float, done=None, total=None) -> dict:
    """An open step anchored to the REAL clock — ``_estimate_completion``
    takes no ``now``, so the fixed-clock helper above cannot be used here."""
    return {"id": step_id, "state": "running", "secs": 0.0,
            "started_at": (_dt.now(_tz.utc) - _td(seconds=ago)).isoformat(),
            "ended_at": None, "visits": 1,
            "done": done, "total": total, "unit": "rows", "waiting_for": None}


def test_the_api_projects_the_finish_off_the_two_ledgers():
    row = _Row(run_stats=_ledger([_open_now("applying", ago=10, done=1, total=2)]))
    at = _estimate_completion(row, _PREVIOUS)
    assert at is not None
    owed = (_dt.fromisoformat(at) - _dt.now(_tz.utc)).total_seconds()
    assert 120 < owed < 140          # half of apply (100) + finish (30)


def test_no_comparable_previous_run_means_no_time_at_all():
    """Better than the confidently wrong one it replaces: the stage's own
    "3 of 12 scan ranges, 9 left" answers "how much is left" without
    inventing a clock time nobody can stand behind."""
    row = _Row(run_stats=_ledger([_open_now("applying", ago=10)]))
    assert _estimate_completion(row, None) is None


def test_a_resumed_run_is_no_longer_told_it_is_nearly_done():
    """The case that made this worth changing. Old rule: elapsed (from the
    FIRST attempt's start) x (100 - pct) / pct, with pct held high by the
    clamp — two hours of work reported as forty minutes. The ledger says the
    run is back in EXTRACT and owes almost everything."""
    row = _Row(
        progress=75,                                  # what the clamp used to hold
        started_at=(_dt.now(_tz.utc) - _td(hours=2)).isoformat(),
        run_stats=_ledger([_open_now("extracting", ago=30)]),
    )
    owed = (_dt.fromisoformat(_estimate_completion(row, _PREVIOUS)) - _dt.now(_tz.utc)).total_seconds()
    assert owed > 400                                 # 100+40+60+200+30, not minutes


def test_a_job_that_is_not_running_gets_no_estimate():
    for status in ("completed", "failed", "cancelled", "pending"):
        assert _estimate_completion(_Row(status=status, run_stats=_ledger(_PREVIOUS)), _PREVIOUS) is None


def test_a_run_with_no_ledger_at_all_gets_no_estimate():
    assert _estimate_completion(_Row(run_stats=None), _PREVIOUS) is None
    assert _estimate_completion(_Row(run_stats="{not json"), _PREVIOUS) is None


# ── which previous run is the baseline ──────────────────────────────────

from backend.app.services.aggregation.service import _prior_ledgers  # noqa: E402


class _Session:
    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _query):
        return self._rows


class _Running:
    def __init__(self, ds_id="ds-1", status="running"):
        self.data_source_id, self.status = ds_id, status


def _row(ds_id, *, writes=0, deletes=0, steps=None, at="2026-09-12T11:00:00Z"):
    return (ds_id, json.dumps({"writes": writes, "deletes": deletes, "steps": steps or _PREVIOUS}), at)


def test_a_no_change_previous_run_is_not_the_baseline():
    """It found everything already there, so its reconcile and apply took
    seconds. Projecting a real rebuild from it promises a finish that was
    never possible — the same guard Job History's own projection has."""
    out = asyncio.run(_prior_ledgers(_Session([_row("ds-1")]), [_Running()]))
    assert out == {}


def test_the_newest_run_that_actually_wrote_is_the_baseline():
    older = [_done("applying", 999)]
    rows = [
        _row("ds-1", at="2026-09-12T11:00:00Z"),                       # no-change
        _row("ds-1", writes=9_000, steps=older, at="2026-09-12T09:00:00Z"),
    ]
    assert asyncio.run(_prior_ledgers(_Session(rows), [_Running()])) == {"ds-1": older}


def test_a_deleting_run_counts_as_one_that_wrote():
    rows = [_row("ds-1", deletes=40)]
    assert asyncio.run(_prior_ledgers(_Session(rows), [_Running()])) == {"ds-1": _PREVIOUS}


def test_a_previous_run_from_before_the_ledger_is_no_baseline():
    rows = [("ds-1", json.dumps({"writes": 9_000}), "2026-09-12T11:00:00Z")]
    assert asyncio.run(_prior_ledgers(_Session(rows), [_Running()])) == {}


def test_nothing_running_costs_no_query_at_all():
    class _Explodes:
        async def execute(self, _query):
            raise AssertionError("should not have been queried")

    assert asyncio.run(_prior_ledgers(_Explodes(), [_Running(status="completed")])) == {}


def test_a_database_that_cannot_answer_costs_no_estimate_and_no_500():
    class _Down:
        async def execute(self, _query):
            raise RuntimeError("connection reset")

    assert asyncio.run(_prior_ledgers(_Down(), [_Running()])) == {}


# ── the attempt log ─────────────────────────────────────────────────────
#
# A job ROW is a run; a run has many ATTEMPTS. Every per-attempt field used
# to be overwritten in place, so resuming a failed job erased the record of
# why you were resuming it — with the single click taken BECAUSE it failed.

from backend.app.services.aggregation.steps import (  # noqa: E402
    archive_attempt, failed_stage, record_attempt,
)


def _died_in(stage: str, *, got=900, owed=1_200):
    ledger = StepLedger(clock=_Clock())
    ledger.enter("preparing")
    ledger.enter(stage)
    ledger.note(done=got, total=owed, unit="aggregated edges")
    ledger.seal("failed")
    return ledger.snapshot()


def test_a_failed_attempt_is_archived_with_where_and_why():
    doc = {"steps": _died_in("applying"), "writes": 400, "deletes": 2}
    assert record_attempt(
        doc, status="failed", error="the shard had no room", category="write_budget",
        progress=62, writes=400, deletes=2,
    ) is True
    [attempt] = doc["attempts"]
    assert attempt["n"] == 1
    assert attempt["stage"] == "applying"
    assert attempt["progress"] == 62
    assert attempt["category"] == "write_budget"
    assert attempt["error"] == "the shard had no room"
    assert {s["id"] for s in attempt["steps"]} == {"preparing", "applying"}
    # …and the live ledger is GONE, which is what makes it idempotent.
    assert "steps" not in doc


def test_archiving_twice_does_not_duplicate_the_attempt():
    """Both the manual resume path and the worker's attempt start call this
    without coordinating. Whichever runs first does the work."""
    doc = {"steps": _died_in("applying")}
    assert record_attempt(doc, status="failed") is True
    assert record_attempt(doc, status="failed") is False
    assert len(doc["attempts"]) == 1


def test_a_successful_attempt_is_not_archived():
    """It IS the run record. Storing it twice doubles every row's payload
    for nothing, and it is what keeps a healthy row carrying none of this."""
    ledger = StepLedger(clock=_Clock())
    for step in ("preparing", "extracting", "computing", "reconciling", "applying", "finalizing"):
        ledger.enter(step)
    ledger.seal("completed")
    doc = {"steps": ledger.snapshot()}
    assert record_attempt(doc, status="completed") is False
    assert "attempts" not in doc


def test_a_run_that_never_opened_a_stage_leaves_nothing_behind():
    assert record_attempt({"steps": StepLedger(clock=_Clock()).snapshot()}, status="failed") is False
    assert record_attempt({}, status="failed") is False
    assert record_attempt({"steps": "junk"}, status="failed") is False


def test_the_log_keeps_the_most_recent_failures(monkeypatch):
    monkeypatch.setenv("AGGREGATION_ATTEMPTS_KEPT", "3")
    doc: dict = {}
    for i in range(6):
        doc["steps"] = _died_in("applying", got=i)
        record_attempt(doc, status="failed", progress=i)
    assert [a["progress"] for a in doc["attempts"]] == [3, 4, 5]
    assert [a["n"] for a in doc["attempts"]] == [4, 5, 6]   # numbering never restarts


def test_an_archived_attempt_drops_what_only_meant_something_live():
    doc = {"steps": _died_in("applying")}
    record_attempt(doc, status="failed")
    step = doc["attempts"][0]["steps"][0]
    assert set(step) == {"id", "state", "secs", "visits", "done", "total", "unit"}
    assert "started_at" not in step and "waiting_for" not in step


def test_failed_stage_names_the_one_it_stopped_in():
    assert failed_stage(_died_in("reconciling")) == "reconciling"
    assert failed_stage([]) is None
    assert failed_stage("junk") is None


# ── the job-row wrapper ─────────────────────────────────────────────────


class _JobRow:
    def __init__(self, **kw):
        self.run_stats = None
        self.status = "failed"
        self.progress = 62
        self.error_message = "the shard had no room"
        self.completed_at = "2026-09-12T09:31:00Z"
        self.updated_at = None
        self.__dict__.update(kw)


def test_the_row_keeps_its_history_across_a_resume():
    job = _JobRow(run_stats=json.dumps({"steps": _died_in("applying"), "writes": 400}))
    assert archive_attempt(job, category="write_budget") is True
    doc = json.loads(job.run_stats)
    assert doc["attempts"][0]["stage"] == "applying"
    assert doc["attempts"][0]["writes"] == 400
    assert "steps" not in doc


def test_a_row_whose_record_cannot_be_read_is_left_alone():
    for bad in (None, "", "{not json", json.dumps([1, 2, 3])):
        assert archive_attempt(_JobRow(run_stats=bad)) is False


def test_a_row_without_the_column_at_all_is_left_alone():
    class _Legacy:
        status = "failed"

    assert archive_attempt(_Legacy()) is False


# ── the two paths that archive, and the one that must not ───────────────


def test_a_manual_resume_keeps_the_record_it_used_to_erase(monkeypatch):
    """service.resume cleared the error, reset the retry count and let a
    fresh ledger replace the old one — erasing, with the single click taken
    BECAUSE a run failed, the whole record of why it failed."""
    import backend.app.services.aggregation.service as svc

    job = _JobRow(
        status="failed", retry_count=2,
        run_stats=json.dumps({"steps": _died_in("applying"), "writes": 400}),
    )
    svc.archive_attempt(job, category=svc.classify_failure(job.error_message))
    job.retry_count, job.error_message = 0, None

    doc = json.loads(job.run_stats)
    assert doc["attempts"][0]["stage"] == "applying"
    assert doc["attempts"][0]["error"] == "the shard had no room"
    assert doc["attempts"][0]["progress"] == 62


def test_the_worker_archives_a_previous_attempt_at_its_own_start():
    """A worker that died without reaching a terminal block leaves the row
    holding a half-open ledger. The NEXT attempt is what captures it."""
    stuck = StepLedger(clock=_Clock())
    stuck.enter("preparing")
    stuck.enter("applying")           # never sealed — the worker vanished
    job = _JobRow(status="running", run_stats=json.dumps({"steps": stuck.snapshot()}))

    assert archive_attempt(job, category=None) is True
    doc = json.loads(job.run_stats)
    assert doc["attempts"][0]["stage"] is None          # it never said it failed
    assert {s["id"] for s in doc["attempts"][0]["steps"]} == {"preparing", "applying"}


def test_a_run_that_simply_finished_leaves_no_attempt_behind():
    ledger = StepLedger(clock=_Clock())
    for step in STEP_IDS:
        ledger.enter(step)
    ledger.seal("completed")
    job = _JobRow(status="completed", run_stats=json.dumps({"steps": ledger.snapshot()}))
    assert archive_attempt(job) is False
    assert "attempts" not in json.loads(job.run_stats)
