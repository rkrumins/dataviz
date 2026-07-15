"""A health probe that can't authenticate reports a healthy service as DOWN.
Both probe clients must carry the same credentials/TLS as the real clients."""
import pytest


class _FakeProbeRedis:
    """Minimal fake standing in for ``redis.asyncio.Redis`` — enough surface
    for ``_falkor_node_probe`` (ping / info / execute_command / aclose)."""

    def __init__(self, **kw):
        self.kwargs = kw

    async def ping(self):
        return True

    async def info(self, *a, **kw):
        return {}

    async def execute_command(self, *a, **kw):
        return []

    async def aclose(self):
        return None


@pytest.fixture(autouse=True)
def _reset_cache_redis_singleton():
    """``_cache_redis()`` caches its client in a module-level global. Tests that
    poke it directly (below) must not leak a fake client into later tests in
    the same pytest process — a future test touching ``probe_cache_redis()``
    would silently get the poisoned client and report a healthy cache as down."""
    from backend.app.services.system_status import probes
    yield
    probes._cache_redis_client = None


def test_cache_probe_carries_cache_auth_and_tls(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_USERNAME", "cache-user")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")
    monkeypatch.setenv("REDIS_CACHE_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_CACHE_TLS_CA_CERTS", "/certs/cache/ca.crt")

    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._cache_redis_client = None          # reset the module singleton
    assert probes._cache_redis() is not None

    assert captured["host"] == "cache.internal"
    assert captured["username"] == "cache-user"
    assert captured["password"] == "cache-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"
    # MINOR 1: the original cache probe was a bare aioredis.from_url(...) that
    # never set health_check_interval, so redis-py defaulted it to 0
    # (disabled). build_redis_client applies the CACHE role's default of 30 —
    # the probe must pin it back to 0 (a short-lived, tightly-budgeted
    # connection has no use for a periodic idle-socket PING).
    assert captured["health_check_interval"] == 0


def test_falkor_node_probe_carries_falkordb_auth(monkeypatch):
    """The FalkorDB node probe built a bare Redis(host, port) and would fail on an
    authenticated instance."""
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or object())

    from backend.app.services.system_status import probes
    probes._build_falkor_probe_client("fdb-host", 6379,
                                      username="graph", password="graph-pw")
    assert captured["username"] == "graph"
    assert captured["password"] == "graph-pw"


# ── GAP: env_conn_config() now carries FALKORDB_USERNAME/PASSWORD, so the
# probe (which resolves env_conn_config() directly) must thread the actual
# VALUES into the client it builds — not just accept a config object that
# happens to have them.

@pytest.mark.asyncio
async def test_falkordb_probe_carries_env_configured_credentials(monkeypatch):
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_HOST", "fdb-env-host")
    monkeypatch.setenv("FALKORDB_PORT", "6379")
    monkeypatch.setenv("FALKORDB_USERNAME", "env-graph-user")
    monkeypatch.setenv("FALKORDB_PASSWORD", "env-graph-pw")
    monkeypatch.delenv("FALKORDB_PASSWORD_FILE", raising=False)

    captured = {}
    import redis.asyncio as aioredis

    def _make(**kw):
        captured.update(kw)
        return _FakeProbeRedis(**kw)

    monkeypatch.setattr(aioredis, "Redis", _make)

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()

    assert captured["host"] == "fdb-env-host"
    assert captured["username"] == "env-graph-user"
    assert captured["password"] == "env-graph-pw"
    assert res["status"] == "healthy"


@pytest.mark.asyncio
async def test_falkordb_probe_degrades_when_password_file_unreadable(monkeypatch, tmp_path):
    """FALKORDB_PASSWORD_FILE naming a file that can't be read is a HARD error
    inside env_conn_config() — the probe must degrade to a down/error result,
    never raise into the /admin/system/status endpoint."""
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(tmp_path / "missing-secret"))

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "down"
    assert "FALKORDB_PASSWORD_FILE" in res["error"]
