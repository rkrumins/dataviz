"""
Unit tests for backend.app.auth.dependencies

Covers:
- get_current_user: JWT extraction, validation, expired/invalid tokens
- get_optional_user: returns None instead of 401 when no token
- require_admin: role-based access control
"""
from datetime import datetime, timezone, timedelta
from typing import Optional

import jwt as pyjwt
import pytest
from fastapi import HTTPException

from backend.app.auth.config import JWT_SECRET_KEY, JWT_ALGORITHM, JWT_ISSUER, JWT_AUDIENCE
from backend.app.auth.jwt import create_access_token, decode_token
from backend.app.auth.dependencies import get_current_user, get_optional_user, require_admin


# ---------------------------------------------------------------------------
# Stub user ORM object (matches project pattern — no unittest.mock)
# ---------------------------------------------------------------------------


class _StubUser:
    """Minimal user object matching UserORM shape for auth dependency tests."""

    def __init__(
        self,
        id: str = "usr_test000001",
        email: str = "test@example.com",
        status: str = "active",
        deleted_at: Optional[str] = None,
    ):
        self.id = id
        self.email = email
        self.status = status
        self.deleted_at = deleted_at
        self.first_name = "Test"
        self.last_name = "User"
        self.password_hash = "not-a-real-hash"
        self.auth_provider = "local"


# ---------------------------------------------------------------------------
# Stub session and repo (replaces real DB calls)
# ---------------------------------------------------------------------------


class _StubSession:
    """Placeholder session; not used directly since we monkey-patch the repo."""
    pass


class _StubUserRepo:
    """
    Captures calls to user_repo functions for testing.
    We monkey-patch these onto the user_repo module.
    """

    def __init__(self, user: Optional[_StubUser] = None, roles: list = None):
        self._user = user
        self._roles = roles or []

    async def get_user_by_id(self, session, user_id: str):
        if self._user and self._user.id == user_id:
            return self._user
        return None

    async def get_user_roles(self, session, user_id: str):
        return self._roles


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_token(user_id: str = "usr_test000001", email: str = "test@example.com", role: str = "user", **kwargs) -> str:
    return create_access_token(user_id=user_id, email=email, role=role, extra=kwargs if kwargs else None)


def _make_expired_token(user_id: str = "usr_test000001") -> str:
    """Create a token that expired 1 hour ago."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": "test@example.com",
        "role": "user",
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now - timedelta(hours=2),
        "exp": now - timedelta(hours=1),
    }
    return pyjwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def _make_invalid_token() -> str:
    """Create a token signed with a wrong key."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "usr_test000001",
        "email": "test@example.com",
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(hours=1),
    }
    return pyjwt.encode(payload, "wrong-secret-key", algorithm=JWT_ALGORITHM)


def _make_token_no_sub() -> str:
    """Create a valid token with no 'sub' claim."""
    now = datetime.now(timezone.utc)
    payload = {
        "email": "test@example.com",
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(hours=1),
    }
    return pyjwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def active_user():
    return _StubUser(id="usr_test000001", status="active")


@pytest.fixture()
def suspended_user():
    return _StubUser(id="usr_suspended01", status="suspended")


@pytest.fixture()
def deleted_user():
    return _StubUser(id="usr_deleted0001", status="active", deleted_at="2026-01-01T00:00:00Z")


@pytest.fixture()
def _patch_user_repo(monkeypatch, active_user):
    """Patch user_repo module functions for testing."""
    stub = _StubUserRepo(user=active_user, roles=["user"])
    import backend.app.db.repositories.user_repo as repo_mod
    monkeypatch.setattr(repo_mod, "get_user_by_id", stub.get_user_by_id)
    monkeypatch.setattr(repo_mod, "get_user_roles", stub.get_user_roles)
    return stub


# ---------------------------------------------------------------------------
# Tests — get_current_user
# ---------------------------------------------------------------------------


class TestGetCurrentUser:

    async def test_valid_token_returns_user(self, _patch_user_repo, active_user):
        """A valid JWT with matching user in DB returns the user."""
        token = _make_token(user_id=active_user.id)
        session = _StubSession()

        user = await get_current_user(token=token, session=session)
        assert user.id == active_user.id

    async def test_missing_token_raises_401(self):
        """No token raises 401."""
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=None, session=session)
        assert exc_info.value.status_code == 401
        assert "Not authenticated" in exc_info.value.detail

    async def test_expired_token_raises_401(self, _patch_user_repo):
        """Expired JWT raises 401."""
        token = _make_expired_token()
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 401
        assert "expired" in exc_info.value.detail.lower()

    async def test_invalid_token_raises_401(self, _patch_user_repo):
        """Token signed with wrong key raises 401."""
        token = _make_invalid_token()
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 401
        assert "Invalid token" in exc_info.value.detail

    async def test_token_without_sub_raises_401(self, _patch_user_repo):
        """Token missing 'sub' claim raises 401."""
        token = _make_token_no_sub()
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 401
        assert "Invalid token payload" in exc_info.value.detail

    async def test_user_not_found_raises_401(self, monkeypatch):
        """Valid token but user not in DB raises 401."""
        stub = _StubUserRepo(user=None)
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_by_id", stub.get_user_by_id)

        token = _make_token(user_id="usr_nonexistent")
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 401
        assert "User not found" in exc_info.value.detail

    async def test_deleted_user_raises_401(self, monkeypatch):
        """User with deleted_at set raises 401."""
        deleted = _StubUser(id="usr_deleted0001", status="active", deleted_at="2026-01-01T00:00:00Z")
        stub = _StubUserRepo(user=deleted)
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_by_id", stub.get_user_by_id)

        token = _make_token(user_id="usr_deleted0001")
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 401

    async def test_suspended_user_raises_403(self, monkeypatch):
        """Suspended user gets 403."""
        suspended = _StubUser(id="usr_suspended01", status="suspended")
        stub = _StubUserRepo(user=suspended)
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_by_id", stub.get_user_by_id)

        token = _make_token(user_id="usr_suspended01")
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, session=session)
        assert exc_info.value.status_code == 403
        assert "not active" in exc_info.value.detail.lower()

    async def test_malformed_token_string_raises_401(self, _patch_user_repo):
        """Completely garbage token raises 401."""
        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token="not.a.jwt.at.all", session=session)
        assert exc_info.value.status_code == 401


# ---------------------------------------------------------------------------
# Tests — get_optional_user
# ---------------------------------------------------------------------------


class TestGetOptionalUser:

    async def test_no_token_returns_none(self, _patch_user_repo):
        """No token returns None instead of raising."""
        session = _StubSession()
        result = await get_optional_user(token=None, session=session)
        assert result is None

    async def test_valid_token_returns_user(self, _patch_user_repo, active_user):
        """Valid token returns user just like get_current_user."""
        token = _make_token(user_id=active_user.id)
        session = _StubSession()
        result = await get_optional_user(token=token, session=session)
        assert result is not None
        assert result.id == active_user.id

    async def test_invalid_token_returns_none(self, _patch_user_repo):
        """Invalid token returns None instead of raising."""
        session = _StubSession()
        result = await get_optional_user(token="bad-token", session=session)
        assert result is None

    async def test_expired_token_returns_none(self, _patch_user_repo):
        """Expired token returns None."""
        token = _make_expired_token()
        session = _StubSession()
        result = await get_optional_user(token=token, session=session)
        assert result is None


# ---------------------------------------------------------------------------
# Tests — require_admin
# ---------------------------------------------------------------------------


class TestRequireAdmin:

    async def test_admin_user_passes(self, monkeypatch):
        """User with admin role passes through."""
        user = _StubUser(id="usr_admin00001", status="active")
        stub = _StubUserRepo(user=user, roles=["admin", "user"])
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_roles", stub.get_user_roles)

        session = _StubSession()
        result = await require_admin(user=user, session=session)
        assert result.id == "usr_admin00001"

    async def test_non_admin_raises_403(self, monkeypatch):
        """User without admin role gets 403."""
        user = _StubUser(id="usr_regular001", status="active")
        stub = _StubUserRepo(user=user, roles=["user"])
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_roles", stub.get_user_roles)

        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await require_admin(user=user, session=session)
        assert exc_info.value.status_code == 403
        assert "Admin access required" in exc_info.value.detail

    async def test_user_with_no_roles_raises_403(self, monkeypatch):
        """User with empty role list gets 403."""
        user = _StubUser(id="usr_noroles001", status="active")
        stub = _StubUserRepo(user=user, roles=[])
        import backend.app.db.repositories.user_repo as repo_mod
        monkeypatch.setattr(repo_mod, "get_user_roles", stub.get_user_roles)

        session = _StubSession()
        with pytest.raises(HTTPException) as exc_info:
            await require_admin(user=user, session=session)
        assert exc_info.value.status_code == 403
