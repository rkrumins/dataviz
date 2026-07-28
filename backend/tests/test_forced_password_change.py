"""A forced password rotation has to be enforced by the API.

The bootstrap admin ships with a password that is printed in the README,
the quickstart compose file, and every setup doc. Until now the only
control was a log line asking the operator to change it.

The flag is carried as an access-token claim and checked in
``get_current_user``, so it costs no extra query — that function already
decodes the token to read ``sid``. It is enforced there rather than in
the SPA because a client-side redirect is a suggestion: anything holding
the cookie could simply not follow it.

These tests drive the dependency directly. The ``test_client`` fixture
overrides ``get_current_user`` wholesale, so going through it would
exercise the override rather than the gate.
"""
import pytest
from fastapi import HTTPException

from backend.app.auth import dependencies as deps


class _Req:
    """Enough of a Request for the exemption check."""

    def __init__(self, path: str):
        self.url = type("U", (), {"path": path})()


# ── The allowlist ────────────────────────────────────────────────────

@pytest.mark.parametrize("path", sorted(deps._PASSWORD_CHANGE_ALLOWED_PATHS))
def test_allowlisted_paths_are_exempt(path):
    """Everything the change screen itself needs stays reachable."""
    assert deps._password_change_exempt(_Req(path)) is True


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
    user = await deps.get_current_user(_request_for("/api/v1/users/me/password"))
    assert user.id == "usr_flagged"


async def test_unflagged_session_is_untouched(monkeypatch):
    _install_fake_session(monkeypatch, must_change=False)
    user = await deps.get_current_user(_request_for("/api/v1/admin/users"))
    assert user.id == "usr_flagged"


# ── Fixtures ─────────────────────────────────────────────────────────

def _request_for(path: str):
    class _R:
        url = None
        app = type("A", (), {"state": type("S", (), {"identity_service": None})()})()
        cookies = {}
    r = _R()
    r.url = type("U", (), {"path": path})()
    return r


def _install_fake_session(monkeypatch, *, must_change: bool):
    """Stub out the token decode and the session validation.

    We are testing the gate, not JWT plumbing — ``mcp`` is the only
    claim that matters here.
    """
    from backend.auth_service.interface import User

    fake = User(
        id="usr_flagged", email="flagged@example.com",
        firstName="Flag", lastName="Ged", role="user", status="active",
    )

    class _Svc:
        async def validate_session(self, _token):
            return fake

    monkeypatch.setattr(deps, "_identity_service", lambda _req: _Svc())
    monkeypatch.setattr(deps, "read_access_cookie", lambda _req: "a.token.value")
    monkeypatch.setattr(
        deps, "decode_token",
        lambda _tok: {"sid": "sess_test", **({"mcp": True} if must_change else {})},
    )
