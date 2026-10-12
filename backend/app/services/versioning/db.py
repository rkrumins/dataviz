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
from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from . import config


class VersioningBase(DeclarativeBase):
    """Declarative base for every ``graphver`` table (separate from management)."""


_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None
_lock_engine: Optional[AsyncEngine] = None


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
    try:
        try:
            yield session
            await asyncio.shield(session.commit())
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await asyncio.shield(session.rollback())
            raise
        except Exception:
            await session.rollback()
            raise
    finally:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.close())


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
    global _engine, _session_factory, _lock_engine
    if _engine is not None:
        await _engine.dispose()
    if _lock_engine is not None:
        await _lock_engine.dispose()
    _engine = None
    _session_factory = None
    _lock_engine = None
