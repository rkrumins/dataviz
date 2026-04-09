"""
Integration tests for FalkorDB provider.
Requires a running FalkorDB instance. Skip if unavailable.
"""

import os
import pytest
import pytest_asyncio

from backend.app.models.graph import (
    GraphNode,
    GraphEdge,
    NodeQuery,
    EdgeQuery,
)


def _falkordb_available() -> bool:
    """Check if FalkorDB package is installed and FalkorDB/Redis is reachable."""
    try:
        import falkordb  # noqa: F401
        import redis
        r = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"), port=int(os.getenv("FALKORDB_PORT", "6379")))
        r.ping()
        r.close()
        return True
    except Exception:
        return False


skip_if_no_falkordb = pytest.mark.skipif(
    not _falkordb_available(),
    reason="FalkorDB not available (start with: docker run -p 6379:6379 falkordb/falkordb)",
)


@pytest_asyncio.fixture
async def falkordb_provider():
    """Create FalkorDB provider with a test graph (isolated by graph name)."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    graph_name = f"test_nexus_{os.getpid()}"
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
    )
    await provider._ensure_connected()
    # Seed with minimal data
    nodes = [
        GraphNode(urn="urn:li:domain:test", entityType="domain", displayName="Test Domain"),
        GraphNode(urn="urn:li:dataset:test.ds1", entityType="dataset", displayName="Dataset 1"),
        GraphNode(urn="urn:li:dataset:test.ds2", entityType="dataset", displayName="Dataset 2"),
    ]
    edges = [
        GraphEdge(id="e1", sourceUrn="urn:li:domain:test", targetUrn="urn:li:dataset:test.ds1", edgeType="CONTAINS"),
        GraphEdge(id="e2", sourceUrn="urn:li:dataset:test.ds1", targetUrn="urn:li:dataset:test.ds2", edgeType="PRODUCES"),
    ]
    await provider.save_custom_graph(nodes, edges)
    yield provider
    # Cleanup: delete test graph
    try:
        await provider._graph.delete()
    except Exception:
        pass


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_node(falkordb_provider):
    node = await falkordb_provider.get_node("urn:li:domain:test")
    assert node is not None
    assert node.urn == "urn:li:domain:test"
    assert node.display_name == "Test Domain"
    assert node.entity_type == "domain"


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_nodes(falkordb_provider):
    nodes = await falkordb_provider.get_nodes(NodeQuery(entity_types=["dataset"]))
    assert len(nodes) >= 2
    assert all(n.entity_type == "dataset" for n in nodes)


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_edges(falkordb_provider):
    edges = await falkordb_provider.get_edges(EdgeQuery(edge_types=["CONTAINS"]))
    assert len(edges) >= 1
    assert any(e.edge_type == "CONTAINS" for e in edges)


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_children(falkordb_provider):
    children = await falkordb_provider.get_children("urn:li:domain:test")
    assert len(children) >= 1
    assert any(c.urn == "urn:li:dataset:test.ds1" for c in children)


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_parent(falkordb_provider):
    parent = await falkordb_provider.get_parent("urn:li:dataset:test.ds1")
    assert parent is not None
    assert parent.urn == "urn:li:domain:test"


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_stats(falkordb_provider):
    stats = await falkordb_provider.get_stats()
    assert stats["nodeCount"] >= 3
    assert stats["edgeCount"] >= 2


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_falkordb_get_schema_stats(falkordb_provider):
    stats = await falkordb_provider.get_schema_stats()
    assert stats.totalNodes >= 3
    assert stats.totalEdges >= 2
    assert len(stats.entityTypeStats) > 0
    assert len(stats.edgeTypeStats) > 0
