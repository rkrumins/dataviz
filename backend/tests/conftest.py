"""
Test configuration: add the backend root to sys.path so that
'backend' is importable without a pyproject.toml install.
"""
import sys
import os

# Add the workspace root (parent of 'backend') to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# Cookie config is read at module-import time. Tests run over plain HTTP
# (the ASGI transport has no TLS), so disable the Secure flag here before
# anything in backend.auth_service is loaded — otherwise httpx would
# refuse to send the cookies back on subsequent requests.
os.environ.setdefault("AUTH_COOKIE_SECURE", "false")

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.app.db.engine import Base, get_db_session, get_readonly_db_session
from backend.app.db import models as _models  # noqa: F401 — register ORM models
from backend.app.db.repositories import user_repo as _user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    require_admin,
)
from backend.auth_service.csrf import CSRF_HEADER_NAME
from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.interface import User
from backend.auth_service.providers import LocalIdentityProvider, register_provider
from backend.auth_service.service import LocalIdentityService


# Process-wide provider registry: register the local provider once for
# any test that hits /auth/login (or other identity-service code paths).
register_provider("local", LocalIdentityProvider())


# ---------------------------------------------------------------------------
# Fake user returned by auth overrides
#
# Endpoints now receive a ``User`` DTO from ``get_current_user`` (the
# cross-service identity contract — no more SQLAlchemy ORM leaking into
# handlers). A separate ``UserORM`` row is still inserted in the test DB
# so endpoints that resolve creator/author metadata can look the user up.
# ---------------------------------------------------------------------------
_FAKE_USER = User(
    id="usr_test000000",
    email="test@example.com",
    first_name="Test",
    last_name="User",
    role="admin",
    status="active",
    auth_provider="local",
    created_at="2024-01-01T00:00:00Z",
    updated_at="2024-01-01T00:00:00Z",
)

# Fixed CSRF token used for every request the test client makes. Real
# clients mint this server-side on /login; here we pre-set it on both
# sides of the double-submit so handlers that POST/PUT/DELETE pass the
# CSRF middleware without each test having to log in first.
_TEST_CSRF_TOKEN = "test-csrf-token"


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
    starts with a clean database. Repo-level tests use this fixture
    directly and so do not see any "authenticated user" — that's only
    seeded by ``test_client`` below, since it simulates a real HTTP
    request where the user exists.
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
def fake_user() -> User:
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

    # Persist the fake user row so endpoints that resolve creator /
    # author metadata (e.g. GET /views/facets) can look them up,
    # mirroring production where the authenticated user has a matching
    # row in the ``users`` table. Kept out of the ``db_session`` fixture
    # so raw-DB tests aren't polluted with an extra user they didn't
    # create.
    db_session.add(_models.UserORM(
        id=_FAKE_USER.id,
        email=_FAKE_USER.email,
        password_hash="not-a-real-hash",
        first_name=_FAKE_USER.first_name,
        last_name=_FAKE_USER.last_name,
        status=_FAKE_USER.status,
        auth_provider=_FAKE_USER.auth_provider,
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    ))
    db_session.add(_models.UserRoleORM(
        user_id=_FAKE_USER.id,
        role_name=_FAKE_USER.role,
    ))
    await db_session.commit()

    async def _override_get_db_session():
        yield db_session

    async def _override_get_current_user():
        return _FAKE_USER

    async def _override_get_optional_user():
        # Tests always "have" an authenticated user, so get_optional_user
        # returns the same stub as get_current_user. Without this override,
        # endpoints that use get_optional_user (e.g. create_view) would see
        # a None token and fall back to the anonymous sentinel, breaking
        # created_by attribution in test assertions.
        return _FAKE_USER

    async def _override_require_admin():
        return _FAKE_USER

    app.dependency_overrides[get_db_session] = _override_get_db_session
    app.dependency_overrides[get_readonly_db_session] = _override_get_db_session
    app.dependency_overrides[get_current_user] = _override_get_current_user
    app.dependency_overrides[get_optional_user] = _override_get_optional_user
    app.dependency_overrides[require_admin] = _override_require_admin

    # Wire a real IdentityService against the per-test session so
    # /api/v1/auth/* endpoints can be exercised end-to-end.
    @asynccontextmanager
    async def _test_session_factory():
        yield db_session

    previous_identity_service = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_test_session_factory,
        user_repo=_user_repo,
        refresh_store_factory=make_refresh_store,
    )

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        # Pre-load the CSRF double-submit so non-GET requests pass the
        # middleware without each test having to walk through /login.
        cookies={CSRF_COOKIE_NAME: _TEST_CSRF_TOKEN},
        headers={CSRF_HEADER_NAME: _TEST_CSRF_TOKEN},
    ) as client:
        yield client

    # Clean up overrides so they don't leak between test modules
    app.dependency_overrides.clear()
    app.state.identity_service = previous_identity_service
