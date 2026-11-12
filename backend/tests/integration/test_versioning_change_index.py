"""Change lists against Postgres: a window of main's revisions and a draft, listed and counted
from one index — and the guards that keep the trees, reviews and pulls from reading a large
change whole.

Oracles: ``diff_window`` (whole payloads, every entity resolved at both ends) for a window, and
``diff_branch_vs_base`` for a draft. For every pair of revisions the index's summary and list
agree with the oracle and with each other; pages, filters and the compact form cover the list
exactly; and none of it reads a branch's whole state.
"""
import asyncio
import os
from itertools import combinations

import pytest
from sqlalchemy import update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning import service as service_mod
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.models import CommitORM
from backend.app.services.versioning.service import DiffTooLarge, GraphVersioningService

from .test_versioning_bounded_reads import _whole_graph_reads_refused

CONT = ["CONTAINS"]


def _n(eid, name=None, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name or eid}}


def _u(eid, name, etype="Column"):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _e(eid, s, t, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


def _oracle(flat) -> dict:
    """``{entity id: status}`` of a whole-payload diff (lists of entries, or an id-keyed diff)."""
    out = {}
    for status in ("added", "removed", "modified"):
        items = flat.get(status) or []
        for item in (items if isinstance(items, list) else list(items)):
            out[item["entityId"] if isinstance(item, dict) else item] = status
    return out


async def _all_entries(svc, gid, origin, limit=2, **filters):
    rows, offset = [], 0
    while True:
        page = await svc.change_entries(graph_id=gid, origin=origin, containment_edge_types=CONT,
                                        offset=offset, limit=limit, **filters)
        rows += page["entries"]
        assert len(page["entries"]) <= limit
        if not page["hasMore"]:
            assert offset + len(page["entries"]) == page["total"]
            return rows
        offset += len(page["entries"])


async def _check_origin(svc, gid, origin, expected: dict) -> None:
    summary = await svc.change_summary(graph_id=gid, origin=origin, containment_edge_types=CONT)
    counts = {s: sum(1 for v in expected.values() if v == s) for s in ("added", "modified", "removed")}
    assert summary["counts"] == counts, (origin, summary["counts"], counts)
    assert summary["tooLarge"] is None and summary["listed"] == len(expected)
    # Entities + relationships + structure is everything; byType adds up to the counts.
    split = [summary[k] for k in ("entityCounts", "edgeCounts", "structureCounts")]
    assert {s: sum(c[s] for c in split) for s in counts} == counts
    assert {s: sum(r[s] for r in summary["byType"]) for s in counts} == counts
    # The list, paged two at a time, is exactly the oracle's, each entity once.
    rows = await _all_entries(svc, gid, origin)
    assert {r["entityId"]: r["status"] for r in rows} == expected and len(rows) == len(expected)
    # Kinds partition it; a status filter keeps exactly its own.
    kinds = [await _all_entries(svc, gid, origin, kind=k) for k in ("node", "edge", "structure")]
    assert sorted(r["entityId"] for part in kinds for r in part) == sorted(expected)
    removed = await _all_entries(svc, gid, origin, statuses=("removed",))
    assert {r["entityId"] for r in removed} == {e for e, s in expected.items() if s == "removed"}
    # The canvas's compact form says the same.
    compact = await svc.change_index_compact(graph_id=gid, origin=origin, containment_edge_types=CONT)
    code = {"a": "added", "m": "modified", "r": "removed"}
    assert {e[0]: code[e[2]] for e in compact["entries"]} == expected and not compact["truncated"]
    # Capped at what it holds, it is the same answer; one short, its total and no entries.
    assert await svc.change_index_compact(graph_id=gid, origin=origin, containment_edge_types=CONT,
                                          max_entries=len(expected)) == compact
    if expected:
        capped = await svc.change_index_compact(graph_id=gid, origin=origin, containment_edge_types=CONT,
                                                max_entries=len(expected) - 1)
        assert capped == {**compact, "entries": [], "truncated": True}
        assert capped["total"] == len(expected)


async def _check_batch(svc, gid, origin, ids) -> None:
    """Opening many entries at once is opening each in turn: the same entries, in the order asked,
    without the ids the origin did not change (on neither side, or changed and changed back)."""
    one_by_one = []
    for eid in ids:
        try:
            entry = await svc.change_entry(graph_id=gid, origin=origin, entity_id=eid)
        except ValueError:
            continue
        if entry["status"] != "unchanged":
            one_by_one.append(entry)
    batch = await svc.change_entries_batch(graph_id=gid, origin=origin, entity_ids=ids)
    assert batch == {"entries": one_by_one}, origin


async def _run() -> None:
    await models.create_schema_and_partitions()
    service_mod._CHANGE_INDEXES.clear()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main's revisions: a seed, an addition, a rename, a deletion, an edit undone in the next one.
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
        _n("DOM", "Domain", etype="Dataset"), _n("T1", "orders"),
        _n("C1", "amount", etype="Column"), _n("C2", "currency", etype="Column"),
        _e("e_d1", "DOM", "T1"), _e("e_t1c1", "T1", "C1"), _e("e_t1c2", "T1", "C2")])
    await svc.apply_ops(graph_id=gid, actor="bo", message="add", containment_edge_types=CONT, ops=[
        _n("T2", "customers"), _e("e_d2", "DOM", "T2"), _e("f_12", "T1", "T2", "FLOWS_TO")])
    await svc.apply_ops(graph_id=gid, actor="ana", message="rename", containment_edge_types=CONT,
                        ops=[_u("C1", "amount_usd")])
    await svc.apply_ops(graph_id=gid, actor="bo", message="drop", containment_edge_types=CONT,
                        ops=[_del("C2")])
    await svc.apply_ops(graph_id=gid, actor="ana", message="rename back", containment_edge_types=CONT,
                        ops=[_u("C1", "amount")])
    log = await svc.commit_log(graph_id=gid, branch_id=main, limit=100)
    head = max(c["commit_seq"] for c in log)

    # ── every window of main against the whole-payload oracle ───────────────
    every = ["DOM", "T1", "C1", "C2", "T2", "e_d1", "e_t1c1", "e_t1c2", "e_d2", "f_12", "nothing"]
    with _whole_graph_reads_refused():
        for lo, hi in combinations(range(0, head + 1), 2):
            flat = await svc.diff_window(graph_id=gid, branch_id=main, from_seq=lo, to_seq=hi)
            await _check_origin(svc, gid, ChangeOrigin(from_seq=lo, to_seq=hi), _oracle(flat))
            await _check_batch(svc, gid, ChangeOrigin(from_seq=lo, to_seq=hi), every)

    # A rename undone later is no net change across both revisions, but a change in each.
    seqs = {c["message"]: c["commit_seq"] for c in log}
    across = await _all_entries(svc, gid, ChangeOrigin(from_seq=seqs["add"], to_seq=head))
    assert "C1" not in {r["entityId"] for r in across} and {"C2", "e_t1c2"} <= {
        r["entityId"] for r in across}
    only_back = await _all_entries(svc, gid, ChangeOrigin(from_seq=seqs["drop"], to_seq=head))
    assert [(r["entityId"], r["status"]) for r in only_back] == [("C1", "modified")]

    # The window names its revisions, its people, and an edge's ends.
    s = await svc.change_summary(graph_id=gid, origin=ChangeOrigin(from_seq=seqs["seed"], to_seq=head),
                                 containment_edge_types=CONT)
    w = s["window"]
    assert w["commitCount"] == head - seqs["seed"] and w["contributors"] == ["bo", "ana"]
    assert w["from"]["message"] == "seed" and w["to"]["message"] == "rename back"
    flow = next(r for r in await _all_entries(svc, gid, ChangeOrigin(from_seq=seqs["seed"], to_seq=head),
                                              kind="edge"))
    assert (flow["entityId"], flow["sourceName"], flow["targetName"]) == ("f_12", "orders", "customers")

    # One entity before and after.
    one = await svc.change_entry(graph_id=gid, origin=ChangeOrigin(from_seq=seqs["add"], to_seq=seqs["rename"]),
                                 entity_id="C1")
    assert one["status"] == "modified" and one["kind"] == "node"
    assert (one["before"]["displayName"], one["after"]["displayName"]) == ("amount", "amount_usd")
    # Many at once leave out what the window did not change: C1, renamed and renamed back.
    back = ChangeOrigin(from_seq=seqs["add"], to_seq=head)
    assert (await svc.change_entry(graph_id=gid, origin=back, entity_id="C1"))["status"] == "unchanged"
    many = await svc.change_entries_batch(graph_id=gid, origin=back, entity_ids=["C1", "C2", "T1"])
    assert [(e["entityId"], e["status"]) for e in many["entries"]] == [("C2", "removed")]

    # A window past main's head is no window.
    with pytest.raises(ValueError):
        await svc.change_summary(graph_id=gid, origin=ChangeOrigin(from_seq=0, to_seq=head + 1),
                                 containment_edge_types=CONT)

    # ── a draft against main where it branched ──────────────────────────────
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        _n("T3", "payments"), _e("e_d3", "DOM", "T3"), _u("C1", "amount_eur"), _del("f_12", "edge")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    draft = ChangeOrigin(branch_id=d)
    with _whole_graph_reads_refused():
        await _check_origin(svc, gid, draft, _oracle(await svc.diff_branch_vs_base(graph_id=gid, branch_id=d)))
        await _check_batch(svc, gid, draft, every + ["T3", "e_d3"])
    entry = await svc.change_entry(graph_id=gid, origin=draft, entity_id="C1")
    assert (entry["before"]["displayName"], entry["after"]["displayName"]) == ("amount", "amount_eur")

    # A new checkpoint is a new index, never the last one served again.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_n("T4", "refunds")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    again = await svc.change_summary(graph_id=gid, origin=draft, containment_edge_types=CONT)
    assert again["counts"]["added"] == 3                         # T3, its link, T4

    # main is listed between revisions, not as a branch.
    with pytest.raises(ValueError):
        await svc.change_summary(graph_id=gid, origin=ChangeOrigin(branch_id=main),
                                 containment_edge_types=CONT)

    # ── past CHANGE_LIST_MAX: counted, not listed ───────────────────────────
    saved_list, saved_tree = config.CHANGE_LIST_MAX, config.DIFF_TREE_MAX_CHANGES
    try:
        config.CHANGE_LIST_MAX = 3
        service_mod._CHANGE_INDEXES.clear()
        big = await svc.change_summary(graph_id=gid, origin=ChangeOrigin(from_seq=0, to_seq=head),
                                       containment_edge_types=CONT)
        assert big["tooLarge"]["limit"] == 3 and big["listed"] == 0 and big["approximate"] is True
        assert big["entityCounts"] is None
        counted = await svc.change_summary(graph_id=gid, origin=draft, containment_edge_types=CONT)
        assert counted["tooLarge"] == {"changed": 5, "limit": 3} and counted["listed"] == 0
        assert counted["counts"] == again["counts"]               # a draft past it is still counted exactly
        compact = await svc.change_index_compact(graph_id=gid, origin=draft, containment_edge_types=CONT)
        assert compact["truncated"] and compact["entries"] == []

        # ── the trees and the review past DIFF_TREE_MAX_CHANGES ─────────────
        config.CHANGE_LIST_MAX = saved_list
        config.DIFF_TREE_MAX_CHANGES = 2
        service_mod._CHANGE_INDEXES.clear()
        seed_id = next(c["commit_id"] for c in log if c["message"] == "seed")
        with _whole_graph_reads_refused():
            tree = await svc.diff_commit_summary(graph_id=gid, commit_id=seed_id, containment_edge_types=CONT)
        assert tree["tooLarge"] == {"changed": 7, "limit": 2} and tree["groups"] == []
        assert tree["counts"] == {"added": 7, "modified": 0, "removed": 0}
        assert tree["entityCounts"]["added"] == 4 and tree["impact"] == {"Dataset": 1, "Table": 1, "Column": 2}
        with pytest.raises(DiffTooLarge):
            await svc.diff_commit_children(graph_id=gid, commit_id=seed_id, container_key="DOM",
                                           containment_edge_types=CONT)
        pr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="payments")
        with _whole_graph_reads_refused():
            review = await svc.diff_pr_summary(pr_id=pr, containment_edge_types=CONT)
        assert review["tooLarge"]["limit"] == 2 and review["counts"] == again["counts"]
        with pytest.raises(DiffTooLarge):
            await svc.diff_pr(pr_id=pr)
        # ...and the whole-payload diffs the screens moved off, in either mode.
        for mode in ("changes", "all"):
            with pytest.raises(DiffTooLarge):
                await svc.diff_branch_vs_base(graph_id=gid, branch_id=d, payloads=mode)
        with pytest.raises(DiffTooLarge):
            await svc.diff_window(graph_id=gid, branch_id=main, from_seq=0, to_seq=head)
        assert (await svc.diff_window(graph_id=gid, branch_id=main, from_seq=head - 1, to_seq=head))[
            "modified"]                                   # one entity: well inside the cap
    finally:
        config.CHANGE_LIST_MAX, config.DIFF_TREE_MAX_CHANGES = saved_list, saved_tree
        service_mod._CHANGE_INDEXES.clear()

    # ── the history calendar, in the reader's time zone ─────────────────────
    late = next(c["commit_id"] for c in log if c["message"] == "rename back")
    async with db.graphver_session() as gs:
        await gs.execute(update(CommitORM).where(CommitORM.graph_id == gid).values(
            created_at="2026-10-15T09:00:00+00:00"))
        await gs.execute(update(CommitORM).where(CommitORM.graph_id == gid, CommitORM.id == late)
                         .values(created_at="2026-10-31T23:30:00+00:00"))
    service_mod._HISTORY_MONTHS.clear()
    utc = await svc.history_months(graph_id=gid, tz="UTC")
    assert [m["month"] for m in utc["months"]] == ["2026-10"]
    assert utc["months"][0]["lastSeq"] == head and utc["headSeq"] == head
    berlin = await svc.history_months(graph_id=gid, tz="Europe/Berlin")
    assert [(m["month"], m["lastSeq"]) for m in berlin["months"]] == [("2026-10", head - 1), ("2026-11", head)]
    assert berlin["months"][1]["days"] == [{"day": "2026-11-01", "count": 1, "firstSeq": head,
                                            "lastSeq": head}]
    with pytest.raises(ValueError):
        await svc.history_months(graph_id=gid, tz="Mars/Olympus")

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_change_index_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning change index e2e: OK")


async def _run_ids_not_urns() -> None:
    """The canvas names a node by its urn, which an imported node's id is not: the compact form
    says each node's urn, and each edge's ends' urns, where they differ from the ids."""
    await models.create_schema_and_partitions()
    service_mod._CHANGE_INDEXES.clear()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]

    def imported(eid, urn, etype="Table"):
        return {"op": "create", "entity_kind": "node", "entity_id": eid,
                "payload": {"urn": urn, "entityType": etype, "displayName": eid}}
    await svc.apply_ops(graph_id=gid, actor="u", message="seed",
                        ops=[_n("urn:canvas:1"), imported("ent_1", "urn:x:1")])
    head = (await svc.get_graph(gid))["main_head_commit_seq"]
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", message="import", ops=[
        imported("ent_2", "urn:x:2", "Column"),
        _e("e1", "ent_1", "ent_2"),                               # both ends imported
        _e("e2", "urn:canvas:1", "ent_1", "LINEAGE"),            # one end each way
    ])
    try:
        compact = await svc.change_index_compact(graph_id=gid, origin=ChangeOrigin(branch_id=d),
                                                 containment_edge_types=CONT)
        rows = {e[0]: e for e in compact["entries"]}
        assert rows["ent_2"] == ["ent_2", "n", "a", "Column", "urn:x:2"]
        assert rows["e1"] == ["e1", "e", "a", "CONTAINS", "ent_1", "ent_2", "urn:x:1", "urn:x:2"]
        assert rows["e2"] == ["e2", "e", "a", "LINEAGE", "urn:canvas:1", "ent_1", "urn:canvas:1", "urn:x:1"]

        await svc.publish(graph_id=gid, branch_id=d, actor="u", message="go")
        to = (await svc.get_graph(gid))["main_head_commit_seq"]
        window = await svc.change_index_compact(graph_id=gid, origin=ChangeOrigin(from_seq=head, to_seq=to),
                                                containment_edge_types=CONT)
        rows = {e[0]: e for e in window["entries"]}
        assert rows["e1"][6:] == ["urn:x:1", "urn:x:2"] and rows["ent_2"][4:] == ["urn:x:2"]
        # A canvas node's id is its urn: nothing follows.
        await svc.apply_ops(graph_id=gid, actor="u", message="rename",
                            ops=[_u("urn:canvas:1", "renamed", "Table")])
        later = await svc.change_index_compact(
            graph_id=gid, origin=ChangeOrigin(from_seq=to, to_seq=to + 1), containment_edge_types=CONT)
        assert later["entries"] == [["urn:canvas:1", "n", "m", "Table"]]
    finally:
        service_mod._CHANGE_INDEXES.clear()
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_compact_form_names_nodes_and_ends_by_urn():
    asyncio.run(_run_ids_not_urns())


async def _run_batch_route() -> None:
    """``POST …/diff/entries/batch`` over the store: what the service answers, for a window and a
    draft; one origin and 1 to 500 ids, else 422; a draft the reader can't read, or a window past
    main's head, is not found."""
    from httpx import ASGITransport, AsyncClient

    from .test_api_graph_draft_journey import _build_app

    await models.create_schema_and_partitions()
    app, _graph_routes = _build_app()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_n("A"), _n("B")])
    await svc.apply_ops(graph_id=gid, actor="u", message="drop", ops=[_del("A")])
    head = (await svc.get_graph(gid))["main_head_commit_seq"]
    mine = await svc.open_draft(graph_id=gid, owner="u_test")            # the harness's reader
    await svc.apply_ops(graph_id=gid, branch_id=mine, actor="u_test", message="add", ops=[_n("C")])
    theirs = await svc.open_draft(graph_id=gid, owner="someone_else")
    url = f"/api/v1/ws1/versioning/graphs/{gid}/diff/entries/batch"
    ids = ["A", "B", "C", "nothing"]
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            for origin in (ChangeOrigin(from_seq=head - 1, to_seq=head), ChangeOrigin(branch_id=mine)):
                r = await c.post(url, json={**origin.as_dict(), "ids": ids})
                assert r.status_code == 200, r.text
                assert r.json() == await svc.change_entries_batch(graph_id=gid, origin=origin, entity_ids=ids)
                assert r.json()["entries"], origin
            for body in ({"branchId": mine, "ids": [f"n{i}" for i in range(501)]},
                         {"branchId": mine, "ids": []},
                         {"fromSeq": head - 1, "ids": ids}):
                assert (await c.post(url, json=body)).status_code == 422, body
            r = await c.post(url, json={"branchId": mine, "ids": [f"n{i}" for i in range(500)]})
            assert r.status_code == 200 and r.json() == {"entries": []}, r.text
            for body in ({"branchId": theirs, "ids": ids}, {"fromSeq": 0, "toSeq": head + 1, "ids": ids}):
                assert (await c.post(url, json=body)).status_code == 404, body
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_many_entries_open_at_once_over_the_route():
    asyncio.run(_run_batch_route())
