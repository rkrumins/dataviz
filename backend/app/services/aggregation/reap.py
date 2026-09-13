"""Ending a run whose worker is already gone.

Every terminal path INSIDE the worker passes through one ``finally``: it
seals the step ledger, writes both mirrors of the source's aggregation
status, emits the terminal event and commits. Nothing reaches that block
when the worker itself is gone — an OOM-killed pod, an evicted node, a lost
dispatch message — and those runs are reaped from another process
(``reconciler``, or the scheduler's no-Redis watchdog) that holds no ledger,
no emitter and no provider.

Those reapers used to write ``job.status`` and little else, which left two
records lying:

* **the ledger** kept a step marked ``running`` forever, so ``failed_stage``
  and the UI's ``stoppedStage`` — both of which look for ``failed`` or
  ``cancelled`` — reported NO failure stage for exactly the runs an operator
  most needs named, and the per-source "keeps dying in Apply" tally skipped
  them entirely;
* **the source row** kept ``aggregation_status`` at ``running``, which the
  freshness column reads straight off and the stale-marker reconciler treats
  as in-flight. A source reaped this way was therefore deferred on every
  tick, forever, and never retried. ``AggregationService.cancel`` already
  documents this rule and follows it; these paths did not.

So this module is the reapers' equivalent of that ``finally``. It is
deliberately import-light — ``models`` and ``steps`` only — because the
reconciler runs on the crash-recovery path and must not drag the pipeline in.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from .models import AggregationDataSourceStateORM
from .steps import seal_steps

logger = logging.getLogger(__name__)

#: Stable prefixes on the messages these reapers write, in the convention
#: ``write budget:`` established: ``classify_failure`` keys off them rather
#: than off our own prose, which is free to change. Both describe an
#: INFRASTRUCTURE fault rather than anything the job did, which is what makes
#: them worth their own categories — "timeout" points an operator at raising
#: the time limits, and no time limit brings back a dead pod.
WORKER_LOST = "worker lost:"
NEVER_DISPATCHED = "never dispatched:"

#: The PUBLIC mirror's ``aggregation_status`` carries a CHECK constraint the
#: private row does not (``ck_ds_aggregation_status``): it has no
#: 'cancelled'. Forwarding the private value verbatim therefore writes a
#: value the constraint REJECTS — and the violation lands at flush, outside
#: ``sync_workspace_row``'s try/except, so it rolls back the caller's whole
#: tick. Every job that tick reaped stays 'running', the source stays
#: in-flight, and the next tick reaps the same row and fails identically.
#: Mapped to what the event listener writes for the same terminal event
#: (``job.cancelled`` -> 'none'), so a reaped cancel and an observed one
#: leave the mirror saying the same thing.
_MIRROR_STATUS = {"cancelled": "none"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def sync_workspace_row(session: Any, data_source_id: str, **fields: Any) -> None:
    """Best-effort DIRECT sync of the viz-service's ``workspace_data_sources``
    row, for single-DB topologies where no aggregation event listener runs.
    In split-DB topologies the table is absent from the jobs DB, the get
    fails harmlessly and the listener owns the sync."""
    try:
        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, data_source_id)
        if ds is None or ds.deleted_at is not None:
            return
        for key, value in fields.items():
            if value is not None and hasattr(ds, key):
                setattr(ds, key, value)
    except Exception as exc:  # noqa: BLE001 — a mirror must never fail a reap
        logger.debug(
            "workspace_data_sources direct sync skipped for %s: %s",
            data_source_id, exc,
        )


async def release_source(session: Any, job: Any, status: str) -> None:
    """Hand the source back to automation.

    ``trigger()`` sets the source row to ``pending`` and only a worker ever
    moves it off. When the worker dies, someone else has to, or the source
    is in flight forever. The rule is the one ``cancel()`` already applies: a
    job that never started on a never-built source goes back to ``none`` so
    the sweeper's never-built detector can queue its first build again;
    anything else carries the job's own terminal status, which automation
    retries with backoff and the breaker bounds.
    """
    try:
        state = await session.get(
            AggregationDataSourceStateORM, job.data_source_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "reap: could not read source state for %s: %s",
            job.data_source_id, exc,
        )
        return
    if state is None:
        return
    never_ran = (
        getattr(job, "started_at", None) is None
        and not getattr(state, "last_aggregated_at", None)
    )
    state.aggregation_status = "none" if never_ran else status
    await sync_workspace_row(
        session, job.data_source_id,
        aggregation_status=_MIRROR_STATUS.get(
            state.aggregation_status, state.aggregation_status,
        ),
    )


async def invalidate_reads(job: Any) -> None:
    """The fourth thing the worker's ``finally`` does, for a reaper.

    That block emits the terminal event, and ``event_listener`` turns it into
    ``invalidate_aggregated_reads`` for job.failed and job.cancelled alike —
    a dying run may have PARTIALLY written, so cached pre-run answers no
    longer match the store. A reaper emits no event, so nothing invalidated.

    Skipping it is worse than one stale TTL: ``graph_cache._promote_mirror``
    reads an UNMOVED generation as proof the answer is still current and
    re-promotes the pre-run view past every expiry, bounded only by
    ``GRAPH_CACHE_LKG_TTL_S`` (24 h by default). Bumping the generation is
    what ends that, so it belongs on every terminal path, reaped or not.

    ``graph_cache`` is imported here rather than at module scope for the
    reason the module docstring gives — the reconciler runs on the
    crash-recovery path — and the whole call fails open: a reaper that
    raises leaves the row ``running``, which is the state it exists to clear.
    """
    workspace_id = getattr(job, "workspace_id", None)
    if not workspace_id:
        # The cache keys are workspace-scoped, so there is no scope to
        # build — the rule ``event_listener`` applies to the same gap.
        return
    try:
        from backend.app.services import graph_cache

        await graph_cache.invalidate_aggregated_reads(
            str(workspace_id), str(job.data_source_id),
        )
    except Exception as exc:  # noqa: BLE001 — never fail a reap
        logger.warning(
            "reap: aggregated-read invalidation skipped for %s: %s",
            job.data_source_id, exc,
        )


async def reap_job(
    session: Any, job: Any, *, status: str, error_message: Optional[str] = None,
    now_iso: Optional[str] = None, events: Any = None,
) -> None:
    """End ``job`` at ``status`` and leave an honest record behind.

    The whole of what the worker's ``finally`` does that a reaper can still
    do: stamp the row, seal the open step so the ledger names the stage the
    run died in, release the source, and invalidate the aggregated read
    caches the dying run may have already written past. Best-effort
    throughout — a reaper that raises leaves the row ``running``, which is
    the state it exists to clear. The caller commits.

    ``events`` is the caller's publisher, and passing one matters in the
    split-DB topology. There are two mirrors of a source's aggregation
    status: readiness reads ``aggregation.data_source_state``, and the fleet
    Freshness cockpit reads ``public.workspace_data_sources``. A worker keeps
    both in step — directly, and through ``aggregation.events.stream``. A
    reaper had only the direct write, which :func:`release_source` documents
    as a no-op when the public table lives in another database, so a reaped
    run left the cockpit showing the source mid-rebuild forever — and the
    failure-reason join, keyed off that same column, dropped the row, so the
    cause was invisible too. It is a parameter rather than something this
    module resolves for itself: reaping must never wait on a bus, and this
    module stays import-light on purpose.
    """
    now_iso = now_iso or _now()
    job.status = status
    if error_message is not None:
        job.error_message = error_message[:2000]
    job.completed_at = now_iso
    job.updated_at = now_iso
    seal_steps(job, status, now=now_iso)
    await release_source(session, job, status)
    await _announce(events, job, status)
    await invalidate_reads(job)


async def _announce(events: Any, job: Any, status: str) -> None:
    """Publish the terminal event a worker would have published.

    Silent when the caller has no publisher, which keeps the direct mirror
    write as the only behaviour anywhere the bus is not wired up — and keeps
    reaping off the bus entirely in the paths that do not pass one."""
    if events is None:
        return
    try:
        if status == "cancelled":
            await events.job_cancelled(
                job_id=job.id, data_source_id=job.data_source_id,
            )
        else:
            await events.job_failed(
                job_id=job.id,
                data_source_id=job.data_source_id,
                error_message=getattr(job, "error_message", None),
            )
    except Exception as exc:                      # noqa: BLE001 — by contract
        logger.debug(
            "reap: could not announce %s for job %s (%s); the direct mirror "
            "write stands", status, getattr(job, "id", "?"), exc,
        )
