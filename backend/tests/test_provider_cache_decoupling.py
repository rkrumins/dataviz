"""WS2.1: the provider cache Redis is decoupled from FalkorDB.

Two guarantees:
1. ``build_cache_client`` NEVER builds a client on the FalkorDB instance —
   without a dedicated ``cache_url`` it returns None (cache disabled), for
   every FalkorDB topology (standalone / sentinel / cluster). Covered in
   test_falkordb_connection.py.
2. Deployed roles fail fast at startup when no dedicated cache is configured,
   so prod can never silently run cache-off — while DEV degrades gracefully.
"""
import pytest

from backend.app.providers import manager as mgr
from backend.app.runtime.role import SynodicRole

_DEPLOYED = [SynodicRole.WEB, SynodicRole.WORKER, SynodicRole.CONTROLPLANE]


def test_guard_dev_without_cache_is_ok(monkeypatch):
    monkeypatch.setattr(
        "backend.app.runtime.role.current_role", lambda: SynodicRole.DEV
    )
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    mgr._assert_dedicated_cache_configured()  # must not raise


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_without_cache_fails_fast(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    with pytest.raises(RuntimeError, match="CACHE_REDIS_URL"):
        mgr._assert_dedicated_cache_configured()


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_with_dedicated_cache_is_ok(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://dedicated-cache:6379/1")
    mgr._assert_dedicated_cache_configured()  # must not raise
