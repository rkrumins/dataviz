"""Shape of `get_nodes` by entity type, as a lossless pager (no infra).

An open ('all') Context View loads each visible type a page at a time and
continues as the user scrolls. That continuation must be LOSSLESS:

  * the order is TOTAL — (displayName, urn) — so the rows of one page are a
    well-defined prefix; ordering by displayName alone lets tied names split
    differently between queries, and a sibling can be skipped for good;
  * with an `after` position the query is a KEYSET seek (no SKIP), so a row
    deleted before the reader's position cannot shift a row out of reach;
  * the seek sits INSIDE each UNION branch, where the label index applies.

The live engine's agreement is pinned in
integration/test_nodes_type_keyset_live.py.
"""
import asyncio

from backend.common.models.graph import NodeQuery
from backend.app.providers.falkordb_provider import FalkorDBProvider


class _FakeResult:
    result_set: list = []


def _provider():
    p = FalkorDBProvider(host="x", graph_name="keyset-shapes")

    async def _noop():
        return None

    p._ensure_connected = _noop
    p.recorded = []

    async def _ro(cypher, params=None, timeout=None, op=None):
        p.recorded.append((cypher, params or {}))
        return _FakeResult()

    p._ro_query = _ro
    p._proj_ro_query = _ro
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    return p


def _query(**kw):
    p = _provider()
    asyncio.new_event_loop().run_until_complete(p.get_nodes(NodeQuery(**kw)))
    assert p.recorded, "no query issued"
    return p.recorded[-1]


def test_offset_page_orders_totally():
    cypher, params = _query(entityTypes=["domain", "system"], limit=200, offset=400)
    assert "ORDER BY n.displayName, n.urn" in cypher
    assert "SKIP $skip" in cypher and params["skip"] == 400


def test_after_position_is_a_keyset_seek_inside_each_branch():
    cypher, params = _query(
        entityTypes=["domain", "system"], limit=200, offset=400,
        afterDisplayName="Same Name", afterUrn="urn:x:042",
    )
    branches = cypher.split(" UNION ")
    assert len(branches) == 2
    for b in branches:
        assert "(n.displayName > $afterName OR (n.displayName = $afterName AND n.urn > $afterUrn))" in b
    assert "ORDER BY n.displayName, n.urn" in cypher
    assert "SKIP" not in cypher, "a keyset page must not also skip"
    assert params["afterName"] == "Same Name" and params["afterUrn"] == "urn:x:042"


def test_no_after_position_keeps_the_offset_path():
    cypher, _ = _query(entityTypes=["domain"], limit=50)
    assert "$afterName" not in cypher
