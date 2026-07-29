"""Signing-key ring — rotating ``JWT_SECRET_KEY`` must not log users out.

Before the ring, verification accepted exactly one key. Any change to
``JWT_SECRET_KEY`` — a redeploy from a different ``.env.deploy``, a
re-run of ``deploy.sh setup``, a rotation — invalidated every
outstanding session the instant it landed, and during a rolling update
pods holding the old and new key both served traffic, so the same user
flipped between authenticated and 401 with no session affinity to pin
them to one pod.

``JWT_SECRET_KEY_PREVIOUS`` keeps retired keys valid for VERIFICATION
only, so a rotation drains instead of cutting over.
"""
from __future__ import annotations

import importlib
import sys

import jwt
import pytest


_OLD = "old-signing-key-" + "a" * 32
_NEW = "new-signing-key-" + "b" * 32

_MODULES = (
    "backend.auth_service.core.tokens",
    "backend.auth_service.core.config",
)


def _reload_auth(monkeypatch, *, secret: str, previous: str | None = None):
    """Re-import config+tokens under a specific key configuration.

    Both modules resolve their state at import, so the reload is what
    makes a key change observable inside a single test process.
    """
    monkeypatch.setenv("JWT_SECRET_KEY", secret)
    if previous is None:
        monkeypatch.delenv("JWT_SECRET_KEY_PREVIOUS", raising=False)
    else:
        monkeypatch.setenv("JWT_SECRET_KEY_PREVIOUS", previous)
    for name in _MODULES:
        sys.modules.pop(name, None)
    return importlib.import_module("backend.auth_service.core.tokens")


@pytest.fixture(autouse=True)
def _restore_modules():
    """Put the exact module objects back after each test.

    Re-importing is not enough: modules that did ``from ... import
    decode_token`` at import time keep a reference to the ORIGINAL
    function, so a fresh import would leave ``sys.modules`` and those
    call sites disagreeing about which signing key is in force — which
    surfaces as unrelated auth tests failing later in the session.
    """
    saved = {name: sys.modules.get(name) for name in _MODULES}
    yield
    for name, module in saved.items():
        if module is not None:
            sys.modules[name] = module
        else:
            sys.modules.pop(name, None)


def test_token_survives_rotation_while_old_key_is_retained(monkeypatch):
    tokens = _reload_auth(monkeypatch, secret=_OLD)
    token = tokens.create_access_token("u1", "a@b.c", "user")

    rotated = _reload_auth(monkeypatch, secret=_NEW, previous=_OLD)
    assert rotated.decode_token(token)["sub"] == "u1"


def test_token_is_rejected_once_the_old_key_leaves_the_ring(monkeypatch):
    tokens = _reload_auth(monkeypatch, secret=_OLD)
    token = tokens.create_access_token("u1", "a@b.c", "user")

    rotated = _reload_auth(monkeypatch, secret=_NEW)
    with pytest.raises(jwt.InvalidSignatureError) as excinfo:
        rotated.decode_token(token)
    # The whole point of the classification: this is unrecoverable, so
    # the caller evicts the cookie rather than refreshing forever.
    assert rotated.is_foreign_token_error(excinfo.value)


def test_new_tokens_are_signed_with_the_active_key_only(monkeypatch):
    """A retired key must never sign — only verify."""
    rotated = _reload_auth(monkeypatch, secret=_NEW, previous=_OLD)
    token = rotated.create_access_token("u1", "a@b.c", "user")

    from backend.auth_service.core import config

    assert jwt.get_unverified_header(token)["kid"] == config.key_id(_NEW)
    # Dropping the retired key cannot affect a freshly minted token.
    reloaded = _reload_auth(monkeypatch, secret=_NEW)
    assert reloaded.decode_token(token)["sub"] == "u1"


def test_kid_header_is_present_and_not_the_secret(monkeypatch):
    tokens = _reload_auth(monkeypatch, secret=_OLD)
    token = tokens.create_access_token("u1", "a@b.c", "user")

    kid = jwt.get_unverified_header(token)["kid"]
    assert kid and _OLD not in kid
    assert len(kid) == 8


def test_token_without_kid_still_verifies(monkeypatch):
    """Tokens minted before the ring existed carry no ``kid``.

    They must keep working, otherwise deploying this change would
    itself log every active user out — the exact failure it fixes.
    """
    tokens = _reload_auth(monkeypatch, secret=_OLD)
    legacy = jwt.encode(
        {
            "sub": "u1",
            "iss": tokens.JWT_ISSUER,
            "aud": tokens.JWT_AUDIENCE,
        },
        _OLD,
        algorithm="HS256",
    )
    assert "kid" not in jwt.get_unverified_header(legacy)
    assert tokens.decode_token(legacy)["sub"] == "u1"


def test_all_token_families_honour_the_ring(monkeypatch):
    """Rotation must not fix access tokens while breaking invites.

    Every family signs through the same helper, so this pins that they
    stay in step.
    """
    tokens = _reload_auth(monkeypatch, secret=_OLD)
    access = tokens.create_access_token("u1", "a@b.c", "user")
    refresh, _claims = tokens.create_refresh_token("u1")
    invite, _exp = tokens.create_invite_token("user", "admin")
    link = tokens.create_link_intent_token(user_id="u1", provider_id="p1")

    rotated = _reload_auth(monkeypatch, secret=_NEW, previous=_OLD)
    assert rotated.decode_token(access)["sub"] == "u1"
    assert rotated.decode_refresh_token(refresh).sub == "u1"
    assert rotated.decode_invite_token(invite)["role"] == "user"
    assert rotated.decode_link_intent_token(link)["user_id"] == "u1"


def test_expiry_is_reported_as_expiry_not_signature_failure(monkeypatch):
    """A stale token must stay distinguishable from a foreign one.

    If the ring collapsed expiry into a signature error, the frontend's
    silent refresh would be replaced by a forced re-login every five
    minutes.
    """
    from datetime import datetime, timedelta, timezone

    tokens = _reload_auth(monkeypatch, secret=_NEW, previous=_OLD)
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    stale = jwt.encode(
        {
            "sub": "u1",
            "iss": tokens.JWT_ISSUER,
            "aud": tokens.JWT_AUDIENCE,
            "iat": past - timedelta(minutes=5),
            "exp": past,
        },
        _NEW,
        algorithm="HS256",
    )
    with pytest.raises(jwt.ExpiredSignatureError) as excinfo:
        tokens.decode_token(stale)
    assert not tokens.is_foreign_token_error(excinfo.value)


def test_retired_key_below_the_length_floor_is_refused(monkeypatch):
    """Retired keys are still trusted, so they carry the same floor."""
    from backend.auth_service.core import config

    monkeypatch.setenv("JWT_SECRET_KEY", _NEW)
    monkeypatch.setenv("JWT_SECRET_KEY_PREVIOUS", "too-short")
    with pytest.raises(config.MissingSigningSecret):
        config._resolve_retired_secrets()


def test_blank_and_duplicate_entries_are_ignored(monkeypatch):
    """Operators rotate by prepending; trailing commas and a repeat of
    the active key must not produce redundant ring entries."""
    from backend.auth_service.core import config

    monkeypatch.setenv("JWT_SECRET_KEY", _NEW)
    monkeypatch.setenv(
        "JWT_SECRET_KEY_PREVIOUS", f" {_OLD} , , {_OLD} , {config.JWT_SECRET_KEY}"
    )
    assert config._resolve_retired_secrets() == (_OLD,)
