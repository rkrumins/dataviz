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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel, Field

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    requires,
)
from backend.app.services.permission_service import PermissionClaims
from backend.app.config import resilience
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    AssetDiscoveryCacheORM,
    DataSourcePollingConfigORM,
    ProviderAdmissionConfigORM,
    ProviderHealthWindowORM,
    ProviderORM,
    WorkspaceDataSourceORM,
)
from backend.common.interfaces.provider import ProviderConfigurationError
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
    last_attempt_at: Optional[str] = None,
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
            # When a refresh was last ATTEMPTED, and how long ago. Distinct from
            # ``updated_at``, which only moves when an attempt produced a payload:
            # a provider that has been failing for days keeps honestly-old counts,
            # and these two fields together are what let the UI say so instead of
            # leaving the reader to guess whether anything is still running.
            "last_attempt_at": last_attempt_at,
            "attempt_age_secs": _age_seconds(_parse_iso(last_attempt_at)),
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


async def _effective_deadline(
    session: AsyncSession, provider_id: str, asset_name: str
) -> int:
    """How stale this row may get before the sweep should have refreshed it.

    The owning data source's configured ``interval_seconds`` when it has one,
    else the global sweep cadence — the same resolution
    ``scheduler._discovery_deadline`` makes, kept here rather than imported so
    the web tier does not pull the worker module into a request path.

    Only called for a row already classified stale, so the fresh path pays
    nothing for it.
    """
    row = (await session.execute(
        select(DataSourcePollingConfigORM.interval_seconds,
               DataSourcePollingConfigORM.is_enabled)
        .join(
            WorkspaceDataSourceORM,
            WorkspaceDataSourceORM.id
            == DataSourcePollingConfigORM.data_source_id,
        )
        .where(
            WorkspaceDataSourceORM.provider_id == provider_id,
            WorkspaceDataSourceORM.graph_name == asset_name,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
        .limit(1)
    )).first()
    if row is not None and row[1] and row[0]:
        return max(int(row[0]), resilience.DISCOVERY_TICK_INTERVAL_SECS)
    return resilience.DISCOVERY_REFRESH_INTERVAL_SECS


async def _maybe_heal_overdue(
    session: AsyncSession,
    provider_id: str,
    asset_name: str,
    cache_row: AssetDiscoveryCacheORM,
) -> bool:
    """Enqueue ONE background refresh for a row the sweep has stopped reaching.

    Reads must not generate unbounded provider work — the removed
    enqueue-on-read produced a discovery job per visible row on every 5s poll,
    and that constraint stands. Three things keep this bounded:

    * It measures the last ATTEMPT, not the last successful payload. A provider
      that is being retried and refusing is never piled on; this fires only when
      nothing has even tried in ``DISCOVERY_READ_HEAL_FACTOR`` of the row's own
      deadlines, which means the sweep is not reaching it at all.
    * A per-scope ``SET NX`` cooldown caps it at one job per scope per cycle,
      however many viewers or polls there are.
    * It rides the background sweep lane, not the hot lane, so it can never
      queue ahead of someone actually clicking Refresh.

    Never raises: a Redis blip degrades to "no repair", not a failed read.
    """
    factor = resilience.DISCOVERY_READ_HEAL_FACTOR
    if factor <= 0:
        return False
    # Fall back to computed_at for rows written before last_attempt_at existed.
    attempted = _parse_iso(cache_row.last_attempt_at) or _parse_iso(
        cache_row.computed_at
    )
    age = _age_seconds(attempted)
    if age is None:
        return False
    deadline = await _effective_deadline(session, provider_id, asset_name)
    if age < deadline * factor:
        return False

    from backend.app.services.aggregation.redis_client import get_redis

    key = f"insights:discovery:readheal:{provider_id}:{asset_name}"
    try:
        won = await get_redis().set(
            key, "1", nx=True, ex=max(300, min(3600, deadline)),
        )
    except Exception as exc:
        logger.debug(
            "discovery read-heal: cooldown check failed for %s:%s (%s) — skipping",
            provider_id, asset_name, exc,
        )
        return False
    if not won:
        return False
    # Deliberately NOT the hot lane, and deliberately no compensating release
    # if the enqueue is dedup-skipped: a job genuinely being in flight is the
    # outcome we wanted, and losing one cycle to a race is correct.
    job_id = await enqueue_discovery_job_safe(provider_id, asset_name)
    if job_id is not None:
        logger.info(
            "discovery.read_heal provider=%s asset=%s attempt_age_secs=%d "
            "deadline_secs=%d — sweep has not reached this row; enqueued one "
            "background refresh",
            provider_id, asset_name, age, deadline,
        )
    return job_id is not None


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
            last_attempt_at=cache_row.last_attempt_at,
        )

    if cache_row is not None and tier == "stale":
        # Serve the cache verbatim. Refresh ownership belongs to the background
        # sweep and the explicit /refresh endpoints — the old enqueue-on-read
        # here meant merely RENDERING an asset list manufactured one discovery
        # job per visible row, on every provider flick and every 5s poll, and
        # that must not come back. ``_maybe_heal_overdue`` is the one bounded
        # exception: it fires only when nothing has ATTEMPTED this row in
        # several of its own deadlines (i.e. the sweep is not reaching it), and
        # a per-scope cooldown caps it at one job per cycle regardless of how
        # many readers there are. See its docstring.
        try:
            payload = json.loads(cache_row.payload)
        except (TypeError, ValueError):
            payload = None
        healed = await _maybe_heal_overdue(
            session, provider_id, asset_name, cache_row,
        )
        return _build_envelope(
            payload=payload,
            status="stale",
            source="cache",
            provider_id=provider_id,
            asset_name=asset_name,
            updated_at=updated_at,
            age_secs=age,
            refreshing=healed or await _refresh_in_flight(provider_id, asset_name),
            # No job_id/poll_url: this is background repair, not work the reader
            # asked for, and the UI must not start a job-polling loop over it.
            job_id=None,
            provider_health=health,
            last_error=cache_row.last_error,
            last_attempt_at=cache_row.last_attempt_at,
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
        last_attempt_at=cache_row.last_attempt_at if cache_row else None,
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


# ── Orphan graphs (operator cleanup) ────────────────────────────────
#
# Background index DDL used to resurrect any graph deleted out of band —
# FalkorDB has no CREATE GRAPH, so CREATE INDEX on a missing key minted it
# empty. That is fixed at the source; these two endpoints deal with the
# phantoms it already left behind. Read the module docstring in
# ``services/orphan_graphs.py`` before changing either: the asymmetry between
# leaking a graph and destroying one is the whole design.


class OrphanCleanupRequest(BaseModel):
    """What to drop, and whether to actually do it.

    ``names`` is required and has no "everything you found" form: the server
    never decides which graphs to delete. ``dry_run`` defaults to ON, so the
    destructive call is the one you have to ask for twice.
    """

    names: List[str] = Field(..., min_length=1)
    dry_run: bool = True


@router.get("/providers/{provider_id}/orphan-graphs")
async def list_orphan_graphs(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Every graph key on this provider, with a verdict on each.

    Read-only. Protected keys are listed too — a preview that showed only the
    deletable ones would be asking the operator to trust a filter they cannot
    see.
    """
    from backend.app.services import orphan_graphs

    await _ensure_provider_exists(session, provider_id)
    try:
        candidates = await orphan_graphs.scan_orphan_graphs(provider_id)
    except ProviderConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        # A reference set we could not read is indistinguishable from an empty
        # one at the point where it matters, so this fails loud rather than
        # reporting graphs as unreferenced.
        logger.warning(
            "orphan scan failed for provider %s: %s", provider_id, exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot verify which graphs are referenced — refusing to report "
                f"any as orphaned. ({type(exc).__name__}: {exc})"
            ),
        )
    return {
        "provider_id": provider_id,
        "keys_total": len(candidates),
        "deletable": sum(1 for c in candidates if c.deletable),
        "candidates": [c.to_dict() for c in candidates],
    }


@router.post("/providers/{provider_id}/orphan-graphs/cleanup")
async def cleanup_orphan_graphs(
    provider_id: str = Path(...),
    body: OrphanCleanupRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Drop the named graphs, if they are still empty and unreferenced.

    Re-verifies every name at delete time rather than trusting the preview: a
    graph can be registered, or filled, between looking and deciding. A name
    that is no longer deletable comes back with its protection verdict and is
    left alone; one refusal never aborts the rest.
    """
    from backend.app.services import orphan_graphs

    await _ensure_provider_exists(session, provider_id)
    try:
        results = await orphan_graphs.delete_orphan_graphs(
            provider_id, body.names, dry_run=body.dry_run,
        )
    except ProviderConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.warning(
            "orphan cleanup failed for provider %s: %s", provider_id, exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot verify which graphs are referenced — refusing to delete "
                f"anything. ({type(exc).__name__}: {exc})"
            ),
        )
    return {
        "provider_id": provider_id,
        "dry_run": body.dry_run,
        "deleted": sum(1 for r in results if r.verdict == "dropped"),
        "results": [r.to_dict() for r in results],
    }


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
    limit: int = Query(50, ge=1, le=500),
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
    # ``interval_secs`` above is the loop's TICK. This is the deadline a cached
    # row inherits when it has no data source, or none with a configured
    # interval; a registered source uses its own ``interval_seconds`` instead,
    # so no single number describes the whole fleet any more.
    default_interval_secs: Optional[int] = None
    seen: Optional[int] = None
    due: Optional[int] = None


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
