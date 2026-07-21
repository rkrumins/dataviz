"""
Unit tests for backend.app.services.aggregation.worker.AggregationWorker
                ._materialize_with_retries

Locks in the hardened retry behaviour:
  * First ``ProviderUnavailable`` triggers an extended sleep that is
    at least ``retry_after_seconds + jitter`` so the next attempt
    arrives after the breaker probe window has elapsed.
  * Second ``ProviderUnavailable`` whose ``reason`` contains
    "circuit open" (case-insensitive) aborts the job immediately,
    sets a clear ``error_message``, and re-raises — no further retries
    against a known-OPEN breaker.
  * Non-``ProviderUnavailable`` errors retain the original exponential
    backoff schedule (``min(5.0 * 2**attempt, 120.0) + jitter``).

These tests use lightweight fakes for ``job`` and ``session`` (no real
DB) and patch ``asyncio.sleep`` so the suite runs in milliseconds.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from backend.app.jobs import JobScope as PlatformJobScope
from backend.app.services.aggregation.worker import AggregationWorker
from backend.common.adapters import ProviderUnavailable


# ── Fakes ────────────────────────────────────────────────────────────────


class _FakeJob:
    """Stand-in for ``AggregationJobORM`` — only the attributes
    ``_materialize_with_retries`` actually reads/writes."""

    def __init__(self, *, max_retries: int = 3) -> None:
        self.id = "agg_test1234"
        self.max_retries = max_retries
        self.retry_count = 0
        self.error_message: str | None = None
        self.updated_at: str | None = None
        # Fields _materialize_with_checkpoints would touch — irrelevant
        # for these tests but harmless to expose.
        self.last_cursor: str | None = None
        self.batch_size = 1000
        self.processed_edges = 0
        self.total_edges = 0
        self.created_edges = 0
        self.progress = 0
        self.last_checkpoint_at: str | None = None


class _FakeSession:
    """Stand-in for ``AsyncSession``. The retry wrapper only calls
    ``commit()`` for checkpointing the error_message between attempts."""

    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


def _make_worker() -> AggregationWorker:
    """A minimally-constructed worker. ``session_factory`` and
    ``registry`` are unused by ``_materialize_with_retries`` — the
    method takes ``session``/``provider`` as args directly."""
    return AggregationWorker(session_factory=None, registry=None, event_publisher=None)


def _retry_call_kwargs() -> dict[str, Any]:
    """Stub values for the three runtime args added to
    ``_materialize_with_retries``: cancel_event, emitter, scope.
    ``_materialize_with_checkpoints`` is mocked in every test, so the
    cancel signal is never read and the emitter is never invoked."""
    return {
        "cancel_event": asyncio.Event(),
        "emitter": AsyncMock(),
        "scope": PlatformJobScope(workspace_id="ws_test", data_source_id="ds_test"),
    }


# ── Tests ────────────────────────────────────────────────────────────────


async def test_first_provider_unavailable_triggers_extended_sleep(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First ProviderUnavailable: sleep ≥ retry_after_seconds (+ jitter),
    then succeed on the second attempt."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=3)
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise ProviderUnavailable("p1", "Some downstream blip", retry_after_seconds=5)
        return {"aggregated_edges_affected": 7}

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    result = await worker._materialize_with_retries(
        session=session,
        job=job,
        provider=object(),
        containment_types=[],
        lineage_types=["TRANSFORMS"],
        **_retry_call_kwargs(),
    )

    assert result == {"aggregated_edges_affected": 7}
    assert call_count["n"] == 2
    assert sleep_mock.await_count == 1
    slept_for = sleep_mock.await_args_list[0].args[0]
    # Jitter pushes it slightly above 5; exp_backoff for attempt=0 is 5,
    # so the floor is 5 (with jitter up to +2).
    assert slept_for >= 5.0, f"Expected sleep >= 5s, got {slept_for}"
    assert slept_for <= 7.0 + 1e-6, f"Sleep {slept_for}s exceeds expected ceiling"


async def test_second_provider_unavailable_with_circuit_open_aborts_immediately(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two consecutive ProviderUnavailable raises — the SECOND one whose
    reason mentions "Circuit open" must short-circuit the retry loop."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=5)
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        raise ProviderUnavailable(
            "p1",
            "Circuit open; will probe downstream again in ~30s",
            retry_after_seconds=30,
        )

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    with pytest.raises(ProviderUnavailable):
        await worker._materialize_with_retries(
            session=session,
            job=job,
            provider=object(),
            containment_types=[],
            lineage_types=["TRANSFORMS"],
            **_retry_call_kwargs(),
        )

    # Exactly two attempts (not the full max_retries+1).
    assert call_count["n"] == 2
    # One sleep — between attempt 1 and attempt 2 — and no sleep before
    # the abort that follows attempt 2.
    assert sleep_mock.await_count == 1
    assert job.error_message is not None
    msg_lower = job.error_message.lower()
    assert "circuit breaker open" in msg_lower or "circuit open" in msg_lower, (
        f"error_message did not mention circuit breaker: {job.error_message!r}"
    )


async def test_first_circuit_open_still_gets_one_retry_then_aborts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even when the FIRST ProviderUnavailable already says "Circuit open",
    we still grant one retry; abort fires on the SECOND occurrence."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=5)
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        raise ProviderUnavailable(
            "p1",
            "Circuit open; will probe downstream again in ~30s",
            retry_after_seconds=30,
        )

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    with pytest.raises(ProviderUnavailable):
        await worker._materialize_with_retries(
            session=session,
            job=job,
            provider=object(),
            containment_types=[],
            lineage_types=["TRANSFORMS"],
            **_retry_call_kwargs(),
        )

    # Same fast-fail behaviour: 2 attempts, 1 sleep, abort message set.
    assert call_count["n"] == 2
    assert sleep_mock.await_count == 1
    assert job.error_message is not None
    msg_lower = job.error_message.lower()
    assert "circuit breaker open" in msg_lower or "circuit open" in msg_lower


async def test_non_provider_unavailable_errors_use_exponential_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Generic exceptions retain the original exponential-backoff
    schedule: attempt 0 -> ~5s, attempt 1 -> ~10s (each with up to +2s
    jitter)."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=3)
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        if call_count["n"] <= 2:
            raise RuntimeError("boom")
        return {"aggregated_edges_affected": 1}

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    result = await worker._materialize_with_retries(
        session=session,
        job=job,
        provider=object(),
        containment_types=[],
        lineage_types=["TRANSFORMS"],
        **_retry_call_kwargs(),
    )

    assert result == {"aggregated_edges_affected": 1}
    assert call_count["n"] == 3
    assert sleep_mock.await_count == 2

    first_sleep = sleep_mock.await_args_list[0].args[0]
    second_sleep = sleep_mock.await_args_list[1].args[0]

    # attempt=0: 5.0 + jitter[0..2)  -> [5, 7)
    assert 5.0 <= first_sleep < 7.0 + 1e-6, f"first sleep {first_sleep} outside [5, 7]"
    # attempt=1: 10.0 + jitter[0..2) -> [10, 12)
    assert 10.0 <= second_sleep < 12.0 + 1e-6, (
        f"second sleep {second_sleep} outside [10, 12]"
    )


async def test_forward_progress_resets_retry_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A job that keeps advancing ``processed_edges`` survives MANY more
    failures than ``max_retries`` — each forward step resets the consecutive
    failure counter (the connection-reset resilience for large jobs)."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=2)  # max_attempts = 3
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        # Each attempt makes forward progress before failing — until the
        # 6th, which finally completes. 6 > max_attempts(3): without the
        # progress-reset this would have failed at attempt 3.
        job.processed_edges += 100
        if call_count["n"] < 6:
            raise RuntimeError("Connection reset by peer")
        return {"aggregated_edges_affected": 5}

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    result = await worker._materialize_with_retries(
        session=session,
        job=job,
        provider=object(),
        containment_types=[],
        lineage_types=["TRANSFORMS"],
        **_retry_call_kwargs(),
    )

    assert result == {"aggregated_edges_affected": 5}
    assert call_count["n"] == 6, (
        "expected the budget to keep resetting on forward progress, "
        f"got {call_count['n']} attempts"
    )


async def test_no_progress_exhausts_retry_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A genuinely stuck job (no ``processed_edges`` advance) still fails
    after exactly ``max_attempts`` consecutive failures — the budget reset
    must NOT make a stuck job loop forever."""
    sleep_mock = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.aggregation.worker.asyncio.sleep", sleep_mock
    )

    worker = _make_worker()
    job = _FakeJob(max_retries=2)  # max_attempts = 3
    session = _FakeSession()

    call_count = {"n": 0}

    async def fake_materialize(**_kwargs: Any) -> dict:
        call_count["n"] += 1
        raise RuntimeError("boom")  # never advances processed_edges

    monkeypatch.setattr(worker, "_materialize_with_checkpoints", fake_materialize)

    with pytest.raises(RuntimeError):
        await worker._materialize_with_retries(
            session=session,
            job=job,
            provider=object(),
            containment_types=[],
            lineage_types=["TRANSFORMS"],
            **_retry_call_kwargs(),
        )

    assert call_count["n"] == 3  # max_attempts, then give up
    assert sleep_mock.await_count == 2  # slept between the 3 attempts


# ── self-heal recovers the node-identity property from the data source ───────


def test_refreeze_recovers_identity_property_from_data_source():
    """The empty-frozen-types self-heal must also re-derive identity_property
    from the DATA SOURCE. Otherwise a legacy/partial job row on an id-keyed
    source heals its edge types yet keeps identity_property NULL → "urn", so the
    urn stamp/directory still drops every id-keyed node (an asymmetric heal)."""
    import json as _json
    from backend.app.db.models import OntologyORM, WorkspaceDataSourceORM
    from backend.app.services.aggregation.models import AggregationJobORM

    ont = OntologyORM(
        id="ont_heal",
        entity_type_definitions="{}",
        relationship_type_definitions=_json.dumps({"FLOWS": {"is_lineage": True}}),
    )
    ds = WorkspaceDataSourceORM(id="ds_heal", identity_property="id", name_property="title")
    job = AggregationJobORM(
        id="agg_heal", ontology_id="ont_heal", data_source_id="ds_heal",
        trigger_source="manual",
    )

    class _GetSession:
        def __init__(self, objs):
            self._objs = objs
            self.committed = False

        async def get(self, model, key):
            return self._objs.get((model.__name__, key))

        async def commit(self):
            self.committed = True

    session = _GetSession({
        ("OntologyORM", "ont_heal"): ont,
        ("WorkspaceDataSourceORM", "ds_heal"): ds,
    })

    worker = _make_worker()
    asyncio.run(worker._refreeze_edge_types(session, job))

    assert job.identity_property == "id", "self-heal must recover identity from the DS"
    assert job.name_property == "title", "self-heal must recover display-name from the DS"
    assert _json.loads(job.lineage_edge_types) == ["FLOWS"], "edge types still heal"
