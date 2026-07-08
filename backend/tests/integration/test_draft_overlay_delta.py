"""The draft overlay's delta-computation service helpers — against Postgres.

The provider's overlay *application* is proven without infra in test_draft_overlay_provider.py; this
pins the two service methods that feed it against a real store: ``branch_overlay_delta`` (the draft's
reader-shaped patch set — empty for a no-change draft) and ``aggregated_overlay_adjust`` (rolling a
column→column lineage delta up to the table→table rollup via composed-containment ancestors).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": eid}}


def _e(eid, s, t, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    # main: tables A,B each with a column, and a column→column lineage edge A.c → B.c
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT, ops=[
        _n("A"), _n("B"), _n("A.c", "Column"), _n("B.c", "Column"),
        _e("cA", "A", "A.c", "CONTAINS"), _e("cB", "B", "B.c", "CONTAINS"),
        _e("lin1", "A.c", "B.c", "LINEAGE"),
    ])

    # ── no-change draft → empty patch set (the invariant's source) ──────────────
    d0 = await svc.open_draft(graph_id=gid, owner="u")
    assert await svc.branch_overlay_delta(graph_id=gid, branch_id=d0) == {
        "nodesUpsert": [], "nodesRemove": [], "edgesUpsert": [], "edgesRemove": [], "nodesNew": []}
    assert await svc.aggregated_overlay_adjust(
        graph_id=gid, branch_id=d0, source_urns=["A", "B"], target_urns=["A", "B"],
        lineage_delta=[], containment_edge_types=CONT) == {}

    # ── ancestor rollup: a column→column lineage delta maps to the table→table pair ──
    adj = await svc.aggregated_overlay_adjust(
        graph_id=gid, branch_id=d0, source_urns=["A", "B"], target_urns=["A", "B"],
        lineage_delta=[("A.c", "B.c", "LINEAGE", +1)], containment_edge_types=CONT)
    assert adj.get(("A", "B"), {}).get("weight") == 1, adj
    assert "LINEAGE" in adj[("A", "B")]["types"]
    assert ("B", "A") not in adj                                  # direction respected

    # ── draft ADDS a lineage edge → it appears in the patch set as an upsert ────
    # (reverse direction: an exact duplicate of lin1 — same source+target+type — is now
    # rejected by the authoritative edge-integrity gate, as it is in the UI)
    d1 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="u", message="add lineage",
                        containment_edge_types=CONT, ops=[_e("lin2", "B.c", "A.c", "LINEAGE")])
    delta1 = await svc.branch_overlay_delta(graph_id=gid, branch_id=d1)
    assert [e["id"] for e in delta1["edgesUpsert"]] == ["lin2"], delta1
    assert not delta1["nodesUpsert"] and not delta1["nodesRemove"] and not delta1["edgesRemove"]

    # ── draft DELETES the base lineage edge → it appears as a removal (before value) ──
    d2 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="u", message="drop lineage",
                        containment_edge_types=CONT,
                        ops=[{"op": "delete", "entity_kind": "edge", "entity_id": "lin1", "payload": None}])
    delta2 = await svc.branch_overlay_delta(graph_id=gid, branch_id=d2)
    assert [e["id"] for e in delta2["edgesRemove"]] == ["lin1"], delta2
    assert delta2["edgesRemove"][0]["sourceUrn"] == "A.c" and delta2["edgesRemove"][0]["targetUrn"] == "B.c"

    # ── draft ADDS a node + containment edge → node upsert + containment upsert ──
    d3 = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d3, actor="u", message="add column",
                        containment_edge_types=CONT, ops=[_n("A.c2", "Column"), _e("cA2", "A", "A.c2", "CONTAINS")])
    delta3 = await svc.branch_overlay_delta(graph_id=gid, branch_id=d3)
    assert [n["urn"] for n in delta3["nodesUpsert"]] == ["A.c2"], delta3
    assert [e["id"] for e in delta3["edgesUpsert"]] == ["cA2"], delta3

    # ── FORK-POINT ISOLATION: main advances AFTER a draft forks (e.g. another branch merged
    #    into it) → the draft must NOT reflect main's new content. Otherwise a draft reads live
    #    main and silently "pulls" changes it never merged (no commit, no user action). The
    #    overlay must rewind main from head back to the draft's fork point. ─────────────────
    d_iso = await svc.open_draft(graph_id=gid, owner="u")            # forks at current main head; NO own edits
    await svc.apply_ops(graph_id=gid, actor="u", message="main advances after fork",
                        containment_edge_types=CONT,
                        ops=[_n("M.new", "Table"),                  # main ADDS a node
                             {"op": "update", "entity_kind": "node", "entity_id": "A",  # main MODIFIES A
                              "payload": {"urn": "A", "entityType": "Table", "displayName": "A-renamed"}}])
    iso = await svc.branch_overlay_delta(graph_id=gid, branch_id=d_iso)
    # main-ADDED "M.new" is absent at the draft's fork point → overlay REMOVES it so it can't leak in.
    # (This also proves the no-change draft is isolated — d_iso has no edits of its own.)
    assert "M.new" in [n["urn"] for n in iso["nodesRemove"]], iso
    # main-MODIFIED "A" → overlay restores the FORK-POINT value ("A"), not main's live "A-renamed".
    a_up = [n for n in iso["nodesUpsert"] if n["urn"] == "A"]
    assert a_up and a_up[0]["displayName"] == "A", iso

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_draft_overlay_delta_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("draft overlay delta (branch_overlay_delta + aggregated_overlay_adjust) e2e: OK")
