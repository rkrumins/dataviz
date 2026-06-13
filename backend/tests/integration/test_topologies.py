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
