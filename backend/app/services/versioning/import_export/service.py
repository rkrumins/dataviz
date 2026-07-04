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

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from backend.app.services.storage.object_store import get_object_store

from .. import db
from ..models import JobORM
from ..service import GraphVersioningService
from .import_worker import ImportWorker


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
        source_uri: str,
        provider_id: Optional[str] = None,
        branch_id: Optional[str] = None,
        reconcile_mode: str = "upsert",
        scope_view_id: Optional[str] = None,
        field_scope: Optional[list] = None,
        auto_publish: bool = False,
        idempotency_key: Optional[str] = None,
        name: Optional[str] = None,
    ) -> Dict[str, str]:
        """Open/append the working draft and create the import job. Returns ``{job_id, branch_id}``.

        ``branch_id`` supplied -> stack onto that existing draft (multiple imports per branch,
        like successive manual edits); omitted -> open a fresh import draft off ``main``.
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
        return {"job_id": job_id, "branch_id": branch_id}

    async def run_import(self, job_id: str) -> Dict[str, int]:
        """Run the import job to completion in-process (v1 dispatch)."""
        return await ImportWorker(self._svc, self._store).run(job_id)

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
