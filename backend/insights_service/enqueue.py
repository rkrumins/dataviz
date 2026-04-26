"""Cross-service helpers for enqueueing insights-service jobs.

Three job kinds funnel through one ``enqueue_job`` core:

* ``stats_poll`` — post-registration data-source poll.
  Producers: insights scheduler tick, ``/graph/stats`` cache miss,
  workspace add-data-source seeding.
* ``discovery``  — pre-registration asset list / per-asset stats.
  Producers: ``/admin/providers/{id}/assets*`` cache miss,
  scheduler-driven background refreshes.
* ``purge``      — async aggregation-edge purge.
  Producers: ``/admin/data-sources/{id}/purge-aggregation``.

Each kind shares a dedup key with whatever scheduler also enqueues it,
so there is no way to queue two jobs for the same scope in parallel.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from backend.app.config import resilience

from .redis_streams import (
    DISCOVERY_STREAM,
    enqueue,
    get_stream,
    release_claim,
    try_claim,
)
from .schemas import (
    DiscoveryJobEnvelope,
    JobEnvelope,
    PurgeJobEnvelope,
    StatsJobEnvelope,
)

logger = logging.getLogger(__name__)


# Dedup-claim TTL must be ≥ longest-possible poll, otherwise the claim
# expires while the original poll is still running and a duplicate XADD
# can be enqueued. We use ``2 × STATS_POLL_TIMEOUT_LARGE_SECS`` (default
# 1200s) — same value the insights-service scheduler uses, read from the
# same source. ``STATS_DEDUP_TTL_SECS`` overrides for both paths.
_DEFAULT_DEDUP_TTL_SECS = int(os.getenv(
    "STATS_DEDUP_TTL_SECS",
    str(int(resilience.STATS_POLL_TIMEOUT_LARGE_SECS * 2)),
))


# Generic Redis-down handling: ConnectionError/TimeoutError cover the bulk
# of failure modes without requiring redis.exceptions at type check time.
_REDIS_BENIGN_ERRORS: tuple = (
    ConnectionError, asyncio.TimeoutError, TimeoutError, OSError,
)


# ── Core: kind-generic enqueue ───────────────────────────────────────

async def enqueue_job(
    envelope: JobEnvelope,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Atomic claim → XADD. Returns the stream message ID, or ``None``
    when another job for the same scope is already in flight.

    The envelope's ``kind`` selects the target stream + consumer group;
    its ``scope_key`` namespaces the SET NX dedup claim so two different
    kinds never collide on the same Redis key.
    """
    cfg = get_stream(envelope.kind)

    claimed = await try_claim(
        envelope.scope_key, ttl_secs=dedup_ttl_secs, stream=cfg
    )
    if not claimed:
        logger.debug(
            "Insights job already pending kind=%s scope=%s — reusing in-flight claim",
            envelope.kind, envelope.scope_key,
        )
        return None

    try:
        msg_id = await enqueue(envelope.to_stream_fields(), stream=cfg)
        logger.info(
            "Enqueued %s job scope=%s msg_id=%s trigger=api",
            envelope.kind, envelope.scope_key, msg_id,
        )
        return msg_id
    except Exception as exc:  # pragma: no cover - defensive; claim will expire
        logger.warning(
            "Failed to XADD %s job scope=%s (claim will expire): %s",
            envelope.kind, envelope.scope_key, exc,
        )
        return None


async def enqueue_job_safe(
    envelope: JobEnvelope,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Redis-tolerant variant of :func:`enqueue_job`.

    Used by HTTP handlers on cache-miss — the handler must still return
    a valid response (200 with ``status="computing"``) even when Redis
    is unreachable, otherwise a Redis outage cascades into 5xx errors
    on the web tier.
    """
    try:
        return await enqueue_job(envelope, dedup_ttl_secs=dedup_ttl_secs)
    except _REDIS_BENIGN_ERRORS as exc:
        logger.warning(
            "Redis unavailable for %s enqueue scope=%s: %s — handler will return cache-only without refresh",
            envelope.kind, envelope.scope_key, exc,
        )
        return None
    except Exception as exc:  # pragma: no cover - last-resort safety net
        logger.exception(
            "Unexpected failure in enqueue_job_safe (kind=%s scope=%s): %s",
            envelope.kind, envelope.scope_key, exc,
        )
        return None


# ── Stats: existing call-site API (graph.py, workspaces.py, scheduler) ─

async def enqueue_stats_job(
    data_source_id: str,
    workspace_id: str,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Enqueue a stats poll job unless one is already in flight.

    Returns the Redis stream message ID when the job was enqueued, or
    ``None`` if another poll is already pending/running for this data
    source (dedup claim already held). In both cases the caller's
    user-facing response should carry ``status=computing`` — the job
    will complete whether we enqueued it this turn or not.
    """
    if not data_source_id or not workspace_id:
        return None
    envelope = StatsJobEnvelope(
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        enqueued_at=datetime.now(timezone.utc),
    )
    return await enqueue_job(envelope, dedup_ttl_secs=dedup_ttl_secs)


async def enqueue_stats_job_safe(
    data_source_id: str,
    workspace_id: str,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Redis-tolerant variant of :func:`enqueue_stats_job`.

    Used by HTTP handlers on cache-miss — Redis outage must NOT cascade
    into 5xx errors. ``None`` covers both "Redis unreachable" and "claim
    already held"; callers treat them identically.
    """
    if not data_source_id or not workspace_id:
        return None
    envelope = StatsJobEnvelope(
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        enqueued_at=datetime.now(timezone.utc),
    )
    return await enqueue_job_safe(envelope, dedup_ttl_secs=dedup_ttl_secs)


# ── Discovery: pre-registration asset cache miss ─────────────────────

# Discovery jobs complete in seconds (list_graphs / get_stats), unlike
# stats polls of 1M+ edge graphs which can take minutes. Using the
# global ``_DEFAULT_DEDUP_TTL_SECS`` (1200s) here was the root cause
# of the "Stale for X minutes" regression: a stalled worker held the
# claim for 20 min before re-enqueue could happen. 90s default is
# enough headroom for slow providers but recovers fast on stalls.
_DISCOVERY_DEDUP_TTL_SECS = resilience.DISCOVERY_DEDUP_TTL_SECS


async def enqueue_discovery_job_safe(
    provider_id: str,
    asset_name: str = "",
    *,
    dedup_ttl_secs: int = _DISCOVERY_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Redis-tolerant enqueue for asset discovery jobs.

    ``asset_name=""`` is the list-all sentinel (one row per provider);
    any other value targets a single asset's stats.
    """
    if not provider_id:
        return None
    envelope = DiscoveryJobEnvelope(
        provider_id=provider_id,
        asset_name=asset_name,
        enqueued_at=datetime.now(timezone.utc),
    )
    return await enqueue_job_safe(envelope, dedup_ttl_secs=dedup_ttl_secs)


async def enqueue_discovery_job_force(
    provider_id: str,
    asset_name: str = "",
) -> Optional[str]:
    """Drop any existing dedup claim then re-enqueue a discovery job.

    Used by the on-demand refresh endpoints (``POST .../refresh``).
    Idempotent at the cache level: the discovery handler is an UPSERT
    into ``asset_discovery_cache`` so a duplicate run only burns one
    extra provider call. Race window between release and claim is
    tolerable for an explicit user-driven action.
    """
    if not provider_id:
        return None
    scope_key = f"{provider_id}:{asset_name}"
    await release_claim(scope_key, stream=DISCOVERY_STREAM)
    return await enqueue_discovery_job_safe(provider_id, asset_name)


# ── Purge: aggregation edge deletion ─────────────────────────────────

async def enqueue_purge_job_safe(
    job_id: str,
    data_source_id: str,
    workspace_id: str,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Redis-tolerant enqueue for aggregation-edge purge jobs.

    ``job_id`` is the pre-existing ``AggregationJobORM.id`` row that the
    HTTP endpoint creates with ``status="pending"``; the worker flips
    it to ``running`` then ``completed``/``failed``. If Redis is
    unavailable, the row stays in ``pending`` and the operator must
    redrive — that's surfaced via the standard Job History UI.
    """
    if not job_id or not data_source_id or not workspace_id:
        return None
    envelope = PurgeJobEnvelope(
        job_id=job_id,
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        enqueued_at=datetime.now(timezone.utc),
    )
    return await enqueue_job_safe(envelope, dedup_ttl_secs=dedup_ttl_secs)


async def enqueue_purge_job_force(
    job_id: str,
    data_source_id: str,
    workspace_id: str,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Drop any existing dedup claim, then enqueue a purge job.

    Used by the HTTP purge endpoint where the user has explicitly
    clicked Purge — duplicate-purge protection lives at the DB layer
    (``claim_purge_job`` 409s on any pending/running row for the same
    data source), so the Redis dedup claim is just an optimization to
    avoid redundant work. A stale claim from a prior crashed worker or
    a claim still being held by a soft-retry loop would otherwise make
    ``enqueue_purge_job_safe`` return ``None`` and the user couldn't
    retry their purge for up to the claim's 20-minute TTL.

    Race window between release and the new claim is tolerable because
    the DB-level conflict check is authoritative.
    """
    if not job_id or not data_source_id or not workspace_id:
        return None
    cfg = get_stream("purge")
    # Best-effort claim release. If Redis is genuinely down, the
    # follow-up enqueue will surface that via the safe wrapper's
    # exception swallowing — let the caller decide how to handle.
    try:
        await release_claim(data_source_id, stream=cfg)
    except _REDIS_BENIGN_ERRORS as exc:
        logger.warning(
            "purge force-release failed (continuing to enqueue): %s", exc,
        )
    return await enqueue_purge_job_safe(
        job_id, data_source_id, workspace_id, dedup_ttl_secs=dedup_ttl_secs,
    )


__all__ = [
    "enqueue_job",
    "enqueue_job_safe",
    "enqueue_stats_job",
    "enqueue_stats_job_safe",
    "enqueue_discovery_job_safe",
    "enqueue_discovery_job_force",
    "enqueue_purge_job_safe",
    "enqueue_purge_job_force",
]
