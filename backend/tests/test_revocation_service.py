"""Unit tests for ``backend.app.services.revocation_service``.

Uses the in-memory backend so tests run without a live Redis. The
real backend is exercised in the integration test suite once Phase 2
wires it into endpoints.
"""
from __future__ import annotations

import pytest

from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationBackendError,
    RevocationService,
    _key,
)


@pytest.mark.asyncio
async def test_revoke_round_trip():
    svc = RevocationService(InMemoryBackend())
    assert not await svc.is_revoked("sess_a")
    await svc.revoke_session("sess_a")
    assert await svc.is_revoked("sess_a")


@pytest.mark.asyncio
async def test_revoke_session_ignores_empty_sid():
    svc = RevocationService(InMemoryBackend())
    await svc.revoke_session("")
    # ``is_revoked`` short-circuits to False on empty sid even if the
    # backend somehow has the empty key.
    assert not await svc.is_revoked("")


@pytest.mark.asyncio
async def test_revoke_sessions_bulk():
    svc = RevocationService(InMemoryBackend())
    await svc.revoke_sessions(["sess_a", "sess_b", "sess_c"])
    assert await svc.is_revoked("sess_a")
    assert await svc.is_revoked("sess_b")
    assert await svc.is_revoked("sess_c")


@pytest.mark.asyncio
async def test_health_passes_with_in_memory_backend():
    svc = RevocationService(InMemoryBackend())
    assert await svc.health() is True


@pytest.mark.asyncio
async def test_revocation_backend_error_propagates():
    """A backend that raises ``RevocationBackendError`` from ``exists``
    bubbles up so ``requires(...)`` can apply its fail-open / fail-closed
    policy."""
    class BrokenBackend(InMemoryBackend):
        async def exists(self, key):
            raise RevocationBackendError("simulated outage")

    svc = RevocationService(BrokenBackend())
    with pytest.raises(RevocationBackendError):
        await svc.is_revoked("sess_x")


def test_key_prefix_is_stable():
    assert _key("sess_x") == "rbac:revoked:sess_x"
