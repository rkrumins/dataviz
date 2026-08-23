"""Configurations that would leave the app unprotected must not boot.

Each of these was reachable by setting one environment variable, took
effect silently, and left nothing in any log saying the protection was
gone. Several were emergency levers that are perfectly reasonable to
have — the problem was that a lever left down looked exactly like one
nobody pulled.
"""
from __future__ import annotations

import pytest

from backend.app.auth.dependencies import (
    RBAC_ENFORCEMENT_FLAGS,
    assert_rbac_enforcement_intact,
)
from backend.auth_service.core import config as auth_config


# ── RBAC enforcement kill-switches ───────────────────────────────────

@pytest.mark.parametrize("flag", RBAC_ENFORCEMENT_FLAGS)
def test_production_refuses_to_start_with_enforcement_disabled(
    flag, monkeypatch,
):
    """`RBAC_ENFORCE_VIEWS=false` is not "less strict".

    It guards nineteen checks in views.py including the object-level
    `can_read_view`, on routes that take `get_optional_user` and
    therefore never 401. Off, it is the only authorization on that
    surface, gone.
    """
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv(flag, "false")
    with pytest.raises(RuntimeError) as err:
        assert_rbac_enforcement_intact()
    assert flag in str(err.value)


@pytest.mark.parametrize("flag", RBAC_ENFORCEMENT_FLAGS)
def test_non_production_only_warns(flag, monkeypatch, caplog):
    """The lever has to stay usable — that is what it is for."""
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv(flag, "false")
    with caplog.at_level("WARNING"):
        assert_rbac_enforcement_intact()
    assert flag in caplog.text


def test_the_default_posture_is_enforcing(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    for flag in RBAC_ENFORCEMENT_FLAGS:
        monkeypatch.delenv(flag, raising=False)
    assert_rbac_enforcement_intact()


# ── Signing algorithm ────────────────────────────────────────────────

def test_alg_none_is_refused_at_startup(monkeypatch):
    """Building the key ring proved a key existed, never that it could
    be used with the configured algorithm — so `none` booted clean."""
    monkeypatch.setattr(auth_config, "JWT_ALGORITHM", "none", raising=False)
    with pytest.raises(auth_config.UnsupportedAlgorithm):
        auth_config.assert_signing_secret()


def test_an_asymmetric_algorithm_is_refused(monkeypatch):
    """Every entry in the ring is a secret string; RS256 would need a
    PEM there and no code path loads one."""
    monkeypatch.setattr(auth_config, "JWT_ALGORITHM", "RS256", raising=False)
    with pytest.raises(auth_config.UnsupportedAlgorithm):
        auth_config.assert_signing_secret()


@pytest.mark.parametrize("alg", ["HS256", "HS384", "HS512"])
def test_the_hmac_family_is_accepted(alg, monkeypatch):
    monkeypatch.setattr(auth_config, "JWT_ALGORITHM", alg, raising=False)
    auth_config.assert_signing_secret()


# ── Reserved claims ──────────────────────────────────────────────────

def test_extra_claims_cannot_override_the_audience():
    """`aud` is the only thing keeping a refresh token from being
    replayed as an access token, and `payload.update(extra)` ran after
    it was set."""
    from backend.auth_service.core.tokens import (
        create_access_token,
        decode_token,
    )

    token = create_access_token(
        user_id="usr_1", email="a@b.c", role="user",
        extra={"sid": "sess_1", "aud": "attacker", "sub": "usr_other"},
    )
    claims = decode_token(token)
    assert claims["sub"] == "usr_1"
    assert claims["aud"] != "attacker"
    assert claims["sid"] == "sess_1", "legitimate extras must survive"


# ── Auth posture defaults ────────────────────────────────────────────

def test_the_failsafe_posture_closes_jit_but_not_sign_in():
    """Two different questions that were answered by one object.

    ``_DEFAULTS`` is "nothing has configured a posture" — a fresh
    install — and must match the column server-defaults. ``_FAILSAFE``
    is "we could not READ the posture", which is when a DB blip on a
    cold cache used to silently re-enable account creation an operator
    had deliberately turned off.
    """
    from backend.auth_service.app_auth_config import _DEFAULTS, _FAILSAFE

    assert _DEFAULTS.allow_jit_provisioning is True
    assert _FAILSAFE.allow_jit_provisioning is False

    # Sign-in stays permissive in both: failing it closed locks everyone
    # out of an application that is otherwise fine.
    for posture in (_DEFAULTS, _FAILSAFE):
        assert posture.allow_local_login is True
        assert posture.sso_enabled is True


async def test_a_failing_loader_with_no_cache_serves_the_closed_default():
    from backend.auth_service.app_auth_config import CachedAuthConfigProvider

    async def _boom():
        raise RuntimeError("db is down")

    snap = await CachedAuthConfigProvider(_boom).get()
    assert snap.allow_jit_provisioning is False
    assert snap.allow_local_login is True


async def test_a_failing_loader_prefers_the_last_good_snapshot():
    """A stale snapshot is what the operator configured; the defaults
    are a guess. Only reached on a cold cache."""
    from backend.auth_service.app_auth_config import (
        AuthConfigSnapshot,
        CachedAuthConfigProvider,
    )

    good = AuthConfigSnapshot(
        sso_enabled=True, allow_local_login=False,
        allow_jit_provisioning=True, version=3, updated_at="",
    )
    calls = {"n": 0}

    async def _flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            return good
        raise RuntimeError("db is down")

    provider = CachedAuthConfigProvider(_flaky, ttl_seconds=0)
    assert (await provider.get()).version == 3
    again = await provider.get()
    assert again.version == 3
    assert again.allow_local_login is False


# ── Reset tokens ─────────────────────────────────────────────────────

async def test_a_reset_token_row_with_no_expiry_is_refused(db_session):
    """The guard was `if expires_at:`, so a missing expiry meant
    "never expires" — the wrong direction for a credential."""
    from backend.app.auth.password import hash_password
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session, email="noexp@corp.example",
        password_hash=hash_password("C0mpl3x!Passw0rd#"),
        first_name="No", last_name="Exp", status="active",
    )
    token, _expires = await user_repo.create_reset_token(db_session, user.id)
    assert await user_repo.verify_reset_token(db_session, token) is not None

    # Now the shape a partial write or a hand-edit leaves behind.
    fresh = await user_repo.get_user_by_id(db_session, user.id)
    fresh.reset_token_expires_at = None
    await db_session.flush()

    assert await user_repo.verify_reset_token(db_session, token) is None


# ── Access-token TTL ceiling ─────────────────────────────────────────
#
# With claims in the token, JWT_EXPIRY_MINUTES *is* the revocation
# latency: a role change, a suspension or a forced sign-out does not
# reach a live session until its next rotation. Three of the four
# shipped configs said 60 while the release notes said 15 — a warning
# had been in the log the whole time and nobody read it.

def _with_ttl(monkeypatch, minutes: int, *, prod: bool, ceiling: int = 15):
    """Point the boot check at a given TTL.

    ``_assert_session_config_coherent`` imports its values inside the
    function body, so setting the module attributes is enough — no
    reload, which would reset the revocation singleton and leak into
    every test that runs after this file.
    """
    import backend.app.main as main_module
    import backend.app.services.revocation_service as revocation_service

    monkeypatch.setattr(auth_config, "JWT_EXPIRY_MINUTES", minutes)
    monkeypatch.setattr(main_module, "_MAX_ACCESS_TTL_MINUTES", ceiling)
    monkeypatch.setattr(main_module, "_is_production", lambda: prod)
    # A long TTL needs a tombstone that outlives it, or the earlier
    # coherence check fires first and we would be asserting on that.
    monkeypatch.setattr(revocation_service, "REVOCATION_TTL_SECONDS", 99999)
    return main_module


def test_production_refuses_an_access_ttl_over_the_ceiling(monkeypatch):
    main_module = _with_ttl(monkeypatch, 60, prod=True)
    with pytest.raises(RuntimeError) as err:
        main_module._assert_session_config_coherent()
    assert "JWT_EXPIRY_MINUTES=60" in str(err.value)
    assert "15-minute ceiling" in str(err.value)


def test_non_production_only_warns_about_a_long_access_ttl(monkeypatch, caplog):
    main_module = _with_ttl(monkeypatch, 60, prod=False)
    with caplog.at_level("WARNING", logger=main_module.logger.name):
        main_module._assert_session_config_coherent()
    assert "JWT_EXPIRY_MINUTES=60" in caplog.text


def test_the_shipped_default_is_within_the_ceiling(monkeypatch):
    main_module = _with_ttl(monkeypatch, 15, prod=True)
    main_module._assert_session_config_coherent()  # no raise


def test_the_ceiling_is_raisable_deliberately(monkeypatch):
    """An operator who has weighed the revocation-latency tradeoff can
    lift it — but by naming it, not by drifting a compose default."""
    main_module = _with_ttl(monkeypatch, 60, prod=True, ceiling=60)
    main_module._assert_session_config_coherent()  # no raise
