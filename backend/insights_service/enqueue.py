"""Cross-service helpers for enqueueing insights-service jobs.

Three job kinds funnel through one ``enqueue_job`` core:

* ``stats_poll``     — post-registration data-source poll.
  Producers: insights scheduler tick, ``/graph/stats`` cache miss,
  workspace add-data-source seeding.
* ``discovery``      — pre-registration asset list / per-asset stats.
  Producers: ``/admin/providers/{id}/assets*`` cache miss,
  scheduler-driven background refreshes.
* ``schema_refresh`` — explicit schema cache priming.
  Producers: ``/metadata/schema`` cache miss when only schema is missing.

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

from .redis_streams import enqueue, get_stream, try_claim
from .schemas import (
    DiscoveryJobEnvelope,
    JobEnvelope,
    SchemaJobEnvelope,
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

async def enqueue_discovery_job_safe(
    provider_id: str,
    asset_name: str = "",
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
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


# ── Schema-only refresh ──────────────────────────────────────────────

async def enqueue_schema_job_safe(
    data_source_id: str,
    workspace_id: str,
    *,
    dedup_ttl_secs: int = _DEFAULT_DEDUP_TTL_SECS,
) -> Optional[str]:
    """Redis-tolerant enqueue for explicit schema cache priming."""
    if not data_source_id or not workspace_id:
        return None
    envelope = SchemaJobEnvelope(
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        enqueued_at=datetime.now(timezone.utc),
    )
    return await enqueue_job_safe(envelope, dedup_ttl_secs=dedup_ttl_secs)


__all__ = [
    "enqueue_job",
    "enqueue_job_safe",
    "enqueue_stats_job",
    "enqueue_stats_job_safe",
    "enqueue_discovery_job_safe",
    "enqueue_schema_job_safe",
]
