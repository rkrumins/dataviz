"""No whole-graph read on the everyday paths — needs Postgres.

On a graph of millions of entities, reading its whole state (``_state_as_of``, ``_composed_state``)
loads every entity's payload: gigabytes, in the web process, for one request. A person's save, pull
latest, publish preview, review (open, preview, diff, summary, merge), publish, revert and restore
need only the entities their change touches, and the incident edges and edge ends the cascade and
integrity checks reason about. Each path here runs with the whole-graph reads refused, on a graph
with a baseline none of them touch, and must still give the right answer.
"""
import asyncio
import contextlib
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

N = 120          # baseline nodes; edges N0->N1 … N59->N60; S contains N0 … N9
CONT = ["CONTAINS"]


def _node(eid, name=None):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": name or f"{eid} name", "entityType": "Dataset"}}


def _upd(eid, name):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": name, "entityType": "Dataset"}}


def _edge(eid, src, tgt, etype="FLOWS_TO"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


@contextlib.contextmanager
def _whole_graph_reads_refused():
    """Every read of a branch's whole state raises, naming the path that asked for it."""
    names = ("_state_as_of", "_composed_state", "_composed_state_as_of", "_merkle_root")
    saved = {n: getattr(GraphVersioningService, n) for n in names}

    def refuse(name):
        async def _refused(self, s, graph_id, *a, **k):
            raise AssertionError(f"{name} read the whole of graph {graph_id}")
        return _refused

    for n in names:
        setattr(GraphVersioningService, n, refuse(n))
    try:
        yield
    finally:
        for n, f in saved.items():
            setattr(GraphVersioningService, n, f)


async def _draft(svc, gid, owner, ops):
    d = await svc.open_draft(graph_id=gid, owner=owner)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=owner, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=owner, containment_edge_types=CONT)
    return d


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice")
    gid, main = G["graph_id"], G["main_branch_id"]
    base = await _draft(svc, gid, "alice", [_node(f"N{i}") for i in range(N)] + [_node("S")]
                        + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(60)]
                        + [_edge(f"C{i}", "S", f"N{i}", "CONTAINS") for i in range(10)])
    baseline = await svc.publish(graph_id=gid, branch_id=base, actor="alice", message="baseline",
                                 containment_edge_types=CONT)

    with _whole_graph_reads_refused():
        # A save: the fold reads the touched entities' values, not the graph's.
        a = await _draft(svc, gid, "alice", [_upd("N1", "one"), _node("X"), _edge("EX", "X", "N2")])
        # Someone else publishes meanwhile, so alice's draft is behind.
        b = await _draft(svc, gid, "bob", [_upd("N100", "hundred"), _del("N119")])
        await svc.publish(graph_id=gid, branch_id=b, actor="bob", message="bob's",
                          containment_edge_types=CONT)

        # The publish dialog's preview, then pull latest.
        pv = await svc.preview_merge(graph_id=gid, branch_id=a)
        assert pv["clean"] and pv["changes"] == {"create": 2, "update": 1, "delete": 0}, pv
        pulled = await svc.rebase_draft(graph_id=gid, branch_id=a, actor="alice")
        assert pulled["clean"] and pulled["incoming"]["commit_count"] == 1, pulled

        # A review: open, preview, the diff and its summary, then merge.
        mr = await svc.open_draft_mr(graph_id=gid, branch_id=a, actor="alice")
        assert (await svc.preview_mr(mr_id=mr))["clean"]
        diff = await svc.diff_pr(pr_id=mr)
        assert {e["entityId"] for e in diff["added"]} == {"X", "EX"}, diff
        assert {e["entityId"] for e in diff["modified"]} == {"N1"}, diff
        summary = await svc.diff_pr_summary(pr_id=mr, containment_edge_types=CONT)
        assert summary["counts"] == {"added": 2, "modified": 1, "removed": 0}, summary
        assert {g["label"] for g in summary["groups"]} >= {"X name → N2 name"}, summary
        # N1's change nests under its container, which the change didn't touch.
        assert [g["counts"] for g in summary["groups"] if g["key"] == "S"] == [
            {"added": 0, "modified": 1, "removed": 0}], summary
        merged = await svc.merge_mr(mr_id=mr, actor="carol", message="alice's",
                                    containment_edge_types=CONT)

        # A delete that takes the edges on it, previewed, then published.
        c = await _draft(svc, gid, "carol", [_del("N5")])
        pv = await svc.preview_merge(graph_id=gid, branch_id=c)
        assert pv["clean"], pv
        await svc.publish(graph_id=gid, branch_id=c, actor="carol", message="drop N5",
                          containment_edge_types=CONT)

        # Undo one commit, and roll everything back to the baseline.
        await svc.revert_commit(graph_id=gid, commit_id=merged, actor="carol")
        rp = await svc.restore_preview(graph_id=gid, commit_id=baseline)
        assert rp["nodes"]["create"] == 2 and rp["edges"]["create"] == 3, rp   # N5, N119; E4, E5, C5
        await svc.restore_to_commit(graph_id=gid, commit_id=baseline, actor="carol")

    async with db.graphver_session() as s:
        now = await svc._current_values(s, gid, main, ["N1", "X", "N5", "E4", "E5", "N100", "N119"])
    assert now["N1"]["displayName"] == "N1 name" and now.get("X") is None, now
    assert now["N5"] is not None and now["E4"] is not None and now["E5"] is not None, now
    assert now["N100"]["displayName"] == "N100 name" and now["N119"] is not None, now
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_everyday_paths_never_read_the_whole_graph():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning bounded reads e2e: OK")
