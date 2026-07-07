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

import contextlib
from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from . import config


class VersioningBase(DeclarativeBase):
    """Declarative base for every ``graphver`` table (separate from management)."""


_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None


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
    """Commit-on-success / rollback-on-error session scope for the store."""
    session = get_session_factory()()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


async def dispose_engine() -> None:  # pragma: no cover - shutdown path
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
