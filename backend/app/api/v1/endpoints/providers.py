"""
Admin Provider endpoints — CRUD for physical database server registrations.
Providers are pure infrastructure: host/port/credentials, no graph or ontology.
"""
import asyncio
import time
from datetime import datetime, timezone
from typing import List, Tuple
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session, with_short_session
from backend.app.db.repositories import provider_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    ProviderCreateRequest,
    ProviderUpdateRequest,
    ProviderResponse,
    ConnectionTestResult,
    AssetListResponse,
    ProviderImpactResponse,
    PhysicalGraphStatsResponse,
)

router = APIRouter()

# ── Provider test cache + in-flight dedup ──────────────────────────
# Reason: multiple hook instances may mount simultaneously and each kick
# off an initial probe sweep. The cache collapses duplicate simultaneous
# probes to the last real result, and the in-flight map collapses
# concurrent probes to a single awaitable. Keyed on
# (provider_id, provider.updated_at) so any credential or host change
# instantly invalidates stale entries without explicit eviction.
#
# TTL kept tight (10s) because an explicit user click on "Test" wants
# the current truth, not stale state. The old 60s TTL was written for a
# frontend stampede that ``useProviderHealthSweep`` already bounds
# (concurrency=3 + one-sweep-per-mount), so the longer window was
# vestigial and produced the "service is down but UI still says healthy"
# UX for up to a minute on both failure AND recovery transitions.
# Callers that want to force-bypass the cache (manual user click, post-
# edit revalidation, etc.) pass ``?fresh=true``.
_TEST_CACHE_TTL_SECS: float = 10.0
_test_cache: dict[str, Tuple[float, str, ConnectionTestResult]] = {}
_test_inflight: dict[str, "asyncio.Future[ConnectionTestResult]"] = {}

# ── /status bounded fan-out ─────────────────────────────────────────
# Resilience mandate: N providers should never mean N concurrent driver
# instantiations + N concurrent DB session opens. Cap concurrency so the
# management-DB pool (20 + 10 overflow) stays drained even when the
# operator has dozens of providers registered.
_STATUS_PROBE_CONCURRENCY: int = 5
_STATUS_PROBE_TIMEOUT_SECS: float = 1.5
_STATUS_OVERALL_TIMEOUT_SECS: float = 6.0


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _breaker_open_error(provider_id: str) -> str | None:
    """Inspect the registry's cached proxies for any open circuit breakers
    on *provider_id*. Returns a user-facing reason string when the breaker
    is tripped; otherwise ``None``.

    Replaces the hand-rolled negative cache — the pybreaker state machine
    inside each :class:`CircuitBreakerProxy` is the authoritative source of
    "recently failed" and is race-free under concurrency.
    """
    for cache_key, proxy in list(provider_registry._providers.items()):
        if cache_key[0] != provider_id:
            continue
        state = getattr(proxy, "breaker_state", None)
        if state != "open":
            continue
        breaker = getattr(proxy, "breaker", None)
        reset_timeout = int(getattr(breaker, "reset_timeout", 30)) if breaker else 30
        return f"Provider circuit open. Will probe downstream again in ~{reset_timeout}s."
    return None


def _provider_type_value(provider_type) -> str:
    return provider_type.value if hasattr(provider_type, "value") else str(provider_type)


async def _run_connectivity_probe(
    *,
    provider_type,
    host: str | None,
    port: int | None,
    tls_enabled: bool,
    creds: dict | None,
) -> ConnectionTestResult:
    instance = provider_registry._create_provider_instance(
        _provider_type_value(provider_type),
        host,
        port,
        None,
        tls_enabled,
        creds,
    )
    try:
        t0 = time.monotonic()
        await asyncio.wait_for(instance.get_stats(), timeout=10)
        latency = (time.monotonic() - t0) * 1000
        return ConnectionTestResult(success=True, latencyMs=round(latency, 1))
    except asyncio.TimeoutError:
        return ConnectionTestResult(success=False, error="Connection timed out after 10s")
    except Exception as exc:
        return ConnectionTestResult(success=False, error=str(exc))


@router.get("/status")
async def list_provider_statuses(
    session: AsyncSession = Depends(get_db_session),
):
    """Return provider readiness without affecting overall app health.

    Resilience: bounded fan-out so one hung provider cannot stall the
    whole response or exhaust the DB pool when many providers exist.

    * ``_STATUS_PROBE_CONCURRENCY`` probes run at once (DB-pool-friendly)
    * Each probe is capped at ``_STATUS_PROBE_TIMEOUT_SECS``
    * Overall wall-clock capped at ``_STATUS_OVERALL_TIMEOUT_SECS`` —
      probes still pending beyond that are reported as ``unknown`` with
      a note (never blocks the UI, never 5xx)
    """
    providers = await provider_repo.list_providers(session)
    if not providers:
        return []

    sem = asyncio.Semaphore(_STATUS_PROBE_CONCURRENCY)

    async def _probe(provider) -> dict:
        # Fast path: if the registry already has an open breaker for this
        # provider, don't probe — report unavailable and let the breaker's
        # reset_timeout gate the next real attempt. No network I/O, no
        # semaphore slot consumed beyond the context entry.
        breaker_error = _breaker_open_error(provider.id)
        if breaker_error:
            return {
                "id": provider.id,
                "name": provider.name,
                "status": "unavailable",
                "lastCheckedAt": _iso_now(),
                "error": breaker_error,
            }

        if not provider.is_active:
            return {
                "id": provider.id,
                "name": provider.name,
                "status": "unknown",
                "lastCheckedAt": None,
            }

        async with sem:
            try:
                instance = await _load_provider_for_outbound(provider.id, None)
                await asyncio.wait_for(
                    instance.get_stats(), timeout=_STATUS_PROBE_TIMEOUT_SECS,
                )
                return {
                    "id": provider.id,
                    "name": provider.name,
                    "status": "ready",
                    "lastCheckedAt": _iso_now(),
                }
            except Exception as exc:
                # Breaker state on cached proxies is updated automatically when
                # they're used from the main request path. This probe uses a
                # raw instance (short-session pattern), so failures here don't
                # update a breaker — but they also don't need to: the main
                # request path will observe and trip the breaker on real
                # traffic.
                return {
                    "id": provider.id,
                    "name": provider.name,
                    "status": "unavailable",
                    "lastCheckedAt": _iso_now(),
                    "error": str(exc)[:200],
                }

    tasks = [asyncio.create_task(_probe(p)) for p in providers]
    done, pending = await asyncio.wait(tasks, timeout=_STATUS_OVERALL_TIMEOUT_SECS)

    results: list[dict] = []
    for task in done:
        try:
            results.append(task.result())
        except Exception:
            continue

    # Probes that exceeded the overall wall clock — surface each as
    # ``unknown`` so the UI can distinguish "we know it's broken" from
    # "we don't know yet" and the user doesn't see a hung response.
    for i, task in enumerate(tasks):
        if task in pending:
            task.cancel()
            p = providers[i]
            results.append({
                "id": p.id,
                "name": p.name,
                "status": "unknown",
                "lastCheckedAt": _iso_now(),
                "error": (
                    f"Probe exceeded {_STATUS_OVERALL_TIMEOUT_SECS:.0f}s wall clock"
                ),
            })
    return results


@router.get("", response_model=List[ProviderResponse])
async def list_providers(
    session: AsyncSession = Depends(get_db_session),
):
    """List all registered providers."""
    return await provider_repo.list_providers(session)


@router.post("/test-connection", response_model=ConnectionTestResult)
async def test_unsaved_provider_connection(
    req: ProviderCreateRequest = Body(...),
):
    creds = req.credentials.model_dump() if req.credentials else None
    return await _run_connectivity_probe(
        provider_type=req.provider_type,
        host=req.host,
        port=req.port,
        tls_enabled=req.tls_enabled,
        creds=creds,
    )


@router.post("", response_model=ProviderResponse, status_code=201)
async def create_provider(
    req: ProviderCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Register a new provider (database server)."""
    return await provider_repo.create_provider(session, req)


@router.get("/{provider_id}", response_model=ProviderResponse)
async def get_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single provider."""
    prov = await provider_repo.get_provider(session, provider_id)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    return prov


@router.put("/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: str = Path(...),
    req: ProviderUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a provider. Evicts any cached provider instances."""
    prov = await provider_repo.update_provider(session, provider_id, req)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    await provider_registry.evict_provider(provider_id)
    return prov


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a provider. Rejects if workspaces still reference it."""
    if await provider_repo.has_workspaces(session, provider_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete provider: one or more workspaces still reference it.",
        )
    deleted = await provider_repo.delete_provider(session, provider_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    await provider_registry.evict_provider(provider_id)


@router.get("/{provider_id}/impact", response_model=ProviderImpactResponse)
async def get_provider_impact(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Calculate the blast radius of deleting a provider."""
    # Ensure provider exists first
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    
    return await provider_repo.get_provider_impact(session, provider_id)


@router.post("/{provider_id}/test", response_model=ConnectionTestResult)
async def test_provider(
    provider_id: str = Path(...),
    fresh: bool = Query(
        False,
        description=(
            "Bypass the 10s cached result and run a fresh probe. Set by "
            "the UI on manual 'Test' button clicks so the user sees the "
            "current truth (not a stale cached success/failure)."
        ),
    ),
):
    """Test connectivity to a registered provider.

    Phase 2.5 §2.5.2 — short-session pattern: open a session only long
    enough to fetch the provider row + credentials, close it, then
    perform the (potentially slow) outbound call WITHOUT holding a DB
    connection. Keeps the pool drained even when many providers are
    being probed against unreachable hosts.

    Caches the last result for 10s keyed on the provider's updated_at
    (config change → instant invalidation). Concurrent probes of the
    same provider collapse onto a single in-flight awaitable. ``fresh``
    bypasses the cache read *and* write so a dead/recovered transition
    is reflected immediately on the next user click.
    """
    # 1. Short DB read — close the session before the outbound call.
    async with with_short_session() as session:
        prov_row = await provider_repo.get_provider_orm(session, provider_id)
        if not prov_row:
            raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
        fingerprint = str(prov_row.updated_at or "")
        ptype = prov_row.provider_type
        host = prov_row.host
        port = prov_row.port
        tls = prov_row.tls_enabled
        creds = await provider_repo.get_credentials(session, provider_id)
    # 2. Cache + in-flight dedup — pure in-memory, no DB. Explicit user
    #    clicks (fresh=True) bypass entirely and also invalidate the
    #    cache entry so subsequent background polls see the new truth.
    if fresh:
        _test_cache.pop(provider_id, None)
    else:
        cached = _test_cache.get(provider_id)
        if cached is not None:
            cached_at, cached_fp, cached_result = cached
            if cached_fp == fingerprint and (time.monotonic() - cached_at) < _TEST_CACHE_TTL_SECS:
                return cached_result

        existing = _test_inflight.get(provider_id)
        if existing is not None:
            return await existing

    loop = asyncio.get_running_loop()
    future: "asyncio.Future[ConnectionTestResult]" = loop.create_future()
    if not fresh:
        _test_inflight[provider_id] = future
    try:
        # 3. Outbound provider call — no DB session held during this window.
        result = await _run_connectivity_probe(
            provider_type=ptype,
            host=host,
            port=port,
            tls_enabled=tls,
            creds=creds,
        )

        # Always write the freshest result so any in-flight callers and
        # subsequent cached reads reflect current truth — including the
        # fresh=True path, which updates the cache for future non-fresh
        # callers rather than skipping the write.
        _test_cache[provider_id] = (time.monotonic(), fingerprint, result)
        if not future.done():
            future.set_result(result)
        return result
    finally:
        _test_inflight.pop(provider_id, None)
        if not future.done():
            # Guard: if an uncaught exception ever bubbles, don't leave
            # awaiters hanging forever.
            future.set_exception(RuntimeError("Provider test aborted"))


async def _load_provider_for_outbound(provider_id: str, asset_name: str | None):
    """Short-session helper: fetch the row + creds, snapshot fields, close session.

    Centralises the Phase 2.5 §2.5.2 pattern shared by every endpoint
    below this comment. Returns a ready-to-instantiate provider object.
    """
    async with with_short_session() as session:
        prov_row = await provider_repo.get_provider_orm(session, provider_id)
        if not prov_row:
            raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
        creds = await provider_repo.get_credentials(session, provider_id)
        ptype, host, port, tls = (
            prov_row.provider_type, prov_row.host, prov_row.port, prov_row.tls_enabled,
        )
    return provider_registry._create_provider_instance(ptype, host, port, asset_name, tls, creds)


@router.get("/{provider_id}/assets", response_model=AssetListResponse)
async def list_assets(provider_id: str = Path(...)):
    """List available assets on this provider. Short-session pattern."""
    instance = await _load_provider_for_outbound(provider_id, None)
    try:
        graphs = await asyncio.wait_for(instance.list_graphs(), timeout=10)
        return AssetListResponse(assets=graphs)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Provider timed out while listing assets")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{provider_id}/assets/{asset_name}/stats", response_model=PhysicalGraphStatsResponse)
async def get_asset_stats(
    provider_id: str = Path(...),
    asset_name: str = Path(...),
):
    """Get raw physical metadata (node/edge counts). Short-session pattern."""
    instance = await _load_provider_for_outbound(provider_id, asset_name)
    try:
        raw = await asyncio.wait_for(instance.get_stats(), timeout=10)
        return PhysicalGraphStatsResponse(
            nodeCount=raw.get("node_count", raw.get("nodeCount", 0)),
            edgeCount=raw.get("edge_count", raw.get("edgeCount", 0)),
            entityTypeCounts=raw.get("entity_type_counts", raw.get("entityTypeCounts", {})),
            edgeTypeCounts=raw.get("edge_type_counts", raw.get("edgeTypeCounts", {})),
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Provider timed out while fetching asset stats")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{provider_id}/discover-schema")
async def discover_schema(
    provider_id: str = Path(...),
    asset_name: str = Body(None, embed=True),
):
    """Introspect an asset's schema. Short-session pattern."""
    instance = await _load_provider_for_outbound(provider_id, asset_name)
    try:
        schema = await asyncio.wait_for(instance.discover_schema(), timeout=15)
        return schema
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Provider timed out while discovering schema")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

