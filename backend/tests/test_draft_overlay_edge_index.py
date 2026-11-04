"""A draft's edges are found by their ends, never by walking every edge it changed.

``get_edges`` scanned all of a draft's edges on every call: for a draft an import added 100k edges
to, every ``/edges/between`` of one node walked all 100k on the event loop. The patch set now
indexes its edges by the urn of either end once, and a read naming its ends walks only theirs.
"""
import asyncio

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.common.models.graph import EdgeQuery
from backend.tests.test_draft_overlay_provider import FakeSvc, StubMain


def _edge(eid, s, t, etype="LINEAGE"):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": etype, "confidence": 1.0,
            "properties": {}}


class _NoScan(dict):
    def values(self):
        raise AssertionError("walked every edge of the draft")

    def items(self):
        raise AssertionError("walked every edge of the draft")


def _draft(n=20_000):
    edges = [_edge(f"e{i}", f"x{i}", f"y{i}") for i in range(n)]
    edges += [_edge("toA", "B", "A"), _edge("fromA", "A", "z"), _edge("AA", "A", "A")]
    delta = {"nodesUpsert": [], "nodesRemove": [], "edgesUpsert": edges, "edgesRemove": []}
    p = DraftOverlayProvider(StubMain(), svc=FakeSvc(delta), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_a_read_naming_its_ends_walks_only_their_edges():
    async def run():
        p = _draft()
        d = await p._delta_()
        d.edge_upsert = _NoScan(d.edge_upsert)
        got = {e.id for e in await p.get_edges(EdgeQuery(any_urns=["A"], limit=100))}
        assert {"toA", "fromA", "AA"} <= got and not any(i.startswith("e") for i in got)
        got = [e.id for e in await p.get_edges(EdgeQuery(source_urns=["A"], target_urns=["A"],
                                                         limit=100))]
        assert got.count("AA") == 1, got                     # both ends named: served once
        assert {e.id for e in await p.get_edges(EdgeQuery(target_urns=["y7"], limit=100))} == {"e7"}
    asyncio.run(run())
