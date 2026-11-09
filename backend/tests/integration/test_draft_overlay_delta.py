"""The draft overlay's delta-computation service helpers — against Postgres.

The provider's overlay *application* is proven without infra in test_draft_overlay_provider.py; this
pins the two service methods that feed it against a real store: ``branch_overlay_delta`` (the draft's
reader-shaped patch set — empty for a no-change draft) and ``ancestor_chains``, by which a rollup read
places a flow (a column→column flow rolls up to the table→table cell via the draft's composed
containment).
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
        "nodesUpsert": [], "nodesModified": [], "nodesRemove": [], "edgesUpsert": [], "edgesRemove": [],
        "nodesNew": []}

    # ── ancestor rollup: a column→column flow is placed at the table→table pair, by its ends'
    #    chains on the draft's composed containment ──
    from backend.app.providers.draft_overlay_provider import _rollup_cells
    from backend.common.models.graph import GraphEdge
    chains = await svc.ancestor_chains(graph_id=gid, branch_id=d0, urns=["A.c", "B.c"],
                                       containment_edge_types=CONT)
    assert chains == {"A.c": ["A"], "B.c": ["B"]}, chains
    adj = {}
    _rollup_cells([GraphEdge.model_construct(id="f", sourceUrn="A.c", targetUrn="B.c",
                                             edgeType="LINEAGE", properties={})],
                  +1, chains, {"A", "B"}, {"A", "B"}, adj)
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
    # seed a node "DEL" onto main BEFORE forking, so it is present at the draft's fork point and we
    # can prove a main-DELETE-after-fork is RESTORED (not lost).
    await svc.apply_ops(graph_id=gid, actor="u", message="seed DEL",
                        containment_edge_types=CONT, ops=[_n("DEL", "Table")])
    d_iso = await svc.open_draft(graph_id=gid, owner="u")            # forks at current main head; NO own edits
    await svc.apply_ops(graph_id=gid, actor="u", message="main advances after fork",
                        containment_edge_types=CONT,
                        ops=[_n("M.new", "Table"),                  # main ADDS a node
                             {"op": "update", "entity_kind": "node", "entity_id": "A",  # main MODIFIES A
                              "payload": {"urn": "A", "entityType": "Table", "displayName": "A-renamed"}},
                             _e("M.lin", "B.c", "A.c", "LINEAGE"),  # main ADDS a lineage edge
                             {"op": "delete", "entity_kind": "edge",  # main DELETES a base lineage edge
                              "entity_id": "lin1", "payload": None},
                             {"op": "delete", "entity_kind": "node",  # main DELETES the seeded node
                              "entity_id": "DEL", "payload": None}])
    iso = await svc.branch_overlay_delta(graph_id=gid, branch_id=d_iso)
    # main-ADDED node absent at fork → REMOVED (the reported "Whoopppp/New Layer" leak). Also proves the
    # no-change draft is isolated — d_iso has no edits of its own.
    assert "M.new" in [n["urn"] for n in iso["nodesRemove"]], iso
    # main-ADDED lineage EDGE → REMOVED from the read.
    assert "M.lin" in [e["id"] for e in iso["edgesRemove"]], iso
    # main-DELETED-after-fork edge → RESTORED to the read (fork-point value).
    assert "lin1" in [e["id"] for e in iso["edgesUpsert"]], iso
    # main-MODIFIED node → restored to the FORK-POINT value ("A"), not main's live "A-renamed": named
    # as it was then (what a name search judges it by), and its value loaded when a read serves it —
    # the draft's value of what it did not touch is main's at its branch point.
    assert {"entityId": "A", "urn": "A", "entityType": "Table", "displayName": "A",
            "qualifiedName": None} in iso["nodesModified"], iso
    a_iso, = await svc.overlay_payloads(graph_id=gid, branch_id=d_iso, entity_ids=["A"])
    assert a_iso["displayName"] == "A", a_iso
    # main-DELETED-after-fork node → restored via upsert AND marked new so the list/search reads surface it.
    assert "DEL" in [n["urn"] for n in iso["nodesUpsert"]], iso
    assert "DEL" in iso["nodesNew"], iso

    # ── draft-wins: an entity the DRAFT itself modified is never rewound to main (or fork) ──────────
    d_own = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d_own, actor="u", message="draft renames A",
                        containment_edge_types=CONT,
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "A",
                              "payload": {"urn": "A", "entityType": "Table", "displayName": "A-draft"}}])
    await svc.apply_ops(graph_id=gid, actor="u", message="main also renames A",
                        containment_edge_types=CONT,
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "A",
                              "payload": {"urn": "A", "entityType": "Table", "displayName": "A-main2"}}])
    own = await svc.branch_overlay_delta(graph_id=gid, branch_id=d_own)
    # A node the draft modified comes by its version row alone — named as the draft names it; a read
    # loads its value when it serves it.
    assert own["nodesModified"] == [{"entityId": "A", "urn": "A", "entityType": "Table",
                                     "displayName": "A-draft", "qualifiedName": None}], own
    assert "A" not in [n["urn"] for n in own["nodesUpsert"]], own   # not rewound either
    a_own, = await svc.overlay_payloads(graph_id=gid, branch_id=d_own, entity_ids=["A"])
    assert a_own["displayName"] == "A-draft", a_own                 # draft's own value — not rewound

    # ── FORK GRAPH: a PARENT-SEEDED entity (no local rows in the fork) modified by a post-fork advance
    #    of the fork's main must be RESTORED to its fork-point value — a non-fork-aware base lookup
    #    would find no local row and wrongly REMOVE it (data disappearance). ─────────────────────────
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="u")
    fid = F["graph_id"]
    d_fork = await svc.open_draft(graph_id=fid, owner="u")           # forks F at its fork point; no own edits
    await svc.apply_ops(graph_id=fid, actor="u", message="fork main modifies a parent-seeded node",
                        containment_edge_types=CONT,
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "B",  # B is parent-seeded in F
                              "payload": {"urn": "B", "entityType": "Table", "displayName": "B-fork"}}])
    fk = await svc.branch_overlay_delta(graph_id=fid, branch_id=d_fork)
    assert {"entityId": "B", "urn": "B", "entityType": "Table", "displayName": "B",
            "qualifiedName": None} in fk["nodesModified"], fk
    b_fk, = await svc.overlay_payloads(graph_id=fid, branch_id=d_fork, entity_ids=["B"])
    assert b_fk["displayName"] == "B", b_fk                         # restored to fork-point value via parent seeding
    assert "B" not in [n["urn"] for n in fk["nodesRemove"]], fk     # NOT removed

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_draft_overlay_delta_e2e():
    asyncio.run(_run())


async def _run_rewind_unloaded() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT,
                        ops=[_n(f"T{i}") for i in range(30)] + [_e("k", "T0", "T1", "CONTAINS")])
    d = await svc.open_draft(graph_id=gid, owner="u")
    # Someone publishes a large change after the draft branched off.
    await svc.apply_ops(graph_id=gid, actor="u", message="publish", containment_edge_types=CONT, ops=[
        *({"op": "update", "entity_kind": "node", "entity_id": f"T{i}",
           "payload": {"urn": f"T{i}", "entityType": "Table", "displayName": f"T{i}'"}}
          for i in range(10, 30)),
        *(_n(f"M{i}") for i in range(20)),
        {"op": "delete", "entity_kind": "edge", "entity_id": "k", "payload": None}])

    saved = GraphVersioningService._values_at

    async def refused(self, *a, **k):
        raise AssertionError("the draft's patch set loaded a payload")
    GraphVersioningService._values_at = refused
    try:
        delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=d)
    finally:
        GraphVersioningService._values_at = saved
    # Every entity main advanced is rewound, by name: a read loads the values it serves.
    assert sorted(m["urn"] for m in delta["nodesModified"]) == sorted(f"T{i}" for i in range(10, 30))
    assert sorted(m["urn"] for m in delta["nodesRemove"]) == sorted(f"M{i}" for i in range(20))
    assert [e["id"] for e in delta["edgesUpsert"]] == ["k"] and delta["edgesUpsert"][0]["lazy"]
    t, = await svc.overlay_payloads(graph_id=gid, branch_id=d, entity_ids=["T10"])
    assert t["displayName"] == "T10"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_drafts_rewind_of_what_main_published_since_loads_no_payload():
    """After a large publish, each draft still open read every entity it changed, twice, whole."""
    asyncio.run(_run_rewind_unloaded())


if __name__ == "__main__":
    asyncio.run(_run())
    print("draft overlay delta (branch_overlay_delta + ancestor_chains) e2e: OK")
