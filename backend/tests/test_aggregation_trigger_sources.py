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
    assert "property_alignment" in TRIGGER_SOURCES  # insights alignment worker
    # A source is withheld from the API list when its own endpoint claims the
    # row — those endpoints do more than mint one (conflict checks, enqueue,
    # rollback on a dead queue), so letting a client ask for the source
    # directly through /aggregation-jobs would bypass all of it.
    assert set(API_TRIGGER_SOURCES) == (
        set(TRIGGER_SOURCES) - {"purge", "property_alignment"}
    )


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


# ── idempotency-key reuse backstop (F8) ─────────────────────────────────


def _existing_row():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    return AggregationJobORM(
        id="agg_existing", data_source_id="ds-1", status="pending",
        trigger_source="manual", projection_mode="in_source",
        progress=0, total_edges=0, processed_edges=0, created_edges=0,
        batch_size=1000, retry_count=0, max_retries=3,
        idempotency_key="K", created_at=now, updated_at=now,
    )


class _ScalarResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _BeginCtx:
    def __init__(self, exc):
        self._exc = exc

    async def __aenter__(self):
        return None

    async def __aexit__(self, *a):
        if self._exc is not None:
            raise self._exc
        return False


class _IntegritySession:
    """Commit raises IntegrityError; the replay re-select then finds the
    row a concurrent trigger (or an old completed tombstone before the
    index-predicate fix) inserted for the same (ds, key)."""

    def __init__(self, replay_row, commit_exc):
        self._results = [None, None, replay_row]   # idem, graph-guard, replay
        self._commit_exc = commit_exc
        self.rolled_back = False

    async def execute(self, stmt):
        return _ScalarResult(self._results.pop(0))

    def in_transaction(self):
        return False

    def begin(self):
        return _BeginCtx(self._commit_exc)

    def add(self, obj):
        pass

    async def rollback(self):
        self.rolled_back = True


def test_idempotency_unique_violation_replays_instead_of_500(monkeypatch):
    import sqlalchemy.exc as sa_exc

    from backend.app.services.aggregation import service as svc_mod

    async def _claim(session, ds_id):
        return True

    monkeypatch.setattr(svc_mod, "claim_exclusive", _claim)
    svc = _make_service()

    async def _resolve(ds_id, session):
        return {"graph_name": "g1", "containment_edge_types": ["HAS"],
                "lineage_edge_types": ["FLOWS"]}

    async def _tuning(session, t):
        return {}

    async def _upsert(session, ds_id, **kw):
        return None

    monkeypatch.setattr(svc, "_resolve_ontology", _resolve)
    monkeypatch.setattr(svc, "_effective_tuning", _tuning)
    monkeypatch.setattr(svc, "_upsert_ds_state", _upsert)

    session = _IntegritySession(
        _existing_row(),
        sa_exc.IntegrityError("stmt", {}, Exception("duplicate key")),
    )
    resp = _run(svc.trigger(
        "ds-1", AggregationTriggerRequest(idempotencyKey="K"), "manual", session,
    ))
    assert resp.id == "agg_existing", (
        "a unique-index race on the idempotency key must replay the "
        "existing job, not surface a 500"
    )
