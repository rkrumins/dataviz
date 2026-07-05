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
from ..models import BranchORM, ImportRowORM, JobORM
from ..service import GraphVersioningService
from .export_worker import (
    ExportWorker, column_order, example_template_records, records_from_state,
)
from .formats import get_adapter
from .import_worker import ImportWorker

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ImportExportService:
    def __init__(
        self,
        versioning: Optional[GraphVersioningService] = None,
        store=None,
        scope_resolver=None,
        ontology_resolver=None,
    ) -> None:
        self._svc = versioning or GraphVersioningService()
        self._store = store or get_object_store()
        # Optional async ``(workspace_id, data_source_id, view_id) -> scope dict | None`` — resolves
        # a view's scope for view-scoped export AND view-scoped replace. Injected at the API layer
        # (management-DB access), so the worker stays decoupled.
        self._scope_resolver = scope_resolver
        # Optional async ``(workspace_id, data_source_id) -> {node_types, edge_types} | None`` — the
        # live ontology types for the per-row import gate. Injected the same way.
        self._ontology_resolver = ontology_resolver

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
            # Surface the actual CHANGES (skip unchanged noise) with a human label, so the dialog can
            # show "T0 · updated", "orders · new", "row 13 · invalid: <reason>" — a real preview.
            rows = (await s.execute(
                select(ImportRowORM)
                .where(ImportRowORM.job_id == job_id, ImportRowORM.status != "unchanged")
                .order_by(ImportRowORM.row_index).limit(limit))).scalars().all()
            sample = [{"rowIndex": r.row_index, "kind": r.kind, "op": r.resolved_op,
                       "status": r.status, "matchedEntityId": r.matched_entity_id,
                       "label": (r.raw or {}).get("displayName") or (r.raw or {}).get("qualifiedName")
                                or (r.raw or {}).get("urn") or "",
                       "reasons": r.reasons or []} for r in rows]
        return {"job": job, "summary": job.get("summary"), "sample": sample,
                "previewDownloadUrl": job.get("previewUri"),
                "rejectedDownloadUrl": job.get("reportUri")}

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
            return [{"jobId": r.id, "jobType": r.job_type, "status": r.status,
                     "branchId": r.branch_id, "importFormat": r.import_format,
                     "reconcileMode": r.reconcile_mode, "summary": r.summary,
                     "scopeViewId": r.scope_view_id, "createdAt": r.created_at,
                     "completedAt": r.completed_at, "errorMessage": r.error_message}
                    for r in rows]

    async def run_import(self, job_id: str) -> Dict[str, int]:
        """Run the import job to completion in-process (v1 dispatch). Resolves the live ontology
        types (per-row gate) and — for a view-scoped **replace** — the view's scope, so absence-
        deletes stay confined to the view's own entities."""
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            ws, ds, view_id, mode = ((row.workspace_id, row.data_source_id, row.scope_view_id,
                                      row.reconcile_mode) if row else (None, None, None, None))
        scope = None
        if mode == "replace" and view_id and self._scope_resolver is not None:
            scope = await self._scope_resolver(ws, ds, view_id)
        ontology = None
        if self._ontology_resolver is not None:
            ontology = await self._ontology_resolver(ws, ds)
        return await ImportWorker(self._svc, self._store, scope=scope, ontology=ontology).run(job_id)

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
        extra_props: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, str]:
        """Create an export job; mints the ``export.<fmt>`` artifact key. Returns
        ``{job_id, result_uri}``. A whole-data-source export is a re-importable backup.
        ``extra_props`` = property names to emit as (empty) columns so the user can add them."""
        async with db.graphver_session() as s:
            job = JobORM(
                job_type="export", graph_id=graph_id, workspace_id=workspace_id,
                data_source_id=data_source_id, provider_id=provider_id,
                scope_view_id=scope_view_id, import_format=export_format, as_of_seq=as_of_seq,
                field_scope=extra_props or None, idempotency_key=idempotency_key, status="pending",
            )
            s.add(job)
            await s.flush()
            job_id = job.id
            result_uri = storage_key(
                workspace_id, data_source_id, graph_id, job_id, f"export.{export_format}")
            job.result_uri = result_uri
        return {"job_id": job_id, "result_uri": result_uri}

    async def run_export(self, job_id: str) -> Dict[str, int]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            ws, ds, view_id, extra_props = ((row.workspace_id, row.data_source_id, row.scope_view_id,
                                             row.field_scope) if row else (None, None, None, None))
        scope = None
        if view_id and self._scope_resolver is not None:
            scope = await self._scope_resolver(ws, ds, view_id)
        return await ExportWorker(self._svc, self._store, scope=scope,
                                  extra_props=extra_props or []).run(job_id)

    async def run_export_safe(self, job_id: str) -> None:
        await self._run_safe(job_id, self.run_export)

    async def open_result(self, job_id: str):
        """Return ``(job, byte-stream)`` for downloading a completed export, else ``None``."""
        job = await self.get_job(job_id)
        if job is None or not job.get("resultUri"):
            return None
        return job, self._store.open_stream(job["resultUri"])

    async def build_template(self, *, graph_id: str, export_format: str = "csv", limit: int = 5) -> bytes:
        """A small, prepopulated starter template so users learn the format instantly: the column
        schema + up to ``limit`` real rows from the graph (edit-in-place), or worked example rows
        when the graph is empty. Synchronous (tiny) — returned inline for a direct download."""
        async with db.graphver_session() as s:
            main_id = (await s.execute(
                select(BranchORM.id).where(
                    BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()
        state = await self._svc.materialize_state(graph_id=graph_id, branch_id=main_id)
        nodes = dict(list(state["nodes"].items())[:limit])
        edges = dict(list(state["edges"].items())[:limit])
        records = records_from_state(nodes, edges) or example_template_records()
        columns = column_order(records)
        adapter = get_adapter(export_format)

        async def _iter():
            for rec in records:
                yield rec

        chunks: List[bytes] = []
        async for b in adapter.write(_iter(), columns=columns):
            chunks.append(b)
        return b"".join(chunks)

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Job as a camelCase dict (frontend wire shape)."""
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                return None
            return {
                "jobId": row.id, "jobType": row.job_type, "status": row.status,
                "graphId": row.graph_id, "branchId": row.branch_id,
                "workspaceId": row.workspace_id, "dataSourceId": row.data_source_id,
                "providerId": row.provider_id, "scopeViewId": row.scope_view_id,
                "reconcileMode": row.reconcile_mode, "importFormat": row.import_format,
                "sourceUri": row.source_uri, "previewUri": row.preview_uri,
                "reportUri": row.report_uri, "resultUri": row.result_uri,
                "summary": row.summary, "errorMessage": row.error_message,
                "createdAt": row.created_at, "completedAt": row.completed_at,
            }
