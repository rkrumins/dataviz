"""An entity's summary and its paged history, as the line being read has them (needs Postgres).

The drawers downloaded an entity's whole history to show two timestamps, and a draft's "Updated"
read whatever row was newest on any branch — main's later edit included, which the draft does not
have. The summary answers for the line being read; the history pages newest first across main and
the draft being viewed, never another user's draft, each row saying what it changed.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.entity_audit import entity_history_page, entity_summary
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
