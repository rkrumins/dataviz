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
    async with get_async_session() as session:        # web pool (default)
        result = await session.execute(...)

    async with get_jobs_session() as session:         # jobs pool
        ...   # aggregation worker, scheduler, outbox relay

    async with get_readonly_session() as session:     # readonly pool
        ...   # readiness / drift / status probes

    async with get_admin_session() as session:        # admin pool
        ...   # alembic runner, lifespan init

Per-role pools (plan Gap 3): the four engines above are backed by the
same Postgres role today but separate connection pools, so a runaway
aggregation worker cannot exhaust the pool that FastAPI request
handlers drain from. Bulkhead within a single process, no new infra.
Role-level Postgres grants (plan Gap 2) can layer on top without
changing the shape here.
"""
import os
import logging
from contextlib import asynccontextmanager
from enum import Enum
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
    AsyncEngine,
)
from sqlalchemy.orm import DeclarativeBase

logger = logging.getLogger(__name__)


class PoolRole(str, Enum):
    """Logical access pattern a caller is using. Each role gets its own
    connection pool so that saturation in one access pattern cannot
    starve the others.

    * ``WEB`` — FastAPI request handlers (OLTP reads + writes, short).
    * ``JOBS`` — Aggregation scheduler, worker, outbox relay (long-
      running writes; checkpoint commits every ~2s).
    * ``READONLY`` — Readiness probes, drift checks, stats endpoints,
      provider-status probes. Connections open ``default_transaction_
      read_only=on`` so a bug cannot accidentally write through them.
    * ``ADMIN`` — Alembic runner, lifespan seed/init. Small pool; used
      only at startup and during migrations.
    """

    WEB = "web"
    JOBS = "jobs"
    READONLY = "readonly"
    ADMIN = "admin"


# Default pool sizing per role. Tuned for the web tier (~4 uvicorn
# workers per replica); worker / control-plane tiers should override
# via env vars in their deployment manifests. Totals: 20+10 + 8+4 +
# 10+5 + 2+0 = 59 peak connections per process, well inside Postgres'
# default max_connections=100.
_POOL_DEFAULTS: dict[PoolRole, dict[str, int]] = {
    PoolRole.WEB:      {"pool_size": 20, "max_overflow": 10},
    PoolRole.JOBS:     {"pool_size": 8,  "max_overflow": 4},
    PoolRole.READONLY: {"pool_size": 10, "max_overflow": 5},
    PoolRole.ADMIN:    {"pool_size": 2,  "max_overflow": 0},
}

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
# Engines (one per PoolRole)                                            #
# ------------------------------------------------------------------ #

# Per-role caches. Populated lazily on first access so roles that a
# given process doesn't use never open sockets.
_engines: dict[PoolRole, AsyncEngine] = {}
_session_factories: dict[PoolRole, async_sessionmaker[AsyncSession]] = {}


def _pool_kwargs(role: PoolRole) -> dict:
    """Resolve pool-sizing knobs for a role, honouring both per-role and
    legacy env vars.

    Per-role env var precedence (highest wins):

    * ``DB_<ROLE>_POOL_SIZE`` / ``DB_<ROLE>_POOL_MAX_OVERFLOW`` — e.g.
      ``DB_JOBS_POOL_SIZE=16``. The canonical knob going forward.
    * ``DB_POOL_SIZE`` / ``DB_POOL_MAX_OVERFLOW`` — the legacy single-pool
      knobs. Still respected for ``WEB`` so existing deployment manifests
      don't suddenly grow a ``WEB`` suffix. Ignored for other roles
      (those have dedicated, smaller defaults that shouldn't be accidentally
      replaced by a big ``DB_POOL_SIZE`` meant for the web tier).
    * Hard-coded defaults from :data:`_POOL_DEFAULTS`.

    Timeouts (``pool_timeout``, ``pool_recycle``, ``pool_pre_ping``) are
    shared across roles — they're dictated by Postgres' idle-in-
    transaction reaper and network behaviour, not the access pattern.
    """
    defaults = _POOL_DEFAULTS[role]
    role_prefix = f"DB_{role.value.upper()}_"

    pool_size_env = os.getenv(f"{role_prefix}POOL_SIZE")
    if pool_size_env is None and role is PoolRole.WEB:
        pool_size_env = os.getenv("DB_POOL_SIZE")
    pool_size = int(pool_size_env) if pool_size_env is not None else defaults["pool_size"]

    overflow_env = os.getenv(f"{role_prefix}POOL_MAX_OVERFLOW")
    if overflow_env is None and role is PoolRole.WEB:
        overflow_env = os.getenv("DB_POOL_MAX_OVERFLOW")
    max_overflow = int(overflow_env) if overflow_env is not None else defaults["max_overflow"]

    return {
        "pool_size": pool_size,
        "max_overflow": max_overflow,
        "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT_SECS", "10")),
        "pool_recycle": int(os.getenv("DB_POOL_RECYCLE_SECS", "1800")),
        "pool_pre_ping": os.getenv("DB_POOL_PRE_PING", "true").lower() == "true",
    }


def _asyncpg_connect_args(role: PoolRole) -> dict:
    """Per-connection knobs passed through to asyncpg.

    ``timeout`` = TCP connection-establishment deadline. Without this,
    Postgres going down results in the uvicorn worker hanging on the
    kernel's default TCP SYN timeout (~75s on Linux), which both
    starves other coroutines and blocks request threads. 5s is short
    enough to fail fast and let ``pool_pre_ping`` retry via a fresh
    connection; long enough to tolerate typical handshake latency.

    ``command_timeout`` caps per-query execution on the protocol layer.
    Paired with FastAPI's per-request timeout middleware, a runaway
    query cannot pin a connection forever.

    For :attr:`PoolRole.READONLY`, ``server_settings`` sets Postgres'
    session-level ``default_transaction_read_only`` so that any stray
    write attempt on a readonly-pool connection errors at the protocol
    boundary rather than silently mutating data. This is a cheap guard
    that catches "wrong pool" bugs at the wire.
    """
    args: dict = {
        "timeout": float(os.getenv("DB_CONNECT_TIMEOUT_SECS", "5")),
        "command_timeout": float(os.getenv("DB_COMMAND_TIMEOUT_SECS", "30")),
    }
    if role is PoolRole.READONLY:
        args["server_settings"] = {"default_transaction_read_only": "on"}
    return args


def get_engine(role: PoolRole = PoolRole.WEB) -> AsyncEngine:
    """Return the cached engine for *role*, creating it on first use.

    Default is :attr:`PoolRole.WEB` so every existing callsite keeps
    working. New code should pass the role explicitly when using a
    non-default pool.
    """
    existing = _engines.get(role)
    if existing is not None:
        return existing
    kw = _pool_kwargs(role)
    connect_args = _asyncpg_connect_args(role)
    engine = create_async_engine(
        DATABASE_URL,
        echo=os.getenv("DB_ECHO", "false").lower() == "true",
        connect_args=connect_args,
        **kw,
    )
    _engines[role] = engine
    # Self-documenting startup line so deployments can verify the
    # effective config without grepping env vars in the host.
    logger.info(
        "Engine[%s] pool: size=%d, max_overflow=%d, timeout=%ds, "
        "recycle=%ds, pre_ping=%s, connect_timeout=%.1fs, "
        "command_timeout=%.1fs%s",
        role.value,
        kw["pool_size"], kw["max_overflow"], kw["pool_timeout"],
        kw["pool_recycle"], kw["pool_pre_ping"],
        connect_args["timeout"], connect_args["command_timeout"],
        " (read_only)" if role is PoolRole.READONLY else "",
    )
    return engine


def get_session_factory(role: PoolRole = PoolRole.WEB) -> async_sessionmaker[AsyncSession]:
    """Return the cached sessionmaker bound to *role*'s engine."""
    existing = _session_factories.get(role)
    if existing is not None:
        return existing
    factory = async_sessionmaker(
        bind=get_engine(role),
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
        autocommit=False,
    )
    _session_factories[role] = factory
    return factory


@asynccontextmanager
async def _session_scope(role: PoolRole) -> AsyncGenerator[AsyncSession, None]:
    """Shared commit-on-success / rollback-on-error boilerplate for every
    role-specific session helper below."""
    factory = get_session_factory(role)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def with_short_session() -> AsyncGenerator[AsyncSession, None]:
    """Short-lived WEB-pool session — for endpoints that make outbound
    graph calls.

    Phase 2.5 §2.5.2: the rule is ``never hold a DB session across an
    outbound network call``. Use this in any endpoint that follows the
    pattern: open session → fetch row(s) → close session → make outbound
    call → optionally reopen session for the result write.

    Functionally identical to :func:`get_async_session`; named
    separately so ``grep with_short_session`` produces an audit list
    of endpoints that have committed to the discipline.
    """
    async with _session_scope(PoolRole.WEB) as session:
        yield session


@asynccontextmanager
async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """Context-manager WEB-pool session — default for non-FastAPI code
    (scripts, lifespan, ad-hoc tasks)."""
    async with _session_scope(PoolRole.WEB) as session:
        yield session


@asynccontextmanager
async def get_jobs_session() -> AsyncGenerator[AsyncSession, None]:
    """Context-manager JOBS-pool session — aggregation scheduler, worker,
    outbox relay.

    Isolates long-running background writes (checkpoint commits every
    ~2s) from the WEB pool that serves request handlers. A saturated
    jobs pool cannot cause UI requests to queue behind it.
    """
    async with _session_scope(PoolRole.JOBS) as session:
        yield session


@asynccontextmanager
async def get_readonly_session() -> AsyncGenerator[AsyncSession, None]:
    """Context-manager READONLY-pool session — readiness probes, drift
    checks, stats endpoints, provider status scans.

    The underlying Postgres connection is opened with
    ``default_transaction_read_only=on`` (see :func:`_asyncpg_connect_args`),
    so any accidental write attempt errors at the wire rather than
    silently mutating state. Separate pool means high-frequency
    read-only traffic (polling dashboards, health checks) cannot drain
    the WEB pool.
    """
    async with _session_scope(PoolRole.READONLY) as session:
        yield session


@asynccontextmanager
async def get_admin_session() -> AsyncGenerator[AsyncSession, None]:
    """Context-manager ADMIN-pool session — Alembic runner, lifespan seed.

    Small dedicated pool so a catastrophic migration can't consume
    connections the web / jobs pools need to stay responsive.
    """
    async with _session_scope(PoolRole.ADMIN) as session:
        yield session


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields a WEB-pool session per request.

    Usage::

        session: AsyncSession = Depends(get_db_session)

    Readonly endpoints (readiness, drift, stats) should use
    :func:`get_readonly_db_session` instead so their traffic does not
    contend with WEB-pool writes.
    """
    factory = get_session_factory(PoolRole.WEB)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_readonly_db_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields a READONLY-pool session per request.

    Use for read-mostly endpoints that are polled at high frequency:
    readiness, drift check, provider status list, stats. Connections
    are opened ``default_transaction_read_only=on`` for defence in
    depth.
    """
    factory = get_session_factory(PoolRole.READONLY)
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


def _permanent_bootstrap_reason(exc: BaseException) -> str | None:
    """If the error is a known permanent bootstrap failure, return a short
    identifier; otherwise None. Used to surface actionable recovery hints
    instead of stack traces.
    """
    msg = str(exc).lower()
    if "role" in msg and "does not exist" in msg:
        return "role_missing"
    if "database" in msg and "does not exist" in msg:
        return "database_missing"
    if "password authentication failed" in msg:
        return "auth_failed"
    return None


_BOOTSTRAP_RECOVERY_HINTS: dict[str, str] = {
    "role_missing": (
        "Postgres role does not exist. Your data volume is likely stale "
        "(initialized earlier with different credentials, or init failed). "
        "Recover:\n"
        "  Local dev:   ./dev.sh repair\n"
        "  Self-host:   docker compose down -v && docker compose up -d   # WIPES DATA"
    ),
    "database_missing": (
        "Postgres database does not exist. Same fix as missing role:\n"
        "  Local dev:   ./dev.sh repair\n"
        "  Self-host:   docker compose down -v && docker compose up -d   # WIPES DATA"
    ),
    "auth_failed": (
        "Postgres authentication failed. POSTGRES_PASSWORD in your env "
        "doesn't match the password stored in the Postgres data volume.\n"
        "  Local dev:  check .env.dev matches the volume; else ./dev.sh reset\n"
        "  Self-host:  check .env POSTGRES_PASSWORD matches; if changed intentionally, "
        "either reset (wipes data) or `ALTER ROLE ... PASSWORD ...` via psql"
    ),
}


class BootstrapError(RuntimeError):
    """Raised when a permanent DB bootstrap failure is detected. Carries a
    short reason code so the lifespan can tag the degraded state precisely.
    """

    def __init__(self, reason: str, original: BaseException) -> None:
        hint = _BOOTSTRAP_RECOVERY_HINTS.get(reason, "")
        super().__init__(f"{hint}\n\nOriginal error: {original}" if hint else str(original))
        self.reason = reason
        self.original = original


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

    # ── Ensure the aggregation schema exists BEFORE Alembic runs ───
    # The aggregation service owns its own Postgres schema. Tables in
    # this schema are created by Alembic/create_all, but the schema
    # itself must exist first. This is idempotent and safe from any
    # process (viz-service, control plane, worker).
    #
    # Also doubles as the bootstrap probe: if the role or database is
    # missing we fail fast here with an actionable message instead of
    # burning the 60s Alembic retry budget on a permanent error.
    try:
        sa_text_mod = __import__("sqlalchemy").text
        engine = get_engine(PoolRole.ADMIN)
        async with engine.begin() as conn:
            await conn.execute(sa_text_mod("CREATE SCHEMA IF NOT EXISTS aggregation"))
        logger.info("Aggregation schema ready")
    except Exception as exc:
        reason = _permanent_bootstrap_reason(exc)
        if reason is not None:
            err = BootstrapError(reason, exc)
            logger.error("Bootstrap failed (%s):\n%s", reason, err)
            raise err from exc
        # Transient or unrelated — continue; Alembic retry will surface it.
        logger.warning("Aggregation schema creation warning: %s", exc)

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
            reason = _permanent_bootstrap_reason(exc)
            if reason is not None:
                err = BootstrapError(reason, exc)
                logger.error("Alembic bootstrap failed (%s):\n%s", reason, err)
                raise err from exc
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

    # ── Fallback: ensure aggregation tables exist ────────────────────
    # The aggregation schema was created above. Now ensure its tables
    # exist even if Alembic had a partial failure or the migration chain
    # was broken. checkfirst=True makes this idempotent (~2ms cost).
    try:
        from backend.app.services.aggregation import models as _agg_models  # noqa: F401
        _admin_engine = get_engine(PoolRole.ADMIN)
        async with _admin_engine.begin() as _agg_conn:
            _agg_tables = [
                t for t in Base.metadata.tables.values()
                if getattr(t, "schema", None) == "aggregation"
            ]
            for _t in _agg_tables:
                await _agg_conn.run_sync(lambda sync_conn, tbl=_t: tbl.create(sync_conn, checkfirst=True))
        logger.info("Aggregation tables verified (%d tables)", len(_agg_tables))
    except Exception as exc:
        logger.warning("Aggregation table fallback creation warning: %s", exc)

    # ── Seed singleton rows that aren't covered by ORM defaults ──────
    # announcement_config has a CHECK(id=1) constraint and needs an
    # explicit default row. Repos read it without nullability concerns.
    # Use the ADMIN pool — lifespan init is the canonical admin caller.
    engine = get_engine(PoolRole.ADMIN)
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
    """Dispose every cached per-role engine on shutdown.

    Any engine created during the process lifetime ends up in
    :data:`_engines`. We dispose all of them so no pool is left with
    open sockets after the app stops. Session factories are a cheap
    derived object keyed off engines, so clearing the map is enough.
    """
    for role, engine in list(_engines.items()):
        try:
            await engine.dispose()
        except Exception as exc:  # pragma: no cover - best effort on shutdown
            logger.warning("Engine[%s] dispose warning: %s", role.value, exc)
    _engines.clear()
    _session_factories.clear()


def pool_status() -> dict[str, dict[str, int | None]]:
    """Snapshot of every cached pool's utilisation — for
    ``/internal/metrics/db`` and for regression tests that need to
    assert bulkhead behaviour.

    Returns a dict keyed by role name with ``checked_out``,
    ``checked_in``, ``overflow``, ``size``, ``pool_timeout``. Roles
    whose engine has never been materialised (nothing has asked for a
    session) are omitted — they're not a cost worth reporting.
    """
    out: dict[str, dict[str, int | None]] = {}
    for role, engine in _engines.items():
        try:
            pool = engine.pool
            out[role.value] = {
                "checked_out": pool.checkedout(),
                "checked_in": pool.checkedin(),
                "overflow": pool.overflow(),
                "size": pool.size(),
            }
        except Exception:
            out[role.value] = {
                "checked_out": None,
                "checked_in": None,
                "overflow": None,
                "size": None,
            }
    return out
