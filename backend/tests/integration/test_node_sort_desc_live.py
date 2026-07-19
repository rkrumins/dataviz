"""LIVE FalkorDB validation of descending keyset pagination — needs a real
FalkorDB (no Postgres).

Every other sort/pagination test mocks the FalkorDB socket; this proves the
real engine agrees with the client-side contract end-to-end:

  * ``ORDER BY displayName DESC, urn DESC`` over a graph whose names include
    PREFIX FAMILIES ("Account" / "Accounts" / "Accounts (Analytics)") and a
    long RUN OF DUPLICATES straddling several page boundaries — the two shapes
    that historically broke keyset pagination;
  * the direction-bound ``k1:`` cursor round-trips through the real query,
    with every page strictly descending and the union of pages exactly equal
    to the seeded child set (no row lost, none repeated);
  * ascending pagination over the same graph returns the exact reverse.

Run:  docker run -d -p 6379:6379 falkordb/falkordb
      GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      pytest backend/tests/integration/test_node_sort_desc_live.py
"""
import asyncio
import os

import pytest

from backend.common.models.graph import GraphEdge, GraphNode


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


PARENT_URN = "urn:sorttest:parent"
PAGE = 25


def _seed_children() -> list[GraphNode]:
    """~120 children engineered so every page boundary risk shape occurs:
    a 40-row duplicate-name run (spans page boundaries), two prefix families,
    and a generic alphabetical tail."""
    children: list[GraphNode] = []

    def child(i: int, name: str) -> GraphNode:
        return GraphNode(
            urn=f"urn:sorttest:child:{i:03d}",
            entityType="dataset",
            displayName=name,
            properties={},
        )

    i = 0
    for _ in range(40):                       # duplicate run — urn is the only tiebreaker
        children.append(child(i, "Duplicated Name")); i += 1
    for name in ("Account", "Accounts", "Accounts (Analytics)",
                 "Sales", "Sales Ops", "Sales Report"):    # prefix families
        children.append(child(i, name)); i += 1
    for k in range(74):                       # generic tail
        children.append(child(i, f"Item {k:03d}")); i += 1
    return children


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    graph_name = f"nxsort_{os.getpid()}_{os.urandom(3).hex()}"
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
        auth_enabled=False,
    )
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)

    children = _seed_children()
    parent = GraphNode(
        urn=PARENT_URN, entityType="container", displayName="Sort Test Parent",
        properties={},
    )
    edges = [
        GraphEdge(id=f"e{n.urn}", sourceUrn=PARENT_URN, targetUrn=n.urn, edgeType="CONTAINS")
        for n in children
    ]

    try:
        assert await provider.save_custom_graph([parent, *children], edges)
        await provider.ensure_indices(["dataset", "container"])

        async def collect(direction: str) -> list[tuple[str, str]]:
            """Page through all children; assert per-page invariants."""
            seen: list[tuple[str, str]] = []
            cursor = None
            pages = 0
            while True:
                result = await provider.get_children_with_edges(
                    PARENT_URN, edge_types=["CONTAINS"], limit=PAGE,
                    include_lineage_edges=False, cursor=cursor,
                    sort_direction=direction,
                )
                page = [(c.display_name, c.urn) for c in result.children]
                # Each page is strictly ordered under the composite key.
                for a, b in zip(page, page[1:]):
                    assert (a < b) if direction == "asc" else (a > b), (direction, a, b)
                seen.extend(page)
                pages += 1
                assert pages <= 20, "runaway pagination"
                if not result.has_more or not result.next_cursor:
                    break
                cursor = result.next_cursor
            return seen

        expected_asc = sorted((c.display_name, c.urn) for c in children)

        got_asc = await collect("asc")
        assert got_asc == expected_asc, (
            f"asc pagination lost/duplicated rows: {len(got_asc)} vs {len(expected_asc)}"
        )

        got_desc = await collect("desc")
        assert got_desc == list(reversed(expected_asc)), (
            f"desc pagination lost/duplicated rows: {len(got_desc)} vs {len(expected_asc)}"
        )

        # by-layer path: same composite keyset, label-anchored union form.
        layered = [
            GraphNode(
                urn=f"urn:sorttest:layered:{k:02d}", entityType="dataset",
                displayName=f"Layered {k % 5}",   # duplicates again
                layerAssignment="layer-live-test", properties={},
            )
            for k in range(30)
        ]
        assert await provider.save_custom_graph(layered, [])
        # get_nodes_by_layer returns a bare list (no next_cursor), so real
        # callers page by offset — exercise exactly that, desc, page size 7.
        by_layer_pages: list[tuple[str, str]] = []
        offset = 0
        while True:
            rows = await provider.get_nodes_by_layer(
                "layer-live-test", limit=7, offset=offset, sort_direction="desc",
            )
            page = [(n.display_name, n.urn) for n in rows]
            for a, b in zip(page, page[1:]):
                assert a > b, (a, b)
            by_layer_pages.extend(page)
            offset += len(rows)
            if len(rows) < 7:
                break
            assert offset <= 100, "runaway by-layer pagination"
        expected_layer = sorted(
            ((n.display_name, n.urn) for n in layered), reverse=True,
        )
        assert by_layer_pages == expected_layer, "by-layer desc order/coverage mismatch"
    finally:
        try:
            await provider._graph.delete()   # scratch graph cleanup
        except Exception:
            pass


@pytest.mark.integration
@pytest.mark.skipif(
    not (os.getenv("GRAPHVER_E2E") and _falkordb_available()),
    reason="set GRAPHVER_E2E=1 + a real FalkorDB (FALKORDB_HOST/PORT) to run",
)
def test_desc_keyset_pagination_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("live FalkorDB desc keyset pagination: OK")
