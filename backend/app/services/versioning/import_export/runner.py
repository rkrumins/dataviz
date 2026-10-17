"""Import, export and publish jobs on the versioning worker's transfer lane, off the API pods.

An API process only queues the jobs it creates (:meth:`ImportExportService.start_import` /
``start_export`` / ``start_publish``): the job row stays ``pending``, in phase ``queued``, once its
inputs are stored. The transfer lane claims queued jobs here through :func:`job_lease.claim` —
``FOR UPDATE SKIP LOCKED``, fair per workspace, every claim a new epoch — and runs them
``GRAPHVER_TRANSFER_SLOTS`` at a time, plus one slot of its own for ``package_inspect`` so a person
waiting on an upload never queues behind a 10-minute import. A job whose worker dies is taken over
once its heartbeat is stale and resumed from its cursor; a stopping worker releases its jobs.
:class:`JobReaper` fails the jobs nothing will ever run.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Sequence

from sqlalchemy import update

from .. import config, db, job_lease
from ..job_lease import INSPECT_TYPES, QUEUED, Lease  # QUEUED: callers import it from here
from ..models import JobORM

logger = logging.getLogger(__name__)

# The jobs the transfer slots take (the general ones, and the dedicated inspect slot), and the
# service entry point that runs each: called as ``entry(job_id, lease)``, it records a failure on
# the job rather than raising.
_ENTRY_POINTS = {"ingest": "run_import_safe", "export": "run_export_safe",
                 "publish": "run_publish_safe", "package_inspect": "run_inspect_safe"}
JOB_TYPES = job_lease.TRANSFER_TYPES


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


class TransferRunner:
    """Claims and runs transfer jobs of ``types``: the general slots (``JOB_TYPES``), or the
    dedicated inspect slot (``types=INSPECT_TYPES``)."""

    def __init__(self, service_factory: Callable[[], object], *, session_factory=None,
                 types: Sequence[str] = JOB_TYPES) -> None:
        # Builds the API's own ImportExportService (its view-scope, ontology and layout hooks).
        self._service_factory = service_factory
        self._session = session_factory or db.graphver_session
        self._types = tuple(types)

    async def claim_one(self) -> Optional[Lease]:
        """Take the next queued (or abandoned) job of this runner's types, or ``None``."""
        return await job_lease.claim(self._session, self._types,
                                     phase_pred=job_lease.TRANSFER_READY, lane="transfer")

    async def run_job(self, lease: Lease) -> None:
        """Run a claimed job to the end; a failure is recorded on the job, never raised. A type this
        runner doesn't know is failed, never run as some other kind of job."""
        ie = self._service_factory()
        entry = _ENTRY_POINTS.get(lease.job_type)
        if entry is None:
            await lease.fail(f"this worker doesn't run {lease.job_type!r} jobs")
            return
        await getattr(ie, entry)(lease.job_id, lease)


class JobReaper:
    """Fails the transfer jobs nothing will ever run, so their dialogs stop waiting.

    * QUEUED too long — no worker took it in ``TRANSFER_QUEUE_TIMEOUT_SECS`` (counted from when it
      was queued, or last handed back): the transfer lane is not running.
    * NEVER QUEUED — pending with no phase for an hour: its creator never finished storing the
      input (the upload was cut off, the API pod died), so it will never be queued.

    The status GET used to do this as a side effect of being read; it is read-only now, and this
    runs on the transfer lane every minute instead. ``job_id`` judges that one job alone: an
    import refused because its draft has an active job asks whether that job still counts."""

    def __init__(self, *, session_factory=None) -> None:
        self._session = session_factory or db.graphver_session

    async def run_once(self, job_id: Optional[str] = None) -> Dict[str, int]:
        types = JOB_TYPES + INSPECT_TYPES
        now = _now()
        failed = {"status": "failed", "completed_at": now, "updated_at": now}
        which = (JobORM.job_type.in_(types), JobORM.status == "pending") + (
            (JobORM.id == job_id,) if job_id else ())
        async with self._session() as s:
            timed_out = (await s.execute(
                update(JobORM).where(
                    *which, JobORM.current_phase == QUEUED,
                    JobORM.updated_at < _ago(config.TRANSFER_QUEUE_TIMEOUT_SECS))
                .values(error_message=config.JOB_NOT_STARTED, **failed)
                .execution_options(synchronize_session=False))).rowcount
            abandoned = (await s.execute(
                update(JobORM).where(
                    *which, JobORM.current_phase.is_(None),
                    JobORM.created_at < _ago(config.JOB_NEVER_QUEUED_SECS))
                .values(error_message=config.JOB_NEVER_QUEUED, **failed)
                .execution_options(synchronize_session=False))).rowcount
        if timed_out or abandoned:
            logger.warning("job reaper: %d queued job(s) timed out, %d never-queued job(s) failed",
                           timed_out, abandoned)
        return {"timedOut": timed_out or 0, "neverQueued": abandoned or 0}
