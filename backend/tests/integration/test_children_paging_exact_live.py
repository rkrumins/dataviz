"""Main's children pages say "more" only when there IS more — LIVE FalkorDB.

"A full page means more" invented a child whenever a container's count was a multiple of the
page size: "Load 1 more · 1 remaining" that loaded nothing. The page now reads one row past its
limit, and the position only advances by the rows it served.
"""
import asyncio
import os

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider


async def _run() -> None:
    name = "gvt_paging_" + os.urandom(3).hex()
    p = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "falkordb"),
                         port=int(os.getenv("FALKORDB_PORT", "6379")),
                         graph_name=name, auto_reconcile=False)
    try:
        await p._ensure_connected()
        await p._query("CREATE (:domain {urn: 'P', displayName: 'P'})")
        for c in ("c1", "c2"):
            await p._query(f"MATCH (p:domain {{urn: 'P'}}) CREATE (p)-[:CONTAINS]->"
                           f"(:dataPlatform {{urn: '{c}', displayName: '{c}'}})")
        r = await p.get_children_with_edges("P", edge_types=["CONTAINS"], limit=2,
                                            include_lineage_edges=False)
        assert [c.urn for c in r.children] == ["c1", "c2"]
        assert r.has_more is False, "exactly a page of children is not 'more'"

        await p._query("MATCH (p:domain {urn: 'P'}) CREATE (p)-[:CONTAINS]->"
                       "(:dataPlatform {urn: 'c3', displayName: 'c3'})")
        r = await p.get_children_with_edges("P", edge_types=["CONTAINS"], limit=2,
                                            include_lineage_edges=False)
        assert [c.urn for c in r.children] == ["c1", "c2"] and r.has_more is True
        assert r.next_offset == 2, "the probe row is served by the next page, not skipped"
        r2 = await p.get_children_with_edges("P", edge_types=["CONTAINS"], limit=2, offset=2,
                                             include_lineage_edges=False)
        assert [c.urn for c in r2.children] == ["c3"] and r2.has_more is False
    finally:
        try:
            await p._query("MATCH (n) DETACH DELETE n")
            await p._graph.delete()
        except Exception:
            pass
        await p.close()


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs a live FalkorDB (set GRAPHVER_E2E=1)")
def test_children_pages_say_more_only_when_there_is_more():
    asyncio.run(_run())
