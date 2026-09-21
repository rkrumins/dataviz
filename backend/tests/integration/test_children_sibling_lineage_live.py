"""LIVE FalkorDB: sibling-scoped lineage on paged children — needs a real FalkorDB.

`get_children_with_edges` returns lineage among {parent} ∪ THIS PAGE only, so an
edge between a page-1 child and a page-3 child never arrives with either page.
The canvas used to paper over that by re-sending every already-loaded sibling to
`/edges/between` on every page — O(loaded) per page, quadratic per parent.

`lineage_scope="siblings"` widens the far end to every child of the same parent
(and the parent), loaded or not. A client that keeps only edges whose far end it
already holds therefore ends up with EXACTLY the sibling lineage once the last
page lands: an edge to a not-yet-loaded sibling comes back again with that
sibling's own page. Cost stays proportional to the page, not to what is loaded.

Pinned here, against the real engine:
  * after paging every child, the kept edges == all lineage among {P} ∪ kids(P);
  * edges to a COUSIN (a child of another parent) never appear — siblings only;
  * the default scope is unchanged: page-only, cross-page edges absent.

Run:  GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \
      pytest backend/tests/integration/test_children_sibling_lineage_live.py
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


P, Q = "urn:sibtest:parent:P", "urn:sibtest:parent:Q"
N_P, N_Q, PAGE = 250, 30, 100


def kid(parent_tag: str, i: int) -> str:
    return f"urn:sibtest:child:{parent_tag}{i:03d}"


def _seed():
    nodes = [
        GraphNode(urn=P, entityType="container", displayName="P", properties={}),
        GraphNode(urn=Q, entityType="container", displayName="Q", properties={}),
    ]
    edges = []
    for i in range(N_P):
        # 20 share one name so page boundaries fall inside a duplicate run.
        name = "Same Name" if i < 20 else f"Child {i:03d}"
        nodes.append(GraphNode(urn=kid("p", i), entityType="dataset", displayName=name, properties={}))
        edges.append(GraphEdge(id=f"c-p{i}", sourceUrn=P, targetUrn=kid("p", i), edgeType="CONTAINS"))
    for i in range(N_Q):
        nodes.append(GraphNode(urn=kid("q", i), entityType="dataset", displayName=f"Cousin {i:03d}", properties={}))
        edges.append(GraphEdge(id=f"c-q{i}", sourceUrn=Q, targetUrn=kid("q", i), edgeType="CONTAINS"))

    sibling_lineage = set()

    def lin(a: str, b: str, eid: str):
        edges.append(GraphEdge(id=eid, sourceUrn=a, targetUrn=b, edgeType="TRANSFORMS"))

    for i in range(0, 130):                       # crosses page boundaries, both directions
        a, b = kid("p", i), kid("p", i + 120)
        (lin(a, b, f"x{i}") if i % 2 == 0 else lin(b, a, f"x{i}"))
        sibling_lineage.add((a, b) if i % 2 == 0 else (b, a))
    for i in range(0, 60, 3):                     # within a page
        lin(kid("p", i), kid("p", i + 1), f"w{i}")
        sibling_lineage.add((kid("p", i), kid("p", i + 1)))
    lin(P, kid("p", 200), "pp")                  # parent <-> child lineage is in scope
    sibling_lineage.add((P, kid("p", 200)))
    cousin_lineage = set()
    for i in range(0, 30, 5):                     # cousins: must NEVER be returned
        lin(kid("p", i * 7), kid("q", i), f"k{i}")
        cousin_lineage.add((kid("p", i * 7), kid("q", i)))
    return nodes, edges, sibling_lineage, cousin_lineage


async def _page_all(provider, scope):
    loaded = {P}
    kept, seen_any = set(), set()
    cursor, offset, pages = None, 0, 0
    while True:
        kw = {} if scope is None else {"lineage_scope": scope}
        r = await provider.get_children_with_edges(
            P, edge_types=["CONTAINS"], lineage_edge_types=["TRANSFORMS"],
            limit=PAGE, offset=offset, cursor=cursor, include_lineage_edges=True, **kw,
        )
        for c in r.children:
            loaded.add(c.urn)
        for e in r.lineage_edges:
            pair = (e.source_urn, e.target_urn)
            seen_any.add(pair)
            if e.source_urn in loaded and e.target_urn in loaded:   # the client's rule
                kept.add(pair)
        offset += len(r.children)
        pages += 1
        assert pages <= 10, "runaway pagination"
        if not r.has_more or not r.next_cursor:
            break
        cursor = r.next_cursor
    return loaded, kept, seen_any


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"nxsib_{os.getpid()}_{os.urandom(3).hex()}",
        auth_enabled=False,
    )
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    nodes, edges, sibling_lineage, cousin_lineage = _seed()
    try:
        assert await provider.save_custom_graph(nodes, edges)
        await provider.ensure_indices(["dataset", "container"])

        loaded, kept, seen = await _page_all(provider, "siblings")
        assert len(loaded) == N_P + 1, "every child must load exactly once"
        assert kept == sibling_lineage, (
            f"sibling lineage incomplete: missing {len(sibling_lineage - kept)}, "
            f"unexpected {len(kept - sibling_lineage)}"
        )
        assert not (seen & cousin_lineage), "cousin edges leaked into sibling scope"

        # Default scope unchanged: page-only, so cross-page edges never arrive.
        _, kept_default, _ = await _page_all(provider, None)
        assert kept_default < sibling_lineage, "default scope must stay page-only"
        cross_page = {(a, b) for (a, b) in sibling_lineage if a != P and b != P}
        assert not cross_page <= kept_default, "default scope unexpectedly widened"
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
def test_children_sibling_lineage_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("live FalkorDB sibling-scoped children lineage: OK")
