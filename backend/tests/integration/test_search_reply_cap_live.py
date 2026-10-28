"""LIVE FalkorDB: a unit holding more rows than one reply is still read whole.

FalkorDB cuts a reply at ``RESULTSET_SIZE`` rows — 10,000 on the stock image
CI runs — and says nothing. A statement over a unit with more lost the rest:
an export dropped rows, a search on a property kept raw (``propertiesRaw``)
missed matches, and containers lost their "N matches inside" badges. Here
12,000 datasets, each in a container of its own, sit in one unit, and every
one of them must come back.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_reply_cap_live.py -q
"""
from __future__ import annotations

import json
import os
import uuid

import pytest
import pytest_asyncio

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

#: The stock image's reply cap.
CAP = 10_000
#: Datasets — and containers, one each — past it.
N = 12_000


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def capped():
    """The stock cap, set for this module on a FalkorDB that runs without it."""
    import redis.asyncio as aioredis

    r = aioredis.Redis(host=os.getenv("FALKORDB_HOST", "localhost"),
                       port=int(os.getenv("FALKORDB_PORT", "6379")))
    _, before = await r.execute_command("GRAPH.CONFIG", "GET", "RESULTSET_SIZE")
    before = int(before)
    if before < 0 or before > CAP:
        await r.execute_command("GRAPH.CONFIG", "SET", "RESULTSET_SIZE", CAP)
    try:
        yield
    finally:
        if before < 0 or before > CAP:
            await r.execute_command("GRAPH.CONFIG", "SET", "RESULTSET_SIZE", before)
        await r.aclose()


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider(capped):
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"replycap_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    for label in ("Domain", "Container", "Dataset"):
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await p._graph.query("CREATE (:Domain {urn: 'urn:root', displayName: 'root'})")
    raw = json.dumps({"owner": "finance"})
    for start in range(0, N, 3_000):
        rows = [{"c": f"urn:container:{i}", "d": f"urn:dataset:{i}"}
                for i in range(start, min(N, start + 3_000))]
        await p._graph.query(
            "UNWIND $rows AS r MATCH (root:Domain {urn: 'urn:root'}) "
            "CREATE (root)-[:CONTAINS]->(:Container {urn: r.c, displayName: r.c})"
            "-[:CONTAINS]->(:Dataset {urn: r.d, displayName: r.d, propertiesRaw: $raw})",
            {"rows": rows, "raw": raw})
    try:
        yield p
    finally:
        await p._graph.delete()


def _query(predicate, **options):
    from backend.common.models.search import SearchQuery

    return SearchQuery.model_validate({
        "predicate": predicate,
        "scope": {"viewId": "v", "scopeMode": "data_source", "entityTypes": ["Dataset"]},
        "options": {"results": "hits", "pageSize": 10, "waitMs": 0, **options}})


async def _finish(provider, query, tag):
    """Follow a search a request at a time to the end."""
    from backend.app.providers.falkordb_search.engine import execute_session_search
    from backend.app.services.deep_search import SearchRunContext

    context = SearchRunContext(data_version=tag, scope_hash=tag)
    session, page = None, None
    for _ in range(400):
        q = query.model_copy(update={"options": query.options.model_copy(
            update={"session_id": session})})
        page = await execute_session_search(provider, q, context=context)
        session = page.session_id
        if page.status == "complete":
            return page
    raise AssertionError("the search never finished")


async def test_an_export_holds_every_row_of_a_unit_past_one_reply(provider, tmp_path):
    from backend.app.providers.falkordb_search.export import execute_export_session, open_export
    from backend.app.services.deep_search import SearchRunContext
    from backend.app.services.storage.object_store import LocalFsObjectStore

    objects = LocalFsObjectStore(tmp_path)
    query = _query({"kind": "all"})
    context = SearchRunContext(data_version="export", scope_hash="export")
    sid, out = None, None
    for _ in range(400):
        out = await execute_export_session(provider, query, context=context, fmt="ndjson",
                                           columns=[], wait_ms=0, session_id=sid,
                                           objects=objects)
        sid = out["sessionId"]
        if out["status"] == "complete":
            break
    assert out["status"] == "complete"
    answer, body = await open_export(provider, sid, scope_hash="export", objects=objects)
    text = b"".join([chunk async for chunk in body]).decode("utf-8")
    urns = [json.loads(line)["urn"] for line in text.splitlines()]
    assert answer["rows"] == N
    assert sorted(urns) == sorted(f"urn:dataset:{i}" for i in range(N))


async def test_a_raw_value_is_searched_on_every_node_past_one_reply(provider):
    page = await _finish(provider, _query({"kind": "property", "key": "owner",
                                           "op": "eq", "value": "finance"}), "raw")
    assert page.total_count == N


async def test_every_container_past_one_reply_is_tallied(provider):
    from backend.app.providers.falkordb_search.engine import read_ancestor_counts

    page = await _finish(provider, _query({"kind": "all"}, results="both",
                                          aggregations=[{"by": "ancestor", "maxBuckets": 10}]),
                         "tally")
    containers = [f"urn:container:{i}" for i in range(N)]
    read = await read_ancestor_counts(provider, page.session_id, containers + ["urn:root"],
                                      scope_hash="tally")
    assert read["status"] == "complete"
    counts = {u: c["count"] for u, c in read["counts"].items()}
    root = counts.pop("urn:root")
    assert root == N
    assert set(counts.values()) == {1}
