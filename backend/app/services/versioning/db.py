"""Decoupled engine / session / declarative base for the ``graphver`` store.

Plan §1: the versioning store is a **separate, decoupled** durable store from the
management DB.  It owns its own :class:`VersioningBase` (separate metadata) so it
can be deployed to its own CloudSQL instance, and there are **no cross-schema
foreign keys to ``public``** — references to management entities
(``data_source_id``, ``workspace_id``, ``actor`` …) are logical only.

For single-instance dev/test the engine falls back to ``MANAGEMENT_DB_URL``
(see :func:`config.graphver_db_url`), but the metadata separation means the two
can be split apart by changing only ``GRAPHVER_DB_URL`` — no code change.

Engine creation is lazy, so importing this module needs SQLAlchemy only (no live
DB, no asyncpg) — which keeps it unit-test/inspection friendly.
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
from typing import AsyncContextManager, AsyncGenerator, Awaitable, Callable, Optional

from sqlalchemy import event, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session
from sqlalchemy.pool import NullPool

from . import config

logger = logging.getLogger(__name__)


class VersioningBase(DeclarativeBase):
    """Declarative base for every ``graphver`` table (separate from management)."""


_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None
_lock_engine: Optional[AsyncEngine] = None
_route_engine: Optional[AsyncEngine] = None
_route_session_factory: Optional[async_sessionmaker[AsyncSession]] = None


def get_engine() -> AsyncEngine:
    """Lazily create and cache the graphver async engine."""
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            config.graphver_db_url(),
            pool_size=config.POOL_SIZE,
            max_overflow=config.POOL_MAX_OVERFLOW,
            pool_timeout=config.POOL_TIMEOUT_SECS,
            pool_pre_ping=True,
            echo=False,
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


@contextlib.asynccontextmanager
async def graphver_session() -> AsyncGenerator[AsyncSession, None]:
    """Commit-on-success / rollback-on-error session scope for the store.

    Cancellation-safe, as ``db/engine.py``'s ``_session_scope`` is: ``CancelledError`` is not an
    ``Exception``, so a job task cancelled mid-window (a worker draining, a request timing out)
    would otherwise skip the rollback and leak its connection out of the pool. The commit, the
    rollback and the close are shielded, so the connection goes back even as the task dies."""
    session = get_session_factory()()
    cancelled = False
    try:
        try:
            yield session
            await asyncio.shield(session.commit())
        except asyncio.CancelledError:
            cancelled = True
            with contextlib.suppress(Exception):
                await asyncio.shield(session.rollback())
            raise
        except Exception:
            await session.rollback()
            raise
    finally:
        committed = session.sync_session.info.pop(_COMMITTED, ())
        with contextlib.suppress(Exception):
            await asyncio.shield(session.close())
        if committed and not cancelled:
            await _run_committed(committed)
        elif committed:
            logger.warning("%d after-commit step(s) skipped: the task was cancelled", len(committed))


def get_route_engine() -> AsyncEngine:
    """The small engine of its own for the lookups that route every read of a versioned graph — its
    pin, its watermark, its main branch: apart from the pool that reads and writes graphs
    (:func:`get_engine`), so reads that fill that pool (a large graph read from Postgres) can't take
    routing, and so every other graph's reads, down with them. Each statement on it is cut off past
    two seconds: a lookup that slow fails fast rather than queue requests behind it."""
    global _route_engine
    if _route_engine is None:
        url = config.graphver_db_url()
        connect_args = ({"server_settings": {"statement_timeout": "2000"}}
                        if url.startswith("postgresql+asyncpg") else {})
        _route_engine = create_async_engine(
            url,
            pool_size=config.ROUTE_POOL_SIZE,
            max_overflow=config.ROUTE_POOL_MAX_OVERFLOW,
            pool_timeout=config.ROUTE_POOL_TIMEOUT_SECS,
            pool_pre_ping=True,
            connect_args=connect_args,
            echo=False,
        )
    return _route_engine


@contextlib.asynccontextmanager
async def graphver_route_session() -> AsyncGenerator[AsyncSession, None]:
    """A session on the route engine (:func:`get_route_engine`) for the lookups that route a read:
    rolled back on error and always returned to its pool, as :func:`graphver_session`. Read only by
    intent: it runs no after-commit steps."""
    global _route_session_factory
    if _route_session_factory is None:
        _route_session_factory = async_sessionmaker(
            bind=get_route_engine(), class_=AsyncSession, expire_on_commit=False,
            autoflush=False, autocommit=False)
    session = _route_session_factory()
    try:
        yield session
        await asyncio.shield(session.commit())
    except BaseException:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.rollback())
        raise
    finally:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.close())


#: The graph whose bounded read slot this task already holds (:func:`bounded_read_sessions`), so a
#: session opened inside another doesn't wait for a second place and deadlock against itself.
_READ_SLOT_HELD: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "graphver_read_slot_held", default=None)
_SET_STATEMENT_TIMEOUT = text("SELECT set_config('statement_timeout', :ms, true)")
_QUERY_CANCELED = "57014"


def bounded_read_sessions(graph_id: str, *, slot=None
                          ) -> Callable[[], AsyncContextManager[AsyncSession]]:
    """A session factory for reads of ``graph_id`` from Postgres while FalkorDB holds no version of
    it, bounded so one large graph's reads can't take the store from everyone's:

    * each session holds a place from ``slot(graph_id, per_process=, per_graph=)`` (the provider
      manager's ``pg_read_slot``), unless its task already holds one for the graph;
    * each statement in it is cancelled past New-version builds' statement limit, answered as
      :class:`~.errors.GraphReadBusy` (503, retryable) rather than holding its connection.

    The limits are read live (``build_policy.resolve``), so an administrator's change applies to the
    next read. Pass it where :class:`~.service.GraphVersioningService` takes ``session_factory``."""

    @contextlib.asynccontextmanager
    async def factory() -> AsyncGenerator[AsyncSession, None]:
        from .build_policy import resolve
        from .errors import GraphReadBusy

        policy = await resolve()
        held = _READ_SLOT_HELD.get() == graph_id
        place = (contextlib.nullcontext() if held or slot is None else
                 slot(graph_id, per_process=policy["pgReadsPerProcess"],
                      per_graph=policy["pgReadsPerGraph"]))
        async with place:
            token = _READ_SLOT_HELD.set(graph_id)
            try:
                try:
                    async with graphver_session() as session:
                        await session.execute(_SET_STATEMENT_TIMEOUT,
                                              {"ms": str(policy["pgStatementTimeoutMs"])})
                        yield session
                except DBAPIError as exc:
                    if getattr(exc.orig, "sqlstate", None) == _QUERY_CANCELED:
                        from backend.app.jobs.metrics import increment
                        increment("graphver_pg_read_timeouts_total")
                        raise GraphReadBusy() from exc
                    raise
            finally:
                _READ_SLOT_HELD.reset(token)

    return factory


#: Steps a transaction defers until it commits (:func:`after_commit`), on its session's ``info``:
#: waiting for the commit, then committed and waiting for the session scope to close.
_PENDING, _COMMITTED = "graphver.after_commit", "graphver.committed"


def after_commit(session, step: Callable[[], Awaitable[None]]) -> None:
    """Run ``step`` (an async thunk) once the transaction ``session`` is in has committed, never if
    it rolls back — so an attempt that :meth:`~.service.GraphVersioningService._retry_seq` runs
    again leaves nothing behind. For what records a commit in another store (its activity event):
    it exists only if the commit does, and it never fails the commit. Run, best-effort, as
    :func:`graphver_session` closes; another session factory drops it."""
    sync = getattr(session, "sync_session", session)
    sync.info.setdefault(_PENDING, []).append(step)


@event.listens_for(Session, "after_commit")
def _committed(sync: Session) -> None:
    pending = sync.info.pop(_PENDING, None)
    if pending:
        sync.info.setdefault(_COMMITTED, []).extend(pending)


@event.listens_for(Session, "after_rollback")
def _rolled_back(sync: Session) -> None:
    sync.info.pop(_PENDING, None)


async def _run_committed(steps) -> None:
    for step in steps:
        try:
            await step()
        except Exception:  # noqa: BLE001 — what it records already happened; nothing to undo
            logger.warning("an after-commit step failed", exc_info=True)


@contextlib.asynccontextmanager
async def graphver_lock_session() -> AsyncGenerator[AsyncSession, None]:
    """A session on a connection of its OWN, for a session-level advisory lock held for minutes.

    The projector holds ``pg_advisory_lock`` for a whole projection (a full seed runs for minutes),
    so its connection must not come out of the pool sized for short window transactions: a few
    graphs projecting at once would starve every job in the process. A NullPool engine opens a
    connection per session and closes it on exit, and closing it releases any lock it still holds,
    so a projection that fails to unlock can never wedge the next. Nothing is committed."""
    global _lock_engine
    if _lock_engine is None:
        _lock_engine = create_async_engine(config.graphver_db_url(), poolclass=NullPool, echo=False)
    session = AsyncSession(bind=_lock_engine, expire_on_commit=False, autoflush=False)
    try:
        yield session
    finally:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.close())


async def dispose_engine() -> None:  # pragma: no cover - shutdown path
    global _engine, _session_factory, _lock_engine, _route_engine, _route_session_factory
    if _engine is not None:
        await _engine.dispose()
    if _lock_engine is not None:
        await _lock_engine.dispose()
    if _route_engine is not None:
        await _route_engine.dispose()
    _engine = None
    _session_factory = None
    _lock_engine = None
    _route_engine = None
    _route_session_factory = None
