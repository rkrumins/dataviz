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
  connections) fail the job with a plain-language reason and no visible damage.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapRunner,
    BootstrapSuperseded,
    abandon_bootstrap,
    bootstrap_status,
    create_bootstrap_job,
    retry_bootstrap,
)
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


async def _drive(runner, job_id):
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        job.status = "running"
    return await runner.run_job(job_id)


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
        s.add(JobORM(job_type="ingest", graph_id=import_graph, status="pending",
                     current_phase="parse"))                  # a file import, mid-flight
    claimed = await BootstrapRunner(lambda name, provider_id=None: _graph()).claim_one()
    assert claimed is None, "the bootstrap worker claimed a file-import job"
    async with db.graphver_session() as s:
        untouched = (await s.execute(select(JobORM).where(
            JobORM.graph_id == import_graph))).scalars().one()
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
    status = await bootstrap_status(data_source_id=d)
    assert status["status"] == "completed" and status["percent"] == 100

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
    await runner._phase_counting(job_id, gid)
    await _set_phase(job_id, "nodes")
    await runner._phase_nodes(job_id, gid)                  # window 1 (2 nodes)
    await runner._phase_nodes(job_id, gid)                  # window 2 (2 nodes)
    n_before, _ = await _counts(gid, await _commit_id(gid))
    assert n_before == 4, n_before
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        assert job.last_cursor == "nodes:4"

    # A second worker takes over the (stale) job and drives it to completion.
    out = await _drive(BootstrapRunner(lambda name, provider_id=None: fake), job_id)
    assert out["status"] == "completed", out
    n, e = await _counts(gid, await _commit_id(gid))
    assert (n, e) == (6, 3), f"resume must not duplicate rows: {(n, e)}"

    # Replaying an already-written window is a no-op (deterministic ids).
    await _set_phase(job_id, "nodes", cursor="nodes:0")
    await runner._phase_nodes(job_id, gid)
    n2, _ = await _counts(gid, await _commit_id(gid))
    assert n2 == 6, "a replayed window must not duplicate rows"

    # ══ C. the source changed mid-copy → fail, and nothing is visible ════════
    d = ds()
    fake = _graph(nodes=6, edges=0)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]
    runner = _runner(fake)
    await runner._phase_counting(job_id, gid)               # counts 6 nodes
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

    # ...and writing to a graph mid-enablement is refused.
    d2 = ds()
    r2 = await _enable(d2)
    with pytest.raises(ConcurrencyError):
        await svc.open_draft(graph_id=r2["graph_id"], owner="bob")

    # Restart re-reads the source from scratch and now succeeds.
    out = await retry_bootstrap(data_source_id=d, mode="restart")
    assert out["status"] == "pending"
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
    # Abandon puts the data source back exactly as it was.
    await abandon_bootstrap(data_source_id=d)
    async with db.graphver_session() as s:
        assert await s.get(GraphORM, res["graph_id"]) is None
    assert await svc.get_graph_by_data_source(d) is None

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
    await runner._phase_counting(job_id, gid)
    await _set_phase(job_id, "nodes")
    async with db.graphver_session() as s:                  # the worker holds the claim
        job = await s.get(JobORM, job_id)
        job.status = "running"
    runner._epoch[job_id] = 0
    await abandon_bootstrap(data_source_id=d)               # user gives up mid-copy
    with pytest.raises(BootstrapSuperseded):
        await runner._phase_nodes(job_id, gid)              # the in-flight window aborts
    async with db.graphver_session() as s:
        assert await s.get(GraphORM, gid) is None
        orphans = await s.scalar(select(func.count()).select_from(NodeVersionORM).where(
            NodeVersionORM.graph_id == gid))
        assert orphans == 0, "the fenced worker must not write rows into a deleted graph"

    # ══ E. duplicate identifiers fail; parallel connections merge + report ═══
    d = ds()
    dupes = FakeGraph([_node("urn:a"), _node("urn:a", displayName="clash")], [])
    res = await _enable(d)
    out = await _drive(_runner(dupes), res["job_id"])
    assert out["status"] == "failed" and "share an identifier" in out["error"], out

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
