"""A forced password rotation has to be enforced by the API.

The bootstrap admin ships with a password that is printed in the README,
the quickstart compose file, and every setup doc. Until now the only
control was a log line asking the operator to change it.

The flag is carried as an access-token claim, and on the user record
every resolver reads, and checked by every resolver that authenticates a
request — ``get_current_user``, ``get_optional_user`` and
``get_permission_claims`` — so it costs no extra query. It is enforced
there rather than in the SPA because a client-side redirect is a
suggestion: anything holding the cookie could simply not follow it.

These tests drive the dependencies directly. The ``test_client`` fixture
overrides them wholesale, so going through it would exercise the
overrides rather than the gate; ``test_forced_password_change_routes.py``
signs in for real and walks the routes.
"""
import pytest
from fastapi import HTTPException

from backend.app.auth import dependencies as deps


class _Req:
    """Enough of a Request for the exemption check."""

    def __init__(self, path: str, method: str = "GET"):
        self.method = method
        self.url = type("U", (), {"path": path})()


# ── The allowlist ────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path", sorted(deps._PASSWORD_CHANGE_ALLOWED))
def test_allowlisted_requests_are_exempt(method, path):
    """Everything the change screen itself needs stays reachable."""
    assert deps._password_change_exempt(_Req(path, method)) is True


def test_the_method_matters_too():
    """Reading your profile is part of the change screen; editing it is
    not."""
    assert deps._password_change_exempt(_Req("/api/v1/users/me", "GET")) is True
    assert deps._password_change_exempt(_Req("/api/v1/users/me", "PATCH")) is False
    assert deps._password_change_exempt(
        _Req("/api/v1/me/identities", "DELETE")) is False


@pytest.mark.parametrize("path", [
    "/api/v1/admin/users",
    "/api/v1/workspaces",
    "/api/v1/users/me/activity",
    "/api/v1/users/me/sessions/revoke-all",
    "/api/v1/me/permissions",
])
def test_everything_else_is_gated(path):
    """Including neighbours of the allowlisted routes.

    ``/users/me`` is exempt and ``/users/me/activity`` is not — a
    prefix match would have quietly opened the whole subtree.
    """
    assert deps._password_change_exempt(_Req(path)) is False


def test_trailing_slash_does_not_bypass_the_gate():
    assert deps._password_change_exempt(_Req("/api/v1/users/me/")) is True
    assert deps._password_change_exempt(_Req("/api/v1/admin/users/")) is False


# ── The gate ─────────────────────────────────────────────────────────

async def test_flagged_session_is_refused_with_a_structured_error(monkeypatch):
    """403 with a machine-readable envelope, so the SPA can route on it
    rather than pattern-matching a sentence."""
    _install_fake_session(monkeypatch, must_change=True)

    with pytest.raises(HTTPException) as exc:
        await deps.get_current_user(_request_for("/api/v1/admin/users"))

    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "password_change_required"


async def test_flagged_session_may_still_change_its_password(monkeypatch):
    """The one door that has to stay open, or the account is bricked."""
    _install_fake_session(monkeypatch, must_change=True)
    user = await deps.get_current_user(
        _request_for("/api/v1/users/me/password", "POST"))
    assert user.id == "usr_flagged"


async def test_unflagged_session_is_untouched(monkeypatch):
    _install_fake_session(monkeypatch, must_change=False)
    user = await deps.get_current_user(_request_for("/api/v1/admin/users"))
    assert user.id == "usr_flagged"


async def test_an_optional_user_is_held_too(monkeypatch):
    """``get_optional_user`` means "may be anonymous", not "may skip the
    hold". Thirty-odd view routes sign in only through it."""
    _install_fake_session(monkeypatch, must_change=True)
    with pytest.raises(HTTPException) as exc:
        await deps.get_optional_user(_request_for("/api/v1/views", "POST"))
    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "password_change_required"

    user = await deps.get_optional_user(_request_for("/api/v1/users/me"))
    assert user.id == "usr_flagged"


async def test_claims_alone_are_held_too(monkeypatch):
    """A route can authorise on the permission claims without resolving
    the user at all."""
    _install_fake_session(monkeypatch, must_change=True)
    with pytest.raises(HTTPException) as exc:
        await deps.get_permission_claims(_request_for("/api/v1/views", "POST"))
    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "password_change_required"


async def test_a_requirement_set_after_sign_in_holds_at_once(monkeypatch):
    """The token was minted before the account was flagged, so it carries
    no claim; the user record, read on every request, does."""
    _install_fake_session(monkeypatch, must_change=False, flagged_record=True)
    for resolve in (deps.get_current_user, deps.get_optional_user):
        with pytest.raises(HTTPException) as exc:
            await resolve(_request_for("/api/v1/admin/users"))
        assert exc.value.detail["error"] == "password_change_required"


async def test_a_revoked_session_is_signed_out_not_held(monkeypatch):
    """Changing the password revokes every session. Another tab still
    holding the old, flagged token must be sent to sign in, not to a
    change screen it can no longer use."""
    _install_fake_session(monkeypatch, must_change=True)

    async def _revoked(*_a, **_k):
        return True

    monkeypatch.setattr(deps, "_tombstoned", _revoked)
    with pytest.raises(HTTPException) as exc:
        await deps.get_current_user(_request_for("/api/v1/admin/users"))
    assert exc.value.status_code == 401
    assert await deps.get_optional_user(_request_for("/api/v1/views")) is None


# ── Fixtures ─────────────────────────────────────────────────────────

def _request_for(path: str, method: str = "GET"):
    class _R:
        url = None
        app = type("A", (), {"state": type("S", (), {"identity_service": None})()})()
        cookies = {}
    r = _R()
    r.method = method
    r.url = type("U", (), {"path": path})()
    return r


def _install_fake_session(
    monkeypatch, *, must_change: bool, flagged_record: bool = False,
):
    """Stub out the token decode and the session validation.

    We are testing the gate, not JWT plumbing — ``mcp`` is the only
    claim that matters here, plus an inline ``ws`` so the claims
    resolver has no store to consult. ``flagged_record`` sets the flag on
    the user record without putting it in the token.
    """
    from backend.auth_service.interface import User

    fake = User(
        id="usr_flagged", email="flagged@example.com",
        firstName="Flag", lastName="Ged", role="user", status="active",
        mustChangePassword=flagged_record,
    )

    class _Svc:
        async def validate_session(self, _token):
            return fake

    monkeypatch.setattr(deps, "_identity_service", lambda _req: _Svc())
    monkeypatch.setattr(deps, "read_access_cookie", lambda _req: "a.token.value")
    monkeypatch.setattr(
        deps, "decode_token",
        lambda _tok: {
            "sid": "sess_test", "sub": "usr_flagged", "ws": {},
            **({"mcp": True} if must_change else {}),
        },
    )
