"""
Unit tests for the per-job override surface that just shipped:

  * AggregationTriggerRequest.timeout_secs / max_retries pass through to
    the AggregationJobORM row at trigger time, and the worker's
    ``job.timeout_secs or _JOB_TIMEOUT_SECS`` selector reads them back.
  * Resume accepts an optional ResumeOverrides body that mutates the job
    row before re-dispatch (and can lift an exhausted retry budget).
  * Validator bounds on AggregationTriggerRequest / ResumeOverrides.
  * AggregationJobResponse surfaces lastCursor / maxRetries / timeoutSecs.

The tests run without a real database — `AggregationJobORM` rows are
constructed in-memory and a tiny ``_FakeSession`` stands in for
``AsyncSession``. The advisory-lock + ontology resolution paths are
patched out so we exercise only the code that genuinely changed.

Designed to load with ``--noconftest`` so the auth-stack-heavy
conftest.py (which the sandbox can't import argon2 for) stays out of
the way.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

# `--noconftest` skips conftest.py, so we replicate its sys.path tweak
# manually: add the repo root (parent of `backend/`) to sys.path so
# imports like `backend.app...` resolve.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app.services.aggregation.models import AggregationJobORM  # noqa: E402
from backend.app.services.aggregation.schemas import (  # noqa: E402
    AggregationJobResponse,
    AggregationTriggerRequest,
    ResumeOverrides,
)
from backend.app.services.aggregation.service import AggregationService  # noqa: E402


# ── Fakes ────────────────────────────────────────────────────────────────


class _FakeSession:
    """Stand-in for ``AsyncSession`` covering only the surface the
    AggregationService methods under test actually touch.

    - ``begin()``: async context manager (used by ``trigger()``).
    - ``add(obj)``: capture the ORM row the service inserts.
    - ``get(model, pk)``: return the pre-seeded job for ``resume()``.
    - ``commit()``: count for sanity.
    """

    def __init__(self, seeded_job: Optional[AggregationJobORM] = None) -> None:
        self.added: list[Any] = []
        self.commits = 0
        self._seeded_job = seeded_job

    def begin(self):
        session = self

        class _Tx:
            async def __aenter__(self_inner):
                return session

            async def __aexit__(self_inner, *_exc):
                session.commits += 1
                return False

        return _Tx()

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def get(self, _model: Any, _pk: Any):
        return self._seeded_job

    async def commit(self) -> None:
        self.commits += 1

    async def execute(self, *_args, **_kwargs):
        # Idempotency-key lookup short-circuits via this path; we never
        # hit it because tests set idempotency_key=None.
        class _R:
            def scalar_one_or_none(self_inner):
                return None

            def scalar(self_inner):
                return None

            def scalars(self_inner):
                return iter([])

            def all(self_inner):
                return []

        return _R()


def _make_service() -> AggregationService:
    """Instantiate the service with a mock dispatcher; trigger/resume
    only need ``dispatcher.dispatch()`` to be awaitable."""
    dispatcher = AsyncMock()
    return AggregationService(
        dispatcher=dispatcher,
        registry=None,
        session_factory=None,
        ontology_service=None,
    )


def _seed_required_orm_defaults(job: AggregationJobORM) -> AggregationJobORM:
    """Apply the column defaults that SQLAlchemy would set on flush.

    ``_to_response`` reads these fields directly off the instance, but
    ORM column defaults only fire on flush — and we never hit the DB
    in these tests. Set the safe zeros up front."""
    if job.progress is None:
        job.progress = 0
    if job.total_edges is None:
        job.total_edges = 0
    if job.processed_edges is None:
        job.processed_edges = 0
    if job.created_edges is None:
        job.created_edges = 0
    if job.batch_size is None:
        job.batch_size = 1000
    if job.retry_count is None:
        job.retry_count = 0
    if job.trigger_source is None:
        job.trigger_source = "manual"
    if job.projection_mode is None:
        job.projection_mode = "in_source"
    if job.status is None:
        job.status = "pending"
    return job


def _patch_resolution_and_claim(
    monkeypatch: pytest.MonkeyPatch,
    *,
    lineage_types: list[str] | None = None,
) -> None:
    """Bypass the Postgres-only advisory lock and ontology lookup so the
    trigger flow runs end-to-end against an in-memory session."""
    async def _fake_claim(_session, _ds_id):
        return True

    async def _fake_resolve(self, _ds_id, _session):
        return {
            "ontology_id": "ont_test",
            "workspace_id": "ws_test",
            "provider_id": "prov_test",
            "graph_name": "graph_test",
            "data_source_label": "test-source",
            "containment_edge_types": [],
            "lineage_edge_types": lineage_types or ["TRANSFORMS"],
        }

    monkeypatch.setattr(
        "backend.app.services.aggregation.service.claim_exclusive",
        _fake_claim,
    )
    monkeypatch.setattr(
        AggregationService,
        "_resolve_ontology",
        _fake_resolve,
    )

    # _upsert_ds_state pulls in AggregationDataSourceStateORM and would
    # touch the DB for a real session.get(); stub it to a no-op.
    async def _noop_state(self, *_args, **_kwargs):
        return None

    monkeypatch.setattr(
        AggregationService,
        "_upsert_ds_state",
        _noop_state,
    )


# ── 1 + 2: trigger() persists / preserves overrides ─────────────────────


async def test_trigger_with_timeout_secs_and_max_retries_lands_on_orm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """timeout_secs=300 + max_retries=5 must reach the ORM row, and the
    worker's ``job.timeout_secs or _JOB_TIMEOUT_SECS`` selector must
    read 300 back (proving the override beats the 7200s global cap)."""
    _patch_resolution_and_claim(monkeypatch)

    service = _make_service()
    session = _FakeSession()

    request = AggregationTriggerRequest(
        timeout_secs=300,
        max_retries=5,
        batch_size=1000,
        projection_mode="in_source",
    )

    # Patch _to_response so we can inspect the inserted ORM row without
    # tripping the response model's required-field validation (column
    # defaults like progress=0 only fire on flush, which we skip).
    captured: dict[str, AggregationJobORM] = {}

    def _capture_response(job: AggregationJobORM):
        captured["job"] = job
        _seed_required_orm_defaults(job)
        return AggregationService._to_response(job)

    monkeypatch.setattr(service, "_to_response", _capture_response)

    response = await service.trigger("ds_xyz", request, "manual", session)

    assert response.id.startswith("agg_")
    # The service called session.add(job) — recover the ORM row.
    inserted = [o for o in session.added if isinstance(o, AggregationJobORM)]
    assert len(inserted) == 1, "expected exactly one AggregationJobORM insert"
    job = inserted[0]
    assert job.timeout_secs == 300, f"timeout_secs not persisted: {job.timeout_secs}"
    assert job.max_retries == 5, f"max_retries not persisted: {job.max_retries}"

    # Worker selector parity — proves the per-job override would beat
    # the global default at runtime.
    assert (job.timeout_secs or 7200) == 300


async def test_trigger_without_overrides_preserves_default_behaviour(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No overrides → ``timeout_secs is None`` (worker falls back to the
    7200s env default) and ``max_retries`` defaults to the ORM column
    default of 3 (the service skips the kwarg when caller omits it)."""
    _patch_resolution_and_claim(monkeypatch)

    service = _make_service()
    session = _FakeSession()

    request = AggregationTriggerRequest(
        batch_size=5000,
        projection_mode="in_source",
    )

    def _capture_response(job: AggregationJobORM):
        _seed_required_orm_defaults(job)
        return AggregationService._to_response(job)

    monkeypatch.setattr(service, "_to_response", _capture_response)

    await service.trigger("ds_xyz", request, "manual", session)

    inserted = [o for o in session.added if isinstance(o, AggregationJobORM)]
    job = inserted[0]
    assert job.timeout_secs is None, (
        f"expected timeout_secs=None for backwards-compat caller, "
        f"got {job.timeout_secs}"
    )
    # ORM column default is 3. SQLAlchemy applies it on flush; in-memory
    # it stays None unless the service set it explicitly. The service
    # skips the kwarg, so the column default applies — which the
    # AggregationJobORM model declares as 3.
    assert job.max_retries == 3 or job.max_retries is None, (
        "max_retries should be the ORM default (3) or rely on it (None)"
    )
    # Confirm the worker's selector returns the global default when the
    # per-job override is absent.
    assert (job.timeout_secs or 7200) == 7200


# ── 3: resume() applies overrides to the ORM row ────────────────────────


async def test_resume_with_overrides_updates_orm_fields() -> None:
    """Resume with overrides bumps timeout_secs / max_retries and
    preserves last_cursor; status flips to pending; retry_count + 1."""
    job = _seed_required_orm_defaults(AggregationJobORM(
        id="agg_failedjob01",
        data_source_id="ds_xyz",
        status="failed",
        timeout_secs=None,
        max_retries=3,
        retry_count=2,
        last_cursor="abc123",
        batch_size=1000,
        projection_mode="in_source",
        created_at="2026-04-22T00:00:00Z",
    ))
    session = _FakeSession(seeded_job=job)
    service = _make_service()

    overrides = ResumeOverrides(timeout_secs=14400, max_retries=10)

    response = await service.resume("ds_xyz", "agg_failedjob01", session, overrides=overrides)

    assert job.timeout_secs == 14400
    assert job.max_retries == 10
    assert job.last_cursor == "abc123", "last_cursor must be preserved on resume"
    assert job.status == "pending"
    assert job.retry_count == 3
    assert response.timeout_secs == 14400
    assert response.max_retries == 10
    assert response.last_cursor == "abc123"


# ── 4: resume() with overrides can unblock an exhausted job ─────────────


async def test_resume_accepts_cancelled_status() -> None:
    """resume() must accept both 'failed' and 'cancelled' jobs — the
    frontend offers Resume on either status, and rejecting cancelled
    jobs would surface a 422 to a user who clicked the dialog button
    that we just told them was valid."""
    job = _seed_required_orm_defaults(AggregationJobORM(
        id="agg_cancelled1",
        data_source_id="ds_xyz",
        status="cancelled",
        max_retries=3,
        retry_count=1,
        batch_size=1000,
        projection_mode="in_source",
        last_cursor="cur_after_cancel",
        created_at="2026-04-22T00:00:00Z",
    ))
    session = _FakeSession(seeded_job=job)
    service = _make_service()

    response = await service.resume("ds_xyz", "agg_cancelled1", session)

    assert response.status == "pending"
    assert job.status == "pending"
    assert job.retry_count == 2
    assert job.last_cursor == "cur_after_cancel"  # preserved


async def test_resume_rejects_other_statuses() -> None:
    """resume() still rejects jobs that aren't terminal — running,
    pending, completed all surface a clear ValueError."""
    for status in ("running", "pending", "completed"):
        job = _seed_required_orm_defaults(AggregationJobORM(
            id=f"agg_{status}",
            data_source_id="ds_xyz",
            status=status,
            max_retries=3,
            retry_count=0,
            batch_size=1000,
            projection_mode="in_source",
            created_at="2026-04-22T00:00:00Z",
        ))
        session = _FakeSession(seeded_job=job)
        service = _make_service()

        with pytest.raises(ValueError, match="not resumable"):
            await service.resume("ds_xyz", f"agg_{status}", session)


async def test_resume_without_overrides_blocks_exhausted_job() -> None:
    """Without overrides, an exhausted job (retry_count >= max_retries)
    must be rejected with the explicit ValueError."""
    job = _seed_required_orm_defaults(AggregationJobORM(
        id="agg_exhausted1",
        data_source_id="ds_xyz",
        status="failed",
        max_retries=3,
        retry_count=3,
        batch_size=1000,
        projection_mode="in_source",
        created_at="2026-04-22T00:00:00Z",
    ))
    session = _FakeSession(seeded_job=job)
    service = _make_service()

    with pytest.raises(ValueError, match="exceeded max retries"):
        await service.resume("ds_xyz", "agg_exhausted1", session)


async def test_resume_with_max_retries_override_unblocks_exhausted_job() -> None:
    """Bumping max_retries via overrides must let the same job resume
    (the override is applied BEFORE the gate check, by design)."""
    job = _seed_required_orm_defaults(AggregationJobORM(
        id="agg_exhausted2",
        data_source_id="ds_xyz",
        status="failed",
        max_retries=3,
        retry_count=3,
        batch_size=1000,
        projection_mode="in_source",
        created_at="2026-04-22T00:00:00Z",
    ))
    session = _FakeSession(seeded_job=job)
    service = _make_service()

    overrides = ResumeOverrides(max_retries=5)

    response = await service.resume(
        "ds_xyz", "agg_exhausted2", session, overrides=overrides
    )

    assert job.max_retries == 5
    assert job.status == "pending"
    assert job.retry_count == 4
    assert response.id == "agg_exhausted2"
    # The dispatcher must have been re-asked to dispatch the job.
    service._dispatcher.dispatch.assert_awaited_once_with("agg_exhausted2")


# ── 5: validator bounds ─────────────────────────────────────────────────


def test_trigger_request_rejects_timeout_below_minimum() -> None:
    with pytest.raises(ValidationError):
        AggregationTriggerRequest(
            timeout_secs=10,
            batch_size=1000,
            projection_mode="in_source",
        )


def test_trigger_request_rejects_timeout_above_maximum() -> None:
    with pytest.raises(ValidationError):
        AggregationTriggerRequest(
            timeout_secs=99999,
            batch_size=1000,
            projection_mode="in_source",
        )


def test_trigger_request_accepts_valid_timeout() -> None:
    req = AggregationTriggerRequest(
        timeout_secs=300,
        batch_size=1000,
        projection_mode="in_source",
    )
    assert req.timeout_secs == 300


def test_resume_overrides_rejects_invalid_projection_mode() -> None:
    with pytest.raises(ValidationError):
        ResumeOverrides(projection_mode="invalid")


# ── 6: response serializer surfaces the new fields ──────────────────────


def test_to_response_surfaces_last_cursor_max_retries_timeout_secs() -> None:
    """``AggregationService._to_response`` must propagate the three new
    fields onto the response model so the UI can pre-populate the
    re-trigger dialog from the most recent job."""
    job = AggregationJobORM(
        id="agg_responsejob",
        data_source_id="ds_xyz",
        status="completed",
        last_cursor="cursor_xyz",
        max_retries=7,
        timeout_secs=10800,
        batch_size=2000,
        projection_mode="in_source",
        trigger_source="manual",
        retry_count=0,
        progress=100,
        total_edges=10,
        processed_edges=10,
        created_edges=10,
        created_at="2026-04-22T00:00:00Z",
    )

    response = AggregationService._to_response(job)

    assert isinstance(response, AggregationJobResponse)
    assert response.last_cursor == "cursor_xyz"
    assert response.max_retries == 7
    assert response.timeout_secs == 10800
