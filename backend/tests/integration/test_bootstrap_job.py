"""The async "enable version control" bootstrap job, end to end — needs Postgres.

The source graph is a fake FalkorDB client (the scan/backfill cypher is exercised by
the live E2E; here we pin the JOB's contract):

* the whole source lands as ONE ``import`` commit, in resumable windows;
* NOTHING is visible until the copy has been validated — a partial or failed job
  leaves the data source reading exactly as it did before;
* a crashed worker resumes from its last committed window and re-running a window
  writes no duplicates (deterministic version ids + ON CONFLICT DO NOTHING);
* the projection is FAST-FORWARDED, never reseeded (a reseed would drop the very
  graph we just copied);
* integrity failures (source changed mid-copy, untrackable items, dropped
  connections) fail the job with a plain-language reason and no visible damage;
* every job-row write is fenced on the worker's lease: a worker that lost the job
  (taken over, abandoned) rolls its window back;
* user actions touch only stopped jobs — a failed job is never re-run by enabling
  again, a live one is never retried — and restart and abandon run on the worker
  (the ``reset`` phase, a queued purge), never inside the request.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapConflict,
    BootstrapRunner,
    abandon_bootstrap,
    bootstrap_status,
    create_bootstrap_job,
    retry_bootstrap,
)
from backend.app.services.versioning.job_lease import Lease, Superseded
from backend.app.services.versioning.purge_worker import PurgeRunner
from backend.app.services.versioning.models import (
    CommitORM,
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
)
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService
from sqlalchemy import func, select


# --------------------------------------------------------------------------- #
# A fake FalkorDB graph: ID-addressed nodes/edges, answering the scan cypher.  #
# --------------------------------------------------------------------------- #
class FakeGraph:
    def __init__(self, nodes, edges):
        # nodes: [(labels, props)], edges: [(src_urn, tgt_urn, type, props)]
        self.nodes, self.edges = list(nodes), list(edges)
        self.writes = []

    # The reader (and therefore the copy) only sees urn-bearing entities — a node
    # without one never renders, searches or traces. The fake honours the same rule.
    def _visible_nodes(self):
        return [(lab, pr) for lab, pr in self.nodes if pr.get("urn")]

    def _visible_edges(self):
        urns = {pr.get("urn") for _, pr in self.nodes if pr.get("urn")}
        return [e for e in self.edges if e[0] in urns and e[1] in urns]

    async def query(self, cypher, params=None, timeout=None):
        p = params or {}
        lo, hi = p.get("lo", 0), p.get("hi", 10**9)
        if "max(ID(n))" in cypher:
            return _RS([[len(self.nodes) - 1 if self.nodes else None]])
        if "max(ID(r))" in cypher:
            return _RS([[len(self.edges) - 1 if self.edges else None]])
        if "count(n)" in cypher:
            invisible = "n.urn IS NULL" in cypher
            return _RS([[len(self.nodes) - len(self._visible_nodes()) if invisible
                         else len(self._visible_nodes())]])
        if "count(r)" in cypher:
            invisible = "IS NULL" in cypher
            return _RS([[len(self.edges) - len(self._visible_edges()) if invisible
                         else len(self._visible_edges())]])
        if cypher.startswith("UNWIND $urns"):
            urns = set(p.get("urns") or [])
            return _RS([[lab, pr] for lab, pr in self.nodes if pr.get("urn") in urns])
        if "SET n.entityId" in cypher or "SET r.id" in cypher:
            self.writes.append(cypher.split("SET")[1].strip()[:20])
            return _RS([])
        if cypher.startswith("MATCH (n) WHERE ID(n)"):
            return _RS([[lab, pr] for i, (lab, pr) in enumerate(self.nodes)
                        if lo <= i < hi and pr.get("urn")])
        if cypher.startswith("MATCH (a) WHERE ID(a)"):
            # Edges are anchored on their SOURCE node's id window (see _SCAN_EDGES) —
            # each edge is emitted exactly once, by the node it leaves.
            visible = {pr.get("urn") for _, pr in self._visible_nodes()}
            in_window = {pr.get("urn") for i, (_, pr) in enumerate(self.nodes)
                         if lo <= i < hi and pr.get("urn")}
            return _RS([[s, t, ty, pr] for (s, t, ty, pr) in self.edges
                        if s in in_window and t in visible])
        return _RS([])

    async def delete(self):                                    # a reseed would call this
        raise AssertionError("the projector must never DROP a bootstrapped source graph")


class DenseBandGraph(FakeGraph):
    """A graph whose edges are wildly uneven across the node-id space — like a real model,
    where ids cluster by entity type. The edge window must be sized by EDGES, not nodes."""

    def __init__(self, nodes, edges, dense_from, dense_to):
        super().__init__(nodes, edges)
        self.dense = range(dense_from, dense_to)
        self.max_edges_returned = 0

    async def query(self, cypher, params=None, timeout=None):
        p = params or {}
        lo, hi = p.get("lo", 0), p.get("hi", 10**9)
        # The count query the fitter uses (cheap; no properties).
        if "count(r)" in cypher and "ID(a) >= $lo" in cypher:
            n = sum(1 for i, (s, t, ty, pr) in enumerate(self.edges)
                    if lo <= self._src_idx(s) < hi)
            return _RS([[n]])
        res = await super().query(cypher, params, timeout)
        if cypher.startswith("MATCH (a) WHERE ID(a)") and "SET" not in cypher:
            self.max_edges_returned = max(self.max_edges_returned, len(res.result_set))
        return res

    def _src_idx(self, urn):
        for i, (_, pr) in enumerate(self.nodes):
            if pr.get("urn") == urn:
                return i
        return -1


class _RS:
    def __init__(self, rows):
        self.result_set = rows


def _node(urn, label="Table", **props):
    return ([label], {"urn": urn, "displayName": urn.split(":")[-1], "entityType": label, **props})


def _edge(src, tgt, etype="FLOWS_TO", **props):
    return (src, tgt, etype, props)


def _graph(nodes=6, edges=3):
    ns = [_node(f"urn:n{i}") for i in range(nodes)]
    es = [_edge(f"urn:n{i}", f"urn:n{i + 1}") for i in range(edges)]
    return FakeGraph(ns, es)


def _runner(fake, width=2):
    """A runner whose scan windows are deliberately tiny, so every test exercises the
    multi-window (resumable) path rather than a single lucky pass."""
    from backend.app.services.versioning import config
    config.BOOTSTRAP_SCAN_WIDTH = width
    config.BOOTSTRAP_WINDOW = width
    return BootstrapRunner(lambda name, provider_id=None: fake)


async def _enable(ds, ws="ws1", actor="alice"):
    return await create_bootstrap_job(
        data_source_id=ds, workspace_id=ws, actor=actor,
        falkor_graph_name=f"g_{ds}", falkor_provider="prov_1")


async def _take(job_id) -> Lease:
    """Claim THIS job as ``job_lease.claim`` would — a new epoch, running — and return its
    lease. (The test DB may hold other claimable jobs; the claim's order is not the subject.)"""
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.retry_count += 1
        job.status = "running"
        job.updated_at = models._now()
        return Lease(job_id=job.id, job_type=job.job_type, epoch=job.retry_count,
                     workspace_id=job.workspace_id, graph_id=job.graph_id)


async def _drive(runner, job_id):
    return await runner.run_job(await _take(job_id))


async def _conflict(coro) -> str:
    """The ``type`` of the 409 a user action is refused with."""
    with pytest.raises(BootstrapConflict) as err:
        await coro
    return err.value.detail["type"]


async def _counts(graph_id, commit_id):
    async with db.graphver_session() as s:
        n = await s.scalar(select(func.count()).select_from(NodeVersionORM).where(
            NodeVersionORM.graph_id == graph_id, NodeVersionORM.commit_id == commit_id))
        e = await s.scalar(select(func.count()).select_from(EdgeVersionORM).where(
            EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.commit_id == commit_id))
    return int(n), int(e)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    # ══ 0. the bootstrap worker must never touch the FILE-import worker's jobs ═
    # Both live in the same `jobs` table and a worker claims by job_type, so a shared
    # type would have each run the other's jobs through the wrong phase machine.
    from backend.app.services.versioning.bootstrap_worker import BOOTSTRAP_JOB_TYPE
    assert BOOTSTRAP_JOB_TYPE == "bootstrap" != "ingest"
    import_graph = "graph_import_" + os.urandom(4).hex()
    async with db.graphver_session() as s:
        job = JobORM(job_type="ingest", graph_id=import_graph, status="pending",
                     current_phase="parse")                   # a file import, mid-flight
        s.add(job)
        await s.flush()
        import_job_id = job.id
    # (This runs against the shared dev DB, so an unrelated bootstrap job may legitimately
    # be claimable — the invariant is that the FILE-IMPORT job is never one of them.)
    claimed = await BootstrapRunner(lambda name, provider_id=None: _graph()).claim_one()
    assert claimed is None or claimed.job_id != import_job_id, \
        "the bootstrap worker claimed a file-import job"
    if claimed is not None:
        await claimed.release()                               # not this test's to run
    async with db.graphver_session() as s:
        untouched = await s.get(JobORM, import_job_id)
        assert untouched.status == "pending" and untouched.current_phase == "parse", \
            "the file-import job was mutated by the bootstrap worker"

    # ══ A. happy path: one import commit, validated, head flipped last ═══════
    d = ds()
    fake = _graph(nodes=6, edges=3)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]

    # Before the worker runs: the graph exists but is INVISIBLE — head at genesis,
    # so the data source still reads exactly as it did (its live provider graph).
    async with db.graphver_session() as s:
        g = await s.get(GraphORM, gid)
        ps = await s.get(ProjectionStateORM, gid)
        assert g.main_head_commit_seq == 1
        # Parked watermark: a projector that thought it had work would DROP the source.
        assert ps.projected_commit_seq == 1 == ps.target_commit_seq
    st = await svc.materialize_state(graph_id=gid, branch_id=(await _main(gid)))
    assert st["nodes"] == {} and st["edges"] == {}, "a pending import must not be visible"

    out = await _drive(_runner(fake), job_id)
    assert out["status"] == "completed", out

    async with db.graphver_session() as s:
        g = await s.get(GraphORM, gid)
        ps = await s.get(ProjectionStateORM, gid)
        commit = (await s.execute(select(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.commit_seq == 2))).scalars().one()
        job = await s.get(JobORM, job_id)
    assert g.main_head_commit_seq == 2                     # visible only now
    assert commit.kind == "import" and commit.stats == {"nodes": 6, "edges": 3}
    assert commit.merkle_root, "small graphs get their integrity fingerprint inline"
    # Fast-forward, NOT a reseed: FakeGraph.delete() would have raised.
    assert ps.projected_commit_seq == 2 == ps.target_commit_seq and ps.status == "idle"
    assert fake.writes, "delete-anchoring keys are backfilled onto the source"

    st = await svc.materialize_state(graph_id=gid, branch_id=(await _main(gid)))
    assert len(st["nodes"]) == 6 and len(st["edges"]) == 3
    assert st["nodes"]["urn:n0"]["entityType"] == "Table"

    report = (job.summary or {}).get("report") or {}
    assert all(c["ok"] for c in report["checks"]), report
    assert report["stored"] == {"nodes": 6, "edges": 3}
    assert report["labels"] == {"Table": 6} and report["edgeTypes"] == {"FLOWS_TO": 3}
    assert report["merkle"] == "inline"
    assert job.provider_id == "prov_1", "the per-provider claim cap counts by it"
    status = await bootstrap_status(data_source_id=d)
    assert status["status"] == "completed" and status["percent"] == 100
    assert (status["origin"], status["attempt"], status["stale"], status["failure"],
            status["queuedAhead"]) == ("graph", 1, False, None, None)

    # Re-enqueueing an enabled source is a no-op.
    again = await _enable(d)
    assert again == {"graph_id": gid, "already_enabled": True}

    # ══ B. crash mid-copy → takeover resumes; no duplicate rows ══════════════
    d = ds()
    fake = _graph(nodes=6, edges=3)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]
    runner = _runner(fake)

    # Run only the counting + first two node windows, then "crash".
    first = await _take(job_id)
    await runner._phase_counting(first, gid)
    await _set_phase(job_id, "nodes")
    await runner._phase_nodes(first, gid)                   # window 1 (2 nodes)
    await runner._phase_nodes(first, gid)                   # window 2 (2 nodes)
    n_before, _ = await _counts(gid, await _commit_id(gid))
    assert n_before == 4, n_before
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        assert job.last_cursor == "nodes:4"

    # A second worker takes the (stale) job over: a new epoch. The first was only slow, and
    # writes its next window — fenced out, so it rolls back, rows and all.
    second = await _take(job_id)
    with pytest.raises(Superseded):
        await runner._phase_nodes(first, gid)
    n_zombie, _ = await _counts(gid, await _commit_id(gid))
    assert n_zombie == 4, "a superseded worker's window must roll back with its job-row write"
    async with db.graphver_session() as s:
        assert (await s.get(JobORM, job_id)).last_cursor == "nodes:4"

    # The new owner drives it to completion from the cursor.
    out = await BootstrapRunner(lambda name, provider_id=None: fake).run_job(second)
    assert out["status"] == "completed", out
    n, e = await _counts(gid, await _commit_id(gid))
    assert (n, e) == (6, 3), f"resume must not duplicate rows: {(n, e)}"

    # Replaying an already-written window is a no-op (deterministic ids).
    await _set_phase(job_id, "nodes", cursor="nodes:0")
    await runner._phase_nodes(await _take(job_id), gid)
    n2, _ = await _counts(gid, await _commit_id(gid))
    assert n2 == 6, "a replayed window must not duplicate rows"

    # ══ C. the source changed mid-copy → fail, and nothing is visible ════════
    d = ds()
    fake = _graph(nodes=6, edges=0)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]
    runner = _runner(fake)
    await runner._phase_counting(await _take(job_id), gid)  # counts 6 nodes
    fake.nodes.append(_node("urn:late"))                    # someone writes to the source
    await _set_phase(job_id, "nodes")
    out = await _drive(runner, job_id)
    assert out["status"] == "failed"
    assert "changed while we were copying" in out["error"], out
    async with db.graphver_session() as s:
        g = await s.get(GraphORM, gid)
        heads = await s.scalar(select(func.count()).select_from(models.EntityHeadORM).where(
            models.EntityHeadORM.graph_id == gid))
    assert g.main_head_commit_seq == 1, "a failed copy must never flip the head"
    assert heads == 0, "a failed copy must not publish any entity heads"
    st = await svc.materialize_state(graph_id=gid, branch_id=(await _main(gid)))
    assert st["nodes"] == {} and st["edges"] == {}

    # The failure says what the user can do: a copy that didn't match needs a fresh read.
    status = await bootstrap_status(data_source_id=d)
    assert status["status"] == "failed"
    assert {k: status["failure"][k] for k in ("code", "action", "phase")} == {
        "code": "integrity", "action": "restart", "phase": "validate"}, status["failure"]

    # Enabling again returns the failed job as it is — it is NOT quietly re-run.
    again = await _enable(d)
    assert (again["job_id"], again["status"]) == (job_id, "failed")
    assert again["failure"]["action"] == "restart"
    async with db.graphver_session() as s:
        assert (await s.get(JobORM, job_id)).status == "failed"

    # ...and resuming it would only fail the same check again.
    assert await _conflict(retry_bootstrap(data_source_id=d)) == "resume_not_possible"

    # ...and writing to a graph mid-enablement is refused.
    d2 = ds()
    r2 = await _enable(d2)
    with pytest.raises(ConcurrencyError):
        await svc.open_draft(graph_id=r2["graph_id"], owner="bob")

    # A job that hasn't stopped is never retried: re-queueing it would hand it to a second
    # worker while the first still runs it.
    for mode in ("resume", "restart"):
        assert await _conflict(retry_bootstrap(data_source_id=d2, mode=mode)) == "job_active"
    live = await _take(r2["job_id"])
    assert await _conflict(retry_bootstrap(data_source_id=d2, mode="restart")) == "job_active"
    await live.release()

    # Restart re-reads the source from scratch and now succeeds. The request only re-queues
    # the job at `reset`; the old copy is deleted on the worker, in windows.
    out = await retry_bootstrap(data_source_id=d, mode="restart")
    assert out["status"] == "pending"
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        assert (job.current_phase, job.last_cursor, job.summary) == ("reset", None,
                                                                    {"actor": "alice"})
    assert (await _counts(gid, await _commit_id(gid)))[0] == 7, \
        "the restart request itself must delete nothing"
    out = await _drive(BootstrapRunner(lambda name, provider_id=None: fake), out["jobId"])
    assert out["status"] == "completed", out
    n, _ = await _counts(gid, await _commit_id(gid))
    assert n == 7, "restart re-imports the CURRENT source (6 + the late node)"

    # ══ D. items the app can't see are skipped + REPORTED (never silent) ═════
    # A node with no identifier never renders, searches or traces — it isn't part of
    # the graph as far as this product is concerned, so copying it is meaningless.
    # It must still be counted and stated, which is what the old path failed to do.
    d = ds()
    invisible = FakeGraph(
        [_node("urn:a"), _node("urn:b"), (["SentinelMarker"], {"id": "left-over-test-node"})],
        [_edge("urn:a", "urn:b")],
    )
    res = await _enable(d)
    out = await _drive(_runner(invisible), res["job_id"])
    assert out["status"] == "completed", out
    status = await bootstrap_status(data_source_id=d)
    assert status["report"]["skippedWithoutIdentifier"] == {"nodes": 1, "edges": 0}
    n, e = await _counts(res["graph_id"], await _commit_id(res["graph_id"]))
    assert (n, e) == (2, 1)

    # ...but a connection between two REAL items whose endpoint never arrived is a
    # genuine inconsistency and must fail.
    d = ds()
    dangling = FakeGraph([_node("urn:a"), _node("urn:ghost")], [_edge("urn:a", "urn:ghost")])
    dangling._visible_nodes = lambda: [dangling.nodes[0]]      # the ghost vanishes mid-copy
    res = await _enable(d)
    out = await _drive(_runner(dangling), res["job_id"])
    assert out["status"] == "failed", out
    # Abandon puts the data source back exactly as it was: at once to every reader (the graph
    # is soft-deleted), and for good once the purge it queued has run on the worker.
    gone = await abandon_bootstrap(data_source_id=d, actor="alice")
    assert gone["status"] == "cancelled" and gone["purgeJobId"], gone
    assert await svc.get_graph_by_data_source(d) is None
    async with db.graphver_session() as s:
        assert (await s.get(GraphORM, res["graph_id"])).deleted_at is not None
        purge = await s.get(JobORM, gone["purgeJobId"])
        assert (purge.job_type, purge.status) == ("purge", "pending")
    # Abandoning again is a no-op returning the same purge; enabling again waits for it.
    assert (await abandon_bootstrap(data_source_id=d))["purgeJobId"] == gone["purgeJobId"]
    assert await _conflict(_enable(d)) == "cleanup_in_progress"
    # A purge that failed (an outage past its retry budget) is queued again by abandoning
    # again — the same job, carrying on, not a second one colliding with its key.
    assert await (await _take(gone["purgeJobId"])).fail("Postgres went away", "infrastructure",
                                                        "resume")
    assert (await abandon_bootstrap(data_source_id=d))["purgeJobId"] == gone["purgeJobId"]
    async with db.graphver_session() as s:
        purge = await s.get(JobORM, gone["purgeJobId"])
        assert (purge.status, purge.error_message, "failure" in purge.summary) == \
            ("pending", None, False)
    purged = await PurgeRunner(lambda name, provider_id=None: dangling).run_job(
        await _take(gone["purgeJobId"]))                     # (FakeGraph.delete would raise)
    assert purged["status"] == "completed", purged
    async with db.graphver_session() as s:
        assert await s.get(GraphORM, res["graph_id"]) is None
        for model in (NodeVersionORM, EdgeVersionORM, CommitORM):
            left = await s.scalar(select(func.count()).select_from(model).where(
                model.graph_id == res["graph_id"]))
            assert left == 0, f"the purge left {left} {model.__tablename__} row(s)"
    fresh = await _enable(d)
    assert fresh["status"] == "pending" and fresh["graph_id"] != res["graph_id"]

    # ══ D2. a FAILED copy must not leave the graph writable ══════════════════
    # This is the sharpest edge in the whole design: a half-imported graph has its
    # head parked at genesis and its projection watermark parked with it. A single
    # canvas edit would advance the head PAST the partial import commit, un-park the
    # watermark, and let the projector DROP the (pinned) source graph and reseed it
    # from a main holding a fraction of the entities — destroying the user's data.
    d = ds()
    broken = FakeGraph([_node("urn:a"), _node("urn:a", displayName="clash")], [])
    res = await _enable(d)
    out = await _drive(_runner(broken), res["job_id"])
    assert out["status"] == "failed"
    with pytest.raises(ConcurrencyError):
        await svc.open_draft(graph_id=res["graph_id"], owner="bob")
    with pytest.raises(ConcurrencyError):
        await svc.apply_ops(graph_id=res["graph_id"], actor="bob", message="edit", ops=[
            {"op": "create", "entity_kind": "node", "entity_id": "X", "payload": {"displayName": "X"}}])
    async with db.graphver_session() as s:
        g = await s.get(GraphORM, res["graph_id"])
        ps = await s.get(ProjectionStateORM, res["graph_id"])
        assert g.main_head_commit_seq == 1, "a failed copy must never advance the head"
        assert ps.projected_commit_seq == ps.target_commit_seq == 1, \
            "the projection watermark must stay parked (else the projector wipes the source)"

    # ══ D3. abandoning mid-copy fences the worker instead of racing it ═══════
    d = ds()
    fake = _graph(nodes=6, edges=3)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]
    runner = _runner(fake)
    lease = await _take(job_id)                              # the worker holds the claim
    await runner._phase_counting(lease, gid)
    await _set_phase(job_id, "nodes")
    await abandon_bootstrap(data_source_id=d)               # user gives up mid-copy
    with pytest.raises(Superseded):
        await runner._phase_nodes(lease, gid)               # the in-flight window aborts
    assert (await runner.run_job(lease))["status"] == "superseded", "and the driver stops"
    async with db.graphver_session() as s:
        assert (await s.get(GraphORM, gid)).deleted_at is not None
        orphans = await s.scalar(select(func.count()).select_from(NodeVersionORM).where(
            NodeVersionORM.graph_id == gid))
        assert orphans == 0, "the fenced worker must not write rows into an abandoned graph"

    # ══ D4. an edge window is sized by EDGES, not nodes ══════════════════════
    # Real models cluster node ids by entity type, so one node window can hold 15k edges
    # and the next 185k — enough to blow the graph server's per-query budget even at the
    # minimum node width (measured on a 5M-edge model; it killed a scale run). The window
    # must shrink on EDGE count, which is cheap to ask for.
    d = ds()
    ns = [_node(f"urn:n{i}") for i in range(8)]
    # Every node in the dense band (4..8) points at every node in 0..4 → 16 edges there,
    # while nodes 0..4 have one edge each. A uniform node window would return them all.
    es = [_edge(f"urn:n{i}", f"urn:n{i + 1}") for i in range(4)]
    es += [_edge(f"urn:n{i}", f"urn:n{j}", etype="FANS_TO") for i in range(4, 8) for j in range(4)]
    dense = DenseBandGraph(ns, es, 4, 8)
    from backend.app.services.versioning import config as _cfg
    _cfg.BOOTSTRAP_EDGE_TARGET = 6                         # tiny target so the fitter must act
    res = await _enable(d)
    out = await _drive(_runner(dense, width=8), res["job_id"])
    _cfg.BOOTSTRAP_EDGE_TARGET = 50_000
    assert out["status"] == "completed", out
    assert dense.max_edges_returned <= 8, (
        f"a window returned {dense.max_edges_returned} edges against a target of 6 — "
        "the window was sized by nodes, not edges")
    _, e = await _counts(res["graph_id"], await _commit_id(res["graph_id"]))
    assert e == len(es), f"every edge must still be copied exactly once (got {e}/{len(es)})"

    # ══ E. duplicate identifiers fail; parallel connections merge + report ═══
    d = ds()
    dupes = FakeGraph([_node("urn:a"), _node("urn:a", displayName="clash")], [])
    res = await _enable(d)
    out = await _drive(_runner(dupes), res["job_id"])
    assert out["status"] == "failed" and "share an identifier" in out["error"], out
    assert await _conflict(retry_bootstrap(data_source_id=d)) == "resume_not_possible"

    d = ds()
    parallel = FakeGraph(
        [_node("urn:a"), _node("urn:b")],
        [_edge("urn:a", "urn:b"), _edge("urn:a", "urn:b")],   # indistinguishable duplicates
    )
    res = await _enable(d)
    out = await _drive(_runner(parallel), res["job_id"])
    assert out["status"] == "completed", out
    status = await bootstrap_status(data_source_id=d)
    assert status["report"]["mergedDuplicateConnections"] == 1
    _, e = await _counts(res["graph_id"], await _commit_id(res["graph_id"]))
    assert e == 1, "the read layer merges these too — one stored connection"

    # ══ F. concurrent "enable" calls create ONE graph and ONE job ════════════
    # Two clicks, two tabs: every caller but the winner of the uq_graphs_data_source race
    # gets the winner's job back — not a 500.
    d = ds()
    outs = await asyncio.gather(*[_enable(d) for _ in range(4)])
    assert len({o["graph_id"] for o in outs}) == 1 and len({o["job_id"] for o in outs}) == 1, outs
    status = await bootstrap_status(data_source_id=d)
    assert status["status"] == "pending" and isinstance(status["queuedAhead"], int)

    await db.dispose_engine()


async def _main(graph_id: str) -> str:
    async with db.graphver_session() as s:
        return (await s.execute(select(models.BranchORM.id).where(
            models.BranchORM.graph_id == graph_id,
            models.BranchORM.kind == "main"))).scalars().one()


async def _commit_id(graph_id: str) -> str:
    async with db.graphver_session() as s:
        return (await s.execute(select(CommitORM.id).where(
            CommitORM.graph_id == graph_id, CommitORM.commit_seq == 2))).scalars().one()


async def _set_phase(job_id: str, phase: str, cursor=None) -> None:
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.current_phase = phase
        job.last_cursor = cursor


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_bootstrap_job_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("bootstrap job e2e: OK")
