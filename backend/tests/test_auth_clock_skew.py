"""Tokens must survive the clock skew between the pods that handle them.

Every replica mints tokens and every replica verifies them, so ``exp``,
``iat`` and ``nbf`` are compared across two machines' clocks. Verified as
exact boundaries, a pod running a second ahead of the one that minted a
token rejects a token that has not expired — and a token minted a second
in the future is rejected outright as not-yet-valid.

The symptom is a user signed out for no reason, on a schedule nobody can
reproduce, because it depends on which of N pods answered. The IdP path
allowed for this from the start (``oidc.py`` validates provider claims
with a leeway); we did not extend the same tolerance to our own tokens.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest

from backend.auth_service.core import tokens as tokens_module
from backend.auth_service.core.config import (
    CLOCK_SKEW_LEEWAY_SECONDS,
    JWT_ALGORITHM,
    JWT_AUDIENCE,
    JWT_ISSUER,
    JWT_SECRET_KEY,
)


def _access_token_at(*, exp_offset_s: float, iat_offset_s: float = -60) -> str:
    """Mint an access token with hand-placed ``iat``/``exp``.

    Offsets are relative to now, so a negative ``exp_offset_s`` is a
    token that has already expired and a positive ``iat_offset_s`` is one
    minted by a pod whose clock runs fast.
    """
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": "u1",
            "email": "a@b.c",
            "role": "user",
            "iss": JWT_ISSUER,
            "aud": JWT_AUDIENCE,
            "iat": now + timedelta(seconds=iat_offset_s),
            "exp": now + timedelta(seconds=exp_offset_s),
        },
        JWT_SECRET_KEY,
        algorithm=JWT_ALGORITHM,
    )


def test_leeway_is_configured():
    """Nothing below tests anything if the leeway is zero."""
    assert CLOCK_SKEW_LEEWAY_SECONDS > 0


def test_token_just_past_expiry_still_verifies():
    """The case: the minting pod's clock is behind the verifying pod's.

    The token has not expired by the clock that issued it, so signing
    the user out here is wrong.
    """
    token = _access_token_at(exp_offset_s=-(CLOCK_SKEW_LEEWAY_SECONDS / 2))
    assert tokens_module.decode_token(token)["sub"] == "u1"


def test_token_well_past_expiry_is_still_rejected():
    """The leeway is a tolerance, not an extension.

    If this passes, the leeway has been widened into a way for expired
    tokens to keep working — which is what the revocation tombstone is
    sized against.
    """
    token = _access_token_at(exp_offset_s=-(CLOCK_SKEW_LEEWAY_SECONDS + 30))
    with pytest.raises(jwt.ExpiredSignatureError):
        tokens_module.decode_token(token)


def test_token_minted_slightly_in_the_future_is_accepted():
    """The other direction, and the one that fails hardest.

    A token whose ``iat`` is ahead of the verifier's clock raises
    ImmatureSignatureError — a token that is not expired, not forged,
    and rejected. Without leeway a pod one second fast makes every
    freshly minted token unusable on its neighbours.
    """
    token = _access_token_at(
        exp_offset_s=900, iat_offset_s=CLOCK_SKEW_LEEWAY_SECONDS / 2,
    )
    assert tokens_module.decode_token(token)["sub"] == "u1"


def test_refresh_tokens_get_the_same_tolerance():
    """A refresh token rejected on a boundary is a forced re-login —
    the worst place for this to be strict."""
    token, claims = tokens_module.create_refresh_token("u1")
    assert tokens_module.decode_refresh_token(token).sub == claims.sub

    stale = jwt.encode(
        {
            "sub": "u1",
            "iss": JWT_ISSUER,
            "aud": f"{JWT_AUDIENCE}:refresh",
            "jti": "j1",
            "fam": "f1",
            "iat": datetime.now(timezone.utc) - timedelta(seconds=120),
            "exp": datetime.now(timezone.utc)
            - timedelta(seconds=CLOCK_SKEW_LEEWAY_SECONDS / 2),
        },
        JWT_SECRET_KEY,
        algorithm=JWT_ALGORITHM,
    )
    assert tokens_module.decode_refresh_token(stale).sub == "u1"


def test_the_revocation_window_covers_the_leeway():
    """The coupling, asserted where someone changing the leeway will see it.

    A token is honoured until ``exp + leeway``. The Redis tombstone that
    makes a forced sign-out take effect must outlive that, or revocation
    silently stops working for the last stretch of every token.
    """
    from backend.app.services.revocation_service import REVOCATION_TTL_SECONDS
    from backend.auth_service.core.config import JWT_EXPIRY_MINUTES

    assert REVOCATION_TTL_SECONDS >= (
        JWT_EXPIRY_MINUTES * 60 + CLOCK_SKEW_LEEWAY_SECONDS
    )
