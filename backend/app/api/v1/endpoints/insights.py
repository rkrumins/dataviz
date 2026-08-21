"""Insights API — cache-only reads for pre-registration discovery.

Both endpoints below are **cache-only**: the web tier never calls a
provider here. Cache-miss enqueues a ``discovery`` job into the
insights service and returns a 200 with ``meta.status="computing"`` so
the frontend can render a placeholder + ETA chip without waiting on
provider IO.

Universal envelope shape::

    {
      "data": <payload | null>,
      "meta": {
        "status": "fresh" | "stale" | "computing" | "unavailable",
        "source": "cache" | "none",
        "updated_at": "<ISO timestamp>" | null,
        "staleness_secs": int | null,
        "ttl_seconds": int | null,
        "refreshing": bool,
        "job_id": "<stream id>" | null,
        "poll_url": "/api/v1/admin/insights/jobs/<id>" | null,
        "provider_health": "ok" | "degraded" | "down" | "unknown",
        "last_error": str | null,
        "provider_id": str,
        "asset_name": str,
      }
    }

Status semantics:
* ``fresh``      — payload is within ``STATS_CACHE_FRESH_SECS`` of cache write.
* ``stale``      — past freshness threshold but within absolute expiry; a
                   refresh job has been enqueued.
* ``computing``  — no cache row, or row past absolute expiry; a job has
                   been enqueued.
* ``unavailable``— no cache row AND Redis enqueue failed; the frontend
                   should show a "background refresh paused" affordance.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel, Field

from backend.app.auth.dependencies import requires
from backend.app.config import resilience
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    AssetDiscoveryCacheORM,
    ProviderAdmissionConfigORM,
    ProviderHealthWindowORM,
    ProviderORM,
)
from backend.insights_service.admission import invalidate_config as invalidate_admission_cache
from backend.insights_service.enqueue import enqueue_discovery_job_safe
from backend.insights_service.redis_streams import DISCOVERY_STREAM, claim_exists

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Envelope helpers ────────────────────────────────────────────────

def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _age_seconds(ts: Optional[datetime]) -> Optional[int]:
    if not ts:
        return None
    return max(0, int((datetime.now(timezone.utc) - ts).total_seconds()))


def _classify_freshness(age_secs: Optional[int]) -> str:
    """fresh | stale | expired.

    The fresh window is the background sweep cadence
    (``DISCOVERY_CACHE_FRESH_SECS``) — a row younger than the next
    scheduled sweep is by definition as fresh as this system produces.
    """
    if age_secs is None:
        return "expired"
    if age_secs <= resilience.DISCOVERY_CACHE_FRESH_SECS:
        return "fresh"
    if age_secs >= resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS:
        return "expired"
    return "stale"


def _ttl_seconds(age_secs: Optional[int]) -> Optional[int]:
    if age_secs is None:
        return None
    return max(0, resilience.DISCOVERY_CACHE_FRESH_SECS - age_secs)


async def _provider_health(
    session: AsyncSession, provider_id: str
) -> str:
    """Return ``ok`` / ``degraded`` / ``down`` / ``unknown`` based on
    the rolling-window counters maintained by the insights worker.

    Threshold heuristic (matches Phase 1 plan): success rate < 0.5 over
    the most recent window classifies as ``down``; consecutive failures
    >= 3 with at least one recent success classifies as ``degraded``.
    """
    row = await session.get(ProviderHealthWindowORM, provider_id)
    if row is None:
        return "unknown"
    total = (row.success_count or 0) + (row.failure_count or 0)
    if total == 0:
        return "unknown"
    success_rate = (row.success_count or 0) / total
    if success_rate < 0.5:
        return "down"
    if (row.consecutive_failures or 0) >= 3:
        return "degraded"
    return "ok"


def _build_envelope(
    *,
    payload: Any,
    status: str,
    source: str,
    provider_id: str,
    asset_name: str,
    updated_at: Optional[datetime],
    age_secs: Optional[int],
    refreshing: bool,
    job_id: Optional[str],
    provider_health: str,
    last_error: Optional[str],
) -> dict:
    return {
        "data": payload,
        "meta": {
            "status": status,
            "source": source,
            "provider_id": provider_id,
            "asset_name": asset_name,
            "updated_at": updated_at.isoformat() if updated_at else None,
            "staleness_secs": age_secs,
            "ttl_seconds": _ttl_seconds(age_secs),
            "refreshing": refreshing,
            "job_id": job_id,
            "poll_url": (
                f"/api/v1/admin/insights/jobs/{job_id}" if job_id else None
            ),
            "provider_health": provider_health,
            "last_error": last_error,
        },
    }


async def _read_cache(
    session: AsyncSession, provider_id: str, asset_name: str
) -> Optional[AssetDiscoveryCacheORM]:
    return await session.get(AssetDiscoveryCacheORM, (provider_id, asset_name))


async def _refresh_in_flight(provider_id: str, asset_name: str) -> bool:
    """True while a discovery job for this exact scope is pending — the
    dedup claim doubles as the honest progress signal. Reads stay pure
    (no enqueue); the UI polls while this is true and stops when the
    completed job releases the claim. Redis down → False (no signal is
    better than a stuck spinner)."""
    try:
        return await claim_exists(
            f"{provider_id}:{asset_name}", stream=DISCOVERY_STREAM,
        )
    except Exception:
        return False


async def _ensure_provider_exists(
    session: AsyncSession, provider_id: str
) -> None:
    row = await session.execute(
        select(ProviderORM.id).where(ProviderORM.id == provider_id)
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=404, detail=f"Provider '{provider_id}' not found"
        )


async def _build_response(
    *,
    session: AsyncSession,
    provider_id: str,
    asset_name: str,
) -> dict:
    """Cache-only read shared by both endpoints. Triggers a refresh on
    miss / stale / expired and returns the universal envelope."""
    cache_row = await _read_cache(session, provider_id, asset_name)
    health = await _provider_health(session, provider_id)

    updated_at = _parse_iso(cache_row.computed_at) if cache_row else None
    age = _age_seconds(updated_at)
    tier = _classify_freshness(age)

    if cache_row is not None and tier == "fresh":
        # Hot path. No enqueue. ``refreshing`` reflects whether a job
        # for this scope is genuinely in flight (a user-forced refresh
        # or the background sweep) so the UI can spin-and-poll until
        # the new figures land.
        try:
            payload = json.loads(cache_row.payload)
        except (TypeError, ValueError):
            payload = None
        return _build_envelope(
            payload=payload,
            status="fresh",
            source="cache",
            provider_id=provider_id,
            asset_name=asset_name,
            updated_at=updated_at,
            age_secs=age,
            refreshing=await _refresh_in_flight(provider_id, asset_name),
            job_id=None,
            provider_health=health,
            last_error=cache_row.last_error,
        )

    if cache_row is not None and tier == "stale":
        # Serve the cache verbatim — NO enqueue side effect. Reads must
        # never generate provider work: refresh ownership belongs to the
        # background sweep and the explicit /refresh endpoints. (The old
        # enqueue-on-read here meant merely RENDERING an asset list
        # manufactured one discovery job per visible row, on every
        # provider flick and every 5s poll.)
        try:
            payload = json.loads(cache_row.payload)
        except (TypeError, ValueError):
            payload = None
        return _build_envelope(
            payload=payload,
            status="stale",
            source="cache",
            provider_id=provider_id,
            asset_name=asset_name,
            updated_at=updated_at,
            age_secs=age,
            refreshing=await _refresh_in_flight(provider_id, asset_name),
            job_id=None,
            provider_health=health,
            last_error=cache_row.last_error,
        )

    # No usable cache (true miss or past absolute expiry) — kick ONE
    # refresh so the first-ever view self-heals. Priority: a user is
    # looking at this right now, so it rides the hot lane instead of
    # queueing behind the background sweep. ``status=computing`` when a
    # job is in flight, or ``unavailable`` when Redis is down.
    job_id = await enqueue_discovery_job_safe(provider_id, asset_name, priority=True)
    status = "computing" if job_id is not None else "unavailable"
    return _build_envelope(
        payload=None,
        status=status,
        source="none",
        provider_id=provider_id,
        asset_name=asset_name,
        updated_at=updated_at,
        age_secs=age,
        refreshing=job_id is not None,
        job_id=job_id,
        provider_health=health,
        last_error=cache_row.last_error if cache_row else None,
    )


# ── Endpoints ───────────────────────────────────────────────────────

@router.get("/providers/{provider_id}/assets")
async def list_assets(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Cache-only list of physical assets for a provider.

    Replaces the live short-session call at
    ``/admin/providers/{id}/assets`` (legacy, providers.py:401-411). The
    web tier never hits the upstream provider here; an insights worker
    refreshes ``asset_discovery_cache`` on a separate process.

    ``data.assetsDetail`` carries the cached per-asset summaries
    (counts + freshness) in ONE bulk read so the UI can sort and
    paginate the whole list without a per-row stats request each.
    """
    await _ensure_provider_exists(session, provider_id)
    env = await _build_response(
        session=session, provider_id=provider_id, asset_name="",
    )

    if env.get("data") is not None:
        rows = await session.execute(
            select(
                AssetDiscoveryCacheORM.asset_name,
                AssetDiscoveryCacheORM.payload,
                AssetDiscoveryCacheORM.computed_at,
            ).where(
                AssetDiscoveryCacheORM.provider_id == provider_id,
                AssetDiscoveryCacheORM.asset_name != "",
            )
        )
        detail = []
        for name, payload_raw, computed_at in rows.all():
            try:
                p = json.loads(payload_raw) if payload_raw else {}
            except (TypeError, ValueError):
                p = {}
            detail.append({
                "name": name,
                "nodeCount": p.get("nodeCount"),
                "edgeCount": p.get("edgeCount"),
                "updatedAt": computed_at,
            })
        env["data"]["assetsDetail"] = detail

    return env


@router.get("/providers/{provider_id}/assets/{asset_name}/stats")
async def get_asset_stats(
    provider_id: str = Path(...),
    asset_name: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Cache-only per-asset node/edge counts.

    Replaces the live short-session call at
    ``/admin/providers/{id}/assets/{name}/stats`` (legacy,
    providers.py:414-432).
    """
    await _ensure_provider_exists(session, provider_id)
    return await _build_response(
        session=session, provider_id=provider_id, asset_name=asset_name,
    )


# ── On-demand refresh (user-driven escape hatch) ────────────────────
#
# The background ``run_discovery_scheduler`` keeps the cache warm on a
# configured cadence (``DISCOVERY_REFRESH_INTERVAL_SECS``). These
# endpoints are the manual override: the user clicks "Refresh now" in
# the UI, we drop the dedup claim and force-enqueue. Idempotent at
# the cache level (UPSERT into ``asset_discovery_cache``).


@router.post(
    "/providers/{provider_id}/assets/{asset_name}/refresh",
    status_code=202,
)
async def refresh_asset(
    provider_id: str = Path(...),
    asset_name: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Force-refresh one asset's stats. Releases any in-flight dedup
    claim and re-enqueues a discovery job. Returns 202 with the new
    Redis stream message id (or ``status="redis_unavailable"`` if the
    enqueue failed because Redis is down)."""
    from backend.insights_service.enqueue import enqueue_discovery_job_force

    await _ensure_provider_exists(session, provider_id)
    job_id = await enqueue_discovery_job_force(provider_id, asset_name)
    return {
        "provider_id": provider_id,
        "asset_name": asset_name,
        "job_id": job_id,
        "status": "queued" if job_id else "redis_unavailable",
    }


class ProviderRefreshRequest(BaseModel):
    """Optional scope for the provider-level refresh. ``asset_names``
    limits the per-asset fan-out to the rows the user is actually
    looking at; ``None`` keeps the legacy refresh-everything behavior."""

    asset_names: Optional[list[str]] = None


@router.post(
    "/providers/{provider_id}/assets/refresh",
    status_code=202,
)
async def refresh_all_assets(
    provider_id: str = Path(...),
    body: Optional[ProviderRefreshRequest] = None,
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Force-refresh a provider's asset list + a scoped set of assets.

    Always enqueues the list-all sentinel (the only way to discover
    new/removed assets). Per-asset fan-out is scoped to
    ``body.asset_names`` when provided (intersected with cached rows so
    arbitrary names can't seed stub cache entries), else every cached
    row. Capped at ``INSIGHTS_MAX_PROVIDER_REFRESH`` (env, default 200)
    and enqueued concurrently so the POST returns in one Redis
    round-trip's time, not N.
    """
    import asyncio

    from backend.insights_service.enqueue import enqueue_discovery_job_force

    await _ensure_provider_exists(session, provider_id)

    # Pull every cached asset_name for this provider, capped.
    rows = await session.execute(
        select(AssetDiscoveryCacheORM.asset_name)
        .where(AssetDiscoveryCacheORM.provider_id == provider_id)
        .limit(resilience.INSIGHTS_MAX_PROVIDER_REFRESH)
    )
    cached_names = [row[0] for row in rows.all() if row[0]]

    requested = body.asset_names if body is not None else None
    if requested is not None:
        wanted = set(requested)
        asset_names = [n for n in cached_names if n in wanted]
    else:
        asset_names = cached_names
    asset_names = asset_names[: resilience.INSIGHTS_MAX_PROVIDER_REFRESH]

    # Bound the fan-out: enqueues are cheap Redis hops, but the endpoint
    # holds one WEB session for the whole gather, so an unbounded ~200-wide
    # burst is avoided in favour of a bounded microbatch.
    sem = asyncio.Semaphore(max(1, resilience.INSIGHTS_REFRESH_ENQUEUE_CONCURRENCY))

    async def _enqueue_one(name: str) -> Optional[str]:
        async with sem:
            return await enqueue_discovery_job_force(provider_id, name)

    list_job_id = await enqueue_discovery_job_force(provider_id, "")
    asset_job_ids = list(
        await asyncio.gather(*(_enqueue_one(n) for n in asset_names))
    )

    return {
        "provider_id": provider_id,
        "jobs_queued": int(list_job_id is not None)
        + sum(1 for j in asset_job_ids if j is not None),
        "list_job_id": list_job_id,
        "asset_job_ids": asset_job_ids,
        "truncated": len(asset_names) >= resilience.INSIGHTS_MAX_PROVIDER_REFRESH,
    }


# ── Job status (poll target for `useInsightsJob`) ────────────────────

@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str = Path(...)) -> dict:
    """Lightweight progress endpoint for an enqueued insights job.

    Returns ``{job_id, status, kind?}`` where ``status`` is one of:

    * ``running``   — message is still in any insights stream's PEL.
    * ``completed`` — no PEL entry; either the worker ACKed it or the
                      message never existed (we can't distinguish from
                      Redis state alone, and the frontend doesn't need
                      to — both mean "stop polling, refetch the data
                      endpoint to read the latest cache row").

    The frontend's ``useInsightsJob`` hook flips to "completed" then
    re-fetches the original data URL; the cache will contain the
    fresh row by then because the worker writes before XACK.
    """
    from backend.app.services.aggregation.redis_client import get_redis
    from backend.insights_service.redis_streams import ALL_STREAMS

    redis = get_redis()
    for stream_cfg in ALL_STREAMS:
        try:
            pending = await redis.xpending_range(
                stream_cfg.stream, stream_cfg.group,
                min=job_id, max=job_id, count=1,
            )
        except Exception as exc:
            # Redis unavailable — surface "unknown" so the frontend can
            # show a softer error rather than infinite-poll.
            logger.warning(
                "insights.job_status redis_unavailable job_id=%s stream=%s err=%s",
                job_id, stream_cfg.stream, exc,
            )
            return {"job_id": job_id, "status": "unknown"}
        if pending:
            return {
                "job_id": job_id,
                "status": "running",
                "kind": stream_cfg.kind,
            }
    return {"job_id": job_id, "status": "completed"}


# ── Dead-letter queue admin ─────────────────────────────────────────

@router.get("/dlq")
async def list_dlq(
    cursor: str = "-",
    limit: int = 50,
) -> dict:
    """Paginated list of DLQ entries.

    ``cursor`` defaults to ``"-"`` for the first page; pass back the
    ``next_cursor`` value to fetch subsequent pages. ``limit`` is
    capped at 200 to keep responses bounded.
    """
    from backend.insights_service.redis_streams import list_dlq_entries

    capped_limit = max(1, min(int(limit), 200))
    entries, next_cursor = await list_dlq_entries(cursor=cursor, limit=capped_limit)
    return {
        "entries": [
            {
                "msg_id": e.msg_id,
                "kind": e.kind,
                "original_stream": e.original_stream,
                "original_msg_id": e.original_msg_id,
                "reason": e.reason,
                "redrive_count": e.redrive_count,
                "ts_ms": e.ts_ms,
                "fields": e.fields,
            }
            for e in entries
        ],
        "next_cursor": next_cursor,
    }


@router.post("/dlq/{msg_id}/redrive")
async def redrive_dlq(msg_id: str = Path(...)) -> dict:
    """Re-deliver a DLQ entry to its original stream.

    Status mapping:
      * 404 — DLQ entry not found (already redriven or deleted)
      * 422 — entry's ``original_stream`` is not in the known-streams allowlist
      * 409 — redrive limit exceeded (operator must investigate root cause)
      * 200 — redrive succeeded, returns new message id and updated counter
    """
    from backend.insights_service.redis_streams import (
        DLQEntryNotFound,
        InvalidOriginalStream,
        RedriveLimitExceeded,
        redrive_dlq_entry,
    )

    try:
        result = await redrive_dlq_entry(msg_id)
    except DLQEntryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except InvalidOriginalStream as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except RedriveLimitExceeded as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    return {
        "redriven_msg_id": result.redriven_msg_id,
        "original_stream": result.original_stream,
        "redrive_count": result.redrive_count,
    }


@router.delete("/dlq/{msg_id}", status_code=204)
async def delete_dlq(msg_id: str = Path(...)) -> None:
    """Drop a single DLQ entry. Idempotent: returns 204 whether or not
    the entry existed."""
    from backend.insights_service.redis_streams import delete_dlq_entry

    await delete_dlq_entry(msg_id)
    return None


# ── Per-provider admission control config ───────────────────────────

class AdmissionConfigBody(BaseModel):
    """Tunable knobs read by the insights worker before each provider call.

    Circuit-breaker knobs (``circuit_fail_max``, ``circuit_window_secs``,
    ``half_open_after_secs``) were removed when the in-memory circuit
    was deleted in favour of the provider-proxy circuit. The DB columns
    still exist (PR-A safety: rollback to old code requires them);
    PR B's Alembic drops them.
    """

    bucket_capacity: int = Field(8, ge=1, le=200)
    refill_per_sec: int = Field(2, ge=1, le=100)


class AdmissionConfigResponse(AdmissionConfigBody):
    provider_id: str
    updated_at: str | None = None
    # Snapshot of the rolling-window counters so the admin UI can show
    # "current health" alongside the tuning fields without a second call.
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    # Most recent provider-call duration (ms) recorded by the worker.
    # Single value, not a real percentile — see admission.record_latency.
    last_call_duration_ms: int | None = None


@router.get(
    "/admission/{provider_id}", response_model=AdmissionConfigResponse,
)
async def get_admission_config(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
) -> AdmissionConfigResponse:
    """Return the current admission knobs + rolling-window health for a
    provider. Falls back to module defaults when no config row exists."""
    await _ensure_provider_exists(session, provider_id)

    cfg_row = await session.get(ProviderAdmissionConfigORM, provider_id)
    health_row = await session.get(ProviderHealthWindowORM, provider_id)

    if cfg_row is not None:
        body = AdmissionConfigBody(
            bucket_capacity=cfg_row.bucket_capacity,
            refill_per_sec=cfg_row.refill_per_sec,
        )
        updated_at = cfg_row.updated_at
    else:
        body = AdmissionConfigBody()
        updated_at = None

    return AdmissionConfigResponse(
        provider_id=provider_id,
        updated_at=updated_at,
        success_count=(health_row.success_count or 0) if health_row else 0,
        failure_count=(health_row.failure_count or 0) if health_row else 0,
        consecutive_failures=(
            (health_row.consecutive_failures or 0) if health_row else 0
        ),
        # ``last_p99_ms`` column reused for last-call duration (ms).
        # Renamed in PR B's Alembic to ``last_call_duration_ms``.
        last_call_duration_ms=(
            health_row.last_p99_ms if health_row else None
        ),
        **body.model_dump(),
    )


@router.put(
    "/admission/{provider_id}", response_model=AdmissionConfigResponse,
)
async def put_admission_config(
    provider_id: str = Path(...),
    body: AdmissionConfigBody = ...,  # type: ignore[assignment]
    session: AsyncSession = Depends(get_db_session),
) -> AdmissionConfigResponse:
    """Upsert the admission knobs for a provider. Workers re-read on
    next acquire because we invalidate the in-process config cache."""
    await _ensure_provider_exists(session, provider_id)

    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await session.get(ProviderAdmissionConfigORM, provider_id)
    if existing is None:
        # Insert with NOT-NULL defaults from the ORM column definitions
        # (5 / 30 / 60). PR A doesn't read or expose these; PR B drops
        # the columns. This INSERT path is the only place that has to
        # know they exist while the columns remain in the schema.
        existing = ProviderAdmissionConfigORM(
            provider_id=provider_id,
            bucket_capacity=body.bucket_capacity,
            refill_per_sec=body.refill_per_sec,
            updated_at=now_iso,
        )
        session.add(existing)
    else:
        existing.bucket_capacity = body.bucket_capacity
        existing.refill_per_sec = body.refill_per_sec
        existing.updated_at = now_iso
    await session.commit()

    # Drop the in-process cache so the next worker acquire re-reads
    # from the DB. Other worker replicas pick up the change within
    # one tick (defaults to ~30s) without explicit cross-process
    # invalidation; that is acceptable for tuning knobs.
    invalidate_admission_cache(provider_id)

    health_row = await session.get(ProviderHealthWindowORM, provider_id)
    return AdmissionConfigResponse(
        provider_id=provider_id,
        updated_at=now_iso,
        success_count=(health_row.success_count or 0) if health_row else 0,
        failure_count=(health_row.failure_count or 0) if health_row else 0,
        consecutive_failures=(
            (health_row.consecutive_failures or 0) if health_row else 0
        ),
        **body.model_dump(),
    )


# ── Discovery scheduler status + manual trigger ─────────────────────


class DiscoverySchedulerStatusResponse(BaseModel):
    """Snapshot of the most recent discovery-scheduler tick.

    Surfaced in the UI's RefreshControl pill ("Auto-refreshes every X
    · Last refresh Ym ago") and used by ops to verify the scheduler
    is firing on cadence. ``last_tick_at`` is ``None`` until the
    first tick completes (which happens shortly after process start
    once the bootstrap delay elapses).
    """

    last_tick_at: Optional[str] = None
    interval_secs: int
    next_tick_eta_secs: Optional[int] = None
    providers: Optional[int] = None
    list_jobs: Optional[int] = None
    asset_jobs: Optional[int] = None
    dedup_skipped: Optional[int] = None


@router.get(
    "/discovery/status",
    response_model=DiscoverySchedulerStatusResponse,
)
async def get_discovery_status() -> DiscoverySchedulerStatusResponse:
    """Read the current discovery-scheduler status.

    Reads module-level state from ``insights_service.scheduler``. In
    deployment topologies where the insights worker runs as a
    separate process, this endpoint reflects the *web-tier's* view
    of that state — which is empty (the scheduler runs in the worker
    process). For dev / single-process mode the values are live.

    Frontend uses this to render "Auto-refreshes every X · Last
    refresh Ym ago" in the RegistryAssets header.
    """
    # Lazy import: scheduler module touches DB engine at import time
    # in some test paths; keep startup-time imports minimal here.
    from backend.insights_service.scheduler import get_discovery_scheduler_status

    return DiscoverySchedulerStatusResponse(**get_discovery_scheduler_status())


@router.post("/discovery/trigger", status_code=202)
async def trigger_discovery_now() -> dict:
    """Run one discovery tick immediately.

    Useful for ops verifying scheduler wiring without waiting for the
    next cadence, or for kicking a global refresh after a bulk
    provider config change. The actual fan-out goes through the same
    SET-NX dedup as the scheduled tick — won't double-enqueue if
    workers are already processing the same scope.
    """
    from backend.insights_service.scheduler import trigger_discovery_tick_now

    summary = await trigger_discovery_tick_now()
    return {
        "status": "completed",
        "providers": summary.providers,
        "list_jobs": summary.list_jobs,
        "asset_jobs": summary.asset_jobs,
        "dedup_skipped": summary.dedup_skipped,
    }


# ── Frontend runtime config endpoint ────────────────────────────────


class InsightsConfigResponse(BaseModel):
    """Frontend-relevant subset of insights configuration.

    Read once at app mount via ``useInsightsConfig``; cached forever
    in React Query. Changing any of these values requires a backend
    restart but no frontend rebuild — the env vars live in
    ``backend.app.config.resilience``.
    """

    frontend_poll_interval_ms: int
    frontend_stale_time_ms: int
    job_poll_interval_ms: int
    job_max_retries: int
    discovery_refresh_interval_secs: int
    ui_stale_threshold_secs: int


@router.get("/config", response_model=InsightsConfigResponse)
async def get_insights_config() -> InsightsConfigResponse:
    """Return the env-driven insights config the frontend cares about.

    No auth-protected fields here — this is genuine UX tuning data,
    not secrets. Routes can mount it without role checks.
    """
    return InsightsConfigResponse(
        frontend_poll_interval_ms=resilience.INSIGHTS_FRONTEND_POLL_INTERVAL_MS,
        frontend_stale_time_ms=resilience.INSIGHTS_FRONTEND_STALE_TIME_MS,
        job_poll_interval_ms=resilience.INSIGHTS_JOB_POLL_INTERVAL_MS,
        job_max_retries=resilience.INSIGHTS_JOB_MAX_RETRIES,
        discovery_refresh_interval_secs=resilience.DISCOVERY_REFRESH_INTERVAL_SECS,
        ui_stale_threshold_secs=resilience.INSIGHTS_UI_STALE_THRESHOLD_SECS,
    )


# ── Counts history ──────────────────────────────────────────────────
#
# Unlike the discovery reads above, these are not cache-only reads of a
# volatile row — they read ``data_source_count_snapshots``, which is durable
# and append-only. Nothing here can enqueue work: the history either exists or
# has not been captured yet, and no amount of provider IO would change that.
# The envelope is kept anyway so the frontend's StatusChip, recovery and
# polling machinery work unchanged across every insights read.

_DEFAULT_HISTORY_WINDOW_DAYS = 30

# Above this many raw points a window is downsampled even when the caller
# asked for "auto". Chosen to stay well under the point count where a
# hand-rolled SVG path starts costing layout time, not for payload size.
_AUTO_RAW_POINT_BUDGET = 720

# Ceiling on correlated events returned with a window. A source under a
# thrashing loader can emit a great many; the ledger only ever shows the few
# nearest any one snapshot, so an unbounded read would be payload for nothing.
_EVENT_LIMIT = 200

# Ceiling on rows in a CSV export. High enough to cover the full retention of
# a busy source, low enough that one request cannot pin a worker.
_CSV_ROW_LIMIT = 50000


class HistoryPoint(BaseModel):
    """One observation. ``node_min``/``node_max`` are the bucket extremes and
    are populated only at hour/day grain, where a single closing value would
    otherwise hide a drop that happened and recovered inside the bucket."""

    at: str
    node_count: int
    edge_count: int
    entity_type_counts: dict
    edge_type_counts: dict
    node_delta: Optional[int] = None
    edge_delta: Optional[int] = None
    node_min: Optional[int] = None
    node_max: Optional[int] = None
    lane: str
    capture_reason: str
    #: normal | notable | severe — how far this movement sits outside what is
    #: ordinary FOR THIS SOURCE. See ``_classify_significance``.
    significance: str = "normal"


class HistoryEvent(BaseModel):
    """One `refresh_events` row inside the window.

    The snapshot says what the numbers did; this says what the platform was
    doing at that moment. Correlating them is how "an external process broke
    something" stops being a guess.
    """

    id: str
    ts: str
    origin: str
    actor: str
    scope: str
    outcome: str
    gate: Optional[str] = None
    reason: Optional[str] = None
    detail: Optional[str] = None
    job_id: Optional[str] = None
    run_id: Optional[str] = None


class LabelSeriesSummary(BaseModel):
    """One label's arc across the window, for the legend and the ledger.

    ``state`` is the reading a person wants: ``new`` and ``gone`` are the two
    that matter most, because a label appearing or disappearing is the shape a
    broken loader makes.
    """

    label: str
    first: int
    last: int
    delta: int
    state: str  # steady | grew | shrank | new | gone
    points: list


class HistoryDrop(BaseModel):
    """The largest single negative movement in the window."""

    at: str
    label: Optional[str] = None
    before: int
    after: int
    delta: int


class HistorySummary(BaseModel):
    node_first: int
    node_last: int
    node_delta: int
    node_pct_change: Optional[float] = None
    edge_first: int
    edge_last: int
    edge_delta: int
    edge_pct_change: Optional[float] = None
    snapshots: int
    changed_snapshots: int
    labels_added: list
    labels_removed: list
    largest_drop: Optional[HistoryDrop] = None
    #: The typical absolute movement for this source in this window — the
    #: median of the non-zero |delta|s. Reported so the UI can say WHY a change
    #: was called notable instead of asking the reader to trust a label.
    change_baseline: int = 0
    notable_changes: int = 0
    severe_changes: int = 0
    # Oldest snapshot held for this source at ANY age. Without it a series
    # that simply started last Tuesday is indistinguishable from one that lost
    # everything before Tuesday.
    coverage_from: Optional[str] = None
    retention_days: int


class CountHistoryPayload(BaseModel):
    data_source_id: str
    from_: str = Field(alias="from")
    to: str
    grain: str
    points: list
    labels: list
    edge_labels: list
    events: list
    summary: HistorySummary

    class Config:
        populate_by_name = True


class ProviderSeriesEntry(BaseModel):
    data_source_id: str
    name: str
    points: list


class ProviderHistoryPayload(BaseModel):
    provider_id: str
    from_: str = Field(alias="from")
    to: str
    grain: str
    #: Bucket-aligned totals across every source on the provider.
    totals: list
    sources: list
    retention_days: int

    class Config:
        populate_by_name = True


def _history_window(frm: Optional[str], to: Optional[str]) -> tuple:
    """Resolve the requested window, defaulting to the last 30 days.

    Bad input widens rather than narrows: a malformed ``from`` falls back to
    the default window instead of 400-ing, because a history view that
    refuses to render is worse than one showing a month.
    """
    now = datetime.now(timezone.utc)
    end = _parse_iso(to) or now
    start = _parse_iso(frm) or (end - timedelta(days=_DEFAULT_HISTORY_WINDOW_DAYS))
    if start > end:
        start, end = end, start
    return start.isoformat(), end.isoformat()


def _auto_grain(frm: str, to: str) -> str:
    """Pick a grain from the window width so the default view is readable
    without the caller having to reason about point counts.

    Errs toward raw: the whole value of this feature is seeing the exact
    moment something changed, and a downsample that smooths that away is a
    worse default than a slightly denser chart.
    """
    start, end = _parse_iso(frm), _parse_iso(to)
    if start is None or end is None:
        return "hour"
    hours = max(1.0, (end - start).total_seconds() / 3600.0)
    if hours <= 48:
        return "raw"
    if hours <= 24 * 14:
        return "hour"
    return "day"


def _pct_change(first: int, last: int) -> Optional[float]:
    """None rather than a fake number when the baseline is zero — a graph that
    grew from 0 to 40,000 did not grow by a percentage."""
    if not first:
        return None
    return round(((last - first) / first) * 100.0, 2)


def _label_summaries(points: list, key: str) -> list:
    """Per-label series across the window.

    A label absent from a snapshot is 0 for that point, not a gap: the probe
    lane drops zero-count buckets rather than reporting ``{"Label": 0}``, so
    absence IS zero and treating it as missing data would draw a hole where a
    deletion happened.
    """
    labels: list = []
    seen: dict = {}
    for point in points:
        for label in (point.get(key) or {}):
            seen.setdefault(label, True)
    for label in sorted(seen):
        series = [int((p.get(key) or {}).get(label, 0) or 0) for p in points]
        first, last = series[0], series[-1]
        if first == 0 and last > 0:
            state = "new"
        elif first > 0 and last == 0:
            state = "gone"
        elif last > first:
            state = "grew"
        elif last < first:
            state = "shrank"
        else:
            state = "steady"
        labels.append(LabelSeriesSummary(
            label=label, first=first, last=last, delta=last - first,
            state=state, points=series,
        ).model_dump())
    labels.sort(key=lambda item: (-abs(item["delta"]), item["label"]))
    return labels


def _largest_drop(rows: list) -> Optional[HistoryDrop]:
    """The worst single negative movement, and which label carried most of it.

    This is the answer to "when did the external process have issues" — the
    one number a person scans the page for.
    """
    worst = None
    for row in rows:
        delta = row.node_delta
        if delta is None or delta >= 0:
            continue
        if worst is None or delta < worst.node_delta:
            worst = row
    if worst is None:
        return None

    label = None
    biggest = 0
    try:
        deltas = json.loads(worst.type_deltas or "{}")
    except (TypeError, ValueError):
        deltas = {}
    nodes = deltas.get("nodes", {}) if isinstance(deltas, dict) else {}
    for name, count in (nodes.get("removed") or {}).items():
        if int(count or 0) > biggest:
            label, biggest = name, int(count or 0)
    for name, pair in (nodes.get("changed") or {}).items():
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        lost = int(pair[0] or 0) - int(pair[1] or 0)
        if lost > biggest:
            label, biggest = name, lost

    before = int(worst.node_count or 0) - int(worst.node_delta or 0)
    return HistoryDrop(
        at=worst.captured_at,
        label=label,
        before=before,
        after=int(worst.node_count or 0),
        delta=int(worst.node_delta or 0),
    )


def _history_envelope(payload: Any, *, provider_id: str, asset_name: str,
                      updated_at: Optional[datetime], has_data: bool) -> dict:
    """Envelope for a durable read.

    ``computing`` here means "capture has not produced a row for this source
    yet", not "a job is running" — there is no job to wait on, but it is the
    status the frontend already renders as a patient placeholder, and it is
    the truthful one: history will appear on its own.
    """
    return _build_envelope(
        payload=payload,
        status="fresh" if has_data else "computing",
        source="cache" if has_data else "none",
        provider_id=provider_id,
        asset_name=asset_name,
        updated_at=updated_at,
        age_secs=_age_seconds(updated_at),
        refreshing=False,
        job_id=None,
        provider_health="unknown",
        last_error=None,
    )


async def _resolve_history_scope(session: AsyncSession, ds_id: str) -> str:
    """Accept a catalog-item id where a data source id is expected.

    The per-data-source history page is routed by catalog id (``cat_…``), which
    is the identity the rest of the Data Source surface uses, while history is
    keyed on the workspace data source (``ds_…``) that observes it. Resolving
    here rather than making the page pass an extra query param is what keeps a
    bare ``/datasources/<id>/history`` link working when someone shares it.

    Two separate reads, never a JOIN: the catalog row is the provider domain's
    and the snapshots are the stats domain's, and the map says cross-domain
    references are by id only. Falls through unchanged when the id does not
    resolve — an unknown id then reports "no history yet", which is both true
    and the same answer a real-but-unobserved source gets.
    """
    from backend.app.db.models import CatalogItemORM
    from backend.app.db.repositories import stats_history_repo

    if not ds_id.startswith("cat_"):
        return ds_id
    item = await session.get(CatalogItemORM, ds_id)
    if item is None or not item.source_identifier:
        return ds_id
    resolved = await stats_history_repo.latest_data_source_for_graph(
        session, item.provider_id, item.source_identifier,
    )
    return resolved or ds_id


@router.get(
    "/data-sources/{ds_id}/history",
    summary="Historical entity counts for one data source",
)
async def get_data_source_history(
    ds_id: str = Path(..., description="Workspace data source id"),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    grain: Optional[str] = Query(None, description="raw | hour | day | auto"),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Counts over time for one data source, per label, with deltas.

    A pure read of durable snapshot rows — no provider IO, no enqueue. An
    empty result is reported as ``computing`` rather than 404: a source whose
    first snapshot has not landed yet is a normal, self-resolving state, and a
    404 would read as "this source does not exist".
    """
    from backend.app.db.repositories import stats_history_repo

    ds_id = await _resolve_history_scope(session, ds_id)
    window_from, window_to = _history_window(frm, to)
    resolved_grain = (
        _auto_grain(window_from, window_to)
        if grain in (None, "", "auto")
        else stats_history_repo.normalize_grain(grain)
    )

    rows = await stats_history_repo.list_snapshots(
        session, ds_id, frm=window_from, to=window_to, grain=resolved_grain,
    )
    # An "auto" caller asked for a readable chart, not a specific grain — so a
    # raw window that turned out denser than expected is downsampled rather
    # than shipped. An explicit grain is always honoured.
    if (
        grain in (None, "", "auto")
        and resolved_grain == "raw"
        and len(rows) > _AUTO_RAW_POINT_BUDGET
    ):
        resolved_grain = "hour"
        rows = await stats_history_repo.list_snapshots(
            session, ds_id, frm=window_from, to=window_to, grain=resolved_grain,
        )

    extremes = await stats_history_repo.bucket_extremes(
        session, ds_id, frm=window_from, to=window_to, grain=resolved_grain,
    )
    width = 13 if resolved_grain == "hour" else 10

    # The RAW rows, read once and reused for both the baseline and the drop.
    # Both have to be derived from raw even when the view is downsampled: a
    # bucket keeps one closing value, and the movement that matters is exactly
    # what averaging away a bucket destroys.
    raw_rows = (
        rows if resolved_grain == "raw"
        else await stats_history_repo.list_snapshots(
            session, ds_id, frm=window_from, to=window_to, grain="raw",
        )
    )
    baseline = stats_history_repo.change_baseline(raw_rows)

    points = []
    for row in rows:
        bucket = (row.captured_at or "")[:width] if resolved_grain != "raw" else None
        low, high = extremes.get(bucket, (None, None)) if bucket else (None, None)
        points.append(HistoryPoint(
            at=row.captured_at,
            node_count=int(row.node_count or 0),
            edge_count=int(row.edge_count or 0),
            entity_type_counts=stats_history_repo.loads_counts(row.entity_type_counts),
            edge_type_counts=stats_history_repo.loads_counts(row.edge_type_counts),
            node_delta=row.node_delta,
            edge_delta=row.edge_delta,
            node_min=low,
            node_max=high,
            lane=row.lane or "poll",
            capture_reason=row.capture_reason or "changed",
            significance=stats_history_repo.classify_significance(row.node_delta, baseline),
        ).model_dump())

    labels = _label_summaries(points, "entity_type_counts")
    edge_labels = _label_summaries(points, "edge_type_counts")
    policy = await stats_history_repo.resolve_history_policy(session)

    node_first = points[0]["node_count"] if points else 0
    node_last = points[-1]["node_count"] if points else 0
    edge_first = points[0]["edge_count"] if points else 0
    edge_last = points[-1]["edge_count"] if points else 0

    summary = HistorySummary(
        node_first=node_first,
        node_last=node_last,
        node_delta=node_last - node_first,
        node_pct_change=_pct_change(node_first, node_last),
        edge_first=edge_first,
        edge_last=edge_last,
        edge_delta=edge_last - edge_first,
        edge_pct_change=_pct_change(edge_first, edge_last),
        snapshots=len(points),
        changed_snapshots=sum(
            1 for p in points if p["capture_reason"] in ("changed", "first")
        ),
        labels_added=[l["label"] for l in labels if l["state"] == "new"],
        labels_removed=[l["label"] for l in labels if l["state"] == "gone"],
        # From the RAW rows, never the downsampled points — see above.
        largest_drop=_largest_drop(raw_rows),
        change_baseline=baseline,
        notable_changes=sum(
            1 for r in raw_rows
            if stats_history_repo.classify_significance(r.node_delta, baseline) == "notable"
        ),
        severe_changes=sum(
            1 for r in raw_rows
            if stats_history_repo.classify_significance(r.node_delta, baseline) == "severe"
        ),
        coverage_from=await stats_history_repo.oldest_captured_at(session, ds_id),
        retention_days=policy.retention_days,
    )

    # What the platform was doing during the window. Read separately and
    # returned alongside rather than joined: refresh_events belongs to the
    # aggregation domain, and the map says cross-domain references are by id.
    # The UI aligns them onto the same axis as the snapshots.
    from backend.app.db.repositories.refresh_events_repo import (
        list_refresh_events_between,
    )

    events = [
        HistoryEvent(
            id=event.id,
            ts=event.ts,
            origin=event.origin,
            actor=event.actor,
            scope=event.scope,
            outcome=event.outcome,
            gate=event.gate,
            reason=event.reason,
            detail=event.detail,
            job_id=event.job_id,
            run_id=event.run_id,
        ).model_dump()
        for event in await list_refresh_events_between(
            session, ds_id, frm=window_from, to=window_to, limit=_EVENT_LIMIT,
        )
    ]

    payload = CountHistoryPayload(
        data_source_id=ds_id,
        **{"from": window_from},
        to=window_to,
        grain=resolved_grain,
        points=points,
        labels=labels,
        edge_labels=edge_labels,
        events=events,
        summary=summary,
    ).model_dump(by_alias=True)

    return _history_envelope(
        payload,
        provider_id="",
        asset_name=ds_id,
        updated_at=_parse_iso(points[-1]["at"]) if points else None,
        has_data=bool(points),
    )


def _bucket_instant(bucket: str) -> str:
    """Turn a bucket KEY into a real instant.

    Buckets are ISO prefixes — ``2026-08-20`` for a day, ``2026-08-20T14`` for
    an hour — and the hour form is not a parseable timestamp in Python or in
    JavaScript. Emitting the key as-is left the rollup charts unable to label
    their own axis. Padding it here means every ``at`` on the wire is an
    instant, whatever produced it.
    """
    if len(bucket) == 13:
        return f"{bucket}:00:00+00:00"
    if len(bucket) == 10:
        return f"{bucket}T00:00:00+00:00"
    return bucket


def _align_rollup(rows: list, *, group: str) -> tuple:
    """Align independently-observed series onto shared buckets.

    Sources are polled on their own clocks, so at any bucket only some of them
    reported. Each series therefore CARRIES FORWARD its last known value into
    buckets it was not observed in — a source that was not polled did not drop
    to zero, and a stacked chart implying it did would invent an outage that
    never happened.

    ``group`` selects the altitude: ``source`` gives one series per data source
    (the per-provider view), ``provider`` sums each provider's sources into one
    series (the fleet view). The arithmetic is identical; only the key differs,
    which is why this is one function and not two that drift apart.

    Takes pre-bucketed :class:`RollupRow`s — the reduction happens in SQL, so
    this never sees more rows than (buckets x sources).
    """
    grid: dict = {}
    names: dict = {}
    for row in rows:
        bucket = row.bucket
        if group == "provider":
            key = row.provider_id or "unknown"
            label = row.provider_id or "Unassigned"
            # A provider's total is the sum of ITS sources, so the innermost
            # value stays keyed by data source until the sum is taken.
            slot = grid.setdefault(bucket, {}).setdefault(key, {})
            slot[row.data_source_id] = (
                int(row.node_count or 0), int(row.edge_count or 0),
            )
        else:
            key = row.data_source_id
            label = row.graph_name or row.data_source_id
            grid.setdefault(bucket, {})[key] = (
                int(row.node_count or 0), int(row.edge_count or 0),
            )
        names.setdefault(key, label)

    def _totals_of(value) -> tuple:
        if isinstance(value, dict):
            return (
                sum(v[0] for v in value.values()),
                sum(v[1] for v in value.values()),
            )
        return value

    buckets = sorted(grid)
    carried: dict = {}
    totals: list = []
    per_key: dict = {k: [] for k in names}
    for bucket in buckets:
        for key, value in grid[bucket].items():
            if group == "provider":
                carried.setdefault(key, {}).update(value)
            else:
                carried[key] = value
        resolved = {k: _totals_of(v) for k, v in carried.items()}
        totals.append({
            "at": _bucket_instant(bucket),
            "node_count": sum(v[0] for v in resolved.values()),
            "edge_count": sum(v[1] for v in resolved.values()),
            "sources": (
                sum(len(v) for v in carried.values()) if group == "provider"
                else len(carried)
            ),
        })
        for key in names:
            nodes, edges = resolved.get(key, (0, 0))
            per_key[key].append({
                "at": _bucket_instant(bucket), "node_count": nodes,
                "edge_count": edges,
            })

    series = [
        ProviderSeriesEntry(
            data_source_id=key, name=names[key], points=per_key[key],
        ).model_dump()
        for key in sorted(
            names,
            key=lambda k: -(per_key[k][-1]["node_count"] if per_key[k] else 0),
        )
    ]
    return totals, series


@router.get(
    "/providers/{provider_id}/history",
    summary="Historical entity counts across a provider's data sources",
)
async def get_provider_history(
    provider_id: str = Path(..., description="Provider id"),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    grain: Optional[str] = Query(None, description="hour | day | auto"),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """The same series rolled up across every onboarded source on a provider.

    Sources are observed at independent times, so the points are aligned onto
    shared buckets and each source's last known value is carried forward into
    buckets it was not observed in. Carrying forward is the honest choice: a
    source that was not polled in a given hour did not drop to zero, and a
    stacked chart that implied it did would invent an outage.

    ``graph_name`` is the display name rather than the data source label —
    it is denormalised onto the snapshot, so the rollup stays inside the stats
    domain and still names sources that have since been removed.
    """
    from backend.app.db.repositories import stats_history_repo

    window_from, window_to = _history_window(frm, to)
    resolved_grain = (
        _auto_grain(window_from, window_to)
        if grain in (None, "", "auto")
        else stats_history_repo.normalize_grain(grain)
    )
    # The rollup is always bucketed: raw across N sources is N interleaved
    # time axes, which no stacked chart can render honestly.
    if resolved_grain == "raw":
        resolved_grain = "hour"
    width = 13 if resolved_grain == "hour" else 10

    rows = await stats_history_repo.rollup_rows(
        session, frm=window_from, to=window_to, width=width,
        provider_id=provider_id,
    )

    totals, sources = _align_rollup(rows, group="source")
    policy = await stats_history_repo.resolve_history_policy(session)

    payload = ProviderHistoryPayload(
        provider_id=provider_id,
        **{"from": window_from},
        to=window_to,
        grain=resolved_grain,
        totals=totals,
        sources=sources,
        retention_days=policy.retention_days,
    ).model_dump(by_alias=True)

    return _history_envelope(
        payload,
        provider_id=provider_id,
        asset_name="",
        updated_at=_parse_iso(totals[-1]["at"]) if totals else None,
        has_data=bool(totals),
    )


@router.get(
    "/history/fleet",
    summary="Historical entity counts across the whole platform",
)
async def get_fleet_history(
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    grain: Optional[str] = Query(None, description="hour | day | auto"),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Total entities over time across every onboarded source, series per
    provider.

    The third altitude, above the per-source and per-provider views. It is the
    one that answers "is the platform as a whole growing, and did anything fall
    off it" — a question no per-source page can, because the interesting case
    is a source that stopped reporting entirely.

    Same carry-forward semantics as the provider rollup, for the same reason:
    a provider not observed in a bucket did not drop to zero.
    """
    from backend.app.db.repositories import stats_history_repo

    window_from, window_to = _history_window(frm, to)
    resolved_grain = (
        _auto_grain(window_from, window_to)
        if grain in (None, "", "auto")
        else stats_history_repo.normalize_grain(grain)
    )
    if resolved_grain == "raw":
        resolved_grain = "hour"
    width = 13 if resolved_grain == "hour" else 10

    rows = await stats_history_repo.rollup_rows(
        session, frm=window_from, to=window_to, width=width,
    )
    totals, providers = _align_rollup(rows, group="provider")

    # Providers are keyed by id in the snapshot rows; resolve display names in
    # one read rather than leaving the UI to render raw ids.
    names: dict = {}
    ids = [p["data_source_id"] for p in providers]
    if ids:
        rows_named = (await session.execute(
            select(ProviderORM.id, ProviderORM.name).where(ProviderORM.id.in_(ids))
        )).all()
        names = {r[0]: r[1] for r in rows_named}
    for entry in providers:
        entry["name"] = names.get(entry["data_source_id"], entry["name"])

    policy = await stats_history_repo.resolve_history_policy(session)
    payload = ProviderHistoryPayload(
        provider_id="fleet",
        **{"from": window_from},
        to=window_to,
        grain=resolved_grain,
        totals=totals,
        sources=providers,
        retention_days=policy.retention_days,
    ).model_dump(by_alias=True)

    return _history_envelope(
        payload,
        provider_id="fleet",
        asset_name="",
        updated_at=_parse_iso(totals[-1]["at"]) if totals else None,
        has_data=bool(totals),
    )


@router.get(
    "/data-sources/{ds_id}/history.csv",
    summary="Export one data source's counts history as CSV",
)
async def export_data_source_history_csv(
    ds_id: str = Path(..., description="Workspace data source or catalog id"),
    frm: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db_session),
):
    """The raw series as CSV — always raw, never downsampled.

    Downsampling is a rendering concession; an export is evidence. Someone
    pulling this into a spreadsheet for an audit needs every observation that
    was recorded, at the resolution it was recorded, not the bucket closings
    that happened to fit a chart.

    One column per label, unioned across the window, so a label that appeared
    or disappeared still has a column and its zeroes are visible rather than
    ragged. Streamed as a single string: the row cap keeps this bounded well
    inside a response, and chunking would buy nothing at this size.
    """
    import csv
    import io

    from fastapi.responses import Response

    from backend.app.db.repositories import stats_history_repo

    ds_id = await _resolve_history_scope(session, ds_id)
    window_from, window_to = _history_window(frm, to)
    rows = await stats_history_repo.list_snapshots(
        session, ds_id, frm=window_from, to=window_to,
        grain="raw", limit=_CSV_ROW_LIMIT,
    )

    labels: list = sorted({
        label
        for row in rows
        for label in stats_history_repo.loads_counts(row.entity_type_counts)
    })
    edge_labels: list = sorted({
        label
        for row in rows
        for label in stats_history_repo.loads_counts(row.edge_type_counts)
    })

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["captured_at", "lane", "capture_reason", "node_count", "edge_count",
         "node_delta", "edge_delta"]
        + [f"node:{label}" for label in labels]
        + [f"edge:{label}" for label in edge_labels]
    )
    for row in rows:
        entities = stats_history_repo.loads_counts(row.entity_type_counts)
        edges = stats_history_repo.loads_counts(row.edge_type_counts)
        writer.writerow(
            [
                row.captured_at, row.lane, row.capture_reason,
                row.node_count, row.edge_count,
                "" if row.node_delta is None else row.node_delta,
                "" if row.edge_delta is None else row.edge_delta,
            ]
            + [entities.get(label, 0) for label in labels]
            + [edges.get(label, 0) for label in edge_labels]
        )

    filename = f"history-{ds_id}-{window_from[:10]}-to-{window_to[:10]}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Counts anomaly alerts ───────────────────────────────────────────
#
# On this router, beside the history it is derived from, rather than on a
# notifications surface of its own: an alert here is a READING of the counts
# series, and the first thing anyone does with one is open that series. The
# bell is the delivery channel; this is the record.

class CountAlert(BaseModel):
    """One recorded anomaly, with the evidence frozen at judgement time."""

    id: str
    data_source_id: str
    catalog_item_id: Optional[str] = None
    workspace_id: Optional[str] = None
    provider_id: Optional[str] = None
    graph_name: Optional[str] = None
    #: When the movement happened — NOT when it was noticed. Evaluation runs
    #: on a tick, so the two differ, and ordering by the wrong one tells a
    #: confusing story.
    observed_at: str
    detected_at: str
    severity: str
    direction: str
    node_delta: int
    node_count: int
    #: What it was judged against. "Unusual" without this is a claim; with it,
    #: an argument.
    baseline: int
    evidence: Optional[dict] = None
    acknowledged_at: Optional[str] = None
    acknowledged_by: Optional[str] = None


class CountAlertsResponse(BaseModel):
    alerts: list
    open_count: int = Field(0, alias="openCount")

    class Config:
        populate_by_name = True


class AlertPolicyResponse(BaseModel):
    enabled: Optional[bool] = None
    min_severity: Optional[str] = Field(None, alias="minSeverity")
    cooldown_secs: Optional[int] = Field(None, alias="cooldownSecs")
    env_enabled: bool = Field(True, alias="envEnabled")
    env_min_severity: str = Field("severe", alias="envMinSeverity")
    env_cooldown_secs: int = Field(21600, alias="envCooldownSecs")
    effective_enabled: bool = Field(True, alias="effectiveEnabled")
    effective_min_severity: str = Field("severe", alias="effectiveMinSeverity")
    effective_cooldown_secs: int = Field(21600, alias="effectiveCooldownSecs")

    class Config:
        populate_by_name = True


class AlertPolicyRequest(BaseModel):
    """Partial update. Absent leaves a field alone; ``-1`` on the numeric
    field clears it back to the env default — same sentinel the retention
    editor uses, because absent and null are indistinguishable over JSON."""

    enabled: Optional[bool] = None
    min_severity: Optional[str] = Field(None, alias="minSeverity")
    cooldown_secs: Optional[int] = Field(None, alias="cooldownSecs", ge=-1)

    class Config:
        populate_by_name = True


def _alert_model(row) -> dict:
    evidence = None
    if row.evidence:
        try:
            evidence = json.loads(row.evidence)
        except (TypeError, ValueError):
            evidence = None
    return CountAlert(
        id=row.id,
        data_source_id=row.data_source_id,
        catalog_item_id=row.catalog_item_id,
        workspace_id=row.workspace_id,
        provider_id=row.provider_id,
        graph_name=row.graph_name,
        observed_at=row.observed_at,
        detected_at=row.detected_at,
        severity=row.severity,
        direction=row.direction,
        node_delta=int(row.node_delta or 0),
        node_count=int(row.node_count or 0),
        baseline=int(row.baseline or 0),
        evidence=evidence,
        acknowledged_at=row.acknowledged_at,
        acknowledged_by=row.acknowledged_by,
    ).model_dump()


@router.get(
    "/alerts",
    response_model=CountAlertsResponse,
    summary="Recorded counts anomalies",
)
async def list_count_alerts(
    ds_id: Optional[str] = Query(None, alias="dataSourceId"),
    open_only: bool = Query(False, alias="openOnly"),
    limit: int = Query(100, ge=1, le=500),
    session: AsyncSession = Depends(get_db_session),
) -> CountAlertsResponse:
    """Newest first, fleet-wide or scoped to one source.

    ``openCount`` counts UNACKNOWLEDGED alerts across the whole fleet, not
    just the returned page — it drives a badge, and a badge that only counted
    what happened to be on screen would under-report exactly when there is
    most to report.
    """
    from backend.app.db.repositories import count_alerts_repo

    resolved = await _resolve_history_scope(session, ds_id) if ds_id else None
    rows = await count_alerts_repo.list_alerts(
        session,
        data_source_id=resolved,
        unacknowledged_only=open_only,
        limit=limit,
    )
    open_rows = await count_alerts_repo.list_alerts(
        session, unacknowledged_only=True, limit=500,
    )
    return CountAlertsResponse(
        alerts=[_alert_model(r) for r in rows],
        openCount=len(open_rows),
    )


@router.post(
    "/alerts/{alert_id}/acknowledge",
    response_model=CountAlert,
    summary="Acknowledge one counts anomaly",
)
async def acknowledge_count_alert(
    alert_id: str = Path(...),
    user=Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Idempotent, and the first acknowledgement wins — re-acknowledging must
    not rewrite who actually looked at it."""
    from backend.app.db.repositories import count_alerts_repo

    row = await count_alerts_repo.acknowledge(
        session, alert_id, actor_id=getattr(user, "id", None),
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id!r} not found")
    await session.commit()
    return _alert_model(row)


@router.get(
    "/alerts/policy",
    response_model=AlertPolicyResponse,
    summary="Read the counts-anomaly alert policy",
)
async def get_alert_policy(
    session: AsyncSession = Depends(get_db_session),
) -> AlertPolicyResponse:
    from backend.app.db.repositories import count_alerts_repo

    policy = await count_alerts_repo.resolve_alert_policy(session)
    return AlertPolicyResponse(
        enabled=policy.persisted_enabled,
        minSeverity=policy.persisted_min_severity,
        cooldownSecs=policy.persisted_cooldown_secs,
        envEnabled=policy.env_enabled,
        envMinSeverity=policy.env_min_severity,
        envCooldownSecs=policy.env_cooldown_secs,
        effectiveEnabled=policy.enabled,
        effectiveMinSeverity=policy.min_severity,
        effectiveCooldownSecs=policy.cooldown_secs,
    )


@router.put(
    "/alerts/policy",
    response_model=AlertPolicyResponse,
    summary="Set the counts-anomaly alert policy",
)
async def put_alert_policy(
    req: AlertPolicyRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
) -> AlertPolicyResponse:
    from backend.app.db.models import PlatformSettingsORM
    from backend.app.db.repositories import count_alerts_repo

    if req.min_severity is not None and req.min_severity not in ("notable", "severe"):
        raise HTTPException(
            status_code=422,
            detail="minSeverity must be 'notable' or 'severe'",
        )

    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    if req.enabled is not None:
        row.history_alerts_enabled = req.enabled
    if req.min_severity is not None:
        row.history_alert_min_severity = req.min_severity
    if req.cooldown_secs is not None:
        row.history_alert_cooldown_secs = (
            None if req.cooldown_secs == -1 else req.cooldown_secs
        )
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.commit()

    return await get_alert_policy(session)
