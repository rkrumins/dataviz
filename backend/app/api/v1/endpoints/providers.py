"""
Admin Provider endpoints — CRUD for physical database server registrations.
Providers are pure infrastructure: host/port/credentials, no graph or ontology.
"""
import asyncio
import json
import time
from datetime import datetime, timezone
from typing import List, Tuple
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import (
    get_db_session,
    get_provider_probe_db_session,
    get_provider_probe_session,
    with_short_session,
)
from backend.app.auth.dependencies import requires, get_permission_claims
from backend.app.db.repositories import provider_repo
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
from backend.app.providers.reachability import resolve_provider_status
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.workspace_visibility import compute_visible_provider_ids
from backend.common.interfaces.provider import ProviderFeature, capability_for
from backend.common.models.management import (
    ProviderCreateRequest,
    ProviderUpdateRequest,
    ProviderResponse,
    ConnectionTestResult,
    ProviderImpactResponse,
    ProviderTypeCapabilities,
    ProviderTypeConnectionShape,
    ProviderTypeField,
    ProviderTypeInfo,
    SchemaDiscoveryRequest,
)
from backend.common.providers.catalog import PROVIDER_CATALOG, ProviderRequestError, descriptor_for

router = APIRouter()


# Phase 18 — per-endpoint gates. Reads accept any workspace-bound user
# holding ``workspace:provider:read`` (results are filtered to their
# visible providers); writes stay ``system:admin`` because provider
# rows carry credentials and credential rotation is a platform concern.
_REQUIRES_PROVIDER_READ = requires("workspace:provider:read", workspace_any=True)
_REQUIRES_SYSTEM_ADMIN = requires("system:admin")

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
    extra_config: dict | None = None,
) -> ConnectionTestResult:
    """Bounded reachability probe used by the ``/test`` endpoint.

    P0.2: prefer ``provider.preflight(deadline_s=...)`` which does ONLY a
    fast TCP / handshake check (≤2s budget). The previous implementation
    wrapped ``get_stats()`` in a 10s timeout, but ``get_stats()`` triggered
    eager schema reconciliation in some adapters (FalkorDB ran 15
    ``CREATE INDEX`` queries with 3s timeouts each), so the 10s budget
    was measuring the wrong thing entirely — connect-time would routinely
    exceed 30s while the wait_for sat idle.

    With ``preflight()``, the probe finishes in ≤2.5s for an unreachable
    host, and ≤500ms for a reachable one.
    """
    descriptor = descriptor_for(_provider_type_value(provider_type))
    if descriptor is None:
        return ConnectionTestResult(success=False, error="provider_unsupported")

    # Each provider type owns its own probe-deadline extension (e.g.
    # FalkorDB's falkordbConnection.probeDeadlineS) — the fixed default must
    # extend, never clip, or the Test button false-fails the exact providers
    # the knob exists for.
    PREFLIGHT_DEADLINE_S = descriptor.probe_deadline_s(extra_config, 2.0)
    PROBE_WALL_CLOCK_S = PREFLIGHT_DEADLINE_S + 0.5  # + small slack
    # Sentinel/Cluster resolution (discover master / slot map) needs more
    # than the fast single-host preflight budget.
    PROBE_FULL_CONNECT_S = max(8.0, PREFLIGHT_DEADLINE_S)

    instance = provider_registry._create_provider_instance(
        _provider_type_value(provider_type),
        host,
        port,
        None,
        tls_enabled,
        creds,
        extra_config=extra_config,
    )

    # For FalkorDB Sentinel/Cluster topologies, a single host/port preflight
    # is not representative (host/port may be unset; routing is driven by the
    # node lists). Exercise the real connection path instead — it resolves
    # the master / owning node and runs RETURN 1.
    use_full_connect = descriptor.probe_strategy(extra_config) == "full_connect"
    preflight = None if use_full_connect else getattr(instance, "preflight", None)

    t0 = time.monotonic()
    try:
        if use_full_connect:
            await asyncio.wait_for(
                instance._ensure_connected(), timeout=PROBE_FULL_CONNECT_S,
            )
            elapsed_ms = (time.monotonic() - t0) * 1000
            return ConnectionTestResult(success=True, latencyMs=round(elapsed_ms, 1))

        if callable(preflight):
            # Outer wait_for is a backstop — preflight is contractually
            # bounded by deadline_s, but cap the wall clock anyway.
            result = await asyncio.wait_for(
                preflight(deadline_s=PREFLIGHT_DEADLINE_S),
                timeout=PROBE_WALL_CLOCK_S,
            )
            elapsed_ms = (time.monotonic() - t0) * 1000
            if result.ok:
                return ConnectionTestResult(success=True, latencyMs=round(elapsed_ms, 1))
            return ConnectionTestResult(success=False, error=result.reason)

        # Fallback for adapters that haven't grown a preflight() yet.
        # Use the same tight budget so we don't regress the bug we just fixed.
        await asyncio.wait_for(instance.get_stats(), timeout=PROBE_WALL_CLOCK_S)
        latency = (time.monotonic() - t0) * 1000
        return ConnectionTestResult(success=True, latencyMs=round(latency, 1))
    except asyncio.TimeoutError:
        _budget = PROBE_FULL_CONNECT_S if use_full_connect else PROBE_WALL_CLOCK_S
        return ConnectionTestResult(
            success=False,
            error=f"Connection timed out after {_budget:.1f}s",
        )
    except Exception as exc:
        return ConnectionTestResult(success=False, error=str(exc))
    finally:
        # Best-effort cleanup so a stale instance does not pin sockets.
        close = getattr(instance, "close", None)
        if callable(close):
            try:
                await asyncio.wait_for(close(), timeout=0.5)
            except Exception:
                pass


@router.get("/status")
async def list_provider_statuses(
    session: AsyncSession = Depends(get_provider_probe_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_PROVIDER_READ),
):
    """Return provider readiness — STRICT structural decoupling from
    provider state.

    This endpoint is polled continuously by the FE status banner and
    admin pages. The handler does ONLY:

      1. List registered providers from the PROVIDER_PROBE pool.
      2. Read in-memory breaker state (``provider_manager`` cache).
      3. Read background-warmup cache (``app.state.provider_warmup_cache``).
      4. Merge; return immediately.

    There is NO outbound work, NO provider construction, NO sockets
    opened. A registered provider host being DNS-unresolvable / TLS-
    broken / hung has zero effect on the response time of this endpoint
    — the request handler can never block on it.

    Provider state is OBSERVED OFFLINE by:
      - The background warmup loop (``backend/app/providers/warmup.py``),
        which probes each provider via ``preflight()`` in round-robin
        and updates the cache. Default cycle: ≥30s, ≤1.5s per probe.
      - Real traffic to the provider, which trips the per-instance
        circuit breaker on network failures. The breaker state is
        authoritative when present (it reflects actual user-observed
        truth); the warmup cache is the fallback for un-visited
        providers.

    With this contract, hosting 1 or 100 providers — any number of them
    unreachable — never affects the request path.
    """
    providers = await provider_repo.list_providers(session)
    if not providers:
        return []

    # Phase 18: filter to the providers this caller can see. Platform
    # admins (system:admin / org-admin) get the unfiltered list.
    visible_ids = await compute_visible_provider_ids(session, claims)
    if visible_ids is not None:
        providers = [p for p in providers if p.id in visible_ids]
        if not providers:
            return []

    # Read in-memory state — both calls are O(1).
    try:
        breaker_states = provider_registry.report_provider_states()
    except Exception:
        breaker_states = {}
    warmup_cache = getattr(provider_registry, "warmup_cache", {}) or {}

    def _resolve_status(provider) -> dict:
        # Status decision is shared with the blank-model provisioning gate
        # (``resolve_provider_status``) so the /status endpoint and the "can I
        # build here?" check can never disagree. The endpoint layer only adds
        # the display fields (name, lastCheckedAt).
        status, error = resolve_provider_status(
            is_active=provider.is_active,
            provider_id=provider.id,
            breaker_states=breaker_states,
            warmup_cache=warmup_cache,
        )
        # lastCheckedAt: a breaker verdict was just observed → now; a warmup-only
        # verdict carries its own timestamp; unknown/inactive has none.
        last_checked = None
        if status != "unknown":
            warmup = warmup_cache.get(provider.id)
            breaker_key_match = next(
                (k for k in breaker_states if k.startswith(f"{provider.id}:")), None)
            if breaker_key_match and breaker_states.get(breaker_key_match):
                last_checked = _iso_now()
            elif warmup is not None:
                last_checked = _iso_timestamp(warmup.get("checked_at"))
        out = {
            "id": provider.id,
            "name": provider.name,
            "status": status,
            "lastCheckedAt": last_checked,
        }
        if error:
            out["error"] = error
        return out

    return [_resolve_status(p) for p in providers]


def _provider_type_field_info(f) -> ProviderTypeField:
    return ProviderTypeField(
        key=f.key, label=f.label, kind=f.kind, location=f.location,
        required=f.required, secret=f.secret, default=f.default,
        placeholder=f.placeholder, help=f.help,
    )


def _provider_type_info(d) -> ProviderTypeInfo:
    conn = d.connection
    return ProviderTypeInfo(
        id=d.id,
        label=d.label,
        description=d.description,
        docs_url=d.docs_url,
        family=d.family,
        capabilities=ProviderTypeCapabilities(
            writable=d.capability.writable,
            full_crud=d.capability.full_crud,
            is_external=d.capability.is_external,
            supports_copy=d.capability.supports_copy,
            # Sorted: `features` is a frozenset, and str-Enum hashing is
            # randomized per-process (PYTHONHASHSEED) — an unsorted dump
            # would make this response, and the fixture generated from it,
            # non-deterministic across separate process runs.
            features=sorted(f.value for f in d.capability.features),
        ),
        connection_shape=ProviderTypeConnectionShape(
            kind=conn.kind,
            uses_host_port=conn.uses_host_port,
            default_port=conn.default_port,
            tls=conn.tls,
            auth=conn.auth,
            database_field=(
                _provider_type_field_info(conn.database_field)
                if conn.database_field else None
            ),
            fields=[_provider_type_field_info(f) for f in conn.fields],
            secret_credential_keys=list(conn.secret_credential_keys),
            extra_config_keys=list(conn.extra_config_keys),
        ),
        admin_visible=d.admin_visible,
    )


@router.get("/types", response_model=List[ProviderTypeInfo])
async def list_provider_types(
    _auth=Depends(_REQUIRES_PROVIDER_READ),
):
    """Provider-type metadata for the catalog: capabilities, connection
    shape, family. MUST be declared before ``GET /{provider_id}`` — FastAPI
    matches routes in declaration order, so declared later this would
    resolve as ``provider_id="types"`` and 404.

    Pure and zero I/O: reads ``PROVIDER_CATALOG``, touches no database and
    no provider. This is non-secret metadata (no credentials, no live
    connection state) — the view-wizard's scope step and other non-admin
    surfaces render these labels, so the gate is the read permission, not
    ``system:admin``.
    """
    return [
        _provider_type_info(d)
        for d in sorted(PROVIDER_CATALOG.values(), key=lambda d: d.id)
        if d.admin_visible
    ]


def _iso_timestamp(epoch_seconds: float | None) -> str | None:
    if epoch_seconds is None:
        return None
    try:
        return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


@router.get("", response_model=List[ProviderResponse])
async def list_providers(
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_PROVIDER_READ),
):
    """List providers visible to the caller.

    Platform admins see every registered provider. Workspace-bound
    users see only providers referenced by a data source in one of
    their workspaces OR explicitly bound via ``permitted_workspaces``.
    Provider credentials are NEVER returned (the response DTO strips
    them).
    """
    providers = await provider_repo.list_providers(session)
    visible_ids = await compute_visible_provider_ids(session, claims)
    if visible_ids is None:
        return providers
    return [p for p in providers if p.id in visible_ids]


def _require_descriptor_or_422(provider_type):
    """Resolve the catalog descriptor for ``provider_type`` or raise the
    structured 422 the frontend's ``friendlyError`` already understands.

    In practice every value ``ProviderCreateRequest.provider_type`` can hold
    is a registered catalog type (the enum and the catalog are kept in sync
    by ``test_provider_catalog_sync.py``) — this guards the one path where a
    type can legitimately be unregistered: an existing row whose stored
    ``provider_type`` is a ``LEGACY_DB_ONLY_TYPES`` value like ``"mock"``.
    """
    ptype = _provider_type_value(provider_type)
    descriptor = descriptor_for(ptype)
    if descriptor is None:
        raise HTTPException(
            status_code=422,
            detail={
                "type": "provider_unsupported",
                "providerType": ptype,
                "message": f"Provider type {ptype!r} is not supported.",
            },
        )
    return descriptor


def _validate_or_422(descriptor, req) -> None:
    """Run the descriptor's structural validation (e.g. Spanner's host/port
    rejection); translate a failure into the 422 shape shared by
    ``/test-connection`` and ``create_provider``."""
    try:
        descriptor.validate(req)
    except ProviderRequestError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "type": "provider_config_invalid",
                "providerType": _provider_type_value(req.provider_type),
                "message": str(exc),
            },
        )


@router.post("/test-connection", response_model=ConnectionTestResult)
async def test_unsaved_provider_connection(
    req: ProviderCreateRequest = Body(...),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
):
    """Test connectivity for a SUBMITTED (unsaved) provider config.

    The counterpart of ``/{provider_id}/test`` (which probes the saved row):
    this probes exactly the payload it is given, nothing is persisted. It is
    the correct target for create forms AND for edit forms validating a
    pending change before saving.
    """
    descriptor = _require_descriptor_or_422(req.provider_type)
    _validate_or_422(descriptor, req)
    creds = req.credentials.model_dump() if req.credentials else None
    return await _run_connectivity_probe(
        provider_type=req.provider_type,
        host=req.host,
        port=req.port,
        tls_enabled=req.tls_enabled,
        creds=creds,
        extra_config=req.extra_config,
    )


@router.post("", response_model=ProviderResponse, status_code=201)
async def create_provider(
    req: ProviderCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
):
    """Register a new provider (database server)."""
    descriptor = _require_descriptor_or_422(req.provider_type)
    _validate_or_422(descriptor, req)
    return await provider_repo.create_provider(session, req)


@router.post("/discover-schema")
async def discover_schema_unsaved(
    req: SchemaDiscoveryRequest = Body(...),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
):
    """Introspect an asset's schema for an UNSAVED provider payload.

    The onboarding wizard used to create a throwaway provider row, discover
    its schema, then delete the row — a write to satisfy a read. This
    probes the submitted payload directly; nothing is persisted. Declared
    alongside ``/test-connection``, before ``/{provider_id}``, mirroring
    that endpoint's unsaved-payload relationship to ``/{provider_id}/test``.
    """
    provider_req = req.provider
    descriptor = _require_descriptor_or_422(provider_req.provider_type)
    _validate_or_422(descriptor, provider_req)
    ptype = _provider_type_value(provider_req.provider_type)
    if not descriptor.capability.supports(ProviderFeature.SCHEMA_DISCOVERY):
        raise HTTPException(
            status_code=422,
            detail={
                "type": "provider_unsupported",
                "providerType": ptype,
                "message": f"{ptype} providers do not support schema discovery.",
            },
        )
    creds = provider_req.credentials.model_dump() if provider_req.credentials else None
    instance = provider_registry._create_provider_instance(
        ptype,
        provider_req.host,
        provider_req.port,
        req.asset_name,
        provider_req.tls_enabled,
        creds,
        extra_config=provider_req.extra_config,
    )
    try:
        return await asyncio.wait_for(instance.discover_schema(), timeout=15)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Provider timed out while discovering schema")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        close = getattr(instance, "close", None)
        if callable(close):
            try:
                await asyncio.wait_for(close(), timeout=0.5)
            except Exception:
                pass


@router.get("/{provider_id}", response_model=ProviderResponse)
async def get_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_PROVIDER_READ),
):
    """Get a single provider, 404 if not visible to the caller."""
    prov = await provider_repo.get_provider(session, provider_id)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    # Phase 18: hide providers the caller's workspaces don't touch
    # behind a 404 (don't leak existence).
    visible_ids = await compute_visible_provider_ids(session, claims)
    if visible_ids is not None and provider_id not in visible_ids:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    return prov


def _effective_provider_identity(prov) -> tuple:
    """The provider's node-identity mapping as the resolver will see it: the
    columns, falling back to the legacy ``extra_config.schemaMapping``."""
    if prov is None:
        return (None, None)
    from backend.app.services.node_identity import provider_identity_from_extra_config

    legacy_identity, legacy_name = provider_identity_from_extra_config(prov)
    return (
        getattr(prov, "identity_property", None) or legacy_identity,
        getattr(prov, "name_property", None) or legacy_name,
    )


@router.put("/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: str = Path(...),
    req: ProviderUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
):
    """Update a provider. Evicts any cached provider instances."""
    from backend.app.services.node_identity import (
        invalidate_node_identity, provider_identity_from_extra_config,
        scopes_resolving_through,
    )
    from backend.app.db.models import ProviderORM

    old_prov = await session.get(ProviderORM, provider_id)
    # Compare the EFFECTIVE provider-level mapping, which folds in the legacy
    # extra_config.schemaMapping — editing that JSON re-resolves every source on
    # this provider just as surely as editing the column does.
    old_identity = _effective_provider_identity(old_prov)

    prov = await provider_repo.update_provider(session, provider_id, req)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    await provider_registry.evict_provider(provider_id)

    new_prov = await session.get(ProviderORM, provider_id)
    if old_identity != _effective_provider_identity(new_prov):
        # Every source on this provider that doesn't override the mapping now
        # resolves differently — mark them stale so the UI prompts a re-run.
        await invalidate_node_identity(
            session,
            await scopes_resolving_through(session, provider_id=provider_id),
            "provider_identity_changed",
        )
    return prov


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
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
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_PROVIDER_READ),
):
    """Calculate the blast radius of deleting a provider."""
    visible_ids = await compute_visible_provider_ids(session, claims)
    if visible_ids is not None and provider_id not in visible_ids:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    # Ensure provider exists first
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    
    return await provider_repo.get_provider_impact(session, provider_id)


@router.post("/{provider_id}/test", response_model=ConnectionTestResult)
async def test_provider(
    provider_id: str = Path(...),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
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

    Probes the SAVED row — always the configuration as last persisted. A
    pending (unsaved) edit is NOT visible here: to validate a candidate
    config before saving, POST the full payload to ``/test-connection``
    instead. Edit forms must use that endpoint, or their 'Test' button
    silently tests the stale saved state.

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
    # 1. Short DB read on the PROVIDER_PROBE pool — close the session
    #    before the outbound preflight (P0.5: probe traffic isolated from
    #    WEB pool, so a status-page refresh storm cannot starve request
    #    handlers).
    async with get_provider_probe_session() as session:
        prov_row = await provider_repo.get_provider_orm(session, provider_id)
        if not prov_row:
            raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
        fingerprint = str(prov_row.updated_at or "")
        ptype = prov_row.provider_type
        host = prov_row.host
        port = prov_row.port
        tls = prov_row.tls_enabled
        # extra_config carries falkordbConnection (topology); pass it so the
        # probe tests Sentinel/Cluster routing, not just a single host/port.
        try:
            extra_config = json.loads(prov_row.extra_config) if prov_row.extra_config else None
        except (ValueError, TypeError):
            extra_config = None
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
            extra_config=extra_config,
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
            # Mark the exception as retrieved so asyncio doesn't log
            # ``Future exception was never retrieved`` when no caller is
            # awaiting (common when the originating /test request was
            # cancelled mid-flight by the upstream timeout).
            try:
                future.exception()
            except Exception:
                pass


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
        # extra_config carries the connection topology (falkordbConnection: mode +
        # sentinel/cluster nodes). Dropping it built a STANDALONE client for a
        # Sentinel/Cluster provider — the sibling /test endpoint always passed it,
        # so the two paths had drifted.
        try:
            extra = json.loads(prov_row.extra_config) if prov_row.extra_config else None
        except Exception:
            extra = None
    return provider_registry._create_provider_instance(
        ptype, host, port, asset_name, tls, creds, extra,
    )


# ── Cache-only discovery endpoints moved to endpoints/insights.py ─────
# ``GET /admin/providers/{id}/assets`` and
# ``GET /admin/providers/{id}/assets/{name}/stats`` were synchronous
# live calls into the upstream provider with a 10s timeout. For large
# providers (50+ graphs) and slow upstreams they'd 504 under load. The
# replacements live at ``/admin/insights/providers/{id}/assets[/...]``
# and read only from ``asset_discovery_cache``; cache-miss enqueues a
# background discovery job. See backend/app/api/v1/endpoints/insights.py.


@router.post("/{provider_id}/discover-schema")
async def discover_schema(
    provider_id: str = Path(...),
    asset_name: str = Body(None, embed=True),
    _auth=Depends(_REQUIRES_SYSTEM_ADMIN),
):
    """Introspect an asset's schema. Short-session pattern."""
    async with with_short_session() as session:
        prov_row = await provider_repo.get_provider_orm(session, provider_id)
        if not prov_row:
            raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
        ptype = prov_row.provider_type
    if not capability_for(ptype).supports(ProviderFeature.SCHEMA_DISCOVERY):
        raise HTTPException(
            status_code=422,
            detail={
                "type": "provider_unsupported",
                "providerType": ptype,
                "message": f"{ptype} providers do not support schema discovery.",
            },
        )
    instance = await _load_provider_for_outbound(provider_id, asset_name)
    try:
        schema = await asyncio.wait_for(instance.discover_schema(), timeout=15)
        return schema
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Provider timed out while discovering schema")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

