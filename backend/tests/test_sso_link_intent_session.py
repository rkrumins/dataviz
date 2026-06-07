"""H2: the SSO callback must re-validate the live session before honouring
a link-intent cookie.

``_resolve_link_intent`` returns the cookie's user_id only when it matches
the user of the current access-cookie session. A replayed/stolen link-intent
cookie presented in a different (or absent) session must be dropped, so an
IdP identity can never be bound to an account the caller does not control.
"""
from types import SimpleNamespace

import pytest

from backend.auth_service.api.router import _resolve_link_intent
from backend.auth_service.core.tokens import create_link_intent_token
from backend.auth_service.cookies import (
    ACCESS_COOKIE_NAME,
    LINK_INTENT_COOKIE_NAME,
)

PROVIDER_ID = "idp_abc123"


def _request(*, link_user_id=None, access_token=None):
    cookies = {}
    if link_user_id is not None:
        cookies[LINK_INTENT_COOKIE_NAME] = create_link_intent_token(
            user_id=link_user_id, provider_id=PROVIDER_ID,
        )
    if access_token is not None:
        cookies[ACCESS_COOKIE_NAME] = access_token
    return SimpleNamespace(cookies=cookies)


def _svc(session_user_id):
    async def validate_session(access_token):
        if access_token is None or session_user_id is None:
            return None
        return SimpleNamespace(id=session_user_id)
    return SimpleNamespace(validate_session=validate_session)


@pytest.mark.asyncio
async def test_intent_honoured_when_session_matches():
    req = _request(link_user_id="usr_alice", access_token="tok")
    svc = _svc("usr_alice")
    assert await _resolve_link_intent(req, svc, provider_id=PROVIDER_ID) == "usr_alice"


@pytest.mark.asyncio
async def test_intent_dropped_when_session_is_different_user():
    # Attacker (session = bob) replays alice's link-intent cookie.
    req = _request(link_user_id="usr_alice", access_token="tok")
    svc = _svc("usr_bob")
    assert await _resolve_link_intent(req, svc, provider_id=PROVIDER_ID) is None


@pytest.mark.asyncio
async def test_intent_dropped_when_no_active_session():
    req = _request(link_user_id="usr_alice", access_token=None)
    svc = _svc(None)
    assert await _resolve_link_intent(req, svc, provider_id=PROVIDER_ID) is None


@pytest.mark.asyncio
async def test_no_intent_cookie_returns_none():
    req = _request(link_user_id=None, access_token="tok")
    svc = _svc("usr_alice")
    assert await _resolve_link_intent(req, svc, provider_id=PROVIDER_ID) is None
