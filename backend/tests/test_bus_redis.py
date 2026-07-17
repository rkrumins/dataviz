"""Unit tests for the aggregation/insights bus Redis builder — Sentinel + TLS,
and the explicit Cluster-not-supported guard. Mocks the redis constructors."""
import sys
import types

import pytest

from backend.common.adapters.redis_bus import BusConfigurationError, build_bus_redis


def _clear_bus_env(monkeypatch):
    for k in (
        "REDIS_SENTINEL_MASTER", "REDIS_SENTINEL_NODES", "REDIS_CLUSTER_NODES",
        "REDIS_TLS_ENABLED", "REDIS_TLS_CA_CERTS", "REDIS_USERNAME", "REDIS_PASSWORD",
    ):
        monkeypatch.delenv(k, raising=False)


def test_cluster_bus_raises(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_CLUSTER_NODES", "n1:7000,n2:7001")
    with pytest.raises(BusConfigurationError):
        build_bus_redis()


def test_single_node_plain(monkeypatch):
    # The central factory (redis_endpoint.build_redis_client) constructs via
    # `aioredis.Redis(host=, port=, ...)`, not `from_url` — so this patches and
    # asserts on the constructor kwargs instead of a URL string. Behaviour under
    # test is unchanged: a plaintext endpoint sends no ssl kwargs.
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6399/0")
    captured = {}
    import redis.asyncio as aioredis

    def fake_redis(**kw):
        captured.update(kw)
        return "CLIENT"

    monkeypatch.setattr(aioredis, "Redis", fake_redis)
    assert build_bus_redis() == "CLIENT"
    assert captured["host"] == "localhost"
    assert captured["port"] == 6399
    assert captured["db"] == 0
    assert "ssl" not in captured and "ssl_ca_certs" not in captured


def test_single_node_tls_adds_certs(monkeypatch):
    # Was test_single_node_tls_upgrades_scheme_and_adds_certs: the old builder
    # upgraded the URL scheme to rediss:// (via from_url) so TLS was implied
    # without a bare `ssl` kwarg. The central factory instead always passes
    # `ssl=True` explicitly via tls_client_kwargs — there is no URL/scheme in
    # play since it constructs `Redis(host=, port=, ...)` directly. The
    # preserved behaviour: TLS-enabled + a custom CA cert reach the client
    # constructor kwargs.
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://h:6380/0")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/ca.pem")
    captured = {}
    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")
    build_bus_redis()
    assert captured["host"] == "h"
    assert captured["port"] == 6380
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/ca.pem"


def test_sentinel_mode(monkeypatch):
    # The ORIGINAL (pre-central-resolver) builder selected Sentinel mode
    # implicitly from the unprefixed REDIS_SENTINEL_MASTER/_NODES alone (no
    # MODE concept existed). This is the back-compat path deploy/topologies/
    # README.md still documents for the bus — it must keep working after the
    # migration to the central resolver (see redis_endpoint.py's STREAMS-only
    # legacy sentinel inference). REDIS_PASSWORD (unprefixed) is honoured too,
    # exactly as the original builder did.
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379, s2:26379")
    monkeypatch.setenv("REDIS_PASSWORD", "pw")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["nodes"], captured["kw"] = nodes, kw

        def master_for(self, name, **kw):
            captured["master"], captured["master_kw"] = name, kw
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)

    assert build_bus_redis() == "MASTER"
    assert captured["master"] == "mymaster"
    assert captured["nodes"] == [("s1", 26379), ("s2", 26379)]
    assert captured["kw"]["password"] == "pw"


def test_sentinel_with_tls(monkeypatch):
    # See test_sentinel_mode above: the unprefixed legacy vars still work.
    # REDIS_TLS_ENABLED (unprefixed) is honoured mode-independently.
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "m")
    monkeypatch.setenv("REDIS_SENTINEL_NODES", "s1:26379")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["kw"] = kw

        def master_for(self, name, **kw):
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)
    build_bus_redis()
    assert captured["kw"]["ssl"] is True


def test_sentinel_mode_role_prefixed(monkeypatch):
    # Pins the NEW REDIS_STREAMS_SENTINEL_* path alongside the legacy
    # unprefixed path above — both must keep working.
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379, s2:26379")
    monkeypatch.setenv("REDIS_PASSWORD", "pw")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["nodes"], captured["kw"] = nodes, kw

        def master_for(self, name, **kw):
            captured["master"], captured["master_kw"] = name, kw
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)

    assert build_bus_redis() == "MASTER"
    assert captured["master"] == "mymaster"
    assert captured["nodes"] == [("s1", 26379), ("s2", 26379)]
    assert captured["kw"]["password"] == "pw"


def test_sentinel_with_tls_role_prefixed(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_STREAMS_MODE", "sentinel")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_MASTER", "m")
    monkeypatch.setenv("REDIS_STREAMS_SENTINEL_NODES", "s1:26379")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, **kw):
            captured["kw"] = kw

        def master_for(self, name, **kw):
            return "MASTER"

    mod = types.ModuleType("redis.asyncio.sentinel")
    mod.Sentinel = FakeSentinel
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", mod)
    build_bus_redis()
    assert captured["kw"]["ssl"] is True


def test_bus_honours_password_and_tls(monkeypatch):
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://bus-host:6380/0")
    monkeypatch.setenv("REDIS_PASSWORD", "bus-pw")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_CERTS", "/certs/streams/ca.crt")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    assert build_bus_redis() == "C"
    assert captured["password"] == "bus-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/streams/ca.crt"


def test_bus_defaults_to_retry_on_timeout_true(monkeypatch):
    """CRITICAL regression check: the original single-node bus builder
    hard-coded `retry_on_timeout=True` on every client it built. The central
    factory must still land it in the constructed client's kwargs by
    default — no env needed."""
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://bus-host:6380/0")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    assert build_bus_redis() == "C"
    assert captured["retry_on_timeout"] is True


def test_only_socket_connect_timeout_env_is_preserved(monkeypatch):
    """An operator setting ONLY REDIS_STREAMS_SOCKET_CONNECT_TIMEOUT (e.g. for
    fast failover detection) must not have it silently clobbered by
    build_bus_redis's caller-supplied socket_timeout/socket_connect_timeout
    defaults — the two fields have independent provenance and need
    independent gates."""
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://bus-host:6380/0")
    monkeypatch.setenv("REDIS_STREAMS_SOCKET_CONNECT_TIMEOUT", "2")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_bus_redis(socket_connect_timeout=5, socket_timeout=10)
    assert captured["socket_connect_timeout"] == 2.0
    # The untouched field still gets the caller's default.
    assert captured["socket_timeout"] == 10.0


def test_only_socket_timeout_env_is_preserved(monkeypatch):
    """Mirror of the above for REDIS_STREAMS_SOCKET_TIMEOUT alone."""
    _clear_bus_env(monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://bus-host:6380/0")
    monkeypatch.setenv("REDIS_STREAMS_SOCKET_TIMEOUT", "30")
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_bus_redis(socket_connect_timeout=5, socket_timeout=10)
    assert captured["socket_timeout"] == 30.0
    # The untouched field still gets the caller's default.
    assert captured["socket_connect_timeout"] == 5.0


def test_bus_default_endpoint_is_not_falkordb(monkeypatch):
    """With no Redis env vars at all, the bus must resolve to localhost:6380
    (the legacy implicit default), NOT 6379 — 6379 is FalkorDB in this
    project's dev environment."""
    _clear_bus_env(monkeypatch)
    monkeypatch.delenv("REDIS_URL", raising=False)
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_bus_redis()
    assert captured["host"] == "localhost"
    assert captured["port"] == 6380


# ── consumer-loop error classification (NOAUTH != a network blip) ──────────

def test_bus_auth_error_classification():
    from redis.exceptions import AuthenticationError, ResponseError
    from backend.common.adapters.redis_bus import is_bus_auth_error

    assert is_bus_auth_error(ResponseError("NOAUTH Authentication required."))
    assert is_bus_auth_error(
        AuthenticationError("WRONGPASS invalid username-password pair")
    )
    assert is_bus_auth_error(AuthenticationError(
        "HELLO must be called with the client already authenticated, otherwise "
        "the HELLO <proto> AUTH <user> <pass> option can be used"
    ))
    # Chained: an auth cause inside a generic wrapper still classifies.
    wrapped = ConnectionError("read failed")
    wrapped.__cause__ = ResponseError("NOAUTH Authentication required.")
    assert is_bus_auth_error(wrapped)
    # Real outages stay transient.
    assert not is_bus_auth_error(ConnectionError("connection refused"))
    assert not is_bus_auth_error(TimeoutError("timed out"))


def test_bus_error_retry_delay_and_message(caplog):
    import logging
    from redis.exceptions import ResponseError
    from backend.common.adapters.redis_bus import (
        BUS_AUTH_RETRY_DELAY_S,
        BUS_TRANSIENT_RETRY_DELAY_S,
        bus_error_retry_delay,
    )

    log = logging.getLogger("test_bus_loop")
    with caplog.at_level(logging.WARNING):
        auth_delay = bus_error_retry_delay(
            ResponseError("NOAUTH Authentication required."), log, what="XREADGROUP",
        )
        blip_delay = bus_error_retry_delay(
            ConnectionError("reset by peer"), log, what="XREADGROUP",
        )
    assert auth_delay == BUS_AUTH_RETRY_DELAY_S       # long backoff — no hot loop
    assert blip_delay == BUS_TRANSIENT_RETRY_DELAY_S  # blips keep today's cadence
    auth_records = [r for r in caplog.records if "AUTHENTICATION" in r.message]
    assert auth_records and auth_records[0].levelno == logging.ERROR
    assert "REDIS_STREAMS_PASSWORD" in auth_records[0].getMessage() or \
        "REDIS_STREAMS_PASSWORD" in auth_records[0].message


# ── stream_block_ms: XREAD block vs socket_timeout (audit closure) ──────

def test_stream_block_ms_passthrough_at_defaults(monkeypatch):
    """Default socket_timeout (10s) comfortably fits the 5s block."""
    from backend.common.adapters.redis_bus import stream_block_ms
    assert stream_block_ms(5000) == 5000


def test_stream_block_ms_clamps_under_tight_socket_timeout(monkeypatch):
    """socket_timeout ≤ block makes EVERY quiet blocking read raise a spurious
    TimeoutError — the window must shrink to fit one second inside it."""
    from backend.common.adapters.redis_bus import stream_block_ms
    monkeypatch.setenv("REDIS_STREAMS_SOCKET_TIMEOUT", "3")
    assert stream_block_ms(5000) == 2000


def test_stream_block_ms_floor_is_one_second(monkeypatch):
    from backend.common.adapters.redis_bus import stream_block_ms
    monkeypatch.setenv("REDIS_STREAMS_SOCKET_TIMEOUT", "1")
    assert stream_block_ms(5000) == 1000
