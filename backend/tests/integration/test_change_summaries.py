"""Change list rows that say what they changed (``summary=true``), against Postgres: a draft's
rows, a window of main's, and a review's, each with its counts and first fields read for the page
in one batch; a summary read that fails leaves the page standing without them."""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name, op="create", **props):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name, "properties": props}}


async def _run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT,
                        ops=[_n("T1", "orders", owner="ana", tier="silver"), _n("T2", "sales")])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        _n("T1", "Orders", op="update", owner="bo", steward="cy"), _n("T3", "refunds", owner="ana")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)

    page = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(branch_id=d), containment_edge_types=CONT,
                                    summary=True)
    by = {e["entityId"]: e["fields"] for e in page["entries"]}
    assert (by["T1"]["changed"], by["T1"]["added"], by["T1"]["removed"]) == (2, 1, 0)   # an update patches: tier stays
    assert [t["label"] for t in by["T1"]["top"]][:2] == ["Name", "owner"]
    assert by["T1"]["top"][0] == {"label": "Name", "folder": None, "kind": "changed", "before": "orders", "after": "Orders"}
    assert by["T3"]["added"] == by["T3"]["total"] and by["T3"]["total"] >= 3
    # Without asking, rows carry no summary.
    assert "fields" not in (await svc.change_entries(graph_id=gid, origin=ChangeOrigin(branch_id=d),
                                                     containment_edge_types=CONT))["entries"][0]

    pr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="Tidy")
    review = await svc.review_change_entries(pr_id=pr, containment_edge_types=CONT, summary=True)
    assert {e["entityId"] for e in review["entries"] if e.get("fields")} == {"T1", "T3"}

    await svc.merge_mr(mr_id=pr, actor="bo", message="m", containment_edge_types=CONT)
    async with db.graphver_session() as s:
        head = (await s.get(models.GraphORM, gid)).main_head_commit_seq
    window = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(from_seq=head - 1, to_seq=head),
                                      containment_edge_types=CONT, summary=True)
    assert {e["entityId"] for e in window["entries"]} == {"T1", "T3"} and all(e["fields"] for e in window["entries"])

    # A summary read that fails: the page stands, without summaries.
    async def broken(*_a, **_k):
        raise RuntimeError("store unavailable")
    monkeypatch.setattr(svc, "_values_either_side", broken)
    page = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(from_seq=head - 1, to_seq=head),
                                    containment_edge_types=CONT, summary=True)
    assert len(page["entries"]) == 2 and not any("fields" in e for e in page["entries"])
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_change_list_rows_say_what_they_changed(monkeypatch):
    asyncio.run(_run(monkeypatch))
