"""A draft reads entities whose ids are not their urns the way it reads any other — needs Postgres.

Canvas and bootstrap writes key a node by its urn, so a draft's overlay named an edge's ends by the
entity ids on its version row and still matched. An import keys new nodes by minted ids
(``ent_…``), so on a draft those edges named ends no reader asked for: a new child under an
existing container was counted but never served, its parent read as empty, the child read as a
root, and a lineage edge to it matched nothing — until publish, where the projector names every
end by its urn. The overlay now names ends by urn too, exactly as the projector does, and agrees
with the branch reader (which already did) on every read.
"""
import os

import pytest

from backend.common.models.graph import EdgeQuery
from backend.tests.integration.test_fork_overlay_delta import _d, _run

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]


def _node(eid, urn, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn.split(":")[-1]}}


def _edge(eid, src, tgt, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _reader(svc, gid, bid):
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    p = VersionedBranchProvider(svc, graph_id=gid, branch_id=bid)
    p.set_containment_edge_types(CONT)
    return p


def _overlay(svc, gid, main, bid):
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    p = DraftOverlayProvider(_reader(svc, gid, main), svc=svc, graph_id=gid, branch_id=bid)
    p.set_containment_edge_types(CONT)
    return p


async def _seeded(svc):
    """main: schema P holding table T, and table L — every id an import's, not a urn."""
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                        ops=[_node("ent_P", "urn:P", "Schema"), _node("ent_T", "urn:T"),
                             _node("ent_L", "urn:L"), _edge("ent_cT", "ent_P", "ent_T", "CONTAINS"),
                             _edge("ent_lTL", "ent_T", "ent_L", "LINEAGE")])
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    # The draft adds table C under P, a lineage edge C → L, and drops T's lineage edge.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="import",
                        containment_edge_types=CONT,
                        ops=[_node("ent_C", "urn:C"), _edge("ent_cC", "ent_P", "ent_C", "CONTAINS"),
                             _edge("ent_lCL", "ent_C", "ent_L", "LINEAGE"),
                             _d("ent_lTL", kind="edge")])
    return gid, main, draft


def _ends(edges):
    return sorted((e.id, e.source_urn, e.target_urn, e.edge_type) for e in edges)


def test_a_drafts_patch_set_names_every_edge_end_by_its_urn():
    async def case(svc):
        gid, _main, draft = await _seeded(svc)
        delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=draft)
        ends = [(e["sourceUrn"], e["targetUrn"]) for key in ("edgesUpsert", "edgesRemove")
                for e in delta[key]]
        assert sorted(ends) == [("urn:C", "urn:L"), ("urn:P", "urn:C"), ("urn:T", "urn:L")], delta
    _run(case)


def test_a_new_child_under_an_existing_container_is_served_where_it_is_counted():
    async def case(svc):
        gid, main, draft = await _seeded(svc)
        oracle, overlay = _reader(svc, gid, draft), _overlay(svc, gid, main, draft)
        want = await oracle.get_children_with_edges("urn:P", edge_types=CONT)
        got = await overlay.get_children_with_edges("urn:P", edge_types=CONT)
        assert sorted(n.urn for n in got.children) == sorted(n.urn for n in want.children) == [
            "urn:C", "urn:T"]
        assert got.total_children == want.total_children == 2
        assert _ends(got.containment_edges) == _ends(want.containment_edges)
        assert (await overlay.get_node("urn:P")).child_count == 2
        roots = await overlay.get_top_level_or_orphan_nodes(limit=100)
        assert "urn:C" not in {n.urn for n in roots.nodes}, "a new child read as a root"
    _run(case)


def test_edges_to_and_from_imported_nodes_match_by_urn():
    async def case(svc):
        gid, main, draft = await _seeded(svc)
        oracle, overlay = _reader(svc, gid, draft), _overlay(svc, gid, main, draft)
        for q in (EdgeQuery(any_urns=["urn:C"], limit=100),
                  EdgeQuery(source_urns=["urn:C"], target_urns=["urn:L"], limit=100),
                  EdgeQuery(any_urns=["urn:T"], limit=100)):
            assert _ends(await overlay.get_edges(q)) == _ends(await oracle.get_edges(q)), q
        assert _ends(await overlay.get_edges(EdgeQuery(any_urns=["urn:L"], limit=100))) == [
            ("ent_lCL", "urn:C", "urn:L", "LINEAGE")]
    _run(case)


def test_the_slim_diff_names_entities_and_edge_ends_by_urn():
    async def case(svc):
        gid, _main, draft = await _seeded(svc)
        diff = await svc.diff_branch_vs_base(graph_id=gid, branch_id=draft, payloads="changes")
        added = {e["entityId"]: e for e in diff["added"]}
        assert added["ent_C"]["urn"] == "urn:C"
        assert (added["ent_cC"]["sourceUrn"], added["ent_cC"]["targetUrn"]) == ("urn:P", "urn:C")
        assert (added["ent_lCL"]["sourceUrn"], added["ent_lCL"]["targetUrn"]) == ("urn:C", "urn:L")
        removed, = diff["removed"]
        assert (removed["sourceUrn"], removed["targetUrn"]) == ("urn:T", "urn:L")
    _run(case)


def test_main_moving_on_after_the_draft_is_rewound_by_urn():
    """The rewind — main's changes since the draft branched off, undone in the draft's read — is
    told from version rows, which name an edge's ends by entity id: an edge main added between
    imported nodes is hidden, and one it deleted is back, under their urns."""
    async def case(svc):
        gid, _main, draft = await _seeded(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="main moves on",
                            containment_edge_types=CONT,
                            ops=[_edge("ent_lPL", "ent_P", "ent_L", "LINEAGE"),
                                 _d("ent_cT", kind="edge")])
        delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=draft)
        hidden = {e["id"]: (e["sourceUrn"], e["targetUrn"]) for e in delta["edgesRemove"]}
        back = {e["id"]: (e["sourceUrn"], e["targetUrn"]) for e in delta["edgesUpsert"]}
        assert hidden["ent_lPL"] == ("urn:P", "urn:L"), delta
        assert back["ent_cT"] == ("urn:P", "urn:T"), delta
        # And a reader of the draft sees the draft's main: T still under P, no P → L.
        overlay = _overlay(svc, gid, _main, draft)
        edges = await overlay.get_edges(EdgeQuery(any_urns=["urn:P"], limit=100))
        assert ("ent_cT", "urn:P", "urn:T", "CONTAINS") in _ends(edges)
        assert not any(e.id == "ent_lPL" for e in edges)
    _run(case)
