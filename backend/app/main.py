import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .api.v1.api import api_router
from .db.engine import init_db, close_db, get_async_session
from .db.seed_templates import seed_templates
from .middleware.request_id import RequestIdMiddleware
from .middleware.logging import StructuredLoggingMiddleware, configure_json_logging
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

    # 2a. Seed feature categories, definitions, and registry meta (idempotent — skips if already present)
    try:
        from .db.seed_feature_registry import seed_feature_registry, seed_feature_registry_meta
        async with get_async_session() as session:
            await seed_feature_registry(session)
            await seed_feature_registry_meta(session)
    except Exception as exc:
        logger.warning("Feature registry seed warning: %s", exc)

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

    # 3. Ensure a primary connection exists; bootstrap from env vars if DB is empty
    async with get_async_session() as session:
        try:
            await provider_registry._resolve_primary_id(session)
        except Exception as exc:
            logger.warning("Primary connection bootstrap warning: %s", exc)

    logger.info("Synodic Visualization Service started")
    yield

    # Shutdown — release all provider connection pools
    await provider_registry.evict_all()
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

# ------------------------------------------------------------------ #
# Middleware (outermost → innermost order)                             #
# ------------------------------------------------------------------ #

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZip compression for responses > 1 KB
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Structured JSON access log + X-Process-Time header
app.add_middleware(StructuredLoggingMiddleware)

# X-Request-ID generation / propagation
app.add_middleware(RequestIdMiddleware)

# ------------------------------------------------------------------ #
# Routers                                                              #
# ------------------------------------------------------------------ #

app.include_router(api_router, prefix="/api/v1")


# ------------------------------------------------------------------ #
# Health endpoint                                                       #
# ------------------------------------------------------------------ #

@app.get("/health", tags=["health"])
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

    # Primary provider ping
    try:
        async with get_async_session() as session:
            primary_id = await provider_registry._resolve_primary_id(session)
            provider = await provider_registry.get_provider(primary_id, session)
            t0 = time.perf_counter()
            await provider.get_stats()
            latency_ms = round((time.perf_counter() - t0) * 1000, 2)
            result["dependencies"]["primary_provider"] = {
                "id": primary_id,
                "type": provider.name,
                "status": "healthy",
                "latencyMs": latency_ms,
            }
    except Exception as exc:
        result["dependencies"]["primary_provider"] = {"status": f"unhealthy: {exc}"}
        result["status"] = "degraded"

    return result
