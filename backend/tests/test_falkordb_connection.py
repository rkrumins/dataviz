"""Unit tests for the FalkorDB connection factory (standalone / Sentinel /
Cluster). These mock the redis + falkordb clients so they run without any
live FalkorDB — they verify mode dispatch, node resolution, and config
parsing, not actual network behavior."""
import sys
import types

import pytest

from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    _parse_nodes,
    build_graph_client,
    env_conn_config,
    load_connection_config,
    resolve_cluster_node_for_key,
)
from backend.common.interfaces.provider import ProviderConfigurationError


# ── config parsing ──────────────────────────────────────────────────

def test_parse_nodes_csv_string():
    assert _parse_nodes("h1:26379, h2:26379") == [("h1", 26379), ("h2", 26379)]


def test_parse_nodes_pairs_and_objects():
    assert _parse_nodes([["a", 1], {"host": "b", "port": 2}]) == [("a", 1), ("b", 2)]


def test_parse_nodes_skips_garbage():
    assert _parse_nodes(["nohost", ["x", "notint"], ["y", 5]]) == [("y", 5)]


def test_load_config_defaults_to_standalone():
    cfg = load_connection_config(None, host="h", port=6379, username=None, password=None)
    assert cfg.mode == "standalone"
    assert cfg.host == "h" and cfg.port == 6379


def test_load_config_unknown_mode_falls_back(caplog):
    cfg = load_connection_config({"mode": "bogus"}, host="h", port=1, username=None, password=None)
    assert cfg.mode == "standalone"


def test_load_config_env_fallback(monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "sentinel")
    monkeypatch.setenv("FALKORDB_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("FALKORDB_SENTINEL_NODES", "s1:26379,s2:26379")
    cfg = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert cfg.mode == "sentinel"
    assert cfg.sentinel_master == "mymaster"
    assert cfg.sentinel_nodes == [("s1", 26379), ("s2", 26379)]


def test_explicit_config_wins_over_env(monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    cfg = load_connection_config({"mode": "standalone"}, host="h", port=1, username=None, password=None)
    assert cfg.mode == "standalone"


def test_load_config_parses_advanced_knobs():
    cfg = load_connection_config(
        {"mode": "cluster", "cluster": {"startupNodes": [["n", 7000]]},
         "socketTimeout": "30", "graphPoolSize": 48},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_timeout == 30.0
    assert cfg.graph_pool_size == 48


def test_load_config_ignores_bad_knobs():
    cfg = load_connection_config(
        {"socketTimeout": "abc", "graphPoolSize": "xyz"},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_timeout is None
    assert cfg.graph_pool_size is None


# ── env_conn_config: the ENV-configured default instance's credentials ──
#
# GAP: env_conn_config() used to pass username=None, password=None
# UNCONDITIONALLY — an operator running the env instance with requirepass/ACL
# auth had no way to tell the app, and the health probe reported a healthy
# FalkorDB as DOWN. FALKORDB_USERNAME / FALKORDB_PASSWORD(_FILE) close that gap.

def test_env_conn_config_unchanged_with_no_new_vars_set(monkeypatch):
    """Back-compat: with none of the new vars set, behaviour is BYTE-FOR-BYTE
    identical to before this change — every existing deployment keeps booting
    unchanged."""
    for var in ("FALKORDB_USERNAME", "FALKORDB_PASSWORD", "FALKORDB_PASSWORD_FILE"):
        monkeypatch.delenv(var, raising=False)
    cfg = env_conn_config()
    assert cfg.username is None
    assert cfg.password is None


def test_env_conn_config_reads_username_and_password(monkeypatch):
    monkeypatch.setenv("FALKORDB_USERNAME", "graph-user")
    monkeypatch.setenv("FALKORDB_PASSWORD", "graph-pw")
    monkeypatch.delenv("FALKORDB_PASSWORD_FILE", raising=False)
    cfg = env_conn_config()
    assert cfg.username == "graph-user"
    assert cfg.password == "graph-pw"


def test_env_conn_config_password_file_wins_over_password(monkeypatch, tmp_path):
    secret_file = tmp_path / "falkordb-password"
    secret_file.write_text("from-file-pw\n")
    monkeypatch.setenv("FALKORDB_PASSWORD", "from-env-pw")
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(secret_file))
    cfg = env_conn_config()
    assert cfg.password == "from-file-pw"


def test_env_conn_config_missing_password_file_is_a_hard_error(monkeypatch, tmp_path):
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(tmp_path / "does-not-exist"))
    with pytest.raises(ProviderConfigurationError, match="FALKORDB_PASSWORD_FILE"):
        env_conn_config()


def test_env_conn_config_empty_password_file_is_a_hard_error(monkeypatch, tmp_path):
    secret_file = tmp_path / "empty-password"
    secret_file.write_text("   \n")            # whitespace-only
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(secret_file))
    with pytest.raises(ProviderConfigurationError, match="FALKORDB_PASSWORD_FILE"):
        env_conn_config()


def test_env_conn_config_hard_error_never_leaks_the_secret_value(monkeypatch, tmp_path):
    secret_file = tmp_path / "empty-password"
    secret_file.write_text("")
    monkeypatch.setenv("FALKORDB_PASSWORD_FILE", str(secret_file))
    with pytest.raises(ProviderConfigurationError) as exc_info:
        env_conn_config()
    message = str(exc_info.value)
    assert "FALKORDB_PASSWORD_FILE" in message
    assert str(secret_file) in message


def test_sentinel_password_file_wins_over_sentinel_password(monkeypatch, tmp_path):
    """FALKORDB_SENTINEL_PASSWORD_FILE — added for symmetry with the data-plane
    FALKORDB_PASSWORD_FILE convention."""
    secret_file = tmp_path / "sentinel-password"
    secret_file.write_text("sentinel-file-pw")
    monkeypatch.setenv("FALKORDB_SENTINEL_PASSWORD", "sentinel-env-pw")
    monkeypatch.setenv("FALKORDB_SENTINEL_PASSWORD_FILE", str(secret_file))
    cfg = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert cfg.sentinel_password == "sentinel-file-pw"


# ── graph client construction (mocked) ──────────────────────────────

@pytest.fixture
def fake_redis_and_falkor(monkeypatch):
    """Install fake redis.asyncio + falkordb.asyncio modules so the factory
    can import them. Returns a registry capturing what got constructed."""
    captured = {}

    class FakePool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            # Faithful to redis.asyncio.ConnectionPool, which exposes
            # ``connection_kwargs``.
            self.connection_kwargs = dict(kwargs)
            captured.setdefault("pools", []).append(self)

        async def aclose(self):
            captured.setdefault("closed", []).append(self)

    class _ConnMixin:
        async def flushdb(self, *a, **kw):          # bound by falkordb_over()
            ...

        async def execute_command(self, *args, **kw):
            captured.setdefault("commands", []).append(args)

        async def aclose(self):
            captured.setdefault("closed", []).append(self)

    class FakeRedis(_ConnMixin):
        def __init__(self, connection_pool=None, **kwargs):
            self.connection_pool = connection_pool
            self.kwargs = kwargs

    class FakeMaster(_ConnMixin):
        def __init__(self):
            self.connection_pool = FakePool(role="sentinel-master")

    class FakeSentinel:
        def __init__(self, nodes, **kwargs):
            captured["sentinel_nodes"] = nodes
            captured["sentinel_kwargs"] = kwargs

        def master_for(self, name, **kwargs):
            captured["master_for"] = name
            captured["master_for_kwargs"] = kwargs
            return FakeMaster()

    class FakeFalkorDB:
        """Tripwire: constructing this must NEVER happen on the async path.

        The real ``FalkorDB.__init__`` sniffs the topology via
        ``falkordb.asyncio.cluster.Is_Cluster()``, which opens a **synchronous**
        redis client and issues ``INFO`` — blocking I/O on the event loop. Against
        a hung node that froze the entire process for 26s (measured), and
        ``asyncio.wait_for`` could not interrupt it, defeating every timeout guard.
        In cluster mode it additionally handed the pool to ``Cluster_Conn``, which
        rebuilt the client while DROPPING socket timeouts / max_connections /
        health_check_interval / TLS, and destructively popped host/port off the
        pool (leaving it pointing at localhost:6379).

        The factory must build the client itself and bind the facade via
        ``falkordb_over()``. Any regression that reintroduces the constructor call
        fails here, loudly.
        """
        def __init__(self, *args, **kwargs):
            raise AssertionError(
                "FalkorDB.__init__ was called from the async connect path: it runs "
                "a blocking synchronous INFO (Is_Cluster) on the event loop. "
                "Build the client explicitly and use falkordb_over(conn)."
            )

    class FakeClusterNode:
        def __init__(self, host, port):
            self.host = host
            self.port = port

    class FakeRedisCluster(_ConnMixin):
        def __init__(self, startup_nodes=None, **kwargs):
            captured["cluster_startup_nodes"] = startup_nodes
            captured["cluster_kwargs"] = kwargs

    # redis.asyncio
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.ConnectionPool = FakePool
    redis_asyncio.Redis = FakeRedis
    sentinel_mod = types.ModuleType("redis.asyncio.sentinel")
    sentinel_mod.Sentinel = FakeSentinel
    cluster_mod = types.ModuleType("redis.asyncio.cluster")
    cluster_mod.RedisCluster = FakeRedisCluster
    redis_cluster_mod = types.ModuleType("redis.cluster")
    redis_cluster_mod.ClusterNode = FakeClusterNode

    redis_pkg = types.ModuleType("redis")
    redis_asyncio_pkg = types.ModuleType("redis.asyncio")
    redis_asyncio_pkg.ConnectionPool = FakePool
    redis_asyncio_pkg.Redis = FakeRedis

    falkor_asyncio = types.ModuleType("falkordb.asyncio")
    falkor_asyncio.FalkorDB = FakeFalkorDB
    falkor_pkg = types.ModuleType("falkordb")

    monkeypatch.setitem(sys.modules, "redis", redis_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", sentinel_mod)
    monkeypatch.setitem(sys.modules, "redis.asyncio.cluster", cluster_mod)
    monkeypatch.setitem(sys.modules, "redis.cluster", redis_cluster_mod)
    monkeypatch.setitem(sys.modules, "falkordb", falkor_pkg)
    monkeypatch.setitem(sys.modules, "falkordb.asyncio", falkor_asyncio)
    captured["FakePool"] = FakePool
    return captured


@pytest.mark.asyncio
async def test_build_graph_client_standalone(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="standalone", host="gx", port=6400)
    db, pool = await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "decode_responses": True},
    )
    # The facade is bound to a client WE built over the pool (falkordb_over) —
    # FalkorDB.__init__ is never called (the fake raises if it is).
    assert db.connection.connection_pool is pool
    assert db.execute_command == db.connection.execute_command
    assert pool.kwargs["host"] == "gx" and pool.kwargs["port"] == 6400


@pytest.mark.asyncio
async def test_build_graph_client_sentinel(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster",
        sentinel_nodes=[("s1", 26379), ("s2", 26379)],
    )
    db, pool = await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "max_connections": 24},
    )
    # The facade must be bound to the sentinel MASTER client (which re-resolves the
    # master on every reconnect), and the returned pool must be that master's pool.
    assert db.connection.connection_pool is pool
    assert fake_redis_and_falkor["master_for"] == "mymaster"
    assert fake_redis_and_falkor["sentinel_nodes"] == [("s1", 26379), ("s2", 26379)]


@pytest.mark.asyncio
async def test_sentinel_master_pool_keeps_the_resilience_kwargs(fake_redis_and_falkor):
    """AUDIT FIX: the sentinel branch used to hand master_for() only
    max_connections + auth, silently dropping socket_keepalive and
    health_check_interval — so after a failover stale sockets stalled to the
    caller's asyncio.TimeoutError (never retried, by design) instead of a retryable
    redis ConnectionError, and the breaker opened where a transparent retry was
    intended. It also force-set decode_responses=True, giving Sentinel callers `str`
    where standalone/cluster give the same callers `bytes`."""
    cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster",
        sentinel_nodes=[("s1", 26379)],
    )
    pool_kwargs = {
        "max_connections": 24, "socket_timeout": 10.0,
        "socket_connect_timeout": 2.0, "socket_keepalive": True,
        "health_check_interval": 30,
    }
    await build_graph_client(cfg, graph_name="g", pool_kwargs=pool_kwargs)

    kw = fake_redis_and_falkor["master_for_kwargs"]
    assert kw["socket_keepalive"] is True
    assert kw["health_check_interval"] == 30
    assert kw["socket_timeout"] == 10.0
    assert kw["max_connections"] == 24
    # Bytes-mode preserved: the caller decides, not the topology.
    assert "decode_responses" not in kw


@pytest.mark.asyncio
async def test_sentinel_daemons_get_no_auth_by_default(fake_redis_and_falkor):
    """AUDIT FIX: the FalkorDB password was sent to the Sentinel DAEMONS. Against
    unauthenticated sentinels (the common k8s shape) redis-py raises on the AUTH
    reply, so discover_master fails and sentinel mode cannot connect AT ALL."""
    cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster", sentinel_nodes=[("s1", 26379)],
        username="graphuser", password="graphpass",
    )
    await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0, "max_connections": 8},
    )

    sentinel_kwargs = fake_redis_and_falkor["sentinel_kwargs"]["sentinel_kwargs"]
    assert "password" not in sentinel_kwargs        # no data-plane secret leaked
    assert "username" not in sentinel_kwargs
    # …but the MASTER (data plane) still authenticates.
    assert fake_redis_and_falkor["master_for_kwargs"]["password"] == "graphpass"


@pytest.mark.asyncio
async def test_sentinel_daemons_use_explicit_credentials(fake_redis_and_falkor):
    cfg = load_connection_config(
        {"mode": "sentinel",
         "sentinel": {"masterName": "m", "nodes": [["s1", 26379]],
                      "username": "sentineluser", "password": "sentinelpass"}},
        host="h", port=6379, username="graphuser", password="graphpass",
    )
    await build_graph_client(
        cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0},
    )
    sk = fake_redis_and_falkor["sentinel_kwargs"]["sentinel_kwargs"]
    assert sk["username"] == "sentineluser" and sk["password"] == "sentinelpass"


@pytest.mark.asyncio
async def test_sentinel_auth_enabled_reuses_data_plane_credentials(fake_redis_and_falkor):
    cfg = load_connection_config(
        {"mode": "sentinel",
         "sentinel": {"masterName": "m", "nodes": [["s1", 26379]], "authEnabled": True}},
        host="h", port=6379, username="graphuser", password="graphpass",
    )
    await build_graph_client(cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0})
    sk = fake_redis_and_falkor["sentinel_kwargs"]["sentinel_kwargs"]
    assert sk["password"] == "graphpass"


@pytest.mark.asyncio
async def test_build_graph_client_sentinel_requires_master(fake_redis_and_falkor):
    cfg = FalkorDBConnConfig(mode="sentinel", sentinel_master=None, sentinel_nodes=[("s1", 1)])
    with pytest.raises(ProviderConfigurationError):
        await build_graph_client(cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0})


@pytest.mark.asyncio
async def test_build_graph_client_cluster_routes_to_owning_node(fake_redis_and_falkor, monkeypatch):
    """Regressions found against a LIVE 3-shard cluster.

    The data plane must be a real cluster client entered at the OWNING node, and it
    must carry the SAME connection tuning as every other topology. Previously the
    falkordb adapter (``Cluster_Conn``) rebuilt the client and forwarded only
    host/port/auth/retry, so cluster silently ran on redis-py defaults.
    """
    cfg = FalkorDBConnConfig(
        mode="cluster", cluster_nodes=[("n1", 7000), ("n2", 7001)], tls_enabled=True,
    )

    async def fake_resolve(_cfg, graph_name, socket_timeout):
        assert graph_name == "g"
        return ("ownernode", 7001)

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_cluster_node_for_key",
        fake_resolve,
    )
    pool_kwargs = {
        "socket_timeout": 10.0, "socket_connect_timeout": 2.0,
        "max_connections": 24, "health_check_interval": 30,
    }
    db, pool = await build_graph_client(cfg, graph_name="g", pool_kwargs=pool_kwargs)

    # The pinned pool (used for the connect-verifying ping + teardown) points at the
    # OWNING node — and, unlike before, is not destructively stripped of host/port by
    # the adapter (which left redis-py silently reconnecting to localhost:6379).
    assert pool.kwargs["host"] == "ownernode" and pool.kwargs["port"] == 7001
    assert pool.connection_kwargs["host"] == "ownernode"
    assert pool.connection_kwargs["port"] == 7001

    # The CLIENT is a RedisCluster (follows MOVED/ASK on a reshard), entered at the
    # owning node with the rest of the cluster as startup nodes.
    ck = fake_redis_and_falkor["cluster_kwargs"]
    assert db.connection is not None
    assert ck["host"] == "ownernode" and ck["port"] == 7001

    # ── The tuning that Cluster_Conn silently dropped ───────────────────
    # max_connections: became 100 PER NODE (10x our cap, per shard).
    # health_check_interval: became 0 — the idle-socket check was OFF, so stale
    #   sockets after a failover stalled to asyncio.TimeoutError (never retried,
    #   by design) instead of a retryable ConnectionError.
    # socket_*_timeout: became redis-py's 5s defaults, slowing the fast-fail that
    #   the provider bulkhead depends on.
    assert ck["socket_timeout"] == 10.0
    assert ck["socket_connect_timeout"] == 2.0
    assert ck["max_connections"] == 24
    assert ck["health_check_interval"] == 30
    # TLS: Cluster_Conn took `ssl` from FalkorDB.__init__'s own param, which is
    # False whenever a connection_pool is passed — so a TLS pool silently became a
    # PLAINTEXT cluster data plane. RedisCluster needs ssl=True, not a
    # connection_class.
    assert ck["ssl"] is True
