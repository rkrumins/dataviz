"""Import and export jobs on the versioning worker, off the API pods.

With ``GRAPHVER_TRANSFER_INPROCESS`` off, an API process only queues the jobs it creates
(:meth:`ImportExportService.start_import` / ``start_export``): the job row stays ``pending``, in
phase ``queued``, once its inputs are stored. The versioning worker claims queued jobs here, oldest
first, with ``FOR UPDATE SKIP LOCKED``: a job goes to one worker only, and no worker waits on
another's claim. It runs them ``GRAPHVER_TRANSFER_SLOTS`` at a time (the worker's
``_transfer_loop``). A job whose worker goes away mid-run reads as failed once its heartbeat is
stale, as it does in-process.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Optional, Tuple

from sqlalchemy import select

from .. import db
from ..models import JobORM

# The phase of a pending job that is ready to run: its file is stored, and a worker may take it.
QUEUED = "queued"
JOB_TYPES = ("ingest", "export")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TransferRunner:
    def __init__(self, service_factory: Callable[[], object], *, session_factory=None) -> None:
        # Builds the API's own ImportExportService (its view-scope, ontology and layout hooks).
        self._service_factory = service_factory
        self._session = session_factory or db.graphver_session

    async def claim_one(self) -> Optional[Tuple[str, str]]:
        """Take the oldest queued job and mark it running: ``(job_id, job_type)``, or ``None``."""
        async with self._session() as s:
            row = (await s.execute(
                select(JobORM).where(JobORM.job_type.in_(JOB_TYPES), JobORM.status == "pending",
                                     JobORM.current_phase == QUEUED)
                .order_by(JobORM.created_at).limit(1).with_for_update(skip_locked=True)
            )).scalars().first()
            if row is None:
                return None
            row.status, row.current_phase = "running", None
            row.started_at = row.updated_at = _now()
            return row.id, row.job_type

    async def run_job(self, job_id: str, job_type: str) -> None:
        """Run a claimed job to the end; a failure is recorded on the job, never raised."""
        ie = self._service_factory()
        await (ie.run_import_safe if job_type == "ingest" else ie.run_export_safe)(job_id)
