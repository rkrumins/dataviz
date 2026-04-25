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
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel, Field

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
    """fresh | stale | expired"""
    if age_secs is None:
        return "expired"
    if age_secs <= resilience.STATS_CACHE_FRESH_SECS:
        return "fresh"
    if age_secs >= resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS:
        return "expired"
    return "stale"


def _ttl_seconds(age_secs: Optional[int]) -> Optional[int]:
    if age_secs is None:
        return None
    return max(0, resilience.STATS_CACHE_FRESH_SECS - age_secs)


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
        # Hot path. No enqueue.
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
            refreshing=False,
            job_id=None,
            provider_health=health,
            last_error=cache_row.last_error,
        )

    # stale or expired or missing — kick a refresh job.
    job_id = await enqueue_discovery_job_safe(provider_id, asset_name)

    if cache_row is not None and tier == "stale":
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
            refreshing=True,
            job_id=job_id,
            provider_health=health,
            last_error=cache_row.last_error,
        )

    # No usable cache. ``status=computing`` when a job is in flight, or
    # ``unavailable`` when Redis is down (job_id == None and no row).
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
    """
    await _ensure_provider_exists(session, provider_id)
    return await _build_response(
        session=session, provider_id=provider_id, asset_name="",
    )


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


# ── Per-provider admission control config ───────────────────────────

class AdmissionConfigBody(BaseModel):
    """Tunable knobs read by the insights worker before each provider call."""

    bucket_capacity: int = Field(8, ge=1, le=200)
    refill_per_sec: int = Field(2, ge=1, le=100)
    circuit_fail_max: int = Field(5, ge=1, le=50)
    circuit_window_secs: int = Field(30, ge=5, le=600)
    half_open_after_secs: int = Field(60, ge=5, le=600)


class AdmissionConfigResponse(AdmissionConfigBody):
    provider_id: str
    updated_at: str | None = None
    # Snapshot of the rolling-window counters so the admin UI can show
    # "current health" alongside the tuning fields without a second call.
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0


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
            circuit_fail_max=cfg_row.circuit_fail_max,
            circuit_window_secs=cfg_row.circuit_window_secs,
            half_open_after_secs=cfg_row.half_open_after_secs,
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
        existing = ProviderAdmissionConfigORM(
            provider_id=provider_id,
            bucket_capacity=body.bucket_capacity,
            refill_per_sec=body.refill_per_sec,
            circuit_fail_max=body.circuit_fail_max,
            circuit_window_secs=body.circuit_window_secs,
            half_open_after_secs=body.half_open_after_secs,
            updated_at=now_iso,
        )
        session.add(existing)
    else:
        existing.bucket_capacity = body.bucket_capacity
        existing.refill_per_sec = body.refill_per_sec
        existing.circuit_fail_max = body.circuit_fail_max
        existing.circuit_window_secs = body.circuit_window_secs
        existing.half_open_after_secs = body.half_open_after_secs
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
