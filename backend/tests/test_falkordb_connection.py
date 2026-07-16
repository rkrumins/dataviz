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
        {"socketTimeout": "abc", "graphPoolSize": "xyz", "connectTimeout": "nope"},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_timeout is None
    assert cfg.graph_pool_size is None
    assert cfg.socket_connect_timeout is None


def test_per_provider_connect_timeout_reaches_every_kwargs_builder():
    """connectTimeout lets ONE slow cross-cluster provider raise its dial
    budget without a fleet-wide env change — and it must reach the raw pools,
    the high-level cluster/sentinel clients, AND the sentinel daemons alike."""
    from backend.app.providers.falkordb_connection import (
        _conn_auth_kwargs,
        _sentinel_auth_kwargs,
        build_graph_pool_kwargs,
        resilient_pool_kwargs,
    )

    cfg = load_connection_config(
        {"mode": "sentinel", "connectTimeout": 5,
         "sentinel": {"masterName": "m", "nodes": [["s1", 26379]]}},
        host="h", port=1, username=None, password=None,
    )
    assert cfg.socket_connect_timeout == 5.0
    assert build_graph_pool_kwargs(cfg, socket_timeout=10.0)["socket_connect_timeout"] == 5.0
    assert _conn_auth_kwargs(cfg, 10.0)["socket_connect_timeout"] == 5.0
    assert _sentinel_auth_kwargs(cfg, 10.0)["socket_connect_timeout"] == 5.0
    # Default unchanged: no override → the env-tunable global.
    from backend.app.config import resilience as _res
    assert (
        resilient_pool_kwargs(socket_timeout=10.0)["socket_connect_timeout"]
        == _res.FALKORDB_SOCKET_CONNECT_TIMEOUT_SECS
    )


# ── credential normalization ────────────────────────────────────────

@pytest.mark.parametrize("username,password,expected", [
    (None, None, (None, None)),
    ("", "", (None, None)),
    ("", None, (None, None)),
    (None, "", (None, None)),
    ("   ", " \t ", (None, None)),               # whitespace-only → absent
    ("", "pw", (None, "pw")),                     # password-only auth (requirepass)
    (None, "pw", (None, "pw")),
    ("user", "", (None, None)),                   # username w/o password → dropped
    ("user", None, (None, None)),
    ("default", "pw", ("default", "pw")),         # explicit default user passes through
    ("user", " pw with spaces ", ("user", " pw with spaces ")),  # never stripped
    ("user", 'p@$$w"rd,=:', ("user", 'p@$$w"rd,=:')),            # special chars intact
])
def test_normalize_credentials_matrix(username, password, expected):
    from backend.app.providers.falkordb_connection import normalize_credentials
    assert normalize_credentials(username, password) == expected


def test_normalize_credentials_warns_on_username_without_password(caplog):
    import logging
    from backend.app.providers.falkordb_connection import normalize_credentials
    with caplog.at_level(logging.WARNING):
        assert normalize_credentials("user", None) == (None, None)
    assert any("username" in r.message and "password" in r.message
               for r in caplog.records)


def test_load_config_normalizes_empty_string_credentials():
    cfg = load_connection_config(None, host="h", port=1, username="", password="")
    assert cfg.username is None
    assert cfg.password is None


def test_load_config_normalizes_sentinel_credentials():
    cfg = load_connection_config(
        {"mode": "sentinel",
         "sentinel": {"masterName": "m", "nodes": [["s1", 26379]]}},
        host="h", port=1, username=None, password=None,
        credentials={"sentinel_username": "  ", "sentinel_password": ""},
    )
    assert cfg.sentinel_username is None
    assert cfg.sentinel_password is None


def test_empty_string_and_none_credentials_share_one_identity():
    """""-vs-None must be ONE instance for the client cache and the
    learned-auth set, or a mark recorded under one spelling misses the other."""
    from backend.app.providers.falkordb_connection import TopologyGraphClients
    a = load_connection_config(None, host="h", port=1, username="", password="")
    b = load_connection_config(None, host="h", port=1, username=None, password=None)
    assert TopologyGraphClients.identity(a) == TopologyGraphClients.identity(b)


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

        async def discover_master(self, name):
            captured["discover_master"] = name
            return ("discovered-master", 6379)

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
        # The addresses this fake "cluster" announces (as a real slot map
        # would: pod IPs). Tests override via captured["cluster_announced"].
        def __init__(self, startup_nodes=None, **kwargs):
            captured["cluster_startup_nodes"] = startup_nodes
            captured["cluster_kwargs"] = kwargs

        async def initialize(self):
            captured["cluster_initialized"] = True

        def keyslot(self, key):
            return 42

        @property
        def nodes_manager(self):
            announced = captured.get("cluster_announced", [("10.0.0.5", 7001)])
            host, port = announced[0]
            node = types.SimpleNamespace(host=host, port=port)
            return types.SimpleNamespace(get_node_from_slot=lambda slot: node)

        def get_primaries(self):
            announced = captured.get("cluster_announced", [("10.0.0.5", 7001)])
            return [types.SimpleNamespace(host=h, port=p) for h, p in announced]

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


def test_sentinel_dedicated_password_only_never_pairs_data_plane_username():
    """Dedicated daemon credentials win AS A UNIT. A password-only daemon
    (default user + requirepass — the `redis://:pw@…` shape) must NOT get the
    graph username spliced in by a per-field authEnabled fallback: that
    mismatched pair fails AUTH and takes discover_master down."""
    from backend.app.providers.falkordb_connection import _sentinel_auth_kwargs

    for auth_enabled in (False, True):
        cfg = load_connection_config(
            {"mode": "sentinel",
             "sentinel": {"masterName": "m", "nodes": [["s1", 26379]],
                          "password": "sd-pw", "authEnabled": auth_enabled}},
            host="h", port=6379, username="graphuser", password="graphpass",
        )
        kw = _sentinel_auth_kwargs(cfg, 10.0)
        assert kw["password"] == "sd-pw"
        assert "username" not in kw


# ── cross-cluster address remap ─────────────────────────────────────

def test_parse_address_remap_json_and_env_forms():
    from backend.app.providers.falkordb_connection import _parse_address_remap

    assert _parse_address_remap(
        {"10.0.0.5:6379": "graph.example.com:6379", "old-host": "new-host"}
    ) == (("10.0.0.5:6379", "graph.example.com:6379"), ("old-host", "new-host"))
    assert _parse_address_remap(
        "10.0.0.5:6379=graph.example.com:6379, old=new"
    ) == (("10.0.0.5:6379", "graph.example.com:6379"), ("old", "new"))
    assert _parse_address_remap(None) == ()
    # Malformed entries are skipped, valid ones kept.
    assert _parse_address_remap("no-equals-sign,a=b,=x") == (("a", "b"),)
    assert _parse_address_remap(["not", "a", "dict"]) == ()


def _remap_cfg(remap, mode="standalone", **kw):
    extra = {"mode": mode, "addressRemap": remap}
    if mode == "sentinel":
        extra["sentinel"] = {"masterName": "m", "nodes": [["s1", 26379]]}
    if mode == "cluster":
        extra["cluster"] = {"startupNodes": [["seed", 7000]]}
    return load_connection_config(extra, host="h", port=6379,
                                  username=None, password=None, **kw)


def test_remap_address_matrix():
    from backend.app.providers.falkordb_connection import remap_address

    cfg = _remap_cfg({
        "10.0.0.5:6379": "edge.example.com:16379",   # exact host:port
        "10.0.0.5": "fallback.example.com",          # host-only (loses to exact)
        "10.0.0.6": "edge2.example.com",             # host-only, port preserved
        "10.0.0.7": "edge3.example.com:26379",       # host-only, port replaced
    })
    assert remap_address(cfg, "10.0.0.5", 6379) == ("edge.example.com", 16379)
    assert remap_address(cfg, "10.0.0.5", 7000) == ("fallback.example.com", 7000)
    assert remap_address(cfg, "10.0.0.6", 6380) == ("edge2.example.com", 6380)
    assert remap_address(cfg, "10.0.0.7", 6379) == ("edge3.example.com", 26379)
    assert remap_address(cfg, "unmapped", 6379) == ("unmapped", 6379)
    # Empty remap is a strict no-op.
    empty = _remap_cfg(None)
    assert empty.address_remap == ()
    assert remap_address(empty, "10.0.0.5", 6379) == ("10.0.0.5", 6379)


@pytest.mark.asyncio
async def test_cluster_owner_resolution_remaps_the_announced_address(fake_redis_and_falkor):
    """The slot map answers with the address the CLUSTER knows (a pod IP,
    unreachable from another GKE cluster). The owner returned to callers — and
    therefore the pinned owning-node pool — must be the remapped endpoint."""
    fake_redis_and_falkor["cluster_announced"] = [("10.0.0.5", 7001)]
    cfg = _remap_cfg({"10.0.0.5:7001": "edge.example.com:17001"}, mode="cluster")
    host, port = await resolve_cluster_node_for_key(cfg, "g", 5.0)
    assert (host, port) == ("edge.example.com", 17001)


@pytest.mark.asyncio
async def test_discovery_cluster_client_carries_the_address_remap_hook(fake_redis_and_falkor):
    """CANARY for redis-py bumps: the short-lived discovery RedisCluster (and by
    the same code path build_cluster_conn's data-plane client) must forward the
    address_remap kwarg — discovery itself follows the slot map on redirects."""
    fake_redis_and_falkor["cluster_announced"] = [("10.0.0.5", 7001)]
    cfg = _remap_cfg({"10.0.0.5": "edge.example.com"}, mode="cluster")
    await resolve_cluster_node_for_key(cfg, "g", 5.0)
    hook = fake_redis_and_falkor["cluster_kwargs"].get("address_remap")
    assert callable(hook)
    assert hook(("10.0.0.5", 7001)) == ("edge.example.com", 7001)
    assert hook(("other", 7000)) == ("other", 7000)


@pytest.mark.asyncio
async def test_no_remap_means_no_hook_and_untouched_addresses(fake_redis_and_falkor):
    """Default-off: absent addressRemap, nothing changes — no kwarg, announced
    addresses pass through verbatim."""
    fake_redis_and_falkor["cluster_announced"] = [("10.0.0.5", 7001)]
    cfg = _remap_cfg(None, mode="cluster")
    host, port = await resolve_cluster_node_for_key(cfg, "g", 5.0)
    assert (host, port) == ("10.0.0.5", 7001)
    assert "address_remap" not in fake_redis_and_falkor["cluster_kwargs"]


@pytest.mark.asyncio
async def test_cluster_primaries_are_remapped(fake_redis_and_falkor):
    from backend.app.providers.falkordb_connection import cluster_primary_nodes

    fake_redis_and_falkor["cluster_announced"] = [("10.0.0.5", 7001), ("10.0.0.6", 7002)]
    cfg = _remap_cfg({"10.0.0.5": "edge-a", "10.0.0.6": "edge-b"}, mode="cluster")
    assert await cluster_primary_nodes(cfg, 5.0) == [("edge-a", 7001), ("edge-b", 7002)]


@pytest.mark.asyncio
async def test_build_cluster_conn_forwards_the_remap_hook(fake_redis_and_falkor):
    from backend.app.providers.falkordb_connection import build_cluster_conn

    cfg = _remap_cfg({"10.0.0.5": "edge"}, mode="cluster")
    build_cluster_conn(cfg, "seed", 7000, {"socket_timeout": 10.0})
    assert callable(fake_redis_and_falkor["cluster_kwargs"].get("address_remap"))


@pytest.mark.asyncio
async def test_sentinel_discovered_master_is_remapped(fake_redis_and_falkor):
    """resolve_sentinel_master (preflight/probes) rewrites what the sentinels
    announce; the fixture's sentinels announce 'discovered-master'."""
    from backend.app.providers.falkordb_connection import resolve_sentinel_master

    cfg = _remap_cfg({"discovered-master": "edge-master.example.com"}, mode="sentinel")
    host, port = await resolve_sentinel_master(cfg, 5.0)
    assert (host, port) == ("edge-master.example.com", 6379)


@pytest.mark.asyncio
async def test_sentinel_data_plane_uses_the_remapping_subclass(fake_redis_and_falkor):
    """master_for re-runs discover_master internally on every reconnect, so the
    remap must live INSIDE the Sentinel class handed to the data plane."""
    from backend.app.providers.falkordb_connection import _sentinel_class

    plain = _remap_cfg(None, mode="sentinel")
    remapped = _remap_cfg({"discovered-master": "edge"}, mode="sentinel")
    import sys
    base = sys.modules["redis.asyncio.sentinel"].Sentinel
    assert _sentinel_class(plain) is base                     # no remap → untouched
    cls = _sentinel_class(remapped)
    assert cls is not base and issubclass(cls, base)
    inst = cls([("s1", 26379)])
    assert await inst.discover_master("m") == ("edge", 6379)


def test_identity_changes_when_remap_changes():
    from backend.app.providers.falkordb_connection import TopologyGraphClients

    a = _remap_cfg(None, mode="cluster")
    b = _remap_cfg({"10.0.0.5": "edge"}, mode="cluster")
    assert TopologyGraphClients.identity(a) != TopologyGraphClients.identity(b)


# ── sentinel daemon TLS ─────────────────────────────────────────────

def _sentinel_tls_cfg(sentinel_extra=None, **load_kw):
    sentinel = {"masterName": "m", "nodes": [["s1", 26379]]}
    sentinel.update(sentinel_extra or {})
    return load_connection_config(
        {"mode": "sentinel", "sentinel": sentinel,
         "tls": {"enabled": True, "caCertPath": "/certs/data-ca.pem"}},
        host="h", port=6379, username=None, password=None, **load_kw,
    )


def test_sentinel_tls_inherits_data_plane_by_default():
    """TLS everywhere (the common GKE shape) needs NO extra config: absent
    sentinel.tls, the daemons inherit the data-plane TLS settings."""
    from backend.app.providers.falkordb_connection import _sentinel_auth_kwargs

    cfg = _sentinel_tls_cfg()
    assert cfg.sentinel_tls is None
    st = cfg.sentinel_tls_settings()
    assert st.enabled is True and st.ca_certs == "/certs/data-ca.pem"
    kw = _sentinel_auth_kwargs(cfg, 10.0)
    assert kw["ssl"] is True and kw["ssl_ca_certs"] == "/certs/data-ca.pem"


def test_sentinel_tls_explicit_disable_gives_plaintext_daemons():
    """sentinel.tls.enabled=false: TLS data plane, PLAINTEXT sentinels."""
    from backend.app.providers.falkordb_connection import _sentinel_auth_kwargs

    cfg = _sentinel_tls_cfg({"tls": {"enabled": False}})
    assert cfg.tls_enabled is True                       # data plane unchanged
    assert cfg.sentinel_tls_settings().enabled is False
    kw = _sentinel_auth_kwargs(cfg, 10.0)
    assert "ssl" not in kw and "ssl_ca_certs" not in kw


def test_sentinel_tls_per_key_override_inherits_the_rest():
    """An explicit sentinel.tls may override single keys (own CA); everything
    it does not name inherits from the data plane."""
    cfg = _sentinel_tls_cfg({"tls": {"enabled": True, "caCertPath": "/certs/sentinel-ca.pem"}})
    st = cfg.sentinel_tls_settings()
    assert st.ca_certs == "/certs/sentinel-ca.pem"       # overridden
    assert st.cert_reqs == "required"                    # inherited default
    # ...and the data plane keeps its own CA.
    assert cfg.tls_settings().ca_certs == "/certs/data-ca.pem"


def test_sentinel_tls_env_fallback(monkeypatch):
    """FALKORDB_SENTINEL_TLS_ENABLED turns daemon TLS on even when the data
    plane is plaintext (and the JSON has no sentinel.tls object)."""
    monkeypatch.setenv("FALKORDB_SENTINEL_TLS_ENABLED", "true")
    cfg = load_connection_config(
        {"mode": "sentinel", "sentinel": {"masterName": "m", "nodes": [["s1", 26379]]}},
        host="h", port=6379, username=None, password=None,
    )
    assert cfg.tls_enabled is False
    assert cfg.sentinel_tls_settings().enabled is True


@pytest.mark.asyncio
async def test_build_graph_client_sentinel_daemons_carry_tls(fake_redis_and_falkor):
    """THE reported break: TLS-enabled sentinels were dialed PLAINTEXT because
    the daemon kwargs never carried ssl — discovery failed and the whole tier
    read as down. Both the daemon connections and the master pool must be TLS."""
    cfg = _sentinel_tls_cfg()
    await build_graph_client(cfg, graph_name="g", pool_kwargs={"socket_timeout": 10.0})
    sk = fake_redis_and_falkor["sentinel_kwargs"]["sentinel_kwargs"]
    assert sk["ssl"] is True and sk["ssl_ca_certs"] == "/certs/data-ca.pem"
    mk = fake_redis_and_falkor["master_for_kwargs"]
    assert mk["ssl"] is True


@pytest.mark.asyncio
async def test_resolve_sentinel_master_uses_only_sentinel_kwargs(fake_redis_and_falkor):
    """Discovery never opens a data-plane connection: the daemon auth/TLS ride
    ONLY in sentinel_kwargs, never spread as connection kwargs (a master pool
    built off the object would inherit the DAEMONS' credentials)."""
    from backend.app.providers.falkordb_connection import resolve_sentinel_master

    cfg = _sentinel_tls_cfg({"username": "sentineluser", "password": "sentinelpass"})
    host, port = await resolve_sentinel_master(cfg, 5.0)
    assert (host, port) == ("discovered-master", 6379)
    ctor_kwargs = fake_redis_and_falkor["sentinel_kwargs"]
    inner = ctor_kwargs["sentinel_kwargs"]
    assert inner["password"] == "sentinelpass" and inner["ssl"] is True
    # Nothing spread at the top level besides sentinel_kwargs itself.
    assert set(ctor_kwargs.keys()) == {"sentinel_kwargs"}


def test_identity_changes_when_sentinel_tls_changes():
    from backend.app.providers.falkordb_connection import TopologyGraphClients

    plain = _sentinel_tls_cfg()
    disabled = _sentinel_tls_cfg({"tls": {"enabled": False}})
    assert (
        TopologyGraphClients.identity(plain)
        != TopologyGraphClients.identity(disabled)
    )


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
