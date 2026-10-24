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
     We additionally refuse if any surviving graph still points at the same FalkorDB name, or if
     any other live data source or catalog entry reads the key — and when that cannot be asked
     (the management database is unreachable), the key is kept too.

The job row itself is deliberately NOT deleted: it is the receipt.
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.orm import aliased

from . import config, db, job_lease
from .job_lease import Draining, Lease, Superseded
from .errors import GraphMoved, JobActive, LockBusy
from .models import GraphORM, JobORM, ProjectionStateORM, _now

logger = logging.getLogger(__name__)

PURGE_JOB_TYPE = "purge"

PHASES = ("count", "edges", "nodes", "heads", "merkle", "working", "commits", "preflight",
          "falkor", "meta", "finalize")

# The bulk tables, in delete order, with the PK column list that makes each window an Index Scan
# rather than a Seq Scan over dead tuples. Order matters only for readability — there are no FKs
# between these — but deleting the heaviest first makes progress legible. ``bootstrap_nodes`` is an
# enablement pre-flight's view of the source (one row per source node, the duplicates kept after it
# finishes as their audit list).
_BULK: Tuple[Tuple[str, str], ...] = (
    ("edge_versions", "graph_id, id"),
    ("node_versions", "graph_id, id"),
    ("entity_heads", "graph_id, branch_id, entity_id"),
    ("merkle_nodes", "graph_id, commit_id, path"),
    ("working_changes", "graph_id, id"),
    ("commits", "graph_id, id"),
    ("bootstrap_nodes", "graph_id, falkor_id"),
)
_PHASE_TABLE = {
    "edges": _BULK[0], "nodes": _BULK[1], "heads": _BULK[2],
    "merkle": _BULK[3], "working": _BULK[4], "commits": _BULK[5], "preflight": _BULK[6],
}

# Progress floors, so the bar moves through the phases instead of sitting at 0 then jumping.
_PHASE_FLOOR = {"count": 0, "edges": 1, "nodes": 25, "heads": 50, "merkle": 70,
                "working": 80, "commits": 82, "preflight": 90, "falkor": 92, "meta": 95,
                "finalize": 99}


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


async def delete_window(s, table: str, pk: str, graph_id: str, *, where: str = "",
                        params: Optional[dict] = None) -> int:
    """Delete up to one ``PURGE_WINDOW`` of ``table``'s rows for ``graph_id`` in the caller's
    transaction, and say how many went. ``where`` narrows the rows (SQL over the table, ANDed — a
    constant, never input; its binds go in ``params``): a purge takes a graph's every row, a
    bootstrap restart only what its import commit wrote.

    ORDER BY the PK is load-bearing (see the module docstring): without it this is a Seq Scan
    that re-walks every dead tuple the earlier windows left, and the delete goes quadratic.
    """
    narrow = f"AND {where} " if where else ""
    res = await s.execute(text(
        f'WITH doomed AS ('
        f'  SELECT ctid FROM "{_sch()}"."{table}" WHERE graph_id = :g {narrow}'
        f'  ORDER BY {pk} LIMIT :n'
        f') '
        f'DELETE FROM "{_sch()}"."{table}" t USING doomed d '
        f'WHERE t.graph_id = :g AND t.ctid = d.ctid'
    ), {"g": graph_id, "n": max(1000, int(config.PURGE_WINDOW)), **(params or {})})
    return res.rowcount or 0


def _minted(g):
    """A fork :meth:`~.service.GraphVersioningService.fork_graph` minted (its ``dsfork_`` id):
    trashed and purged on its own, or with its parent. Any other goes with its data source."""
    return g.data_source_id.startswith("dsfork_", autoescape=True)


async def _forks_reading(s, graph: GraphORM) -> int:
    """How many forks still read ``graph``'s history. A graph with nothing past its genesis
    commit (an abandoned enablement) gives its forks nothing, so none hold it back. A trashed
    minted fork stops holding its parent back unless a live fork, or one bound to a data source,
    reads through it, at any depth (a fork's state composes its parent's, recursively)."""
    if graph.main_head_commit_seq <= 1:
        return 0
    # Each fork of ``graph`` (top), and every fork under it reached through trashed minted forks.
    sub = select(GraphORM.id.label("top"), GraphORM.id, GraphORM.deleted_at,
                 GraphORM.data_source_id).where(
        GraphORM.fork_parent_graph_id == graph.id).cte("sub", recursive=True)
    child = aliased(GraphORM)
    sub = sub.union_all(select(sub.c.top, child.id, child.deleted_at, child.data_source_id).where(
        child.fork_parent_graph_id == sub.c.id, sub.c.deleted_at.isnot(None), _minted(sub.c)))
    return int(await s.scalar(select(func.count(sub.c.top.distinct())).where(
        or_(sub.c.deleted_at.is_(None), ~_minted(sub.c)))) or 0)


async def graph_key_readers(provider_id: Optional[str], graph_name: str,
                            exclude_ds: Optional[str]) -> List[dict]:
    """Every live data source and catalog entry, besides ``exclude_ds``, that reads the FalkorDB
    key ``(provider_id, graph_name)`` (``managed_sources.graph_key_bindings``, in the management
    database). Raises when it cannot be asked."""
    from backend.app.db.engine import get_async_session
    from backend.app.services.managed_sources import graph_key_bindings

    async with get_async_session() as s:
        return await graph_key_bindings(s, provider_id, graph_name, exclude_ds=exclude_ds)


class PurgeRunner:
    """Executes `job_type='purge'` jobs. Hosted by the versioning worker's bootstrap lane, on the
    job lease (``job_lease``) like every other job."""

    def __init__(self, graph_factory=None, *, session_factory=None, consumer: str = "purge-1",
                 key_in_use: Optional[Callable[..., Awaitable[List[dict]]]] = None):
        self._factory = graph_factory          # None => FalkorDB drop is skipped and disclosed
        self._session = session_factory or db.graphver_session
        self._consumer = consumer
        # Who else reads a key we are about to drop: ``(provider, name, exclude_ds) -> bindings``.
        self._key_in_use = key_in_use or graph_key_readers

    # ---------------------------------------------------------------- infra --
    async def claim_one(self) -> Optional[Lease]:
        """Claim a pending purge, or take over one whose worker looks dead.

        The bootstrap's contract (``job_lease.claim``): `JobORM` is the durable queue, `updated_at`
        is the heartbeat, and every claim is a new EPOCH, so a slow-but-alive worker that gets taken
        over discovers it at its next write and stops rather than double-deleting. (Double-deleting
        is harmless here — that is the point of DELETE — but a superseded worker that kept running
        would fight the new owner for every window.)
        """
        return await job_lease.claim(self._session, job_lease.PURGE_TYPES,
                                     phase_pred=job_lease.PURGE_READY, lane="bootstrap")

    # ---------------------------------------------------------------- driver --
    async def run_job(self, lease: Lease) -> Dict[str, object]:
        """Drive a claimed purge to the end. Every write to its row is fenced on ``lease``; the
        lease is checked between windows, and a stopping worker hands the job back (DELETE is
        idempotent, so the next owner just carries on). A refusal or a crash is recorded on the
        job, never raised."""
        job_id = lease.job_id
        try:
            while True:
                lease.check()
                async with self._session() as s:
                    job = await s.get(JobORM, job_id)
                    if job is None or job.status != "running" or job.retry_count != lease.epoch:
                        raise Superseded("the job was cancelled or taken over")
                    phase = job.current_phase or "count"
                    graph_id, deleted = job.graph_id, job.processed
                # A Postgres failover or a dropped connection is waited out, not failed: every
                # unit is idempotent (DELETEs, a count), so a retry re-runs one that rolled back
                # or finds its rows already gone. A refusal is never retried.
                done = await lease.retry_transient(
                    lambda: self._run_phase(phase, lease, graph_id), never=(PurgeRefused,))
                if not done:
                    continue                                   # same phase, next window
                nxt = PHASES[PHASES.index(phase) + 1] if phase != PHASES[-1] else None
                if nxt is None:
                    if not await lease.finish("completed", current_phase=None, progress=100):
                        raise Superseded("the job was cancelled or taken over")
                    logger.info("purge %s completed (graph=%s, %s rows)", job_id, graph_id, deleted)
                    return {"job_id": job_id, "status": "completed", "deleted": deleted}
                async with self._session() as s:
                    await lease.checkpoint(s, current_phase=nxt, progress=_PHASE_FLOOR[nxt])
        except Superseded as exc:
            logger.info("purge %s handed off: %s", job_id, exc)
            return {"job_id": job_id, "status": "superseded"}
        except (Draining, asyncio.CancelledError) as exc:
            # The worker is stopping: hand the job back for another to carry on. Shielded — the
            # release must land even as this task is cancelled.
            try:
                await asyncio.shield(lease.release())
            except Exception:  # noqa: BLE001 — unreleased, it goes stale and is taken over
                logger.exception("releasing purge %s failed", job_id)
            if isinstance(exc, asyncio.CancelledError):
                raise
            return {"job_id": job_id, "status": "released"}
        except PurgeRefused as exc:
            logger.error("purge %s REFUSED: %s", job_id, exc.reason)
            await self._fail(lease, exc.reason, exc.code)
            return {"job_id": job_id, "status": "failed", "error": exc.reason}
        except Exception as exc:                                # pragma: no cover - infra
            logger.exception("purge %s crashed", job_id)
            await self._fail(lease, str(exc)[:400], "infrastructure")
            return {"job_id": job_id, "status": "failed"}

    async def _fail(self, lease: Lease, reason: str, code: str) -> None:
        # Fenced: a purge taken over (or cancelled) is its owner's to record, not ours.
        if not await lease.fail(reason, code, "resume" if code == "infrastructure" else None):
            logger.info("purge %s: not failed — it is no longer this worker's", lease.job_id)

    async def _run_phase(self, phase: str, lease: Lease, graph_id: str) -> bool:
        if phase == "count":
            return await self._phase_count(lease, graph_id)
        if phase in _PHASE_TABLE:
            return await self._delete_window(lease, graph_id, *_PHASE_TABLE[phase])
        if phase == "falkor":
            return await self._phase_falkor(lease, graph_id)
        if phase == "meta":
            return await self._phase_meta(lease, graph_id)
        if phase == "finalize":
            return await self._phase_finalize(lease, graph_id)
        raise PurgeRefused(f"unknown purge phase {phase!r}", "internal")

    # ---------------------------------------------------------------- phases --
    async def _phase_count(self, lease: Lease, graph_id: str) -> bool:
        """Establish the denominator — and check, ONCE, that we are allowed to do this at all."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                # Already gone. A replayed purge is a no-op, not an error.
                logger.info("purge %s: graph %s already gone", lease.job_id, graph_id)
                await lease.finish("completed", current_phase=None, progress=100)
                raise Superseded("nothing to purge")

            # ── THE GATE ── Soft-delete is the ONLY thing that authorises destruction. It is
            # set by the one code path a human actually confirmed. Without this, a stray job row
            # with a live graph_id would quietly shred a working graph.
            if graph.deleted_at is None:
                raise PurgeRefused(
                    "this graph is still live — a purge only ever runs on a graph that was "
                    "explicitly deleted", "graph_not_deleted")
            forks = await _forks_reading(s, graph)
            if forks:
                raise PurgeRefused(f"{forks} fork(s) still read this graph's history", "live_forks")

            # Nothing else runs on a graph being destroyed. Cancelled with the checkpoint below,
            # so a purge that is no longer ours cancels nothing.
            await s.execute(update(JobORM).where(
                JobORM.graph_id == graph_id, JobORM.id != lease.job_id,
                JobORM.status.in_(("pending", "running")),
            ).values(status="cancelled", error_message="the graph is being permanently deleted",
                     completed_at=_now(), updated_at=_now()))

            total = 0
            for table, _pk in _BULK:
                total += int(await s.scalar(text(
                    f'SELECT count(*) FROM "{_sch()}"."{table}" WHERE graph_id = :g'
                ), {"g": graph_id}) or 0)

            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            summary["rows"] = total
            await lease.checkpoint(s, total=total, processed=0, summary=summary)
        logger.info("purge %s: %s rows to reclaim for graph %s", lease.job_id, total, graph_id)
        return True

    async def _delete_window(self, lease: Lease, graph_id: str, table: str, pk: str) -> bool:
        """Delete up to one window of rows (:func:`delete_window`). Returns True when the table is
        empty for this graph. The window's progress is a fenced checkpoint in the same transaction,
        so a worker that lost the job rolls its delete back rather than racing the new owner."""
        async with self._session() as s:
            deleted = await delete_window(s, table, pk, graph_id)
            if deleted:
                job = await s.get(JobORM, lease.job_id)
                processed = (job.processed or 0) + deleted
                progress = {}
                if job.total:
                    span = 92 - _PHASE_FLOOR["edges"]          # count..falkor occupy 1%..92%
                    progress["progress"] = min(92, 1 + int(span * processed / job.total))
                await lease.checkpoint(s, processed=processed, **progress)
        return deleted == 0

    async def _phase_falkor(self, lease: Lease, graph_id: str) -> bool:
        """Drop the projected FalkorDB graph — if, and only if, it is ours to drop and nothing else
        reads it — and, by the same rule, each old key a move left waiting to be dropped
        (``retired_keys``) that holds the projector's pass marker or is one of the graph's own
        platform keys."""
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
            name = ps.falkor_graph_name if ps else None
            owned = bool(ps.owns_falkor_graph) if ps else False
            provider = ps.falkor_provider if ps else None
            retired = list(ps.retired_keys or []) if ps else []
            ds_id = getattr(await s.get(JobORM, lease.job_id), "data_source_id", None)

        async def verdict_for(name, provider, owned, *, marked: bool = False) -> str:
            shared_with = 0
            if name:
                async with self._session() as s:
                    # Belt and braces: even a graph we minted must not be dropped while another
                    # SURVIVING graph still projects into it. Ownership answers "did we make this?";
                    # this answers "is anyone still using it?".
                    shared_with = int(await s.scalar(text(
                        f'SELECT count(*) FROM "{_sch()}"."projection_state" p '
                        f'JOIN "{_sch()}"."graphs" g ON g.id = p.graph_id '
                        f'WHERE p.falkor_graph_name = :n AND p.graph_id <> :g '
                        f'  AND g.deleted_at IS NULL'
                    ), {"n": name, "g": graph_id}) or 0)

            # Ownership says we made the key; it does not say nobody else reads it now — another
            # data source bound to the same name, or a catalog entry publishing it. Asked last (only
            # of a key we would otherwise drop), and an answer we cannot get keeps the key: fail
            # closed.
            readers: Optional[List[dict]] = []
            if name and owned and not shared_with:
                try:
                    readers = await self._key_in_use(provider, name, ds_id)
                except Exception:                               # noqa: BLE001 — fail closed
                    logger.warning("purge %s: could not ask who reads '%s'", lease.job_id, name,
                                   exc_info=True)
                    readers = None

            if not name:
                return "no projected graph"
            if not owned:
                return f"PROTECTED: '{name}' is not ours (we did not create it) — left untouched"
            if shared_with:
                return f"PROTECTED: '{name}' is still projected by {shared_with} live graph(s)"
            if readers is None:
                return f"PROTECTED: could not check what else reads '{name}' — left untouched"
            if readers:
                return (f"PROTECTED: '{name}' is still read by {len(readers)} data source(s) or "
                        "catalog entr(ies) — left untouched")
            if self._factory is None:
                return f"skipped: no graph client configured — '{name}' left in place"
            try:
                client = self._factory(name, provider)
                if inspect.isawaitable(client):
                    client = await client
                if marked:
                    # A key the projector wrote carries its pass marker; one without it is not
                    # a key we can vouch for, unless it is one of the graph's own platform keys,
                    # which a reseed cut short leaves without one.
                    from . import keymigrate
                    from .projection import read_projection_marker
                    exists, seq = await read_projection_marker(client)
                    if exists is False:
                        return f"'{name}' was already gone"
                    if seq is None and not keymigrate.is_owned_key(graph_id, name):
                        return (f"PROTECTED: '{name}' holds no projection marker of ours — "
                                "left untouched")
                await client.delete()
                logger.warning("purge %s DROPPED FalkorDB graph %s (we created it)",
                               lease.job_id, name)
                # A graph later written under the same name gets a new id catalogue;
                # every long-lived reader must drop its old one (graph_generation).
                from backend.app.providers.graph_generation import bump_graph_generation
                await bump_graph_generation(name, reason=f"purge {lease.job_id}")
                return f"dropped '{name}'"
            except Exception as exc:                            # pragma: no cover - infra
                # A leaked FalkorDB graph is recoverable (cleanup script). Failing the whole
                # purge over it — and stranding millions of SQL rows — is not an improvement.
                verdict = f"could not drop '{name}': {exc}"
                logger.warning("purge %s: %s", lease.job_id, verdict)
                return verdict

        verdict = await verdict_for(name, provider, owned)
        # Every key a move left is one we owned: the move refuses any other.
        gone = []
        for entry in retired:
            gone.append({"name": entry["name"], "provider": entry.get("provider"),
                         "verdict": await verdict_for(entry["name"], entry.get("provider"), True,
                                                      marked=True)})

        async with self._session() as s:
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            summary["falkor"] = {"name": name, "owned": owned, "verdict": verdict,
                                 "retired": gone}
            await lease.checkpoint(s, summary=summary)
        logger.info("purge %s falkor: %s (%d old key(s) of a move)", lease.job_id, verdict,
                    len(gone))
        return True

    async def _phase_meta(self, lease: Lease, graph_id: str) -> bool:
        """The small tables. Bounded by branch/job count, so one statement each is fine."""
        sch = _sch()
        async with self._session() as s:
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
                await s.execute(text(sql), {"g": graph_id, "j": lease.job_id})
            await lease.checkpoint(s)                          # fenced: still ours, or roll back
        return True

    async def _phase_finalize(self, lease: Lease, graph_id: str) -> bool:
        async with self._session() as s:
            await s.execute(text(f'DELETE FROM "{_sch()}"."graphs" WHERE id = :g'),
                            {"g": graph_id})
            await lease.checkpoint(s)                          # fenced: still ours, or roll back
        return True


# ------------------------------------------------------------------ enqueue --
async def create_purge_job(*, graph_id: str, workspace_id: Optional[str], actor: str,
                           data_source_id: Optional[str] = None,
                           session_factory=None, session=None,
                           require_tombstoned: bool = False) -> Optional[str]:
    """Soft-delete the graph and enqueue its purge, in ONE transaction.

    The two must be atomic. A soft-delete with no job leaks the rows forever (that is exactly the
    bug we are fixing). A job with no soft-delete is refused by `_phase_count` — safe, but it
    would mean a delete that silently did nothing.

    ``session`` makes that transaction the caller's: abandoning a bootstrap cancels its job and
    queues this purge as one commit, so the graph is never cancelled-but-not-queued.

    Idempotent: a second delete of the same graph returns the job already in flight, and queues
    a FAILED one again (its phase kept — DELETE is idempotent, so it carries on) rather than
    adding another beside it: ``purge:{graph_id}`` is unique whatever the job's status
    (``ix_jobs_idem_active``).

    ``require_tombstoned`` is the reaper's: it acts on a graph only while it is still in the
    trash — a restore that took the graph row first wins — and re-queues only a purge that failed
    on infrastructure, or was refused for forks that no longer read the graph, never one refused
    for anything else. A graph that forks still read is not purged: the reaper leaves it (None);
    anyone else is refused (:class:`PurgeRefused` ``live_forks``). A trashed minted fork that no
    fork reads through is no reader: it is purged with its parent (:func:`_queue_trashed_forks`).
    """
    from .service import GraphVersioningService

    sf = session_factory or db.graphver_session
    async with (contextlib.nullcontext(session) if session is not None else sf()) as s:
        # Jobs, the lifecycle key, then graphs (15 §8). The graph row is the one restore locks, so
        # whichever of the two commits second sees what the other did. The key makes the draft
        # saves that start after us wait for us; its wait, and the row's, are bounded (LockBusy).
        existing = (await s.execute(
            select(JobORM).where(
                JobORM.job_type == PURGE_JOB_TYPE,
                JobORM.graph_id == graph_id,
                JobORM.status.in_(("pending", "running", "failed")),
            ).order_by(JobORM.created_at.desc()).limit(1).with_for_update())).scalars().first()
        await GraphVersioningService._lock_lifecycle(s, graph_id)
        graph = (await GraphVersioningService._bounded_lock(
            s, select(GraphORM).where(GraphORM.id == graph_id).with_for_update(),
            f"graph {graph_id}")).scalars().first()
        if graph is None:
            return None
        if require_tombstoned and graph.deleted_at is None:
            logger.info("purge skipped: graph %s was restored", graph_id)
            return None

        # Then its forks (parent before child), FOR KEY SHARE: a fork's restore or purge (FOR
        # UPDATE) waits for this decision or is seen by the count; a fork's commits do not wait.
        await s.execute(select(GraphORM.id).where(GraphORM.fork_parent_graph_id == graph_id)
                        .order_by(GraphORM.id).with_for_update(read=True, key_share=True))
        forks = await _forks_reading(s, graph)
        if forks:
            reason = f"{forks} fork(s) still read this graph's history"
            if require_tombstoned:
                logger.warning("purge of graph %s skipped: %s", graph_id, reason)
                return None
            raise PurgeRefused(reason, "live_forks")

        if existing is not None and existing.status != "failed":
            return existing.id
        if existing is not None and require_tombstoned and \
                ((existing.summary or {}).get("failure") or {}).get("code") \
                not in ("infrastructure", "live_forks"):
            logger.warning("purge %s of graph %s was refused; not re-queueing it", existing.id,
                           graph_id)
            return None

        await _queue_trashed_forks(s, graph_id, actor)
        graph.deleted_at = graph.deleted_at or _now()
        graph.deleted_by = graph.deleted_by or actor

        if existing is not None:
            summary = dict(existing.summary or {})
            summary.pop("failure", None)
            summary.pop("takeovers", None)       # a fresh poison count: someone asked again
            existing.summary = summary
            existing.status = "pending"
            existing.error_message = existing.completed_at = None
            existing.updated_at = _now()
            logger.info("purge re-queued for graph %s (job=%s, by %s)", graph_id, existing.id, actor)
            return existing.id

        job = _new_purge_job(graph, actor=actor, workspace_id=workspace_id,
                             data_source_id=data_source_id)
        s.add(job)
        await s.flush()
        logger.info("purge queued for graph %s (job=%s, by %s)", graph_id, job.id, actor)
        return job.id


def _new_purge_job(graph, *, actor: str, workspace_id: Optional[str] = None,
                   data_source_id: Optional[str] = None,
                   summary: Optional[dict] = None) -> JobORM:
    return JobORM(
        job_type=PURGE_JOB_TYPE,
        graph_id=graph.id,
        workspace_id=workspace_id or graph.workspace_id,
        data_source_id=data_source_id or graph.data_source_id,
        status="pending",
        current_phase="count",
        idempotency_key=f"purge:{graph.id}",
        summary=summary or {"actor": actor},
    )


async def _queue_trashed_forks(s, graph_id: str, actor: str) -> None:
    """Queue a purge, in the caller's transaction, for each trashed minted fork under ``graph_id``,
    at any depth through trashed minted forks, that no fork reads (:func:`_forks_reading`) and
    has no purge job: a fork cannot outlive the history it reads, and once queued it is past its
    undo. The caller holds the direct fork rows (FOR KEY SHARE); the deeper ones are locked so
    here first, and only then checked for a job, so a fork's own purge (the reaper's, which holds
    its row FOR UPDATE) is waited for and seen, not queued twice. A deeper fork's restore is
    refused while its parent is trashed."""
    tree = select(GraphORM.id).where(
        GraphORM.fork_parent_graph_id == graph_id, GraphORM.deleted_at.isnot(None),
        _minted(GraphORM)).cte("tree", recursive=True)
    child = aliased(GraphORM)
    tree = tree.union_all(select(child.id).where(
        child.fork_parent_graph_id == tree.c.id, child.deleted_at.isnot(None), _minted(child)))
    await s.execute(select(GraphORM.id).where(GraphORM.id.in_(select(tree.c.id)))
                    .order_by(GraphORM.id).with_for_update(read=True, key_share=True))
    forks = [f for f in (await s.execute(select(GraphORM).where(
        GraphORM.id.in_(select(tree.c.id)),
        ~select(JobORM.id).where(JobORM.job_type == PURGE_JOB_TYPE,
                                 JobORM.graph_id == GraphORM.id).exists(),
    ))).scalars().all() if not await _forks_reading(s, f)]
    for f in forks:
        s.add(_new_purge_job(f, actor=actor, summary={"actor": actor, "parentGraphId": graph_id}))
    if forks:
        await s.flush()
        logger.info("purge queued for the trashed forks %s of graph %s (by %s)",
                    [f.id for f in forks], graph_id, actor)


async def purge_graph_for_data_source(*, data_source_id: str, workspace_id: str,
                                      actor: str, require_tombstoned: bool = False) -> List[str]:
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
                                     data_source_id=data_source_id,
                                     require_tombstoned=require_tombstoned)
        if jid:
            jobs.append(jid)
    return jobs


# ---------------------------------------------------------------- the undo window --
def _purge_jobs_of(data_source_id: str, deleted_at: Optional[str] = None):
    """Every purge job, in any status, of a graph the data source still has. A purge that
    completed took its graph row with it, so it no longer counts: the purge of a graph whose
    enablement was abandoned must not hold its data source back later. Unless it was queued
    since the data source went to the trash (``deleted_at``): that purge destroyed what a
    restore would bring back, and the reaper removes the row only on a later pass."""
    of_graph = JobORM.graph_id.in_(
        select(GraphORM.id).where(GraphORM.data_source_id == data_source_id))
    if deleted_at is not None:
        of_graph = or_(of_graph, and_(JobORM.data_source_id == data_source_id,
                                      JobORM.created_at >= deleted_at))
    return and_(JobORM.job_type == PURGE_JOB_TYPE, of_graph)


async def tombstone_graphs_for_data_source(*, data_source_id: str, workspace_id: str,
                                           actor: str) -> int:
    """Hide a data source's graphs WITHOUT queueing anything. The reversible half of delete.

    No purge job is created. The tombstone's age is the only schedule there is, and the reaper
    (below) is what eventually acts on it — which is precisely what leaves room for an undo.

    A graph busy past ``GRAPH_LOCK_TIMEOUT_MS`` (a long import or save) is :class:`LockBusy`, and
    nothing is trashed.
    """
    from .service import GraphVersioningService

    of_source = (GraphORM.data_source_id == data_source_id, GraphORM.workspace_id == workspace_id,
                 GraphORM.deleted_at.is_(None))
    async with db.graphver_session() as s:
        # Each graph's lifecycle key first (15 §8), so the draft saves that start after us wait for
        # us; then FOR UPDATE, not the UPDATE's own FOR NO KEY UPDATE: a fork or fork restore reads
        # the parent FOR KEY SHARE, so it waits for this and sees the graph trashed, or we wait for
        # it. Both waits are bounded.
        for gid in sorted((await s.execute(select(GraphORM.id).where(*of_source))).scalars().all()):
            await GraphVersioningService._lock_lifecycle(s, gid)
        graphs = (await GraphVersioningService._bounded_lock(
            s, select(GraphORM).where(*of_source).with_for_update(),
            f"data source {data_source_id}")).scalars().all()
        for g in graphs:
            g.deleted_at = _now()
            g.deleted_by = actor
    return len(graphs)


@dataclass(frozen=True)
class PurgeState:
    """Where a data source's purge stands, and why it is stuck — what the trash shows.

    ``state``: ``none`` (nothing queued), ``queued`` (pending or running), ``failed`` (it stopped;
    ``reason`` is the job's own) or ``blocked`` (``forks`` forks still read a graph's history, so
    no purge of it goes through, whoever asks). ``final``: a purge job exists, in any status, so
    there is no undo (:func:`restore_graphs_for_data_source`)."""

    state: str = "none"
    reason: Optional[str] = None
    forks: int = 0
    final: bool = False


async def _purge_state(s, data_source_id: str, deleted_at: Optional[str] = None) -> PurgeState:
    jobs = (await s.execute(select(JobORM.status, JobORM.error_message, JobORM.summary)
                            .where(_purge_jobs_of(data_source_id, deleted_at))
                            .order_by(JobORM.created_at.desc()))).all()
    forks = 0
    for g in (await s.execute(select(GraphORM).where(
            GraphORM.data_source_id == data_source_id))).scalars().all():
        forks += await _forks_reading(s, g)
    final = bool(jobs)
    if forks:
        return PurgeState("blocked", f"{forks} fork(s) still read this graph's history",
                          forks, final)
    if any(status in ("pending", "running") for status, _e, _s in jobs):
        return PurgeState("queued", final=True)
    for status, error, summary in jobs:
        if status == "failed":
            reason = ((summary or {}).get("failure") or {}).get("reason") or error
            return PurgeState("failed", reason, final=True)
    return PurgeState(final=final)


async def restore_graphs_for_data_source(*, data_source_id: str, workspace_id: str,
                                         deleted_at: Optional[str] = None) -> PurgeState:
    """Bring a data source's graphs back, unless it is too late: then nothing changes, and the
    purge state that refused it is returned (``final``, with its reason).

    TOO LATE MEANS: a purge job exists, in any status — a failed one has already deleted part
    of the graph, and a completed one queued since ``deleted_at`` (the data source's trash time)
    all of it. That is the whole concurrency design — rather than trying to cancel a purge
    mid-flight and stitch a half-deleted graph back together, restore simply REFUSES once a purge
    has been queued. A purge and a restore can therefore never overlap, and there is no
    partial-restore state to reason about. The row lock below serialises us against the reaper
    deciding to queue one at this exact moment. It is taken after each graph's lifecycle key (15
    §8), and both waits are bounded (:class:`LockBusy`).
    """
    from .service import GraphVersioningService

    of_source = (GraphORM.data_source_id == data_source_id, GraphORM.workspace_id == workspace_id)
    async with db.graphver_session() as s:
        for gid in sorted((await s.execute(select(GraphORM.id).where(*of_source))).scalars().all()):
            await GraphVersioningService._lock_lifecycle(s, gid)
        graphs = (await GraphVersioningService._bounded_lock(
            s, select(GraphORM).where(*of_source).with_for_update(),
            f"data source {data_source_id}")).scalars().all()

        state = await _purge_state(s, data_source_id, deleted_at)
        if state.final:
            return state                           # being (or already) destroyed — cannot undo

        for g in graphs:
            g.deleted_at = None
            g.deleted_by = None
    return state


async def purge_state_for_data_source(*, data_source_id: str,
                                      deleted_at: Optional[str] = None) -> PurgeState:
    """Where this data source's purge stands (:class:`PurgeState`). Drives the trash UI: "Being
    deleted", the reason a purge failed, or the forks blocking it. A failed purge is past the
    point of no return too: restore refuses it."""
    async with db.graphver_session() as s:
        return await _purge_state(s, data_source_id, deleted_at)


# ------------------------------------------------------------------------ a move --
class MoveBlocked(Exception):
    """A data source's versioned graph can't move to another workspace yet. The message says
    why, as a sentence the person moving it can act on. Nothing was changed."""


async def rehome_graph_for_data_source(*, data_source_id: str, to_workspace_id: str,
                                       refuse_busy: bool = True) -> Optional[str]:
    """File a data source's versioned graph, with its forks and their jobs, under
    ``to_workspace_id``, from wherever it is filed now. Returns the graph's id, or None when the
    source has no versioned graph. The transfer engine's way in — a move, an accepted request, an
    undo, and a failed one putting the graph back (``services/data_source_transfer.py``);
    :meth:`~.service.GraphVersioningService.move_graph_workspace` takes the locks and moves them.

    The graph records its workspace for itself, and every tenant check on it reads that: the
    graph routes, resolving a source to its graph, enablement, the trash and the purge. Keyed by
    the data source alone, and it sets rather than swaps, so a retried move lands the same way
    and a graph a failure left elsewhere is set right. Open drafts and review requests go with
    it. Every refusal is :class:`MoveBlocked`, with nothing written: the graph's lock not granted
    in time, or another request moving the graph meanwhile; and with ``refuse_busy`` — a
    person's move — a job pending or running on the graph or a fork of it (a job runs in the
    workspace it was queued in), or a failed attempt to turn version control on, waiting to be
    resumed or cancelled. Putting the graph back after a failed move runs with it off: the source
    never left, so its graph, and any job started on it meanwhile, belong where it is.
    """
    from .service import GraphVersioningService

    async with db.graphver_session() as s:
        at = await s.scalar(select(GraphORM.workspace_id).where(
            GraphORM.data_source_id == data_source_id))
    if at is None:
        return None
    try:
        ids = await GraphVersioningService().move_graph_workspace(
            data_source_id, to_workspace_id, from_workspace_id=at,
            refuse_failed_enable=refuse_busy, refuse_active_jobs=refuse_busy)
    except JobActive as busy:
        raise MoveBlocked(str(busy)) from busy
    except LockBusy as busy:
        raise MoveBlocked(
            "Version history is being written right now; try again shortly.") from busy
    except GraphMoved as moved:
        raise MoveBlocked(
            "Another request moved its version history meanwhile; try again.") from moved
    return ids[0] if ids else None


#: How long a data source made from a view package may stand without its versioned graph before the
#: reaper tombstones it: the request that made it died before queueing the seed, and nobody retried.
ORPHAN_PACKAGE_SOURCE_SECS = 3600

#: Expired data sources whose graph the reaper left standing, so it says so once, not every pass.
_LEFT_STANDING: set = set()


class Reaper:
    """Turns expired tombstones into purges, and then into nothing.

    The grace period lives here and nowhere else. A data source deleted 31 days ago is not a
    scheduling problem — it is just a row whose `deleted_at` is older than the cutoff. Asking that
    question every 15 minutes is the entire mechanism.

    It runs in three stages per data source, and stops at whichever one is still in progress:
      1. tombstone expired, no purge queued  -> queue one
      2. purge queued, not finished          -> leave it alone
      3. purge finished (or never needed)    -> hard-delete the data-source row; it is now gone

    It also tombstones a data source made from a view package that has stood without a graph for
    ``ORPHAN_PACKAGE_SOURCE_SECS`` (:meth:`_orphaned_package_sources`); the stages above take it
    from there. And before any of it, it files each graph, with its forks, under its data source's
    workspace where the two disagree (:meth:`_misplaced_graphs`), so the stages find the graphs
    they look for.

    A trashed fork has no data-source row (its ``dsfork_`` id is minted, not stored), so its own
    tombstone's age is its schedule (:meth:`_expired_forks`).
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

        rehomed = await self._misplaced_graphs()
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
            try:
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
                        data_source_id=ds_id, workspace_id=ws_id, actor=actor or "reaper",
                        require_tombstoned=True)
                    if jobs:
                        queued += len(jobs)
                        logger.info("reaper: grace expired for %s — purge queued %s", ds_id, jobs)
                    elif ds_id not in _LEFT_STANDING:
                        # Restored under us, read by a fork, or tombstoned without its graph
                        # (a force-delete whose graph tombstone failed; a graph filed under
                        # another workspace, which _misplaced_graphs re-files once no job
                        # runs on it). Its row is never removed while a graph of it stands.
                        _LEFT_STANDING.add(ds_id)
                        logger.warning("reaper: %s is past its grace period but its graph was "
                                       "not purged; leaving both alone", ds_id)
                    continue          # the row goes on a later pass, once no graph is left
                if unfinished:
                    continue              # still being destroyed

                # Nothing left to purge (graph gone, or it never had one). The tombstone is the
                # last trace of this data source, and its time is up.
                #
                # COMMIT EXPLICITLY. Unlike `graphver_session`, the app session factory does not
                # commit on context exit — the first cut of this silently rolled the delete back
                # and still counted it, so the reaper reported work it had not done. A janitor
                # that lies about what it reclaimed is worse than one that does nothing.
                async with Session() as s:
                    row = await s.get(WorkspaceDataSourceORM, ds_id)
                    if row is not None and row.deleted_at is not None:
                        await s.delete(row)
                        await s.commit()
                        reaped += 1
                        logger.info("reaper: %s is past its grace period and is now gone", ds_id)
            except Exception:
                logger.exception("reaper: %s failed; carrying on with the rest", ds_id)
        queued += await self._expired_forks(cutoff)

        # A purge that failed on infrastructure, or was refused for forks (queued again only once
        # none reads the graph), is queued again — including one whose data source row is
        # already gone ("Delete permanently"), which the loop above never sees.
        async with self._gv() as gs:
            failed = (await gs.execute(
                select(JobORM.graph_id).join(GraphORM, GraphORM.id == JobORM.graph_id).where(
                    JobORM.job_type == PURGE_JOB_TYPE, JobORM.status == "failed",
                    JobORM.summary["failure"]["code"].astext.in_(("infrastructure", "live_forks")),
                    GraphORM.deleted_at.isnot(None)))).scalars().all()
        revived = 0
        for gid in failed:
            try:
                if await create_purge_job(graph_id=gid, workspace_id=None, actor="reaper",
                                          require_tombstoned=True, session_factory=self._gv):
                    revived += 1
            except Exception:
                logger.exception("reaper: re-queueing the purge of graph %s failed", gid)

        orphans = await self._orphaned_package_sources()
        if queued or reaped or orphans or revived or rehomed:
            logger.info("reaper: %s purge(s) queued, %s re-queued, %s data source(s) removed, %s "
                        "orphaned package source(s) tombstoned, %s graph(s) re-filed", queued,
                        revived, reaped, orphans, rehomed)
        return {"queued": queued, "reaped": reaped, "orphans": orphans, "revived": revived,
                "rehomed": rehomed}

    async def _expired_forks(self, cutoff: str) -> int:
        """Queue the purge of each trashed fork whose grace ran out by ``cutoff``. One whose purge
        exists is skipped, whatever its status: a failed one is the revive pass's."""
        async with self._gv() as gs:
            expired = (await gs.execute(
                select(GraphORM.id, GraphORM.workspace_id, GraphORM.deleted_by).where(
                    GraphORM.fork_parent_graph_id.isnot(None), GraphORM.deleted_at.isnot(None),
                    GraphORM.deleted_at < cutoff,
                    ~select(JobORM.id).where(JobORM.job_type == PURGE_JOB_TYPE,
                                             JobORM.graph_id == GraphORM.id).exists()))).all()
        queued = 0
        for gid, ws_id, actor in expired:
            try:
                if await create_purge_job(graph_id=gid, workspace_id=ws_id,
                                          actor=actor or "reaper", require_tombstoned=True,
                                          session_factory=self._gv):
                    queued += 1
                    logger.info("reaper: grace expired for fork %s — purge queued", gid)
            except Exception:
                logger.exception("reaper: fork %s failed; carrying on with the rest", gid)
        return queued

    async def _misplaced_graphs(self) -> int:
        """File each data source's versioned graph, with its forks, under the data source's
        workspace where the two disagree.

        A source moved before moves carried their graphs leaves its graph filed under the old
        workspace — readable there, external where the source went, and missed by the trash and
        the purge — and so does a move whose graph could not be put back after its data source
        failed to commit. The management database decides tenancy, so the graph follows its
        source, tombstone and all: a source in the trash whose graph is still live gets the delete
        it missed, in the same transaction. It is a data-source move without the refusal a
        person's move meets while an enable that failed waits (the source already lives
        elsewhere); open drafts and reviews go with it, as with any move, and a graph a job still
        runs on waits for a later pass: a job runs in the workspace it was queued in. A move, an
        accepted request and an undo hold the source's row FOR UPDATE from before its graph moves
        until the source commits, so the row is read again FOR UPDATE SKIP LOCKED and held while
        the graph moves: a move in flight is skipped, left to finish, and so is a source another
        reaper is re-filing. A fork moves with its graph, never on its own; a graph whose source
        row is gone is the purge's business, not this."""
        from backend.app.db.models import WorkspaceDataSourceORM as DS
        from .service import GraphVersioningService

        async with self._gv() as gs:
            graphs = (await gs.execute(select(
                GraphORM.data_source_id, GraphORM.workspace_id, GraphORM.deleted_at,
            ).where(GraphORM.fork_parent_graph_id.is_(None)))).all()
        if not graphs:
            return 0
        ids = [ds_id for ds_id, _ws, _deleted in graphs]
        homes: Dict[str, Tuple[str, Optional[str]]] = {}
        Session = self._app_sessions()
        async with Session() as s:
            for i in range(0, len(ids), 500):
                homes.update({ds_id: (ws_id, deleted) for ds_id, ws_id, deleted in (await s.execute(
                    select(DS.id, DS.workspace_id, DS.deleted_at).where(DS.id.in_(ids[i:i + 500]))
                )).all()})

        svc = GraphVersioningService(session_factory=self._gv)
        refiled = 0
        for ds_id, ws_id, graph_deleted in graphs:
            home = homes.get(ds_id)
            if home is None or home[0] == ws_id:
                continue
            try:
                async with Session() as s:
                    home = (await s.execute(select(DS.workspace_id, DS.deleted_at).where(
                        DS.id == ds_id).with_for_update(skip_locked=True))).first()
                    if home is None or home[0] == ws_id:
                        continue              # held by a move or another reaper, gone, or in place
                    to_ws, source_deleted = home
                    await svc.move_graph_workspace(
                        ds_id, to_ws, from_workspace_id=ws_id, refuse_failed_enable=False,
                        tombstone_by="reaper" if source_deleted and not graph_deleted else None)
            except JobActive:
                logger.info("reaper: %s's graph is filed under %s; re-filed once its job ends",
                            ds_id, ws_id)
                continue
            except Exception:
                logger.exception("reaper: re-filing %s's graph failed; carrying on with the rest",
                                 ds_id)
                continue
            refiled += 1
            logger.info("reaper: %s's graph was filed under %s; its source lives in %s — re-filed",
                        ds_id, ws_id, to_ws)
        return refiled

    async def _orphaned_package_sources(self) -> int:
        """Tombstone each live data source made from a view package (``extra_config.origin.kind =
        'viewPackage'``) that has had no live versioned graph for ``ORPHAN_PACKAGE_SOURCE_SECS``.

        "New source from a package" creates the data source, then its graph and seed job, in two
        databases with no transaction across them. A request that died in between left a source
        with nothing behind it — retrying it reuses that source (within the hour), and this
        clears what nobody came back for. A tombstone, not a delete: it takes the usual grace
        period, and a restore within it brings the source back."""
        from backend.app.db.models import WorkspaceDataSourceORM as DS
        from backend.app.db.repositories import data_source_repo
        from backend.app.services.managed_sources import origin_of

        cutoff = _now_minus(ORPHAN_PACKAGE_SOURCE_SECS)
        Session = self._app_sessions()
        async with Session() as s:
            rows = (await s.execute(select(DS.id, DS.extra_config).where(
                DS.deleted_at.is_(None), DS.created_at < cutoff,
                DS.extra_config.contains("viewPackage")))).all()
        candidates = [ds_id for ds_id, extra in rows
                      if (origin_of(extra) or {}).get("kind") == "viewPackage"]
        if not candidates:
            return 0
        async with self._gv() as gs:
            standing = set((await gs.execute(select(GraphORM.data_source_id).where(
                GraphORM.data_source_id.in_(candidates),
                GraphORM.deleted_at.is_(None)))).scalars().all())
        tombstoned = 0
        for ds_id in candidates:
            if ds_id in standing:
                continue
            async with Session() as s:
                if await data_source_repo.soft_delete_data_source(s, ds_id, actor="reaper"):
                    await s.commit()                   # the app session doesn't commit on exit
                    tombstoned += 1
                    logger.info("reaper: %s was made from a view package and never got its "
                                "graph — tombstoned", ds_id)
        return tombstoned
