import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from .api.v1.api import api_router
from .db.engine import init_db, close_db, get_async_session
from .db.seed_templates import seed_templates
from .db.repositories import user_repo
from .db.repositories.refresh_token_repo import make_refresh_store
from .middleware.request_id import RequestIdMiddleware
from .middleware.logging import StructuredLoggingMiddleware, configure_json_logging
from .middleware.security_headers import SecurityHeadersMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from .registry.provider_registry import provider_registry
from backend.auth_service.csrf import CSRFMiddleware
from backend.auth_service.providers import LocalIdentityProvider, register_provider
from backend.auth_service.service import LocalIdentityService

logger = logging.getLogger(__name__)

try:
    from redis.exceptions import ConnectionError as _RedisConnectionError
    from redis.exceptions import TimeoutError as _RedisTimeoutError
except Exception:  # pragma: no cover - redis is part of runtime deps
    _RedisConnectionError = ConnectionError
    _RedisTimeoutError = TimeoutError


# ------------------------------------------------------------------ #
# Lifespan                                                             #
# ------------------------------------------------------------------ #

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup / shutdown lifecycle."""
    configure_json_logging()

    # 1. Initialise management DB tables (idempotent — safe to run every restart)
    await init_db()

    # 2. Seed Quick Start Templates (idempotent — skips if already present)
    async with get_async_session() as session:
        await seed_templates(session)

    # 2a. Seed feature system — each seed gets its own session so a failure
    #      in one (e.g. multi-worker IntegrityError) doesn't roll back the others.
    from .db.seed_feature_registry import seed_feature_registry, seed_feature_flags, seed_feature_registry_meta  # noqa: E402
    try:
        async with get_async_session() as session:
            await seed_feature_registry(session)
    except Exception as exc:
        logger.warning("Feature registry seed warning: %s", exc)
    try:
        async with get_async_session() as session:
            await seed_feature_flags(session)
    except Exception as exc:
        logger.warning("Feature flags seed warning: %s", exc)
    try:
        async with get_async_session() as session:
            await seed_feature_registry_meta(session)
    except Exception as exc:
        logger.warning("Feature registry meta seed warning: %s", exc)

    # 2b. Seed system default ontology (idempotent — merge-not-overwrite strategy)
    try:
        from .ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from .ontology.service import LocalOntologyService
        async with get_async_session() as session:
            repo = SQLAlchemyOntologyRepository(session)
            svc = LocalOntologyService(repo)
            await svc.seed_system_defaults()
            await session.commit()
    except Exception as exc:
        logger.warning("System default ontology seed warning: %s", exc)

    # 2c. Bootstrap system admin (idempotent — skips if any user exists)
    # Always ensures at least one admin account is present.
    # Customizable via ADMIN_EMAIL / ADMIN_PASSWORD env vars; defaults provided.
    try:
        import os
        from .db.repositories import user_repo
        from .auth.password import hash_password
        admin_email = os.getenv("ADMIN_EMAIL", "admin@nexuslineage.local")
        admin_password = os.getenv("ADMIN_PASSWORD", "changeme")
        async with get_async_session() as session:
            user_count = await user_repo.count_users(session)
            if user_count == 0:
                user = await user_repo.create_user(
                    session,
                    email=admin_email,
                    password_hash=hash_password(admin_password),
                    first_name="System",
                    last_name="Admin",
                    status="active",
                )
                await user_repo.assign_role(session, user.id, "admin")
                await user_repo.create_approval(
                    session, user.id, status="approved", approved_by="system",
                )
                logger.info(
                    "System admin created: %s (change password after first login!)",
                    admin_email,
                )
    except Exception as exc:
        logger.warning("Admin bootstrap warning: %s", exc)

    # 3. Environment bootstrap is no longer auto-invoked on startup.
    #    Fresh installs go through the admin wizard; Docker quickstart /
    #    CI fixtures invoke `python -m backend.scripts.seed_default_environment`
    #    explicitly. Startup must never mutate user data.
    logger.info(
        "Startup is side-effect-free. Run "
        "`python -m backend.scripts.seed_default_environment` for dev seed; "
        "admin wizard handles production onboarding."
    )

    # 4. Wire up the auth service. The IdentityService is the single
    #    boundary every consumer crosses; today it's an in-process
    #    LocalIdentityService, tomorrow (post-extraction) a remote HTTP
    #    client implementing the same protocol.
    register_provider("local", LocalIdentityProvider())

    async def _emit_user_event(session, event_type: str, payload: dict) -> None:
        await user_repo.create_outbox_event(session, event_type=event_type, payload=payload)

    _app.state.identity_service = LocalIdentityService(
        session_factory=get_async_session,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
        outbox_emit=_emit_user_event,
    )
    logger.info("Auth service initialised (provider=local)")

    # 5. Wire up the aggregation service
    try:
        from .services.aggregation import (
            AggregationService, AggregationWorker,
            InProcessDispatcher, AggregationScheduler,
        )

        agg_worker = AggregationWorker(get_async_session, provider_registry)
        agg_dispatcher = InProcessDispatcher(agg_worker)

        # Get ontology service reference for monolith-mode resolution
        ontology_svc = None
        try:
            from .ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
            from .ontology.service import LocalOntologyService
            ontology_svc = LocalOntologyService(
                SQLAlchemyOntologyRepository(None)  # session injected per-call
            )
        except Exception:
            logger.warning("Ontology service not available for aggregation — will use DB fallback")

        agg_service = AggregationService(
            dispatcher=agg_dispatcher,
            registry=provider_registry,
            session_factory=get_async_session,
            ontology_service=ontology_svc,
        )
        agg_scheduler = AggregationScheduler(get_async_session, provider_registry)

        # Register as app state for endpoint access
        _app.state.aggregation_service = agg_service

        # Recover interrupted jobs from previous crash/restart
        recovered = await agg_service.recover_interrupted_jobs()
        if recovered:
            logger.info("Recovered %d interrupted aggregation jobs", recovered)

        # Start background scheduler
        asyncio.create_task(agg_scheduler.start())
        logger.info("Aggregation service started (scheduler active)")
    except Exception as exc:
        logger.warning("Aggregation service startup warning: %s", exc)

    logger.info("Synodic Visualization Service started")
    yield

    # Shutdown — release all provider connection pools (with timeout so a hung
    # provider doesn't block graceful shutdown indefinitely).
    try:
        await asyncio.wait_for(provider_registry.evict_all(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("Provider shutdown timed out after 5s — forcing exit")
    await close_db()
    logger.info("Synodic Visualization Service stopped")


# ------------------------------------------------------------------ #
# App                                                                  #
# ------------------------------------------------------------------ #

app = FastAPI(
    title="Synodic Visualization Service",
    description=(
        "Graph metadata, lineage, ontology, and reference model API. "
        "Supports multiple graph database connections via ProviderRegistry."
    ),
    version="0.2.0",
    lifespan=lifespan,
)

# Rate-limit 429 handler
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Global handler for management DB failures — returns structured 503 instead of
# raw 500 with stack trace, so the frontend can show a meaningful message.
from sqlalchemy.exc import OperationalError as _SAOperationalError

@app.exception_handler(_SAOperationalError)
async def _db_operational_error_handler(_request, exc):
    logger.error("Management DB unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Management database is temporarily unavailable. Please try again."},
    )

def _provider_unavailable_payload(request, exc) -> dict:
    provider_id = request.query_params.get("connectionId")
    return {
        "detail": {
            "code": "PROVIDER_UNAVAILABLE",
            "providerId": provider_id,
            "reason": str(exc),
        }
    }


async def _provider_error_handler(request, exc):
    logger.warning("Provider connectivity error on %s: %s", request.url.path, exc)
    if "/graph" in request.url.path:
        return JSONResponse(
            status_code=503,
            content=_provider_unavailable_payload(request, exc),
        )
    return JSONResponse(status_code=503, content={"detail": str(exc)})


# Primary handler for provider failures: raised by the CircuitBreakerProxy
# around every graph-provider instance. Carries a retry-after hint and a
# sanitized reason (no redis.exceptions details leak to the client). When
# the breaker is open, this handler fires in <1ms with no network I/O.
from backend.common.adapters import ProviderUnavailable as _ProviderUnavailable


@app.exception_handler(_ProviderUnavailable)
async def _provider_unavailable_handler(request, exc: _ProviderUnavailable):
    logger.warning(
        "Provider unavailable on %s: provider=%s reason=%s retry_after=%ds",
        request.url.path, exc.provider_name, exc.reason, exc.retry_after_seconds,
    )
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": str(exc.retry_after_seconds)},
        content={
            "detail": {
                "code": "PROVIDER_UNAVAILABLE",
                "providerName": exc.provider_name,
                "reason": exc.reason,
                "retryAfterSeconds": exc.retry_after_seconds,
            }
        },
    )


# Fallback handlers for raw connectivity errors that bypass the breaker
# (e.g. errors raised during provider instantiation, before the proxy is in
# place). In steady state these should be rare because every cached provider
# is breaker-wrapped.
app.add_exception_handler(ConnectionError, _provider_error_handler)
app.add_exception_handler(OSError, _provider_error_handler)
app.add_exception_handler(asyncio.TimeoutError, _provider_error_handler)
app.add_exception_handler(_RedisConnectionError, _provider_error_handler)
app.add_exception_handler(_RedisTimeoutError, _provider_error_handler)

# ------------------------------------------------------------------ #
# Timeout middleware (raw ASGI — avoids BaseHTTPMiddleware streaming   #
# issues). Wraps every HTTP request in asyncio.wait_for so a hung     #
# provider can never block a request indefinitely.                     #
# ------------------------------------------------------------------ #

class _TimeoutMiddleware:
    """ASGI middleware: abort any HTTP request exceeding *timeout* seconds."""
    def __init__(self, app, timeout: float = 30.0):
        self.app = app
        self.timeout = timeout

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        try:
            await asyncio.wait_for(
                self.app(scope, receive, send), timeout=self.timeout,
            )
        except asyncio.TimeoutError:
            response = JSONResponse(
                {"detail": "Request timed out — the graph provider may be unreachable."},
                status_code=504,
            )
            await response(scope, receive, send)

# Must be added FIRST so it wraps all other middleware.
app.add_middleware(_TimeoutMiddleware, timeout=25.0)

# ------------------------------------------------------------------ #
# Middleware (outermost → innermost order)                             #
# ------------------------------------------------------------------ #

_cors_origins_env = os.getenv("CORS_ALLOWED_ORIGINS", "")
_cors_origins = (
    [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
    if _cors_origins_env
    else ["http://localhost:3000", "http://localhost:5173"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-CSRF-Token"],
)

# GZip compression for responses > 1 KB
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Structured JSON access log + X-Process-Time header
app.add_middleware(StructuredLoggingMiddleware)

# X-Request-ID generation / propagation
app.add_middleware(RequestIdMiddleware)

# Security headers (X-Content-Type-Options, X-Frame-Options, CSP, HSTS, etc.)
app.add_middleware(SecurityHeadersMiddleware)

# CSRF double-submit. Innermost so it runs closest to the route — the
# preceding middleware (CORS, security headers) must complete first so
# that browser preflight checks succeed before we enforce the CSRF rule.
app.add_middleware(CSRFMiddleware)

# ------------------------------------------------------------------ #
# Routers                                                              #
# ------------------------------------------------------------------ #

app.include_router(api_router, prefix="/api/v1")

# Internal pool-pressure metrics (Phase 2.5 §2.5.3) — opt-in via
# INTERNAL_METRICS_ENABLED=true. Restrict at ingress in production.
from .middleware.db_metrics import router as db_metrics_router  # noqa: E402
app.include_router(db_metrics_router)


# ------------------------------------------------------------------ #
# Health endpoint                                                       #
# ------------------------------------------------------------------ #

@app.get("/health", tags=["health"])
@app.get("/api/v1/health", tags=["health"], include_in_schema=False)
async def health_check():
    """
    Management-plane health check — only the management DB is required for the
    application to be considered healthy.
    """
    from .db.engine import get_engine
    from sqlalchemy import text

    result: dict = {"status": "healthy", "version": "0.2.0", "dependencies": {}}

    # Management DB ping
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        result["dependencies"]["management_db"] = "healthy"
    except Exception as exc:
        result["dependencies"]["management_db"] = f"unhealthy: {exc}"
        result["status"] = "unhealthy"

    return result


@app.get("/api/v1/health/providers", tags=["health"])
async def provider_health_check():
    """
    Per-workspace provider health — returns status for each data source.
    The frontend uses this to show health badges and warn users before
    navigating to a workspace with a dead provider.

    Phase 2 §2.4: bounded fan-out so one hung provider can't take the
    whole endpoint down. Concurrency cap of 5, per-probe timeout of 4s,
    overall wall-clock cap of 12s. Probes that exceed the wall clock are
    returned as `{"status": "unknown"}` — the endpoint is always 200 OK
    with partial results, never a 5xx because of slow upstreams.
    """
    from .db.repositories.workspace_repo import list_workspaces
    from .db.repositories.data_source_repo import list_data_sources

    PROBE_CONCURRENCY = 5
    PER_PROBE_TIMEOUT = 4.0     # seconds — tightened from 5s
    OVERALL_TIMEOUT = 12.0      # seconds — partial results returned past this

    providers: dict = {}

    try:
        async with get_async_session() as session:
            workspaces = await list_workspaces(session)

            sem = asyncio.Semaphore(PROBE_CONCURRENCY)
            ds_meta: list[tuple[str, str, str]] = []
            for ws in workspaces:
                sources = await list_data_sources(session, ws.id)
                for ds in sources:
                    ds_meta.append((ws.id, ds.id, ds.provider_id))

            async def check_provider(ws_id: str, ds_id: str, ds_provider_id: str):
                key = f"{ws_id}:{ds_id}"
                async with sem:
                    try:
                        provider = await asyncio.wait_for(
                            provider_registry.get_provider_for_workspace(ws_id, session, ds_id),
                            timeout=PER_PROBE_TIMEOUT,
                        )
                        await asyncio.wait_for(provider.get_stats(), timeout=PER_PROBE_TIMEOUT)
                        return key, {"status": "healthy", "providerId": ds_provider_id}
                    except Exception as exc:
                        return key, {"status": "unhealthy", "error": str(exc)[:200]}

            if ds_meta:
                tasks = [
                    asyncio.create_task(check_provider(ws_id, ds_id, prov_id))
                    for ws_id, ds_id, prov_id in ds_meta
                ]
                done, pending = await asyncio.wait(tasks, timeout=OVERALL_TIMEOUT)

                for task in done:
                    try:
                        key, status = task.result()
                        providers[key] = status
                    except Exception:
                        # Per-task failure already encoded by check_provider's
                        # try/except — anything reaching here is unexpected.
                        continue

                # Probes that exceeded the wall clock — cancel and surface
                # as "unknown" so the UI can distinguish "broken" from
                # "we don't know yet".
                for i, task in enumerate(tasks):
                    if task in pending:
                        task.cancel()
                        ws_id, ds_id, _ = ds_meta[i]
                        providers[f"{ws_id}:{ds_id}"] = {
                            "status": "unknown",
                            "error": f"Probe exceeded {OVERALL_TIMEOUT:.0f}s wall clock",
                        }

    except Exception as exc:
        return {"providers": {}, "error": str(exc)[:200]}

    return {"providers": providers}
