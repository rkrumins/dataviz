"""An entity's summary and its paged history, as the line being read has them (needs Postgres).

The drawers downloaded an entity's whole history to show two timestamps, and a draft's "Updated"
read whatever row was newest on any branch — main's later edit included, which the draft does not
have. The summary answers for the line being read; the history pages newest first across main and
the draft being viewed, never another user's draft, each row saying what it changed.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.entity_audit import entity_deletion, entity_history_page, entity_summary
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService, Viewer


def _node(urn, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": urn, "properties": props}}


def _set(urn, **props):
    return {"op": "update", "entity_kind": "node", "entity_id": urn, "payload": {"properties": props}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws_audit", actor="ana")
    gid, main = g["graph_id"], g["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", ops=[_node("A", v=0), _node("B", v=0)])
    await svc.apply_ops(graph_id=gid, actor="bo", message="bo edits A", ops=[_set("A", v=1)])
    d = await svc.open_draft(graph_id=gid, owner="cy")

    # main moves on after the branch point; the draft never touches A
    await svc.apply_ops(graph_id=gid, actor="dee", message="later on main", ops=[_set("A", v=2)])

    s = await entity_summary(svc, graph_id=gid, entity_id="A", branch_id=d, include_value=True)
    at_branch_point = {"urn": "A", "entityType": "dataset", "displayName": "A", "properties": {"v": 1}}
    assert s["exists"] and s["kind"] == "node"
    assert s["version"] == content_hash(at_branch_point), s          # main AT the branch point
    assert s["value"]["node"]["properties"] == {"v": 1}
    assert s["created"]["actor"] == "ana" and not s["created"]["inDraft"]
    assert s["updated"]["actor"] == "bo"                              # not dee's later edit
    assert s["changedOnMainSinceBranch"] is True
    assert s["revisions"] == {"published": 2, "draft": 0}

    on_main = await entity_summary(svc, graph_id=gid, entity_id="A")
    assert on_main["updated"]["actor"] == "dee" and on_main["revisions"]["published"] == 3

    # the draft edits A: its own edit is the last change, counted as the draft's
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="cy", message="cy edits A", ops=[_set("A", w=1)])
    s = await entity_summary(svc, graph_id=gid, entity_id="A", branch_id=d)
    assert s["updated"]["actor"] == "cy" and s["updated"]["inDraft"] is True
    assert s["revisions"] == {"published": 2, "draft": 1}

    # history: newest first, main + this draft, with what each row changed
    page = await entity_history_page(svc, graph_id=gid, entity_id="A", branch_id=d)
    ops = [(v["actor"], v["on_draft"], v["after_branch_point"]) for v in page["versions"]]
    assert ops == [("cy", True, False), ("dee", False, True), ("bo", False, False), ("ana", False, False)]
    assert page["versions"][0]["changes"] == [
        {"path": ["properties", "w"], "kind": "added", "before": None, "after": 1}]
    assert page["versions"][1]["changes"] == [
        {"path": ["properties", "v"], "kind": "changed", "before": 1, "after": 2}]
    assert page["versions"][0]["commit_message"] == "cy edits A"
    assert "payload" not in page["versions"][0]

    assert [v["actor"] for v in (await entity_history_page(
        svc, graph_id=gid, entity_id="A", branch_id=d, scope="draft"))["versions"]] == ["cy"]
    assert [v["actor"] for v in (await entity_history_page(
        svc, graph_id=gid, entity_id="A", branch_id=d, scope="published"))["versions"]] == ["dee", "bo", "ana"]

    # another user's draft is never read into this history
    other = await svc.open_draft(graph_id=gid, owner="eve")
    await svc.apply_ops(graph_id=gid, branch_id=other, actor="eve", message="eve", ops=[_set("A", eve=1)])
    assert "eve" not in [v["actor"] for v in (await entity_history_page(
        svc, graph_id=gid, entity_id="A", branch_id=d))["versions"]]
    with pytest.raises(AccessDenied):
        await svc.assert_branch_readable(graph_id=gid, branch_id=other, viewer=Viewer(actor="cy"))

    # 120 revisions page without a gap or a repeat
    for i in range(119):
        await svc.apply_ops(graph_id=gid, actor="ana", message=f"b{i}", ops=[_set("B", v=i + 1)])
    seen, before = [], None
    while True:
        page = await entity_history_page(svc, graph_id=gid, entity_id="B", limit=50, before=before)
        seen += [v["id"] for v in page["versions"]]
        if not page["hasMore"]:
            assert page["nextBefore"] is None
            break
        before = page["nextBefore"]
    assert len(seen) == 120 and len(set(seen)) == 120

    # an edge answers too (kind found without being told)
    await svc.apply_ops(graph_id=gid, actor="ana", message="edge", ops=[{
        "op": "create", "entity_kind": "edge", "entity_id": "E",
        "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B", "properties": {}}}])
    e = await entity_summary(svc, graph_id=gid, entity_id="E", include_value=True)
    assert e["kind"] == "edge" and e["value"]["edge"]["sourceUrn"] == "A"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_entity_summary_and_history_e2e():
    asyncio.run(_run())


# ── Deletions: who, what it held, where it lived, and what it took with it ───
CONT = ["CONTAINS"]


def _named(eid, name, etype, urn=None, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn or eid, "entityType": etype, "displayName": name, "properties": props}}


def _link(eid, src, tgt, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _gone(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _published_deletion(svc):
    """main: Sales ⊃ crm ⊃ {orders ⊃ {amount, currency}, report, an imported table (id ≠ urn)},
    with lineage from orders to report and from amount to the imported table. In cy's draft bo
    deletes orders — its columns and every link on them go in the same commit — and cy
    publishes it."""
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="ana")
    gid, main = G["graph_id"], G["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
        _named("DOM", "Sales", "Domain"), _named("SCH", "crm", "Schema"), _named("T", "orders", "Table"),
        _named("C1", "amount", "Column"), _named("C2", "currency", "Column"),
        _named("OUT", "report", "Table"), _named("ent_X", "imported", "Table", urn="urn:x"),
        _link("dom_sch", "DOM", "SCH"), _link("sch_t", "SCH", "T"), _link("t_c1", "T", "C1"),
        _link("t_c2", "T", "C2"), _link("sch_out", "SCH", "OUT"), _link("sch_x", "SCH", "ent_X"),
        _link("lin", "T", "OUT", "LINEAGE"), _link("lin_x", "C1", "ent_X", "LINEAGE")])
    await svc.apply_ops(graph_id=gid, actor="ana", message="describe orders", ops=[_set("T", rows=12)])
    d = await svc.open_draft(graph_id=gid, owner="cy")
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user", subject_id="bo",
                                role="editor", actor="cy")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bo", message="drop orders",
                        containment_edge_types=CONT, ops=[_gone("T")])
    return gid, main, d


async def _run_deletion() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, main, d = await _published_deletion(svc)
    ancestors = [{"urn": "DOM", "displayName": "Sales", "entityType": "Domain"},
                 {"urn": "SCH", "displayName": "crm", "entityType": "Schema"}]

    # Before it is published: the draft's own deletion, the person who made it, main as it was.
    mine = await entity_deletion(svc, graph_id=gid, entity_id="T", branch_id=d, containment_edge_types=CONT)
    assert mine["deleted"]["inDraft"] is True and mine["deleted"]["deletedBy"] == "bo"
    assert "mergedBy" not in mine["deleted"] and mine["deleted"]["message"] == "drop orders"
    assert mine["lastValue"]["properties"] == {"rows": 12} and mine["urn"] == "T"
    assert mine["ancestors"] == ancestors
    assert (await entity_deletion(svc, graph_id=gid, entity_id="T", containment_edge_types=CONT))["deleted"] is None

    await svc.publish(graph_id=gid, branch_id=d, actor="cy", message="publish the drop")
    n = (await svc.get_graph(gid))["main_head_commit_seq"]
    async with db.graphver_session() as s:
        was = (await svc._values_at(s, gid, main, ["T"], n - 1))["T"]
        squash = await s.get(models.CommitORM, (gid, await svc.merged_commit_id(graph_id=gid, branch_id=d)))

    # Published: main's revision N, deleted by bo in the draft, published by cy.
    out = await entity_deletion(svc, graph_id=gid, entity_id="T", containment_edge_types=CONT)
    gone = out["deleted"]
    assert (gone["seq"], gone["commitKind"], gone["message"]) == (n, "squash_publish", "publish the drop")
    assert (gone["deletedBy"], gone["mergedBy"], gone["inDraft"]) == ("bo", "cy", False)
    assert gone["mergedAt"] == squash.created_at and gone["at"] < squash.created_at
    assert gone["commitId"] == squash.id
    assert out["lastValue"] == was and out["kind"] == "node" and out["urn"] == "T"
    assert out["ancestors"] == ancestors and out.get("ends") is None

    # An edge says where its ends were: by urn, as the canvas names them (an imported one's isn't its id).
    lin = await entity_deletion(svc, graph_id=gid, entity_id="lin_x", containment_edge_types=CONT)
    assert lin["kind"] == "edge" and lin["deleted"]["deletedBy"] == "bo" and lin["urn"] is None
    assert lin["ends"] == {"source": {"urn": "C1", "displayName": "amount"},
                           "target": {"urn": "urn:x", "displayName": "imported"}}
    assert lin["lastValue"]["edgeType"] == "LINEAGE" and lin["ancestors"] == []

    # What is live has no deletion to tell.
    live = await entity_deletion(svc, graph_id=gid, entity_id="DOM", containment_edge_types=CONT)
    assert (live["deleted"], live["lastValue"], live["ancestors"]) == (None, None, [])

    # A draft-only deletion: the draft's own revision, main where it branched off.
    d2 = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="ana", message="drop report",
                        containment_edge_types=CONT, ops=[_gone("OUT")])
    report = await entity_deletion(svc, graph_id=gid, entity_id="OUT", branch_id=d2, containment_edge_types=CONT)
    assert report["deleted"]["inDraft"] is True and report["deleted"]["deletedBy"] == "ana"
    assert report["deleted"]["seq"] == 1 and report["deleted"]["commitKind"] == "edit"
    assert report["lastValue"]["displayName"] == "report" and report["ancestors"] == ancestors
    assert (await entity_deletion(svc, graph_id=gid, entity_id="OUT", containment_edge_types=CONT))["deleted"] is None
    # ...and one the draft restored is not deleted on the draft's line.
    d3 = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.apply_ops(graph_id=gid, branch_id=d3, actor="ana", message="back",
                        ops=[_named("T", "orders", "Table")])
    assert (await entity_deletion(svc, graph_id=gid, entity_id="T", branch_id=d3,
                                  containment_edge_types=CONT))["deleted"] is None

    # Deleted, made again, deleted again: atSeq picks which.
    seqs = []
    for actor, op in (("ana", _named("Z", "z", "Table", v=1)), ("ana", _gone("Z")),
                      ("dee", _named("Z", "z", "Table", v=2)), ("dee", _gone("Z"))):
        await svc.apply_ops(graph_id=gid, actor=actor, message=op["op"], ops=[op])
        seqs.append((await svc.get_graph(gid))["main_head_commit_seq"])
    first = await entity_deletion(svc, graph_id=gid, entity_id="Z", at_seq=seqs[1], containment_edge_types=CONT)
    assert first["deleted"]["seq"] == seqs[1] and first["lastValue"]["properties"] == {"v": 1}
    assert first["deleted"]["deletedBy"] == "ana" and "mergedBy" not in first["deleted"]
    assert (await entity_deletion(svc, graph_id=gid, entity_id="Z", at_seq=seqs[2],
                                  containment_edge_types=CONT))["deleted"] is None
    last = await entity_deletion(svc, graph_id=gid, entity_id="Z", containment_edge_types=CONT)
    assert last["deleted"]["seq"] == seqs[3] and last["lastValue"]["properties"] == {"v": 2}
    assert last["deleted"]["deletedBy"] == "dee"
    with pytest.raises(ValueError):
        await entity_deletion(svc, graph_id=gid, entity_id="Z", at_seq=seqs[3] + 1, containment_edge_types=CONT)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_entity_deletion_e2e():
    asyncio.run(_run_deletion())


async def _run_cascade() -> None:
    from backend.app.services.versioning import service as service_mod
    from backend.app.services.versioning.change_index import ChangeOrigin

    await models.create_schema_and_partitions()
    service_mod._CHANGE_INDEXES.clear()
    svc = GraphVersioningService()
    gid, main, d = await _published_deletion(svc)
    base = (await svc.get_graph(gid))["main_head_commit_seq"]

    async def cascade(origin, root):
        return await svc.deletion_cascade(graph_id=gid, origin=origin, entity_id=root,
                                          containment_edge_types=CONT)

    links = {"sch_t", "t_c1", "t_c2", "lin", "lin_x"}
    drafted = await cascade(ChangeOrigin(branch_id=d), "T")
    await svc.publish(graph_id=gid, branch_id=d, actor="cy", message="publish the drop")
    n = (await svc.get_graph(gid))["main_head_commit_seq"]
    window = ChangeOrigin(from_seq=n - 1, to_seq=n)
    out = await cascade(window, "T")
    assert out["restorable"] is True and out.get("reason") is None and out["root"] == "T"
    assert out["origin"] == {"fromSeq": n - 1, "toSeq": n} and out["total"] == {"nodes": 3, "links": 5}
    removed = out["removed"]
    # The node first, then its children, then every link with an end among them.
    assert [e["entityId"] for e in removed[:3]] == ["T", "C1", "C2"]
    assert {e["entityId"] for e in removed[3:]} == links and all(e["kind"] == "edge" for e in removed[3:])
    assert all(e["status"] == "removed" for e in removed)
    async with db.graphver_session() as s:
        before = await svc._values_at(s, gid, main, [e["entityId"] for e in removed], n - 1)
    assert {e["entityId"]: e["before"] for e in removed} == before
    by_id = {e["entityId"]: e for e in removed}
    assert by_id["T"]["urn"] == "T" and by_id["T"]["before"]["properties"] == {"rows": 12}
    assert (by_id["lin_x"]["sourceUrn"], by_id["lin_x"]["targetUrn"]) == ("C1", "urn:x")
    assert (by_id["sch_t"]["sourceUrn"], by_id["sch_t"]["targetUrn"]) == ("SCH", "T")
    # The draft it came from said the same before it was published, its values main's at its base.
    assert drafted["removed"] == removed and drafted["origin"] == {"branchId": d}
    assert drafted["restorable"] is True and base == n - 1

    # A child alone; a link alone.
    child = await cascade(window, "C1")
    assert child["removed"][0]["entityId"] == "C1" and child["total"] == {"nodes": 1, "links": 2}
    assert {e["entityId"] for e in child["removed"][1:]} == {"t_c1", "lin_x"}
    assert [e["entityId"] for e in (await cascade(window, "lin"))["removed"]] == ["lin"]

    # What the window did not remove.
    for root in ("DOM", "nothing"):
        kept = await cascade(window, root)
        assert (kept["restorable"], kept["reason"], kept["removed"]) == (False, "not_deleted", [])
        assert kept["total"] == {"nodes": 0, "links": 0}

    # Past a cap: counted, no values.
    for cap, value in (("_CASCADE_NODES_MAX", 2), ("_CASCADE_LINKS_MAX", 4)):
        saved = getattr(service_mod, cap)
        setattr(service_mod, cap, value)
        try:
            big = await cascade(window, "T")
        finally:
            setattr(service_mod, cap, saved)
        assert (big["restorable"], big["reason"], big["removed"]) == (False, "too_large", [])
        assert big["total"] == {"nodes": 3, "links": 5}
    assert (await cascade(window, "T"))["restorable"] is True

    # A change list too large to list has no walk to make.
    saved = config.CHANGE_LIST_MAX
    try:
        config.CHANGE_LIST_MAX = 3
        service_mod._CHANGE_INDEXES.clear()
        huge = await cascade(window, "T")
    finally:
        config.CHANGE_LIST_MAX = saved
        service_mod._CHANGE_INDEXES.clear()
    assert (huge["restorable"], huge["reason"], huge["total"], huge["removed"]) == (False, "too_large", None, [])

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_deletion_cascade_e2e():
    asyncio.run(_run_cascade())
