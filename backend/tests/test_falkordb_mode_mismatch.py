"""Standalone-vs-cluster mode-mismatch detection.

A standalone-mode provider pointed at a Redis Cluster node "works" just well
enough to be dangerous: keyless GRAPH.LIST reports only that node's graphs
(a random fraction behind a load-balanced Service) and keyed commands fail
with bare MOVED errors. These tests pin the two detection points:

- ``redis_ping_preflight(detect_cluster=True)`` → ``cluster_mode_mismatch``
  reason when the server reports ``cluster_enabled:1`` (fail-open on INFO
  errors, never issued unless requested);
- ``verify_not_cluster_node`` → ProviderConfigurationError at client-build
  time for a standalone config against a cluster-enabled server (no-op in
  cluster/sentinel modes, fail-open on probe errors).
"""
import asyncio
from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    verify_not_cluster_node,
)
from backend.common.interfaces.preflight import redis_ping_preflight
from backend.common.interfaces.provider import ProviderConfigurationError


def _info_reply(payload: bytes) -> bytes:
    return b"$" + str(len(payload)).encode() + b"\r\n" + payload + b"\r\n"


async def _run_preflight(replies: list[bytes], **kwargs):
    """Same in-process scripted-RESP-server harness as
    test_preflight_auth_classification."""
    async def handle(reader, writer):
        writer.write(b"".join(replies))
        await writer.drain()
        try:
            await asyncio.sleep(0.2)
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        return await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=1.0, **kwargs,
        )


# ── redis_ping_preflight detect_cluster ─────────────────────────────

@pytest.mark.asyncio
async def test_detect_cluster_flags_cluster_enabled_server():
    res = await _run_preflight(
        [b"+PONG\r\n", _info_reply(b"# Cluster\r\ncluster_enabled:1\r\n")],
        detect_cluster=True,
    )
    assert res.ok is False
    assert res.reason == "cluster_mode_mismatch"


@pytest.mark.asyncio
async def test_detect_cluster_passes_standalone_server():
    res = await _run_preflight(
        [b"+PONG\r\n", _info_reply(b"# Cluster\r\ncluster_enabled:0\r\n")],
        detect_cluster=True,
    )
    assert res.ok is True


@pytest.mark.asyncio
async def test_detect_cluster_fails_open_on_info_error():
    # The server answered PING; a flaky INFO must not fail the probe.
    res = await _run_preflight(
        [b"+PONG\r\n", b"-ERR INFO unavailable\r\n"],
        detect_cluster=True,
    )
    assert res.ok is True


@pytest.mark.asyncio
async def test_info_not_issued_unless_requested():
    received = {}

    async def handle(reader, writer):
        writer.write(b"+PONG\r\n")
        await writer.drain()
        await asyncio.sleep(0.15)
        received["extra"] = reader._buffer if hasattr(reader, "_buffer") else b""
        try:
            data = await asyncio.wait_for(reader.read(64), timeout=0.05)
        except asyncio.TimeoutError:
            data = b""
        received["post_ping"] = data
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        res = await redis_ping_preflight("127.0.0.1", port, deadline_s=1.0)
        # Consume the PING the client sent, then confirm nothing follows.
        await asyncio.sleep(0.25)
    assert res.ok is True
    assert b"INFO" not in received.get("post_ping", b"")


# ── FalkorDBProvider.preflight wiring ───────────────────────────────

@pytest.mark.asyncio
async def test_provider_preflight_requests_detection_only_in_standalone(monkeypatch):
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    import backend.common.interfaces.preflight as preflight_mod

    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    captured = []

    async def fake_ping(host, port, **kw):
        captured.append(bool(kw.get("detect_cluster", False)))
        return SimpleNamespace(ok=True, reason="ok", elapsed_ms=1, peer=f"{host}:{port}")

    monkeypatch.setattr(preflight_mod, "redis_ping_preflight", fake_ping)

    standalone = FalkorDBProvider(host="x", graph_name="g")
    assert (await standalone.preflight(deadline_s=0.5)).ok
    assert captured == [True]

    captured.clear()
    cluster = FalkorDBProvider(host="x", graph_name="g")
    cluster._connection_config = {
        "mode": "cluster",
        "cluster": {"startupNodes": [["n1", 7000]]},
    }
    assert (await cluster.preflight(deadline_s=0.5)).ok
    assert captured == [False]           # cluster probe never asks for detection


# ── verify_not_cluster_node (client-build guard) ────────────────────

def _fake_redis(monkeypatch, info_result):
    class FakeRedis:
        def __init__(self, connection_pool=None, **kw):
            pass

        async def info(self, section=None):
            if isinstance(info_result, BaseException):
                raise info_result
            return info_result

    monkeypatch.setattr("redis.asyncio.Redis", FakeRedis)


@pytest.mark.asyncio
async def test_verify_raises_for_standalone_config_on_cluster_node(monkeypatch):
    _fake_redis(monkeypatch, {"cluster_enabled": 1})
    cfg = FalkorDBConnConfig(mode="standalone", host="h", port=6379)
    with pytest.raises(ProviderConfigurationError) as excinfo:
        await verify_not_cluster_node(cfg, object(), 1.0)
    assert "mode=cluster" in str(excinfo.value)


@pytest.mark.asyncio
async def test_verify_passes_real_standalone(monkeypatch):
    _fake_redis(monkeypatch, {"cluster_enabled": 0})
    cfg = FalkorDBConnConfig(mode="standalone", host="h", port=6379)
    await verify_not_cluster_node(cfg, object(), 1.0)     # no raise


@pytest.mark.asyncio
async def test_verify_noop_outside_standalone(monkeypatch):
    # Would raise if the probe ran — cluster mode must never issue it.
    _fake_redis(monkeypatch, RuntimeError("must not be called"))
    called = {"n": 0}

    class Boom:
        def __init__(self, *a, **k):
            called["n"] += 1

    monkeypatch.setattr("redis.asyncio.Redis", Boom)
    cfg = FalkorDBConnConfig(mode="cluster", host="h", port=6379,
                             cluster_nodes=[("n1", 7000)])
    await verify_not_cluster_node(cfg, object(), 1.0)
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_verify_fails_open_on_probe_error(monkeypatch):
    from redis.exceptions import ConnectionError as RedisConnectionError

    _fake_redis(monkeypatch, RedisConnectionError("blip"))
    cfg = FalkorDBConnConfig(mode="standalone", host="h", port=6379)
    await verify_not_cluster_node(cfg, object(), 1.0)     # no raise
