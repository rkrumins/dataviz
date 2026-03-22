"""
Test configuration: add the backend root to sys.path so that
'backend' is importable without a pyproject.toml install.
"""
import sys
import os

# Add the workspace root (parent of 'backend') to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------
from typing import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.app.db.engine import Base, get_db_session
from backend.app.db import models as _models  # noqa: F401 — register ORM models
from backend.app.auth.dependencies import get_current_user, require_admin


# ---------------------------------------------------------------------------
# Fake user returned by auth overrides
# ---------------------------------------------------------------------------
_FAKE_USER = _models.UserORM(
    id="usr_test000000",
    email="test@example.com",
    password_hash="not-a-real-hash",
    first_name="Test",
    last_name="User",
    status="active",
    auth_provider="local",
)


# ---------------------------------------------------------------------------
# Database fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def db_engine() -> AsyncEngine:
    """Create an in-memory SQLite async engine shared across all tests."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        echo=False,
        # SQLite requires this for async usage with multiple statements
        connect_args={"check_same_thread": False},
    )
    return engine


@pytest.fixture()
async def db_session(db_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """
    Per-test async session.

    Creates all tables before each test and rolls back after, so every test
    starts with a clean database.
    """
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        bind=db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    async with session_factory() as session:
        yield session
        await session.rollback()

    # Drop all tables so the next test gets a truly clean slate
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


# ---------------------------------------------------------------------------
# Auth override fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_user() -> _models.UserORM:
    """The stub user object injected by auth overrides."""
    return _FAKE_USER


# ---------------------------------------------------------------------------
# FastAPI test client
# ---------------------------------------------------------------------------

@pytest.fixture()
async def test_client(
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncClient, None]:
    """
    httpx.AsyncClient wired to the FastAPI app with dependency overrides so
    that tests hit an in-memory SQLite DB and skip real authentication.
    """
    # Import app lazily to avoid triggering lifespan / real DB init at
    # import time.
    from backend.app.main import app

    # --- dependency overrides ---

    async def _override_get_db_session():
        yield db_session

    async def _override_get_current_user():
        return _FAKE_USER

    async def _override_require_admin():
        return _FAKE_USER

    app.dependency_overrides[get_db_session] = _override_get_db_session
    app.dependency_overrides[get_current_user] = _override_get_current_user
    app.dependency_overrides[require_admin] = _override_require_admin

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        yield client

    # Clean up overrides so they don't leak between test modules
    app.dependency_overrides.clear()
