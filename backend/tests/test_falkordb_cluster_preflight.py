"""The FalkorDB cluster preflight must be a CHEAP, deadline-clean, resilient
reachability+AUTH probe — never a heavyweight RedisCluster build.

Regression for the production symptom: a cluster+auth provider warmup reported
``warmup_wall_clock_exceeded`` (and ``connect_timeout``). Root cause: the probe
built a RedisCluster to resolve the owning node — RedisCluster.initialize()
connects to EVERY startup node, verifies full slot coverage and retries, and its
aclose() blocks the deadline-cancel, so one slow/down node added ~2s (measured)
and under real latency overran the budget; on discovery-timeout it then pinged
cluster_nodes[0], which could be the down node (connect_timeout).

Fixed by probing startup nodes with a raw AUTH+PING, in order, stopping on the
first reachable node (or a definitive auth verdict — the cluster shares one
credential). Owning-node discovery stays in the CONNECT path (cached).
"""
import pytest

import backend.common.interfaces.preflight as pf_mod
import backend.app.providers.falkordb_connection as fc_mod
from backend.common.interfaces.preflight import PreflightResult
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _cluster_provider(nodes, password="pw"):
    fc = {"mode": "cluster", "cluster": {"startupNodes": nodes}}
    return FalkorDBProvider(
        host=nodes[0][0], port=nodes[0][1], graph_name="g",
        password=password, connection_config=fc, auth_enabled=True,
        extra_config={"falkordbConnection": fc},
        credentials={"password": password} if password else {},
    )


@pytest.mark.asyncio
async def test_probe_skips_a_down_node_and_pings_the_next(monkeypatch):
    calls = []

    async def fake(host, port, **kw):
        calls.append((host, port))
        if host == "down":
            return PreflightResult.failure("connect_timeout", 100)
        return PreflightResult.success(f"{host}:{port}", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _cluster_provider([["down", 6379], ["up", 6379], ["up2", 6379]])
    r = await p.preflight(deadline_s=3.0)
    assert r.ok
    assert calls == [("down", 6379), ("up", 6379)]  # tried down, then up, then STOPPED


@pytest.mark.asyncio
async def test_probe_stops_on_a_definitive_auth_verdict_without_retrying_nodes(monkeypatch):
    calls = []

    async def fake(host, port, **kw):
        calls.append((host, port))
        return PreflightResult.failure("auth_required", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _cluster_provider([["n1", 6379], ["n2", 6379], ["n3", 6379]])
    r = await p.preflight(deadline_s=3.0)
    assert r.reason == "auth_required"
    assert calls == [("n1", 6379)]  # one credential for the whole cluster — don't retry


@pytest.mark.asyncio
async def test_probe_passes_the_configured_credentials_to_every_node(monkeypatch):
    seen = []

    async def fake(host, port, *, password=None, username=None, **kw):
        seen.append((host, password, username))
        return PreflightResult.failure("connect_timeout", 1)  # force it to try all

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _cluster_provider([["a", 6379], ["b", 6379]], password="secret")
    await p.preflight(deadline_s=2.0)
    assert [pw for _, pw, _ in seen] == ["secret", "secret"]  # auth sent to each node


@pytest.mark.asyncio
async def test_probe_never_builds_a_rediscluster(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("preflight must NOT build a RedisCluster / resolve slots")

    monkeypatch.setattr(fc_mod, "resolve_cluster_node_for_key", boom)

    async def fake(host, port, **kw):
        return PreflightResult.success(f"{host}:{port}", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _cluster_provider([["n1", 6379]])
    r = await p.preflight(deadline_s=3.0)
    assert r.ok  # resolve_cluster_node_for_key was never called (else boom)


@pytest.mark.parametrize(
    "auth_enabled,password_kept",
    [
        (True, True),          # explicit on
        (None, True),          # null / JSON null — must NOT drop the password
        ("true", True),
        (0, True),             # weird truthy-ish — keep the credential (safe)
        (False, False),        # explicit off — honored
        ("false", False),      # explicit off (string) — honored
    ],
)
def test_only_explicit_false_authEnabled_drops_a_saved_password(auth_enabled, password_kept):
    """The footgun: a configured graph password must survive a null / absent /
    weird ``authEnabled``. Before, ``password if auth_enabled else None`` treated
    a stored ``null`` as falsy and silently dropped the credential, so a provider
    configured with auth in the UI still probed ``auth_required``. Only an
    EXPLICIT false may disable auth."""
    p = FalkorDBProvider(
        host="h", port=6379, graph_name="g", password="secret",
        auth_enabled=auth_enabled, credentials={"password": "secret"},
    )
    assert (p._password is not None) is password_kept
    assert p._auth_enabled is password_kept


# ── sentinel preflight: the fallback target is a DAEMON, not the data plane ──

def _sentinel_provider(tls=None, sentinel_extra=None, password="graphpass"):
    sentinel = {"masterName": "m", "nodes": [["s1", 26379]]}
    sentinel.update(sentinel_extra or {})
    fc_json = {"mode": "sentinel", "sentinel": sentinel}
    if tls is not None:
        fc_json["tls"] = tls
    return FalkorDBProvider(
        host="h", port=6379, graph_name="g", password=password,
        connection_config=fc_json,
        credentials={"password": password} if password else {},
    )


@pytest.mark.asyncio
async def test_sentinel_fallback_probes_the_daemon_with_daemon_identity(monkeypatch):
    """When master discovery fails, the fallback pings a Sentinel DAEMON — a
    separate service with its own auth and its own TLS listener. Probing it with
    the GRAPH password + GRAPH TLS context reported auth_failed / a garbled
    handshake against a healthy tier whenever the two differ (here: TLS data
    plane, plaintext unauthenticated sentinels)."""
    async def discovery_fails(cfg, socket_timeout):
        raise ConnectionError("no sentinel quorum")

    monkeypatch.setattr(fc_mod, "resolve_sentinel_master", discovery_fails)
    seen = {}

    async def fake(host, port, *, username=None, password=None, ssl_context=None, **kw):
        seen.update(host=host, port=port, username=username,
                    password=password, ssl_context=ssl_context)
        return PreflightResult.success(f"{host}:{port}", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _sentinel_provider(
        tls={"enabled": True, "verifyMode": "none"},
        sentinel_extra={"tls": {"enabled": False}},        # plaintext daemons
    )
    r = await p.preflight(deadline_s=2.0)
    assert r.ok
    assert (seen["host"], seen["port"]) == ("s1", 26379)   # fell back to the daemon
    assert seen["password"] is None                        # no graph secret leaked
    assert seen["ssl_context"] is None                     # daemon listener is plaintext


@pytest.mark.asyncio
async def test_sentinel_fallback_uses_sentinel_credentials_when_configured(monkeypatch):
    async def discovery_fails(cfg, socket_timeout):
        raise ConnectionError("no sentinel quorum")

    monkeypatch.setattr(fc_mod, "resolve_sentinel_master", discovery_fails)
    seen = {}

    async def fake(host, port, *, username=None, password=None, ssl_context=None, **kw):
        seen.update(username=username, password=password)
        return PreflightResult.success(f"{host}:{port}", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _sentinel_provider(sentinel_extra={"authEnabled": True})
    await p.preflight(deadline_s=2.0)
    assert seen["password"] == "graphpass"     # authEnabled opts the daemons in


@pytest.mark.asyncio
async def test_sentinel_master_probe_keeps_the_data_plane_identity(monkeypatch):
    """When discovery SUCCEEDS the probe target is the MASTER: data-plane
    credentials and data-plane TLS, exactly as before."""
    async def discovery_ok(cfg, socket_timeout):
        return ("the-master", 6379)

    monkeypatch.setattr(fc_mod, "resolve_sentinel_master", discovery_ok)
    seen = {}

    async def fake(host, port, *, username=None, password=None, ssl_context=None, **kw):
        seen.update(host=host, port=port, password=password, ssl_context=ssl_context)
        return PreflightResult.success(f"{host}:{port}", 5)

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", fake)
    p = _sentinel_provider(
        tls={"enabled": True, "verifyMode": "none"},
        sentinel_extra={"tls": {"enabled": False}},
    )
    r = await p.preflight(deadline_s=2.0)
    assert r.ok
    assert (seen["host"], seen["port"]) == ("the-master", 6379)
    assert seen["password"] == "graphpass"                 # data-plane auth
    assert seen["ssl_context"] is not None                 # data-plane TLS


@pytest.mark.asyncio
async def test_cluster_mode_without_nodes_is_a_definitive_config_failure(monkeypatch):
    """mode=cluster with NO startup nodes used to silently fall through to a
    standalone ping of self._host (typically localhost) — a verdict about a
    host nobody will dial. It must surface as its own failure reason instead."""
    async def never(host, port, **kw):
        raise AssertionError("must not ping anything: the config is incomplete")

    monkeypatch.setattr(pf_mod, "redis_ping_preflight", never)
    fc = {"mode": "cluster", "cluster": {"startupNodes": []}}
    p = FalkorDBProvider(host="h", port=6379, graph_name="g", connection_config=fc)
    r = await p.preflight(deadline_s=2.0)
    assert not r.ok
    assert r.reason == "cluster_nodes_missing"
