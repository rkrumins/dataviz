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
