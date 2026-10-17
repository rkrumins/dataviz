"""One job contract for every worker lane: claim, lease, fence, heartbeat, release.

``graphver.jobs`` is the durable queue for transfer jobs (import, export, publish, package
inspect), bootstraps (graph and package seeds) and purges. This module is the ONE implementation
of what used to be three slightly different copies (bootstrap_worker, purge_worker,
import_export/runner):

* **Claim** — one transaction, ``FOR UPDATE OF jobs SKIP LOCKED``: a job goes to exactly one
  worker, and no worker waits on another's claim. A job is claimable when it is pending and READY
  (each lane says what ready means: a transfer job once its creator queued it, a bootstrap unless
  it is paused for a decision, a purge always), or running with a heartbeat older than
  ``INGEST_STALE_SECS`` — its worker died, and the job is taken over where it stopped.
* **Epoch** — EVERY claim bumps ``retry_count``, so ``(id, epoch)`` names exactly one ownership. The
  old rule (only a takeover bumped it) let a re-queued job and the zombie still running it share an
  epoch, and both write.
* **Fencing** — every write to the job row is a compare-and-set on ``(id, epoch, status='running'
  [, cursor])``, made in the SAME transaction as the work it records. A superseded worker's window
  therefore rolls back with its job-row write, instead of landing beside the new owner's.
* **Liveness** — a heartbeat THREAD (:class:`LeaseKeeper`), not an asyncio task: a window that holds
  the event loop for a minute of CPU must not look dead and have its job stolen. And because a loop
  that never comes back would hold its leases forever, the keeper exits a wedged process.
* **Fairness** — a claim prefers the workspace running the fewest jobs of its kind (a soft cap of
  ``JOBS_PER_WORKSPACE``), runs ``package_inspect`` first, and can cap how many bootstraps scan one
  FalkorDB provider at once.

What a worker does with a :class:`Lease`: ``check()`` between units of work; end each unit's
transaction with ``checkpoint(s, ...)``; ``finish``/``fail`` at the end; ``release()`` when told to
drain. It never UPDATEs its job row any other way.
"""
from __future__ import annotations

import asyncio
import contextlib
import faulthandler
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Optional, Sequence, Set, Tuple

from sqlalchemy import Integer, Text, bindparam, exists, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.exc import DisconnectionError, InterfaceError, OperationalError, SQLAlchemyError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from backend.app.observability import event_loop_monitor

from . import config, db
from .models import ImportRowORM, JobORM

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Job types, phases and what "ready to run" means per lane                     #
# --------------------------------------------------------------------------- #
# The phase of a pending transfer job that is ready to run: its inputs are stored and its creator
# queued it. Before that it is pending with no phase, and no worker may take it.
QUEUED = "queued"
# The phase of a bootstrap paused for a person's decision (duplicate identifiers found by the
# pre-flight). Stored as status 'pending' so every "is a job in flight?" check still sees it, and
# excluded from claims so it holds no slot while it waits.
AWAITING_DECISION = "awaiting_decision"

# The transfer lane's general slots, and its dedicated inspect slot.
TRANSFER_TYPES: Tuple[str, ...] = ("ingest", "export", "publish")
INSPECT_TYPES: Tuple[str, ...] = ("package_inspect",)
BOOTSTRAP_TYPES: Tuple[str, ...] = ("bootstrap",)
PURGE_TYPES: Tuple[str, ...] = ("purge",)
# Released transfer jobs go back to QUEUED; other types keep the phase they stopped in.
_QUEUED_TYPES = frozenset(TRANSFER_TYPES + INSPECT_TYPES)

# ``phase_pred`` for :func:`claim`: which PENDING rows are ready, as SQL over the jobs row
# aliased ``j``. Constants only — never built from input.
TRANSFER_READY = f"j.current_phase = '{QUEUED}'"
BOOTSTRAP_READY = f"j.current_phase IS DISTINCT FROM '{AWAITING_DECISION}'"
PURGE_READY = "TRUE"

# What each lane claims, as (types, phase_pred) per runner — for the system-status backlog probe.
LANE_CLAIMS: Dict[str, Tuple[Tuple[Tuple[str, ...], str], ...]] = {
    "transfer": ((TRANSFER_TYPES, TRANSFER_READY), (INSPECT_TYPES, TRANSFER_READY)),
    "bootstrap": ((BOOTSTRAP_TYPES, BOOTSTRAP_READY), (PURGE_TYPES, PURGE_READY)),
}

# What an import staged by a worker that predates the lease reads when it is claimed again: it was
# written with random minted ids and no cursor, so it cannot be resumed — only started again.
INTERRUPTED = ("The job stopped before it finished (the server restarted or it was interrupted). "
               "Start it again.")

# A claim that fails a job in place (poison, pre-lease) looks again, at most this many times per
# transaction: a backlog of dead jobs is cleared over several polls, never in one long transaction.
_CLAIM_SKIPS = 10

_JOBS = JobORM.__table__.fullname


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


class Superseded(Exception):
    """This worker no longer holds the job: another worker took it over (stale heartbeat), the
    user cancelled it, or the cursor moved under it. Not a failure — the write that found out
    rolls back, and the worker stops quietly."""


class Draining(Exception):
    """The worker is stopping: hand the job back at this boundary (:meth:`Lease.release`) so
    another worker resumes it from its cursor."""


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"


UNSET: Any = _Unset()


# --------------------------------------------------------------------------- #
# The lease                                                                    #
# --------------------------------------------------------------------------- #
@dataclass(eq=False)
class Lease:
    """One worker's ownership of one job, for one epoch (``retry_count`` at the claim)."""

    job_id: str
    job_type: str
    epoch: int
    workspace_id: Optional[str]
    graph_id: str
    # Set by the LeaseKeeper thread when a renewal finds the row no longer ours.
    lost: threading.Event = field(default_factory=threading.Event, repr=False)
    # Set by the worker's slot loop when the process is stopping.
    drain: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    # Where finish/fail/release open their own short transaction (the claim's factory).
    session_factory: Optional[Callable[[], Any]] = field(default=None, repr=False)

    def _sessions(self):
        return (self.session_factory or db.graphver_session)()

    def _fenced(self):
        t = JobORM.__table__
        return update(t).where(t.c.id == self.job_id, t.c.retry_count == self.epoch,
                               t.c.status == "running")

    def check(self) -> None:
        """Raise :class:`Superseded` when the lease is lost, :class:`Draining` when the worker is
        stopping. Call it between units of work — a window, a phase — never inside one."""
        if self.lost.is_set():
            raise Superseded(f"job {self.job_id} (epoch {self.epoch}) is no longer this worker's")
        if self.drain.is_set():
            raise Draining(f"job {self.job_id}: the worker is stopping")

    async def checkpoint(self, s, *, expect_cursor: Any = UNSET, **values) -> None:
        """Record progress in the CALLER's transaction — the one that wrote the work — as a fenced
        compare-and-set. ``values`` are job columns (``last_cursor``, ``processed``, ``summary``…);
        ``updated_at`` and ``last_sequence`` move with every checkpoint. With ``expect_cursor`` the
        row must also still hold that cursor, so a window can never be recorded twice.

        Raises :class:`Superseded` when the row is not ours (epoch, status or cursor moved): the
        caller's transaction then rolls back, taking the window's work with it."""
        t = JobORM.__table__
        stmt = self._fenced()
        if expect_cursor is not UNSET:
            stmt = stmt.where(t.c.last_cursor.is_not_distinct_from(expect_cursor))
        res = await s.execute(stmt.values(updated_at=_now(), last_sequence=t.c.last_sequence + 1,
                                          **values))
        if res.rowcount != 1:
            raise Superseded(f"job {self.job_id} (epoch {self.epoch}) moved on: its row is no "
                             "longer running at this epoch and cursor")

    async def finish(self, status: str = "completed", **values) -> bool:
        """End the job (``status`` and job columns in ``values``), fenced, in a transaction of its
        own. False when the job is no longer ours — a zombie's finish is a no-op."""
        async with self._sessions() as s:
            res = await s.execute(self._fenced().values(
                status=status, completed_at=_now(), updated_at=_now(), **values))
            return res.rowcount == 1

    async def fail(self, message: str, code: str = "internal", action: Optional[str] = None,
                   phase: Optional[str] = None) -> bool:
        """Fail the job, fenced, recording ``summary.failure = {code, action, phase, reason}``
        (``phase`` defaults to the row's current phase). Codes: ``integrity`` (action restart),
        ``infrastructure`` (action resume), ``internal`` (no action). False when superseded."""
        failure = json.dumps({"code": code, "action": action, "reason": message})
        async with self._sessions() as s:
            res = await s.execute(_FAIL, {
                "id": self.job_id, "epoch": self.epoch, "message": message[:2000], "now": _now(),
                "failure": failure, "phase": phase})
            return res.rowcount == 1

    async def release(self) -> bool:
        """Hand the job back, fenced: pending again (a transfer job queued again; others keep their
        phase), cursor and progress kept, so the next claim resumes it. The epoch is NOT bumped
        here — the next claim bumps it. False when the job is no longer ours."""
        values: Dict[str, Any] = {"status": "pending", "updated_at": _now()}
        if self.job_type in _QUEUED_TYPES:
            values["current_phase"] = QUEUED
        async with self._sessions() as s:
            res = await s.execute(self._fenced().values(**values))
            released = res.rowcount == 1
        if released:
            logger.info("%s job %s released at epoch %s", self.job_type, self.job_id, self.epoch)
        return released

    async def retry_transient(self, fn: Callable[[], Awaitable[Any]],
                              budget: Optional[float] = None, *,
                              never: Tuple[type, ...] = (),
                              on_retry: Optional[Callable[[Exception], Awaitable[None]]] = None):
        """Run ``fn()``, waiting out transient infrastructure faults (a FalkorDB restart, a Postgres
        failover, a network blip) with exponential backoff, for up to ``budget`` seconds
        (``BOOTSTRAP_RETRY_BUDGET_SECS``) per call — a success resets it, so it bounds how long an
        OUTAGE may last, not how long the job may take. Past it the fault is raised and the job
        stays resumable from its cursor.

        Safe because the unit of work is a transaction: a retry either re-runs a window that rolled
        back or reads a cursor that already moved past one that landed. ``fn`` builds its own
        clients, so a retry never reuses a dead connection. The lease is checked before every
        attempt; :class:`Superseded`, :class:`Draining` and the ``never`` types are never retried.
        ``on_retry(exc)`` runs before each wait (e.g. to record the interruption)."""
        deadline = time.monotonic() + (config.BOOTSTRAP_RETRY_BUDGET_SECS if budget is None
                                       else budget)
        delay, attempt = 1.0, 0
        while True:
            self.check()
            try:
                return await fn()
            except (Superseded, Draining) + tuple(never):
                raise
            except Exception as exc:
                if not is_transient(exc) or time.monotonic() + delay > deadline:
                    raise
                attempt += 1
                logger.warning(
                    "%s job %s hit a transient fault (%s: %s); retrying in %.0fs (attempt %d, "
                    "%.0fs of budget left)", self.job_type, self.job_id, type(exc).__name__,
                    str(exc)[:120], delay, attempt, max(0.0, deadline - time.monotonic()))
                if on_retry is not None:
                    await on_retry(exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, config.BOOTSTRAP_RETRY_MAX_DELAY_SECS)


# ``summary`` may be SQL NULL or a JSON null (the ORM writes None as one); either starts empty.
_FAIL = text(
    f"UPDATE {_JOBS} SET status = 'failed', error_message = :message, completed_at = :now, "
    "updated_at = :now, summary = (CASE WHEN jsonb_typeof(summary) = 'object' THEN summary "
    "ELSE CAST('{}' AS jsonb) END) || jsonb_build_object("
    "'failure', CAST(:failure AS jsonb) || jsonb_build_object("
    "'phase', coalesce(CAST(:phase AS text), current_phase))) "
    "WHERE id = :id AND retry_count = :epoch AND status = 'running'")


# --------------------------------------------------------------------------- #
# Claim                                                                        #
# --------------------------------------------------------------------------- #
def _claimable(phase_pred: str) -> str:
    """The rows a claim may take, over ``jobs j``: pending and ready, or running and silent past
    ``:stale`` (its worker died)."""
    return (f"((j.status = 'pending' AND ({phase_pred})) "
            "OR (j.status = 'running' AND j.updated_at < :stale))")


def _claim_sql(phase_pred: str, *, provider_capped: bool):
    """The next job for this claimer, locked. ``running`` counts each workspace's (and provider's,
    per origin) LIVE jobs of these types, so the order is:

    1. ``package_inspect`` first — a person is waiting on the upload dialog;
    2. workspaces under their fair share before those at it (a soft cap: when every waiting
       workspace is at its share, the oldest job still runs — no slot idles while work waits);
    3. the workspace running fewest, then the oldest job.

    With a provider cap, a job whose (provider, origin) already has that many live is skipped."""
    cap = ("AND (SELECT coalesce(sum(p.n), 0) FROM running p "
           "WHERE p.provider_id IS NOT DISTINCT FROM j.provider_id "
           "AND p.origin = coalesce(j.summary->>'origin', 'graph')) < :provider_cap "
           if provider_capped else "")
    stmt = text(
        "WITH running AS ("
        "SELECT workspace_id, provider_id, coalesce(summary->>'origin', 'graph') AS origin, "
        "count(*) AS n "
        f"FROM {_JOBS} WHERE job_type = ANY(:types) AND status = 'running' "
        "AND updated_at >= :stale GROUP BY 1, 2, 3) "
        f"SELECT j.* FROM {_JOBS} j "
        "LEFT JOIN (SELECT workspace_id, sum(n) AS n FROM running GROUP BY 1) r "
        "ON r.workspace_id IS NOT DISTINCT FROM j.workspace_id "
        f"WHERE j.job_type = ANY(:types) AND {_claimable(phase_pred)} {cap}"
        "ORDER BY (j.job_type = 'package_inspect') DESC, (coalesce(r.n, 0) >= :ws_cap), "
        "coalesce(r.n, 0), j.created_at "
        "LIMIT 1 FOR UPDATE OF j SKIP LOCKED"
    ).bindparams(bindparam("types", type_=ARRAY(Text)))
    return select(JobORM).from_statement(stmt)


async def claim(session_factory, types: Sequence[str], *, phase_pred: str,
                stale_secs: Optional[float] = None, ws_cap: Optional[int] = None,
                provider_cap: Optional[int] = None, lane: str = "transfer") -> Optional[Lease]:
    """Claim the next job of ``types`` and return its :class:`Lease`, or None when there is none.

    One transaction: pick (``FOR UPDATE OF jobs SKIP LOCKED``, ordered as :func:`_claim_sql`
    says), bump the epoch, mark it running. ``phase_pred`` says which pending rows are ready
    (``TRANSFER_READY``, ``BOOTSTRAP_READY``, ``PURGE_READY``). ``stale_secs`` (default
    ``INGEST_STALE_SECS``) is how long a running job may be silent before it is taken over;
    ``ws_cap`` (default ``JOBS_PER_WORKSPACE``) the soft per-workspace share. With ``provider_cap``
    the lane's claims are serialized by an advisory lock, so two claimers can't both see a
    (provider, origin) under its cap and both take one.

    Some rows are failed in place instead of claimed, and the claim looks again:

    * POISON — a takeover beyond ``max_retries``: the job's worker keeps dying on it (out of
      memory, a crash in a native library), and running it again would only kill the next one.
      It fails as ``infrastructure`` with action ``resume``, so a person decides.
    * PRE-LEASE IMPORT — a transfer job with rows staged in ``import_rows`` but no cursor was
      staged by a worker that predates the lease (random minted ids, unconditional writes): it
      cannot be resumed, so it fails with :data:`INTERRUPTED`, as it always did, and is started
      again. (A job on the lease checkpoints its cursor with every batch it stages.)
    """
    stale_secs = config.INGEST_STALE_SECS if stale_secs is None else stale_secs
    ws_cap = config.JOBS_PER_WORKSPACE if ws_cap is None else ws_cap
    stmt = _claim_sql(phase_pred, provider_capped=provider_cap is not None)
    params: Dict[str, Any] = {"types": list(types), "stale": _ago(stale_secs), "ws_cap": ws_cap}
    if provider_cap is not None:
        params["provider_cap"] = provider_cap
    async with session_factory() as s:
        if provider_cap is not None:
            await s.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
                            {"key": f"graphver:claim:{lane}"})
        for _ in range(_CLAIM_SKIPS):
            row = (await s.execute(stmt, params)).scalars().first()
            if row is None:
                return None
            if await _failed_in_place(s, row):
                await s.flush()          # so the next pick in this transaction doesn't see it again
                continue
            now = _now()
            row.retry_count = (row.retry_count or 0) + 1
            if row.current_phase == QUEUED:
                row.current_phase = None
            row.status = "running"
            row.started_at = row.started_at or now
            row.updated_at = now
            row.error_message = None
            return Lease(job_id=row.id, job_type=row.job_type, epoch=row.retry_count,
                         workspace_id=row.workspace_id, graph_id=row.graph_id,
                         session_factory=session_factory)
    return None


async def _failed_in_place(s, row: JobORM) -> bool:
    """Fail ``row`` if it must not run again (see :func:`claim`); count a takeover otherwise."""
    now = _now()
    if row.job_type in _QUEUED_TYPES and row.last_cursor is None and await s.scalar(
            select(exists().where(ImportRowORM.job_id == row.id))):
        logger.warning("%s job %s was staged by a pre-lease worker; failing it rather than "
                       "resuming", row.job_type, row.id)
        row.status, row.error_message = "failed", INTERRUPTED
        row.completed_at = row.updated_at = now
        return True
    if row.status != "running":
        return False
    summary = dict(row.summary or {})
    takeovers = int(summary.get("takeovers") or 0) + 1
    summary["takeovers"] = takeovers
    if takeovers > (row.max_retries if row.max_retries is not None else 3):
        reason = (f"The worker running this job stopped {takeovers} times before it finished "
                  "(for example, it ran out of memory), so it is not being retried automatically. "
                  "Resume it to continue from where it got to.")
        summary["failure"] = {"code": "infrastructure", "action": "resume",
                              "phase": row.current_phase, "reason": reason}
        logger.error("%s job %s is poison: its worker stopped %d times (phase=%s cursor=%s)",
                     row.job_type, row.id, takeovers, row.current_phase, row.last_cursor)
        row.status, row.error_message, row.summary = "failed", reason, summary
        row.completed_at = row.updated_at = now
        return True
    row.summary = summary
    logger.warning("taking over stale %s job %s (phase=%s cursor=%s, takeover %d)",
                   row.job_type, row.id, row.current_phase, row.last_cursor, takeovers)
    return False


async def claimable_backlog(s) -> Dict[str, Dict[str, Any]]:
    """Per lane, what a worker of it could claim right now: ``claimable`` jobs, and how long the
    oldest has waited (``oldestClaimableSecs``, since it was queued or last beat). A backlog that
    only grows means the lane's workers are not running."""
    out: Dict[str, Dict[str, Any]] = {}
    for lane, groups in LANE_CLAIMS.items():
        where = " OR ".join(f"(j.job_type = ANY(:types{i}) AND {_claimable(pred)})"
                            for i, (_types, pred) in enumerate(groups))
        stmt = text(f"SELECT count(*), min(coalesce(j.updated_at, j.created_at)) FROM {_JOBS} j "
                    f"WHERE {where}").bindparams(
            *(bindparam(f"types{i}", type_=ARRAY(Text)) for i in range(len(groups))))
        params: Dict[str, Any] = {f"types{i}": list(t) for i, (t, _pred) in enumerate(groups)}
        params["stale"] = _ago(config.INGEST_STALE_SECS)
        count, oldest = (await s.execute(stmt, params)).one()
        age = None
        if oldest:
            age = round((datetime.now(timezone.utc) - datetime.fromisoformat(oldest))
                        .total_seconds())
        out[lane] = {"claimable": int(count or 0), "oldestClaimableSecs": age}
    return out


# --------------------------------------------------------------------------- #
# Heartbeat thread                                                             #
# --------------------------------------------------------------------------- #
# Renew every live lease of this process in one statement. Each column is one typed array
# parameter (as import_worker._RESOLVE_ROWS does), so asyncpg never has to guess a type.
_RENEW = text(
    f"UPDATE {_JOBS} AS j SET updated_at = :now FROM unnest(:ids, :epochs) AS v(id, epoch) "
    "WHERE j.id = v.id AND j.retry_count = v.epoch AND j.status = 'running' "
    "RETURNING j.id, j.retry_count",
).bindparams(bindparam("ids", type_=ARRAY(Text)), bindparam("epochs", type_=ARRAY(Integer)))

_running_keeper: Optional["LeaseKeeper"] = None


def running_keeper() -> Optional["LeaseKeeper"]:
    """The process's started :class:`LeaseKeeper`, or None (tests, the web tier)."""
    return _running_keeper


def _keeper_engine():
    # NullPool: a connection per renewal, never one parked in a pool bound to some other loop.
    return create_async_engine(config.graphver_db_url(), poolclass=NullPool, echo=False)


class LeaseKeeper:
    """Keeps this process's leases alive from a daemon THREAD with its own event loop and engine.

    Every ``INGEST_HEARTBEAT_SECS`` it renews all registered leases in one batched UPDATE. A thread,
    because liveness must not depend on the event loop: a worker deep in a CPU-bound window, or
    blocked in a synchronous client call, is alive and must not have its job stolen. Only an id
    missing from a SUCCESSFUL renewal marks a lease ``lost`` — its row moved to another epoch or out
    of running. A failed statement (Postgres down, a lock wait past ``lock_timeout``) is logged and
    retried next tick; if it keeps failing the job goes stale and the CAS fences it anyway.

    WEDGE GUARD: a loop that has not ticked for ``JOB_WEDGE_SECS`` (per the event-loop monitor) will
    not finish its jobs, and renewing them would hold them forever. The keeper dumps every thread's
    stack, stops renewing and — in a standalone worker (``exit_on_wedge``) — exits with status 70
    for the orchestrator to restart it; the stale jobs are then taken over.
    """

    def __init__(self, *, exit_on_wedge: bool = False, every: Optional[float] = None,
                 wedge_secs: Optional[float] = None, engine_factory=None) -> None:
        self._exit_on_wedge = exit_on_wedge
        self._every = config.INGEST_HEARTBEAT_SECS if every is None else every
        self._wedge_secs = config.JOB_WEDGE_SECS if wedge_secs is None else wedge_secs
        self._engine_factory = engine_factory or _keeper_engine
        self._engine = None
        self._leases: Set[Lease] = set()
        self._guard = threading.Lock()
        self._stopping = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._dumped = False

    def register(self, lease: Lease) -> None:
        with self._guard:
            self._leases.add(lease)

    def unregister(self, lease: Lease) -> None:
        with self._guard:
            self._leases.discard(lease)

    def start(self) -> "LeaseKeeper":
        global _running_keeper
        if _running_keeper is not None:
            raise RuntimeError("a LeaseKeeper is already running in this process")
        self._thread = threading.Thread(target=self._run, name="graphver-lease-keeper",
                                        daemon=True)
        _running_keeper = self
        self._thread.start()
        return self

    def stop(self, timeout: float = 10.0) -> None:
        global _running_keeper
        self._stopping.set()
        if self._thread is not None:
            self._thread.join(timeout)
        if _running_keeper is self:
            _running_keeper = None

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        try:
            while not self._stopping.wait(self._every):
                if self.wedged():
                    continue
                try:
                    loop.run_until_complete(self.renew_once())
                except Exception:  # noqa: BLE001 — retried next tick; staleness fences the rest
                    logger.warning("renewing job leases failed; retrying in %ss", self._every,
                                   exc_info=True)
        finally:
            if self._engine is not None:
                with contextlib.suppress(Exception):
                    loop.run_until_complete(self._engine.dispose())
            loop.close()

    async def renew_once(self) -> Set[str]:
        """Renew every registered lease; mark lost (and return the ids of) those whose row did
        not come back. Raises on a statement error, marking nothing."""
        with self._guard:
            leases = list(self._leases)
        if not leases:
            return set()
        if self._engine is None:
            self._engine = self._engine_factory()
        async with self._engine.begin() as conn:
            # A row locked by its own long window must not stall every other lease's renewal.
            await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            result = await conn.execute(_RENEW, {"now": _now(),
                                                 "ids": [lease.job_id for lease in leases],
                                                 "epochs": [lease.epoch for lease in leases]})
            alive = {(row[0], row[1]) for row in result}
        lost: Set[str] = set()
        for lease in leases:
            if (lease.job_id, lease.epoch) not in alive and not lease.lost.is_set():
                lease.lost.set()
                lost.add(lease.job_id)
                logger.warning("%s job %s: lease lost at epoch %s (taken over, or no longer "
                               "running)", lease.job_type, lease.job_id, lease.epoch)
        return lost

    def wedged(self) -> bool:
        """True while the event loop has not ticked for ``JOB_WEDGE_SECS``. The first time, dump
        every thread's stack; with ``exit_on_wedge``, exit the process (status 70)."""
        tick = event_loop_monitor.last_tick()
        if not tick:
            return False                    # no loop monitor in this process: nothing to judge by
        stalled = time.monotonic() - tick
        if stalled < self._wedge_secs:
            self._dumped = False
            return False
        if not self._dumped:
            self._dumped = True
            logger.critical("event loop WEDGED for %.0fs: job leases are no longer renewed; "
                            "dumping all thread stacks", stalled)
            with contextlib.suppress(Exception):
                faulthandler.dump_traceback(all_threads=True)
        if self._exit_on_wedge:
            logger.critical("exiting (70) so the orchestrator restarts this worker")
            os._exit(70)
        return True


# --------------------------------------------------------------------------- #
# Transient vs. terminal faults (shared with bootstrap_worker)                  #
# --------------------------------------------------------------------------- #
# Which faults a long job should WAIT OUT, and which mean something is really wrong. The
# distinction is load-bearing in two directions:
#   * a broken pipe must be waited out — the window was fine, the connection wasn't, and shrinking
#     the window fixes nothing;
#   * an oversized-query timeout must SHRINK the window — waiting fixes nothing, because the same
#     query will blow the same budget again.
# Get it backwards and you either wedge a 40-minute job on a one-second blip, or retry an
# impossible query until the budget runs out.
_TRANSIENT_TYPES: Tuple[type, ...] = (
    ConnectionError,          # builtin: ConnectionReset/Refused/Aborted
    asyncio.TimeoutError,     # a client-side hang net tripped
    OSError,                  # socket layer: EPIPE, ECONNRESET, DNS, host unreachable
)
try:                          # pragma: no cover - depends on the installed client
    # redis-py shadows the builtins with its OWN ConnectionError/TimeoutError, and they do NOT
    # subclass them — catching only the builtins would miss every FalkorDB fault there is.
    from redis.exceptions import BusyLoadingError as _RedisBusy
    from redis.exceptions import ConnectionError as _RedisConnErr
    from redis.exceptions import TimeoutError as _RedisTimeout
    _TRANSIENT_TYPES = _TRANSIENT_TYPES + (_RedisConnErr, _RedisTimeout, _RedisBusy)
except Exception:                                              # pragma: no cover
    pass

# OSErrors that are about a file, not the network: waiting never brings back a missing input.
_PERMANENT_OS = (FileNotFoundError, PermissionError, IsADirectoryError, NotADirectoryError)
# The server killed OUR query for being too expensive. Not an outage — a scan's halving ladder
# owns this one, and must see it rather than have it retried behind its back.
_OVERSIZED = ("query timed out", "query's execution time exceeded")
# Text fallbacks, for clients that signal an outage with a plain error string.
_TRANSIENT_TEXT = (
    "loading",                # FalkorDB/Redis replaying its RDB/AOF after a restart
    "masterdown", "clusterdown", "readonly", "try again",
    "connection reset", "broken pipe", "connection refused", "connection closed",
    "server closed the connection", "not connected", "no route to host",
    "temporarily unavailable", "too many connections", "the database system is",
)


def is_transient(exc: BaseException) -> bool:
    """True if waiting and reconnecting is a sane response to ``exc``."""
    blurb = f"{type(exc).__name__}: {exc}".lower()
    if any(t in blurb for t in _OVERSIZED):
        return False                                   # shrink the window, don't wait
    if isinstance(exc, _PERMANENT_OS):
        return False                                   # a missing or unreadable file stays so
    if isinstance(exc, _TRANSIENT_TYPES):
        return True
    if isinstance(exc, SQLAlchemyError):
        # A restarted / failed-over Postgres surfaces as one of these, or as an invalidated DBAPI
        # connection. A constraint violation is an IntegrityError and is NOT any of them — it must
        # fail loudly rather than be retried into the same wall.
        return (isinstance(exc, (DisconnectionError, InterfaceError, OperationalError))
                or bool(getattr(exc, "connection_invalidated", False)))
    return any(t in blurb for t in _TRANSIENT_TEXT)


def friendly_infra_error(exc: Exception) -> str:
    """What a job that gave up on an infrastructure fault tells the user."""
    mins = max(1, config.BOOTSTRAP_RETRY_BUDGET_SECS // 60)
    if is_transient(exc):
        return (f"The graph service stayed unreachable for over {mins} minutes, so we stopped "
                "waiting. Nothing was lost — resume to pick up exactly where this left off. "
                f"({type(exc).__name__})")
    return ("We couldn't finish reading the source graph — the graph service may be busy or "
            f"unavailable. You can resume this safely. ({type(exc).__name__})")
