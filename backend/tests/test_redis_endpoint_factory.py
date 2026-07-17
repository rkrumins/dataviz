"""The single client factory. Every non-graph Redis client is built here, so these
assertions are what guarantee auth + TLS actually reach the wire for every role."""
import pytest

from backend.common.adapters.redis_endpoint import (
    RedisConfigurationError, RedisEndpointConfig, RedisRole, build_redis_client,
)
from backend.common.adapters.redis_tls import TLSSettings


def test_standalone_passes_auth_and_tls(monkeypatch):
    captured = {}
    import redis.asyncio as aioredis

    def fake_redis(**kw):
        captured.update(kw)
        return "CLIENT"

    monkeypatch.setattr(aioredis, "Redis", fake_redis)

    cfg = RedisEndpointConfig(
        role=RedisRole.CACHE, host="cache.internal", port=6380, db=2,
        username="cache-user", password="cache-pw",
        tls=TLSSettings.from_fields(
            enabled=True, ca_certs="/certs/cache/ca.crt",
            certfile="/certs/cache/client.crt", keyfile="/certs/cache/client.key",
        ),
    )
    assert build_redis_client(cfg) == "CLIENT"
    assert captured["host"] == "cache.internal"
    assert captured["port"] == 6380
    assert captured["db"] == 2
    assert captured["username"] == "cache-user"
    assert captured["password"] == "cache-pw"
    assert captured["ssl"] is True
    assert captured["ssl_ca_certs"] == "/certs/cache/ca.crt"
    assert captured["ssl_certfile"] == "/certs/cache/client.crt"
    assert captured["ssl_keyfile"] == "/certs/cache/client.key"


def test_plaintext_sends_no_ssl_kwargs(monkeypatch):
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_redis_client(RedisEndpointConfig(role=RedisRole.STREAMS, host="h"))
    assert "ssl" not in captured
    assert captured.get("username") is None
    assert captured.get("password") is None


def test_sentinel_uses_master_for_with_auth_and_tls(monkeypatch):
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["nodes"] = nodes
            captured["sentinel_kwargs"] = sentinel_kwargs
            captured["kw"] = kw

        def master_for(self, name, **kw):
            captured["master"] = name
            captured["master_kw"] = kw
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    cfg = RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel",
        sentinel_master="mymaster", sentinel_nodes=(("s1", 26379),),
        username="u", password="pw",
        tls=TLSSettings.from_fields(enabled=True, ca_certs="/certs/streams/ca.crt"),
    )
    assert build_redis_client(cfg) == "MASTER"
    assert captured["master"] == "mymaster"
    # Constructor (connection_kwargs) — these seed Sentinel.connection_kwargs.
    assert captured["kw"]["password"] == "pw"
    assert captured["kw"]["ssl"] is True
    assert captured["kw"]["ssl_ca_certs"] == "/certs/streams/ca.crt"
    # master_for — this is what actually reaches the master data connection;
    # a regression that broke only this call must fail here too.
    assert captured["master_kw"]["password"] == "pw"
    assert captured["master_kw"]["ssl"] is True
    assert captured["master_kw"]["ssl_ca_certs"] == "/certs/streams/ca.crt"


def test_sentinel_delivers_nonzero_db_to_master_not_to_sentinel_daemons(monkeypatch):
    """Critical fix: the sentinel branch used to build `common` without `db`, so
    a non-zero db silently fell back to redis-py's default of 0. `db` must reach
    the master/replica connection but must NEVER reach sentinel_kwargs — sentinel
    daemons have no databases."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs
            captured["kw"] = kw

        def master_for(self, name, **kw):
            captured["master_kw"] = kw
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    cfg = RedisEndpointConfig(
        role=RedisRole.CACHE, mode="sentinel", db=1,
        sentinel_master="mymaster", sentinel_nodes=(("s1", 26379),),
    )
    assert build_redis_client(cfg) == "MASTER"
    assert captured["kw"]["db"] == 1
    assert captured["master_kw"]["db"] == 1
    assert "db" not in captured["sentinel_kwargs"]


def test_sentinel_auth_enabled_forwards_data_plane_credentials_to_sentinel_daemons(
    monkeypatch,
):
    """sentinel_auth_enabled=True is the explicit opt-in to reuse the data-plane
    username/password for the sentinel daemons themselves (as opposed to
    dedicated sentinel_username/sentinel_password)."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    build_redis_client(RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),),
        username="data-plane-user", password="data-plane-pw",
        sentinel_auth_enabled=True,
    ))
    assert captured["sentinel_kwargs"]["username"] == "data-plane-user"
    assert captured["sentinel_kwargs"]["password"] == "data-plane-pw"


def test_sentinel_daemons_get_no_auth_by_default(monkeypatch):
    """The FalkorDB work established this: sending the data-plane password to an
    UNAUTHENTICATED sentinel daemon makes redis-py raise on the AUTH reply and
    takes discover_master down. Only send it when explicitly opted in."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    build_redis_client(RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),), password="data-plane-pw",
    ))
    assert "password" not in captured["sentinel_kwargs"]


@pytest.mark.parametrize("role", [RedisRole.STREAMS, RedisRole.CACHE])
@pytest.mark.parametrize("auth_enabled", [True, False])
@pytest.mark.parametrize("dedicated", [True, False])
def test_sentinel_daemon_auth_matrix(monkeypatch, role, auth_enabled, dedicated):
    """The full daemon-auth decision table, per role. Exactly three outcomes:
    dedicated creds win outright; sentinel_auth_enabled=True falls back to the
    data-plane creds; otherwise the daemon connection carries NO auth at all
    (an unauthenticated daemon rejects any AUTH and takes discover_master
    down). One wrong cell here is a whole-tier outage, hence the matrix."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            captured["master_kw"] = kw
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    cfg = RedisEndpointConfig(
        role=role, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),),
        username="dp-user", password="dp-pw",
        sentinel_username="sd-user" if dedicated else None,
        sentinel_password="sd-pw" if dedicated else None,
        sentinel_auth_enabled=auth_enabled,
    )
    assert build_redis_client(cfg) == "MASTER"

    sk = captured["sentinel_kwargs"]
    if dedicated:
        # Dedicated daemon credentials always win — even with the reuse flag on.
        assert sk["username"] == "sd-user"
        assert sk["password"] == "sd-pw"
    elif auth_enabled:
        assert sk["username"] == "dp-user"
        assert sk["password"] == "dp-pw"
    else:
        assert "username" not in sk
        assert "password" not in sk
    # Whatever the daemon outcome, the data-plane connection keeps its own auth.
    assert captured["master_kw"]["username"] == "dp-user"
    assert captured["master_kw"]["password"] == "dp-pw"
    # Daemons have no databases — db must never leak into their kwargs.
    assert "db" not in sk


def test_sentinel_dedicated_password_only_reuses_no_data_plane_username(monkeypatch):
    """`redis://:pw@…`-style daemons exist too: a dedicated sentinel_password
    with NO sentinel_username must authenticate as the default user
    (password-only), not silently pair the data-plane username with the
    dedicated password."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    for auth_enabled in (False, True):
        build_redis_client(RedisEndpointConfig(
            role=RedisRole.STREAMS, mode="sentinel", sentinel_master="m",
            sentinel_nodes=(("s1", 26379),),
            username="dp-user", password="dp-pw",
            sentinel_password="sd-pw",
            # True is the trap: a per-field fallback would splice dp-user in
            # next to sd-pw — a mismatched pair the daemon rejects.
            sentinel_auth_enabled=auth_enabled,
        ))
        sk = captured["sentinel_kwargs"]
        assert sk["password"] == "sd-pw"
        assert "username" not in sk


def test_cluster_mode_config_is_refused_by_the_factory():
    cfg = RedisEndpointConfig(role=RedisRole.CACHE, mode="cluster", host="h")
    with pytest.raises(RedisConfigurationError, match="cluster"):
        build_redis_client(cfg)


def test_standalone_passes_retry_on_timeout(monkeypatch):
    """A resolved knob that never reaches the constructed client is the exact
    bug class this factory exists to kill — assert on the captured kwargs,
    not just on cfg.retry_on_timeout."""
    captured = {}
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "Redis", lambda **kw: captured.update(kw) or "C")

    build_redis_client(RedisEndpointConfig(role=RedisRole.STREAMS, host="h", retry_on_timeout=True))
    assert captured["retry_on_timeout"] is True

    captured.clear()
    build_redis_client(RedisEndpointConfig(role=RedisRole.CACHE, host="h", retry_on_timeout=False))
    assert captured["retry_on_timeout"] is False


def test_sentinel_passes_retry_on_timeout_to_master_connection(monkeypatch):
    """Same guarantee as the standalone case, but for the Sentinel-managed
    master/replica data connection (master_for) — the sentinel-daemon
    connection kwargs are a separate concern and are not asserted here."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["kw"] = kw

        def master_for(self, name, **kw):
            captured["master_kw"] = kw
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    cfg = RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel",
        sentinel_master="mymaster", sentinel_nodes=(("s1", 26379),),
        retry_on_timeout=True,
    )
    assert build_redis_client(cfg) == "MASTER"
    assert captured["kw"]["retry_on_timeout"] is True
    assert captured["master_kw"]["retry_on_timeout"] is True


def test_cluster_mode_is_refused_regardless_of_case_or_whitespace():
    """The resolver normalizes mode via .strip().lower(), so this is unreachable
    through resolve_redis_config today — but the factory is the last line of
    defence against a hand-built cfg (a fixture, a future migration) that didn't
    go through the resolver, so it must normalize independently."""
    for raw_mode in ("Cluster", " cluster ", "CLUSTER"):
        cfg = RedisEndpointConfig(role=RedisRole.CACHE, mode=raw_mode, host="h")
        with pytest.raises(RedisConfigurationError, match="cluster"):
            build_redis_client(cfg)


def test_sentinel_daemon_kwargs_carry_health_check_and_retry(monkeypatch):
    """Daemon sockets need the same slow-network posture as the data plane:
    idle health PINGs and one timeout retry on discover_master. They must
    still NEVER see db or max_connections (no databases; pool cap is a
    data-plane concern)."""
    captured = {}

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            captured["sentinel_kwargs"] = sentinel_kwargs or {}

        def master_for(self, name, **kw):
            return "MASTER"

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    build_redis_client(RedisEndpointConfig(
        role=RedisRole.STREAMS, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),),
        health_check_interval=15, retry_on_timeout=True, max_connections=42,
    ))
    sk = captured["sentinel_kwargs"]
    assert sk["health_check_interval"] == 15
    assert sk["retry_on_timeout"] is True
    assert "db" not in sk
    assert "max_connections" not in sk


def test_sentinel_master_change_is_followed_at_runtime(monkeypatch):
    """Runtime failover parity with the FalkorDB path: the factory must hand
    back Sentinel's managed master_for product — never resolve the master
    once and pin a plain client to that address, which would hold the DEAD
    master through a pod rotation."""
    state = {"master": ("old-master", 6379)}

    class FakeManagedClient:
        """redis-py's master_for product re-discovers per pooled connection —
        model that by reading the CURRENT master at op time."""
        def __init__(self, sentinel):
            self._sentinel = sentinel

        def current_master(self):
            return state["master"]

    class FakeSentinel:
        def __init__(self, nodes, sentinel_kwargs=None, **kw):
            pass

        def master_for(self, name, **kw):
            return FakeManagedClient(self)

    import redis.asyncio.sentinel as sentinel_mod
    monkeypatch.setattr(sentinel_mod, "Sentinel", FakeSentinel)

    client = build_redis_client(RedisEndpointConfig(
        role=RedisRole.CACHE, mode="sentinel", sentinel_master="m",
        sentinel_nodes=(("s1", 26379),),
    ))
    # The factory returned the MANAGED client (discovery-per-connection),
    # not an address-pinned plain Redis.
    assert isinstance(client, FakeManagedClient)
    assert client.current_master() == ("old-master", 6379)
    state["master"] = ("promoted-replica", 6379)      # failover
    assert client.current_master() == ("promoted-replica", 6379)
