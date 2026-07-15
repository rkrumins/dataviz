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
