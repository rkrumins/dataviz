"""Cross-service helper for enqueueing a stats poll job.

Used by:
- The stats service's own scheduler (periodic tick)
- The main API on cache-miss in ``/graph/stats`` / ``/graph/metadata/schema``
  so user requests can kick a recompute without blocking on it.
- The main API when a data source is created, so its stats are populated
  before the first user looks at it.

All callers share the same dedup key and Redis stream — there is no way
to queue two jobs for the same data source in parallel.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from .redis_streams import enqueue, try_claim
from .schemas import StatsJobEnvelope

logger = logging.getLogger(__name__)


# Matches STATS_POLL_TIMEOUT_LARGE_SECS * 2 (the worker's own ceiling).
# A single external caller doesn't need to tune this — the stats service
# config owns it. We only fall back to 600s here as a hard default that
# prevents a stuck claim from surviving past the worker's longest poll.
_DEFAULT_DEDUP_TTL_SECS = 600


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

    claimed = await try_claim(data_source_id, ttl_secs=dedup_ttl_secs)
    if not claimed:
        logger.debug(
            "Stats job already pending for ds=%s — reusing in-flight claim", data_source_id
        )
        return None

    envelope = StatsJobEnvelope(
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        enqueued_at=datetime.now(timezone.utc),
    )
    try:
        msg_id = await enqueue(envelope.to_stream_fields())
        logger.info(
            "Enqueued stats job for ds=%s (workspace=%s, msg_id=%s, trigger=api)",
            data_source_id, workspace_id, msg_id,
        )
        return msg_id
    except Exception as exc:  # pragma: no cover - defensive; claim will expire
        logger.warning(
            "Failed to XADD stats job for ds=%s (claim will expire): %s",
            data_source_id, exc,
        )
        return None
