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
    """Reaping seals the step ledger; it must not drop the counters the run
    committed on its way down (``writes`` on the record, and beside it the
    ``edges_before`` the scheduler's converging check compares across runs)."""
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


def test_a_graph_with_no_attribute_ids_left_is_its_own_bucket():
    """FalkorDB's refusal — raw, and wrapped in the provider's "unavailable"
    wording — and the pipeline's own pre-flight land in one bucket, and not
    in provider_unavailable, which the word "unavailable" would otherwise
    claim. The only way past it is to recreate the graph, so the bucket is
    one no Resume may be offered for."""
    from backend.app.providers.falkordb_materialize import _attribute_limit_message
    from backend.app.services.aggregation.service import _UNRESUMABLE_CATEGORIES

    raw = (
        "Max number of attributes exceeded, graph does not support more than "
        "65534 unique attribute names"
    )
    assert classify_failure(raw) == "attribute_limit"
    assert classify_failure(f"Provider 'x' unavailable: {raw}") == "attribute_limit"
    assert classify_failure(_attribute_limit_message("g", 65_100)) == "attribute_limit"
    assert classify_failure(_attribute_limit_message("g", None)) == "attribute_limit"
    assert "attribute_limit" in _UNRESUMABLE_CATEGORIES


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


# ── the PUBLIC mirror has a narrower vocabulary than the private row ────
#
# ``workspace_data_sources.aggregation_status`` carries a CHECK constraint
# (``ck_ds_aggregation_status``) that allows none|pending|running|ready|
# failed|skipped and NOT 'cancelled'. The private
# ``aggregation_data_source_state`` row has no such constraint, and
# ``AggregationService.cancel`` writes 'cancelled' to it deliberately.
#
# So a reaper that forwards the private value to the mirror verbatim writes a
# value the constraint rejects. The violation lands at FLUSH, outside
# ``sync_workspace_row``'s try/except, so it takes down the whole reconciler
# tick: every job it reaped stays 'running', the source stays in-flight, and
# the next tick reaps the same row and fails the same way. Forever.
#
# ``_MIRROR_STATUS`` maps to what the event listener writes for the same
# terminal event (``job.cancelled`` -> 'none', event_listener.py), so both
# paths leave the mirror saying the same thing.


class _MirrorRow:
    """The public mirror row, as a single-DB topology has it."""

    def __init__(self):
        self.id = "ds"
        self.deleted_at = None
        self.aggregation_status = "running"


class _SingleDBSession:
    """Both rows exist — the single-DB topology the compose stack ships,
    where no event listener owns the mirror and the reaper writes it."""

    def __init__(self, state, mirror):
        self.state = state
        self.mirror = mirror

    async def get(self, orm, key):
        name = getattr(orm, "__name__", "")
        return self.state if name.endswith("StateORM") else self.mirror


def _mirror_vocabulary() -> set:
    """The values ``ck_ds_aggregation_status`` actually permits, read off the
    ORM so this test cannot drift from the constraint."""
    from backend.app.db.models import WorkspaceDataSourceORM
    import re

    for arg in WorkspaceDataSourceORM.__table__.constraints:
        text = str(getattr(arg, "sqltext", ""))
        if "aggregation_status" in text:
            return set(re.findall(r"'([a-z]+)'", text))
    raise AssertionError("ck_ds_aggregation_status not found on the ORM")


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_a_reaped_run_writes_a_status_the_mirror_constraint_permits(status):
    mirror = _MirrorRow()
    job = _job()
    _run(reap_job(_SingleDBSession(_State(), mirror), job, status=status))
    allowed = _mirror_vocabulary()
    assert mirror.aggregation_status in allowed, (
        f"reap_job(status={status!r}) wrote "
        f"{mirror.aggregation_status!r} to workspace_data_sources, which "
        f"ck_ds_aggregation_status rejects (allows {sorted(allowed)}). The "
        f"flush raises and the whole reconciler tick rolls back."
    )


def test_a_cancelled_reap_leaves_the_mirror_where_the_event_listener_would():
    """``job.cancelled`` -> ``aggregation_status='none'`` in
    event_listener.py. A reaped cancel must not disagree with it."""
    mirror = _MirrorRow()
    _run(reap_job(_SingleDBSession(_State(), mirror), _job(), status="cancelled"))
    assert mirror.aggregation_status == "none"


def test_the_private_row_still_records_cancelled():
    """Only the MIRROR's vocabulary is narrow. The private row keeps the
    precise terminal status, as ``AggregationService.cancel`` writes it."""
    state = _State()
    _run(reap_job(_SingleDBSession(state, _MirrorRow()), _job(), status="cancelled"))
    assert state.aggregation_status == "cancelled"


# ── the reaper is the worker's ``finally``, and that block invalidates ───
#
# The worker's terminal block does four things; this module's docstring
# names three of them. The fourth is the terminal EVENT, and
# ``event_listener`` turns that into
# ``invalidate_aggregated_reads(workspace_id, data_source_id)`` for
# job.failed and job.cancelled alike — because "a failed run may have
# PARTIALLY written before dying — cached pre-run answers no longer match
# the store" (event_listener.py).
#
# A reaper emits no event, so nothing invalidated. That matters more than a
# missed bump: ``graph_cache._promote_mirror`` treats an UNMOVED generation
# as proof the answer is still current and re-promotes the pre-run view past
# every TTL expiry, bounded only by ``GRAPH_CACHE_LKG_TTL_S`` (24 h). A
# rebuild that wrote rollup edges and then had its pod killed therefore left
# users on stale lineage for up to a day, with no stale banner either.


def _reap_with_spy(monkeypatch, *, status, job=None, session=None):
    """Reap while recording what the cache choke point was asked to do."""
    calls: list = []

    async def _spy(workspace_id, data_source_id):
        calls.append((workspace_id, data_source_id))

    import backend.app.services.graph_cache as gc
    monkeypatch.setattr(gc, "invalidate_aggregated_reads", _spy)
    _run(reap_job(session or _Session(_State()), job or _job(), status=status))
    return calls


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_a_reaped_run_invalidates_the_aggregated_read_caches(monkeypatch, status):
    calls = _reap_with_spy(monkeypatch, status=status, job=_job(workspace_id="ws1"))
    assert calls == [("ws1", "ds")], (
        "a reaped run wrote rollup edges the caches do not know about; "
        "_promote_mirror will keep serving the pre-run answer for up to "
        "GRAPH_CACHE_LKG_TTL_S because the generation never moved"
    )


def test_a_run_with_no_workspace_id_does_not_invalidate(monkeypatch):
    """The cache keys are workspace-scoped, so there is no scope to build —
    the same rule ``event_listener`` applies to pre-workspace_id events."""
    calls = _reap_with_spy(monkeypatch, status="failed", job=_job(workspace_id=None))
    assert calls == []


def test_invalidation_failure_never_fails_the_reap(monkeypatch):
    """A reaper that raises leaves the row ``running`` — the state it exists
    to clear. Cache invalidation is best-effort like every other read here."""
    async def _boom(workspace_id, data_source_id):
        raise RuntimeError("redis gone")

    import backend.app.services.graph_cache as gc
    monkeypatch.setattr(gc, "invalidate_aggregated_reads", _boom)
    job = _job(workspace_id="ws1")
    _run(reap_job(_Session(_State()), job, status="failed"))   # must not raise
    assert job.status == "failed"
