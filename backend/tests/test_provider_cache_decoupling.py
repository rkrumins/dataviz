"""WS2.1: the provider cache Redis is decoupled from FalkorDB.

Two guarantees:
1. ``build_cache_client`` NEVER builds a client on the FalkorDB instance —
   without a dedicated cache endpoint it returns None (cache disabled), for
   every FalkorDB topology (standalone / sentinel / cluster). Covered in
   test_falkordb_connection.py / test_cache_client_endpoint.py.
2. Deployed roles fail fast at startup when a Redis endpoint they actually
   use is unresolvable. STREAMS is a single fleet-wide coordination endpoint
   with no per-provider override, so it must always resolve. The CACHE role
   may be configured purely per-provider (extra_config.cacheConnection), so
   a missing GLOBAL cache endpoint is resolved and logged, never enforced —
   the old guard only checked the env CACHE_REDIS_URL, which made that
   deployment shape fail to boot. DEV degrades gracefully for both.
"""
import pytest

from backend.app.providers import manager as mgr
from backend.app.runtime.role import SynodicRole

_DEPLOYED = [SynodicRole.WEB, SynodicRole.WORKER, SynodicRole.CONTROLPLANE]

_REDIS_VARS = ["CACHE_REDIS_URL", "REDIS_URL", "REDIS_STREAMS_HOST", "REDIS_CACHE_HOST"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for v in _REDIS_VARS:
        monkeypatch.delenv(v, raising=False)


def test_guard_dev_without_redis_is_ok(monkeypatch):
    monkeypatch.setattr(
        "backend.app.runtime.role.current_role", lambda: SynodicRole.DEV
    )
    mgr._assert_redis_roles_configured()  # must not raise


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_streams_unconfigured_fails_fast(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    with pytest.raises(RuntimeError, match="STREAMS"):
        mgr._assert_redis_roles_configured()


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_cache_unconfigured_does_not_fail(monkeypatch, role):
    # The CACHE role may be configured purely per-provider — a deployment
    # with no GLOBAL cache endpoint must still boot (only STREAMS is required).
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    mgr._assert_redis_roles_configured()  # must not raise


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_with_dedicated_cache_is_ok(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://dedicated-cache:6379/1")
    mgr._assert_redis_roles_configured()  # must not raise
