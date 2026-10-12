"""ImportExportService — orchestrates bulk import/export jobs (plan Phase 1).

Per-view / per-data-source, independent of the aggregation/ingestion worker. ``create_import_job``
opens (or appends to) the user's working **draft branch** and mints a ``graphver.jobs`` row with
full traceability metadata (workspace/data source/provider/graph); the ``ImportWorker`` then
populates the draft. Terminal review/publish/PR reuse the existing draft workflow — this service
never writes to ``main`` itself.

A job never runs in the API process: once its inputs are stored the caller queues it with
:meth:`ImportExportService.start_import` / ``start_export`` / ``start_publish``, and the versioning
worker's transfer lane claims it from ``jobs`` and runs it on a lease (:mod:`.runner`,
:mod:`..job_lease`).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from backend.app.services.storage.object_store import get_object_store, storage_key

from .. import config, db
from ..job_lease import Draining, Lease, Superseded, friendly_infra_error, is_transient
from ..models import ImportRowORM, JobORM
from ..service import GraphVersioningService
from . import stream
from .export_worker import ExportWorker, example_template_records
from .formats import get_adapter
from .import_worker import ImportWorker, lease_job
from .rowmodel import column_order
from .runner import INSPECT_TYPES, JOB_TYPES, QUEUED
from .snapshot import open_snapshot
from .uploads import PACKAGE_PREFIX

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _silent_secs(row: JobORM) -> float:
    """Seconds since the job last showed life: its heartbeat, else its start, else its creation."""
    last = datetime.fromisoformat(row.updated_at or row.started_at or row.created_at)
    return (datetime.now(timezone.utc) - last).total_seconds()


class ImportExportService:
    def __init__(
        self,
        versioning: Optional[GraphVersioningService] = None,
        store=None,
        scope_resolver=None,
        ontology_resolver=None,
        layout_writer=None,
        publish_hook=None,
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
        # Optional async ``(workspace_id, data_source_id, view_id, created_node_facts,
        # batch_edge_facts) -> {added: N}`` — writes canonical layer assignments for a view-scoped
        # import's newly-created top-level entities. Injected at the API layer (management-DB access).
        self._layout_writer = layout_writer
        # Optional async ``(job) -> {"commitId": id} | {"error": {"status", "detail"}}`` — publishes
        # a draft or merges its review, with what a publish sets off after it lands. Injected at the
        # API layer, which resolves the ontology and owns those side effects; a refusal comes back
        # as the HTTP answer the route gives when it publishes inside the request.
        self._publish_hook = publish_hook

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

    async def start_import(self, job_id: str) -> str:
        """Queue the import once its file is stored. Returns the status to report."""
        return await self._start(job_id)

    async def start_export(self, job_id: str) -> str:
        """Queue the export once its inputs are stored. Returns the status to report."""
        return await self._start(job_id)

    async def start_inspect(self, job_id: str) -> str:
        """Queue a package inspection (its own slot on the transfer lane). Returns the status."""
        return await self._start(job_id)

    async def find_job(self, *, graph_id: str, idempotency_key: str) -> Optional[Dict[str, Any]]:
        """The job created for ``idempotency_key`` on ``graph_id`` (as :meth:`get_job` reads it),
        or ``None``: what a retried or replayed request answers with instead of a second job."""
        async with db.graphver_session() as s:
            job_id = (await s.execute(select(JobORM.id).where(
                JobORM.graph_id == graph_id, JobORM.idempotency_key == idempotency_key))).scalar_one_or_none()
        return await self.get_job(job_id) if job_id else None

    async def create_inspect_job(self, *, upload_id: str, source_uri: str) -> Tuple[str, bool]:
        """The ``package_inspect`` job for a package upload (``source_uri``: its record) — one per
        upload, however often its completion is asked for. Returns its id, and whether this call
        created it."""
        key = f"inspect:{upload_id}"
        try:
            async with db.graphver_session() as s:
                job = JobORM(job_type="package_inspect", graph_id=PACKAGE_PREFIX, source_uri=source_uri,
                             idempotency_key=key, status="pending")
                s.add(job)
                await s.flush()
                job_id = job.id
            return job_id, True
        except IntegrityError:                      # a concurrent completion created it first
            return (await self.find_job(graph_id=PACKAGE_PREFIX, idempotency_key=key))["jobId"], False

    async def _start(self, job_id: str) -> str:
        """Queue the job for the versioning worker's transfer lane (:mod:`.runner`). It never runs
        in the API process: there it shared a web pod's CPU, memory and event loop with interactive
        requests, and a restart or a worker timeout lost it."""
        async with db.graphver_session() as s:
            await s.execute(update(JobORM).where(JobORM.id == job_id, JobORM.status == "pending")
                            .values(current_phase=QUEUED, updated_at=_now()))
        return "pending"

    async def run_import_safe(self, job_id: str, lease: Lease) -> None:
        """Run the import on ``lease``, recording any error on the job (transfer-lane entry point)."""
        await self._run_safe(job_id, lease, self.run_import)

    async def _run_safe(self, job_id: str, lease: Lease, runner) -> None:
        """Run ``runner(job_id, lease=lease)`` and settle the lease however it ends:

        * superseded — another worker owns the job now; its last write rolled back. Stop quietly.
        * draining, or cancelled (the worker is stopping) — hand the job back, so another worker
          resumes it. Shielded: the release must land even as this task is cancelled.
        * any other error — fail the job, fenced (a zombie's failure is a no-op)."""
        try:
            await runner(job_id, lease=lease)
        except Superseded as exc:
            logger.info("job %s handed off: %s", job_id, exc)
        except (Draining, asyncio.CancelledError) as exc:
            logger.warning("job %s stopped for the worker's shutdown; releasing it", job_id)
            try:
                await asyncio.shield(lease.release())
            except Exception:  # noqa: BLE001 — unreleased, it goes stale and is taken over
                logger.exception("releasing job %s failed", job_id)
            if isinstance(exc, asyncio.CancelledError):
                raise
        except Exception as exc:
            logger.exception("job %s failed", job_id)
            if is_transient(exc):          # an outage that outlasted the retry budget: resumable
                await lease.fail(friendly_infra_error(exc), "infrastructure", "resume")
            else:
                await lease.fail(str(exc), "internal")

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

    async def run_import(self, job_id: str, lease: Optional[Lease] = None) -> Dict[str, int]:
        """Run the import job to completion (on ``lease`` when the transfer lane runs it). Resolves
        the live ontology types (per-row gate) and — for a view-scoped **replace** — the view's
        scope, so absence-deletes stay confined to the view's own entities."""
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
        worker = ImportWorker(self._svc, self._store, scope=scope, ontology=ontology,
                              facts=bool(view_id and self._layout_writer is not None))
        # Called directly (tools, tests faking ImportWorker) there is no lease to pass on: the
        # worker takes the job itself.
        summary = await (worker.run(job_id, lease=lease) if lease is not None
                         else worker.run(job_id))
        # Post-commit: a view-scoped import that created new top-level entities writes canonical layer
        # assignments so the curated view shows them right away. Best-effort — never fails the import.
        if view_id and self._layout_writer is not None and worker.created_node_facts:
            await self._apply_view_layout(job_id, ws, ds, view_id, worker)
        return summary

    async def _apply_view_layout(self, job_id, ws, ds, view_id, worker) -> None:
        """Hand the import's newly-created top-level entities to the injected layout writer and record
        the outcome on ``job.summary`` (``viewAssignments: {added: N}`` or ``{error: ...}``). The
        import is already committed and marked ``completed`` by the worker before this runs, so any
        failure here is isolated: it is logged + noted, never raised (which would flip the job to
        ``failed`` via ``run_import_safe``)."""
        try:
            try:
                result = await self._layout_writer(
                    ws, ds, view_id, worker.created_node_facts, worker.batch_edge_facts)
                note = {"added": int((result or {}).get("added", 0))}
            except Exception as exc:  # pragma: no cover - defensive; recorded on the job row
                logger.exception("view layout write-back failed for import job %s", job_id)
                note = {"error": str(exc)[:500]}
            async with db.graphver_session() as s:
                row = await s.get(JobORM, job_id)
                if row is not None:
                    summary = dict(row.summary or {})
                    summary["viewAssignments"] = note
                    row.summary = summary
                    row.updated_at = _now()
        except Exception:  # pragma: no cover - defensive; must never fail the completed import
            logger.exception("recording view-assignment summary failed for import job %s", job_id)

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
        branch_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        extra_props: Optional[List[str]] = None,
        select_ids: Optional[List[str]] = None,
        select_types: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
        package: Optional[Dict[str, Any]] = None,
        file_name: Optional[str] = None,
    ) -> Dict[str, str]:
        """Create an export job; mints the ``export.<fmt>`` artifact key. Returns
        ``{job_id, result_uri}``. A whole-data-source export is a re-importable backup.
        ``branch_id`` exports that working branch's composed state (main + committed + draft),
        defaulting to published main. Export options (``props``/``ids``/``types``) ride in
        ``field_scope``: ``extra_props`` = empty columns to add; ``select_ids``/``select_types`` =
        row-scope to just those entities / entity types. ``package`` makes the job a view package's
        (view_transfer.package): the views' file is built from the versions sealed for it, then the
        data is written into the package as it streams. ``file_name`` names the download."""
        options: Dict[str, Any] = {}
        if package:
            options["package"] = package
        if file_name:
            options["fileName"] = file_name
        if extra_props:
            options["props"] = extra_props
        if select_ids:
            options["ids"] = select_ids
        if select_types:
            options["types"] = select_types
        async with db.graphver_session() as s:
            job = JobORM(
                job_type="export", graph_id=graph_id, workspace_id=workspace_id,
                data_source_id=data_source_id, provider_id=provider_id,
                scope_view_id=scope_view_id, branch_id=branch_id,
                import_format=export_format, as_of_seq=as_of_seq,
                field_scope=options or None, idempotency_key=idempotency_key, status="pending",
            )
            s.add(job)
            await s.flush()
            job_id = job.id
            result_uri = storage_key(
                workspace_id, data_source_id, graph_id, job_id, f"export.{export_format}")
            job.result_uri = result_uri
        return {"job_id": job_id, "result_uri": result_uri}

    async def run_export(self, job_id: str, lease: Optional[Lease] = None) -> Dict[str, int]:
        lease = lease or await lease_job(job_id)
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            ws, ds, view_id, branch_id, options = (
                (row.workspace_id, row.data_source_id, row.scope_view_id,
                 row.branch_id, row.field_scope)
                if row else (None, None, None, None, None))
        scope, package = None, None
        if (options or {}).get("package"):
            # A view package: its views first, and a view's data scoped by the version it holds
            # (view_transfer.package) — never by the view as it is now, and never, failing that,
            # the whole data source.
            from backend.app.services.view_transfer.package import PackageExport

            package = PackageExport(options["package"], workspace_id=ws, data_source_id=ds)
            scope = await package.prepare(self._phase(lease))
        elif view_id and self._scope_resolver is not None:
            # Branch-effective: an export of a draft branch scopes to that
            # draft's own view assignments (base ⊕ overlay).
            scope = await self._scope_resolver(ws, ds, view_id, branch_id)
        return await ExportWorker(self._svc, self._store, scope=scope, options=options or {},
                                  package=package).run(job_id, lease=lease)

    async def run_export_safe(self, job_id: str, lease: Lease) -> None:
        await self._run_safe(job_id, lease, self.run_export)

    @staticmethod
    def _phase(lease: Lease):
        """``phase(name, **job columns)``: the job enters phase ``name`` — a fenced checkpoint,
        and where a superseded or stopping worker stops."""
        async def phase(name: str, **values) -> None:
            lease.check()
            async with db.graphver_session() as s:
                await lease.checkpoint(s, current_phase=name, **values)
        return phase

    async def run_inspect(self, job_id: str, lease: Optional[Lease] = None) -> Dict[str, Any]:
        """Check a package upload (view_transfer.package.inspect_upload) on ``lease`` — the
        transfer lane's inspect slot — and finish the job with what was found. A file that is no
        package it can take completes the job too: the answer is on the upload, for its dialog."""
        from backend.app.services.view_transfer.package import inspect_upload

        lease = lease or await lease_job(job_id)
        async with db.graphver_session() as s:
            source_uri = (await s.get(JobORM, job_id)).source_uri
        summary = await inspect_upload(self._store, source_uri, self._phase(lease))
        if not await lease.finish("completed", summary=summary, progress=100):
            raise Superseded(f"inspect job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        return summary

    async def run_inspect_safe(self, job_id: str, lease: Lease) -> None:
        await self._run_safe(job_id, lease, self.run_inspect)

    async def create_publish_job(
        self, *, workspace_id: str, data_source_id: Optional[str], graph_id: str, branch_id: str,
        actor: str, message: str, resolutions: Optional[Dict[str, Any]] = None,
        merge_request_id: Optional[str] = None,
    ) -> Dict[str, str]:
        """A publish of a draft too large to publish inside a request — or the merge of its review
        (``merge_request_id``), queued like an export. The request rides in ``field_scope``."""
        fields: Dict[str, Any] = {"actor": actor, "message": message}
        if resolutions:
            fields["resolutions"] = resolutions
        if merge_request_id:
            fields["mergeRequestId"] = merge_request_id
        async with db.graphver_session() as s:
            job = JobORM(job_type="publish", graph_id=graph_id, workspace_id=workspace_id,
                         data_source_id=data_source_id, branch_id=branch_id,
                         field_scope=fields, status="pending")
            s.add(job)
            await s.flush()
            return {"job_id": job.id}

    async def start_publish(self, job_id: str) -> str:
        """Queue the publish job (see :meth:`_start`). Returns the status to report."""
        return await self._start(job_id)

    async def run_publish(self, job_id: str, lease: Optional[Lease] = None) -> Dict[str, Any]:
        """Publish the job's draft (or merge its review) through the injected hook, on ``lease`` —
        the transfer lane's, which keeps a large squash alive while it says nothing until it lands;
        called without one, the job is taken here (:func:`.import_worker.lease_job`). The hook's
        answer is the job's summary, and a refusal fails the job; both through the fenced finish.

        Safe to run again. An earlier attempt may have merged the draft and died (or been taken
        over) before it finished the job: a merged draft is not published twice — the hook is told
        the commit it landed as (``mergedCommitId``) and runs only what a publish sets off. So too
        when the publish is refused because the draft merged under it: a superseded attempt's
        squash landed first."""
        lease = lease or await lease_job(job_id)
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            job = {**(row.field_scope or {}), "graphId": row.graph_id, "branchId": row.branch_id,
                   "workspaceId": row.workspace_id, "dataSourceId": row.data_source_id}
        merged = await self._svc.merged_commit_id(graph_id=job["graphId"], branch_id=job["branchId"])
        result = await self._publish_hook(job if merged is None else {**job, "mergedCommitId": merged})
        if "error" in result:
            merged = await self._svc.merged_commit_id(graph_id=job["graphId"], branch_id=job["branchId"])
            if merged is not None:
                result = await self._publish_hook({**job, "mergedCommitId": merged})
        values: Dict[str, Any] = {"summary": result}
        if "error" in result:
            detail = result["error"].get("detail")
            values.update(status="failed", error_message=str(
                detail.get("message") or detail.get("type") if isinstance(detail, dict) else detail)[:2000])
        if not await lease.finish(**values):
            raise Superseded(f"publish job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        return result

    async def run_publish_safe(self, job_id: str, lease: Lease) -> None:
        await self._run_safe(job_id, lease, self.run_publish)

    async def requeue_failed(self, job_id: str) -> bool:
        """Queue a FAILED job again — a person asked to retry it — to resume from its cursor.

        Only a failed job: a pending or running one belongs to the queue or to the worker running
        it, and queuing it again would give two workers one epoch. Its takeover count starts over
        (a person decided to run it again) and its failure is cleared; the next claim bumps the
        epoch. A job with no cursor starts over: rows staged by a worker from before leases (with
        no cursor to resume them by) are dropped, or the claim would fail it again on sight.
        True when the job was queued."""
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id, with_for_update=True)
            if row is None or row.status != "failed":
                return False
            if row.last_cursor is None:
                await s.execute(delete(ImportRowORM).where(ImportRowORM.job_id == job_id))
            summary = row.summary if isinstance(row.summary, dict) else {}
            row.summary = {k: v for k, v in summary.items() if k not in ("takeovers", "failure")} or None
            row.status, row.current_phase = "pending", QUEUED
            row.error_message = row.completed_at = None
            row.updated_at = _now()
        return True

    async def build_template(self, *, graph_id: str, export_format: str = "csv", limit: int = 5) -> bytes:
        """A small, prepopulated starter template so users learn the format instantly: the column
        schema + up to ``limit`` real rows from the graph (edit-in-place), or worked example rows
        when the graph is empty. Reads one page of each kind from published main, never the whole
        graph — returned inline for a direct download."""
        snap = await open_snapshot(graph_id=graph_id, page_size=limit)
        records = await stream.first_records(snap, limit) or example_template_records()
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
        """Job as a camelCase dict (frontend wire shape). READ-ONLY: polled by every open dialog, so
        it never writes. A job whose worker died is not reported failed here — it reads ``stale``
        (silent past ``INGEST_STALE_SECS``) until another worker takes it over and resumes it; one
        nothing will run is failed by the transfer lane's :class:`.runner.JobReaper`. A queued job
        says how many jobs of its slot are queued before it (``queuedAhead``), and every job how
        far it has got (``phase``, ``progress``, ``processed``/``total``) and which attempt this is
        (``attempt``: each claim is one)."""
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                return None
            ahead = None
            if row.status == "pending" and row.current_phase == QUEUED:
                slot = INSPECT_TYPES if row.job_type in INSPECT_TYPES else JOB_TYPES
                ahead = (await s.execute(select(func.count()).select_from(JobORM).where(
                    JobORM.job_type.in_(slot), JobORM.status == "pending",
                    JobORM.current_phase == QUEUED, JobORM.created_at < row.created_at))).scalar_one()
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
                # Queued for the versioning worker: how many jobs it waits behind (else None).
                "queuedAhead": ahead,
                "phase": row.current_phase, "progress": row.progress,
                "processed": row.processed, "total": row.total, "attempt": row.retry_count,
                # Running, but its worker has not beaten in a takeover's time: it is about to be
                # resumed elsewhere (or no worker is running).
                "stale": row.status == "running" and _silent_secs(row) > config.INGEST_STALE_SECS,
                # The download's name: the export's own, or a view package's (view_transfer.package).
                "fileName": (row.field_scope.get("fileName")
                             or (row.field_scope.get("package") or {}).get("fileName"))
                if isinstance(row.field_scope, dict) else None,
                # A view package's export: what it packages (its views, at the versions sealed for it).
                "package": {k: v for k, v in row.field_scope["package"].items() if k != "actor"}
                if isinstance(row.field_scope, dict) and row.field_scope.get("package") else None,
            }
