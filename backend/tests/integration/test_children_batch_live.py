"""LIVE FalkorDB: ``get_children_batch`` answers each parent as ``get_children_with_edges`` does.

The batch reads every parent's page in one ``UNWIND $parents`` statement per
parent label, with each page ordered and cut inside it, and reads the pages'
lineage once for the whole batch. A parent's page must still be EXACTLY the page
it reads alone, or a client paging on from the batch's ``nextOffset`` /
``nextCursor`` skips or repeats rows. Pinned against the real engine:

  * the same children, in the same order, the same containment edges, the same
    ``hasMore`` / ``nextOffset`` / ``nextCursor`` / ``totalChildren`` — at the top,
    at an offset, after a cursor, in both directions, with names shared across a
    page boundary;
  * the same lineage, in both scopes — siblings never reaching a cousin, and an
    edge between two parents of the batch given to neither;
  * an unknown parent and an empty one: an empty page, no error.

Run:  GRAPHVER_E2E=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      pytest backend/tests/integration/test_children_batch_live.py
"""
import asyncio
import os

import pytest

from backend.common.models.graph import ChildrenBatchParent, GraphEdge, GraphNode


def _falkordb_available() -> bool:
    try:
        import redis
        c = redis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                        port=int(os.getenv("FALKORDB_PORT", "6379")), socket_connect_timeout=2)
        return c.ping() is True
    except Exception:
        return False


P, Q, E = "urn:batch:parent:P", "urn:batch:parent:Q", "urn:batch:parent:E"
N_P, N_Q, PAGE = 230, 7, 100


def kid(tag: str, i: int) -> str:
    return f"urn:batch:child:{tag}{i:03d}"


def _seed():
    nodes = [GraphNode(urn=u, entityType="container", displayName=u.rsplit(":", 1)[1], properties={}) for u in (P, Q, E)]
    edges = []
    for i in range(N_P):
        # 20 share one name, straddling the first page boundary.
        name = "Same Name" if 90 <= i < 110 else f"Child {i:03d}"
        nodes.append(GraphNode(urn=kid("p", i), entityType="dataset", displayName=name, properties={}))
        edges.append(GraphEdge(id=f"c-p{i}", sourceUrn=P, targetUrn=kid("p", i), edgeType="CONTAINS"))
    for i in range(N_Q):
        nodes.append(GraphNode(urn=kid("q", i), entityType="dataset", displayName=f"Q child {i}", properties={}))
        edges.append(GraphEdge(id=f"c-q{i}", sourceUrn=Q, targetUrn=kid("q", i), edgeType="CONTAINS"))
    # A grandchild, so a child's own count is read too.
    nodes.append(GraphNode(urn="urn:batch:col:1", entityType="column", displayName="id", properties={}))
    edges.append(GraphEdge(id="c-col", sourceUrn=kid("q", 1), targetUrn="urn:batch:col:1", edgeType="CONTAINS"))

    def lin(a: str, b: str, eid: str):
        edges.append(GraphEdge(id=eid, sourceUrn=a, targetUrn=b, edgeType="TRANSFORMS"))

    for i in range(0, 120, 3):                     # P's siblings, across pages, both ways
        (lin(kid("p", i), kid("p", i + 105), f"x{i}") if i % 2 == 0 else lin(kid("p", i + 105), kid("p", i), f"x{i}"))
    lin(kid("p", 2), kid("p", 3), "w")             # within a page
    lin(P, kid("p", 4), "pp")                     # the parent
    for i in range(N_Q - 1):
        lin(kid("q", i), kid("q", i + 1), f"q{i}")
    lin(kid("p", 5), kid("q", 2), "cousin")       # between two parents of the batch
    lin(kid("q", 3), Q, "qq")
    return nodes, edges


def _same(batch, single, where: str):
    assert [c.urn for c in batch.children] == [c.urn for c in single.children], where
    assert [c.child_count for c in batch.children] == [c.child_count for c in single.children], where
    assert [(e.source_urn, e.target_urn) for e in batch.containment_edges] == \
        [(e.source_urn, e.target_urn) for e in single.containment_edges], where
    assert sorted(e.id for e in batch.lineage_edges) == sorted(e.id for e in single.lineage_edges), where
    for field in ("has_more", "next_offset", "next_cursor", "total_children", "degraded_detail"):
        assert getattr(batch, field) == getattr(single, field), f"{where}: {field}"


async def _run() -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"nxbatch_{os.getpid()}_{os.urandom(3).hex()}",
        auth_enabled=False,
    )
    provider.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    nodes, edges = _seed()
    try:
        assert await provider.save_custom_graph(nodes, edges)
        await provider.ensure_indices(["dataset", "container", "column"])
        common = dict(edge_types=["CONTAINS"], lineage_edge_types=["TRANSFORMS"], limit=PAGE, include_lineage_edges=True)

        for scope in ("siblings", "page"):
            for direction in ("asc", "desc"):
                kw = {**common, "sort_direction": direction, "lineage_scope": scope}
                one = lambda urn, **at: provider.get_children_with_edges(urn, **at, **kw)  # noqa: E731
                first_p = await one(P)
                asks = [
                    ChildrenBatchParent(urn=P), ChildrenBatchParent(urn=Q), ChildrenBatchParent(urn=E),
                    ChildrenBatchParent(urn="urn:batch:parent:nowhere"),
                ]
                got = await provider.get_children_batch(asks, **kw)
                _same(got[P], first_p, f"P top {scope} {direction}")
                _same(got[Q], await one(Q), f"Q {scope} {direction}")
                for empty in (E, "urn:batch:parent:nowhere"):
                    assert got[empty].children == [] and not got[empty].has_more
                # The edge between P's page and Q's belongs to neither.
                assert "cousin" not in {e.id for r in got.values() for e in r.lineage_edges}

                # On from where the first page ended — by offset and by cursor.
                at_offset = await provider.get_children_batch(
                    [ChildrenBatchParent(urn=P, offset=first_p.next_offset), ChildrenBatchParent(urn=Q, offset=3)], **kw)
                _same(at_offset[P], await one(P, offset=first_p.next_offset), f"P offset {scope} {direction}")
                _same(at_offset[Q], await one(Q, offset=3), f"Q offset {scope} {direction}")
                after = await provider.get_children_batch(
                    [ChildrenBatchParent(urn=P, cursor=first_p.next_cursor), ChildrenBatchParent(urn=Q)], **kw)
                _same(after[P], await one(P, cursor=first_p.next_cursor), f"P cursor {scope} {direction}")

        # Paged by the batch's own positions, every child of P lands exactly once.
        seen, offset = [], 0
        while True:
            r = (await provider.get_children_batch([ChildrenBatchParent(urn=P, offset=offset)], **common))[P]
            seen += [c.urn for c in r.children]
            offset = r.next_offset
            if not r.has_more:
                break
        assert sorted(seen) == sorted(kid("p", i) for i in range(N_P)) and len(seen) == N_P
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
def test_children_batch_live():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("live FalkorDB children batch parity: OK")
