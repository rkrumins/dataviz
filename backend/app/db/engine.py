"""
SQLAlchemy async engine and session factory for the management database.

Synodic is **Postgres-only** (Postgres v16+) for both development and
production. SQLite is no longer supported — the dialect-asymmetry tax
on Phase 2 concurrency, Phase 1.5 schema namespaces, and migration
discipline outweighed the dev-ergonomics benefit. Spin up the dev
Postgres via `docker compose -f docker-compose.dev.yml up -d`.

Required env var:
    MANAGEMENT_DB_URL   e.g. postgresql+asyncpg://synodic:synodic@localhost:5432/synodic

Usage:
    async with get_async_session() as session:
        result = await session.execute(...)
"""
import os
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
    AsyncEngine,
)
from sqlalchemy.orm import DeclarativeBase

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# URL resolution                                                       #
# ------------------------------------------------------------------ #

_DEV_FALLBACK_URL = "postgresql+asyncpg://synodic:synodic@localhost:5432/synodic"


def _build_db_url() -> str:
    """Resolve the management DB URL.

    `MANAGEMENT_DB_URL` is mandatory in any non-dev deployment. For local
    development we fall back to the credentials provisioned by
    `docker-compose.dev.yml`. Anything that isn't an asyncpg Postgres URL
    is rejected fast — there is no longer a SQLite branch.
    """
    url = os.getenv("MANAGEMENT_DB_URL", _DEV_FALLBACK_URL)
    if not url.startswith("postgresql+asyncpg://"):
        raise RuntimeError(
            "Synodic requires Postgres v16+ via asyncpg. "
            f"MANAGEMENT_DB_URL must start with 'postgresql+asyncpg://' (got: {url[:30]!r}). "
            "Run `docker compose -f docker-compose.dev.yml up -d` for a local dev Postgres."
        )
    return url


DATABASE_URL: str = _build_db_url()

# ------------------------------------------------------------------ #
# Engine                                                               #
# ------------------------------------------------------------------ #

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            DATABASE_URL,
            echo=os.getenv("DB_ECHO", "false").lower() == "true",
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
            autocommit=False,
        )
    return _session_factory


@asynccontextmanager
async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """Context-manager session — used in non-FastAPI code (scripts, lifespan)."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency — yields a session per request.

    Usage:
        session: AsyncSession = Depends(get_db_session)
    """
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ------------------------------------------------------------------ #
# Base class for ORM models                                            #
# ------------------------------------------------------------------ #

class Base(DeclarativeBase):
    pass


def _alembic_config():
    """Build an Alembic Config pointing at backend/alembic.ini.

    `script_location` in alembic.ini is the relative string `alembic`,
    which Alembic resolves against the current working directory. When
    `init_db()` runs from arbitrary CWDs (uvicorn launched from repo
    root, tests from anywhere) we need to override it to an absolute
    path so resolution does not depend on where the process was started.
    """
    from alembic.config import Config
    here = os.path.dirname(os.path.abspath(__file__))           # backend/app/db
    backend_dir = os.path.normpath(os.path.join(here, "..", ".."))  # backend
    ini_path = os.path.join(backend_dir, "alembic.ini")
    cfg = Config(ini_path)
    cfg.set_main_option("script_location", os.path.join(backend_dir, "alembic"))
    return cfg


def _run_alembic_upgrade() -> None:
    """Synchronous Alembic upgrade — invoked via asyncio.to_thread.

    Alembic itself is sync; running it on a worker thread keeps the
    event loop free during startup.
    """
    from alembic import command
    cfg = _alembic_config()
    command.upgrade(cfg, "head")


async def init_db() -> None:
    """Apply Alembic migrations and seed minimal singleton rows.

    Schema lifecycle is owned by Alembic from Phase 1 onward — the
    inline `ALTER TABLE` block that previously lived here has been
    removed. The dev workflow when iterating on the schema is:

        rm nexus_core.db nexus_core.db-wal nexus_core.db-shm 2>/dev/null
        # restart the app, or:
        cd backend && alembic upgrade head
    """
    import asyncio as _asyncio
    from datetime import datetime as _dt, timezone as _tz
    sa_text = __import__("sqlalchemy").text

    # Alembic loads env.py, which imports every ORM module; this also
    # ensures Base.metadata is fully populated for the rest of the app.
    await _asyncio.to_thread(_run_alembic_upgrade)
    logger.info("Alembic upgrade complete (head reached)")

    # ── Seed singleton rows that aren't covered by ORM defaults ──────
    # announcement_config has a CHECK(id=1) constraint and needs an
    # explicit default row. Repos read it without nullability concerns.
    engine = get_engine()
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                sa_text("SELECT 1 FROM announcement_config WHERE id = 1")
            )
            if result.scalar() is None:
                now_iso = _dt.now(_tz.utc).isoformat()
                await conn.execute(
                    sa_text(
                        "INSERT INTO announcement_config (id, poll_interval_seconds, default_snooze_minutes, updated_at) "
                        "VALUES (1, 15, 30, :now)"
                    ),
                    {"now": now_iso},
                )
                logger.info("Seed: announcement_config default row inserted")
        except Exception as exc:
            logger.warning("announcement_config seed warning: %s", exc)

    logger.info("Management DB initialised at %s", DATABASE_URL)


async def close_db() -> None:
    """Dispose the engine connection pool on shutdown."""
    global _engine, _session_factory
    if _engine:
        await _engine.dispose()
        _engine = None
        _session_factory = None
