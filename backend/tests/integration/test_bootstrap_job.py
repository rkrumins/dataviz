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
  (the ``reset`` phase, a queued purge), never inside the request;
* duplicate identifiers are found by the pre-flight BEFORE anything is copied: the job
  pauses with the ranked list (pages and CSV), a decision must carry the list's
  fingerprint, the copy keeps one copy per urn and re-checks a source that changed while
  it waited, and the source graph is collapsed the same way (E1–E14; the real cypher runs
  against a live FalkorDB in ``test_bootstrap_falkor_live.py``).
"""
import asyncio
import os
import re

import pytest

from backend.app.services.versioning import db, job_lease, models
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapConflict,
    BootstrapRunner,
    abandon_bootstrap,
    bootstrap_status,
    create_bootstrap_job,
    decide_duplicates,
    duplicate_page,
    duplicates_csv,
    retry_bootstrap,
)
from backend.app.services.versioning.job_lease import Lease, Superseded
from backend.app.services.versioning.purge_worker import PurgeRunner
from backend.app.services.versioning.models import (
    BootstrapNodeORM,
    CommitORM,
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
)
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService
from sqlalchemy import func, select, text


# --------------------------------------------------------------------------- #
# A fake FalkorDB graph: ID-addressed nodes/edges, answering the job's cypher. #
# --------------------------------------------------------------------------- #
class FakeGraph:
    """A node's internal id is its index in ``nodes`` (None = deleted, its id free to re-use). An
    edge is (source, target, type, props); an end is a node's id, or a urn standing for the first
    node holding it. ``hidden`` ids are left out of the copy's node scan — gone mid-copy."""

    def __init__(self, nodes, edges):
        self.nodes, self.edges = list(nodes), list(edges)
        self.writes = []
        self.hidden = set()
        self.indexed = set()

    # -- the graph, as the job's statements see it ------------------------------------------
    def _id(self, end):
        if isinstance(end, int):
            return end if end < len(self.nodes) and self.nodes[end] is not None else None
        return next((i for i, n in enumerate(self.nodes) if n and n[1].get("urn") == end), None)

    def _urn(self, i):
        return self.nodes[i][1].get("urn") if i is not None and self.nodes[i] else None

    def _resolved(self):
        """(source id, target id, type, props, index in `edges`) of every edge whose ends exist."""
        out = []
        for k, (s, t, ty, pr) in enumerate(self.edges):
            si, ti = self._id(s), self._id(t)
            if si is not None and ti is not None:
                out.append((si, ti, ty, pr, k))
        return out

    def _present(self):
        return [(i, n) for i, n in enumerate(self.nodes) if n is not None]

    @staticmethod
    def _label(cypher, var):
        m = re.search(r"\(" + var + r":`((?:[^`]|``)+)`", cypher)
        return m.group(1).replace("``", "`") if m else None

    async def query(self, cypher, params=None, timeout=None):
        p = params or {}
        lo, hi = p.get("lo", 0), p.get("hi", 10**9)
        if "max(ID(n))" in cypher:
            ids = [i for i, _ in self._present()]
            return _RS([[max(ids) if ids else None]])
        if cypher.startswith("CREATE INDEX"):
            self.indexed.add(re.search(r"\(n:(\w+)\)", cypher).group(1))
            return _RS([])
        if cypher.startswith("CALL db.indexes()"):
            return _RS([[lab, ["urn"], "OPERATIONAL"] for lab in sorted(self.indexed)])
        if cypher.startswith("UNWIND $rows"):                         # the collapse
            return _RS(self._collapse(cypher, p.get("rows") or []))
        if "SET n.entityId" in cypher:
            self.writes.append("n.entityId")
            return _RS([])
        if "SET r.id" in cypher:
            self.writes.append("r.id")
            for si, ti, ty, pr, _k in self._resolved():
                if lo <= si < hi and self._urn(si) and self._urn(ti) and not pr.get("id"):
                    pr["id"] = f"{self._urn(si)}|{ty}|{self._urn(ti)}"
            return _RS([])
        if "RETURN count(n)" in cypher:                               # the source's urn nodes
            return _RS([[sum(1 for _, (lab, pr) in self._present() if pr.get("urn"))]])
        if "n.lastSyncedAt" in cypher:                                # the pre-flight's read
            return _RS([[i, lab, pr.get("urn"), pr.get("lastSyncedAt")]
                        for i, (lab, pr) in self._present() if lo <= i < hi])
        if "AND b.urn <> '', count(r)" in cypher:
            seen = {True: 0, False: 0}
            for si, ti, _ty, _pr, _k in self._resolved():
                if lo <= si < hi:
                    seen[bool(self._urn(si) and self._urn(ti))] += 1
            return _RS([[flag, n] for flag, n in seen.items() if n])
        if "RETURN count(r)" in cypher:                               # a window's edges
            unkeyed = "r.id IS NULL" in cypher
            return _RS([[sum(1 for si, _ti, _ty, pr, _k in self._resolved()
                             if lo <= si < hi and not (unkeyed and pr.get("id")))]])
        if cypher.startswith("UNWIND $urns"):                         # the sample re-read
            label, urns = self._label(cypher, "n"), set(p.get("urns") or [])
            return _RS([[i, lab, pr] for i, (lab, pr) in self._present()
                        if pr.get("urn") in urns and (label is None or label in lab)])
        if cypher.startswith("MATCH (n) WHERE ID(n)"):                # the copy's node scan
            return _RS([[i, lab, pr] for i, (lab, pr) in self._present()
                        if lo <= i < hi and pr.get("urn") and i not in self.hidden])
        if cypher.startswith("MATCH (a) WHERE ID(a)"):                # the copy's edge scan
            # Edges are anchored on their SOURCE node's id window (see _SCAN_EDGES) —
            # each edge is emitted exactly once, by the node it leaves.
            return _RS([[si, ti, self._urn(si), self._urn(ti), ty, pr]
                        for si, ti, ty, pr, _k in self._resolved()
                        if lo <= si < hi and self._urn(si) and self._urn(ti)])
        return _RS([])

    def _copy(self, cypher, var, row, id_key):
        """The node a collapse statement names: by label + urn, then id (else None)."""
        i = row[id_key]
        node = self.nodes[i] if i < len(self.nodes) else None
        label = self._label(cypher, var)
        if node is None or node[1].get("urn") != row["urn"] or (label and label not in node[0]):
            return None
        return i

    def _collapse(self, cypher, rows):
        """`backfill:dupes`, as FalkorDB would run it."""
        if "DETACH DELETE l" in cypher:
            gone = [i for row in rows if (i := self._copy(cypher, "l", row, "lid")) is not None]
            for i in gone:
                self.nodes[i] = None
            self.edges = [e for e in self.edges if self._id(e[0]) is not None
                          and self._id(e[1]) is not None]
            return [[len(gone)]]
        if "RETURN ID(l), ID(o), type(r), r.id IS NULL" in cypher:
            out_dir = "(l)-[r]->(o)" in cypher
            res = []
            for row in rows:
                li = self._copy(cypher, "l", row, "lid")
                for si, ti, ty, pr, _k in self._resolved() if li is not None else ():
                    if (si if out_dir else ti) == li:
                        res.append([li, ti if out_dir else si, ty, not pr.get("id")])
            return res
        rtype = re.search(r"\[r:`([^`]+)`\]", cypher).group(1)
        n = 0
        for row in rows:
            li, wi = self._copy(cypher, "l", row, "lid"), self._copy(cypher, "w", row, "wid")
            if li is None or wi is None:
                continue
            for si, ti, ty, pr, _k in list(self._resolved()):
                if ty != rtype:
                    continue
                if "(l)-[r:" in cypher and "]->(l)" in cypher:            # a genuine self-loop
                    if si == ti == li:
                        n += self._merge(wi, wi, ty, pr, keyed=True)
                    continue
                out_dir = "(l)-[r:" in cypher
                if (si if out_dir else ti) != li:
                    continue
                other = ti if out_dir else si
                keyed = bool(pr.get("id"))
                if keyed != ("r.id IS NOT NULL" in cypher) or self._urn(other) == row["urn"]:
                    continue
                n += self._merge(*((wi, other) if out_dir else (other, wi)), ty, pr, keyed=keyed)
        return [[n]]

    def _merge(self, s, t, ty, props, *, keyed):
        for es, et, ety, epr, _k in self._resolved():
            if (es, et, ety) == (s, t, ty) and (not keyed or epr.get("id") == props.get("id")):
                return 1
        self.edges.append((s, t, ty, dict(props)))
        return 1

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
        if cypher.endswith("RETURN count(r)") and "ID(a) >= $lo" in cypher and "SET" not in cypher:
            n = sum(1 for (s, t, ty, pr) in self.edges if lo <= self._id(s) < hi)
            return _RS([[n]])
        res = await super().query(cypher, params, timeout)
        if cypher.startswith("MATCH (a) WHERE ID(a)") and "properties(r)" in cypher:
            self.max_edges_returned = max(self.max_edges_returned, len(res.result_set))
        return res


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


def _dupes_graph(cls=None):
    """Two duplicated urns. urn:a: ids 0 and 2, 2 synced later (kept). urn:c: ids 3 (Column) and
    4 (Table) — a copy under each of two labels; neither synced, so the lower id (3) is kept."""
    return (cls or FakeGraph)([
        _node("urn:a", displayName="a-old", lastSyncedAt="2026-01-01T00:00:00Z"),      # 0
        _node("urn:b"),                                                              # 1
        _node("urn:a", displayName="a-new", lastSyncedAt="2026-02-01T00:00:00Z"),      # 2
        _node("urn:c", label="Column", displayName="c-column"),                      # 3
        _node("urn:c", displayName="c-table"),                                       # 4
    ], [
        _edge(0, 1, id="e1"),                  # a discarded copy's edge: moves to the kept one
        _edge(0, 1, id="e7"),                  # ...beside a parallel one with its own id
        _edge(1, 0, id="e5"),                  # into a discarded copy
        _edge(0, 2, id="e3"),                  # between two copies of urn:a: collapse self-loop
        _edge(2, 2, id="e6"),                  # the kept copy pointing at itself: genuine
        _edge(4, 1, etype="OWNS", id="e4"),    # a cross-label copy's edge
    ])


class CrashOnceGraph(FakeGraph):
    """Its first delete of a discarded copy fails — after the copy's edges were moved."""
    crashed = False

    def _collapse(self, cypher, rows):
        if "DETACH DELETE" in cypher and not self.crashed:
            self.crashed = True
            raise ConnectionResetError("the graph service went away mid-collapse")
        return super()._collapse(cypher, rows)


class CrashAfterDeleteGraph(FakeGraph):
    """Its first delete of the discarded copies LANDS, and then the reply is lost: the window's
    checkpoint never commits, and its replay finds those copies already gone."""
    crashed = False

    def _collapse(self, cypher, rows):
        out = super()._collapse(cypher, rows)
        if "DETACH DELETE" in cypher and not self.crashed:
            self.crashed = True
            raise ConnectionResetError("the graph service went away after the delete")
        return out


def _edge_ends(fake):
    return sorted((fake._id(s), fake._id(t), pr.get("id")) for s, t, _ty, pr in fake.edges)


def _runner(fake, width=2, on_rollups_stale=None):
    """A runner whose scan windows are deliberately tiny, so every test exercises the
    multi-window (resumable) path rather than a single lucky pass."""
    from backend.app.services.versioning import config
    config.BOOTSTRAP_SCAN_WIDTH = width
    config.BOOTSTRAP_WINDOW = width
    config.BOOTSTRAP_BACKFILL_PAUSE_MS = 0              # the pause is for a live graph's readers
    return BootstrapRunner(lambda name, provider_id=None: fake, on_rollups_stale=on_rollups_stale)


async def _preflight(runner, lease, graph_id):
    """Run the pre-flight to its end: True when the copy may start, "paused" when it waits."""
    while True:
        done = await runner._phase_counting(lease, graph_id)
        if done:
            return done


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

    # Run only the pre-flight + first two node windows, then "crash".
    first = await _take(job_id)
    assert await _preflight(runner, first, gid) is True
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
    await _preflight(runner, await _take(job_id), gid)    # counts 6 nodes
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
    # (6: the late node lies past the largest id the pre-flight read, so the copy never saw it —
    # only validation's recount did.)
    assert (await _counts(gid, await _commit_id(gid)))[0] == 6, \
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
    dangling.hidden = {1}                                      # the ghost vanishes mid-copy
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
    broken = FakeGraph([_node("urn:a"), _node("urn:b")], [_edge("urn:a", "urn:b")])
    broken.hidden = {1}                                      # urn:b vanishes mid-copy
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
    await _preflight(runner, lease, gid)
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

    # ══ E. parallel connections merge + report ═══════════════════════════════
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
    with pytest.raises(LookupError):                       # no duplicates: no list to read
        await duplicate_page(data_source_id=d)

    # ══ E1. duplicate identifiers: found and decided BEFORE anything is copied ══
    d = ds()
    fake = _dupes_graph()
    hooked = []

    async def _hook(graph_id):
        hooked.append(graph_id)

    runner = _runner(fake, on_rollups_stale=_hook)
    res = await _enable(d)
    gid, job_id = res["graph_id"], res["job_id"]
    out = await _drive(runner, job_id)
    assert out["status"] == "paused", out
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        assert (job.status, job.current_phase, job.last_cursor) == (
            "pending", "awaiting_decision", None)
        ready = await s.scalar(text(
            f"SELECT count(*) FROM {JobORM.__table__.fullname} j WHERE j.id = :id "
            f"AND j.status = 'pending' AND {job_lease.BOOTSTRAP_READY}"), {"id": job_id})
    assert ready == 0, "a job waiting for a person is never claimed: it holds no slot"
    assert await _counts(gid, await _commit_id(gid)) == (0, 0), "nothing copied before deciding"
    with pytest.raises(ConcurrencyError):                  # and the graph stays write-blocked
        await svc.open_draft(graph_id=gid, owner="bob")
    status = await bootstrap_status(data_source_id=d)
    dup = status["duplicates"]
    assert (status["status"], status["phase"]) == ("needs_decision", "awaiting_decision")
    assert {k: dup[k] for k in ("identifiers", "extraCopies", "sameType", "crossType")} == {
        "identifiers": 2, "extraCopies": 2, "sameType": 1, "crossType": 1}, dup
    assert dup["decision"] is None and dup["fingerprint"] and dup["rule"]
    assert {(c["urn"], c["internalId"]) for c in dup["sample"] if c["kept"]} == {
        ("urn:a", 2), ("urn:c", 3)}, "the latest lastSyncedAt wins, then the lowest internal id"
    # The whole list: in pages, and as a CSV download.
    page = await duplicate_page(data_source_id=d, limit=3)
    assert [(i["urn"], i["copy"], i["internalId"]) for i in page["items"]] == [
        ("urn:a", 1, 2), ("urn:a", 2, 0), ("urn:c", 1, 3)]
    rest = await duplicate_page(data_source_id=d, after=page["next"], limit=3)
    assert [(i["urn"], i["internalId"], i["kept"]) for i in rest["items"]] == [
        ("urn:c", 4, False)] and rest["next"] is None
    lines = "".join([c async for c in await duplicates_csv(data_source_id=d)]).splitlines()
    assert lines[0] == "urn,copy,kept,reason,label,internal_id,last_synced_at"
    assert len(lines) == 5 and lines[1].startswith("urn:a,1,yes,kept,Table,2,2026-02-01")

    # ══ E14. a paused job is not resumed, and not decided while something runs it ══
    assert await _conflict(retry_bootstrap(data_source_id=d)) == "job_active"
    held = await _take(job_id)
    assert await _conflict(decide_duplicates(
        data_source_id=d, fingerprint=dup["fingerprint"], actor="alice")) == "not_awaiting_decision"
    await held.release()                                     # back to waiting, phase kept

    # ══ E2. only the list that was shown can be decided; the copy then starts at 0 ══
    assert await _conflict(decide_duplicates(
        data_source_id=d, fingerprint="0" * 32, actor="alice")) == "stale_decision"
    assert await decide_duplicates(data_source_id=d, fingerprint=dup["fingerprint"],
                                   actor="alice") == {"jobId": job_id, "already": False}
    assert (await decide_duplicates(data_source_id=d, fingerprint=dup["fingerprint"],
                                    actor="alice"))["already"] is True, "a repeat changes nothing"
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        # The copy starts by reading the source again: a pause can last days.
        assert (job.status, job.current_phase, job.last_cursor) == ("pending", "counting", None)
    status = await bootstrap_status(data_source_id=d)
    assert status["status"] == "pending" and status["duplicates"]["decision"]["decidedBy"] == "alice"
    out = await _drive(runner, job_id)
    assert out["status"] == "completed", out

    # ══ E3. one item per urn, the kept copy's content; collapse self-loops dropped ══
    st = await svc.materialize_state(graph_id=gid, branch_id=(await _main(gid)))
    assert sorted(st["nodes"]) == ["urn:a", "urn:b", "urn:c"]
    assert st["nodes"]["urn:a"]["displayName"] == "a-new"
    assert st["nodes"]["urn:c"]["entityType"] == "Column"
    assert sorted(st["edges"]) == ["e1", "e4", "e5", "e6", "e7"], \
        "e3 joined two copies of urn:a and is dropped; e6 is a real self-loop and is kept"
    status = await bootstrap_status(data_source_id=d)
    checks = {c["key"]: c["ok"] for c in status["report"]["checks"]}
    assert all(checks.values()), checks
    assert {"duplicates_collapsed", "duplicates_resolved", "source_stable"} <= set(checks)
    assert status["collapsed"] == {"nodes": 2, "byLabel": {"Table": 2}, "selfLoops": 1}
    # ...and the SOURCE graph now matches the copy: the discarded copies are gone, their edges
    # moved to the copies kept — one per stored edge, parallel ids kept apart.
    assert fake.nodes[0] is None and fake.nodes[4] is None and fake.nodes[2] and fake.nodes[3]
    assert _edge_ends(fake) == [(1, 2, "e5"), (2, 1, "e1"), (2, 1, "e7"), (2, 2, "e6"),
                                (3, 1, "e4")]
    assert hooked == [gid], "the rollups computed over the deleted copies are rebuilt"
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        kept_rows = await s.scalar(select(func.count()).select_from(BootstrapNodeORM).where(
            BootstrapNodeORM.graph_id == gid))
    assert job.summary["sourceCollapse"]["deleted"] == 2
    assert kept_rows == 4, "the unique rows are tidied away; the duplicates stay as the record"
    assert len((await duplicate_page(data_source_id=d))["items"]) == 4, "the list outlives the job"

    # ══ E4. a crash between moving the edges and deleting the copies ══════════
    d = ds()
    crashy = _dupes_graph(CrashOnceGraph)
    res = await _enable(d)
    runner = _runner(crashy)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    assert (await _drive(runner, res["job_id"]))["status"] == "completed"
    assert crashy.crashed, "the delete did fail once"
    assert _edge_ends(crashy) == [(1, 2, "e5"), (2, 1, "e1"), (2, 1, "e7"), (2, 2, "e6"),
                                  (3, 1, "e4")], "the re-run MERGEs onto the first run's edges"

    # ══ E4b. a crash AFTER the delete landed, before its checkpoint ══════════════
    # The replay finds the copies gone and counts no deletes — the rollups are rebuilt anyway:
    # that follows the decision, not a tally a crash can lose.
    d = ds()
    lost = _dupes_graph(CrashAfterDeleteGraph)
    hooked = []
    res = await _enable(d)
    runner = _runner(lost, on_rollups_stale=_hook)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    assert (await _drive(runner, res["job_id"]))["status"] == "completed"
    assert lost.crashed and lost.nodes[0] is None and lost.nodes[4] is None
    status = await bootstrap_status(data_source_id=d)
    assert status["sourceCollapse"] is not None, "copies left the source: that is remembered"
    assert hooked == [res["graph_id"]], "the rollups computed over the deleted copies are rebuilt"

    # ══ E5/E6. a restart re-checks and re-asks; abandoning purges the list too ══
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    assert (await _drive(_runner(fake), res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    assert (await retry_bootstrap(data_source_id=d, mode="restart"))["status"] == "pending"
    assert (await _drive(_runner(fake), res["job_id"]))["status"] == "paused"
    assert (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"] == fp, \
        "the same source gives the same list, and the same fingerprint"
    gone = await abandon_bootstrap(data_source_id=d)
    purged = await PurgeRunner(lambda name, provider_id=None: fake).run_job(
        await _take(gone["purgeJobId"]))
    assert purged["status"] == "completed", purged
    async with db.graphver_session() as s:
        assert await s.scalar(select(func.count()).select_from(BootstrapNodeORM).where(
            BootstrapNodeORM.graph_id == res["graph_id"])) == 0

    # ══ E7. a restart after a decision keeps it for the same list ════════════════
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    await _set_phase(res["job_id"], "nodes")
    async with db.graphver_session() as s:                 # it failed before the copy started
        job = await s.get(JobORM, res["job_id"])
        job.status = "failed"
    assert (await retry_bootstrap(data_source_id=d, mode="restart"))["status"] == "pending"
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "completed", "the same list is not asked about twice"
    assert (await bootstrap_status(data_source_id=d))["duplicates"]["decision"]["decidedBy"] == \
        "alice"

    # ══ E9. a job whose counting predates the pre-flight finishes as it always did ══
    d = ds()
    fake = _graph(nodes=6, edges=3)
    res = await _enable(d)
    async with db.graphver_session() as s:
        job = await s.get(JobORM, res["job_id"])
        job.summary = {
            "actor": "alice",
            "source": {"nodes": 6, "edges": 3, "invisibleNodes": 0, "invisibleEdges": 0},
            "scanned": {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}},
            "written": {"nodes": 0, "edges": 0},
            "rejected": {"duplicateUrns": 0, "danglingEdges": 0, "samples": []},
            "collapsedParallelEdges": 0, "sample": {"nodes": [], "nodesSeen": 0}}
        job.current_phase, job.total = "nodes", 9
    out = await _drive(_runner(fake), res["job_id"])
    assert out["status"] == "completed", out
    report = (await bootstrap_status(data_source_id=d))["report"]
    assert "source_stable" not in {c["key"] for c in report["checks"]}
    assert await _counts(res["graph_id"], await _commit_id(res["graph_id"])) == (6, 3)

    # ══ E10. a discarded copy deleted during the copy, its id re-used: copied ═══
    # (While the job WAITED, the re-check after the decision would see it: E12.)
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    await _recheck_then(runner, d, fp, res, lambda: fake.nodes.__setitem__(0, _node("urn:z")))
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "completed", out
    st = await svc.materialize_state(graph_id=res["graph_id"],
                                     branch_id=(await _main(res["graph_id"])))
    assert sorted(st["nodes"]) == ["urn:a", "urn:b", "urn:c", "urn:z"]
    checks = {c["key"]: c for c in (await bootstrap_status(data_source_id=d))["report"]["checks"]}
    assert not checks["duplicates_collapsed"]["ok"] and not checks["duplicates_collapsed"]["blocking"]
    assert fake.nodes[0][1]["urn"] == "urn:z", "the node now holding the id is not deleted"

    # ══ E12. the source changed during the pause: checked again, automatically ══
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    fake.nodes.append(_node("urn:new"))                     # unrelated: the same duplicates
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "completed", out
    status = await bootstrap_status(data_source_id=d)
    assert status["report"]["source"]["maxNodeId"] == 5, "the copy read the source again"
    assert status["duplicates"]["fingerprint"] == fp

    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    fake.nodes.append(_node("urn:b", displayName="b-again"))   # a NEW duplicate
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "paused", "a changed list is asked about again"
    status = await bootstrap_status(data_source_id=d)
    assert status["duplicates"]["fingerprint"] != fp and status["duplicates"]["identifiers"] == 3
    assert status["duplicates"]["decision"] is None, "the old decision was not about this list"
    assert await _conflict(decide_duplicates(
        data_source_id=d, fingerprint=fp, actor="alice")) == "stale_decision"
    assert await _counts(res["graph_id"], await _commit_id(res["graph_id"])) == (0, 0)

    # ══ E13. the copy to keep was deleted during the copy, its id re-used: fails ═══
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    await _recheck_then(runner, d, fp, res, lambda: fake.nodes.__setitem__(2, _node("urn:y")))
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "failed" and "no copy left to keep" in out["error"], out
    status = await bootstrap_status(data_source_id=d)
    assert {k: status["failure"][k] for k in ("code", "action", "phase")} == {
        "code": "integrity", "action": "restart", "phase": "validate"}
    assert not {c["key"]: c["ok"] for c in status["report"]["checks"]}["duplicates_resolved"]

    # ══ E15. a copy re-synced while waiting: the ranking changed, so it is asked again ══
    # Collapsing on the old list would delete the copy synced most recently — the opposite of
    # the rule the manager was shown.
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    fake.nodes[0][1]["lastSyncedAt"] = "2026-03-01T00:00:00Z"   # now newer than copy 2
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    dup = (await bootstrap_status(data_source_id=d))["duplicates"]
    assert dup["fingerprint"] != fp and dup["decision"] is None
    assert {(c["urn"], c["internalId"]) for c in dup["sample"] if c["kept"]} == {
        ("urn:a", 0), ("urn:c", 3)}
    assert fake.nodes[0] is not None and fake.nodes[2] is not None, "nothing was deleted"

    # ══ E16. a connection added while waiting: counted by the re-check, not a late failure ══
    d = ds()
    fake = _dupes_graph()
    res = await _enable(d)
    runner = _runner(fake)
    assert (await _drive(runner, res["job_id"]))["status"] == "paused"
    fp = (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"]
    fake.edges.append(_edge(1, 3, id="e9"))
    await decide_duplicates(data_source_id=d, fingerprint=fp, actor="alice")
    out = await _drive(runner, res["job_id"])
    assert out["status"] == "completed", out
    assert (await bootstrap_status(data_source_id=d))["duplicates"]["fingerprint"] == fp

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


async def _recheck_then(runner, ds_id, fingerprint, res, change) -> None:
    """Decide, let the copy's re-check of the source run (it finds the same list), and only THEN
    apply ``change`` to the source — a change made during the copy, which the re-check could not
    see."""
    await decide_duplicates(data_source_id=ds_id, fingerprint=fingerprint, actor="alice")
    held = await _take(res["job_id"])
    assert await _preflight(runner, held, res["graph_id"]) is True
    await held.release()
    change()


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
