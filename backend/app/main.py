import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from .api.v1.api import api_router
from .db.engine import init_db, close_db, get_async_session
from .db.seed_templates import seed_templates
from .middleware.request_id import RequestIdMiddleware
from .middleware.logging import StructuredLoggingMiddleware, configure_json_logging
from .middleware.security_headers import SecurityHeadersMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from .registry.provider_registry import provider_registry

logger = logging.getLogger(__name__)


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

    # 3. Optionally bootstrap a default provider + workspace from env vars.
    #    Only bootstraps when FALKORDB_HOST (or equivalent) is explicitly set,
    #    so a fresh empty deployment can start clean and let users configure
    #    everything through the admin wizard.
    import os as _os
    _auto_bootstrap = _os.getenv("FALKORDB_HOST") or _os.getenv("NEO4J_HOST")
    if _auto_bootstrap:
        async with get_async_session() as session:
            try:
                await asyncio.wait_for(
                    provider_registry._resolve_primary_id(session), timeout=10
                )
            except asyncio.TimeoutError:
                logger.warning("Primary connection bootstrap timed out after 10s — provider may be unreachable")
            except Exception as exc:
                logger.warning("Primary connection bootstrap warning: %s", exc)
    else:
        logger.info("No graph host configured — skipping auto-bootstrap (use admin wizard to set up)")

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
app.add_middleware(_TimeoutMiddleware, timeout=30.0)

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
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)

# GZip compression for responses > 1 KB
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Structured JSON access log + X-Process-Time header
app.add_middleware(StructuredLoggingMiddleware)

# X-Request-ID generation / propagation
app.add_middleware(RequestIdMiddleware)

# Security headers (X-Content-Type-Options, X-Frame-Options, CSP, HSTS, etc.)
app.add_middleware(SecurityHeadersMiddleware)

# ------------------------------------------------------------------ #
# Routers                                                              #
# ------------------------------------------------------------------ #

app.include_router(api_router, prefix="/api/v1")


# ------------------------------------------------------------------ #
# Health endpoint                                                       #
# ------------------------------------------------------------------ #

@app.get("/health", tags=["health"])
@app.get("/api/v1/health", tags=["health"], include_in_schema=False)
async def health_check():
    """
    Enhanced health check — returns management DB + primary provider status.
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
        result["status"] = "degraded"

    # Primary provider ping (with timeout so a hung provider doesn't block the
    # entire health endpoint — which in turn blocks the frontend login flow).
    try:
        async with get_async_session() as session:
            primary_id = await asyncio.wait_for(
                provider_registry._resolve_primary_id(session), timeout=5
            )
            provider = await asyncio.wait_for(
                provider_registry.get_provider(primary_id, session), timeout=5
            )
            t0 = time.perf_counter()
            await asyncio.wait_for(provider.get_stats(), timeout=10)
            latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            result["dependencies"]["primary_provider"] = {
                "id": primary_id,
                "type": provider.name,
                "status": "healthy",
                "latencyMs": latency_ms,
            }
    except asyncio.TimeoutError:
        result["dependencies"]["primary_provider"] = {"status": "unhealthy: timeout"}
        result["status"] = "degraded"
    except Exception as exc:
        result["dependencies"]["primary_provider"] = {"status": f"unhealthy: {exc}"}
        result["status"] = "degraded"

    return result
