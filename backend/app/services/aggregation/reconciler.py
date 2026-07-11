"""Stuck-job reconciler.

Periodic background task that detects ``aggregation_jobs`` rows whose
worker died without writing a terminal status, marks them
``status='failed'`` with a clear ``error_message``, and emits a metric
so operators / dashboards see the event.

Why this exists. The current ``InProcessDispatcher`` runs each
aggregation as an ``asyncio.create_task(worker.run(...))``. If the web
process is killed mid-job (deploy, OOM, segfault), the in-flight task
is gone but the DB row is still ``status='running'``. Nothing detects
this today. Operators see a frozen progress bar that never moves and a
job they cannot cancel without manual SQL.

What this *doesn't* do. It does NOT auto-redispatch the stuck job —
under ``InProcessDispatcher`` redispatch races with a possibly-still-
alive original task. Operator-driven Resume is the path forward; this
reconciler just clears the lie that the row is actively progressing
so Resume becomes available. Phase 2 (Redis Streams + XAUTOCLAIM)
will add safe auto-redispatch.

Threshold. ``last_checkpoint_at`` is bumped every ~2 s on a healthy
aggregation worker (intra-batch heartbeat cadence), so 5 minutes
without a checkpoint is a strong signal of death. The threshold is
env-tunable via ``STUCK_JOB_HEARTBEAT_THRESHOLD_SECS``.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from backend.app.jobs.metrics import increment as metrics_increment

from .cancel import get_registry as get_cancel_registry
from .models import AggregationJobORM

logger = logging.getLogger(__name__)


_RECONCILE_INTERVAL_SECS: float = float(
    os.getenv("STUCK_JOB_RECONCILE_INTERVAL_SECS", "30")
)
_HEARTBEAT_THRESHOLD_SECS: float = float(
    os.getenv("STUCK_JOB_HEARTBEAT_THRESHOLD_SECS", "300")
)
_MAX_AUTO_RESUMES: int = int(os.getenv("STUCK_JOB_MAX_AUTO_RESUMES", "5"))
# Stale-PENDING backstop: a row dispatched onto the job stream in a
# deployment with no aggregation-worker consumer stays 'pending' forever
# ("queued and will start shortly" in the UI) and 409-blocks every later
# trigger for its data source. Two signals close that hole:
#   - no live worker registered (fleet registry empty) for a pending row
#     older than _PENDING_NO_WORKER_SECS → fail fast with a config hint;
#   - any pending row older than _PENDING_TIMEOUT_SECS → fail (backstop
#     for lost stream messages even when workers exist).
_PENDING_NO_WORKER_SECS: float = float(
    os.getenv("AGGREGATION_PENDING_NO_WORKER_SECS", "900")
)
_PENDING_TIMEOUT_SECS: float = float(
    os.getenv("AGGREGATION_PENDING_TIMEOUT_SECS", "21600")
)


def _parse_iso(ts: str | None) -> datetime | None:
    """Parse a TEXT-stored ISO timestamp from ``aggregation_jobs``.

    Tolerant: returns ``None`` on missing or malformed values so the
    reconciler never crashes on a single bad row.
    """
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _reconcile_once(session_factory: Any, redis_client: Any = None) -> int:
    """Single sweep. Returns the count of rows reconciled.

    Lock-aware (preferred): the per-job execution lock ``agg:exec:{job_id}``
    is the authoritative "a runner is alive" signal. For each ``running``
    job:
      - lock PRESENT  → a live single-active executor is heartbeating → skip.
      - lock ABSENT   → the executor died → AUTO-RESUME by re-dispatching so a
                        worker picks it up and continues from ``last_cursor``
                        (capped by ``STUCK_JOB_MAX_AUTO_RESUMES`` → then failed).
                        A cancelled job (durable flag) is marked cancelled, not
                        resumed.
    When ``redis_client`` is None (or the lock check errors), fall back to the
    legacy checkpoint-staleness sweep → mark ``failed`` for manual Resume.
    """
    threshold = datetime.now(timezone.utc) - timedelta(
        seconds=_HEARTBEAT_THRESHOLD_SECS
    )
    cancel_registry = get_cancel_registry()

    reconciled = 0
    async with session_factory() as session:
        # Cross-replica guard: the control plane, a dev-role monolith and
        # any HA replica may all run this loop. The xact-scoped advisory
        # lock (held until this session's commit/close) makes each tick
        # single-writer without coordination; the sweep itself is
        # idempotent (INCR cap + exec-lock dedupe), so the lock only
        # removes duplicate re-dispatch noise. Non-Postgres backends
        # (unit fakes) simply proceed — single-instance semantics.
        try:
            from sqlalchemy import text as _text
            got = (await session.execute(_text(
                "SELECT pg_try_advisory_xact_lock("
                "hashtextextended('agg:reconciler', 0))"
            ))).scalar()
            if got in (False, 0):
                return 0
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

        running = (
            await session.execute(
                select(AggregationJobORM).where(
                    AggregationJobORM.status == "running"
                )
                # Purge rows live on the INSIGHTS stream and hold no
                # aggregation exec lock — sweeping them here re-dispatched
                # every purge outliving one tick onto the aggregation
                # stream, where the worker refused it ("this row belongs
                # to the purge stream"). Purge liveness is the insights
                # PEL/XAUTOCLAIM's job.
                .where(AggregationJobORM.trigger_source != "purge")
            )
        ).scalars().all()

        for job in running:
            now_iso = datetime.now(timezone.utc).isoformat()

            # ── Lock-aware path (the exec lock is the liveness signal) ──
            if redis_client is not None:
                try:
                    from .redis_client import (
                        exec_lock_key, cancel_flag_key, JOBS_STREAM,
                    )

                    if await redis_client.exists(exec_lock_key(job.id)):
                        continue  # a live executor holds the lock

                    # Lock gone → executor died. If cancelled, don't resume.
                    if await redis_client.get(cancel_flag_key(job.id)):
                        job.status = "cancelled"
                        job.error_message = "Cancelled; executor stopped."
                        job.completed_at = now_iso
                        job.updated_at = now_iso
                        reconciled += 1
                        continue

                    # Auto-resume, capped to avoid a poison job looping forever.
                    cnt_key = f"agg:redispatch:{job.id}"
                    attempts = int(await redis_client.incr(cnt_key))
                    await redis_client.expire(
                        cnt_key, int(_HEARTBEAT_THRESHOLD_SECS) * 4,
                    )
                    if attempts > _MAX_AUTO_RESUMES:
                        job.status = "failed"
                        job.error_message = (
                            f"Auto-resume cap ({_MAX_AUTO_RESUMES}) reached "
                            f"without completing; resume from cursor={job.last_cursor} "
                            f"is still possible."
                        )
                        job.completed_at = now_iso
                        job.updated_at = now_iso
                        metrics_increment(
                            "stuck_jobs_redispatched_total",
                            kind="aggregation", outcome="auto_resume_exhausted",
                        )
                        reconciled += 1
                        continue

                    await redis_client.xadd(
                        JOBS_STREAM,
                        {"job_id": job.id, "dispatched_at": now_iso},
                        maxlen=50000,
                    )
                    logger.warning(
                        "reconciler: job %s exec lock absent (executor died) — "
                        "auto-resume #%d from cursor=%s",
                        job.id, attempts, job.last_cursor,
                    )
                    metrics_increment(
                        "stuck_jobs_redispatched_total",
                        kind="aggregation", outcome="auto_resumed",
                    )
                    reconciled += 1
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "reconciler: lock-aware check failed for %s (%s) — "
                        "falling back to staleness sweep", job.id, exc,
                    )
                    # fall through to the staleness path below

            # ── Fallback: legacy checkpoint-staleness → mark failed ──
            ref_ts = _parse_iso(job.last_checkpoint_at) or _parse_iso(job.started_at)
            if ref_ts is None or ref_ts >= threshold:
                continue

            if job.id in cancel_registry.active_jobs():
                logger.warning(
                    "reconciler: job %s last_checkpoint_at=%s is stale but "
                    "worker is locally registered; skipping (cooperative "
                    "cancel via UI is the right tool)",
                    job.id, job.last_checkpoint_at,
                )
                continue

            stale_for = (datetime.now(timezone.utc) - ref_ts).total_seconds()
            logger.error(
                "reconciler: job %s ds=%s stuck for %.0fs (last_checkpoint_at=%s) "
                "— marking failed; operator can Resume to restart from cursor=%s",
                job.id, job.data_source_id, stale_for,
                job.last_checkpoint_at, job.last_cursor,
            )
            job.status = "failed"
            job.error_message = (
                f"Reconciler: no progress for {int(stale_for)}s "
                f"(threshold={int(_HEARTBEAT_THRESHOLD_SECS)}s). "
                f"Worker likely died; resume from last_cursor is possible."
            )
            job.completed_at = now_iso
            job.updated_at = now_iso
            metrics_increment(
                "stuck_jobs_redispatched_total",
                kind="aggregation",
                outcome="marked_failed",
            )
            reconciled += 1

        reconciled += await _sweep_stale_pending(session, redis_client)

        if reconciled:
            await session.commit()

    return reconciled


async def _sweep_stale_pending(session: Any, redis_client: Any) -> int:
    """Fail pending rows that will never be picked up — see the module
    constants for the two signals. Never raises."""
    now = datetime.now(timezone.utc)
    try:
        pending = (
            await session.execute(
                select(AggregationJobORM)
                .where(AggregationJobORM.status == "pending")
                .where(AggregationJobORM.trigger_source != "purge")
            )
        ).scalars().all()
        if not pending:
            return 0
        workers_alive: bool | None = None
        if redis_client is not None:
            try:
                cursor, keys = await redis_client.scan(
                    cursor=0, match="agg:worker:*", count=100,
                )
                workers_alive = bool(keys)
                while not workers_alive and cursor:
                    cursor, keys = await redis_client.scan(
                        cursor=cursor, match="agg:worker:*", count=100,
                    )
                    workers_alive = bool(keys)
            except Exception:
                workers_alive = None  # unknown — don't fail rows on it
        count = 0
        for job in pending:
            ref = _parse_iso(job.updated_at) or _parse_iso(job.created_at)
            if ref is None:
                continue
            age = (now - ref).total_seconds()
            if workers_alive is False and age > _PENDING_NO_WORKER_SECS:
                reason = (
                    f"Queued for {int(age)}s with no aggregation worker "
                    "registered on the job bus. Check that the aggregation "
                    "worker service is deployed and can reach REDIS_URL, "
                    "then re-trigger."
                )
            elif age > _PENDING_TIMEOUT_SECS:
                reason = (
                    f"Queued for {int(age)}s without being picked up "
                    f"(threshold={int(_PENDING_TIMEOUT_SECS)}s) — the "
                    "dispatch message was likely lost. Re-trigger to "
                    "re-enqueue."
                )
            else:
                continue
            now_iso = now.isoformat()
            logger.error(
                "reconciler: pending job %s ds=%s abandoned: %s",
                job.id, job.data_source_id, reason,
            )
            job.status = "failed"
            job.error_message = reason
            job.completed_at = now_iso
            job.updated_at = now_iso
            metrics_increment(
                "stuck_jobs_redispatched_total",
                kind="aggregation", outcome="pending_abandoned",
            )
            count += 1
        return count
    except Exception as exc:
        logger.warning("reconciler: stale-pending sweep failed: %s", exc)
        return 0


async def run_reconciler(
    session_factory: Any,
    shutdown: asyncio.Event,
    redis_client: Any = None,
) -> None:
    """Long-running reconciler loop.

    Spawned as a background task during application startup. Sleeps
    on the shutdown event between sweeps so process termination
    doesn't have to wait the full interval. When ``redis_client`` is
    provided the sweep is lock-aware (auto-resume on executor death);
    otherwise it falls back to the staleness sweep.
    """
    logger.info(
        "Stuck-job reconciler starting (interval=%ds, threshold=%ds, "
        "lock_aware=%s)",
        int(_RECONCILE_INTERVAL_SECS), int(_HEARTBEAT_THRESHOLD_SECS),
        redis_client is not None,
    )
    while not shutdown.is_set():
        try:
            count = await _reconcile_once(session_factory, redis_client)
            if count:
                logger.info("reconciler: reconciled %d stuck job(s)", count)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A failed sweep must not kill the loop — log and try
            # again next interval.
            logger.error("reconciler: sweep failed: %s", exc, exc_info=True)
        try:
            await asyncio.wait_for(
                shutdown.wait(), timeout=_RECONCILE_INTERVAL_SECS,
            )
            return
        except asyncio.TimeoutError:
            continue
