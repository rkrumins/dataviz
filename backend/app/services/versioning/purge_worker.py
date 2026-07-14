"""Reclaiming a deleted versioned graph — windowed, resumable, and refusing to overreach.

Deleting a data source used to delete one row. Everything derived from it stayed: on this dev
database 2,296 of 2,321 versioned graphs (98.9%) have no data source left, holding millions of
version rows nobody can reach. This is the other half of the delete.

Three properties, and the third is the one that matters most:

1. WINDOWED. One graph here is ~2.9M rows (1.15M entity_heads, 1.0M edge_versions, 635k
   node_versions, 143k merkle_nodes) and a real one is 7.7M+. A single `DELETE ... WHERE
   graph_id = X` is one transaction holding locks and generating WAL for the whole graph. We
   delete in windows, each its own transaction.

   The windows are ORDERED BY THE PRIMARY KEY, and that is not cosmetic. `SELECT ctid ... LIMIT n`
   without an ORDER BY plans a Seq Scan, so every window re-walks the dead tuples the previous
   windows left behind — quadratic, and at 7.7M rows the difference between a minute and an hour.
   Ordering by the PK plans an Index Scan, whose dead entries are LP_DEAD-hinted and skipped
   cheaply. (Verified with EXPLAIN on the live table; see the module tests.)

2. RESUMABLE FOR FREE. DELETE is idempotent, so — unlike the bootstrap, which must checkpoint a
   cursor to avoid writing a row twice — a purge that dies mid-phase simply re-runs the same
   "delete the next N rows for this graph" and converges. There is no cursor to get wrong. A
   killed worker is taken over on the stale heartbeat and picks up where it stopped, because
   "where it stopped" is just "whatever rows are still there".

3. IT REFUSES TO DELETE WHAT IS NOT OURS. Two hard gates, both of which FAIL the job rather than
   guess:

   - The graph must already be SOFT-DELETED (`graphs.deleted_at IS NOT NULL`). A purge job that
     somehow targets a live graph — a replayed message, a bad id, a bug in a caller — does
     nothing. Soft-delete is the only thing that authorises destruction, and it is set by the
     one code path a human actually confirmed.

   - The FalkorDB graph is dropped ONLY if `projection_state.owns_falkor_graph` is true — i.e.
     only if WE generated its name. A bootstrapped data source is pinned to the CUSTOMER'S OWN
     graph (`nexus_lineage`, `perf-load-test-solidatus`), which predates us and may be shared.
     Deleting our version history must never mean deleting their data. On this database that is
     248 graphs protected against 19 owned — the guardrail is doing almost all of the work.
     We additionally refuse if any surviving graph still points at the same FalkorDB name.

The job row itself is deliberately NOT deleted: it is the receipt.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select, text

from . import config, db
from .models import GraphORM, JobORM, ProjectionStateORM, _now

logger = logging.getLogger(__name__)

PURGE_JOB_TYPE = "purge"

PHASES = ("count", "edges", "nodes", "heads", "merkle", "working", "commits",
          "falkor", "meta", "finalize")

# The bulk tables, in delete order, with the PK column list that makes each window an Index Scan
# rather than a Seq Scan over dead tuples. Order matters only for readability — there are no FKs
# between these — but deleting the heaviest first makes progress legible.
_BULK: Tuple[Tuple[str, str], ...] = (
    ("edge_versions", "graph_id, id"),
    ("node_versions", "graph_id, id"),
    ("entity_heads", "graph_id, branch_id, entity_id"),
    ("merkle_nodes", "graph_id, commit_id, path"),
    ("working_changes", "graph_id, id"),
    ("commits", "graph_id, id"),
)
_PHASE_TABLE = {
    "edges": _BULK[0], "nodes": _BULK[1], "heads": _BULK[2],
    "merkle": _BULK[3], "working": _BULK[4], "commits": _BULK[5],
}

# Progress floors, so the bar moves through the phases instead of sitting at 0 then jumping.
_PHASE_FLOOR = {"count": 0, "edges": 1, "nodes": 25, "heads": 50, "merkle": 70,
                "working": 80, "commits": 82, "falkor": 92, "meta": 95, "finalize": 99}


class PurgeSuperseded(Exception):
    """Another worker took this job over, or it was cancelled. Stop; do not write."""


class PurgeRefused(Exception):
    """A guardrail said no. The job fails and NOTHING is deleted."""

    def __init__(self, reason: str, code: str = "refused") -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code


def _now_minus(secs: int) -> str:
    import datetime as _dt
    return (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=secs)).isoformat()


def _sch() -> str:
    return config.graphver_schema()


class PurgeRunner:
    """Executes `job_type='purge'` jobs. Hosted by the versioning worker, beside bootstrap."""

    def __init__(self, graph_factory=None, *, session_factory=None, consumer: str = "purge-1"):
        self._factory = graph_factory          # None => FalkorDB drop is skipped and disclosed
        self._session = session_factory or db.graphver_session
        self._consumer = consumer
        self._epoch: Dict[str, int] = {}

    # ---------------------------------------------------------------- infra --
    async def claim_one(self) -> Optional[str]:
        """Claim a pending purge, or take over one whose worker looks dead.

        Identical contract to the bootstrap runner: `JobORM` is the durable queue, `updated_at`
        is the heartbeat, and `retry_count` is the CLAIM EPOCH so a slow-but-alive worker that
        gets taken over discovers it on its next write and stops rather than double-deleting.
        (Double-deleting is harmless here — that is the point of DELETE — but a superseded worker
        that kept running would fight the new owner for every window.)
        """
        stale_before = _now_minus(config.INGEST_STALE_SECS)
        async with self._session() as s:
            row = (await s.execute(
                select(JobORM).where(
                    JobORM.job_type == PURGE_JOB_TYPE,
                    text("(status = 'pending' OR (status = 'running' AND updated_at < :stale))")
                    .bindparams(stale=stale_before),
                ).order_by(JobORM.created_at).limit(1).with_for_update(skip_locked=True)
            )).scalars().first()
            if row is None:
                return None
            if row.status == "running":
                row.retry_count += 1
                logger.warning("taking over stale purge job %s (phase=%s)",
                               row.id, row.current_phase)
            row.status = "running"
            row.started_at = row.started_at or _now()
            row.updated_at = _now()
            row.error_message = None
            self._epoch[row.id] = row.retry_count
            return row.id

    def _own(self, job: JobORM) -> JobORM:
        if job.status == "cancelled":
            raise PurgeSuperseded("the job was cancelled")
        if self._epoch.get(job.id) is not None and job.retry_count != self._epoch[job.id]:
            raise PurgeSuperseded("another worker took over this job")
        return job

    # ---------------------------------------------------------------- driver --
    async def run_job(self, job_id: str) -> Dict[str, object]:
        beat = asyncio.create_task(self._heartbeat(job_id))
        try:
            while True:
                async with self._session() as s:
                    job = await s.get(JobORM, job_id)
                    if job is None or job.status in ("completed", "cancelled"):
                        return {"job_id": job_id, "status": job.status if job else "missing"}
                    self._own(job)
                    phase = job.current_phase or "count"
                    graph_id = job.graph_id
                done = await self._run_phase(phase, job_id, graph_id)
                if not done:
                    continue                                   # same phase, next window
                nxt = PHASES[PHASES.index(phase) + 1] if phase != PHASES[-1] else None
                async with self._session() as s:
                    job = self._own(await s.get(JobORM, job_id))
                    if nxt is None:
                        job.status = "completed"
                        job.current_phase = None
                        job.progress = 100
                        job.completed_at = _now()
                        job.updated_at = _now()
                        logger.info("purge %s completed (graph=%s, %s rows)",
                                    job_id, graph_id, job.processed)
                        return {"job_id": job_id, "status": "completed",
                                "deleted": job.processed}
                    job.current_phase = nxt
                    job.progress = _PHASE_FLOOR[nxt]
                    job.updated_at = _now()
        except PurgeSuperseded as exc:
            logger.info("purge %s handed off: %s", job_id, exc)
            self._epoch.pop(job_id, None)
            return {"job_id": job_id, "status": "superseded"}
        except PurgeRefused as exc:
            logger.error("purge %s REFUSED: %s", job_id, exc.reason)
            await self._fail(job_id, exc.reason, exc.code)
            return {"job_id": job_id, "status": "failed", "error": exc.reason}
        except Exception as exc:                                # pragma: no cover - infra
            logger.exception("purge %s crashed", job_id)
            await self._fail(job_id, str(exc)[:400], "infrastructure")
            return {"job_id": job_id, "status": "failed"}
        finally:
            beat.cancel()

    async def _heartbeat(self, job_id: str) -> None:
        """Say "still alive" on a timer. A single 50k-row window on a bloated table can outlast
        the stale window all by itself; beating only at window boundaries would let a healthy
        worker be declared dead and its job stolen, over and over."""
        try:
            while True:
                await asyncio.sleep(config.INGEST_HEARTBEAT_SECS)
                async with self._session() as s:
                    job = await s.get(JobORM, job_id)
                    if job is None or job.status != "running":
                        return
                    if self._epoch.get(job_id) is not None \
                            and job.retry_count != self._epoch[job_id]:
                        return                                  # superseded; stop beating
                    job.updated_at = _now()
        except asyncio.CancelledError:
            pass

    async def _fail(self, job_id: str, reason: str, code: str) -> None:
        async with self._session() as s:
            job = await s.get(JobORM, job_id)
            if job is None or job.status == "cancelled":
                return
            job.status = "failed"
            job.error_message = reason
            job.updated_at = _now()
            summary = dict(job.summary or {})
            summary["failure"] = {"code": code, "reason": reason}
            job.summary = summary

    async def _run_phase(self, phase: str, job_id: str, graph_id: str) -> bool:
        if phase == "count":
            return await self._phase_count(job_id, graph_id)
        if phase in _PHASE_TABLE:
            return await self._delete_window(job_id, graph_id, *_PHASE_TABLE[phase])
        if phase == "falkor":
            return await self._phase_falkor(job_id, graph_id)
        if phase == "meta":
            return await self._phase_meta(job_id, graph_id)
        if phase == "finalize":
            return await self._phase_finalize(job_id, graph_id)
        raise PurgeRefused(f"unknown purge phase {phase!r}", "internal")

    # ---------------------------------------------------------------- phases --
    async def _phase_count(self, job_id: str, graph_id: str) -> bool:
        """Establish the denominator — and check, ONCE, that we are allowed to do this at all."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                # Already gone. A replayed purge is a no-op, not an error.
                logger.info("purge %s: graph %s already gone", job_id, graph_id)
                job = self._own(await s.get(JobORM, job_id))
                job.status = "completed"
                job.current_phase = None
                job.progress = 100
                job.completed_at = _now()
                job.updated_at = _now()
                raise PurgeSuperseded("nothing to purge")

            # ── THE GATE ── Soft-delete is the ONLY thing that authorises destruction. It is
            # set by the one code path a human actually confirmed. Without this, a stray job row
            # with a live graph_id would quietly shred a working graph.
            if graph.deleted_at is None:
                raise PurgeRefused(
                    "this graph is still live — a purge only ever runs on a graph that was "
                    "explicitly deleted", "graph_not_deleted")

            total = 0
            for table, _pk in _BULK:
                total += int(await s.scalar(text(
                    f'SELECT count(*) FROM "{_sch()}"."{table}" WHERE graph_id = :g'
                ), {"g": graph_id}) or 0)

            job = self._own(await s.get(JobORM, job_id))
            job.total = total
            job.processed = 0
            job.updated_at = _now()
            summary = dict(job.summary or {})
            summary["rows"] = total
            job.summary = summary
        logger.info("purge %s: %s rows to reclaim for graph %s", job_id, total, graph_id)
        return True

    async def _delete_window(self, job_id: str, graph_id: str, table: str, pk: str) -> bool:
        """Delete up to one window of rows. Returns True when the table is empty for this graph.

        ORDER BY the PK is load-bearing (see the module docstring): without it this is a Seq Scan
        that re-walks every dead tuple the earlier windows left, and the purge goes quadratic.
        """
        width = max(1000, int(config.PURGE_WINDOW))
        async with self._session() as s:
            self._own(await s.get(JobORM, job_id))            # fence BEFORE we delete anything
            res = await s.execute(text(
                f'WITH doomed AS ('
                f'  SELECT ctid FROM "{_sch()}"."{table}" WHERE graph_id = :g '
                f'  ORDER BY {pk} LIMIT :n'
                f') '
                f'DELETE FROM "{_sch()}"."{table}" t USING doomed d '
                f'WHERE t.graph_id = :g AND t.ctid = d.ctid'
            ), {"g": graph_id, "n": width})
            deleted = res.rowcount or 0
            if deleted:
                job = self._own(await s.get(JobORM, job_id))
                job.processed = (job.processed or 0) + deleted
                if job.total:
                    span = 92 - _PHASE_FLOOR["edges"]          # count..falkor occupy 1%..92%
                    job.progress = min(92, 1 + int(span * job.processed / job.total))
                job.updated_at = _now()
        return deleted == 0

    async def _phase_falkor(self, job_id: str, graph_id: str) -> bool:
        """Drop the projected FalkorDB graph — if, and only if, it is ours to drop."""
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            name = ps.falkor_graph_name if ps else None
            owned = bool(ps.owns_falkor_graph) if ps else False
            provider = ps.falkor_provider if ps else None

            shared_with = 0
            if name:
                # Belt and braces: even a graph we minted must not be dropped while another
                # SURVIVING graph still projects into it. Ownership answers "did we make this?";
                # this answers "is anyone still using it?".
                shared_with = int(await s.scalar(text(
                    f'SELECT count(*) FROM "{_sch()}"."projection_state" p '
                    f'JOIN "{_sch()}"."graphs" g ON g.id = p.graph_id '
                    f'WHERE p.falkor_graph_name = :n AND p.graph_id <> :g '
                    f'  AND g.deleted_at IS NULL'
                ), {"n": name, "g": graph_id}) or 0)

        verdict: str
        if not name:
            verdict = "no projected graph"
        elif not owned:
            verdict = f"PROTECTED: '{name}' is not ours (we did not create it) — left untouched"
        elif shared_with:
            verdict = f"PROTECTED: '{name}' is still projected by {shared_with} live graph(s)"
        elif self._factory is None:
            verdict = f"skipped: no graph client configured — '{name}' left in place"
        else:
            try:
                client = self._factory(name, provider)
                if inspect.isawaitable(client):
                    client = await client
                await client.delete()
                verdict = f"dropped '{name}'"
                logger.warning("purge %s DROPPED FalkorDB graph %s (we created it)", job_id, name)
            except Exception as exc:                            # pragma: no cover - infra
                # A leaked FalkorDB graph is recoverable (cleanup script). Failing the whole
                # purge over it — and stranding millions of SQL rows — is not an improvement.
                verdict = f"could not drop '{name}': {exc}"
                logger.warning("purge %s: %s", job_id, verdict)

        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            summary = dict(job.summary or {})
            summary["falkor"] = {"name": name, "owned": owned, "verdict": verdict}
            job.summary = summary
            job.updated_at = _now()
        logger.info("purge %s falkor: %s", job_id, verdict)
        return True

    async def _phase_meta(self, job_id: str, graph_id: str) -> bool:
        """The small tables. Bounded by branch/job count, so one statement each is fine."""
        sch = _sch()
        async with self._session() as s:
            self._own(await s.get(JobORM, job_id))
            for sql in (
                f'DELETE FROM "{sch}"."branch_members" WHERE branch_id IN '
                f'  (SELECT id FROM "{sch}"."branches" WHERE graph_id = :g)',
                f'DELETE FROM "{sch}"."import_rows" WHERE job_id IN '
                f'  (SELECT id FROM "{sch}"."jobs" WHERE graph_id = :g)',
                f'DELETE FROM "{sch}"."merge_requests" WHERE graph_id = :g',
                f'DELETE FROM "{sch}"."branches" WHERE graph_id = :g',
                f'DELETE FROM "{sch}"."projection_state" WHERE graph_id = :g',
                # Every job for this graph EXCEPT this one. The purge's own row survives as the
                # receipt: what was deleted, when, by whom, and what we refused to touch.
                f'DELETE FROM "{sch}"."jobs" WHERE graph_id = :g AND id <> :j',
            ):
                await s.execute(text(sql), {"g": graph_id, "j": job_id})
        return True

    async def _phase_finalize(self, job_id: str, graph_id: str) -> bool:
        async with self._session() as s:
            self._own(await s.get(JobORM, job_id))
            await s.execute(text(f'DELETE FROM "{_sch()}"."graphs" WHERE id = :g'),
                            {"g": graph_id})
        return True


# ------------------------------------------------------------------ enqueue --
async def create_purge_job(*, graph_id: str, workspace_id: Optional[str], actor: str,
                           data_source_id: Optional[str] = None,
                           session_factory=None) -> Optional[str]:
    """Soft-delete the graph and enqueue its purge, in ONE transaction.

    The two must be atomic. A soft-delete with no job leaks the rows forever (that is exactly the
    bug we are fixing). A job with no soft-delete is refused by `_phase_count` — safe, but it
    would mean a delete that silently did nothing.

    Idempotent: a second delete of the same graph returns the job already in flight.
    """
    sf = session_factory or db.graphver_session
    async with sf() as s:
        graph = await s.get(GraphORM, graph_id)
        if graph is None:
            return None

        existing = (await s.execute(
            select(JobORM).where(
                JobORM.job_type == PURGE_JOB_TYPE,
                JobORM.graph_id == graph_id,
                JobORM.status.in_(("pending", "running")),
            ).limit(1))).scalars().first()
        if existing is not None:
            return existing.id

        graph.deleted_at = graph.deleted_at or _now()
        graph.deleted_by = graph.deleted_by or actor

        job = JobORM(
            job_type=PURGE_JOB_TYPE,
            graph_id=graph_id,
            workspace_id=workspace_id or graph.workspace_id,
            data_source_id=data_source_id or graph.data_source_id,
            status="pending",
            current_phase="count",
            idempotency_key=f"purge:{graph_id}",
            summary={"actor": actor},
        )
        s.add(job)
        await s.flush()
        logger.info("purge queued for graph %s (job=%s, by %s)", graph_id, job.id, actor)
        return job.id


async def purge_graph_for_data_source(*, data_source_id: str, workspace_id: str,
                                      actor: str) -> List[str]:
    """Soft-delete + enqueue a purge for every versioned graph of a data source.

    This is the PERMANENT path — "delete permanently", and the reaper once the grace period is
    up. The ordinary user delete calls :func:`tombstone_graphs_for_data_source` instead, which
    hides the graph without queueing anything, so it can be undone.

    Usually exactly one graph. Forks are separate rows with their own data_source_id and are NOT
    swept up here — a fork is somebody else's work, and deleting the source is not consent to
    delete it.
    """
    async with db.graphver_session() as s:
        graphs = (await s.execute(
            select(GraphORM.id).where(
                GraphORM.data_source_id == data_source_id,
                GraphORM.workspace_id == workspace_id,
            ))).scalars().all()

    jobs: List[str] = []
    for gid in graphs:
        jid = await create_purge_job(graph_id=gid, workspace_id=workspace_id, actor=actor,
                                     data_source_id=data_source_id)
        if jid:
            jobs.append(jid)
    return jobs


# ---------------------------------------------------------------- the undo window --
async def tombstone_graphs_for_data_source(*, data_source_id: str, workspace_id: str,
                                           actor: str) -> int:
    """Hide a data source's graphs WITHOUT queueing anything. The reversible half of delete.

    No purge job is created. The tombstone's age is the only schedule there is, and the reaper
    (below) is what eventually acts on it — which is precisely what leaves room for an undo.
    """
    async with db.graphver_session() as s:
        graphs = (await s.execute(
            select(GraphORM).where(
                GraphORM.data_source_id == data_source_id,
                GraphORM.workspace_id == workspace_id,
                GraphORM.deleted_at.is_(None),
            ))).scalars().all()
        for g in graphs:
            g.deleted_at = _now()
            g.deleted_by = actor
    return len(graphs)


async def restore_graphs_for_data_source(*, data_source_id: str, workspace_id: str) -> bool:
    """Bring a data source's graphs back. Returns False if it is too late.

    TOO LATE MEANS: a purge job exists. That is the whole concurrency design — rather than trying
    to cancel a purge mid-flight and stitch a half-deleted graph back together, restore simply
    REFUSES once a purge has been queued. A purge and a restore can therefore never overlap, and
    there is no partial-restore state to reason about. The row lock below serialises us against
    the reaper deciding to queue one at this exact moment.
    """
    async with db.graphver_session() as s:
        graphs = (await s.execute(
            select(GraphORM).where(
                GraphORM.data_source_id == data_source_id,
                GraphORM.workspace_id == workspace_id,
            ).with_for_update())).scalars().all()

        for g in graphs:
            doomed = await s.scalar(select(func.count()).select_from(JobORM).where(
                JobORM.job_type == PURGE_JOB_TYPE, JobORM.graph_id == g.id,
                JobORM.status.in_(("pending", "running", "completed"))))
            if doomed:
                return False                       # being (or already) destroyed — cannot undo

        for g in graphs:
            g.deleted_at = None
            g.deleted_by = None
    return True


async def purge_pending_for_data_source(*, data_source_id: str) -> bool:
    """Is this data source past the point of no return? (Drives the trash UI's "Deleting…" state.)"""
    async with db.graphver_session() as s:
        return bool(await s.scalar(
            select(func.count()).select_from(JobORM)
            .join(GraphORM, GraphORM.id == JobORM.graph_id)
            .where(GraphORM.data_source_id == data_source_id,
                   JobORM.job_type == PURGE_JOB_TYPE,
                   JobORM.status.in_(("pending", "running")))))


class Reaper:
    """Turns expired tombstones into purges, and then into nothing.

    The grace period lives here and nowhere else. A data source deleted 31 days ago is not a
    scheduling problem — it is just a row whose `deleted_at` is older than the cutoff. Asking that
    question every 15 minutes is the entire mechanism.

    It runs in three stages per data source, and stops at whichever one is still in progress:
      1. tombstone expired, no purge queued  -> queue one
      2. purge queued, not finished          -> leave it alone
      3. purge finished (or never needed)    -> hard-delete the data-source row; it is now gone
    """

    def __init__(self, *, app_session_factory=None, graphver_session_factory=None):
        self._app = app_session_factory
        self._gv = graphver_session_factory or db.graphver_session

    def _app_sessions(self):
        if self._app is not None:
            return self._app
        from backend.app.db.engine import get_session_factory
        return get_session_factory()

    async def run_once(self) -> Dict[str, int]:
        from backend.app.db.models import WorkspaceDataSourceORM

        cutoff = _now_minus(config.PURGE_GRACE_DAYS * 86400)
        Session = self._app_sessions()
        async with Session() as s:
            expired = (await s.execute(
                select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id,
                       WorkspaceDataSourceORM.deleted_by)
                .where(WorkspaceDataSourceORM.deleted_at.isnot(None),
                       WorkspaceDataSourceORM.deleted_at < cutoff))).all()

        queued = reaped = 0
        for ds_id, ws_id, actor in expired:
            async with self._gv() as gs:
                graphs = (await gs.execute(select(GraphORM.id).where(
                    GraphORM.data_source_id == ds_id))).scalars().all()
                unfinished = 0
                if graphs:
                    unfinished = int(await gs.scalar(
                        select(func.count()).select_from(JobORM).where(
                            JobORM.job_type == PURGE_JOB_TYPE,
                            JobORM.graph_id.in_(graphs),
                            JobORM.status.in_(("pending", "running")))) or 0)

            if graphs and not unfinished:
                # Are they queued at all? A graph still standing with no job needs one.
                jobs = await purge_graph_for_data_source(
                    data_source_id=ds_id, workspace_id=ws_id, actor=actor or "reaper")
                if jobs:
                    queued += len(jobs)
                    logger.info("reaper: grace expired for %s — purge queued %s", ds_id, jobs)
                    continue          # let it run; we will remove the row on a later pass
            if unfinished:
                continue              # still being destroyed

            # Nothing left to purge (graph gone, or it never had one). The tombstone is the last
            # trace of this data source, and its time is up.
            #
            # COMMIT EXPLICITLY. Unlike `graphver_session`, the app session factory does not
            # commit on context exit — the first cut of this silently rolled the delete back and
            # still counted it, so the reaper reported work it had not done. A janitor that lies
            # about what it reclaimed is worse than one that does nothing.
            async with Session() as s:
                row = await s.get(WorkspaceDataSourceORM, ds_id)
                if row is not None and row.deleted_at is not None:
                    await s.delete(row)
                    await s.commit()
                    reaped += 1
                    logger.info("reaper: %s is past its grace period and is now gone", ds_id)

        if queued or reaped:
            logger.info("reaper: %s purge(s) queued, %s data source(s) removed", queued, reaped)
        return {"queued": queued, "reaped": reaped}
