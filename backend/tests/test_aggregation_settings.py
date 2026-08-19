"""Unit tests for per-job tuning + global settings plumbing.

Covers: AggregationTuning bounds + merge semantics, the service's
defaults-merge at trigger time, resume tuning overrides, the pipeline's
knob resolution (job tuning beats env), and the control-plane resume
endpoint accepting an overrides body (regression: it used to drop it).
"""
import asyncio
import inspect
import json

import pytest
from pydantic import ValidationError

from backend.app.services.aggregation.schemas import (
    AggregationTriggerRequest,
    AggregationTuning,
    ResumeOverrides,
)


def _run(coro):
    return asyncio.run(coro)


#: What every UI trigger path sends as ``timeoutSecs`` — the frontend's
#: ``PRESET_TIMEOUT_MINUTES * 60`` (AggregationOverridesForm.tsx).
PRESET_TIMEOUT_SECS = 180 * 60


# ── schema bounds + merge ───────────────────────────────────────────────


def test_tuning_bounds_enforced():
    with pytest.raises(ValidationError):
        AggregationTuning(scan_range_width=1)          # < 10k
    with pytest.raises(ValidationError):
        AggregationTuning(extract_concurrency=9)       # > 4
    with pytest.raises(ValidationError):
        AggregationTuning(write_pacing_ratio=-1)
    t = AggregationTuning(scanRangeWidth=100_000, extractConcurrency=3)
    assert t.scan_range_width == 100_000
    assert t.extract_concurrency == 3


def test_rollup_storage_accepts_the_auto_tri_state():
    """``auto`` is a third MODE, not a missing bool, and it has to survive the
    wire. The field was ``Optional[bool]``, so the only way to ask for auto was
    to omit the key — and omission means "inherit", which cannot walk a stored
    global back. See the merge test below for why that mattered."""
    assert AggregationTuning(materializeFinePairs="auto").materialize_fine_pairs == "auto"
    assert AggregationTuning(materializeFinePairs=True).materialize_fine_pairs is True
    assert AggregationTuning(materializeFinePairs=False).materialize_fine_pairs is False
    assert AggregationTuning().materialize_fine_pairs is None
    # It must not be COERCED to a bool — a truthy read of "auto" would force
    # the full cube on every graph that asked for the safe mode.
    assert AggregationTuning(materializeFinePairs="auto").materialize_fine_pairs is not True
    with pytest.raises(ValidationError):
        AggregationTuning(materializeFinePairs="cube")
    # Lax bool coercion on the other member is deliberately preserved: the
    # trigger API accepted these before the union and still must.
    assert AggregationTuning(materializeFinePairs="true").materialize_fine_pairs is True
    assert AggregationTuning(materializeFinePairs=1).materialize_fine_pairs is True


def test_auto_can_override_a_stored_full_detail_default():
    """The bug this tri-state exists to fix. ``merged_over`` drops None, so
    while "Auto" was expressed by omitting the key, a global default of
    ``true`` was inherited by every job even when the dialog showed Auto — the
    UI said one thing and the pipeline did another."""
    merged = AggregationTuning(materializeFinePairs="auto").merged_over(
        {"materialize_fine_pairs": True},
    )
    assert merged["materialize_fine_pairs"] == "auto"
    # And the round trip the worker actually performs.
    assert json.loads(json.dumps(merged))["materialize_fine_pairs"] == "auto"


def test_auto_survives_the_dump_the_job_row_is_written_from():
    from backend.app.providers import falkordb_materialize as mat

    dumped = AggregationTuning(materializeFinePairs="auto").model_dump(exclude_none=True)
    frozen = json.loads(json.dumps(dumped))
    pipeline = mat.AggregationPipeline(
        provider=type("P", (), {"_graph_name": "g"})(),
        containment_edge_types=None,
        lineage_edge_types=None,
        last_cursor=None,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        tuning=frozen,
    )
    assert pipeline._fine_mode() == "auto"


def test_fine_mode_resolves_every_state(monkeypatch):
    from backend.app.providers import falkordb_materialize as mat

    def _pipeline(tuning):
        return mat.AggregationPipeline(
            provider=type("P", (), {"_graph_name": "g"})(),
            containment_edge_types=None,
            lineage_edge_types=None,
            last_cursor=None,
            progress_callback=None,
            intra_batch_callback=None,
            should_cancel=None,
            tuning=tuning,
        )

    assert _pipeline({"materialize_fine_pairs": True})._fine_mode() == "true"
    assert _pipeline({"materialize_fine_pairs": False})._fine_mode() == "false"
    assert _pipeline({"materialize_fine_pairs": "auto"})._fine_mode() == "auto"
    # Absent falls through to the env tri-state, which is what makes the
    # shipped default reachable at all.
    monkeypatch.delenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", raising=False)
    assert _pipeline({})._fine_mode() == "true"
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "auto")
    assert _pipeline({})._fine_mode() == "auto"


def test_tuning_merged_over_defaults():
    t = AggregationTuning(write_pacing_ratio=1.5)
    merged = t.merged_over({"scan_range_width": 100_000, "write_pacing_ratio": 0.5})
    assert merged == {"scan_range_width": 100_000, "write_pacing_ratio": 1.5}


def test_trigger_and_resume_accept_tuning_aliases():
    req = AggregationTriggerRequest(
        **{"tuning": {"scanRangeWidth": 50_000, "materializeLeafPairs": True}}
    )
    assert req.tuning.scan_range_width == 50_000
    assert req.tuning.materialize_leaf_pairs is True
    ov = ResumeOverrides(**{"tuning": {"extractConcurrency": 2}})
    assert ov.tuning.extract_concurrency == 2


# ── service defaults merge ──────────────────────────────────────────────


class _FakeSettingsRow:
    tuning_json = json.dumps({"scan_range_width": 111_000, "apply_chunk": 2_000})
    updated_at = None
    updated_by = None


class _FakeSession:
    def __init__(self, row):
        self._row = row

    async def get(self, orm, key):
        return self._row


def _make_service():
    from backend.app.services.aggregation.service import AggregationService
    return AggregationService(
        dispatcher=None, registry=None, session_factory=None,
    )


def test_effective_tuning_layers_request_over_stored_defaults():
    svc = _make_service()
    merged = _run(svc._effective_tuning(
        _FakeSession(_FakeSettingsRow()),
        AggregationTuning(apply_chunk=9_000),
    ))
    assert merged["scan_range_width"] == 111_000   # from stored defaults
    assert merged["apply_chunk"] == 9_000          # request override wins


def test_effective_tuning_without_settings_row():
    svc = _make_service()
    merged = _run(svc._effective_tuning(_FakeSession(None), None))
    assert merged == {}


# ── pipeline knob resolution ────────────────────────────────────────────


def test_pipeline_knobs_prefer_job_tuning_over_env(monkeypatch):
    from backend.app.providers import falkordb_materialize as mat

    pipeline = mat.AggregationPipeline(
        provider=type("P", (), {"_graph_name": "g"})(),
        containment_edge_types=None,
        lineage_edge_types=None,
        last_cursor=None,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        tuning={
            "scan_range_width": 42_000,
            "write_pacing_ratio": 2.5,
            "extract_concurrency": 3,
            "materialize_leaf_pairs": True,
            "max_pending_pairs": 60_000,
        },
    )
    assert pipeline._knob_int("scan_range_width", mat._scan_range_width, 10_000, 5_000_000) == 42_000
    assert pipeline._pacing_ratio == 2.5
    assert pipeline._knob_int("extract_concurrency", mat._extract_concurrency, 1, 4) == 3
    assert pipeline._knob_bool("materialize_leaf_pairs", mat._materialize_leaf_pairs) is True
    assert pipeline._pair_cap() == 60_000
    # Absent knob → env default.
    assert pipeline._knob_int("delete_chunk", mat._delete_chunk, 100, 50_000) == mat._delete_chunk()
    # Out-of-bounds job values are clamped, not trusted.
    pipeline._tuning["scan_range_width"] = 1
    assert pipeline._knob_int("scan_range_width", mat._scan_range_width, 10_000, 5_000_000) == 10_000


def test_pipeline_defaults_clear_the_large_graph_target(monkeypatch):
    """Out-of-the-box defaults must complete a 1M-node / 2M-edge graph.

    The binding constraint is the write budget: such a graph produces
    several million canonical rollup pairs, and the old 2M default failed
    the job terminally on `MaterializationBudgetExceeded`. These are the
    values a fresh install runs with when nobody touches the UI, so pin
    them — a silent regression here puts large graphs back to failing.
    """
    from backend.app.providers import falkordb_materialize as mat

    for var in (
        "AGGREGATION_SCAN_RANGE_WIDTH", "AGGREGATION_MAX_PENDING_PAIRS",
        "AGGREGATION_WRITE_PACING_RATIO", "AGGREGATION_EXTRACT_CONCURRENCY",
        "AGGREGATION_MAX_MATERIALIZED_EDGES", "AGGREGATION_MAX_CUBE_EDGES",
        "AGGREGATION_MATERIALIZE_FINE_PAIRS",
    ):
        monkeypatch.delenv(var, raising=False)

    assert mat._scan_range_width() == 200_000
    assert mat._max_pending_pairs() == 50_000_000
    assert mat._pacing_ratio() == 1.0
    assert mat._extract_concurrency() == 1
    # Sized against ONE SHARD: a graph key lives entirely on one node, so
    # cluster mode gives a single graph no extra room. 25M x ~0.5KB ~= 12.5GB,
    # ~70% of the reference cluster's ~18GB per-shard headroom — covering a
    # graph 6-8x the 1M/2M floor, which is a minimum rather than a ceiling.
    assert mat._max_materialized_edges() == 25_000_000
    # Separate from the write budget on purpose — see
    # test_auto_mode_cube_ceiling_is_independent_of_write_budget.
    assert mat._max_cube_edges() == 8_000_000
    # A cube the write budget would reject must never be selected.
    assert mat._max_cube_edges() < mat._max_materialized_edges()
    # Rollup storage ships as FULL DETAIL: every ancestor combination is
    # pre-created, so no canvas granularity can come back thin — including on
    # self-nesting types, where boundary mode's on-demand reader still reasons
    # in ontology type levels.
    #
    # This is a deliberate trade, and the pin records both halves. A FORCED
    # cube skips the up-front estimate, so a graph whose cube exceeds
    # ``_max_materialized_edges`` is not refused — it fails terminally
    # mid-apply, leaving a partial cube over the previous generation's cells.
    # "auto" is the mode that degrades instead of failing, and an operator
    # moves a fleet onto it from Ingestion → Freshness → Automation (③ Act →
    # Advanced) or via AGGREGATION_MATERIALIZE_FINE_PAIRS, without a redeploy.
    assert mat._materialize_fine_pairs_mode() == "true"


def test_machine_queued_rebuilds_get_the_same_stall_window_as_the_ui(monkeypatch):
    """Every UI trigger path sends ``timeoutSecs`` explicitly; the machine
    paths — reconciliation drift and first builds, the cron drift sweep, the
    stale-marker reconciler, Refresh rollups, the projector heal hook — send
    nothing and fall through to this. At 900s they were being killed for
    going quiet for fifteen minutes on exactly the graphs big enough to do
    that, while the same rebuild started from the Re-trigger dialog survived.
    """
    import importlib

    monkeypatch.delenv("AGGREGATION_STALL_TIMEOUT_SECS", raising=False)
    from backend.app.services.aggregation import worker as worker_mod
    importlib.reload(worker_mod)
    try:
        assert worker_mod._STALL_TIMEOUT_SECS == 10_800
        assert worker_mod._STALL_TIMEOUT_SECS == PRESET_TIMEOUT_SECS
        # Must stay under the control plane's stale-job backstop, which fires
        # at 2x AGGREGATION_JOB_TIMEOUT_SECS with no checkpoint movement —
        # otherwise that coarse sweep fails a wedged job before the worker's
        # progress-aware watchdog can.
        assert worker_mod._STALL_TIMEOUT_SECS < 2 * 7_200
        # And well under the absolute wall-clock net, which is not a stall.
        assert worker_mod._STALL_TIMEOUT_SECS < worker_mod._MAX_WALL_SECS
    finally:
        importlib.reload(worker_mod)


# ── control-plane resume endpoint regression ────────────────────────────


def test_controlplane_resume_accepts_overrides_body():
    """The CP resume endpoint used to take no body, silently dropping
    ResumeOverrides in proxy deployments."""
    from backend.app.services.aggregation import controlplane as cp

    sig = inspect.signature(cp.resume_job)
    assert "overrides" in sig.parameters, (
        "controlplane.resume_job must accept the ResumeOverrides body"
    )


def test_worker_passes_tuning_to_provider():
    """The worker must forward the job's frozen tuning_json to the
    provider's materialize call."""
    import backend.app.services.aggregation.worker as worker_mod

    src = inspect.getsource(worker_mod.AggregationWorker._materialize_with_checkpoints)
    assert "tuning=job_tuning" in src
