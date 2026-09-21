"""LIVE FalkorDB: paging `get_nodes` by entity type is lossless — needs a real FalkorDB.

Two labels are merged through the query's UNION, with a 40-row run of one
display name straddling several page boundaries (the shape that loses rows when
the order is displayName alone). Paging by keyset `after` positions must return
every node exactly once, in (displayName, urn) order; paging by offset over the
same data must return the same sequence (the order is now total).

Run:  GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      pytest backend/tests/integration/test_nodes_type_keyset_live.py
"""
import asyncio
import os

import pytest

from backend.common.models.graph import GraphNode, NodeQuery


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


PAGE = 25


def _seed():
    nodes = []
    for i in range(40):
        nodes.append(GraphNode(urn=f"urn:ks:a:{i:03d}", entityType="alpha", displayName="Same Name", properties={}))
    for i in range(60):
        nodes.append(GraphNode(urn=f"urn:ks:a:x{i:03d}", entityType="alpha", displayName=f"Alpha {i:03d}", properties={}))
    for i in range(50):
        nodes.append(GraphNode(urn=f"urn:ks:b:{i:03d}", entityType="beta",
                               displayName="Same Name" if i % 2 else f"Beta {i:03d}", properties={}))
    return nodes


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"nxks_{os.getpid()}_{os.urandom(3).hex()}",
        auth_enabled=False,
    )
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    nodes = _seed()
    expected = sorted((n.display_name, n.urn) for n in nodes)
    try:
        assert await provider.save_custom_graph(nodes, [])
        await provider.ensure_indices(["alpha", "beta"])

        # Keyset: carry the page's MAX (displayName, urn) — row order inside a
        # page is not guaranteed once the query aggregates.
        got, after, pages = [], None, 0
        while True:
            kw = {} if after is None else {"afterDisplayName": after[0], "afterUrn": after[1]}
            page = await provider.get_nodes(NodeQuery(entityTypes=["alpha", "beta"], limit=PAGE, **kw))
            keys = [(n.display_name, n.urn) for n in page]
            got.extend(keys)
            pages += 1
            assert pages <= 20, "runaway keyset pagination"
            if len(page) < PAGE:
                break
            after = max(keys)
        assert sorted(got) == expected, f"keyset lost/duplicated rows: {len(got)} vs {len(expected)}"
        assert len(set(got)) == len(got)

        # Offset over the same data yields the same total order.
        by_offset, offset = [], 0
        while True:
            page = await provider.get_nodes(NodeQuery(entityTypes=["alpha", "beta"], limit=PAGE, offset=offset))
            by_offset.extend(sorted((n.display_name, n.urn) for n in page))
            offset += len(page)
            if len(page) < PAGE:
                break
        assert by_offset == expected, "offset pages are not a total order"
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
def test_nodes_type_keyset_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("live FalkorDB get_nodes type keyset: OK")
