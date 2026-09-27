"""A property operation, run as a job against a real draft (Postgres).

The job finds what the search matches on the published graph — narrowed by the operation's
precondition, then the draft's own changed nodes re-checked against the search alone — and
writes the change into the draft a window at a time, each window one commit, every entity
decided on its draft value. It refuses up front when it would take the draft past its cap, stops
between windows when asked or when the draft is gone, skips what the ontology refuses, and waits
while the published graph catches up. The search here is scripted over main's real state
(``search_semantics.evaluate``); ``test_property_ops_live.py`` runs it on FalkorDB.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning import property_ops as ops_mod
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.property_ops import OpContext, PropertyOpRunning, PublishRunning
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation
from backend.app.services.deep_search import SearchRunContext
from backend.app.providers.falkordb_search.scan import ScanResult
from backend.common.models.search import SearchQuery


def _node(i, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": f"N{i}",
            "payload": {"urn": f"urn:N{i}", "entityType": "Dataset", "displayName": f"N{i}",
                        "properties": props}}


def _update(eid, **props):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": {"properties": props}}


class _Search:
    """The published graph's search, scripted over main's state."""

    def __init__(self, svc, gid):
        self.svc, self.gid, self.scans, self.membership_calls = svc, gid, [], []

    async def _main(self):
        main = await self.svc.main_branch_id(self.gid)
        return {n["urn"]: n for n in (await self.svc.materialize_state(
            graph_id=self.gid, branch_id=main))["nodes"].values()}

    @staticmethod
    def _holds(p, node):
        from backend.common.search_semantics import evaluate, resolve_predicate
        if p.kind == "all":
            return True
        if p.kind == "group":
            answers = [_Search._holds(c, node) for c in p.children]
            return {"and": all, "or": any}[p.op](answers) if p.op != "not" else not answers[0]
        props = node.get("properties") or {}
        if p.kind == "hasProperty":
            return (p.key in props) != p.negate
        return evaluate(props.get(p.key), resolve_predicate(p))

    async def deep_search_scan(self, query, *, context, cap):
        self.scans.append(query.predicate)
        urns = [u for u, n in (await self._main()).items() if self._holds(query.predicate, n)]
        return ScanResult(urns[:cap + 1], len(urns) > cap)

    async def deep_search_membership(self, scope, items, urns, *, context):
        self.membership_calls.append(list(urns))
        main = await self._main()
        return {"matches": {item: [u for u in urns if u in main and self._holds(p, main[u])]
                            for item, p in items}, "errors": {}}


def _query(predicate=None):
    return SearchQuery.model_validate({"predicate": predicate or {"kind": "all"},
                                       "scope": {"viewId": "v", "scopeMode": "view"}})


async def _setup(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[
        _node(i, **({"owner": "bob"} if i % 2 == 0 else {})) for i in range(25)])
    return gid


async def _props(svc, gid, branch_id):
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=branch_id))["nodes"]
    return {eid: n.get("properties") or {} for eid, n in nodes.items()}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = await _setup(svc)
    search = _Search(svc, gid)
    written = []
    waits = {"left": 2}

    async def context(job):
        if waits["left"]:
            waits["left"] -= 1              # the published graph is catching up
            return None

        async def on_written():
            written.append(job["branchId"])

        return OpContext(provider=search, run_context=SearchRunContext(data_version="1"),
                         containment_edge_types=["CONTAINS"], ontology_rules=None,
                         on_written=on_written)

    ie = ImportExportService(versioning=svc, property_op_context=context)
    ops = ie.property_ops

    async def create(draft, op, predicate=None, **kw):
        return await ops.create(workspace_id="ws1", data_source_id="ds1", graph_id=gid, branch_id=draft,
                                view_id="v", actor="alice", op=op, query=_query(predicate),
                                scope_hash="h", **kw)

    # ── A set across every match, a window at a time, decided on the draft's value ──
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
        {"op": "delete", "entity_kind": "node", "entity_id": "N3"}])
    job_id = await create(draft, {"kind": "set", "key": "reviewed", "value": True}, expected_count=25)
    job = await ops.get(job_id)
    assert job["status"] == "pending" and job["kind"] == "apply" and job["expectedCount"] == 25, job
    summary = await ops.run(job_id)
    job = await ops.get(job_id)
    assert job["status"] == "completed" and job["processed"] == 25 and job["total"] == 25, job
    assert job["percent"] == 100 and waits["left"] == 0
    assert summary["matched"] == 25 and summary["applied"] == 24 and summary["notInDraft"] == 1, summary
    assert len(summary["commits"]) == 3 and summary["draftChangesBefore"] == 1, summary
    props = await _props(svc, gid, draft)
    assert "N3" not in props and all(p["reviewed"] is True for p in props.values())
    log = await svc.commit_log(graph_id=gid, branch_id=draft)
    assert [c["message"] for c in log[:3]] == [f"Set reviewed = true · part {i} of 3" for i in (3, 2, 1)]
    assert written, "the draft's reads were refreshed"
    assert search.membership_calls == [], "a set is not narrowed, so nothing is re-checked"

    # ── Fill empty: narrowed to isEmpty on the published graph, the draft's own edits re-checked ──
    draft2 = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft2, actor="alice", ops=[
        _update("N0", owner=""),                        # blank in the draft, "bob" on main
        _update("N1", owner="dave")])                   # set in the draft, missing on main
    job_id = await create(draft2, {"kind": "fillEmpty", "key": "owner", "value": "erin"})
    summary = await ops.run(job_id)
    props = await _props(svc, gid, draft2)
    assert props["N0"]["owner"] == "erin", "found by the re-check of the draft's changed nodes"
    assert props["N1"]["owner"] == "dave", "decided on the draft's value"
    assert all(props[f"N{i}"]["owner"] == ("bob" if i % 2 == 0 else "erin")
               for i in range(2, 25)), props
    assert summary["applied"] == 12 and summary["unchanged"] == 1, summary
    assert search.scans[-1].kind == "group" and search.membership_calls, "narrowed, then re-checked"

    # ── Past the cap: refused before anything is written ──
    draft3 = await svc.open_draft(graph_id=gid, owner="alice")
    before = await svc.branch_change_count(graph_id=gid, branch_id=draft3)
    config.PROPERTY_OP_MAX_DRAFT_CHANGES = 10
    try:
        capped = await create(draft3, {"kind": "set", "key": "x", "value": 1})
        await ops.run(capped)
    finally:
        config.PROPERTY_OP_MAX_DRAFT_CHANGES = 100_000
    job = await ops.get(capped)
    assert job["status"] == "failed" and "10" in job["error"], job
    assert await svc.branch_change_count(graph_id=gid, branch_id=draft3) == before

    # ── One op at a time on a draft, and never beside a publish in flight ──
    first = await create(draft3, {"kind": "remove", "key": "owner"})
    with pytest.raises(PropertyOpRunning):
        await create(draft3, {"kind": "remove", "key": "owner"})
    await ops.cancel(first)
    assert (await ops.get(first))["status"] == "cancelled", "a pending op stops at once"
    await ie.create_publish_job(workspace_id="ws1", data_source_id="ds1", graph_id=gid, branch_id=draft3,
                                actor="alice", message="m")
    with pytest.raises(PublishRunning):
        await create(draft3, {"kind": "remove", "key": "owner"})
    assert [o["jobId"] for o in await ops.list(graph_id=gid, branch_id=draft3)] == [first, capped]

    # ── A publish job queued as an operation started refuses when it runs ──
    draft9 = await svc.open_draft(graph_id=gid, owner="alice")
    writing = await create(draft9, {"kind": "remove", "key": "owner"})
    queued = (await ie.create_publish_job(workspace_id="ws1", data_source_id="ds1", graph_id=gid,
                                          branch_id=draft9, actor="alice", message="m"))["job_id"]
    result = await ie.run_publish(queued)
    assert result["error"]["status"] == 409 and result["error"]["detail"]["jobId"] == writing, result
    assert (await ie.get_job(queued))["status"] == "failed"
    await ops.cancel(writing)

    # ── A job that died with its process holds the draft no longer ──
    draft7 = await svc.open_draft(graph_id=gid, owner="alice")
    dead = await create(draft7, {"kind": "remove", "key": "owner"})
    async with db.graphver_session() as s:
        row = await s.get(models.JobORM, dead)
        row.status, row.updated_at = "running", "2026-01-01T00:00:00+00:00"
    await create(draft7, {"kind": "remove", "key": "owner"})
    assert (await ops.get(dead))["status"] == "failed"

    # ── Stop between windows: what was written stays ──
    draft4 = await svc.open_draft(graph_id=gid, owner="alice")
    job_id = await create(draft4, {"kind": "set", "key": "stop", "value": 1})
    real_apply = svc.apply_ops

    async def then_stop(**kw):
        out = await real_apply(**kw)
        await ops.cancel(job_id)
        return out

    svc.apply_ops = then_stop
    try:
        summary = await ops.run(job_id)
    finally:
        svc.apply_ops = real_apply
    job = await ops.get(job_id)
    assert job["status"] == "cancelled" and summary["applied"] == 10 and len(summary["commits"]) == 1, job

    # ── The draft published or discarded under the op: it stops there ──
    draft5 = await svc.open_draft(graph_id=gid, owner="alice")
    job_id = await create(draft5, {"kind": "set", "key": "gone", "value": 1})

    async def then_discard(**kw):
        out = await real_apply(**kw)
        await svc.abandon_draft(graph_id=gid, branch_id=draft5, actor="alice")
        return out

    svc.apply_ops = then_discard
    try:
        await ops.run(job_id)
    finally:
        svc.apply_ops = real_apply
    job = await ops.get(job_id)
    assert job["status"] == "failed" and "discarded" in job["error"] and len(job["summary"]["commits"]) == 1, job

    # …and discarded as a window was about to be written: the window is refused, and says why.
    draft8 = await svc.open_draft(graph_id=gid, owner="alice")
    job_id = await create(draft8, {"kind": "set", "key": "gone", "value": 1})
    calls = {"n": 0}

    async def discard_first(**kw):
        calls["n"] += 1
        if calls["n"] == 2:
            await svc.abandon_draft(graph_id=gid, branch_id=draft8, actor="alice")
        return await real_apply(**kw)

    svc.apply_ops = discard_first
    try:
        await ops.run(job_id)
    finally:
        svc.apply_ops = real_apply
    job = await ops.get(job_id)
    assert job["status"] == "failed" and "discarded" in job["error"] and len(job["summary"]["commits"]) == 1, job

    # ── What the ontology refuses is skipped, and the window written without it ──
    draft6 = await svc.open_draft(graph_id=gid, owner="alice")
    job_id = await create(draft6, {"kind": "set", "key": "ok", "value": 1}, predicate={
        "kind": "property", "key": "owner", "op": "eq", "value": "bob"})

    async def refuse_n4(**kw):
        if any(o["entity_id"] == "N4" for o in kw["ops"]):
            raise OntologyViolation([{"entity_id": "N4", "kind": "node", "reason": "no"}])
        return await real_apply(**kw)

    svc.apply_ops = refuse_n4
    try:
        summary = await ops.run(job_id)
    finally:
        svc.apply_ops = real_apply
    assert summary["skipped"]["ontology"] == 1 and summary["applied"] == 12, summary
    props = await _props(svc, gid, draft6)
    assert "ok" not in props["N4"] and props["N6"]["ok"] == 1

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_property_operation_is_written_into_the_draft_a_window_at_a_time(monkeypatch):
    monkeypatch.setattr(config, "PROPERTY_OP_WINDOW", 10, raising=False)
    monkeypatch.setattr(ops_mod, "_WAIT_POLL_S", 0.01, raising=False)
    asyncio.run(_run())
