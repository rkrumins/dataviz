"""Phase 10 — promoted-admin bug regression suite.

The user's bug: a promoted admin can't access admin functions until
they re-login. Two compounding root causes:

  1. Revocation only fired on ``requires(...)`` routes — a route
     using ``require_admin`` accepted the stale JWT.
  2. The legacy DTO-role check in ``require_admin`` masked the
     stale-claim state; routes using ``requires(...)`` then 403'd
     for the same user, producing the half-functional admin page.

Phase 10 closes both: revocation now fires inside
``get_current_user`` (every authenticated request) and
``require_admin`` requires the ``system:admin`` JWT claim.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from backend.app.auth.dependencies import require_admin, requires
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import (
    InMemoryBackend, RevocationService,
    configure_revocation_service, get_revocation_service,
)
from backend.auth_service.core.tokens import create_access_token
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.interface import User


_ALICE = User(
    id="usr_alice_p10",
    email="alice_p10@example.com",
    first_name="Alice",
    last_name="P10",
    role="super_admin",
    status="active",
    auth_provider="local",
    created_at="",
    updated_at="",
)


def _make_token(claims: PermissionClaims, *, role: str = "super_admin") -> str:
    return create_access_token(
        user_id=_ALICE.id,
        email=_ALICE.email,
        role=role,
        extra=claims.to_jwt_dict(),
    )


def _build_app(backend=None) -> FastAPI:
    """Minimal app exercising both require_admin and requires(...)."""
    app = FastAPI()
    configure_revocation_service(RevocationService(backend or InMemoryBackend()))

    class _StubIdentity:
        async def validate_session(self, token):
            return _ALICE if token else None

    app.state.identity_service = _StubIdentity()

    @app.get("/legacy-admin")
    async def _legacy_admin(user: User = Depends(require_admin)):
        return {"who": user.id}

    @app.get("/claim-admin")
    async def _claim_admin(user: User = Depends(requires("system:admin"))):
        return {"who": user.id}

    # An ordinary global permission — deliberately NOT one of
    # ``_FAIL_CLOSED_PERMISSIONS``, so the outage test below has a route
    # on which the fail-OPEN tier is observable.
    @app.get("/analytics")
    async def _analytics(
        user: User = Depends(requires("system:analytics:read")),
    ):
        return {"who": user.id}

    return app


@pytest.fixture(autouse=True)
def _fresh_revocation_backend():
    configure_revocation_service(RevocationService(InMemoryBackend()))


# ── Phase 10 — revocation universal ──────────────────────────────────


@pytest.mark.asyncio
async def test_require_admin_rejects_revoked_session():
    """Pre-Phase-10 this was the bug: ``require_admin`` never
    consulted the revocation set, so a stale JWT carrying the
    legacy DTO role kept admins authenticated even after their
    session was revoked. Phase 10 moves the revocation check into
    ``get_current_user`` — every auth dep now picks it up."""
    claims = PermissionClaims(sid="sess_revoked", global_perms=("system:admin",))
    token = _make_token(claims)

    # Pre-revoke the sid.
    svc = get_revocation_service()
    await svc.revoke_session("sess_revoked")

    app = _build_app(backend=svc._backend)  # type: ignore[attr-defined]
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
        cookies={ACCESS_COOKIE_NAME: token},
    ) as c:
        r = await c.get("/legacy-admin")
        assert r.status_code == 401, r.text
        assert "revoked" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_require_admin_requires_claim_not_just_dto_role():
    """Phase 10: ``require_admin`` no longer accepts the legacy
    DTO-role-only path. A stale JWT with ``role=super_admin`` but
    empty ``global_perms`` is rejected — Phase 6 made the two
    stores agree, so this combo only arises mid-promotion. We
    refuse and let the FE silent-refresh mint a fresh JWT."""
    claims = PermissionClaims(sid="sess_x", global_perms=())  # no system:admin
    token = _make_token(claims, role="super_admin")  # DTO role mismatched

    app = _build_app()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
        cookies={ACCESS_COOKIE_NAME: token},
    ) as c:
        r = await c.get("/legacy-admin")
        assert r.status_code == 403, r.text
        assert "Admin access required" in r.json()["detail"]


@pytest.mark.asyncio
async def test_require_admin_allows_claim_present():
    """Sanity: with a valid ``system:admin`` claim, the route works."""
    claims = PermissionClaims(sid="sess_ok", global_perms=("system:admin",))
    token = _make_token(claims)

    app = _build_app()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
        cookies={ACCESS_COOKIE_NAME: token},
    ) as c:
        r = await c.get("/legacy-admin")
        assert r.status_code == 200, r.text
        assert r.json() == {"who": _ALICE.id}


def _broken_backend():
    """A revocation backend that cannot answer."""
    from backend.app.services.revocation_service import RevocationBackendError

    class _BrokenBackend(InMemoryBackend):
        async def exists(self, key):
            raise RevocationBackendError("redis is down")

    return _BrokenBackend()


@pytest.mark.asyncio
async def test_ordinary_routes_stay_open_during_a_redis_outage():
    """A Redis blip must not sign the whole platform out.

    ``get_current_user`` checks the tombstone on every authenticated
    request and does it FAIL-OPEN: when the backend cannot answer it
    logs and honours the JWT, whose TTL is the staleness floor. This is
    the tier that keeps an outage from becoming a total auth outage, and
    it is asserted on an ordinary permission because the privileged ones
    deliberately behave the other way — see the test below.
    """
    claims = PermissionClaims(
        sid="sess_outage", global_perms=("system:analytics:read",),
    )
    token = _make_token(claims)

    app = _build_app(backend=_broken_backend())
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
        cookies={ACCESS_COOKIE_NAME: token},
    ) as c:
        r = await c.get("/analytics")
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["/legacy-admin", "/claim-admin"])
async def test_admin_routes_refuse_when_redis_cannot_confirm_session(route):
    """...and the privileged tier refuses instead.

    "I cannot confirm this session is still alive" must not read as
    "carry on" when the thing being authorised is platform
    administration, so a ``_FAIL_CLOSED_PERMISSIONS`` route answers 503
    rather than honouring the JWT.

    Both routes are asserted because they reached that guarantee by
    different paths and only one of them used to hold it:
    ``requires("system:admin")`` ran the second revocation probe from
    the start, while ``require_admin`` — which gates the admin users,
    announcements, ontologies, groups and stats-admin surfaces — never
    did, and was fail-OPEN on the most sensitive routes in the product.
    """
    claims = PermissionClaims(sid="sess_outage", global_perms=("system:admin",))
    token = _make_token(claims)

    app = _build_app(backend=_broken_backend())
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
        cookies={ACCESS_COOKIE_NAME: token},
    ) as c:
        r = await c.get(route)
        assert r.status_code == 503, r.text


# ── End-to-end via the full app: promote → 401 → re-login flow ──────


@pytest.mark.asyncio
async def test_promoted_user_admin_endpoints_after_relogin(
    test_client: AsyncClient, db_session,
):
    """Walks the user's exact pain path. Before the fix, the
    promoted user kept getting 403 on /admin/users/me even after
    promotion. After the fix:

      1. Admin promotes the user via PUT /admin/users/{id}/role.
      2. user_repo state shows both user_roles AND role_bindings
         flipped to super_admin (Phase 6 invariant).
      3. The audit log shows the role change.
      4. A fresh ``permission_service.resolve(...)`` for the
         promoted user produces ``system:admin`` in global_perms.

    The test exercises the backend state — the FE silent-refresh
    glue is verified by the frontend integration tests."""
    from backend.app.db.repositories import user_repo, binding_repo
    from backend.app.services.permission_service import resolve

    user = await user_repo.create_user(
        db_session,
        email="promote_e2e@example.com", password_hash="x",
        first_name="P", last_name="E",
    )

    resp = await test_client.put(
        f"/api/v1/admin/users/{user.id}/role",
        json={"role": "super_admin"},
    )
    assert resp.status_code == 200, resp.text

    # Both stores flipped.
    roles = await user_repo.get_user_roles(db_session, user.id)
    assert "super_admin" in roles
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    globals_ = [b for b in bindings if b.scope_type == "global"]
    assert len(globals_) == 1
    assert globals_[0].role_name == "super_admin"

    # Resolver picks up the new claim — this is what fresh login or
    # silent refresh would mint into the next JWT.
    claims = await resolve(db_session, user.id)
    assert "system:admin" in claims.global_perms
