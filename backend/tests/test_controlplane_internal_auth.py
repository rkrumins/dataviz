"""Control-plane internal auth (WS2.3): the shared-secret bearer token
must ENFORCE when configured and be a complete NO-OP when unset (so a dev
stack with no token keeps working), with the health/docs paths always open.
"""
import types

import pytest
from fastapi import HTTPException

from backend.app.services.aggregation import internal_auth as ia


def _req(path: str):
    """Minimal stand-in for a Starlette Request (only .url.path is read)."""
    return types.SimpleNamespace(url=types.SimpleNamespace(path=path))


async def _call(path: str, authorization=None):
    await ia.require_internal_token(_req(path), authorization=authorization)


# ── No token configured → auth disabled, everything passes ──────────

@pytest.mark.asyncio
async def test_no_token_is_noop(monkeypatch):
    monkeypatch.delenv(ia.INTERNAL_TOKEN_ENV, raising=False)
    # Any path, with or without an Authorization header, must be allowed.
    await _call("/aggregation/jobs")
    await _call("/aggregation/data-sources/ds/purge", authorization="Bearer whatever")
    assert ia.internal_auth_headers() == {}  # clients send no header


# ── Token configured → enforced on protected routes ─────────────────

@pytest.mark.asyncio
async def test_token_required_when_configured(monkeypatch):
    monkeypatch.setenv(ia.INTERNAL_TOKEN_ENV, "s3cret")
    # Correct token → allowed.
    await _call("/aggregation/jobs", authorization="Bearer s3cret")
    # Clients now attach it.
    assert ia.internal_auth_headers() == {"Authorization": "Bearer s3cret"}


@pytest.mark.asyncio
@pytest.mark.parametrize("authz", [None, "", "s3cret", "Bearer", "Bearer ", "Bearer wrong"])
async def test_token_rejects_bad_or_missing(monkeypatch, authz):
    monkeypatch.setenv(ia.INTERNAL_TOKEN_ENV, "s3cret")
    with pytest.raises(HTTPException) as ei:
        await _call("/aggregation/jobs", authorization=authz)
    assert ei.value.status_code == 401


# ── Exempt paths stay open even WITH a token configured ─────────────

@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/health", "/docs", "/redoc", "/openapi.json"])
async def test_exempt_paths_always_open(monkeypatch, path):
    monkeypatch.setenv(ia.INTERNAL_TOKEN_ENV, "s3cret")
    await _call(path)  # no Authorization header, must not raise


# ── Startup: prod must not run unauthenticated ──────────────────────
#
# The no-op mode above is a real dev convenience, but it was also
# reachable in production, where an unset token leaves every :8091 route
# — job trigger, cancel, delete, purge, settings — open to anything that
# can reach the port. That is not a degraded mode, it is an absent
# control, so startup now fails closed there: the same stance
# ``require_encryption_or_plaintext_ok`` takes for credential encryption.

@pytest.mark.parametrize("env", ["prod", "production", "PRODUCTION", " Prod "])
def test_production_refuses_to_start_without_a_token(env, monkeypatch):
    monkeypatch.setenv("ENV", env)
    monkeypatch.delenv(ia.INTERNAL_TOKEN_ENV, raising=False)
    with pytest.raises(RuntimeError) as ei:
        ia.assert_auth_mode_allowed()
    assert ia.INTERNAL_TOKEN_ENV in str(ei.value)


def test_a_blank_token_counts_as_unset(monkeypatch):
    """``get_internal_token`` strips, so whitespace is not a secret."""
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv(ia.INTERNAL_TOKEN_ENV, "   ")
    with pytest.raises(RuntimeError):
        ia.assert_auth_mode_allowed()


def test_production_starts_with_a_token(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv(ia.INTERNAL_TOKEN_ENV, "s3cret")
    ia.assert_auth_mode_allowed()  # no raise


@pytest.mark.parametrize("env", ["dev", "test", ""])
def test_non_production_only_warns(env, monkeypatch, caplog):
    """Local stacks keep the no-op mode — loudly."""
    monkeypatch.setenv("ENV", env)
    monkeypatch.delenv(ia.INTERNAL_TOKEN_ENV, raising=False)
    with caplog.at_level("WARNING", logger=ia.logger.name):
        ia.assert_auth_mode_allowed()  # no raise
    assert ia.INTERNAL_TOKEN_ENV in caplog.text
