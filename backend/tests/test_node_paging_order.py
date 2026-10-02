"""Shape of FalkorDB's paged reads, as a lossless pager (no infra).

A client pages a type (open views) or a container (the canvas, the wizard) by
POSITION, taking the next position from the server. That is lossless only if:

  * the order is TOTAL — (displayName, urn, internal id) — so a page is a
    well-defined slice even when names, or names AND urns, repeat; a tie lets rows
    split differently between two queries, and one is skipped for good;
  * a children page reports where the next page starts (`nextOffset`) as the
    rows it CONSUMED in that order — not rows a caller happens to keep.

The live engine's agreement is pinned in
integration/test_nodes_type_paging_live.py.
"""
import asyncio

from backend.common.models.graph import NodeQuery
from backend.app.providers.falkordb_provider import FalkorDBProvider


class _FakeResult:
    def __init__(self, rows=None):
        self.result_set = rows or []


def _provider(rows=None):
    p = FalkorDBProvider(host="x", graph_name="paging-shapes")

    async def _noop():
        return None

    async def _no_label(_urn):
        return None

    p._ensure_connected = _noop
    p._get_cached_label = _no_label
    p.recorded = []

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.recorded.append((cypher, params or {}))
        return _FakeResult(rows if op == "children.page" else None)

    p._ro_query = _ro
    p._proj_ro_query = _ro
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    return p


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_a_type_page_orders_totally():
    p = _provider()
    _run(p.get_nodes(NodeQuery(entityTypes=["domain", "system"], limit=200, offset=400)))
    cypher, params = p.recorded[-1]
    assert "ORDER BY n.displayName, n.urn, id(n) SKIP $skip" in cypher
    assert params["skip"] == 400


def test_a_children_page_orders_totally_and_says_where_the_next_starts():
    rows = [[{"urn": f"urn:c:{i}", "entityType": "system", "displayName": f"c{i}"}, 0, "urn:p", "CONTAINS", {}]
            for i in range(3)]
    p = _provider(rows)
    p._extract_node_from_result = lambda n: __import__(
        "backend.common.models.graph", fromlist=["GraphNode"]).GraphNode(**n)
    res = _run(p.get_children_with_edges("urn:p", edge_types=["CONTAINS"], offset=200, limit=100,
                                         include_lineage_edges=False))
    cypher, params = next(r for r in p.recorded if "SKIP $skip" in r[0])
    assert "ORDER BY c.displayName, c.urn, id(c)" in cypher
    assert params["skip"] == 200
    assert res.next_offset == 203


def test_a_page_whose_lineage_failed_says_so_and_is_not_cached_as_complete():
    # The children are right; their lineage is short. Unmarked, the response
    # cache served that page to everyone for an hour as if it were complete.
    from backend.app.services.graph_cache import _is_incomplete_result

    # Two children: page-scope lineage only runs for a page with a pair in it.
    rows = [[{"urn": f"urn:c:{i}", "entityType": "system", "displayName": f"c{i}"}, 0, "urn:p", "CONTAINS", {}]
            for i in range(2)]
    p = _provider(rows)
    p._extract_node_from_result = lambda n: __import__(
        "backend.common.models.graph", fromlist=["GraphNode"]).GraphNode(**n)
    answer = p._ro_query

    async def _ro(cypher, params=None, timeout=None, op=None):
        if op and op.startswith("children.lineage"):
            raise TimeoutError("lineage timed out")
        return await answer(cypher, params=params, timeout=timeout, op=op)

    p._ro_query = _ro
    for scope in ("page", "siblings"):
        res = _run(p.get_children_with_edges("urn:p", edge_types=["CONTAINS"], lineage_edge_types=["FLOWS_TO"],
                                             limit=100, lineage_scope=scope))
        assert [c.urn for c in res.children] == ["urn:c:0", "urn:c:1"]
        assert res.degraded_detail and "lineage" in res.degraded_detail
        assert _is_incomplete_result(res)
