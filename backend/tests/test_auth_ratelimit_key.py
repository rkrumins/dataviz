"""``/auth/refresh`` must be bucketed per session, not per address.

Keying this endpoint on the client address is what turned a rate limit
into a logout. Behind a proxy ``get_remote_address`` returns the ingress
address, so every user in the deployment shared one 30/minute bucket;
users in a NAT'd office shared one regardless. Rotations cluster —
everyone who signed in at 09:00 rotates together — so a synchronised
herd hit the shared window, got a 429, and the SPA read any non-OK
refresh as "session gone".

The ``fam`` claim identifies one browser session, which is what the
limit is meant to protect, and survives both NAT and missing forwarding
headers.
"""
from __future__ import annotations

from starlette.requests import Request

from backend.auth_service.api.router import _refresh_family_key
from backend.auth_service.cookies import REFRESH_COOKIE_NAME
from backend.auth_service.core.tokens import create_refresh_token


def _request(cookie: str | None, client_ip: str = "10.0.0.1") -> Request:
    headers = []
    if cookie is not None:
        headers.append(
            (b"cookie", f"{REFRESH_COOKIE_NAME}={cookie}".encode()),
        )
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/refresh",
        "headers": headers,
        "client": (client_ip, 1234),
        "scheme": "http",
        "server": ("testserver", 80),
        "query_string": b"",
    })


def test_two_sessions_behind_one_address_get_separate_buckets():
    """The whole point: one office must not share one refresh budget."""
    alice, _ = create_refresh_token(user_id="u_alice")
    bob, _ = create_refresh_token(user_id="u_bob")

    shared_ip = "203.0.113.7"
    assert (
        _refresh_family_key(_request(alice, shared_ip))
        != _refresh_family_key(_request(bob, shared_ip))
    )


def test_one_session_keeps_its_bucket_across_addresses():
    """A laptop moving from office wifi to tethering is still one session."""
    token, claims = create_refresh_token(user_id="u_roaming")
    key_a = _refresh_family_key(_request(token, "203.0.113.7"))
    key_b = _refresh_family_key(_request(token, "198.51.100.2"))
    assert key_a == key_b == f"fam:{claims.family_id}"


def test_rotated_tokens_in_one_family_share_a_bucket():
    """Rotation must not hand a session a fresh budget every 30 seconds."""
    _, first = create_refresh_token(user_id="u_rot")
    rotated, second = create_refresh_token(
        user_id="u_rot", family_id=first.family_id,
    )
    assert second.jti != first.jti
    assert _refresh_family_key(_request(rotated)) == f"fam:{first.family_id}"


def test_expired_token_still_names_its_family():
    """An expired refresh is exactly when the bucket matters.

    Falling back to the address here would pile every expired session in
    the deployment back into the one bucket this change exists to empty.
    """
    token, claims = create_refresh_token(user_id="u_expired")
    # Mint one that expired an hour ago.
    stale, _ = create_refresh_token(
        user_id="u_expired",
        family_id=claims.family_id,
        expires_at_epoch=claims.exp - 8 * 24 * 3600,
    )
    assert _refresh_family_key(_request(stale)) == f"fam:{claims.family_id}"


def test_unusable_cookies_fall_back_to_the_address():
    """No cookie, or one we did not sign, cannot name a session."""
    assert _refresh_family_key(_request(None)) == "10.0.0.1"
    assert _refresh_family_key(_request("not-a-jwt")) == "10.0.0.1"


def test_a_forged_family_cannot_choose_its_bucket():
    """The key is read from a verified signature, not from the wire.

    Otherwise a caller could mint themselves a fresh bucket per request
    and the limit would be decorative.
    """
    import jwt as pyjwt

    forged = pyjwt.encode(
        {"sub": "u", "jti": "x", "fam": "attacker-chosen", "aud": "x", "iss": "x"},
        "not-the-signing-key",
        algorithm="HS256",
    )
    assert _refresh_family_key(_request(forged)) == "10.0.0.1"
