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
    # cluster mode gives a single graph no extra room. 16M x ~0.5KB ~= 8GB,
    # inside the reference cluster's ~18GB per-shard headroom.
    assert mat._max_materialized_edges() == 16_000_000
    # Separate from the write budget on purpose — see
    # test_auto_mode_cube_ceiling_is_independent_of_write_budget.
    assert mat._max_cube_edges() == 8_000_000
    # A cube the write budget would reject must never be selected.
    assert mat._max_cube_edges() < mat._max_materialized_edges()
    # Rollup storage stays on AUTO: forcing the full cube is what OOMs a
    # multi-million-edge instance.
    assert mat._materialize_fine_pairs_mode() == "auto"


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
