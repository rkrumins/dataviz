"""``require_admin`` must not be fail-open.

Revocation is checked in two tiers. ``get_current_user`` checks the
tombstone on every authenticated request and does so FAIL-OPEN: an
unreachable backend logs and honours the JWT, because the token TTL is
still a floor and a Redis blip must not sign the whole platform out.
``requires(...)`` then runs a second, opt-in probe for the permissions
in ``_FAIL_CLOSED_PERMISSIONS``, where an unreachable backend is a 503
instead — "I cannot confirm this session is alive" should not read as
"carry on" when the thing being authorised is platform administration.

``require_admin`` gates ``system:admin``, which is in that set. It never
ran the probe. So its call sites — admin users, announcements,
ontologies, groups, stats-admin — were fail-open on the most sensitive
surface in the product, and during a Redis outage a session revoked
moments earlier kept full admin for the remainder of its access token.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.app.auth import dependencies as deps
from backend.app.services.revocation_service import RevocationBackendError


class _Claims:
    """Minimal stand-in — the probe reads only ``sid``."""

    def __init__(self, sid: str | None = "sess_1"):
        self.sid = sid


def _revoker(*, revoked: bool = False, raises: bool = False):
    class _Svc:
        async def is_revoked(self, sid: str) -> bool:
            if raises:
                raise RevocationBackendError("redis unreachable")
            return revoked

    return lambda: _Svc()


# ── the probe itself ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_live_session_passes(monkeypatch):
    monkeypatch.setattr(deps, "get_revocation_service", _revoker())
    await deps.assert_session_alive_or_503(
        _Claims(), permission="system:admin", user_id="u1",
    )  # no raise


@pytest.mark.asyncio
async def test_a_revoked_session_is_401(monkeypatch):
    monkeypatch.setattr(deps, "get_revocation_service", _revoker(revoked=True))
    with pytest.raises(HTTPException) as err:
        await deps.assert_session_alive_or_503(
            _Claims(), permission="system:admin", user_id="u1",
        )
    assert err.value.status_code == 401


@pytest.mark.asyncio
async def test_an_unreachable_backend_is_503_not_a_pass(monkeypatch):
    """The whole point. Fail-open here would mean a revoked admin keeps
    admin for the rest of their access-token lifetime."""
    monkeypatch.setattr(deps, "get_revocation_service", _revoker(raises=True))
    with pytest.raises(HTTPException) as err:
        await deps.assert_session_alive_or_503(
            _Claims(), permission="system:admin", user_id="u1",
        )
    assert err.value.status_code == 503


@pytest.mark.asyncio
async def test_a_token_with_no_sid_is_not_probed(monkeypatch):
    """Nothing to look up. Pre-sid tokens must not 503 their way out."""
    monkeypatch.setattr(deps, "get_revocation_service", _revoker(raises=True))
    await deps.assert_session_alive_or_503(
        _Claims(sid=None), permission="system:admin", user_id="u1",
    )  # no raise


# ── require_admin runs it ────────────────────────────────────────────

class _User:
    id = "u1"


def _request():
    class _R:
        pass

    return _R()


@pytest.mark.asyncio
async def test_require_admin_503s_when_revocation_is_unavailable(monkeypatch):
    """This is the regression. Before, an unreachable backend meant
    require_admin fell through to the permission test and let a
    still-claimed admin straight in."""
    monkeypatch.setattr(deps, "get_revocation_service", _revoker(raises=True))

    async def _claims(_request):
        return _Claims()

    monkeypatch.setattr(deps, "get_permission_claims", _claims)
    monkeypatch.setattr(deps, "has_permission", lambda c, p: True)

    with pytest.raises(HTTPException) as err:
        await deps.require_admin(_request(), user=_User())
    assert err.value.status_code == 503


@pytest.mark.asyncio
async def test_require_admin_401s_a_revoked_admin(monkeypatch):
    monkeypatch.setattr(deps, "get_revocation_service", _revoker(revoked=True))

    async def _claims(_request):
        return _Claims()

    monkeypatch.setattr(deps, "get_permission_claims", _claims)
    monkeypatch.setattr(deps, "has_permission", lambda c, p: True)

    with pytest.raises(HTTPException) as err:
        await deps.require_admin(_request(), user=_User())
    assert err.value.status_code == 401


@pytest.mark.asyncio
async def test_require_admin_still_admits_a_live_admin(monkeypatch):
    """Guards the guard: if the probe refused everything, the two tests
    above would pass for the wrong reason."""
    monkeypatch.setattr(deps, "get_revocation_service", _revoker())

    async def _claims(_request):
        return _Claims()

    monkeypatch.setattr(deps, "get_permission_claims", _claims)
    monkeypatch.setattr(deps, "has_permission", lambda c, p: True)

    user = _User()
    assert await deps.require_admin(_request(), user=user) is user


@pytest.mark.asyncio
async def test_a_live_non_admin_is_still_403(monkeypatch):
    """The probe runs first, so a non-admin must not be turned into a
    401 or 503 by it."""
    monkeypatch.setattr(deps, "get_revocation_service", _revoker())

    async def _claims(_request):
        return _Claims()

    monkeypatch.setattr(deps, "get_permission_claims", _claims)
    monkeypatch.setattr(deps, "has_permission", lambda c, p: False)

    with pytest.raises(HTTPException) as err:
        await deps.require_admin(_request(), user=_User())
    assert err.value.status_code == 403


def test_system_admin_is_in_the_fail_closed_set():
    """Pins the premise: require_admin gates system:admin, and that
    permission is declared fail-closed, so running the probe is
    consistency rather than a new policy."""
    assert "system:admin" in deps._FAIL_CLOSED_PERMISSIONS
