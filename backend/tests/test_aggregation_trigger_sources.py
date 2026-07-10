"""Trigger-source contract: automatic callers must be able to mint jobs.

Regression suite for the F1 audit finding: ``insights_service/purge.py``
triggers with ``triggerSource=post_purge`` and the context-engine
read-path backfill with ``auto`` — both were rejected by the jobs-table
CHECK constraint (IntegrityError → 500 / silently swallowed), so the
promised automatic re-aggregation never ran. The service also accepted
ANY string and let the database blow up instead of returning 422.
"""
import asyncio

import pytest

from backend.app.services.aggregation.models import (
    API_TRIGGER_SOURCES,
    TRIGGER_SOURCES,
    AggregationJobORM,
)
from backend.app.services.aggregation.schemas import AggregationTriggerRequest
from backend.app.services.aggregation.service import AggregationService


def _run(coro):
    return asyncio.run(coro)


def _make_service():
    return AggregationService(
        dispatcher=None, registry=None, session_factory=None,
    )


class _ExplodingSession:
    """Any attribute access means validation didn't happen first."""

    def __getattr__(self, name):  # pragma: no cover - failure path only
        raise AssertionError(
            f"session.{name} touched before trigger_source validation"
        )


# ── model-level contract ────────────────────────────────────────────────


def test_trigger_sources_cover_automatic_callers():
    assert "post_purge" in TRIGGER_SOURCES   # insights purge worker
    assert "auto" in TRIGGER_SOURCES         # read-path backfill
    assert set(API_TRIGGER_SOURCES) == set(TRIGGER_SOURCES) - {"purge"}


def test_check_constraint_built_from_trigger_sources():
    constraint = next(
        c for c in AggregationJobORM.__table__.constraints
        if getattr(c, "name", None) == "ck_agg_jobs_trigger_source"
    )
    sql = str(constraint.sqltext)
    for source in TRIGGER_SOURCES:
        assert f"'{source}'" in sql, f"constraint is missing {source!r}"


# ── service-level validation (422, not IntegrityError 500) ─────────────


def test_trigger_rejects_unknown_source_before_any_db_work():
    svc = _make_service()
    with pytest.raises(ValueError, match="trigger_source"):
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), "bogus", _ExplodingSession(),
        ))


def test_trigger_rejects_caller_minted_purge_rows():
    # 'purge' rows mark the purge lifecycle itself (excluded from the
    # reconciler / crash recovery / resume) — API callers must not mint
    # them or the row would be unmanaged.
    svc = _make_service()
    with pytest.raises(ValueError, match="trigger_source"):
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), "purge", _ExplodingSession(),
        ))


def test_trigger_accepts_every_api_source_past_validation():
    # Validation must NOT reject any declared API source. Passing an
    # exploding session proves acceptance: valid sources move on to the
    # idempotency lookup and trip the AssertionError, never ValueError.
    svc = _make_service()
    for source in API_TRIGGER_SOURCES:
        with pytest.raises(AssertionError, match="before trigger_source"):
            _run(svc.trigger(
                "ds-1", AggregationTriggerRequest(), source,
                _ExplodingSession(),
            ))
