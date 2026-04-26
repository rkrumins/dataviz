"""Redis Streams wiring for the insights service.

The service consumes from multiple streams — one per job kind:

* ``insights.jobs.stats``     — post-registration data-source polling
* ``insights.jobs.discovery`` — pre-registration asset list / per-asset stats
* ``insights.jobs.schema``    — explicit schema cache priming

Each stream has its own consumer group so a worker can XREADGROUP from
all of them in parallel and process each independently. A single DLQ
(``insights.dlq``) collects exhausted messages from any source — the
DLQ entry carries ``kind`` and ``original_stream`` so an operator can
route a redrive back to the right place.

Reuses the singleton async Redis client from
``backend.app.services.aggregation.redis_client`` — one connection
pool per process regardless of how many headless services share it.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

import redis.asyncio as aioredis

from backend.app.config import resilience
from backend.app.services.aggregation.redis_client import get_redis

logger = logging.getLogger(__name__)


# ── Stream catalog ───────────────────────────────────────────────────

@dataclass(frozen=True)
class StreamConfig:
    """Identity of one Redis Stream + its consumer group + dedup namespace."""
    kind: str            # 'stats_poll' | 'discovery' | 'purge'
    stream: str          # Redis stream key
    group: str           # XREADGROUP consumer group
    dedup_prefix: str    # SET NX key prefix for the producer-side claim


# All streams use one consumer group so a single XREADGROUP call can
# multiplex across them. The per-stream PEL is still tracked
# independently by Redis under the same group name.
SHARED_GROUP = "insights-workers"

STATS_STREAM = StreamConfig(
    kind="stats_poll",
    stream="insights.jobs.stats",
    group=SHARED_GROUP,
    dedup_prefix="insights:stats",
)

DISCOVERY_STREAM = StreamConfig(
    kind="discovery",
    stream="insights.jobs.discovery",
    group=SHARED_GROUP,
    dedup_prefix="insights:discovery",
)

# Purge gets its own stream so the worker's per-graph semaphore + size-
# bucketed timeouts apply uniformly. The dedup prefix is keyed on the
# data_source_id so two purge requests for the same source coalesce.
PURGE_STREAM = StreamConfig(
    kind="purge",
    stream="insights.jobs.purge",
    group=SHARED_GROUP,
    dedup_prefix="insights:purge",
)

ALL_STREAMS: tuple[StreamConfig, ...] = (STATS_STREAM, DISCOVERY_STREAM, PURGE_STREAM)

_BY_KIND: dict[str, StreamConfig] = {s.kind: s for s in ALL_STREAMS}

DLQ_STREAM = "insights.dlq"

# DLQ has no consumer group / no PEL — capping it with MAXLEN is safe
# because there are no unACKed entries that would be silently trimmed.
DLQ_MAXLEN = 5_000

# Worker XAUTOCLAIM idle-time threshold and DLQ redrive cap are
# centralised in ``backend.app.config.resilience`` so ops can tune
# them via env vars without code changes. Re-exported here so the
# rest of the insights_service module-graph reads one canonical value.
XAUTOCLAIM_MIN_IDLE_MS = resilience.XAUTOCLAIM_MIN_IDLE_MS
DLQ_REDRIVE_LIMIT = resilience.DLQ_REDRIVE_LIMIT


# ── Backwards-compat shims for legacy stats-only callers ─────────────
# Keep these so the existing worker.py / scheduler.py code continues to
# work without simultaneous edits. They alias to the stats stream
# specifically — anything new should use the StreamConfig API.

JOBS_STREAM = STATS_STREAM.stream
CONSUMER_GROUP = STATS_STREAM.group


def get_stream(kind: str) -> StreamConfig:
    try:
        return _BY_KIND[kind]
    except KeyError as exc:
        raise ValueError(f"Unknown insights job kind: {kind!r}") from exc


# ── Consumer-group lifecycle ─────────────────────────────────────────

async def ensure_consumer_group(stream: StreamConfig | None = None) -> None:
    """Create the consumer group for one stream — or all of them — idempotently.

    Called once at process start by ``__main__.py``. Safe to re-invoke;
    BUSYGROUP errors are swallowed.
    """
    redis = get_redis()
    targets: tuple[StreamConfig, ...] = (stream,) if stream else ALL_STREAMS
    for cfg in targets:
        try:
            await redis.xgroup_create(cfg.stream, cfg.group, id="0", mkstream=True)
            logger.info(
                "Created consumer group %r on stream %r", cfg.group, cfg.stream
            )
        except aioredis.ResponseError as exc:
            if "BUSYGROUP" in str(exc):
                logger.debug("Consumer group %r already exists", cfg.group)
                continue
            raise


# ── Per-job dedup claim (SET NX + TTL) ───────────────────────────────

def _dedup_key(cfg: StreamConfig, scope_key: str) -> str:
    return f"{cfg.dedup_prefix}:pending:{scope_key}"


# Legacy single-arg helper — keyed implicitly on the stats stream.
def dedup_key(scope_key: str) -> str:
    return _dedup_key(STATS_STREAM, scope_key)


async def try_claim(scope_key: str, ttl_secs: int, *, stream: StreamConfig = STATS_STREAM) -> bool:
    """Atomic set-if-not-exists with TTL. True → caller owns the slot."""
    redis = get_redis()
    return bool(await redis.set(_dedup_key(stream, scope_key), "1", nx=True, ex=ttl_secs))


async def release_claim(scope_key: str, *, stream: StreamConfig = STATS_STREAM) -> None:
    redis = get_redis()
    await redis.delete(_dedup_key(stream, scope_key))


# ── Producer side: XADD ──────────────────────────────────────────────

async def enqueue(fields: dict[str, str], *, stream: StreamConfig = STATS_STREAM) -> str:
    """XADD a job envelope. Returns the stream message ID.

    Intentionally **no MAXLEN** on jobs streams: an approximate trim
    can remove entries that are still in some consumer's PEL (i.e.
    unACKed), which is silent data loss. Periodic MINID-based
    ``trim_streams_by_minid`` handles bounded growth instead — see
    ``scheduler.trim_streams``.
    """
    redis = get_redis()
    return await redis.xadd(stream.stream, fields)


async def send_to_dlq(
    msg_id: str,
    fields: dict[str, str],
    reason: str,
    *,
    stream: StreamConfig = STATS_STREAM,
) -> None:
    """Forward a message that has exhausted its retries to the shared DLQ.

    The DLQ entry includes ``original_stream`` and ``kind`` so an
    operator's redrive script can route the redrive back to the source.
    """
    redis = get_redis()
    # Carry redrive_count forward so a redriven-then-failed-again
    # message lands back in DLQ with the counter preserved (the
    # redrive helper increments it). For first-time DLQ writes the
    # ``fields`` dict has no counter yet; default to 0.
    existing_redrive = fields.get("redrive_count", "0")
    payload = {
        **fields,
        "original_msg_id": msg_id,
        "original_stream": stream.stream,
        "kind": stream.kind,
        "reason": reason,
        "redrive_count": existing_redrive,
    }
    await redis.xadd(DLQ_STREAM, payload, maxlen=DLQ_MAXLEN, approximate=True)


# ── DLQ admin helpers ───────────────────────────────────────────────
#
# All DLQ XRANGE/XADD/XDEL verbs live here so endpoints / scripts /
# tests don't reach into Redis directly. Typed exceptions let the
# caller map to HTTP status codes without parsing strings.


class DLQEntryNotFound(Exception):
    """Raised when a DLQ admin operation targets an id that is no longer
    present (already redriven, deleted, or was never there)."""


class InvalidOriginalStream(Exception):
    """Raised when a DLQ entry's ``original_stream`` is not in the
    allowlist of known job streams. Untrusted input from Redis: a
    stale entry (renamed stream) or a hostile XADD could otherwise
    trick redrive into writing to an arbitrary key."""


class RedriveLimitExceeded(Exception):
    """Raised when a DLQ entry has already been redriven
    ``DLQ_REDRIVE_LIMIT`` times. Operator must investigate the
    underlying failure (poisoned envelope, persistent provider issue)
    rather than keep re-queuing."""


@dataclass(frozen=True)
class DLQEntry:
    """Parsed shape of one DLQ row. Field names match the worker's
    ``send_to_dlq`` payload."""
    msg_id: str
    kind: str
    original_stream: str
    original_msg_id: str
    reason: str
    redrive_count: int
    fields: dict[str, str]   # full payload incl. envelope fields
    ts_ms: int               # parsed from the stream message id


@dataclass(frozen=True)
class RedriveResult:
    redriven_msg_id: str
    original_stream: str
    redrive_count: int


def _decode_str(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _parse_dlq_entry(msg_id_raw, fields_raw: dict) -> DLQEntry:
    msg_id = _decode_str(msg_id_raw)
    fields = {_decode_str(k): _decode_str(v) for k, v in fields_raw.items()}
    ts_ms = _decode_msg_id_to_ms(msg_id) or 0
    try:
        redrive_count = int(fields.get("redrive_count", "0"))
    except ValueError:
        redrive_count = 0
    return DLQEntry(
        msg_id=msg_id,
        kind=fields.get("kind", ""),
        original_stream=fields.get("original_stream", ""),
        original_msg_id=fields.get("original_msg_id", ""),
        reason=fields.get("reason", ""),
        redrive_count=redrive_count,
        fields=fields,
        ts_ms=ts_ms,
    )


def _is_known_stream(stream_name: str) -> bool:
    return any(cfg.stream == stream_name for cfg in ALL_STREAMS)


async def list_dlq_entries(
    cursor: str = "-",
    limit: int = 50,
) -> tuple[list[DLQEntry], Optional[str]]:
    """Paginated DLQ listing.

    ``cursor`` is the inclusive lower bound for XRANGE — use ``"-"``
    on the first page and the returned ``next_cursor`` for the next.
    Returns ``(entries, next_cursor)``; ``next_cursor`` is ``None``
    when fewer than ``limit`` entries were returned.
    """
    if limit <= 0:
        return [], None
    redis = get_redis()
    raw = await redis.xrange(DLQ_STREAM, min=cursor, max="+", count=limit)
    entries = [_parse_dlq_entry(msg_id, fields) for msg_id, fields in raw]
    next_cursor: Optional[str] = None
    if len(entries) >= limit:
        # XRANGE is inclusive on both ends; advance past the last id by
        # appending '0' as the sequence component to skip the last seen.
        last_id = entries[-1].msg_id
        # Format "<ms>-<seq>". Increment seq.
        if "-" in last_id:
            ms_part, seq_part = last_id.split("-", 1)
            try:
                next_cursor = f"{ms_part}-{int(seq_part) + 1}"
            except ValueError:
                next_cursor = last_id
        else:
            next_cursor = last_id
    return entries, next_cursor


async def get_dlq_entry(msg_id: str) -> Optional[DLQEntry]:
    """Fetch one DLQ entry by id, or None if absent."""
    redis = get_redis()
    raw = await redis.xrange(DLQ_STREAM, min=msg_id, max=msg_id, count=1)
    if not raw:
        return None
    return _parse_dlq_entry(raw[0][0], raw[0][1])


async def delete_dlq_entry(msg_id: str) -> bool:
    """XDEL one DLQ entry. Returns True if it existed and was removed."""
    redis = get_redis()
    deleted = await redis.xdel(DLQ_STREAM, msg_id)
    return bool(deleted)


async def redrive_dlq_entry(msg_id: str) -> RedriveResult:
    """Re-deliver a DLQ entry to its original stream.

    Order: XADD to ``original_stream`` first, then XDEL the DLQ row.
    If XADD fails, the DLQ row is preserved — at-least-once redrive,
    never lossy. If XDEL fails (rare; row gone), we still report
    success because the redrive happened.

    Validation: ``original_stream`` must match one of ``ALL_STREAMS``;
    untrusted Redis content otherwise. ``redrive_count`` must be
    < ``DLQ_REDRIVE_LIMIT``; otherwise the operator is asked to
    investigate root cause rather than keep redriving.
    """
    entry = await get_dlq_entry(msg_id)
    if entry is None:
        raise DLQEntryNotFound(f"DLQ entry {msg_id!r} not found")

    if not _is_known_stream(entry.original_stream):
        raise InvalidOriginalStream(
            f"DLQ entry {msg_id} has unknown original_stream "
            f"{entry.original_stream!r}; refusing to redrive"
        )

    if entry.redrive_count >= DLQ_REDRIVE_LIMIT:
        raise RedriveLimitExceeded(
            f"DLQ entry {msg_id} already redriven "
            f"{entry.redrive_count} times (limit={DLQ_REDRIVE_LIMIT})"
        )

    new_redrive_count = entry.redrive_count + 1
    redrive_fields = {
        k: v
        for k, v in entry.fields.items()
        if k not in ("original_msg_id", "original_stream", "reason")
    }
    redrive_fields["redrive_count"] = str(new_redrive_count)

    redis = get_redis()
    redriven_msg_id = await redis.xadd(entry.original_stream, redrive_fields)
    try:
        await redis.xdel(DLQ_STREAM, msg_id)
    except Exception as exc:
        # Redrive succeeded; DLQ cleanup didn't. Log + report success.
        logger.warning(
            "redrive.xdel_failed msg_id=%s err=%s — entry remains in DLQ",
            msg_id, exc,
        )

    return RedriveResult(
        redriven_msg_id=_decode_str(redriven_msg_id),
        original_stream=entry.original_stream,
        redrive_count=new_redrive_count,
    )


# ── Stream depth snapshot (queue-depth observability) ──────────────

@dataclass(frozen=True)
class StreamDepth:
    """Snapshot of one jobs stream's queue health."""
    length: Optional[int]                # XLEN; None on Redis error
    pending: Optional[int]               # XPENDING summary count
    oldest_pending_age_ms: Optional[int] # now - PEL min-id ms; None when no PEL


@dataclass(frozen=True)
class DLQDepth:
    length: Optional[int]
    oldest_age_ms: Optional[int]


@dataclass(frozen=True)
class StreamDepthsSnapshot:
    streams: dict[str, StreamDepth]   # keyed by ``StreamConfig.kind``
    dlq: DLQDepth


async def snapshot_stream_depths() -> StreamDepthsSnapshot:
    """Read XLEN + XPENDING summary for each jobs stream + DLQ head.

    Designed to run on a 5s background tick from ``__main__.py``.
    Per-stream errors degrade gracefully to ``None``-valued fields
    rather than raising — health endpoints should never fail because
    one stream is briefly unreachable.
    """
    redis = get_redis()
    now_ms = int(time.time() * 1000)

    streams: dict[str, StreamDepth] = {}
    for cfg in ALL_STREAMS:
        try:
            length = int(await redis.xlen(cfg.stream))
        except Exception:
            length = None

        pending_count: Optional[int] = None
        oldest_pending_age_ms: Optional[int] = None
        try:
            pending = await redis.xpending(cfg.stream, cfg.group)
            if isinstance(pending, dict):
                pending_count = int(pending.get("pending", 0) or 0)
                min_id = pending.get("min")
            else:
                pending_count = int(pending[0] or 0) if pending else 0
                min_id = pending[1] if pending and len(pending) > 1 else None
            if pending_count > 0 and min_id is not None:
                min_ms = _decode_msg_id_to_ms(min_id)
                if min_ms is not None:
                    oldest_pending_age_ms = max(0, now_ms - min_ms)
        except Exception:
            pending_count = None

        streams[cfg.kind] = StreamDepth(
            length=length,
            pending=pending_count,
            oldest_pending_age_ms=oldest_pending_age_ms,
        )

    dlq_length: Optional[int] = None
    dlq_oldest_age_ms: Optional[int] = None
    try:
        dlq_length = int(await redis.xlen(DLQ_STREAM))
        if dlq_length > 0:
            head = await redis.xrange(DLQ_STREAM, count=1)
            if head:
                head_ms = _decode_msg_id_to_ms(head[0][0])
                if head_ms is not None:
                    dlq_oldest_age_ms = max(0, now_ms - head_ms)
    except Exception:
        dlq_length = None

    return StreamDepthsSnapshot(
        streams=streams,
        dlq=DLQDepth(length=dlq_length, oldest_age_ms=dlq_oldest_age_ms),
    )


def stream_depths_to_dict(snapshot: StreamDepthsSnapshot) -> dict:
    """JSON-friendly view for /health payload merging."""
    return {
        "streams": {
            kind: {
                "len": s.length,
                "pending": s.pending,
                "oldest_pending_age_ms": s.oldest_pending_age_ms,
            }
            for kind, s in snapshot.streams.items()
        },
        "dlq": {
            "len": snapshot.dlq.length,
            "oldest_age_ms": snapshot.dlq.oldest_age_ms,
        },
    }


# ── Periodic stream trim (MINID-based, PEL-safe) ────────────────────

@dataclass(frozen=True)
class TrimResult:
    """Per-stream outcome of one ``trim_streams_by_minid`` pass."""
    stream: str
    trimmed: int           # entries actually removed (0 when skipped)
    skipped: bool          # true → trim was suppressed
    reason: Optional[str]  # populated when skipped


def _decode_msg_id_to_ms(msg_id: object) -> Optional[int]:
    """Stream IDs are ``<ms>-<seq>`` strings (or bytes). Returns the
    ``<ms>`` component as int, or None if unparseable."""
    if msg_id is None:
        return None
    raw = msg_id.decode() if isinstance(msg_id, bytes) else str(msg_id)
    head = raw.split("-", 1)[0]
    try:
        return int(head)
    except ValueError:
        return None


async def trim_streams_by_minid(cutoff_age_ms: int) -> dict[str, TrimResult]:
    """Trim each jobs stream by ``MINID ~ <now - cutoff_age_ms>``.

    PEL-safe: if any pending entry on a stream has an id older than
    the cutoff (i.e. the worker still owes an XACK on it), trimming
    is **skipped** for that stream so XAUTOCLAIM can still redeliver
    it. The MAXLEN-based approach we used previously had no such
    guard and was the silent-data-loss vector.

    Callers (typically ``scheduler.trim_streams``) should pass
    ``cutoff_age_ms`` ≥ ``2 * XAUTOCLAIM_MIN_IDLE_MS`` so a single
    failed redelivery cycle can't race the trim.
    """
    redis = get_redis()
    now_ms = int(time.time() * 1000)
    cutoff_ms = max(0, now_ms - cutoff_age_ms)

    out: dict[str, TrimResult] = {}
    for cfg in ALL_STREAMS:
        try:
            pending = await redis.xpending(cfg.stream, cfg.group)
            # redis-py returns {'pending': N, 'min': '<id>', ...} or a
            # 4-tuple in older versions. Normalise.
            if isinstance(pending, dict):
                pending_count = int(pending.get("pending", 0) or 0)
                min_id = pending.get("min")
            else:
                pending_count = int(pending[0] or 0) if pending else 0
                min_id = pending[1] if pending and len(pending) > 1 else None

            if pending_count > 0:
                min_id_ms = _decode_msg_id_to_ms(min_id)
                if min_id_ms is not None and min_id_ms < cutoff_ms:
                    out[cfg.stream] = TrimResult(
                        stream=cfg.stream,
                        trimmed=0,
                        skipped=True,
                        reason=f"oldest_pending_age_ms={now_ms - min_id_ms}",
                    )
                    continue

            cutoff_id = f"{cutoff_ms}-0"
            trimmed = await redis.xtrim(cfg.stream, minid=cutoff_id, approximate=True)
            out[cfg.stream] = TrimResult(
                stream=cfg.stream,
                trimmed=int(trimmed or 0),
                skipped=False,
                reason=None,
            )
        except Exception as exc:
            logger.warning(
                "trim_streams.error stream=%s err=%s — skipped",
                cfg.stream, exc,
            )
            out[cfg.stream] = TrimResult(
                stream=cfg.stream, trimmed=0, skipped=True, reason=f"error: {exc}",
            )
    return out
