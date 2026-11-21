"""The AI service's management-database sessions.

The same engine plumbing as every other process (``backend.app.db.engine``),
on the small ``JOBS`` pool (``DB_JOBS_POOL_SIZE``): this service writes a few
rows per turn (a message, a usage count) and reads its settings through a
short cache, so it never needs the web tier's pool.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.db.engine import PoolRole, get_session_factory

_factory: async_sessionmaker[AsyncSession] | None = None


def set_session_factory(factory: async_sessionmaker[AsyncSession] | None) -> None:
    """Tests bind an in-memory database here."""
    global _factory
    _factory = factory


def session_factory() -> async_sessionmaker[AsyncSession]:
    global _factory
    if _factory is None:
        _factory = get_session_factory(PoolRole.JOBS)
    return _factory


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """A session that commits on success and rolls back on error."""
    async with session_factory()() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency."""
    async with session_scope() as session:
        yield session
