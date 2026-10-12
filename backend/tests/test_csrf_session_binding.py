"""A CSRF token proves which session it was minted for.

Plain double-submit compares the cookie against the header and stops.
That proves the sender could read the cookie — but not that the cookie
is *theirs*. Anyone able to write a cookie into the victim's jar for
this domain sets ``nx_csrf`` to a value of their own choosing and sends
the matching header; the comparison succeeds and the victim's
``nx_access`` rides along automatically.

That is not a remote precondition here. ``nx_csrf`` is ``Path=/`` with
no ``__Host-`` prefix, and ``AUTH_COOKIE_DOMAIN`` exists specifically to
share the cookie jar across subdomains, so any XSS or takeover on a
sibling host under the shared parent is enough.

The nonce is now bound to the session's ``sid`` under the signing key.
The attacker can still pick a nonce; they cannot produce its tag for
somebody else's ``sid``.
"""
from __future__ import annotations

import secrets

import pytest

from backend.auth_service.csrf import mint_csrf_token, verify_csrf_token


# ── Binding ──────────────────────────────────────────────────────────

def test_a_token_verifies_against_the_session_it_was_minted_for():
    token = mint_csrf_token("sess_alice")
    assert verify_csrf_token(token, "sess_alice") is True


def test_a_token_minted_for_another_session_is_refused():
    """The attacker's own, perfectly valid, token."""
    stolen = mint_csrf_token("sess_mallory")
    assert verify_csrf_token(stolen, "sess_alice") is False


def test_an_attacker_chosen_value_is_refused():
    """The cookie-tossing case: a value never minted by us at all.

    Under plain double-submit this passed, because the only question
    asked was whether the cookie and the header matched — and the
    attacker controls both.
    """
    planted = secrets.token_urlsafe(32)
    assert verify_csrf_token(planted, "sess_alice") is False


def test_a_forged_tag_is_refused():
    nonce = secrets.token_urlsafe(32)
    assert verify_csrf_token(f"{nonce}.{'a' * 32}", "sess_alice") is False


def test_a_tag_lifted_onto_a_different_nonce_is_refused():
    """The tag covers the nonce, not just the sid."""
    _nonce_a, _, tag_a = mint_csrf_token("sess_alice").partition(".")
    other_nonce = secrets.token_urlsafe(32)
    assert verify_csrf_token(f"{other_nonce}.{tag_a}", "sess_alice") is False


def test_two_mints_for_one_session_differ():
    """Rotation must produce a fresh value, not a deterministic one."""
    assert mint_csrf_token("sess_alice") != mint_csrf_token("sess_alice")


# ── The no-sid fallback ──────────────────────────────────────────────

def test_a_session_with_no_sid_falls_back_to_plain_double_submit():
    """Not a hole: whether a sid exists is decided by the victim's
    signed access token, which an attacker cannot alter."""
    assert verify_csrf_token(secrets.token_urlsafe(32), None) is True


def test_an_empty_token_is_always_refused():
    assert verify_csrf_token("", "sess_alice") is False
    assert verify_csrf_token("", None) is False


def test_a_pre_session_mint_is_unbound():
    token = mint_csrf_token(None)
    assert "." not in token


# ── Key rotation ─────────────────────────────────────────────────────

def test_a_token_survives_a_signing_key_rotation(monkeypatch):
    """A retired key still verifies, as it does for JWTs.

    Otherwise rotating ``JWT_SECRET_KEY`` would 403 every write in
    flight — the exact mass-disruption ``JWT_SECRET_KEY_PREVIOUS``
    exists to prevent.
    """
    # Patch the config object ``csrf`` itself holds, not the one this
    # test file imported. ``test_auth_environment_isolation`` pops
    # ``backend.auth_service.core.config`` out of ``sys.modules`` and
    # re-imports it, so after that suite runs the two names can be
    # different module objects — and patching the wrong one leaves mint
    # and verify both reading the real ring, which passes every
    # assertion here except the last one.
    from backend.auth_service import csrf as csrf_module

    config = csrf_module.config

    old_key = "o" * 48
    new_key = "n" * 48

    monkeypatch.setattr(config, "JWT_SECRET_KEY", old_key, raising=False)
    monkeypatch.setattr(
        config, "JWT_VERIFICATION_KEYS", (("old", old_key),), raising=False,
    )
    minted_under_old = mint_csrf_token("sess_alice")

    # Rotate: new key signs, old key still verifies.
    monkeypatch.setattr(config, "JWT_SECRET_KEY", new_key, raising=False)
    monkeypatch.setattr(
        config, "JWT_VERIFICATION_KEYS",
        (("new", new_key), ("old", old_key)), raising=False,
    )
    assert verify_csrf_token(minted_under_old, "sess_alice") is True

    # Once the old key is retired for good, it stops verifying.
    monkeypatch.setattr(
        config, "JWT_VERIFICATION_KEYS", (("new", new_key),), raising=False,
    )
    assert verify_csrf_token(minted_under_old, "sess_alice") is False
