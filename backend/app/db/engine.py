"""
SQLAlchemy async engine and session factory for the management database.

Development:  SQLite via aiosqlite  (nexus_core.db in the project root)
Production:   PostgreSQL via asyncpg (set MANAGEMENT_DB_URL env var)

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

def _build_db_url() -> str:
    """
    Resolve the management DB URL from environment.
    Falls back to SQLite in the repo root for development.
    """
    url = os.getenv("MANAGEMENT_DB_URL")
    if url:
        return url
    # Default: SQLite stored alongside the running process.
    # Path: backend/../../nexus_core.db  →  <repo-root>/nexus_core.db
    here = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(here, "..", "..", "..", "nexus_core.db")
    db_path = os.path.normpath(db_path)
    return f"sqlite+aiosqlite:///{db_path}"


DATABASE_URL: str = _build_db_url()

# ------------------------------------------------------------------ #
# Engine                                                               #
# ------------------------------------------------------------------ #

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        connect_args = {}
        if DATABASE_URL.startswith("sqlite"):
            connect_args["check_same_thread"] = False
        _engine = create_async_engine(
            DATABASE_URL,
            echo=os.getenv("DB_ECHO", "false").lower() == "true",
            connect_args=connect_args,
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


async def init_db() -> None:
    """
    Create all tables that don't yet exist.
    Called once during application lifespan startup.
    """
    engine = get_engine()
    async with engine.begin() as conn:
        from . import models  # noqa: F401 — registers ORM models with Base
        await conn.run_sync(Base.metadata.create_all)

    # ── Inline schema migrations ──────────────────────────────────────
    # SQLAlchemy create_all only creates NEW tables, not new columns on
    # existing tables.  We run safe ALTER TABLE statements here.
    async with engine.begin() as conn:
        migrations = [
            "ALTER TABLE workspace_data_sources ADD COLUMN projection_mode TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN dedicated_graph_name TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN catalog_item_id TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN access_level TEXT DEFAULT 'read'",
            "ALTER TABLE context_models ADD COLUMN view_type TEXT",
            "ALTER TABLE context_models ADD COLUMN config TEXT",
            "ALTER TABLE context_models ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'",
            "ALTER TABLE context_models ADD COLUMN created_by TEXT",
            "ALTER TABLE context_models ADD COLUMN tags TEXT",
            "ALTER TABLE context_models ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE providers ADD COLUMN permitted_workspaces TEXT DEFAULT '[\"*\"]'",
            # Phase 0a: Rename ontology_blueprints -> ontologies
            "ALTER TABLE ontology_blueprints RENAME TO ontologies",
            # Phase 0a: Rename blueprint_id -> ontology_id in workspace_data_sources
            "ALTER TABLE workspace_data_sources ADD COLUMN ontology_id TEXT REFERENCES ontologies(id) ON DELETE SET NULL",
            "UPDATE workspace_data_sources SET ontology_id = blueprint_id WHERE blueprint_id IS NOT NULL",
            # Phase 1: Add new definition columns to ontologies
            "ALTER TABLE ontologies ADD COLUMN entity_type_definitions TEXT DEFAULT '{}'",
            "ALTER TABLE ontologies ADD COLUMN relationship_type_definitions TEXT DEFAULT '{}'",
            "ALTER TABLE ontologies ADD COLUMN is_system INTEGER DEFAULT 0",
            "ALTER TABLE ontologies ADD COLUMN scope TEXT DEFAULT 'universal'",
            # Phase 2: Add description and evolution_policy to ontologies
            "ALTER TABLE ontologies ADD COLUMN description TEXT",
            "ALTER TABLE ontologies ADD COLUMN evolution_policy TEXT DEFAULT 'reject'",
        ]
        for stmt in migrations:
            try:
                await conn.execute(
                    __import__("sqlalchemy").text(stmt)
                )
                logger.info("Migration applied: %s", stmt)
            except Exception:
                # Column already exists — safe to ignore
                pass

    logger.info("Management DB initialised at %s", DATABASE_URL)


async def close_db() -> None:
    """Dispose the engine connection pool on shutdown."""
    global _engine, _session_factory
    if _engine:
        await _engine.dispose()
        _engine = None
        _session_factory = None
