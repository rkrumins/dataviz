"""ImportExportService — orchestrates bulk import/export jobs (plan Phase 1).

Per-view / per-data-source, independent of the aggregation/ingestion worker. ``create_import_job``
opens (or appends to) the user's working **draft branch** and mints a ``graphver.jobs`` row with
full traceability metadata (workspace/data source/provider/graph); the ``ImportWorker`` then
populates the draft. Terminal review/publish/PR reuse the existing draft workflow — this service
never writes to ``main`` itself.

v1 dispatch is in-process (``run_import`` awaited or scheduled by the caller); a Redis/Postgres
dispatcher can slot in later behind the same call, mirroring the aggregation pattern without
importing it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select

from backend.app.services.storage.object_store import get_object_store, storage_key

from .. import config, db
from ..models import ImportRowORM, JobORM
from ..service import GraphVersioningService
from .export_worker import ExportWorker
from .import_worker import ImportWorker

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ImportExportService:
    def __init__(self, versioning: Optional[GraphVersioningService] = None, store=None) -> None:
        self._svc = versioning or GraphVersioningService()
        self._store = store or get_object_store()

    @property
    def store(self):
        return self._store

    async def create_import_job(
        self,
        *,
        workspace_id: str,
        data_source_id: str,
        graph_id: str,
        actor: str,
        import_format: str,
        source_uri: Optional[str] = None,
        provider_id: Optional[str] = None,
        branch_id: Optional[str] = None,
        reconcile_mode: str = "upsert",
        scope_view_id: Optional[str] = None,
        field_scope: Optional[list] = None,
        auto_publish: bool = False,
        idempotency_key: Optional[str] = None,
        name: Optional[str] = None,
    ) -> Dict[str, str]:
        """Open/append the working draft and create the import job.

        Returns ``{job_id, branch_id, source_uri}``. When ``source_uri`` is omitted it is minted
        from the traceable ``{ws}/{ds}/{graph}/{job}/source.<fmt>`` layout (the caller then streams
        the upload to it). ``branch_id`` supplied -> stack onto that existing draft (multiple
        imports per branch, like successive manual edits); omitted -> open a fresh import draft.
        """
        if branch_id is None:
            branch_id = await self._svc.open_draft(
                graph_id=graph_id, owner=actor, name=name or "Import")

        async with db.graphver_session() as s:
            job = JobORM(
                job_type="ingest", graph_id=graph_id, workspace_id=workspace_id,
                data_source_id=data_source_id, provider_id=provider_id,
                scope_view_id=scope_view_id, branch_id=branch_id,
                reconcile_mode=reconcile_mode, import_format=import_format,
                field_scope=field_scope, auto_publish=auto_publish,
                source_uri=source_uri, idempotency_key=idempotency_key, status="pending",
            )
            s.add(job)
            await s.flush()
            job_id = job.id
            if source_uri is None:
                source_uri = storage_key(
                    workspace_id, data_source_id, graph_id, job_id, f"source.{import_format}")
                job.source_uri = source_uri
        return {"job_id": job_id, "branch_id": branch_id, "source_uri": source_uri}

    async def run_import_safe(self, job_id: str) -> None:
        """Run the import, marking the job ``failed`` on any error (dispatch entrypoint)."""
        await self._run_safe(job_id, self.run_import)

    async def _run_safe(self, job_id: str, runner) -> None:
        try:
            await runner(job_id)
        except Exception as exc:  # pragma: no cover - defensive; recorded on the job row
            logger.exception("job %s failed", job_id)
            async with db.graphver_session() as s:
                row = await s.get(JobORM, job_id)
                if row is not None:
                    row.status = "failed"
                    row.error_message = str(exc)[:2000]
                    row.completed_at = _now()

    async def get_preview(self, job_id: str, *, sample_limit: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Job summary + a bounded sample of resolved rows (the inline preview; the full diff is
        the draft-vs-main diff via the existing versioning endpoints)."""
        limit = sample_limit or config.PREVIEW_SAMPLE_LIMIT
        job = await self.get_job(job_id)
        if job is None:
            return None
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM).where(ImportRowORM.job_id == job_id)
                .order_by(ImportRowORM.row_index).limit(limit))).scalars().all()
            sample = [{"rowIndex": r.row_index, "kind": r.kind, "op": r.resolved_op,
                       "status": r.status, "matchedEntityId": r.matched_entity_id,
                       "reasons": r.reasons or []} for r in rows]
        return {"job": job, "summary": job.get("summary"), "sample": sample,
                "previewDownloadUrl": job.get("preview_uri"),
                "rejectedDownloadUrl": job.get("report_uri")}

    async def list_jobs(
        self, *, graph_id: Optional[str] = None, data_source_id: Optional[str] = None,
        job_type: Optional[str] = None, limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Jobs for a graph / data source — the per-view/per-data-source history surface."""
        async with db.graphver_session() as s:
            q = select(JobORM)
            if graph_id:
                q = q.where(JobORM.graph_id == graph_id)
            if data_source_id:
                q = q.where(JobORM.data_source_id == data_source_id)
            if job_type:
                q = q.where(JobORM.job_type == job_type)
            q = q.order_by(JobORM.created_at.desc()).limit(limit)
            rows = (await s.execute(q)).scalars().all()
            return [{"job_id": r.id, "job_type": r.job_type, "status": r.status,
                     "branch_id": r.branch_id, "import_format": r.import_format,
                     "reconcile_mode": r.reconcile_mode, "summary": r.summary,
                     "scope_view_id": r.scope_view_id, "created_at": r.created_at,
                     "completed_at": r.completed_at, "error_message": r.error_message}
                    for r in rows]

    async def run_import(self, job_id: str) -> Dict[str, int]:
        """Run the import job to completion in-process (v1 dispatch)."""
        return await ImportWorker(self._svc, self._store).run(job_id)

    async def create_export_job(
        self,
        *,
        workspace_id: str,
        data_source_id: str,
        graph_id: str,
        actor: str,
        export_format: str = "ndjson",
        as_of_seq: Optional[int] = None,
        scope_view_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, str]:
        """Create an export job; mints the ``export.<fmt>`` artifact key. Returns
        ``{job_id, result_uri}``. A whole-data-source export is a re-importable backup."""
        async with db.graphver_session() as s:
            job = JobORM(
                job_type="export", graph_id=graph_id, workspace_id=workspace_id,
                data_source_id=data_source_id, provider_id=provider_id,
                scope_view_id=scope_view_id, import_format=export_format, as_of_seq=as_of_seq,
                idempotency_key=idempotency_key, status="pending",
            )
            s.add(job)
            await s.flush()
            job_id = job.id
            result_uri = storage_key(
                workspace_id, data_source_id, graph_id, job_id, f"export.{export_format}")
            job.result_uri = result_uri
        return {"job_id": job_id, "result_uri": result_uri}

    async def run_export(self, job_id: str) -> Dict[str, int]:
        return await ExportWorker(self._svc, self._store).run(job_id)

    async def run_export_safe(self, job_id: str) -> None:
        await self._run_safe(job_id, self.run_export)

    async def open_result(self, job_id: str):
        """Return ``(job, byte-stream)`` for downloading a completed export, else ``None``."""
        job = await self.get_job(job_id)
        if job is None or not job.get("result_uri"):
            return None
        return job, self._store.open_stream(job["result_uri"])

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                return None
            return {
                "job_id": row.id, "job_type": row.job_type, "status": row.status,
                "graph_id": row.graph_id, "branch_id": row.branch_id,
                "workspace_id": row.workspace_id, "data_source_id": row.data_source_id,
                "provider_id": row.provider_id, "scope_view_id": row.scope_view_id,
                "reconcile_mode": row.reconcile_mode, "import_format": row.import_format,
                "source_uri": row.source_uri, "preview_uri": row.preview_uri,
                "report_uri": row.report_uri, "result_uri": row.result_uri,
                "summary": row.summary, "error_message": row.error_message,
                "created_at": row.created_at, "completed_at": row.completed_at,
            }
