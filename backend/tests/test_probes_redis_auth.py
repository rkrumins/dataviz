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


# ── probe detail reports WHAT was probed (mode / tls / authenticated) ──────

@pytest.mark.asyncio
async def test_falkordb_standalone_probe_reports_config_detail(monkeypatch):
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_HOST", "fdb-host")
    monkeypatch.setenv("FALKORDB_PASSWORD", "graph-pw")

    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: _FakeProbeRedis(**kw))

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["detail"]["mode"] == "standalone"     # previously unstamped
    assert res["detail"]["tls"] is False
    assert res["detail"]["authenticated"] is True
    assert "graph-pw" not in repr(res)


@pytest.mark.asyncio
async def test_cache_probe_reports_config_detail(monkeypatch):
    monkeypatch.delenv("CACHE_REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_CACHE_HOST", "cache.internal")
    monkeypatch.setenv("REDIS_CACHE_PASSWORD", "cache-pw")

    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: _FakeProbeRedis(**kw))

    from backend.app.services.system_status import probes
    probes._cache_redis_client = None

    res = await probes.probe_cache_redis()
    assert res["detail"]["mode"] == "standalone"
    assert res["detail"]["tls"] is False
    assert res["detail"]["authenticated"] is True
    assert res["detail"]["scope"] == "global"


@pytest.mark.asyncio
async def test_bus_probe_reports_config_detail(monkeypatch):
    monkeypatch.setenv("REDIS_STREAMS_HOST", "bus.internal")
    monkeypatch.setenv("REDIS_STREAMS_TLS_ENABLED", "true")

    from backend.app.services.system_status import probes
    from backend.app.services.aggregation import redis_client as rc_mod

    monkeypatch.setattr(rc_mod, "get_redis", lambda: _FakeProbeRedis())

    res = await probes.probe_bus_redis()
    assert res["detail"]["mode"] == "standalone"
    assert res["detail"]["tls"] is True
    assert res["detail"]["authenticated"] is False   # auth disabled: honest


# ── slow-network + unconfigured env-default (audit closure) ────────────────

@pytest.mark.asyncio
async def test_falkordb_probe_honors_configured_timeouts(monkeypatch):
    """The fixed 1/1.5s probe windows false-downed a slow cross-cluster hop.
    The env-default instance's connectTimeout/socketTimeout must reach the
    probe client."""
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_HOST", "fdb-host")
    monkeypatch.setenv("FALKORDB_SOCKET_CONNECT_TIMEOUT", "4")
    monkeypatch.setenv("FALKORDB_SOCKET_TIMEOUT", "6")

    built = {}

    import redis.asyncio as aioredis

    def capture(**kw):
        built.update(kw)
        return _FakeProbeRedis(**kw)

    monkeypatch.setattr(aioredis, "Redis", capture)

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] != "down"
    assert built["socket_connect_timeout"] == 4.0
    assert built["socket_timeout"] == 6.0


@pytest.mark.asyncio
async def test_falkordb_probe_unset_host_unreachable_is_unknown(monkeypatch):
    """FALKORDB_HOST unset → the probe dials the localhost default. On a
    deployment where FalkorDB lives only in provider rows that is NOT an
    outage — report unconfigured (the cache probe's convention), never a
    false DOWN."""
    for var in ("FALKORDB_HOST", "FALKORDB_MODE"):
        monkeypatch.delenv(var, raising=False)

    class _DownRedis(_FakeProbeRedis):
        async def ping(self):
            raise ConnectionError("connection refused")

    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: _DownRedis(**kw))

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "unknown"
    assert res["detail"]["configured"] is False

    # With FALKORDB_HOST SET, an unreachable endpoint stays a real DOWN.
    monkeypatch.setenv("FALKORDB_HOST", "fdb-host")
    res = await probes.probe_falkordb()
    assert res["status"] == "down"
