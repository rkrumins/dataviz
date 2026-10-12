"""Versioning worker — the projection, transfer and bootstrap LANES (``GRAPHVER_WORKER_LANES``).

The **projection** lane advances each graph's FalkorDB projection with two cooperating
mechanisms (matching the locked "inline nudge + reconciling worker" decision):

* **Reconciling poll loop** (durable backstop, sufficient for correctness): every
  ``PROJECTION_POLL_SECS`` project every graph whose ``projected < target``.
* **Redis-stream consumer** (latency): consume ``{graph_id}`` wake-ups, project,
  ``XACK``; PEL recovery on boot via ``XAUTOCLAIM``.

``ProjectionStateORM`` is the durable queue, so a lost wake-up is still caught by
the poll loop. Per-``graph_id`` serialization keeps the two mechanisms from
projecting the same graph concurrently. Mirrors the aggregation worker runtime.

The **transfer** lane (import / export / publish, and a dedicated package-inspect slot) and the
**bootstrap** lane (bootstraps, purges) run jobs from ``graphver.jobs`` through one
:meth:`ProjectionWorker._slot_loop` each. Production runs each lane as its own pod; compose and
dev run all three in one process.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional, Set, Union, TYPE_CHECKING

from backend.app.services.background import spawn_detached

from . import config, job_lease
from .messaging import (
    CONSUMER_GROUP,
    PROJECTION_STREAM,
    ensure_consumer_group,
    get_broker_redis,
)
from .cache_manager import CacheManager
from .projection import FalkorProjector

if TYPE_CHECKING:
    from .bootstrap_worker import BootstrapRunner
    from .import_export.runner import JobReaper, TransferRunner
    from .purge_worker import PurgeRunner, Reaper
    from .service import GraphVersioningService

logger = logging.getLogger(__name__)

# How often the transfer lane fails the jobs nothing will ever run (runner.JobReaper).
_JOB_REAP_SECS = 60


class ProjectionWorker:
    def __init__(
        self,
        projector: FalkorProjector,
        *,
        poll_secs: Optional[int] = None,
        consumer_name: str = "proj-1",
        versioning: Optional["GraphVersioningService"] = None,
        sweep_secs: Optional[int] = None,
        evict_budget: Optional[Callable[[str], Union[int, Awaitable[int]]]] = None,
        evict_secs: Optional[int] = None,
        bootstrap: Optional["BootstrapRunner"] = None,
        purge: Optional["PurgeRunner"] = None,
        reaper: Optional["Reaper"] = None,
        transfers: Optional[TransferRunner] = None,
        inspections: Optional[TransferRunner] = None,
        job_reaper: Optional["JobReaper"] = None,
        lanes: Optional[Iterable[str]] = None,
    ):
        self._lanes = frozenset(lanes) if lanes is not None else config.worker_lanes()
        self._proj = projector
        self._poll = poll_secs or config.PROJECTION_POLL_SECS
        self._consumer = consumer_name
        self._inflight: Set[str] = set()
        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._versioning = versioning            # enables the idle-draft sweep loop
        self._sweep_secs = sweep_secs or config.DRAFT_SWEEP_SECS
        self._evict_budget = evict_budget        # provider_id -> max resident graphs; enables eviction
        self._evict_secs = evict_secs or config.EVICT_SECS
        self._cache = CacheManager(projector) if evict_budget is not None else None
        self._bootstrap = bootstrap              # enables the "enable version control" ingest loop
        self._purge = purge                      # enables reclaiming deleted graphs
        self._reaper = reaper                    # enables expiring the undo window
        self._transfers = transfers              # enables running queued import/export/publish jobs
        self._inspections = inspections          # enables the dedicated package-inspect slot
        self._job_reaper = job_reaper            # enables failing transfer jobs nothing will run

    def stop(self) -> None:
        self._stop.set()

    async def _project_one(self, graph_id: str):
        async with self._lock:
            if graph_id in self._inflight:
                return None                      # already being projected — skip
            self._inflight.add(graph_id)
        try:
            return await self._proj.project_graph(graph_id)
        finally:
            async with self._lock:
                self._inflight.discard(graph_id)

    async def reconcile_once(self):
        """One pass of the durable backstop: project every lagging graph."""
        return await self._proj.project_pending()

    async def sweep_once(self):
        """One pass of the idle-draft janitor (plan §17 #8); no-op without a service. What a swept
        draft held in views goes with it, as on abandon, and any draft whose views were left
        unsettled by its publish or abandon is settled (``draft_views``). Import/export artifacts
        older than ``OBJECT_STORE_TTL_HOURS`` are swept from the object store — but never the
        inputs a job may still read — and the staged rows of imports finished more than
        ``STAGING_GC_DAYS`` ago from ``import_rows``."""
        if self._versioning is None:
            return []
        swept = await self._versioning.sweep_idle_drafts()
        from backend.app.services import draft_views

        try:
            if swept:
                await draft_views.discard(swept)
            await draft_views.settle(self._versioning)
        except Exception:  # noqa: BLE001 — the drafts are swept; their views settle next pass
            logger.exception("settling the views of finished drafts failed")
        try:
            from .import_export.import_worker import sweep_staged_rows

            await sweep_staged_rows(older_than_days=config.STAGING_GC_DAYS)
        except Exception:  # noqa: BLE001 — tried again next pass
            logger.exception("sweeping finished imports' staged rows failed")
        try:
            # Read right before anything is deleted: an input of a queued, running or resumable job
            # is kept however old. Unread, nothing is deleted this pass.
            from .import_export.uploads import jobs_input_prefixes

            keep = await jobs_input_prefixes()
        except Exception:  # noqa: BLE001 — tried again next pass
            logger.exception("reading the inputs jobs still need failed; nothing is swept this pass")
            return swept
        try:
            from backend.app.services.view_transfer.package import prune_uploads

            await prune_uploads(keep_prefixes=keep)
        except Exception:  # noqa: BLE001 — tried again next pass
            logger.exception("pruning view package uploads failed")
        try:
            from backend.app.services.storage.object_store import get_object_store

            await get_object_store().sweep(older_than_hours=config.OBJECT_STORE_TTL_HOURS,
                                           keep_prefixes=keep)
        except Exception:  # noqa: BLE001 — tried again next pass
            logger.exception("sweeping expired import/export artifacts failed")
        return swept

    async def evict_once(self):
        """One pass of the per-provider RAM-budget cache janitor (plan §16.5 #9-10):
        within each FalkorDB provider, evict the coldest resident graphs above that
        provider's budget. Pinned/in-flight graphs are skipped (evicting deeper to
        compensate); no-op without a budget resolver."""
        if self._cache is None:
            return []
        evicted = []
        for provider in await self._cache.resident_providers():
            raw = self._evict_budget(provider)
            budget = await raw if inspect.isawaitable(raw) else raw
            if budget <= 0:
                continue                          # 0 ⇒ unlimited for this provider
            resident = await self._cache.resident_count(provider)
            need = resident - budget
            if need <= 0:
                continue
            done = 0
            for gid in await self._cache.lru_candidates(provider, limit=resident):
                if done >= need:
                    break
                if await self._cache.evict(gid, drop_graph=self._proj.drop_graph):
                    evicted.append(gid)
                    done += 1
        return evicted

    async def run(self) -> None:
        """Run the enabled lanes until :meth:`stop`. Each lane runs only what was given to it, and
        nothing of a lane that is not enabled — the consumer group included, so a transfer pod
        never joins the projection stream."""
        loops = []
        if "projection" in self._lanes:
            await ensure_consumer_group()
            await self._reclaim_pending()
            loops += [self._poll_loop(), self._stream_loop()]
            if self._versioning is not None:
                loops.append(self._sweep_loop())
            if self._cache is not None:
                loops.append(self._evict_loop())
        if "transfer" in self._lanes:
            if self._transfers is not None:
                loops.append(self._slot_loop(self._transfers, slots=config.TRANSFER_SLOTS,
                                             name="transfer", poll_secs=config.TRANSFER_POLL_SECS))
            if self._inspections is not None:
                loops.append(self._slot_loop(self._inspections, slots=1, name="inspect",
                                             poll_secs=config.TRANSFER_POLL_SECS))
            if self._job_reaper is not None:
                loops.append(self._job_reap_loop())
        if "bootstrap" in self._lanes:
            # "Enable version control" and package seeds, then purges. ``JobORM`` is the durable
            # queue for both, so a job survives a worker restart and one whose worker died is taken
            # over once its heartbeat goes stale — no second Redis stream to keep alive.
            if self._bootstrap is not None:
                loops.append(self._slot_loop(self._bootstrap, slots=config.BOOTSTRAP_SLOTS,
                                             name="bootstrap", poll_secs=config.INGEST_POLL_SECS))
            if self._purge is not None:
                loops.append(self._slot_loop(self._purge, slots=1, name="purge",
                                             poll_secs=config.INGEST_POLL_SECS))
            if self._reaper is not None:
                loops.append(self._reap_loop())
        await asyncio.gather(*loops)

    async def _slot_loop(self, runner, *, slots: int, name: str, poll_secs: float) -> None:
        """Run ``runner``'s jobs, up to ``slots`` at a time, each a task of its own, until stopped.

        The runner protocol: ``claim_one()`` returns what it claimed — a :class:`job_lease.Lease`,
        or (a runner not yet on the lease) a job id — or None when nothing is claimable; and
        ``run_job(claimed)`` runs it to the end, recording any failure on the job rather than
        raising. A claimed lease is kept alive by the process's LeaseKeeper while it runs.

        On stop it claims nothing more and DRAINS: every running lease is told to stop at its next
        boundary (``lease.drain``), where it hands its job back (``Lease.release``: pending again,
        cursor kept) for another worker to resume; those still running after ``DRAIN_SECS`` are
        cancelled, and release under a shield on their way out."""
        running: Dict[asyncio.Task, Any] = {}
        try:
            while not self._stop.is_set():
                running = {t: c for t, c in running.items() if not t.done()}
                try:
                    while len(running) < slots and not self._stop.is_set():
                        claimed = await runner.claim_one()
                        if claimed is None:
                            break
                        job_id = getattr(claimed, "job_id", claimed)
                        running[spawn_detached(self._run_claimed(runner, claimed),
                                               name=f"{name} {job_id}")] = claimed
                except Exception:
                    logger.exception("%s slot loop error", name)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=poll_secs)
                except asyncio.TimeoutError:
                    pass                          # not stopping: look for claimable jobs again
            await self._drain(name, running)
        except asyncio.CancelledError:
            # The loop itself was cancelled (an in-process worker shut down without waiting out
            # the drain): cancel its jobs too, so they release now rather than go stale and wait
            # for a takeover.
            for task in running:
                task.cancel()
            raise

    @staticmethod
    async def _drain(name: str, running: Dict[asyncio.Task, Any]) -> None:
        live = {t: c for t, c in running.items() if not t.done()}
        if not live:
            return
        for claimed in live.values():
            if isinstance(claimed, job_lease.Lease):
                claimed.drain.set()
        logger.info("%s: draining %d running job(s) for up to %ss", name, len(live),
                    config.DRAIN_SECS)
        _, late = await asyncio.wait(live, timeout=config.DRAIN_SECS)
        for task in late:
            task.cancel()
        await asyncio.gather(*late, return_exceptions=True)

    @staticmethod
    async def _run_claimed(runner, claimed) -> None:
        """``runner.run_job(claimed)``, with a claimed lease renewed by the process's LeaseKeeper
        for exactly as long as it runs."""
        keeper = job_lease.running_keeper()
        lease = claimed if isinstance(claimed, job_lease.Lease) else None
        if keeper is not None and lease is not None:
            keeper.register(lease)
        try:
            await runner.run_job(claimed)
        finally:
            if keeper is not None and lease is not None:
                keeper.unregister(lease)

    async def _job_reap_loop(self) -> None:
        """Fail the transfer jobs nothing will ever run (see ``runner.JobReaper``)."""
        while not self._stop.is_set():
            try:
                await self._job_reaper.run_once()
            except Exception:
                logger.exception("job reaper error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_JOB_REAP_SECS)
            except asyncio.TimeoutError:
                pass

    async def _reap_loop(self) -> None:
        """Expire the undo window. The ONLY thing that ever turns a soft delete into a real one.

        Every other path leaves a deleted data source fully restorable; this asks, on a slow
        timer, which tombstones are older than the grace period and queues their purge. If this
        loop never runs, nothing is destroyed — which is the correct failure mode for the loop
        whose job is destruction."""
        while not self._stop.is_set():
            try:
                await self._reaper.run_once()
            except Exception:
                logger.exception("reaper error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=config.REAP_POLL_SECS)
            except asyncio.TimeoutError:
                pass

    async def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.reconcile_once()
            except Exception:
                logger.exception("projection poll loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll)
            except asyncio.TimeoutError:
                pass

    async def _sweep_loop(self) -> None:
        while not self._stop.is_set():
            try:
                swept = await self.sweep_once()
                if swept:
                    logger.info("auto-abandoned %d idle draft(s)", len(swept))
            except Exception:
                logger.exception("draft sweep loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._sweep_secs)
            except asyncio.TimeoutError:
                pass

    async def _evict_loop(self) -> None:
        while not self._stop.is_set():
            try:
                evicted = await self.evict_once()
                if evicted:
                    logger.info("evicted %d cold graph(s) from the FalkorDB cache", len(evicted))
            except Exception:
                logger.exception("eviction loop error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._evict_secs)
            except asyncio.TimeoutError:
                pass

    async def _stream_loop(self) -> None:
        from backend.common.adapters.redis_bus import bus_error_retry_delay

        client = get_broker_redis()
        while not self._stop.is_set():
            try:
                resp = await client.xreadgroup(
                    CONSUMER_GROUP, self._consumer, {PROJECTION_STREAM: ">"},
                    count=16, block=1000,
                )
            except Exception as exc:
                # Auth-aware (same contract as the other consumer loops):
                # NOAUTH/WRONGPASS — a rotated or wrong bus credential —
                # backs off long with an actionable message instead of
                # hot-looping at 1/s with a generic traceback.
                await asyncio.sleep(bus_error_retry_delay(
                    exc, logger, what="projection stream XREADGROUP",
                ))
                continue
            for _stream, msgs in resp or []:
                for msg_id, fields in msgs:
                    gid = (fields or {}).get("graph_id")
                    try:
                        if gid:
                            await self._project_one(gid)
                    except Exception:
                        logger.exception("projection for %s failed", gid)
                    finally:
                        await client.xack(PROJECTION_STREAM, CONSUMER_GROUP, msg_id)

    async def _reclaim_pending(self) -> None:
        """Re-claim messages a crashed consumer left un-ACKed (PEL recovery)."""
        try:
            client = get_broker_redis()
            _cursor, msgs, _ = await client.xautoclaim(
                PROJECTION_STREAM, CONSUMER_GROUP, self._consumer,
                min_idle_time=60000, count=64,
            )
            for msg_id, fields in msgs or []:
                gid = (fields or {}).get("graph_id")
                if gid:
                    await self._project_one(gid)
                await client.xack(PROJECTION_STREAM, CONSUMER_GROUP, msg_id)
        except Exception:   # pragma: no cover - infra / older redis without XAUTOCLAIM
            logger.debug("projection PEL recovery skipped", exc_info=True)


def build_worker(projector: FalkorProjector, graph_factory, *, lanes: Iterable[str],
                 import_export: Callable[[], object], consumer: Optional[str] = None,
                 evict_budget: Optional[Callable[[str], Union[int, Awaitable[int]]]] = None,
                 ) -> ProjectionWorker:
    """The worker for ``lanes``, with what each enabled lane runs and nothing of the others — ONE
    wiring, shared by the standalone worker (``__main__``) and the dev in-process path (``main.py``),
    so the two cannot drift (the in-process path once lacked the transfer lane altogether).

    ``import_export`` builds the API's ImportExportService for the transfer lane's jobs;
    ``consumer`` names this process (the pod's hostname) to the projection stream and the logs."""
    from .bootstrap_worker import BootstrapRunner
    from .import_export.runner import INSPECT_TYPES, JobReaper, TransferRunner
    from .purge_worker import PurgeRunner, Reaper
    from .service import GraphVersioningService

    lanes = frozenset(lanes)
    projection, transfer, bootstrap = ("projection" in lanes, "transfer" in lanes,
                                       "bootstrap" in lanes)
    return ProjectionWorker(
        projector, lanes=lanes, consumer_name=consumer or "proj-1",
        versioning=GraphVersioningService() if projection else None,
        evict_budget=evict_budget if projection else None,
        # "Enable version control" jobs: a 10M-entity source is copied here, off the web tier, in
        # resumable windows (see bootstrap_worker). With the projector's rollup-rebuild hook: a
        # duplicate collapse deletes copies from the source graph, and the :AGGREGATED rollups
        # computed over them must be rebuilt as a publish's would be. With the projector itself:
        # a new data source seeded from a view package is projected into its new key by the job.
        bootstrap=BootstrapRunner(
            graph_factory, consumer=consumer or "boot-1",
            on_rollups_stale=getattr(projector, "_on_rollups_stale", None),
            projector=projector,
        ) if bootstrap else None,
        purge=PurgeRunner(graph_factory, consumer=consumer or "purge-1") if bootstrap else None,
        reaper=Reaper() if bootstrap else None,
        transfers=TransferRunner(import_export) if transfer else None,
        inspections=TransferRunner(import_export, types=INSPECT_TYPES) if transfer else None,
        job_reaper=JobReaper() if transfer else None,
    )
