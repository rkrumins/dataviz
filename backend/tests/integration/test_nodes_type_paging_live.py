"""LIVE FalkorDB: paging by POSITION is lossless over tied and missing names — needs a real FalkorDB.

Clients page a whole type (open views) and a container (canvas, wizard) by
position, taking the next one from the server. Pinned against the real engine,
with the three shapes that lose rows when the order or the position is not total:

  * a 40-row run of one display name straddling several page boundaries;
  * entities with NO stored `displayName` — their name lives under `name`, which
    the reader serves as the display name — so a position minted from the served
    name and compared to the stored one matches nothing;
  * entities that DUPLICATE another's urn (and name) — bad source data, but a
    tie on (displayName, urn) must not let the two split differently between
    pages and drop one.

Every stored row must come back exactly once, for `get_nodes_page` over two
labels and for `get_children_with_edges` under one parent, and the last page
must say so.

Run:  GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      pytest backend/tests/integration/test_nodes_type_paging_live.py
"""
import asyncio
import os

import pytest

from backend.common.models.graph import GraphEdge, GraphNode, NodeQuery


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


PAGE = 25
PARENT = "urn:pg:parent"
NAMELESS = 30
DUPLICATES = 12   # extra nodes re-using the urn AND name of a "Same Name" node


def _seed():
    nodes = [GraphNode(urn=PARENT, entityType="container", displayName="Parent", properties={})]
    edges = []
    for i in range(40):
        nodes.append(GraphNode(urn=f"urn:pg:a:{i:03d}", entityType="alpha", displayName="Same Name", properties={}))
    for i in range(60):
        nodes.append(GraphNode(urn=f"urn:pg:a:x{i:03d}", entityType="alpha", displayName=f"Alpha {i:03d}", properties={}))
    for i in range(50):
        nodes.append(GraphNode(urn=f"urn:pg:b:{i:03d}", entityType="beta",
                               displayName="Same Name" if i % 2 else f"Beta {i:03d}", properties={}))
    for n in nodes[1:]:
        edges.append(GraphEdge(id=f"c-{n.urn}", sourceUrn=PARENT, targetUrn=n.urn, edgeType="CONTAINS"))
    return nodes, edges


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"nxpg_{os.getpid()}_{os.urandom(3).hex()}",
        auth_enabled=False,
    )
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    nodes, edges = _seed()
    try:
        assert await provider.save_custom_graph(nodes, edges)
        # Named only under `name`, as an unmapped source stores them.
        await provider._graph.query(
            "MATCH (p:container {urn: $p}) "
            "UNWIND range(0, $n - 1) AS i "
            "CREATE (p)-[:CONTAINS]->(:alpha {urn: 'urn:pg:nameless:' + toString(i), "
            "entityType: 'alpha', name: 'Unnamed ' + toString(i)})",
            {"p": PARENT, "n": NAMELESS},
        )
        await provider._graph.query(
            "MATCH (p:container {urn: $p}) "
            "UNWIND range(0, $n - 1) AS i "
            "CREATE (p)-[:CONTAINS]->(:beta {urn: 'urn:pg:a:' + right('00' + toString(i), 3), "
            "entityType: 'beta', displayName: 'Same Name'})",
            {"p": PARENT, "n": DUPLICATES},
        )
        await provider.ensure_indices(["alpha", "beta", "container"])
        expected = {n.urn for n in nodes[1:]} | {f"urn:pg:nameless:{i}" for i in range(NAMELESS)}
        stored = len(nodes) - 1 + NAMELESS + DUPLICATES

        got, offset, pages = [], 0, 0
        while True:
            page = await provider.get_nodes_page(NodeQuery(entityTypes=["alpha", "beta"], limit=PAGE, offset=offset))
            got.extend(n.urn for n in page.nodes)
            assert page.next_offset == offset + len(page.nodes)
            offset = page.next_offset
            pages += 1
            assert pages <= 20, "runaway type paging"
            if not page.has_more:
                break
        assert len(got) == stored, f"type paging delivered {len(got)} of {stored} stored rows"
        assert set(got) == expected, f"type paging lost {len(expected - set(got))} urns"

        kids, offset, pages = [], 0, 0
        while True:
            r = await provider.get_children_with_edges(
                PARENT, edge_types=["CONTAINS"], limit=PAGE, offset=offset, include_lineage_edges=False)
            kids.extend(c.urn for c in r.children)
            offset = r.next_offset
            pages += 1
            assert pages <= 20, "runaway children paging"
            if not r.has_more:
                break
        assert len(kids) == stored, f"children paging delivered {len(kids)} of {stored} stored rows"
        assert set(kids) == expected, f"children paging lost {len(expected - set(kids))} urns"
    finally:
        try:
            await provider._graph.delete()
        except Exception:
            pass


@pytest.mark.integration
@pytest.mark.skipif(
    not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
    reason="set GRAPHVER_E2E=1 + a real FalkorDB (FALKORDB_HOST/PORT) to run",
)
def test_nodes_type_paging_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("live FalkorDB position paging over tied and missing names: OK")
