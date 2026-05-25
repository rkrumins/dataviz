"""
Unit tests for Enhancement 1 — AggregationWorker._maybe_skip_unchanged.

Exercises the fingerprint-based short-circuit that turns repeat jobs
against an unchanged graph into a sub-second no-op while still firing
the full lifecycle event chain (the caller falls through to the
existing success block when the skip applies).

The tests target the helper method directly so they don't need a real
provider, FalkorDB, or Postgres. Designed to load with
``--noconftest`` so the auth-stack-heavy conftest stays out of the way.
"""
from __future__ import annotations

import os
import sys
from typing import Any, List, Optional
from unittest.mock import AsyncMock

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app.services.aggregation.models import AggregationJobORM  # noqa: E402
from backend.app.services.aggregation.worker import AggregationWorker  # noqa: E402


# ── Fakes ────────────────────────────────────────────────────────────────


class _FakeSession:
    """Minimal AsyncSession stand-in for the skip-unchanged path.

    ``_maybe_skip_unchanged`` only calls ``session.execute(select(...))``;
    the fake returns a pre-seeded prior job (or None) from the result's
    ``scalar_one_or_none()``.
    """

    def __init__(self, prior_jobs: Optional[List[AggregationJobORM]] = None) -> None:
        self._prior_jobs = prior_jobs or []
        self.execute_calls = 0

    async def execute(self, _stmt: Any) -> Any:
        self.execute_calls += 1
        prior = self._prior_jobs[0] if self._prior_jobs else None

        class _Result:
            def scalar_one_or_none(self_inner) -> Optional[AggregationJobORM]:
                return prior

        return _Result()


def _make_worker() -> AggregationWorker:
    """Worker with mocked collaborators — the skip path never touches them."""
    return AggregationWorker(
        session_factory=None,
        registry=None,
        event_publisher=None,
    )


def _make_job(
    *,
    id: str = "agg_new",
    data_source_id: str = "ds_a",
    trigger_source: str = "schedule",
    ontology_fingerprint: Optional[str] = "ont_fp_v1",
    graph_fingerprint_before: Optional[str] = "graph_fp_match",
) -> AggregationJobORM:
    job = AggregationJobORM(
        id=id,
        data_source_id=data_source_id,
        trigger_source=trigger_source,
        ontology_fingerprint=ontology_fingerprint,
        graph_fingerprint_before=graph_fingerprint_before,
    )
    return job


def _make_prior(
    *,
    id: str = "agg_prior",
    data_source_id: str = "ds_a",
    status: str = "completed",
    graph_fingerprint_after: Optional[str] = "graph_fp_match",
    lineage_edge_count: Optional[int] = 12345,
    created_edges: int = 67890,
    ontology_fingerprint: Optional[str] = "ont_fp_v1",
) -> AggregationJobORM:
    prior = AggregationJobORM(
        id=id,
        data_source_id=data_source_id,
        status=status,
        graph_fingerprint_after=graph_fingerprint_after,
        lineage_edge_count=lineage_edge_count,
        created_edges=created_edges,
        ontology_fingerprint=ontology_fingerprint,
    )
    return prior


# ── Happy path ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_applies_when_fingerprints_match():
    """Routine trigger + matching graph + matching ontology + completed
    prior with non-null fingerprint/count → skip fires and returns a
    synthetic result that carries the prior's edge counts."""
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job()

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is not None, "skip should apply for matching fingerprints"
    assert result["skipped_unchanged"] is True
    assert result["aggregated_edges_affected"] == prior.created_edges
    assert result["total_edges"] == prior.lineage_edge_count
    assert result["processed"] == prior.lineage_edge_count
    assert result["errors"] == 0


# ── Trigger-source overrides ─────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["manual", "drift", "purge"])
async def test_skip_bypassed_for_intent_carrying_triggers(trigger):
    """Manual / drift / purge triggers carry explicit operator/system
    intent and always rebuild — even when fingerprints match."""
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job(trigger_source=trigger)

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None, f"skip must not apply for trigger_source={trigger!r}"


# ── Prior-row guards ─────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("prior_status", ["running", "failed", "cancelled"])
async def test_skip_requires_completed_prior(prior_status):
    """A non-completed prior cannot establish a baseline. The fake
    session returns None for the filtered query (which already
    restricts to status='completed'); we just confirm the helper
    returns None when no completed prior is reachable."""
    worker = _make_worker()
    # Simulate "no completed prior" by passing an empty list.
    session = _FakeSession(prior_jobs=[])
    job = _make_job()

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None


@pytest.mark.asyncio
async def test_skip_bypassed_when_no_prior_exists():
    """First-ever job for this data source → no prior → no skip."""
    worker = _make_worker()
    session = _FakeSession(prior_jobs=[])
    job = _make_job()

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before="any_fp",
    )

    assert result is None


# ── Fingerprint mismatches ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_bypassed_when_graph_fingerprint_differs():
    """Different graph fingerprint → graph topology changed → must rebuild."""
    worker = _make_worker()
    prior = _make_prior(graph_fingerprint_after="graph_fp_OLD")
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job(graph_fingerprint_before="graph_fp_NEW")

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None


@pytest.mark.asyncio
async def test_skip_bypassed_when_ontology_fingerprint_differs():
    """Ontology was edited (even with same graph counts) → must rebuild."""
    worker = _make_worker()
    prior = _make_prior(ontology_fingerprint="ont_fp_v1")
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job(ontology_fingerprint="ont_fp_v2")

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None


@pytest.mark.asyncio
async def test_skip_bypassed_when_current_fingerprint_is_empty():
    """compute_graph_fingerprint returns '' on provider failure; skip
    must default to 'do not skip' rather than wrongly matching another
    failed-fingerprint prior."""
    worker = _make_worker()
    prior = _make_prior(graph_fingerprint_after="graph_fp_match")
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job(graph_fingerprint_before="")

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before="",
    )

    assert result is None


# ── Kill switch ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_bypassed_when_kill_switch_disabled(monkeypatch):
    """AGGREGATION_SKIP_UNCHANGED_ENABLED=false disables the heuristic
    even when all other conditions are perfectly matched."""
    monkeypatch.setenv("AGGREGATION_SKIP_UNCHANGED_ENABLED", "false")
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job()

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None, "kill switch must override matching fingerprints"


# ── Ontology-fingerprint null handling ───────────────────────────────────


# ── Ontology-fingerprint null handling ───────────────────────────────────


@pytest.mark.asyncio
async def test_skip_applies_when_ontology_fingerprint_missing_on_either_side():
    """Pre-ontology-fingerprint rows have NULL. Skip should still apply
    when both sides are NULL OR when one side is NULL (we cannot compare
    so we fall back to the graph fingerprint, which already matched).
    Conservative interpretation: NULL ontology fingerprint == 'don't
    block the skip', because the graph fingerprint already proved
    structural equality."""
    worker = _make_worker()
    # Both NULL.
    prior_both_null = _make_prior(ontology_fingerprint=None)
    job_both_null = _make_job(ontology_fingerprint=None)
    session = _FakeSession(prior_jobs=[prior_both_null])
    result = await worker._maybe_skip_unchanged(
        session, job_both_null,
        fingerprint_before=job_both_null.graph_fingerprint_before,
    )
    assert result is not None, "both-null ontology fingerprints should not block skip"

    # Prior NULL, current set.
    prior_null = _make_prior(ontology_fingerprint=None)
    job_set = _make_job(ontology_fingerprint="ont_fp_v1")
    session = _FakeSession(prior_jobs=[prior_null])
    result = await worker._maybe_skip_unchanged(
        session, job_set, fingerprint_before=job_set.graph_fingerprint_before,
    )
    assert result is not None, "missing prior ontology fingerprint should not block skip"


# ── Force-rebuild override (P1-4) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_force_rebuild_bypasses_skip_even_with_matching_fingerprints():
    """Per-job force_rebuild=True always rebuilds, even with matching
    fingerprints + a routine trigger source. Lets non-UI callers force
    a rebuild while preserving trigger_source for audit."""
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job()
    job.force_rebuild = True  # non-default

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is None, "force_rebuild must bypass the skip"


@pytest.mark.asyncio
async def test_force_rebuild_default_false_allows_skip():
    """Default force_rebuild=False (or NULL on legacy rows) doesn't
    interfere with the existing skip semantics."""
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job()
    job.force_rebuild = False

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is not None, "skip should still apply when force_rebuild is False"


@pytest.mark.asyncio
async def test_force_rebuild_null_treated_as_false():
    """Legacy rows pre-date the column → force_rebuild is None. Skip
    must still apply (NULL is not truthy)."""
    worker = _make_worker()
    prior = _make_prior()
    session = _FakeSession(prior_jobs=[prior])
    job = _make_job()
    job.force_rebuild = None  # legacy row

    result = await worker._maybe_skip_unchanged(
        session, job, fingerprint_before=job.graph_fingerprint_before,
    )

    assert result is not None, "NULL force_rebuild must be treated as False"


# ── Schema validation ────────────────────────────────────────────────────


def test_trigger_request_accepts_force_rebuild_camelcase():
    """The field deserialises from both snake_case and camelCase."""
    from backend.app.services.aggregation.schemas import AggregationTriggerRequest

    req_camel = AggregationTriggerRequest(forceRebuild=True)
    req_snake = AggregationTriggerRequest(force_rebuild=True)
    assert req_camel.force_rebuild is True
    assert req_snake.force_rebuild is True


def test_trigger_request_force_rebuild_default_false():
    """Backward compat: callers that don't pass the flag get False."""
    from backend.app.services.aggregation.schemas import AggregationTriggerRequest

    req = AggregationTriggerRequest()
    assert req.force_rebuild is False
