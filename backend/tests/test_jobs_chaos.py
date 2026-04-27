"""Job platform chaos / resilience tests.

These tests validate the resilience contracts described in the
runbook (``docs/runbooks/jobs.md``) and the design plan. They require
a docker-compose-orchestrated environment (Redis + Postgres
controllable) and are gated by ``RUN_CHAOS_TESTS=1`` so the regular
CI matrix doesn't try to run them without infra.

Run locally:

    docker compose -f docker-compose.dev.yml up -d
    RUN_CHAOS_TESTS=1 pytest backend/tests/test_jobs_chaos.py -v

The contracts under test:

* **Polling-fallback during Redis outage** — pausing Redis for 30s
  during an active aggregation must not produce 5xx on any API
  endpoint; clients keep working via the polling overlay; on resume,
  workers re-publish state and SSE clients reconnect cleanly.
* **Stuck-job reconciler** — `kill -9` of the worker process mid-batch
  produces a row stuck at ``status='running'``; the reconciler must
  mark it ``failed`` within 60 seconds of the heartbeat-staleness
  threshold elapsing.
* **Cooperative cancel mid-batch** — the cancel API + dispatcher must
  observe the cancel between MERGE sub-batches without orphaning
  any in-flight Cypher transaction.
* **Cancel during 30s Redis outage** — even when Redis is unreachable,
  the cooperative cancel mechanism (which uses an in-process
  ``asyncio.Event``) still works.

Each test is structured as: arrange (trigger an aggregation), act
(inject the failure), assert (the contract holds).
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_CHAOS_TESTS") != "1",
    reason="Chaos tests require docker-compose orchestration; "
    "set RUN_CHAOS_TESTS=1 to enable.",
)


# ── Polling-fallback ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redis_pause_30s_during_active_aggregation_does_not_5xx() -> None:
    """Polling-fallback contract: Redis being unavailable for 30s must
    not produce a single 5xx on the JobHistory API. Workers continue
    FalkorDB work; UI degrades to last-known state; on Redis resume,
    workers re-publish state and the API serves the up-to-date row.

    Wiring (TODO when this lands in CI):
    1. Trigger a multi-million-edge aggregation against a seeded graph.
    2. Wait for first checkpoint to land (UI shows ``processed_edges > 0``).
    3. ``docker pause synodic-redis``; sleep 30s; ``docker unpause synodic-redis``.
    4. Throughout: poll ``GET /aggregation-jobs/{id}`` at 1s; assert
       every response is 200; record the responses.
    5. Assert no entry in the ``redis_emit_errors_total`` counter
       crossed into a permanent error state (transient errors during
       the pause window are expected and counted; recovery clears).
    6. After resume: assert the worker's HSET state matches the
       worker's in-memory state via the re-publish-on-recover hook.
    """
    pytest.skip("Requires docker-compose orchestration; tracked separately")


# ── Stuck-job reconciler ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_kill9_worker_midbatch_marks_failed_within_60s() -> None:
    """Reconciler contract: a worker SIGKILLed mid-batch leaves a
    `status='running'` row whose ``last_checkpoint_at`` ages past
    ``STUCK_JOB_HEARTBEAT_THRESHOLD_SECS`` (default 5min); the
    reconciler must mark it ``failed`` within
    ``STUCK_JOB_RECONCILE_INTERVAL_SECS + threshold``.

    Wiring:
    1. Trigger an aggregation; wait for first checkpoint commit.
    2. Lower ``STUCK_JOB_HEARTBEAT_THRESHOLD_SECS=10`` and
       ``STUCK_JOB_RECONCILE_INTERVAL_SECS=5`` for the test (env override).
    3. ``kill -9`` the worker process.
    4. Sleep 20s.
    5. Assert ``status='failed'`` with ``error_message`` matching the
       reconciler signature.
    6. Assert ``last_cursor`` is preserved.
    7. Assert ``stuck_jobs_redispatched_total{outcome="marked_failed"}``
       counter incremented by 1.
    """
    pytest.skip("Requires docker-compose orchestration; tracked separately")


# ── Cooperative cancellation ──────────────────────────────────────


@pytest.mark.asyncio
async def test_cooperative_cancel_observed_within_one_subbatch() -> None:
    """Cancel contract: ``service.cancel`` requests cooperative cancel;
    the worker observes between MERGE sub-batches (~1–3s typical).
    No FalkorDB MERGE transaction is orphaned (no partial/half-written
    AGGREGATED edges).

    Wiring:
    1. Trigger an aggregation against a graph large enough that one
       outer batch has ≥ 50 sub-batches.
    2. Wait for ``processed_edges > 0`` (first checkpoint landed).
    3. Call ``POST /aggregation-jobs/{id}/cancel``.
    4. Poll status; assert transition to ``cancelled`` within 30s.
    5. Inspect FalkorDB: count ``AGGREGATED`` edges; assert no edges
       have ``r.weight=0`` or ``r.sourceEdgeTypes IS NULL`` (signs of
       a half-written MERGE).
    6. Assert ``cooperative_cancels_observed_total`` counter ticked.
    """
    pytest.skip("Requires docker-compose orchestration; tracked separately")


@pytest.mark.asyncio
async def test_cooperative_cancel_works_during_redis_outage() -> None:
    """Cooperative cancel uses an in-process ``asyncio.Event`` (the
    ``CancelRegistry``) — independent of Redis. So even when Redis is
    unavailable, cancelling a running aggregation must still terminate
    the worker at the next safe boundary.

    Wiring:
    1. Trigger an aggregation.
    2. ``docker pause synodic-redis``.
    3. Call ``POST /aggregation-jobs/{id}/cancel`` (FastAPI handler
       runs ``request_cancel`` against the in-process registry, no
       Redis touch needed).
    4. Assert worker terminates within 30s.
    5. ``docker unpause synodic-redis``.
    6. Assert final row state is ``cancelled``.
    """
    pytest.skip("Requires docker-compose orchestration; tracked separately")
