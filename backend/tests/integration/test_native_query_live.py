"""Native read-only queries against a live FalkorDB.

What only a real engine can show: node cells carry their urn; a write is
refused by the guard AND by the engine when the guard is bypassed, with the
graph unchanged; the server's timeout, the row cap and the reply byte cap
fire, and a connection the cap cut works again after; and "Edit and run"
starts from a query that runs — the compiled search, its values written in,
passes the guard and finds what the search finds.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_native_query_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from backend.app.services.native_query.cypher_text import inline_params
from backend.app.services.native_query.guard import FALKORDB, check
from backend.app.services.native_query.limit import cap_rows
from backend.common.interfaces.native_query import (
    NativeQueryRefused,
    NativeQueryTimeout,
    NativeQueryTooLarge,
    NativeQueryWriteRefused,
)
from backend.common.models.search import SearchQuery

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live native query test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

NODES = 300
MIB = 1024 * 1024


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"native_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    await p._graph.query("CREATE INDEX FOR (n:Dataset) ON (n.urn)")
    await p._graph.query(
        "UNWIND range(1, $n) AS i CREATE (:Dataset {urn: 'urn:ds:' + toString(i), "
        "displayName: 'dataset ' + toString(i), entityType: 'Dataset', rows: i, "
        "blob: reduce(s = '', x IN range(1, 40) | s + 'abcdefghij')})", {"n": NODES})
    await p._graph.query(
        "MATCH (a:Dataset), (b:Dataset) WHERE b.rows = a.rows + 1 "
        "CREATE (a)-[:TRANSFORMS {properties: '{\"logic\": \"direct\"}'}]->(b)")
    try:
        yield p
    finally:
        await p._graph.delete()
        await p.close()


async def native(provider, query, *, limit=50, timeout_ms=5000, max_reply_bytes=16 * MIB):
    """As the service runs it: guard, row cap, the engine."""
    capped = cap_rows(query, check(query, engine=FALKORDB), limit=limit, engine=FALKORDB)
    return await provider.run_readonly_cypher(
        capped.text, row_cap=limit + 1, timeout_ms=timeout_ms, max_reply_bytes=max_reply_bytes)


async def count(provider):
    return (await provider._graph.ro_query("MATCH (n) RETURN count(n)")).result_set[0][0]


async def test_node_cells_carry_their_urn(provider):
    result = await native(provider, "MATCH (n:Dataset) RETURN n ORDER BY n.rows", limit=3)
    assert result.columns == ["n"]
    first = result.rows[0][0]
    assert (first["kind"], first["urn"], first["displayName"]) == ("node", "urn:ds:1", "dataset 1")
    assert first["labels"] == ["Dataset"]


async def test_edges_and_paths_come_back_whole(provider):
    result = await native(provider, "MATCH p = (a:Dataset {rows: 1})-[r]->(b) RETURN r, p")
    edge, path = result.rows[0]
    assert edge["kind"] == "edge" and edge["type"] == "TRANSFORMS"
    assert edge["properties"]["properties"] == {"kind": "map", "entries": {"logic": "direct"}}
    assert [n["urn"] for n in path["nodes"]] == ["urn:ds:1", "urn:ds:2"]


async def test_the_row_cap_holds(provider):
    result = await native(provider, "MATCH (n:Dataset) RETURN n.urn LIMIT 100000", limit=20)
    assert len(result.rows) == 21                         # the extra row says "cut"


async def test_a_write_is_refused_by_the_guard_and_by_the_engine(provider):
    before = await count(provider)
    with pytest.raises(NativeQueryRefused):
        await native(provider, "MATCH (n) DETACH DELETE n")
    with pytest.raises(NativeQueryWriteRefused):
        await provider.run_readonly_cypher(
            "CREATE (:Intruder) RETURN 1", row_cap=2, timeout_ms=2000, max_reply_bytes=MIB)
    assert await count(provider) == before


async def test_files_and_urls_are_refused(provider):
    with pytest.raises(NativeQueryRefused):
        await native(provider, "LOAD CSV FROM 'file:///etc/passwd' AS line RETURN line")


async def test_a_slow_query_times_out(provider):
    with pytest.raises(NativeQueryTimeout):
        await native(
            provider,
            "MATCH (a:Dataset), (b:Dataset), (c:Dataset) "
            "WHERE a.blob CONTAINS 'zzz' OR b.rows + c.rows < 0 RETURN count(*) AS n",
            timeout_ms=500,
        )


async def test_the_reply_cap_cuts_a_huge_answer_and_the_connection_recovers(provider):
    # Every node, in one cell: ~150 KB here, against a 64 KiB cap.
    cap = 64 * 1024
    with pytest.raises(NativeQueryTooLarge):
        await native(provider, "MATCH (n:Dataset) RETURN collect(n) AS everything",
                     max_reply_bytes=cap)
    again = await native(provider, "MATCH (n:Dataset) RETURN count(n) AS n", max_reply_bytes=cap)
    assert again.rows == [[NODES]]


async def test_the_compiled_search_runs_as_written_and_finds_the_same(provider):
    from backend.app.providers.falkordb_deep_search import explain_deep_search

    query = SearchQuery.model_validate({
        "predicate": {"kind": "group", "op": "and", "children": [
            {"kind": "entityType", "op": "in", "values": ["Dataset"]},
            {"kind": "property", "key": "rows", "op": "gt", "value": 290},
        ]},
        "scope": {"viewId": "v", "scopeMode": "data_source"},
        "options": {"results": "hits", "pageSize": 100},
    })
    explained = explain_deep_search(provider, query)
    written = inline_params(explained.get("hits_cypher") or explained["cypher"],
                            explained.get("params") or {})
    assert written is not None
    result = await native(provider, written, limit=100)
    # It returns the search's own columns: n.urn first.
    urn = [c.replace("`", "") for c in result.columns].index("n.urn")
    found = {row[urn] for row in result.rows}
    page = await provider.deep_search(query)
    assert found == {hit.node.urn for hit in page.hits} == {
        f"urn:ds:{i}" for i in range(291, NODES + 1)
    }, (result.columns, written)
