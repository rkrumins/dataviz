"""The full FalkorDB authentication matrix: (instance auth ON/OFF) × (credentials
present/absent) × (standalone / sentinel / cluster), across every connection path.

The three outcomes, and why they must never be confused with an outage:

  auth_not_configured — we sent credentials, the instance has no password. Whether
      this even errors is version- and ACL-dependent (a `nopass` default user accepts
      any password over redis-py's HELLO AUTH; a plain RESP2 AUTH against the same
      server errors), so the code must handle it rather than rely on luck. SELF-HEAL:
      drop the credentials and reconnect — a stale password on a provider row must
      never take a healthy graph offline.
  auth_required  — NOAUTH: the instance wants credentials we don't have.
  auth_rejected  — WRONGPASS: the credentials are wrong.

The last two are CONFIGURATION errors. This matters because redis-py's
``AuthenticationError`` SUBCLASSES redis ``ConnectionError``: without an explicit
mapping the provider retried bad credentials as a transient blip (and in cluster mode
re-resolved the topology for them) and the circuit breaker tripped — reporting a
misconfiguration as "provider unavailable" and hammering it forever.
"""
import pytest
from redis.exceptions import AuthenticationError, ResponseError

from backend.app.providers import falkordb_connection as fc
from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    apply_learned_auth,
    is_auth_not_configured_error,
    is_auth_rejected_error,
    is_auth_required_error,
    strip_credentials,
    with_auth_negotiation,
)
from backend.common.interfaces.provider import ProviderConfigurationError


@pytest.fixture(autouse=True)
def _clear_auth_memo():
    fc._UNAUTHENTICATED_INSTANCES.clear()
    yield
    fc._UNAUTHENTICATED_INSTANCES.clear()


# The real server replies, verbatim.
ERR_NO_PASSWORD_ACL = ResponseError(
    "ERR AUTH <password> called without any password configured for the default "
    "user. Are you sure your configuration is correct?"
)
ERR_NO_PASSWORD_LEGACY = ResponseError(
    "ERR Client sent AUTH, but no password is set"
)
ERR_NOAUTH = ResponseError("NOAUTH Authentication required.")
# What redis-py ACTUALLY raises on its RESP3 handshake against an auth-enabled server
# when no credentials are configured — no "NOAUTH" anywhere in it. Found by driving a
# real `requirepass` instance; the earlier classifier missed this case entirely.
ERR_HELLO_UNAUTHENTICATED = AuthenticationError(
    "HELLO must be called with the client already authenticated, otherwise the "
    "HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client "
    "and select the RESP protocol version"
)
ERR_WRONGPASS = AuthenticationError("WRONGPASS invalid username-password pair")


# ── classification ───────────────────────────────────────────────────

def test_classifies_every_server_reply():
    assert is_auth_not_configured_error(ERR_NO_PASSWORD_ACL)
    assert is_auth_not_configured_error(ERR_NO_PASSWORD_LEGACY)
    assert is_auth_required_error(ERR_NOAUTH)
    assert is_auth_required_error(ERR_HELLO_UNAUTHENTICATED)   # the RESP3 handshake
    assert is_auth_rejected_error(ERR_WRONGPASS)
    # ...and doesn't mistake a real outage for an auth problem.
    assert not is_auth_not_configured_error(ConnectionError("connection refused"))
    assert not is_auth_required_error(ConnectionError("connection refused"))


@pytest.mark.asyncio
async def test_resp3_handshake_without_credentials_is_a_config_error():
    """The live-verified shape: an auth-enabled instance + a provider row with no
    credentials. redis-py raises AuthenticationError whose message contains no
    'NOAUTH' — the first classifier missed it and the failure would have been retried
    as a transient blip and tripped the breaker."""
    cfg = _cfg()

    async def attempt(c):
        raise ERR_HELLO_UNAUTHENTICATED

    with pytest.raises(ProviderConfigurationError, match="requires authentication"):
        await with_auth_negotiation(cfg, attempt)


def test_auth_errors_are_not_transient_and_must_not_trip_the_breaker():
    """redis-py's AuthenticationError subclasses redis ConnectionError, so without an
    explicit exclusion bad credentials were retried as a blip and opened the breaker —
    surfacing a misconfiguration as an outage."""
    from backend.app.providers.falkordb_provider import _is_transient_connection_error

    assert _is_transient_connection_error(ConnectionError("reset by peer")) in (True, False)
    assert not _is_transient_connection_error(ERR_WRONGPASS)
    assert not _is_transient_connection_error(ERR_NOAUTH)
    assert not _is_transient_connection_error(ERR_NO_PASSWORD_ACL)


# ── the matrix, through the shared negotiation ───────────────────────

def _cfg(mode="standalone", **kw):
    base = dict(host="h", port=6379)
    if mode == "sentinel":
        base.update(sentinel_master="m", sentinel_nodes=[("s1", 26379)])
    if mode == "cluster":
        base.update(cluster_nodes=[("n1", 7000)])
    base.update(kw)
    return FalkorDBConnConfig(mode=mode, **base)


@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_creds_against_an_unauthenticated_instance_self_heal(mode):
    """CASE: instance auth OFF, provider row HAS credentials (stale password).
    Must reconnect without them — in every topology — not report the graph down."""
    cfg = _cfg(mode, username="u", password="stale")
    seen = []

    async def attempt(c):
        seen.append((c.username, c.password))
        if c.password:                       # the server rejects AUTH: it has none
            raise ERR_NO_PASSWORD_ACL
        return "connected"

    assert await with_auth_negotiation(cfg, attempt) == "connected"
    assert seen == [("u", "stale"), (None, None)]     # retried WITHOUT credentials

    # …and the lesson is remembered, so every later connection skips AUTH outright.
    assert apply_learned_auth(cfg).password is None
    seen.clear()
    assert await with_auth_negotiation(cfg, attempt) == "connected"
    assert seen == [(None, None)]                     # no failed attempt this time


@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_no_creds_against_an_auth_required_instance_is_a_config_error(mode):
    """CASE: instance auth ON, provider row has NO credentials. A clear config error —
    never a retried, breaker-tripping 'outage'."""
    cfg = _cfg(mode)

    async def attempt(c):
        raise ERR_NOAUTH

    with pytest.raises(ProviderConfigurationError, match="requires authentication"):
        await with_auth_negotiation(cfg, attempt)


@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_wrong_creds_are_a_config_error(mode):
    """CASE: instance auth ON, provider row has the WRONG credentials."""
    cfg = _cfg(mode, username="u", password="wrong")

    async def attempt(c):
        raise ERR_WRONGPASS

    with pytest.raises(ProviderConfigurationError, match="rejected"):
        await with_auth_negotiation(cfg, attempt)


@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_matching_credentials_connect_normally(mode):
    """CASE: instance auth ON, correct credentials — untouched."""
    cfg = _cfg(mode, username="u", password="right")

    async def attempt(c):
        assert (c.username, c.password) == ("u", "right")
        return "connected"

    assert await with_auth_negotiation(cfg, attempt) == "connected"


@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_no_auth_instance_no_creds_is_the_plain_path(mode):
    """CASE: instance auth OFF, no credentials — the common dev/k8s shape."""
    cfg = _cfg(mode)

    async def attempt(c):
        assert not c.username and not c.password
        return "connected"

    assert await with_auth_negotiation(cfg, attempt) == "connected"


@pytest.mark.asyncio
async def test_a_real_outage_still_propagates_as_an_outage():
    """An auth-shaped wrapper must not swallow genuine connection failures — they
    still reach the breaker."""
    cfg = _cfg(username="u", password="p")

    async def attempt(c):
        raise ConnectionError("connection refused")

    with pytest.raises(ConnectionError):
        await with_auth_negotiation(cfg, attempt)


# ── the cluster "no reachable node" wrapper must classify as auth ────

def test_cluster_no_reachable_node_wrapping_the_hello_error_is_auth():
    """redis-py 8 defaults to RESP3, so an auth cluster with NO configured credential
    fails every startup node with the HELLO handshake error, and NodesManager.initialize
    re-raises `RedisClusterException("...at least one reachable node: <cause>") from
    <cause>`. The wrapper inlines the cause text AND chains it — both must classify as
    auth_required so it surfaces as a config error, never a retried outage."""
    from redis.exceptions import RedisClusterException

    wrapped = RedisClusterException(
        "Redis Cluster cannot be connected. Please provide at least one reachable "
        f"node: {ERR_HELLO_UNAUTHENTICATED}"
    )
    wrapped.__cause__ = ERR_HELLO_UNAUTHENTICATED
    assert is_auth_required_error(wrapped)
    assert not is_auth_rejected_error(wrapped)


@pytest.mark.asyncio
async def test_cluster_primary_nodes_surfaces_auth_as_config_error(monkeypatch):
    """The keyless GRAPH.LIST path (graph name-availability) is now wrapped in
    with_auth_negotiation, so a cluster with auth but no configured credential yields a
    clean ProviderConfigurationError instead of the raw RedisClusterException that would
    trip the operation breaker."""
    from redis.exceptions import RedisClusterException

    async def _boom(cfg, socket_timeout):
        exc = RedisClusterException(
            "Redis Cluster cannot be connected. Please provide at least one reachable "
            f"node: {ERR_HELLO_UNAUTHENTICATED}"
        )
        exc.__cause__ = ERR_HELLO_UNAUTHENTICATED
        raise exc

    monkeypatch.setattr(fc, "_cluster_primary_nodes_once", _boom)
    with pytest.raises(ProviderConfigurationError, match="requires authentication"):
        await fc.cluster_primary_nodes(_cfg(mode="cluster"), 5.0)


# ── the symmetric self-heal: auth RE-ENABLED on a learned-unauth instance ──

@pytest.mark.parametrize("mode", ["standalone", "sentinel", "cluster"])
@pytest.mark.asyncio
async def test_auth_reenabled_unlearns_and_retries_with_credentials(mode):
    """CASE: instance was learned unauthenticated (credentials stripped), then auth
    is ENABLED on the server. The NOAUTH on the stripped connection must un-learn
    the mark and retry ONCE with the configured credentials — not dead-end in a
    false 'no credentials configured' until process restart."""
    cfg = _cfg(mode, username="u", password="p")
    fc.mark_instance_unauthenticated(cfg)
    seen = []

    async def attempt(c):
        seen.append((c.username, c.password))
        if not c.password:                   # the server now demands AUTH
            raise ERR_NOAUTH
        return "connected"

    assert await with_auth_negotiation(cfg, attempt) == "connected"
    assert seen == [(None, None), ("u", "p")]          # exactly two attempts
    assert not fc.is_instance_learned_unauthenticated(cfg)
    # ...and the un-learn reaches every pool builder again.
    kw = fc.build_graph_pool_kwargs(cfg, socket_timeout=10.0)
    assert kw.get("password") == "p"


@pytest.mark.asyncio
async def test_auth_reenabled_with_wrong_creds_is_a_clean_config_error():
    """The retry after un-learn fails too (row credentials genuinely wrong) →
    a clean 'rejected' config error, never a loop and never a raw redis error."""
    cfg = _cfg(username="u", password="wrong")
    fc.mark_instance_unauthenticated(cfg)
    seen = []

    async def attempt(c):
        seen.append((c.username, c.password))
        raise ERR_NOAUTH if not c.password else ERR_WRONGPASS

    with pytest.raises(ProviderConfigurationError, match="rejected"):
        await with_auth_negotiation(cfg, attempt)
    assert seen == [(None, None), ("u", "wrong")]      # bounded: two attempts, no loop


@pytest.mark.asyncio
async def test_noauth_without_a_learned_mark_never_retries():
    """NOAUTH when nothing was stripped is a plain config error — the un-learn
    retry only fires when the learned mark actually removed credentials."""
    cfg = _cfg(username="u", password="p")
    calls = {"n": 0}

    async def attempt(c):
        calls["n"] += 1
        raise ERR_NOAUTH

    with pytest.raises(ProviderConfigurationError, match="requires authentication"):
        await with_auth_negotiation(cfg, attempt)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_invalidate_config_clears_the_learned_mark():
    """A provider config change (evict_provider → invalidate_config) must also
    invalidate what we LEARNED about the instance's auth — the operator may have
    just enabled authentication or rotated the credentials."""
    cfg = _cfg(username="u", password="p")
    fc.mark_instance_unauthenticated(cfg)
    assert fc.is_instance_learned_unauthenticated(cfg)
    await fc.TopologyGraphClients().invalidate_config(cfg)
    assert not fc.is_instance_learned_unauthenticated(cfg)


@pytest.mark.asyncio
async def test_resilient_graph_reconnects_with_creds_when_auth_is_reenabled():
    """The registry/projector handle: a cached credential-less client (learned
    mark) hitting NOAUTH must un-learn, rebuild WITH the handle's credentials,
    and retry once."""
    cfg = _cfg(username="u", password="p")
    fc.mark_instance_unauthenticated(cfg)

    class _OkGraph:
        async def query(self, *a, **kw):
            return "ok"

    class _NoAuthGraph:
        async def query(self, *a, **kw):
            raise ERR_NOAUTH

    invalidated = []

    class _Clients:
        async def invalidate(self, c, name):
            invalidated.append(name)

        async def resolve_graph(self, c, name):
            # After the un-learn the rebuild must carry credentials again.
            assert not fc.is_instance_learned_unauthenticated(c)
            return _OkGraph()

    g = fc.ResilientGraph(_Clients(), cfg, "g1", _NoAuthGraph())
    assert await g.query("RETURN 1") == "ok"
    assert invalidated == ["g1"]
    assert not fc.is_instance_learned_unauthenticated(cfg)


@pytest.mark.asyncio
async def test_resilient_graph_noauth_without_mark_is_still_a_config_error():
    cfg = _cfg(username="u", password="p")

    class _NoAuthGraph:
        async def query(self, *a, **kw):
            raise ERR_NOAUTH

    class _Clients:
        async def invalidate(self, c, name):          # pragma: no cover
            raise AssertionError("must not rebuild on a plain config error")

        async def resolve_graph(self, c, name):       # pragma: no cover
            raise AssertionError("must not rebuild on a plain config error")

    g = fc.ResilientGraph(_Clients(), cfg, "g1", _NoAuthGraph())
    with pytest.raises(ProviderConfigurationError, match="requires authentication"):
        await g.query("RETURN 1")


@pytest.mark.asyncio
async def test_provider_connect_restores_row_credentials_when_auth_is_reenabled(monkeypatch):
    """The provider's connect path: an earlier 'no auth configured' self-heal
    nulled self._username/_password for the process, then auth is enabled on the
    server. The NOAUTH connect must restore the row credentials (they survive in
    self._credentials), un-learn the instance, and rebuild once WITH them —
    instead of the old permanent dead-end ProviderConfigurationError."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host="h", port=6379, graph_name="g",
        username="u", password="p",
        credentials={"username": "u", "password": "p"},
    )
    # Simulate the earlier auth_not_configured self-heal in this process:
    cfg0 = fc.load_connection_config(None, host=p._host, port=6379,
                                     username="u", password="p")
    fc.mark_instance_unauthenticated(cfg0)
    p._username = None
    p._password = None

    attempts = []

    async def fake_build_and_verify(pool_kwargs, init_timeout):
        attempts.append("password" in pool_kwargs)
        if not pool_kwargs.get("password"):
            raise ERR_NOAUTH                       # server now demands AUTH
        p._graph = object()                        # success: connected handle

    monkeypatch.setattr(p, "_build_and_verify", fake_build_and_verify)
    monkeypatch.setattr(p, "_schedule_reconcile_once", lambda: None)

    await p._ensure_connected()
    assert attempts == [False, True]               # retried once, WITH credentials
    assert (p._username, p._password) == ("u", "p")
    assert not fc.is_instance_learned_unauthenticated(p._conn_cfg)


# ── the learned state reaches every pool builder ─────────────────────

def test_learned_no_auth_strips_credentials_from_every_pool_builder():
    """Once an instance is known to have no auth, EVERY path (graph pools, the
    high-level Sentinel/Cluster clients) must stop sending AUTH — not just the one
    that discovered it."""
    cfg = _cfg(username="u", password="p")
    fc.mark_instance_unauthenticated(cfg)

    kw = fc.build_graph_pool_kwargs(cfg, socket_timeout=10.0)
    assert "password" not in kw and "username" not in kw

    conn_kw = fc._conn_auth_kwargs(cfg, 10.0)
    assert "password" not in conn_kw and "username" not in conn_kw


def test_explicit_auth_disabled_still_wins_up_front():
    """The operator's explicit switch (falkordbConnection.authEnabled=false) nulls the
    credentials before any connection is attempted — unchanged behavior."""
    from backend.app.providers.falkor_graph_registry import resolve_provider_conn_config

    assert callable(resolve_provider_conn_config)
    # The gate itself is pinned in test_falkordb_topology_routing (cluster row sets
    # authEnabled=false and no credentials reach the pool).
    assert strip_credentials(_cfg(username="u", password="p")).password is None


# ── preflight: a stale password must not report a healthy graph as down ──

def test_preflight_treats_auth_not_configured_as_reachable():
    from backend.common.interfaces.preflight import _redis_auth_reason

    reason = _redis_auth_reason(
        b"-ERR AUTH <password> called without any password configured for the "
        b"default user.\r\n",
        had_password=True,
    )
    assert reason == "auth_not_configured"
    # NOAUTH / WRONGPASS stay real failures.
    assert _redis_auth_reason(b"-NOAUTH Authentication required.\r\n",
                              had_password=False) == "auth_required"
    assert _redis_auth_reason(b"-WRONGPASS invalid username-password pair\r\n",
                              had_password=True) == "auth_failed"
