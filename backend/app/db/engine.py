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
    Create all tables that don't yet exist and apply incremental migrations.
    Called once during application lifespan startup.
    Works for both SQLite (dev/quickstart) and PostgreSQL (production).
    """
    import json as _json
    from datetime import datetime as _dt, timezone as _tz
    sa_text = __import__("sqlalchemy").text

    engine = get_engine()
    # ── 1. Create all ORM-defined tables ──────────────────────────────
    # With multi-worker servers (e.g. gunicorn), multiple workers may race
    # to create_all simultaneously.  On PostgreSQL this can cause
    # IntegrityError on pg_type_typname_nsp_index.  Safe to ignore —
    # the other worker's transaction will win and create the tables.
    from . import models  # noqa: F401 — registers ORM models with Base
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as _create_err:
        logger.warning("create_all race (safe to ignore): %s", _create_err)
        # Tables may already exist from the winning worker — verify
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    # ── 2. Inline ALTER TABLE migrations for pre-existing databases ───
    # create_all only creates NEW tables, not new columns on existing
    # tables.  Each ALTER is wrapped in try/except so it's safe to re-run.
    async with engine.begin() as conn:
        migrations = [
            "ALTER TABLE workspace_data_sources ADD COLUMN projection_mode TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN dedicated_graph_name TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN catalog_item_id TEXT",
            "ALTER TABLE workspace_data_sources ADD COLUMN access_level TEXT DEFAULT 'read'",
            "ALTER TABLE workspace_data_sources ADD COLUMN extra_config TEXT",
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
            "ALTER TABLE feature_categories ADD COLUMN preview INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE feature_categories ADD COLUMN preview_label TEXT",
            "ALTER TABLE feature_categories ADD COLUMN preview_footer TEXT",
            "ALTER TABLE feature_definitions ADD COLUMN implemented INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE feature_registry_meta ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE feature_flags ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
            # Phase 3: Ontology versioning + audit columns
            "ALTER TABLE ontologies ADD COLUMN schema_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE ontologies ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE ontologies ADD COLUMN created_by TEXT",
            "ALTER TABLE ontologies ADD COLUMN updated_by TEXT",
            # Announcements: replace is_dismissible with snooze_duration_minutes
            "ALTER TABLE announcements ADD COLUMN snooze_duration_minutes INTEGER NOT NULL DEFAULT 0",
            # Soft-delete for ontologies and views
            "ALTER TABLE ontologies ADD COLUMN deleted_at TEXT DEFAULT NULL",
            "ALTER TABLE ontologies ADD COLUMN published_by TEXT DEFAULT NULL",
            "ALTER TABLE ontologies ADD COLUMN published_at TEXT DEFAULT NULL",
            "ALTER TABLE ontologies ADD COLUMN deleted_by TEXT DEFAULT NULL",
            "ALTER TABLE views ADD COLUMN deleted_at TEXT",
        ]
        for stmt in migrations:
            try:
                await conn.execute(sa_text(stmt))
                logger.info("Migration applied: %s", stmt)
            except Exception:
                # Column/table already exists — safe to ignore
                pass

    # ── 3. Backfill schema_id for existing ontologies ─────────────────
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                sa_text("SELECT id, name FROM ontologies WHERE schema_id = '' ORDER BY name, version")
            )
            rows = result.fetchall()
            if rows:
                name_to_schema: dict[str, str] = {}
                for row_id, name in rows:
                    if not name:
                        schema_id = row_id
                    else:
                        if name not in name_to_schema:
                            name_to_schema[name] = row_id
                        schema_id = name_to_schema[name]
                    await conn.execute(
                        sa_text("UPDATE ontologies SET schema_id = :sid WHERE id = :rid"),
                        {"sid": schema_id, "rid": row_id},
                    )
                logger.info("Backfilled schema_id for %d ontologies", len(rows))
        except Exception:
            pass

    # ── 4. Seed singleton rows (announcement_config) ──────────────────
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
        except Exception:
            pass

    # ── 5. Seed 'announcementsEnabled' feature definition if missing ──
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                sa_text("SELECT 1 FROM feature_definitions WHERE key = :key"),
                {"key": "announcementsEnabled"},
            )
            if result.scalar() is None:
                await conn.execute(
                    sa_text(
                        "INSERT INTO feature_definitions "
                        "(key, name, description, category_id, type, default_value, "
                        "user_overridable, sort_order, deprecated, implemented, admin_hint) "
                        "VALUES (:key, :name, :desc, :cat, :type, :default, false, 0, false, true, :hint)"
                    ),
                    {
                        "key": "announcementsEnabled",
                        "name": "Announcements",
                        "desc": "Show global announcement banners to all users. When disabled, banners are hidden even if active announcements exist.",
                        "cat": "notifications",
                        "type": "boolean",
                        "default": _json.dumps(True),
                        "hint": "Toggle off to instantly hide all announcement banners without deactivating individual announcements.",
                    },
                )
                logger.info("Seed: announcementsEnabled feature definition inserted")
        except Exception:
            pass

    # ── 6. One-time: undo bad data_source_id backfill ─────────────────
    # A prior migration incorrectly guessed data_source_id for legacy views.
    # Reset to NULL so these views use the active datasource (pre-fix behavior).
    # This MUST only run once — subsequent runs would wipe legitimately-set
    # data_source_id values on views targeting the primary datasource.
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                sa_text("SELECT 1 FROM schema_migrations WHERE key = 'undo_bad_ds_backfill'")
            )
            if result.scalar() is None:
                await conn.execute(
                    sa_text(
                        """
                        UPDATE views
                        SET data_source_id = NULL
                        WHERE data_source_id IS NOT NULL
                          AND data_source_id = (
                              SELECT ds.id FROM workspace_data_sources ds
                              WHERE ds.workspace_id = views.workspace_id
                              ORDER BY ds.is_primary DESC, ds.created_at ASC
                              LIMIT 1
                          )
                        """
                    )
                )
                now_iso = _dt.now(_tz.utc).isoformat()
                await conn.execute(
                    sa_text(
                        "INSERT INTO schema_migrations (key, applied_at) "
                        "VALUES ('undo_bad_ds_backfill', :now)"
                    ),
                    {"now": now_iso},
                )
                logger.info("Migration applied: undo_bad_ds_backfill")
        except Exception:
            pass

    logger.info("Management DB initialised at %s", DATABASE_URL)


async def close_db() -> None:
    """Dispose the engine connection pool on shutdown."""
    global _engine, _session_factory
    if _engine:
        await _engine.dispose()
        _engine = None
        _session_factory = None
