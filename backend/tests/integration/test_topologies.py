"""Integration tests: FalkorDB provider + aggregation + insights across
standalone / Sentinel / Cluster, with/without auth, with/without TLS.

These require a real FalkorDB endpoint (the cloud sandbox has none, so they
auto-skip). Stand one up with the compose harnesses in ``deploy/topologies/``
and point the test at it via env, e.g.::

    # standalone + auth + TLS
    FALKORDB_TEST_MODE=standalone \
    FALKORDB_TEST_HOST=127.0.0.1 FALKORDB_TEST_PORT=6379 \
    FALKORDB_TEST_PASSWORD=testpass \
    FALKORDB_TEST_TLS=1 FALKORDB_TEST_TLS_CA=deploy/topologies/certs/ca.crt \
    pytest backend/tests/integration/test_topologies.py -v

    # sentinel
    FALKORDB_TEST_MODE=sentinel \
    FALKORDB_TEST_SENTINEL_MASTER=mymaster \
    FALKORDB_TEST_SENTINEL_NODES=127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381 \
    FALKORDB_TEST_PASSWORD=testpass pytest ... -v

    # cluster
    FALKORDB_TEST_MODE=cluster \
    FALKORDB_TEST_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 \
    FALKORDB_TEST_PASSWORD=testpass pytest ... -v

Each combo is exercised end-to-end: preflight → connect → an aggregation write
(on_lineage_edge_written rolls a leaf edge up the containment chain) → an
insights stats read.
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

pytestmark = pytest.mark.integration


def _nodes(raw: str) -> list[list]:
    out = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        host, _, port = chunk.rpartition(":")
        out.append([host, int(port)])
    return out


def _mode() -> str:
    return os.getenv("FALKORDB_TEST_MODE", "").strip().lower()


def _configured() -> bool:
    m = _mode()
    if m == "standalone":
        return bool(os.getenv("FALKORDB_TEST_HOST"))
    if m == "sentinel":
        return bool(os.getenv("FALKORDB_TEST_SENTINEL_MASTER")
                    and os.getenv("FALKORDB_TEST_SENTINEL_NODES"))
    if m == "cluster":
        return bool(os.getenv("FALKORDB_TEST_CLUSTER_NODES"))
    return False


skip_if_unconfigured = pytest.mark.skipif(
    not _configured(),
    reason="Set FALKORDB_TEST_MODE + endpoint env (see module docstring).",
)


def _connection_config() -> dict | None:
    m = _mode()
    cfg: dict = {"mode": m}
    if m == "sentinel":
        cfg["sentinel"] = {
            "masterName": os.environ["FALKORDB_TEST_SENTINEL_MASTER"],
            "nodes": _nodes(os.environ["FALKORDB_TEST_SENTINEL_NODES"]),
        }
    elif m == "cluster":
        cfg["cluster"] = {
            "startupNodes": _nodes(os.environ["FALKORDB_TEST_CLUSTER_NODES"]),
        }
    if os.getenv("FALKORDB_TEST_TLS", "").strip().lower() in ("1", "true", "yes"):
        cfg["tls"] = {
            "enabled": True,
            "caCertPath": os.getenv("FALKORDB_TEST_TLS_CA") or None,
            "certPath": os.getenv("FALKORDB_TEST_TLS_CERT") or None,
            "keyPath": os.getenv("FALKORDB_TEST_TLS_KEY") or None,
            # Self-signed harness certs → default to no verification.
            "verifyMode": os.getenv("FALKORDB_TEST_TLS_VERIFY", "none"),
            "checkHostname": False,
        }
    # Cross-cluster simulation (docker-compose.falkordb-cluster-remap.yml):
    # the cluster announces addresses unreachable from the host; the test only
    # passes when the remap rewrites them. "from=to,..." CSV.
    remap = os.getenv("FALKORDB_TEST_ADDRESS_REMAP", "").strip()
    if remap:
        cfg["addressRemap"] = {
            src.strip(): dst.strip()
            for src, _, dst in (c.partition("=") for c in remap.split(",") if c.strip())
        }
    # Sentinel daemons on their own TLS setting ("1"/"0"; absent → inherit).
    sentinel_tls = os.getenv("FALKORDB_TEST_SENTINEL_TLS", "").strip().lower()
    if m == "sentinel" and sentinel_tls:
        cfg.setdefault("sentinel", {})["tls"] = {
            "enabled": sentinel_tls in ("1", "true", "yes"),
            "caCertPath": os.getenv("FALKORDB_TEST_TLS_CA") or None,
            "verifyMode": os.getenv("FALKORDB_TEST_TLS_VERIFY", "none"),
            "checkHostname": False,
        }
    return cfg


@pytest_asyncio.fixture
async def provider():
    if not _configured():
        pytest.skip("FalkorDB topology not configured")
    pytest.importorskip("falkordb")
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    host = os.getenv("FALKORDB_TEST_HOST", "127.0.0.1")
    port = int(os.getenv("FALKORDB_TEST_PORT", "6379"))
    graph = f"topo_test_{uuid.uuid4().hex[:8]}"
    p = FalkorDBProvider(
        host=host, port=port, graph_name=graph,
        username=os.getenv("FALKORDB_TEST_USERNAME"),
        password=os.getenv("FALKORDB_TEST_PASSWORD"),
        connection_config=_connection_config(),
        cache_redis_url=os.getenv("FALKORDB_TEST_CACHE_URL"),
        tls_enabled=os.getenv("FALKORDB_TEST_TLS", "").strip().lower()
        in ("1", "true", "yes"),
    )
    await p._ensure_connected()
    yield p
    try:
        await p.close()
    except Exception:
        pass


@skip_if_unconfigured
@pytest.mark.asyncio
async def test_preflight_reaches_endpoint():
    pytest.importorskip("falkordb")
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_TEST_HOST", "127.0.0.1"),
        port=int(os.getenv("FALKORDB_TEST_PORT", "6379")),
        graph_name="topo_preflight",
        username=os.getenv("FALKORDB_TEST_USERNAME"),
        password=os.getenv("FALKORDB_TEST_PASSWORD"),
        connection_config=_connection_config(),
        tls_enabled=os.getenv("FALKORDB_TEST_TLS", "").strip().lower()
        in ("1", "true", "yes"),
    )
    res = await p.preflight(deadline_s=5.0)
    assert res.ok, f"preflight failed: {res.reason}"


@skip_if_unconfigured
@pytest.mark.asyncio
async def test_aggregation_write_and_insights_read(provider):
    from backend.common.models.graph import GraphEdge, GraphNode

    # schemaA contains ds1, schemaB contains ds2; a leaf lineage edge ds1->ds2
    # must roll up to an AGGREGATED edge schemaA->schemaB.
    nodes = [
        GraphNode(urn="urn:topo:schema:A", entityType="schema", displayName="A"),
        GraphNode(urn="urn:topo:schema:B", entityType="schema", displayName="B"),
        GraphNode(urn="urn:topo:ds:1", entityType="dataset", displayName="1"),
        GraphNode(urn="urn:topo:ds:2", entityType="dataset", displayName="2"),
    ]
    edges = [
        GraphEdge(id="cA1", sourceUrn="urn:topo:schema:A", targetUrn="urn:topo:ds:1", edgeType="CONTAINS"),
        GraphEdge(id="cB2", sourceUrn="urn:topo:schema:B", targetUrn="urn:topo:ds:2", edgeType="CONTAINS"),
    ]
    provider.set_containment_edge_types(["CONTAINS"])
    await provider.save_custom_graph(nodes, edges)

    before = await provider.count_aggregated_edges()
    await provider.on_lineage_edge_written(
        "urn:topo:ds:1", "urn:topo:ds:2", "lin1", "DERIVES_FROM",
    )
    after = await provider.count_aggregated_edges()
    assert after >= before + 1  # aggregation write path (incl. cache) works

    # Insights/stats read path.
    stats = await provider.get_stats()
    assert stats is not None


@skip_if_unconfigured
@pytest.mark.asyncio
async def test_preflight_and_connect_agree():
    """The cheap probe and the heavyweight connect must give the SAME verdict
    for the configured combo — a preflight that says 'up' while connect fails
    (or vice versa) is how services flap between online/offline."""
    pytest.importorskip("falkordb")
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_TEST_HOST", "127.0.0.1"),
        port=int(os.getenv("FALKORDB_TEST_PORT", "6379")),
        graph_name=f"topo_agree_{uuid.uuid4().hex[:8]}",
        username=os.getenv("FALKORDB_TEST_USERNAME"),
        password=os.getenv("FALKORDB_TEST_PASSWORD"),
        connection_config=_connection_config(),
        tls_enabled=os.getenv("FALKORDB_TEST_TLS", "").strip().lower()
        in ("1", "true", "yes"),
    )
    res = await p.preflight(deadline_s=5.0)
    assert res.ok, f"preflight failed: {res.reason}"
    try:
        await p._ensure_connected()          # must not raise if preflight said ok
    finally:
        try:
            await p.close()
        except Exception:
            pass


@skip_if_unconfigured
@pytest.mark.asyncio
async def test_probe_falkordb_matches_topology(monkeypatch):
    """The system-status dashboard probe, driven by the same endpoint via the
    env-default instance: healthy for the configured combo, with the right
    per-mode shape (sentinel resolves the master; cluster fans out over every
    primary)."""
    pytest.importorskip("falkordb")

    m = _mode()
    monkeypatch.setenv("FALKORDB_MODE", m)
    monkeypatch.setenv("FALKORDB_HOST", os.getenv("FALKORDB_TEST_HOST", "127.0.0.1"))
    monkeypatch.setenv("FALKORDB_PORT", os.getenv("FALKORDB_TEST_PORT", "6379"))
    if os.getenv("FALKORDB_TEST_USERNAME"):
        monkeypatch.setenv("FALKORDB_USERNAME", os.environ["FALKORDB_TEST_USERNAME"])
    if os.getenv("FALKORDB_TEST_PASSWORD"):
        monkeypatch.setenv("FALKORDB_PASSWORD", os.environ["FALKORDB_TEST_PASSWORD"])
    if m == "sentinel":
        monkeypatch.setenv("FALKORDB_SENTINEL_MASTER",
                           os.environ["FALKORDB_TEST_SENTINEL_MASTER"])
        monkeypatch.setenv("FALKORDB_SENTINEL_NODES",
                           os.environ["FALKORDB_TEST_SENTINEL_NODES"])
    if m == "cluster":
        monkeypatch.setenv("FALKORDB_CLUSTER_NODES",
                           os.environ["FALKORDB_TEST_CLUSTER_NODES"])
    if os.getenv("FALKORDB_TEST_TLS", "").strip().lower() in ("1", "true", "yes"):
        monkeypatch.setenv("FALKORDB_TLS_ENABLED", "1")
        if os.getenv("FALKORDB_TEST_TLS_CA"):
            monkeypatch.setenv("FALKORDB_TLS_CA_CERTS", os.environ["FALKORDB_TEST_TLS_CA"])
        monkeypatch.setenv("FALKORDB_TLS_CERT_REQS",
                           os.getenv("FALKORDB_TEST_TLS_VERIFY", "none"))
        monkeypatch.setenv("FALKORDB_TLS_CHECK_HOSTNAME", "0")
    if os.getenv("FALKORDB_TEST_ADDRESS_REMAP"):
        monkeypatch.setenv("FALKORDB_ADDRESS_REMAP",
                           os.environ["FALKORDB_TEST_ADDRESS_REMAP"])

    from backend.app.services.system_status.probes import probe_falkordb

    result = await probe_falkordb()
    assert result["status"] == "healthy", result
    if m in ("sentinel", "cluster"):
        assert result["detail"]["mode"] == m


@skip_if_unconfigured
@pytest.mark.asyncio
async def test_auth_flip_unlearns():
    """LIVE un-learn drill (standalone only; opt-in via
    FALKORDB_TEST_ALLOW_CONFIG_SET=1 — it mutates the server's requirepass):

    1. connect against a no-auth server, then land in the learned-unauthenticated
       state (some server builds hard-reject AUTH-with-no-password and the
       self-heal strips the credentials itself; redis-py silently tolerates
       others — so the drill forces the state explicitly to be deterministic);
    2. CONFIG SET requirepass mid-session → the next connect gets NOAUTH on the
       stripped connection, un-learns, restores the row credentials, and
       reconnects — instead of dead-ending in ProviderConfigurationError.
    """
    if _mode() != "standalone":
        pytest.skip("auth flip drill is standalone-only")
    if os.getenv("FALKORDB_TEST_ALLOW_CONFIG_SET", "") != "1":
        pytest.skip("set FALKORDB_TEST_ALLOW_CONFIG_SET=1 to run (mutates requirepass)")
    if os.getenv("FALKORDB_TEST_PASSWORD"):
        pytest.skip("start the server WITHOUT auth for this drill")
    pytest.importorskip("falkordb")
    from redis.asyncio import Redis
    from backend.app.providers import falkordb_connection as fc
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    host = os.getenv("FALKORDB_TEST_HOST", "127.0.0.1")
    port = int(os.getenv("FALKORDB_TEST_PORT", "6379"))
    password = "flip-secret"
    admin = Redis(host=host, port=port, decode_responses=True)

    p = FalkorDBProvider(
        host=host, port=port, graph_name=f"topo_flip_{uuid.uuid4().hex[:8]}",
        password=password, credentials={"password": password},
        connection_config=_connection_config(),
    )
    try:
        # Phase 1: server has NO auth; connect, then force the learned-unauth
        # state (deterministic stand-in for the self-heal, whose triggering
        # depends on the server build's AUTH-with-no-password reply).
        await p._ensure_connected()
        fc.mark_instance_unauthenticated(p._conn_cfg)
        p._username = None
        p._password = None

        # Phase 2: auth is ENABLED on the live server.
        await admin.config_set("requirepass", password)
        try:
            await p.close()
            p._graph = None
            p._connect_cooldown_until = 0.0
            # Must un-learn, restore the row credential, and reconnect.
            await p._ensure_connected()
            assert p._password == password
        finally:
            authed = Redis(host=host, port=port, password=password,
                           decode_responses=True)
            await authed.config_set("requirepass", "")
            await authed.aclose()
    finally:
        await admin.aclose()
        try:
            await p.close()
        except Exception:
            pass
