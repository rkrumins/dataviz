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


def _pool_kwargs() -> dict:
    """Resolve pool-sizing knobs from env (Phase 2.5 §2.5.1).

    Defaults are sized for the web tier (`SYNODIC_ROLE=web`, ~4 uvicorn
    workers per replica). Worker / control-plane tiers should override
    these in their deployment manifests — see plan §6.7. Reading via env
    keeps deployment-time tuning out of the codebase.
    """
    return {
        "pool_size": int(os.getenv("DB_POOL_SIZE", "20")),
        "max_overflow": int(os.getenv("DB_POOL_MAX_OVERFLOW", "10")),
        "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT_SECS", "10")),
        "pool_recycle": int(os.getenv("DB_POOL_RECYCLE_SECS", "1800")),
        "pool_pre_ping": os.getenv("DB_POOL_PRE_PING", "true").lower() == "true",
    }


def _asyncpg_connect_args() -> dict:
    """Per-connection knobs passed through to asyncpg.

    `timeout` = TCP connection-establishment deadline. Without this,
    Postgres going down results in the uvicorn worker hanging on the
    kernel's default TCP SYN timeout (~75s on Linux), which both
    starves other coroutines and blocks request threads. 5s is short
    enough to fail fast and let `pool_pre_ping` retry via a fresh
    connection; long enough to tolerate typical handshake latency.

    `command_timeout` caps per-query execution on the protocol layer.
    Paired with FastAPI's per-request timeout middleware, a runaway
    query cannot pin a connection forever.
    """
    return {
        "timeout": float(os.getenv("DB_CONNECT_TIMEOUT_SECS", "5")),
        "command_timeout": float(os.getenv("DB_COMMAND_TIMEOUT_SECS", "30")),
    }


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        kw = _pool_kwargs()
        connect_args = _asyncpg_connect_args()
        _engine = create_async_engine(
            DATABASE_URL,
            echo=os.getenv("DB_ECHO", "false").lower() == "true",
            connect_args=connect_args,
            **kw,
        )
        # Self-documenting startup line so deployments can verify the
        # effective config without grepping env vars in the host.
        logger.info(
            "Engine pool: size=%d, max_overflow=%d, timeout=%ds, "
            "recycle=%ds, pre_ping=%s, connect_timeout=%.1fs, "
            "command_timeout=%.1fs",
            kw["pool_size"], kw["max_overflow"], kw["pool_timeout"],
            kw["pool_recycle"], kw["pool_pre_ping"],
            connect_args["timeout"], connect_args["command_timeout"],
        )
    return _engine


@asynccontextmanager
async def with_short_session() -> AsyncGenerator[AsyncSession, None]:
    """Short-lived session — for endpoints that make outbound graph calls.

    Phase 2.5 §2.5.2: the rule is `never hold a DB session across an
    outbound network call`. Use this in any endpoint that follows the
    pattern: open session → fetch row(s) → close session → make outbound
    call → optionally reopen session for the result write.

    Functionally identical to `get_async_session()`; named separately so
    `grep with_short_session` produces an audit list of endpoints that
    have committed to the discipline.
    """
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


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


def _is_transient_db_error(exc: BaseException) -> bool:
    """Classify startup errors: transient (retry) vs permanent (give up).

    Transient = Postgres not yet reachable: connection refused, TCP
    timeout, unreachable host, SQLAlchemy's OperationalError with a
    psycopg2 cause. Permanent = authentication failure, missing DB,
    schema/SQL bug in a migration — retrying those just burns time.
    """
    import socket
    from sqlalchemy.exc import OperationalError, InterfaceError, DBAPIError

    if isinstance(exc, (ConnectionError, TimeoutError, socket.gaierror, socket.timeout)):
        return True
    if isinstance(exc, OSError):
        return True
    if isinstance(exc, (OperationalError, InterfaceError, DBAPIError)):
        msg = str(exc).lower()
        # Retry on "could not connect" / "connection refused" / "server closed"
        # family. Explicit auth errors surface in the message too and we don't
        # retry those.
        if any(tok in msg for tok in (
            "could not connect",
            "connection refused",
            "connection reset",
            "server closed the connection",
            "timeout expired",
            "timed out",
            "no route to host",
            "name or service not known",
            "could not translate host name",
        )):
            return True
    return False


async def init_db() -> None:
    """Apply Alembic migrations and seed minimal singleton rows.

    Boot resilience: if Postgres is not yet reachable (docker-compose
    start order, pod init-ordering, etc.), retry the Alembic upgrade
    with exponential backoff up to `DB_STARTUP_RETRY_TIMEOUT_SECS`
    total wall clock (default 60s). On budget exhaustion or a
    non-transient error (auth, bad migration), raise — the orchestrator
    restarts the pod and we try again fresh. Hanging forever on a
    blocked `psycopg2.connect()` is what the pre-fix behaviour did.

    Schema lifecycle is owned by Alembic from Phase 1 onward — the
    inline `ALTER TABLE` block that previously lived here has been
    removed. The dev workflow when iterating on the schema is:

        docker compose -f docker-compose.dev.yml down -v
        docker compose -f docker-compose.dev.yml up -d
        cd backend && alembic upgrade head
    """
    import asyncio as _asyncio
    import time as _time
    from datetime import datetime as _dt, timezone as _tz
    sa_text = __import__("sqlalchemy").text

    # ── Alembic upgrade with bounded retry ──────────────────────────
    budget = float(os.getenv("DB_STARTUP_RETRY_TIMEOUT_SECS", "60"))
    deadline = _time.monotonic() + budget
    delay = 1.0
    attempt = 0
    while True:
        attempt += 1
        try:
            # Alembic loads env.py, which imports every ORM module; this
            # also ensures Base.metadata is fully populated.
            await _asyncio.to_thread(_run_alembic_upgrade)
            if attempt > 1:
                logger.info(
                    "Alembic upgrade succeeded on attempt %d (Postgres became reachable)",
                    attempt,
                )
            logger.info("Alembic upgrade complete (head reached)")
            break
        except Exception as exc:
            remaining = deadline - _time.monotonic()
            if not _is_transient_db_error(exc) or remaining <= 0:
                if remaining <= 0:
                    logger.error(
                        "Giving up on Alembic upgrade after %.0fs / %d attempts "
                        "— Postgres unreachable. Last error: %s",
                        budget, attempt, str(exc)[:300],
                    )
                raise
            sleep_for = min(delay, remaining)
            logger.warning(
                "Alembic upgrade attempt %d failed (%.0fs budget left, "
                "retrying in %.1fs): %s",
                attempt, remaining, sleep_for, str(exc)[:200],
            )
            await _asyncio.sleep(sleep_for)
            delay = min(delay * 2, 10.0)

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
