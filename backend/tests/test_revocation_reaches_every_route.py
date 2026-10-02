"""A revoked session is refused on every route, not only on some.

Signing out, a password reset, a suspension's cutoff and a role change all
tombstone the session's ``sid``. ``get_current_user`` checked the tombstone;
``get_optional_user`` and ``get_permission_claims`` did not — and the
routes that authorise with that pair kept honouring the old token, with
its old claims, until it expired.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend.app.auth import dependencies as deps
from backend.app.services import revocation_service as revocation_mod
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationBackendError,
    RevocationService,
)
from backend.auth_service.cookies import ACCESS_COOKIE_NAME
from backend.auth_service.core.tokens import create_access_token
from backend.auth_service.interface import User

_USER = "usr_revoked_everywhere"
_SID = "sess_revoked_everywhere"


def _token() -> str:
    claims = PermissionClaims(sid=_SID, global_perms=("user:read",))
    return create_access_token(_USER, "a@b.c", "user", extra=claims.to_jwt_dict())


def _request(token: str) -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/api/v1/views",
        "headers": [(b"cookie", f"{ACCESS_COOKIE_NAME}={token}".encode())],
        "query_string": b"", "client": ("10.0.0.1", 1234),
    })


class _Identity:
    async def validate_session(self, token):
        return User(id=_USER, email="a@b.c", first_name="A", last_name="B",
                    role="user", status="active") if token else None


@pytest.fixture()
def store(monkeypatch) -> RevocationService:
    svc = RevocationService(InMemoryBackend())
    monkeypatch.setattr(revocation_mod, "_service", svc, raising=False)
    monkeypatch.setattr(deps, "get_revocation_service", lambda: svc)
    monkeypatch.setattr(deps, "_identity_service", lambda request: _Identity())
    return svc


async def _live(store: RevocationService) -> None:
    await store.record_session(
        _USER, _SID,
        claims=PermissionClaims(sid=_SID, ws_perms={}).to_session_dict(),
    )


async def test_claims_are_refused_for_a_revoked_session(store):
    await _live(store)
    await store.revoke_session(_SID)

    with pytest.raises(HTTPException) as exc:
        await deps.get_permission_claims(_request(_token()))
    assert exc.value.status_code == 401


async def test_claims_are_served_for_a_live_session(store):
    await _live(store)
    claims = await deps.get_permission_claims(_request(_token()))
    assert claims.sid == _SID


async def test_an_optional_user_is_anonymous_once_revoked(store):
    await _live(store)
    request = _request(_token())
    assert (await deps.get_optional_user(request)).id == _USER

    await store.revoke_session(_SID)
    assert await deps.get_optional_user(request) is None


async def test_an_unreachable_store_still_honours_the_token(store, monkeypatch):
    """Fail-open, as on every ordinary request: the token's short lifetime
    is the floor, and a Redis blip must not sign everyone out."""
    async def _boom(sid):
        raise RevocationBackendError("down")

    monkeypatch.setattr(store, "is_revoked", _boom)
    assert (await deps.get_optional_user(_request(_token()))).id == _USER
