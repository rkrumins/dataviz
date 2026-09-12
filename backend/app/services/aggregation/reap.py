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
        session, job.data_source_id, aggregation_status=state.aggregation_status,
    )


async def reap_job(
    session: Any, job: Any, *, status: str, error_message: Optional[str] = None,
    now_iso: Optional[str] = None,
) -> None:
    """End ``job`` at ``status`` and leave an honest record behind.

    The whole of what the worker's ``finally`` does that a reaper can still
    do: stamp the row, seal the open step so the ledger names the stage the
    run died in, and release the source. Best-effort throughout — a reaper
    that raises leaves the row ``running``, which is the state it exists to
    clear. The caller commits.
    """
    now_iso = now_iso or _now()
    job.status = status
    if error_message is not None:
        job.error_message = error_message[:2000]
    job.completed_at = now_iso
    job.updated_at = now_iso
    seal_steps(job, status, now=now_iso)
    await release_source(session, job, status)
