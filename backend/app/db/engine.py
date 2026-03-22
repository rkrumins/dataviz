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

    # ── Create feature_categories / feature_definitions / feature_flags if missing ─
    async with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS feature_categories "
                    "(id TEXT NOT NULL PRIMARY KEY, label TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, "
                    "preview INTEGER NOT NULL DEFAULT 1, preview_label TEXT, preview_footer TEXT)"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS feature_definitions "
                    "(key TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, category_id TEXT NOT NULL, "
                    "type TEXT NOT NULL, default_value TEXT NOT NULL, user_overridable INTEGER NOT NULL DEFAULT 0, "
                    "options TEXT, help_url TEXT, admin_hint TEXT, sort_order INTEGER NOT NULL DEFAULT 0, deprecated INTEGER NOT NULL DEFAULT 0, implemented INTEGER NOT NULL DEFAULT 0)"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS feature_flags "
                    "(id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS feature_registry_meta "
                    "(id INTEGER PRIMARY KEY CHECK (id = 1), experimental_notice_enabled INTEGER NOT NULL DEFAULT 1, "
                    "experimental_notice_title TEXT, experimental_notice_message TEXT, updated_at TEXT NOT NULL)"
                )
            )
            logger.info("Migration: feature_categories, feature_definitions, feature_flags, feature_registry_meta ensured")

    # ── Create user / auth tables if missing ───────────────────────────
    async with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS users "
                    "(id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, "
                    "first_name TEXT NOT NULL, last_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', "
                    "auth_provider TEXT NOT NULL DEFAULT 'local', external_id TEXT, metadata TEXT DEFAULT '{}', "
                    "reset_token_hash TEXT, reset_token_expires_at TEXT, "
                    "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS user_roles "
                    "(id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                    "role_name TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, "
                    "UNIQUE(user_id, role_name))"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS user_approvals "
                    "(id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                    "approved_by TEXT, status TEXT NOT NULL DEFAULT 'pending', rejection_reason TEXT, "
                    "created_at TEXT NOT NULL, resolved_at TEXT)"
                )
            )
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS outbox_events "
                    "(id TEXT NOT NULL PRIMARY KEY, event_type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', "
                    "processed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
                )
            )
            logger.info("Migration: users, user_roles, user_approvals, outbox_events ensured")

    # ── Create announcements table if missing ────────────────────────────
    async with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS announcements "
                    "(id TEXT NOT NULL PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, "
                    "banner_type TEXT NOT NULL DEFAULT 'info', is_active INTEGER NOT NULL DEFAULT 1, "
                    "snooze_duration_minutes INTEGER NOT NULL DEFAULT 0, cta_text TEXT, cta_url TEXT, "
                    "created_by TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
            )
            logger.info("Migration: announcements table ensured")

    # ── Create announcement_config table if missing ────────────────────
    async with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS announcement_config "
                    "(id INTEGER PRIMARY KEY CHECK (id = 1), "
                    "poll_interval_seconds INTEGER NOT NULL DEFAULT 15, "
                    "default_snooze_minutes INTEGER NOT NULL DEFAULT 30, "
                    "updated_by TEXT, updated_at TEXT NOT NULL DEFAULT '')"
                )
            )
            # Seed single row if empty
            await conn.execute(
                __import__("sqlalchemy").text(
                    "INSERT OR IGNORE INTO announcement_config (id, poll_interval_seconds, default_snooze_minutes, updated_at) "
                    "VALUES (1, 15, 30, datetime('now'))"
                )
            )
            logger.info("Migration: announcement_config table ensured")

    # ── Seed 'announcementsEnabled' feature definition if missing ──────
    async with engine.begin() as conn:
        try:
            import json as _json
            await conn.execute(
                __import__("sqlalchemy").text(
                    "INSERT OR IGNORE INTO feature_definitions "
                    "(key, name, description, category_id, type, default_value, "
                    "user_overridable, sort_order, deprecated, implemented, admin_hint) "
                    "VALUES (:key, :name, :desc, :cat, :type, :default, 0, 0, 0, 1, :hint)"
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
            logger.info("Migration: announcementsEnabled feature definition ensured")
        except Exception:
            pass

    # ── Inline schema migrations ──────────────────────────────────────
    # SQLAlchemy create_all only creates NEW tables, not new columns on
    # existing tables.  We run safe ALTER TABLE statements here.
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

    # ── Backfill schema_id for existing ontologies ───────────────────
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                __import__("sqlalchemy").text(
                    "SELECT id, name FROM ontologies WHERE schema_id = '' ORDER BY name, version"
                )
            )
            rows = result.fetchall()
            if rows:
                name_to_schema: dict[str, str] = {}
                for row_id, name in rows:
                    # NULL/empty names get their own id as schema_id (no grouping)
                    if not name:
                        # Each unnamed ontology is its own schema lineage
                        schema_id = row_id
                    else:
                        if name not in name_to_schema:
                            name_to_schema[name] = row_id
                        schema_id = name_to_schema[name]
                    await conn.execute(
                        __import__("sqlalchemy").text(
                            "UPDATE ontologies SET schema_id = :sid WHERE id = :rid"
                        ),
                        {"sid": schema_id, "rid": row_id},
                    )
                logger.info("Backfilled schema_id for %d ontologies", len(rows))
        except Exception:
            pass

    # ── Schema migrations tracking table ──────────────────────────────
    # Ensures destructive one-time migrations only run once, even across
    # server restarts. Each migration is identified by a unique key.
    async with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            await conn.execute(
                __import__("sqlalchemy").text(
                    "CREATE TABLE IF NOT EXISTS schema_migrations "
                    "(key TEXT NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)"
                )
            )

    # ── One-time: undo bad data_source_id backfill ───────────────────
    # A prior migration incorrectly guessed data_source_id for legacy views.
    # Reset to NULL so these views use the active datasource (pre-fix behavior).
    # This MUST only run once — subsequent runs would wipe legitimately-set
    # data_source_id values on views targeting the primary datasource.
    async with engine.begin() as conn:
        try:
            result = await conn.execute(
                __import__("sqlalchemy").text(
                    "SELECT 1 FROM schema_migrations WHERE key = 'undo_bad_ds_backfill'"
                )
            )
            if result.scalar() is None:
                await conn.execute(
                    __import__("sqlalchemy").text(
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
                await conn.execute(
                    __import__("sqlalchemy").text(
                        "INSERT INTO schema_migrations (key, applied_at) "
                        "VALUES ('undo_bad_ds_backfill', datetime('now'))"
                    )
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
