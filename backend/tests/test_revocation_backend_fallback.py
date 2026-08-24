"""Production must not get an in-process revocation backend.

The danger of ``InMemoryBackend`` in production is not that it forgets
across restarts. It is that it **succeeds**: ``is_revoked`` answers "no",
``set_with_ttl`` returns cleanly, ``health`` says True. So the tiered
design silently collapses — the fail-open tier honours the JWT as
designed, and the FAIL-CLOSED tier sails through too, because a tier
that refuses on ``RevocationBackendError`` never sees one. With four
workers per container a revoke reaches one worker in ``4N``, and nothing
anywhere reports a problem.

Raising out of ``get_revocation_service`` is not the fix either: it runs
on every authenticated request, so a config typo would become a total,
unrecoverable auth outage. That is the failure the fallback exists to
prevent.

So production gets ``UnavailableBackend``, which refuses every
operation — putting the process in exactly the state a real Redis outage
puts it in, which the code already handles correctly and on purpose.
"""

from __future__ import annotations

import pytest

from backend.app.services import revocation_service as rs


@pytest.fixture(autouse=True)
def _isolate_singleton():
    """``get_revocation_service`` memoises in a module global."""
    original = rs._INSTANCE
    rs._INSTANCE = None
    yield
    rs._INSTANCE = original


def _force_construction_failure(monkeypatch):
    """Make ``build_revocation_backend`` fail the way a bad config does."""
    def _boom():
        raise RuntimeError("no redis here")

    monkeypatch.setattr(rs, "build_revocation_backend", _boom)


# ── which stand-in each environment gets ─────────────────────────────

@pytest.mark.parametrize("env", ["prod", "production", "PRODUCTION", " Prod "])
def test_production_gets_the_refusing_backend(env, monkeypatch):
    monkeypatch.setenv("ENV", env)
    _force_construction_failure(monkeypatch)

    backend = rs.get_revocation_service()._backend
    assert isinstance(backend, rs.UnavailableBackend)


@pytest.mark.parametrize("env", ["dev", "test", ""])
def test_non_production_keeps_the_in_process_backend(env, monkeypatch):
    """A laptop and CI must stay usable without a running Redis."""
    monkeypatch.setenv("ENV", env)
    _force_construction_failure(monkeypatch)

    backend = rs.get_revocation_service()._backend
    assert isinstance(backend, rs.InMemoryBackend)


def test_construction_failure_never_escapes(monkeypatch):
    """The whole reason the fallback exists: this function runs on every
    authenticated request, so raising here is a total auth outage."""
    monkeypatch.setenv("ENV", "production")
    _force_construction_failure(monkeypatch)

    rs.get_revocation_service()  # must not raise


# ── the refusing backend refuses, rather than lying ──────────────────

@pytest.mark.asyncio
async def test_every_operation_raises_rather_than_succeeding():
    """This is the property the whole change turns on. InMemoryBackend
    answers all of these cleanly, which is what made the fail-closed
    tier stop failing closed."""
    backend = rs.UnavailableBackend()

    with pytest.raises(rs.RevocationBackendError):
        await backend.exists("rbac:revoked:sess_x")
    with pytest.raises(rs.RevocationBackendError):
        await backend.set_with_ttl("rbac:revoked:sess_x", 60)
    with pytest.raises(rs.RevocationBackendError):
        await backend.set_if_absent("saml:asid:x", 60)
    with pytest.raises(rs.RevocationBackendError):
        await backend.delete("rbac:revoked:sess_x")
    with pytest.raises(rs.RevocationBackendError):
        await backend.add_to_set("rbac:user_sids:u", "sess_x", 60)
    with pytest.raises(rs.RevocationBackendError):
        await backend.set_members("rbac:user_sids:u")
    with pytest.raises(rs.RevocationBackendError):
        await backend.set_value("rbac:sess:x", "{}", 60)
    with pytest.raises(rs.RevocationBackendError):
        await backend.exists_and_get("rbac:revoked:x", "rbac:sess:x")


@pytest.mark.asyncio
async def test_health_reports_false_instead_of_raising():
    """``health`` is the one method whose job is to REPORT the state
    rather than act on it, and /health/deps calls it."""
    assert await rs.UnavailableBackend().health() is False


@pytest.mark.asyncio
async def test_a_revocation_check_surfaces_as_a_backend_error(monkeypatch):
    """End of the chain: the service raises the error the fail-closed
    tier is written to catch, which is what turns a privileged route
    into a 503 instead of a silent pass."""
    monkeypatch.setenv("ENV", "production")
    _force_construction_failure(monkeypatch)

    with pytest.raises(rs.RevocationBackendError):
        await rs.get_revocation_service().is_revoked("sess_x")


# ── readiness sees it ────────────────────────────────────────────────

@pytest.mark.parametrize("env", ["production", "dev"])
def test_neither_stand_in_counts_as_shared(env, monkeypatch):
    """`/health/ready` gates on this, so both stand-ins must report
    unshared — the refusing one is degraded, not healthy."""
    monkeypatch.setenv("ENV", env)
    _force_construction_failure(monkeypatch)

    assert rs.revocation_is_shared() is False
