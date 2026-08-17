"""ProbeScheduler — decides WHICH sources get their counts re-read, and when.

The drift tripwire needs fresh counts to compare. Producing them used to mean
waiting for the stats service's 900s poll, because that poll is two full graph
scans. ``provider.get_counts_fast`` answers the same question from FalkorDB's
label/relation counters in about a millisecond, which makes a 60s cadence
affordable — and that single change is what takes worst-case drift detection
from roughly 75 minutes down to under a minute.

**Scheduling lives here; execution lives in the stats service.** This loop only
resolves policy (per-source override → persisted global → env) and enqueues, so
it stays pure SQL plus one Redis XADD. The stats service owns every outbound
provider call, which is a standing invariant of this codebase, not an accident
of layering. The two halves meet at the ``insights.jobs.probe`` stream.

Runs on the Control Plane singleton alongside the reconcile sweep. Enqueueing
is idempotent through the probe lane's SET NX claim, so a second replica (dev
monolith, HA control plane) coalesces rather than double-probing.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select

logger = logging.getLogger(__name__)


# The loop wakes far more often than any source is due, so a cadence change
# takes effect promptly and sources stagger instead of firing in lockstep.
# Same reasoning as the reconcile sweep's 60s tick.
_TICK_SECS = 15.0


@dataclass
class ProbeTickSummary:
    """Per-tick counters, surfaced through the health probe."""
    seen: int = 0
    due: int = 0
    enqueued: int = 0
    coalesced: int = 0
    errors: int = 0


# The running loop's instance is owned by the control-plane lifespan task and
# unreachable from a request handler, so each tick also publishes here for
# ``/health`` to read — same shape and reasoning as the stats scheduler's
# ``get_scheduler_status``.
_last_tick: Optional[ProbeTickSummary] = None
_last_tick_at: Optional[datetime] = None


def get_probe_scheduler_status() -> dict:
    """JSON-friendly snapshot of the last tick for the health probe. Without
    it an operator cannot tell a fleet with nothing to probe from a probe
    scheduler that is not running at all."""
    if _last_tick is None or _last_tick_at is None:
        return {"last_tick_at": None}
    return {"last_tick_at": _last_tick_at.isoformat(), **asdict(_last_tick)}


class ProbeScheduler:
    def __init__(self, session_factory):
        self._session_factory = session_factory
        self._last: Optional[ProbeTickSummary] = None

    @property
    def last_tick(self) -> Optional[ProbeTickSummary]:
        return self._last

    async def start(self, shutdown: asyncio.Event) -> None:
        global _last_tick, _last_tick_at

        logger.info("Probe scheduler started (tick=%.0fs)", _TICK_SECS)
        while not shutdown.is_set():
            try:
                self._last = _last_tick = await self.tick()
                _last_tick_at = datetime.now(timezone.utc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A failed pass must never kill the loop — the whole point of
                # this component is that it keeps running unattended.
                logger.warning("Probe scheduler tick failed: %s", exc)
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=_TICK_SECS)
            except asyncio.TimeoutError:
                pass
        logger.info("Probe scheduler stopped")

    async def tick(self) -> ProbeTickSummary:
        """One pass: select due sources, enqueue a probe for each."""
        from .service import (
            AGGREGATION_PROBE_BATCH_CAP,
            read_global_cadence,
            resolve_probe_enabled,
            resolve_probe_interval,
        )

        summary = ProbeTickSummary()

        async with self._session_factory() as session:
            cadence = await read_global_cadence(session)
            global_enabled = getattr(cadence, "probe_enabled", None)
            global_interval = getattr(cadence, "probe_interval_secs", None)

            # Cheap pre-filter. It cannot know each source's override, so it is
            # deliberately permissive on the interval and the exact test runs
            # in Python below — the same split the reconcile sweep uses.
            #
            # "Permissive" means the NARROWEST interval any source could
            # resolve to, not the global one. A source overridden FASTER than
            # the fleet is due before the global cutoff, so a global-width
            # cutoff would never load its row and the Python check that honours
            # the override would never run — the override would be reported in
            # the drawer and silently do nothing.
            fastest = await self._fastest_override(session)
            narrowest = resolve_probe_interval(None, global_interval)
            if fastest is not None:
                narrowest = min(narrowest, fastest)
            cutoff = (
                datetime.now(timezone.utc) - timedelta(seconds=narrowest)
            ).isoformat()
            rows = await self._due_rows(session, cutoff)

        summary.seen = len(rows)
        now = datetime.now(timezone.utc)

        for ds_id, workspace_id, override_enabled, override_interval, last_probed in rows:
            if not resolve_probe_enabled(override_enabled, global_enabled):
                continue
            interval = resolve_probe_interval(override_interval, global_interval)
            if not _is_due(last_probed, interval, now):
                continue
            summary.due += 1
            if summary.enqueued >= AGGREGATION_PROBE_BATCH_CAP:
                # Oldest-probed-first ordering means the remainder is simply
                # picked up next tick rather than starved.
                logger.info(
                    "Probe scheduler: batch cap (%d) reached — %d source(s) "
                    "deferred to the next tick",
                    AGGREGATION_PROBE_BATCH_CAP, summary.due - summary.enqueued,
                )
                break
            outcome = await self._enqueue(ds_id, workspace_id)
            if outcome == "enqueued":
                summary.enqueued += 1
            elif outcome == "dedup":
                summary.coalesced += 1
            else:
                summary.errors += 1

        if summary.enqueued or summary.errors:
            logger.info(
                "Probe tick: seen=%d due=%d enqueued=%d coalesced=%d errors=%d",
                summary.seen, summary.due, summary.enqueued,
                summary.coalesced, summary.errors,
            )
        return summary

    @staticmethod
    async def _fastest_override(session) -> Optional[int]:
        """The narrowest per-source probe interval anyone has set, or None when
        nobody overrides. One scalar read over a table with one row per source,
        and it is what keeps the SQL pre-filter a superset of ``_is_due``."""
        from sqlalchemy import func

        from .models import AggregationDataSourceStateORM as S

        return (await session.execute(
            select(func.min(S.probe_interval_secs))
        )).scalar()

    async def _due_rows(self, session, cutoff: str):
        """Sources whose counts are old enough to be worth re-reading.

        Oldest-probed-first, so a fleet larger than one batch drains in order
        instead of the same head being re-probed every tick. NULL sorts first:
        a source that has never been probed has no baseline at all, which is
        the case where being late costs the most.
        """
        from backend.app.db.models import DataSourceStatsORM, WorkspaceDataSourceORM
        from .models import AggregationDataSourceStateORM as S

        stmt = (
            select(  # noqa: cross-domain (probe lane: stats.last_probed_at is the probe cadence clock; read-only, bounded by AGGREGATION_PROBE_SCAN_CAP)
                WorkspaceDataSourceORM.id,
                WorkspaceDataSourceORM.workspace_id,
                S.probe_enabled,
                S.probe_interval_secs,
                DataSourceStatsORM.last_probed_at,
            )
            .outerjoin(S, S.data_source_id == WorkspaceDataSourceORM.id)
            .outerjoin(
                DataSourceStatsORM,
                DataSourceStatsORM.data_source_id == WorkspaceDataSourceORM.id,
            )
            # Liveness is deleted_at, never is_active: a tombstoned source that
            # is still flagged active would otherwise be probed forever.
            .where(WorkspaceDataSourceORM.is_active.is_(True))
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
            .where(
                DataSourceStatsORM.last_probed_at.is_(None)
                | (DataSourceStatsORM.last_probed_at < cutoff)
            )
            .order_by(DataSourceStatsORM.last_probed_at.asc().nullsfirst())
            # KNOWN BOUND: oldest-probed-first is the right fairness rule, but
            # it works against a fast per-source override. One narrow override
            # drags ``cutoff`` down for everyone, so most of the fleet matches
            # — and the override's own source, being the most recently probed,
            # sorts LAST. Above the cap it is the row this LIMIT truncates.
            # Harmless below AGGREGATION_PROBE_SCAN_CAP sources (raise it, or
            # make due-ness per-row in SQL, if that stops being true).
            .limit(AGGREGATION_PROBE_SCAN_CAP)
        )
        return list((await session.execute(stmt)).all())

    @staticmethod
    async def _enqueue(ds_id: str, workspace_id: str) -> str:
        """Redis-only, so a probe is never blocked by DB contention.

        Never raises: a probe that fails to enqueue is retried next tick, and
        the reconcile sweep's own interval remains the correctness backstop.
        """
        try:
            from backend.insights_service.enqueue import enqueue_probe_job_safe

            _msg_id, outcome = await enqueue_probe_job_safe(ds_id, workspace_id)
            return outcome
        except Exception as exc:
            logger.debug("Probe enqueue failed for %s: %s", ds_id, exc)
            return "error"


# Bound on ONE tick's read regardless of fleet size. Larger than the enqueue
# batch cap because Python filters overrides out of this set.
AGGREGATION_PROBE_SCAN_CAP = 1000


def _is_due(last_probed_at: Optional[str], interval_secs: int, now: datetime) -> bool:
    """Never probed, or the interval elapsed. ``interval_secs <= 0`` means
    "every tick" — honored rather than treated as unset, matching the other
    interval knobs."""
    if interval_secs <= 0:
        return True
    if not last_probed_at:
        return True
    try:
        last = datetime.fromisoformat(last_probed_at)
    except (TypeError, ValueError):
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() >= interval_secs


async def run_probe_scheduler(session_factory, shutdown: asyncio.Event) -> None:
    """Entry point for the Control Plane lifespan."""
    await ProbeScheduler(session_factory).start(shutdown)
