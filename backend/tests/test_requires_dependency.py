"""Integration tests for the ``requires(perm, scope)`` FastAPI dependency.

Uses a tiny ad-hoc FastAPI app rather than the full backend.app.main
app — the goal is to verify the dependency's behaviour (claims read,
revocation check, fail-open/fail-closed, 403/401 paths) in isolation.
The full backend's middleware (CSRF, etc.) is irrelevant here.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from backend.app.auth.dependencies import requires
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationBackendError,
    RevocationService,
    configure_revocation_service,
)
from backend.auth_service.core.tokens import create_access_token
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.interface import User
from backend.auth_service.service import LocalIdentityService


_ALICE = User(
    id="usr_alice",
    email="alice@example.com",
    first_name="Alice",
    last_name="A",
    role="user",
    status="active",
    auth_provider="local",
    created_at="",
    updated_at="",
)


def _make_token(claims: PermissionClaims) -> str:
    """Mint a real access JWT carrying the given claims."""
    return create_access_token(
        user_id=_ALICE.id,
        email=_ALICE.email,
        role=_ALICE.role,
        extra=claims.to_jwt_dict(),
    )


def _build_app(
    permission: str,
    *,
    workspace: str | None = None,
    backend=None,
) -> FastAPI:
    app = FastAPI()

    # Install our test revocation service (in-memory backend by default).
    configure_revocation_service(RevocationService(backend or InMemoryBackend()))

    # The ``requires`` dependency calls ``get_current_user`` which calls
    # ``identity_service.validate_session``. We install a stub that
    # accepts any non-empty token and returns Alice.
    class _StubIdentity:
        async def validate_session(self, token):
            return _ALICE if token else None

    app.state.identity_service = _StubIdentity()

    if workspace:
        @app.get(f"/widget/{{{workspace}}}")
        async def _ep(
            user: User = Depends(requires(permission, workspace=workspace)),
        ):
            return {"user_id": user.id}
    else:
        @app.get("/widget")
        async def _ep_g(user: User = Depends(requires(permission))):
            return {"user_id": user.id}

    return app


async def _client(app: FastAPI, *, cookies=None) -> AsyncClient:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    return AsyncClient(transport=transport, base_url="http://testserver", cookies=cookies)


# ── 401 paths ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_requires_returns_401_when_no_cookie():
    app = _build_app("workspaces:create")
    async with await _client(app) as c:
        r = await c.get("/widget")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_requires_returns_401_on_invalid_cookie():
    app = _build_app("workspaces:create")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: "not-a-real-jwt"}) as c:
        r = await c.get("/widget")
        assert r.status_code == 401


# ── 403 paths ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_requires_403_when_global_permission_missing():
    claims = PermissionClaims(sid="sess_a", global_perms=("workspace:view:read",))
    token = _make_token(claims)
    app = _build_app("workspaces:create")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget")
        assert r.status_code == 403
        assert "workspaces:create" in r.json()["detail"]


@pytest.mark.asyncio
async def test_requires_403_when_workspace_permission_missing():
    claims = PermissionClaims(
        sid="sess_a",
        ws_perms={"ws_a": ("workspace:view:read",)},
    )
    token = _make_token(claims)
    app = _build_app("workspace:view:edit", workspace="ws_id")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        # ws_a does NOT grant edit — expect 403.
        r = await c.get("/widget/ws_a")
        assert r.status_code == 403


# ── 200 paths ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_requires_200_with_global_permission():
    claims = PermissionClaims(sid="sess_a", global_perms=("workspaces:create",))
    token = _make_token(claims)
    app = _build_app("workspaces:create")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget")
        assert r.status_code == 200
        assert r.json() == {"user_id": _ALICE.id}


@pytest.mark.asyncio
async def test_requires_200_with_workspace_wildcard():
    claims = PermissionClaims(
        sid="sess_a",
        ws_perms={"ws_a": ("workspace:view:*",)},
    )
    token = _make_token(claims)
    app = _build_app("workspace:view:edit", workspace="ws_id")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget/ws_a")
        assert r.status_code == 200


@pytest.mark.asyncio
async def test_requires_200_for_global_admin_implicit_allow():
    claims = PermissionClaims(sid="sess_a", global_perms=("system:admin",))
    token = _make_token(claims)
    app = _build_app("workspace:view:delete", workspace="ws_id")
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget/ws_anywhere")
        assert r.status_code == 200


# ── revocation paths ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_requires_401_when_session_in_revocation_set():
    backend = InMemoryBackend()
    await backend.set_with_ttl("rbac:revoked:sess_a", 60)

    claims = PermissionClaims(sid="sess_a", global_perms=("workspaces:create",))
    token = _make_token(claims)

    app = _build_app("workspaces:create", backend=backend)
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget")
        assert r.status_code == 401
        assert "revoked" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_requires_503_on_redis_outage_for_fail_closed_perm():
    class BrokenBackend(InMemoryBackend):
        async def exists(self, key):
            raise RevocationBackendError("redis is down")

    claims = PermissionClaims(sid="sess_a", global_perms=("system:admin",))
    token = _make_token(claims)

    # system:admin is in _FAIL_CLOSED_PERMISSIONS → expect 503.
    app = _build_app("system:admin", backend=BrokenBackend())
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget")
        assert r.status_code == 503


@pytest.mark.asyncio
async def test_requires_200_on_redis_outage_for_fail_open_perm():
    class BrokenBackend(InMemoryBackend):
        async def exists(self, key):
            raise RevocationBackendError("redis is down")

    claims = PermissionClaims(
        sid="sess_a",
        ws_perms={"ws_a": ("workspace:view:read",)},
    )
    token = _make_token(claims)

    # workspace:view:read is fail-open: outage allows the request.
    app = _build_app("workspace:view:read", workspace="ws_id", backend=BrokenBackend())
    async with await _client(app, cookies={ACCESS_COOKIE_NAME: token}) as c:
        r = await c.get("/widget/ws_a")
        assert r.status_code == 200


# Reset the singleton service after the module so other tests aren't
# poisoned by an InMemoryBackend lingering from these tests.
@pytest.fixture(autouse=True)
def _restore_revocation_singleton():
    yield
    # Replace with a fresh in-memory instance (good default for tests).
    configure_revocation_service(RevocationService(InMemoryBackend()))


__all__: list[str] = []  # silence "imported but unused" in linters

_ = LocalIdentityService  # imported for parity with conftest expectations
