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

from .. import config, db, provenance
from ..errors import JobActive, MainWriteForbidden
from ..job_lease import Draining, Lease, Superseded, friendly_infra_error, is_transient
from ..models import BranchORM, GraphORM, ImportRowORM, JobORM, MergeRequestORM
from ..service import AccessDenied, GraphVersioningService, NotUpToDate, Viewer
from . import contract, stream
from . import identifier as identifiers
from . import keys as matching
from .export_worker import ExportWorker, example_template_records
from .formats import get_adapter
from .import_worker import (IdentifierMatchedNothing, ImportWorker, ReplaceBlocked, _normalize_page,
                            _record_pages, lease_job)
from .resolve import _ALREADY_GONE, _STATUS
from .rowmodel import column_order
from .runner import INSPECT_TYPES, JOB_TYPES, QUEUED, JobReaper
from .snapshot import open_snapshot
from .uploads import PACKAGE_PREFIX

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _silent_secs(row: JobORM) -> float:
    """Seconds since the job last showed life: its heartbeat, else its start, else its creation."""
    last = datetime.fromisoformat(row.updated_at or row.started_at or row.created_at)
    return (datetime.now(timezone.utc) - last).total_seconds()


def _never_arrived(row) -> bool:
    """An import whose file never arrived: failed with no phase as JOB_NEVER_QUEUED — its request
    broke off before storing it, or the reaper failed it once that request had gone."""
    return (row is not None and row.job_type == "ingest" and row.status == "failed"
            and row.current_phase is None and row.error_message == config.JOB_NEVER_QUEUED)


def _refusal(exc: Exception) -> Dict[str, Any]:
    """Why an import's draft wasn't published (``summary.publish.reason``), shaped as the publish
    route would have answered: a mapped refusal's own detail; a draft behind main, by how far."""
    if isinstance(exc, NotUpToDate):
        return {"type": "not_up_to_date", "behindBy": exc.behind_by,
                "message": "Main changed while the file was imported, so the draft is behind it. "
                           "Update the draft from main and publish it, or import the file again."}
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict) and detail.get("type"):
        return detail
    return {"type": "refused", "message": str(exc)[:500]}


#: How many changed rows a dry run lists (its summary counts them all).
_VALIDATE_SAMPLE = 200

#: How many times an import that publishes itself pulls main into its draft when main moved under
#: it (``_publish_own_draft``), before it waits for someone to publish it.
_AUTO_PULLS = 3


def _conflicts(pulled: Dict[str, Any]) -> Dict[str, Any]:
    """Why an import's draft waits after pulling main: fields both changed differently."""
    n = len(pulled.get("conflicts") or [])
    return {"type": "conflicts", "conflicts": n,
            "message": f"Main changed while the file was imported, and {n} of the draft's entities "
                       "changed there too, in the same fields: the draft waits for someone to "
                       "resolve them and publish it."}


def _behind_main(result: Dict[str, Any]) -> bool:
    """A publish job's answer: refused because its draft is behind main."""
    detail = (result.get("error") or {}).get("detail")
    return isinstance(detail, dict) and detail.get("type") == "not_up_to_date"


class DryRunTooLarge(ValueError):
    """A file larger than a dry run checks: import it into a draft instead."""


class IdentityUnavailable(RuntimeError):
    """The data source's node identity can't be read, so a dry run can't match as an import would."""


def _label(row: Dict[str, Any]) -> Optional[str]:
    """How a row is named in a dry run's list, as the import preview names it."""
    return row.get("displayName") or row.get("qualifiedName") or row.get("urn") or row.get("edgeType")


class ImportExportService:
    def __init__(
        self,
        versioning: Optional[GraphVersioningService] = None,
        store=None,
        scope_resolver=None,
        ontology_resolver=None,
        layout_writer=None,
        publish_hook=None,
        replace_scope_resolver=None,
        identity_resolver=None,
        fork_hook=None,
    ) -> None:
        self._svc = versioning or GraphVersioningService()
        self._store = store or get_object_store()
        # Optional async ``(workspace_id, data_source_id, view_id, branch_id) -> scope dict | None``
        # — resolves a view's scope for view-scoped export. Injected at the API layer
        # (management-DB access), so the worker stays decoupled.
        self._scope_resolver = scope_resolver
        # The same for a view-scoped replace, which deletes within that scope; it raises when it
        # cannot read the view. Fail-closed: without a scope, the replace is refused.
        self._replace_scope_resolver = replace_scope_resolver
        # Optional async ``(workspace_id, data_source_id) -> {node_types, edge_types} | None`` — the
        # live ontology types for the per-row import gate. Injected the same way.
        self._ontology_resolver = ontology_resolver
        # Optional async ``(workspace_id, data_source_id) -> ResolvedNodeIdentity | None`` — the
        # data source's node-identity mapping, so imported nodes get their own name and identity
        # properties (``node_identity.bind_node_write``). Injected the same way.
        self._identity_resolver = identity_resolver
        # Optional async ``(workspace_id, data_source_id, view_id, branch_id, created_node_facts,
        # batch_edge_facts) -> {added: N}`` — writes canonical layer assignments for a view-scoped
        # import's newly-created top-level entities. Injected at the API layer (management-DB access).
        self._layout_writer = layout_writer
        # Optional async ``(job) -> {"commitId": id} | {"error": {"status", "detail"}}`` — publishes
        # a draft or merges its review, with what a publish sets off after it lands. Injected at the
        # API layer, which resolves the ontology and owns those side effects; a refusal comes back
        # as the HTTP answer the route gives when it publishes inside the request.
        self._publish_hook = publish_hook
        # The same for a fork's jobs (``fork_update``, ``fork_merge``): ``(job) -> its answer |
        # {"error": …}``.
        self._fork_hook = fork_hook

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
        originating_view_id: Optional[str] = None,
        draft_visibility: Optional[str] = None,
        identifier: Optional[str] = None,
        allow_mass_delete: bool = False,
        import_settings: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """Open/append the working draft and create the import job.

        Returns ``{job_id, branch_id, source_uri}``. When ``source_uri`` is omitted it is minted
        from the traceable ``{ws}/{ds}/{graph}/{job}/source.<fmt>`` layout (the caller then streams
        the upload to it). ``branch_id`` supplied -> stack onto that existing draft (multiple
        imports per branch, like successive manual edits); omitted -> open a fresh import draft
        (for ``originating_view_id``, at ``draft_visibility``: the caller passes its data source's
        policy, private when it passes none), in the job's transaction once the graph is known to be in
        ``workspace_id``: an import refused or rolled back leaves no empty draft behind.
        A supplied branch must be an open draft of this graph: main is :class:`MainWriteForbidden`,
        a closed draft :class:`BranchNotOpen`, someone else's private draft :class:`NotDraftOwner`,
        any other branch ``ValueError``.

        An ``idempotency_key`` already taken on the graph (by any job, finished or not:
        ``ix_jobs_idem_active``) raises ``IntegrityError``; the draft this call would have opened
        goes with the refused insert, and the caller answers with that key's job (:meth:`find_job`).

        One import at a time per draft: while one is pending or running it is :class:`JobActive`.
        It is checked under the draft's lock, so the rule holds where a worker start has not built
        ``uq_jobs_ingest_active`` yet, and the index settles it too. A job nothing will run does not
        count — the transfer lane's reaper rules are applied to it first — but a running one whose
        worker went quiet does: it is taken over and resumed.
        """
        if branch_id == "main":
            raise MainWriteForbidden()
        # What its rows find their entities by: the caller's (the request's, else its data
        # source's: ``services.import_settings``, kept as ``import_settings``), else the platform's.
        identifier = identifier or identifiers.platform_default()

        async def insert() -> Dict[str, str]:
            uri, draft_id = source_uri, branch_id
            async with db.graphver_session() as s:
                await self._svc._lock_lifecycle(s, graph_id, shared=True)
                await self._lock_in_workspace(s, graph_id, workspace_id)
                await self._svc._assert_writable(s, graph_id)
                if draft_id is None:
                    draft_id = await self._svc._add_draft(
                        s, graph_id=graph_id, owner=actor, name=name or "Import",
                        originating_view_id=originating_view_id,
                        visibility=draft_visibility or "private")
                branch = await self._svc._lock_branch(s, graph_id, draft_id)
                if branch.kind == "main":
                    raise MainWriteForbidden()
                self._svc._require_open(branch)
                await self._svc._require_edit(s, branch, actor, ())
                active = await self._import_on(s, draft_id, idempotency_key)
                if active is not None:
                    raise JobActive(active)
                job = JobORM(
                    job_type="ingest", graph_id=graph_id, workspace_id=workspace_id,
                    data_source_id=data_source_id, provider_id=provider_id,
                    scope_view_id=scope_view_id, branch_id=draft_id,
                    reconcile_mode=reconcile_mode, import_format=import_format,
                    field_scope=field_scope, auto_publish=auto_publish,
                    source_uri=uri, idempotency_key=idempotency_key, status="pending",
                    provenance=provenance.snapshot(), identity_strategy=identifier,
                    allow_mass_delete=bool(allow_mass_delete) or None,
                    import_settings=import_settings,
                )
                s.add(job)
                await s.flush()
                job_id = job.id
                if uri is None:
                    uri = storage_key(
                        workspace_id, data_source_id, graph_id, job_id, f"source.{import_format}")
                    job.source_uri = uri
            return {"job_id": job_id, "branch_id": draft_id, "source_uri": uri}

        for attempt in (1, 2):
            try:
                return await insert()
            except JobActive as busy:
                active = busy.job_id
            except IntegrityError:
                # A repeated idempotency key: the caller answers with that key's job (find_job).
                if idempotency_key and await self.find_job(graph_id=graph_id, idempotency_key=idempotency_key):
                    raise
                active = await self._active_import(branch_id) if branch_id else None
                if active is None:          # the import it met has finished since: the draft is free
                    if attempt == 2:
                        raise
                    continue
            if attempt == 2 or not any((await JobReaper().run_once(job_id=active)).values()):
                raise JobActive(active, f"Another import is still running on this draft (job "
                                        f"{active}). Wait for it to finish, then import again.") from None

    async def _lock_in_workspace(self, s, graph_id: str, workspace_id: str) -> None:
        """Take the graph's move lock shared (:meth:`GraphVersioningService._lock_move`), which a
        move of its data source holds but no main write does, and refuse a graph that has moved
        out of ``workspace_id`` (``ValueError``, the 404 of a graph in no workspace of the
        caller's): a job is never stamped with the workspace its graph has left."""
        await self._svc._lock_move(s, graph_id, shared=True)
        if await s.scalar(select(GraphORM.id).where(
                GraphORM.id == graph_id, GraphORM.workspace_id != workspace_id)) is not None:
            raise ValueError(f"unknown graph {graph_id}")

    @staticmethod
    async def _import_on(s, branch_id: str, idempotency_key: Optional[str]) -> Optional[str]:
        """The import pending or running on draft ``branch_id``, read in ``s`` under the draft's
        lock — but not one created for ``idempotency_key``: that is this request sent twice at
        once, which its key's index answers."""
        look = select(JobORM.id).where(JobORM.branch_id == branch_id, JobORM.job_type == "ingest",
                                       JobORM.status.in_(("pending", "running")))
        if idempotency_key:
            look = look.where(JobORM.idempotency_key.is_distinct_from(idempotency_key))
        return await s.scalar(look.limit(1))

    async def _active_import(self, branch_id: str) -> Optional[str]:
        """The import pending or running on draft ``branch_id``, if any."""
        async with db.graphver_session() as s:
            return (await s.execute(select(JobORM.id).where(
                JobORM.branch_id == branch_id, JobORM.job_type == "ingest",
                JobORM.status.in_(("pending", "running"))).limit(1))).scalar_one_or_none()

    async def abandon_unqueued(self, job_id: str) -> None:
        """Fail a job created but never queued — its request broke off before its input was
        stored — so its draft takes the next import now, not once the reaper finds it. A queued
        job is left alone."""
        async with db.graphver_session() as s:
            now = _now()
            await s.execute(update(JobORM).where(
                JobORM.id == job_id, JobORM.status == "pending", JobORM.current_phase.is_(None))
                .values(status="failed", error_message=config.JOB_NEVER_QUEUED,
                        completed_at=now, updated_at=now))

    async def reclaim_import(self, job_id: str, *, actor: str, workspace_id: str) -> bool:
        """Take back an import whose file never arrived, for its idempotency key sent again: pending
        once more with no phase, so only the request that took it back stores its file and queues
        it, and the reaper's hour starts again. Held to what creating it is held to
        (:meth:`create_import_job`): the graph still in ``workspace_id`` and writable, the draft
        open and still the caller's to edit, and no other import pending or running on it
        (:class:`JobActive`). False when another request took it back first."""
        async with db.graphver_session() as s:
            peek = await s.get(JobORM, job_id)
            if not _never_arrived(peek):
                return False
            await self._svc._lock_lifecycle(s, peek.graph_id, shared=True)
            await self._lock_in_workspace(s, peek.graph_id, workspace_id)
            await self._svc._assert_writable(s, peek.graph_id)
            branch = await self._svc._lock_branch(s, peek.graph_id, peek.branch_id)
            # the draft's lock before the job row's, as requeue_failed takes them
            row = await s.get(JobORM, job_id, with_for_update=True, populate_existing=True)
            if not _never_arrived(row):
                return False
            self._svc._require_open(branch)
            await self._svc._require_edit(s, branch, actor, ())
            active = await self._import_on(s, branch.id, None)
            if active is not None:
                raise JobActive(active, f"Another import is running on this draft (job {active}). "
                                        "Send this one again once it has finished.")
            now = _now()
            row.status, row.error_message, row.completed_at = "pending", None, None
            row.created_at = row.updated_at = now   # never_runs() counts a phase-less job's hour from created_at
        return True

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
        except (ReplaceBlocked, IdentifierMatchedNothing, matching.MatchingPropertyLimit,
                matching.NotOnAFork) as exc:
            # Refused by the replace's own checks: nothing deleted, the rows on the draft. The
            # failure says why (``summary.failure.code``) and what to do (``action``).
            logger.warning("import job %s stopped: %s", job_id, exc)
            await lease.fail(str(exc), exc.code, exc.action)
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
                       "reasons": r.reasons or [], "code": r.code} for r in rows]
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
            ws, ds, view_id, mode, branch_id, graph_id, auto_publish = (
                (row.workspace_id, row.data_source_id, row.scope_view_id, row.reconcile_mode,
                 row.branch_id, row.graph_id, row.auto_publish) if row else (None,) * 7)
        scope = None
        if mode == "replace" and view_id:
            if self._replace_scope_resolver is not None:
                scope = await self._replace_scope_resolver(ws, ds, view_id, branch_id)
            if not scope:
                raise ValueError("This view has nothing placed in it, so an import that replaces "
                                 "the view's contents has nothing it may delete. Nothing was imported.")
        ontology = None
        if self._ontology_resolver is not None:
            ontology = await self._ontology_resolver(ws, ds)
        node_identity = None
        if self._identity_resolver is not None:
            # Read, never guessed: a fault is waited out, then fails the job, resumably.
            node_identity = await (lease.retry_transient(lambda: self._identity_resolver(ws, ds))
                                   if lease is not None else self._identity_resolver(ws, ds))
        worker = ImportWorker(self._svc, self._store, scope=scope, ontology=ontology,
                              facts=bool(view_id and self._layout_writer is not None),
                              node_identity=node_identity)
        # Called directly (tools, tests faking ImportWorker) there is no lease to pass on: the
        # worker takes the job itself.
        summary = await (worker.run(job_id, lease=lease) if lease is not None
                         else worker.run(job_id))
        # Post-commit: a view-scoped import that created new top-level entities writes canonical layer
        # assignments so the curated view shows them right away. Best-effort — never fails the import.
        if view_id and self._layout_writer is not None and worker.created_node_facts:
            await self._apply_view_layout(job_id, ws, ds, view_id, branch_id, worker)
        if auto_publish:          # after the layout, so the placements are published with the data
            await asyncio.shield(self._auto_publish(job_id, ws, ds, graph_id, branch_id, summary))
        return summary

    async def _auto_publish(self, job_id, ws, ds, graph_id, branch_id, summary) -> None:
        """Publish the draft a completed import opened, as it asked (``autoPublish``), and record
        how that went on its summary (``publish``), as :meth:`_apply_view_layout` records the
        layout:

        * ``queued``, with ``jobId``: the draft's publish job, which runs as a large publish does —
          the review policy read again, the import's owner held to publish again;
        * ``unchanged``: the import changed nothing, so its draft, empty, is closed;
        * ``skipped``, with ``reason``: rows weren't imported, or the draft can't be published
          (it fell behind main while the file was imported, …). The draft waits for review.

        Never raised: the import is complete whatever happens here."""
        refused = int(summary.get("invalid") or 0) + int(summary.get("skipped") or 0)
        try:
            if refused:
                note = {"state": "skipped", "reason": {
                    "type": "rows_refused", "rows": refused,
                    "message": f"{refused} row(s) of the file weren't imported, so the draft "
                               "waits for someone to review it."}}
            else:
                async with db.graphver_session() as s:
                    owner = (await s.get(BranchORM, branch_id)).owner
                if not any(summary.get(k) for k in ("new", "updated", "deleted")):
                    await self._svc.abandon_draft(graph_id=graph_id, branch_id=branch_id, actor=owner)
                    note = {"state": "unchanged"}
                else:
                    note = await self._publish_own_draft(job_id, ws, ds, graph_id, branch_id, owner)
        except Exception as exc:  # noqa: BLE001 — a refusal, or an outage: the draft is kept
            logger.warning("import job %s did not publish itself: %s", job_id, exc)
            note = {"state": "skipped", "reason": _refusal(exc)}
        await self._note_publish(job_id, note)

    async def _note_publish(self, import_job_id: str, note: Dict[str, Any]) -> None:
        """Record on the import job how its publish went (``summary.publish``). Never raised."""
        try:
            async with db.graphver_session() as s:
                row = await s.get(JobORM, import_job_id)
                if row is not None:
                    row.summary = {**(row.summary or {}), "publish": note}
                    row.updated_at = _now()
        except Exception:  # pragma: no cover - defensive; must never fail the completed import
            logger.exception("recording the publish of import job %s failed", import_job_id)

    async def _publish_own_draft(self, import_job_id, ws, ds, graph_id, branch_id, owner) -> Dict[str, Any]:
        """Queue the publish of the draft an import opened (``autoPublish``). Main may have moved
        while the file was imported, so the draft can't land past what came in (a person
        published, or another import changed what this one changes): then the draft pulls main
        first, with the field-level merge a person's "Pull latest" runs, as a merge queue rebases,
        and is queued once it pulls clean — up to ``_AUTO_PULLS`` pulls, counted on with the job's
        own (:meth:`_pull_and_publish`). Two imports that made the same entity alike pull clean; a
        field both changed differently is a conflict, and the draft waits for someone to resolve
        it. A draft of any size pulls: past ``SQUASH_PAGED_ABOVE`` changes, reading only what main
        changed too."""
        pulls = 0
        while True:
            try:
                job = await self.create_publish_job(
                    workspace_id=ws, data_source_id=ds, graph_id=graph_id, branch_id=branch_id,
                    actor=owner, message=f"Import {import_job_id}", auto_publish=True,
                    import_job_id=import_job_id, pulls=pulls)
                return {"state": "queued", "jobId": job["job_id"], **({"pulls": pulls} if pulls else {})}
            except NotUpToDate:
                if pulls >= _AUTO_PULLS:
                    raise
            pulled = await self._svc.rebase_draft(
                graph_id=graph_id, branch_id=branch_id, actor=owner,
                message="pull latest from main to publish the import")
            pulls += 1
            if not pulled.get("clean"):
                return {"state": "skipped", "pulls": pulls, "reason": _conflicts(pulled)}

    async def _apply_view_layout(self, job_id, ws, ds, view_id, branch_id, worker) -> None:
        """Hand the import's newly-created top-level entities to the injected layout writer and record
        the outcome on ``job.summary`` (``viewAssignments: {added: N}`` or ``{error: ...}``). The
        import is already committed and marked ``completed`` by the worker before this runs, so any
        failure here is isolated: it is logged + noted, never raised (which would flip the job to
        ``failed`` via ``run_import_safe``)."""
        try:
            try:
                result = await self._layout_writer(
                    ws, ds, view_id, branch_id, worker.created_node_facts, worker.batch_edge_facts)
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
        # Who started it: theirs to cancel (cancel_export).
        options: Dict[str, Any] = {"actor": actor}
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
            await self._lock_in_workspace(s, graph_id, workspace_id)
            job = JobORM(
                job_type="export", graph_id=graph_id, workspace_id=workspace_id,
                data_source_id=data_source_id, provider_id=provider_id,
                scope_view_id=scope_view_id, branch_id=branch_id,
                import_format=export_format, as_of_seq=as_of_seq,
                field_scope=options, idempotency_key=idempotency_key, status="pending",
                provenance=provenance.snapshot(),
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
        merge_request_id: Optional[str] = None, auto_publish: bool = False,
        import_job_id: Optional[str] = None, pulls: int = 0,
    ) -> Dict[str, str]:
        """A publish of a draft too large to publish inside a request — or the merge of its review
        (``merge_request_id``), queued like an export. The request rides in ``field_scope``.

        The draft is taken in the same transaction: under its row lock it must be open (main is
        :class:`MainWriteForbidden`, a closed draft :class:`BranchNotOpen`), and it becomes
        ``publishing``, closed to every write but the job's publish until the job ends. A publish of
        someone else's private draft is :class:`NotDraftOwner`, of a shared draft by anyone but its owner
        or a maintainer :class:`DraftRoleRequired`. A merge its reviewers have not approved is
        :class:`ApprovalRequired` here, before the draft is closed for it, and a draft behind ``main``
        :class:`NotUpToDate`, as a publish inside the request is; the job checks both again. The job
        is stored already queued: it has no input to wait for. ``auto_publish``: an import
        (``import_job_id``) publishes its draft (:meth:`_auto_publish`), and the job holds its actor
        to publish again; ``pulls``, how often its draft pulled main to get here."""
        fields: Dict[str, Any] = {"actor": actor, "message": message}
        if resolutions:
            fields["resolutions"] = resolutions
        if merge_request_id:
            fields["mergeRequestId"] = merge_request_id
        if auto_publish:
            fields["autoPublish"] = True
            if import_job_id:
                fields.update(importJobId=import_job_id, pulls=pulls)
        async with db.graphver_session() as s:
            await self._svc._lock_lifecycle(s, graph_id, shared=True)
            await self._lock_in_workspace(s, graph_id, workspace_id)
            await self._svc._assert_writable(s, graph_id)
            branch = await self._svc._lock_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._svc._require_open(branch)
            if not merge_request_id:                     # a review's merger need not own the draft
                await self._svc._require_publish(s, branch, actor, ())
            await self._svc._require_no_import(s, branch_id)
            head = await s.scalar(select(GraphORM.main_head_commit_seq).where(GraphORM.id == graph_id))
            if (branch.base_commit_seq or 0) < head:     # behind main: may it land past what came in?
                await self._svc._require_landable(
                    s, graph_id, await self._svc._main_branch_id(s, graph_id), branch, head)
            if merge_request_id:
                pr = await s.get(MergeRequestORM, merge_request_id)
                if pr is None or pr.status in ("merged", "closed"):
                    raise ValueError(f"merge request {merge_request_id} is not open")
                await self._svc._require_approvals(s, pr)
            branch.status = "publishing"
            job = JobORM(job_type="publish", graph_id=graph_id, workspace_id=workspace_id,
                         data_source_id=data_source_id, branch_id=branch_id,
                         field_scope=fields, status="pending", current_phase=QUEUED, updated_at=_now(),
                         provenance=provenance.snapshot())
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
        A refusal hands the draft back (``publishing`` → ``open``) once the job has failed. An
        import's own publish that finds main moved pulls and publishes again first
        (:meth:`_pull_and_publish`).

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
        if job.get("importJobId") and _behind_main(result):
            result = await self._pull_and_publish(job_id, job, lease, result)
        values: Dict[str, Any] = {"summary": result}
        if "error" in result:
            detail = result["error"].get("detail")
            values.update(status="failed", error_message=str(
                detail.get("message") or detail.get("type") if isinstance(detail, dict) else detail)[:2000])
        if not await lease.finish(**values):
            raise Superseded(f"publish job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        if "error" in result:
            await self._svc.release_publishing(graph_id=job["graphId"], branch_id=job["branchId"])
        return result

    async def _pull_and_publish(self, job_id: str, job: Dict[str, Any], lease: Lease,
                                result: Dict[str, Any]) -> Dict[str, Any]:
        """An import's own publish (``job``) refused because main moved past its draft while it
        waited its turn (``result``): the job pulls main into the draft it holds, with the merge of
        "Pull latest", and publishes it again, up to ``_AUTO_PULLS`` pulls counted on from the
        import's (``pulls``). So the job a client follows ends published, or refused saying why: a
        field both changed differently (``conflicts``), which waits on the draft for someone to
        resolve it, or main moving on every time (``not_up_to_date``). The import's
        ``summary.publish`` follows along."""
        pulls = int(job.get("pulls") or 0)
        while _behind_main(result) and pulls < _AUTO_PULLS:
            lease.check()
            pulled = await self._svc.rebase_draft(
                graph_id=job["graphId"], branch_id=job["branchId"], actor=job["actor"],
                message="pull latest from main to publish the import", publishing_ok=True)
            pulls += 1
            if not pulled.get("clean"):
                result = {"error": {"status": 409, "detail": _conflicts(pulled)}}
                break
            await self._note_publish(job["importJobId"], {"state": "queued", "jobId": job_id, "pulls": pulls})
            result = await self._publish_hook(job)
        if "error" in result:
            await self._note_publish(job["importJobId"], {
                "state": "skipped", "jobId": job_id, "pulls": pulls, "reason": result["error"].get("detail")})
        return result

    async def run_publish_safe(self, job_id: str, lease: Lease) -> None:
        await self._run_safe(job_id, lease, self.run_publish)

    async def create_fork_update_job(
        self, *, workspace_id: str, data_source_id: Optional[str], graph_id: str, actor: str,
        parent_seq: int, resolutions: Optional[Dict[str, Any]] = None,
        parent_label: Optional[str] = None,
    ) -> Dict[str, str]:
        """An Update from parent too large to run inside a request (``graph_id``: the fork), queued
        like a publish, already queued: the parent's head it updates to is pinned (``parent_seq``),
        and the request rides in ``field_scope``. Fenced as a publish job is: the fork's lifecycle
        and move locks shared, the fork writable and still in ``workspace_id``, and one update of
        it pending or running at a time (:class:`JobActive`), told under a lock its creations
        take in turn."""
        fields: Dict[str, Any] = {"actor": actor, "parentSeq": parent_seq}
        if resolutions:
            fields["resolutions"] = resolutions
        if parent_label:
            fields["parentLabel"] = parent_label
        async with db.graphver_session() as s:
            await self._svc._lock_lifecycle(s, graph_id, shared=True)
            await self._lock_in_workspace(s, graph_id, workspace_id)
            await self._svc._assert_writable(s, graph_id)
            await self._svc._bounded_lock(s, select(func.pg_advisory_xact_lock(
                func.hashtext(f"gvforkupdate:{graph_id}"))), f"graph {graph_id}")
            active = await s.scalar(select(JobORM.id).where(
                JobORM.graph_id == graph_id, JobORM.job_type == "fork_update",
                JobORM.status.in_(("pending", "running"))).limit(1))
            if active is not None:
                raise JobActive(active, f"An update from the parent is already running on this fork "
                                        f"(job {active}).")
            job = JobORM(job_type="fork_update", graph_id=graph_id, workspace_id=workspace_id,
                         data_source_id=data_source_id, field_scope=fields, status="pending",
                         current_phase=QUEUED, updated_at=_now(), provenance=provenance.snapshot())
            s.add(job)
            await s.flush()
            return {"job_id": job.id}

    async def create_fork_merge_job(
        self, *, workspace_id: str, pr_id: str, actor: str, message: str,
    ) -> Dict[str, str]:
        """The merge of a fork's review too large to merge inside a request, queued like a publish:
        the job is the parent's (``graph_id``), and the review, the fork and its head now (pinned:
        what it merges) ride in ``field_scope``. Fenced as a publish job is — the parent's lifecycle
        and move locks shared, the parent writable and still in ``workspace_id`` — and taken under
        the review's row lock: open, approved (:class:`ApprovalRequired`) and up to date with the
        parent (:class:`ForkNotUpToDate`), it becomes ``merging``, which no other merge gets past
        (:class:`JobActive`) until the job ends. Returns ``{job_id, graph_id}``."""
        async with db.graphver_session() as s:
            peek = await s.get(MergeRequestORM, pr_id)
            if peek is None:
                raise ValueError(f"unknown pull request {pr_id}")
            parent_id = peek.target_graph_id
            await self._svc._lock_lifecycle(s, parent_id, shared=True)
            await self._lock_in_workspace(s, parent_id, workspace_id)
            await self._svc._assert_writable(s, parent_id)
            pr = await self._svc._lock_pr(s, pr_id)
            if pr is None or pr.status in ("merged", "closed"):
                raise ValueError(f"pull request {pr_id} is not open")
            if pr.status == "merging":
                raise JobActive(await self._svc._merging_job(s, pr_id),
                                "This review is already being merged by a job.")
            fork = await s.get(GraphORM, pr.graph_id)
            parent = await s.get(GraphORM, parent_id)
            if fork is None or fork.deleted_at is not None or parent is None:
                raise ValueError("pr endpoints missing")
            await self._svc._require_approvals(s, pr)
            pinned = fork.main_head_commit_seq
            await self._svc._assert_up_to_date(s, fork, pinned, parent)
            pr.status, pr.updated_at = "merging", _now()
            job = JobORM(job_type="fork_merge", graph_id=parent_id, workspace_id=workspace_id,
                         data_source_id=parent.data_source_id,
                         field_scope={"actor": actor, "message": message, "prId": pr_id,
                                      "forkId": fork.id, "pinnedSeq": pinned},
                         status="pending", current_phase=QUEUED, updated_at=_now(),
                         provenance=provenance.snapshot())
            s.add(job)
            await s.flush()
            return {"job_id": job.id, "graph_id": parent_id}

    async def start_fork_job(self, job_id: str) -> str:
        """Queue a fork's job (see :meth:`_start`). Returns the status to report."""
        return await self._start(job_id)

    async def run_fork_job(self, job_id: str, lease: Optional[Lease] = None) -> Dict[str, Any]:
        """Run a fork's job through the injected hook, on ``lease`` (the transfer lane's; taken here
        when called without one), as :meth:`run_publish` runs a publish: the hook's answer is the
        job's summary, and a refusal — an update's conflicts, a merge no longer up to date — fails
        the job with it, through the fenced finish; a refused merge hands its review back
        (``merging`` → open) once the job has failed. Safe to run again: an update already landed
        answers up to date, and a review already merged answers with its merge — so too a merge
        refused because the review merged under it, by a superseded attempt."""
        lease = lease or await lease_job(job_id)
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            job = {**(row.field_scope or {}), "jobType": row.job_type, "graphId": row.graph_id,
                   "workspaceId": row.workspace_id, "dataSourceId": row.data_source_id}
        result = await self._fork_hook(job)
        if "error" in result and job["jobType"] == "fork_merge":
            # Refused because the review merged under it — a superseded attempt's merge landed
            # first: the hook answers with that merge.
            pr = await self._svc.get_pr(job["prId"])
            if pr is not None and pr["status"] == "merged":
                result = await self._fork_hook(job)
        values: Dict[str, Any] = {"summary": result}
        if "error" in result:
            detail = result["error"].get("detail")
            values.update(status="failed", error_message=str(
                detail.get("message") or detail.get("type") if isinstance(detail, dict) else detail)[:2000])
        if not await lease.finish(**values):
            raise Superseded(f"{job['jobType']} job {job_id} (epoch {lease.epoch}) was taken over "
                             "before it could finish")
        if "error" in result and job["jobType"] == "fork_merge":
            await self._svc.release_merging(pr_id=job["prId"])
        return result

    async def run_fork_job_safe(self, job_id: str, lease: Lease) -> None:
        await self._run_safe(job_id, lease, self.run_fork_job)

    async def requeue_failed(self, job_id: str) -> bool:
        """Queue a FAILED job again — a person asked to retry it — to resume from its cursor.

        Only a failed job: a pending or running one belongs to the queue or to the worker running
        it, and queuing it again would give two workers one epoch. Its takeover count starts over
        (a person decided to run it again) and its failure is cleared; the next claim bumps the
        epoch. A job with no cursor starts over: rows staged by a worker from before leases (with
        no cursor to resume them by) are dropped, or the claim would fail it again on sight.
        True when the job was queued. An import whose draft has another import pending or
        running is :class:`JobActive`: one at a time per draft, checked under the draft's lock as
        :meth:`create_import_job` checks it, so it holds without ``uq_jobs_ingest_active``."""
        draft = None
        try:
            async with db.graphver_session() as s:
                peek = await s.get(JobORM, job_id)
                if peek is None or peek.status != "failed":
                    return False
                draft = peek.branch_id if peek.job_type == "ingest" else None
                if draft:                       # the draft's lock before the job row's
                    await self._svc._lock_branch(s, peek.graph_id, draft)
                row = await s.get(JobORM, job_id, with_for_update=True, populate_existing=True)
                if row is None or row.status != "failed":
                    return False
                if draft:
                    active = await self._import_on(s, draft, None)   # this one is failed
                    if active is not None:
                        raise JobActive(active, f"Another import is running on this draft (job "
                                                f"{active}). Retry this one once it has finished.")
                if row.last_cursor is None:
                    await s.execute(delete(ImportRowORM).where(ImportRowORM.job_id == job_id))
                summary = row.summary if isinstance(row.summary, dict) else {}
                row.summary = {k: v for k, v in summary.items() if k not in ("takeovers", "failure")} or None
                row.status, row.current_phase = "pending", QUEUED
                row.error_message = row.completed_at = None
                row.updated_at = _now()
        except IntegrityError:
            active = draft and await self._active_import(draft)
            if not active:
                raise
            raise JobActive(active, f"Another import is running on this draft (job {active}). "
                                    "Retry this one once it has finished.") from None
        return True

    async def cancel_export(self, job_id: str, *, viewer: Viewer) -> bool:
        """Cancel export ``job_id`` unless it has ended — one started by mistake, or no longer
        wanted. Its creator's to cancel, or a manager's (:class:`AccessDenied` for anyone else).

        A queued export is never claimed. A running one's worker finds its row no longer running
        at its next fenced write — a progress checkpoint, every few seconds — and stops, and the
        store removes the part of the file it wrote. True when this call cancelled it; False when
        it had already ended (completed, failed or cancelled), which leaves it as it was."""
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id, with_for_update=True)
            if row is None or row.job_type != "export":
                raise ValueError("export not found")
            creator = row.field_scope.get("actor") if isinstance(row.field_scope, dict) else None
            if creator != viewer.actor and not viewer.can_manage:
                raise AccessDenied("Only the person who started this export, or a manager, can cancel it.")
            if row.status not in ("pending", "running"):
                return False
            summary = row.summary if isinstance(row.summary, dict) else {}
            row.summary = {**summary, "cancelledBy": viewer.actor}
            row.status = "cancelled"
            row.completed_at = row.updated_at = _now()
        return True

    async def contract_context(self, workspace_id: str,
                               data_source_id: Optional[str]) -> Tuple[Optional[dict], Optional[str]]:
        """What the import contract says of this data source: its ontology as an import reads it
        (types, fields, the types each relationship joins, team keys), and the property it
        identifies nodes by — ``(None, None)`` where either can't be read."""
        from backend.app.services.node_identity import identity_property
        ontology = (await self._ontology_resolver(workspace_id, data_source_id)
                    if self._ontology_resolver is not None else None)
        try:                        # a template or schema without it says less, and matches nothing
            identity = (await self._identity_resolver(workspace_id, data_source_id)
                        if self._identity_resolver is not None else None)
        except Exception:
            identity = None
        return ontology, identity_property(identity) if identity is not None else None

    async def build_template(self, *, export_format: str = "csv",
                             ontology: Optional[Dict[str, Any]] = None,
                             identity_property: Optional[str] = None) -> bytes:
        """The import template a person fills in, or a connector copies: the record format's
        columns (:mod:`.contract`) — every property the data source's types define, its identifier
        property, the fields an edge's ends are found by — with a worked row of each entity type
        and an edge of each relationship type joining them, each pointing at its nodes by an
        example urn. A workbook adds a Columns sheet saying what every column means; CSV and TSV
        start with a BOM, so a spreadsheet reads them as UTF-8. Without an ontology, worked
        example rows. Nothing of the graph is read: a template never carries a real entity, which
        importing it as it is would change. Built in memory, returned inline."""
        records = contract.template_records(ontology) or example_template_records()
        extra = contract.template_columns(ontology, identity_property)
        columns = column_order(records, schema_props={
            "node": [c[len("prop."):] for c in extra["node"]]})
        if any(r.get("kind") == "edge" for r in records):
            columns = columns[:-1] + extra["edge"] + columns[-1:]          # ahead of _op
        adapter = get_adapter(export_format)

        async def _iter():
            for rec in records:
                yield rec

        options = ({"guide": contract.columns_guide(columns, ontology, identity_property)}
                   if export_format == "xlsx" else {})
        chunks: List[bytes] = [stream._BOM] if export_format in ("csv", "tsv") else []
        async for b in adapter.write(_iter(), columns=columns, **options):
            chunks.append(b)
        return b"".join(chunks)

    async def validate_import(self, *, graph_id: str, workspace_id: str,
                              data_source_id: Optional[str], branch_id: Optional[str],
                              data: bytes, import_format: str,
                              identifier: Optional[str] = None) -> Dict[str, Any]:
        """A dry run of importing ``data``: parsed, normalized and resolved against ``main`` (or
        the draft ``branch_id``) as an import resolves a window — the same matching, the same new
        ids, the same reasons a row is refused — and nothing written: no draft opened, no job
        made. One window at most (``IMPORT_COMMIT_WINDOW`` rows; ``ValueError`` past it): a larger
        file is imported into a draft, which is itself a dry run until published. Not run here:
        the write gate a strict graph applies at commit, and the deletions a ``replace`` would
        make — the import's preview shows those. ``identifier``: what its rows find their entities
        by, as an import naming it would (:mod:`.identifier`); the platform's when None."""
        adapter = get_adapter(import_format)

        async def _chunks():
            yield data

        records: List[Dict[str, Any]] = []
        rows: List[Dict[str, Any]] = []
        skipped = 0
        async for page in _record_pages(adapter, _chunks()):
            records += [r for r in page if isinstance(r, dict)          # a row, not a skipped record
                        and str(r.get("kind") or "").strip().lower() in ("node", "edge")]
            page_rows, page_skipped = await asyncio.to_thread(_normalize_page, page, False)
            skipped += page_skipped
            rows += [{**row, "_row_index": len(rows) + i} for i, (_kind, row) in enumerate(page_rows)]
            if len(rows) > config.IMPORT_COMMIT_WINDOW:
                raise DryRunTooLarge(f"a dry run checks up to {config.IMPORT_COMMIT_WINDOW:,} rows; "
                                     "import a larger file into a draft and read its preview")
        ontology, _identity = await self.contract_context(workspace_id, data_source_id)
        try:
            node_identity = (await self._identity_resolver(workspace_id, data_source_id)
                             if self._identity_resolver is not None else None)
        except Exception as exc:
            raise IdentityUnavailable("the data source's node identity can't be read right now, "
                                      "so rows can't be matched as an import would: try again "
                                      "shortly") from exc
        branch = branch_id or await self._svc.main_branch_id(graph_id)
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        worker = ImportWorker(self._svc, self._store, ontology=ontology, node_identity=node_identity)
        worker._identifier = identifier or identifiers.platform_default()
        await worker.validation_state(snap, graph_id, branch, rows)
        nodes = [r for r in rows if r["kind"] == "node"]
        edges = [r for r in rows if r["kind"] == "edge"]
        lookups: Dict[str, Any] = await worker._node_lookups(snap, nodes) if nodes else {}
        if edges:                                    # one call: an edge finds a node made above it
            more = await worker._edge_lookups(snap, edges)
            for key in ("urn_to_eid", "qname_to_eid", "current", "hash_of", "bases"):
                lookups[key] = {**more.get(key, {}), **lookups.get(key, {})}
            lookups["node_eids"] = set(lookups.get("node_eids") or ()) | more["node_eids"]
            lookups["edge_to_eid"] = more["edge_to_eid"]
            lookups["edge_eids"] = more["edge_eids"]
        lookups.update(created_from={}, keys=worker._keys)
        _ops, resolutions = await asyncio.to_thread(worker.resolve, nodes + edges, lookups)
        summary = {"new": 0, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0,
                   "skipped": skipped}
        for res in resolutions:
            summary[_STATUS[res["resolved_op"]]] += 1
        by_index = {r["_row_index"]: r for r in rows}
        changed = [res for res in resolutions if res["resolved_op"] != "unchanged"]
        sample = [{"rowIndex": res["_row_index"], "kind": by_index[res["_row_index"]]["kind"],
                   "op": res["resolved_op"], "matchedEntityId": res.get("matched_entity_id"),
                   "label": _label(by_index[res["_row_index"]]), "reasons": res.get("reasons") or [],
                   "code": res.get("code")}
                  for res in sorted(changed, key=lambda r: r["_row_index"])[:_VALIDATE_SAMPLE]]
        hints: List[str] = []
        gone = sum(1 for res in resolutions if _ALREADY_GONE in (res.get("reasons") or ()))
        if gone:                             # unchanged, so not among the rows listed
            hints.append(f"{gone} delete {'row finds' if gone == 1 else 'rows find'} nothing to "
                         "delete: what they name isn't in the graph (deleted already, or never "
                         "there). They change nothing; check their names if you expected them to.")
        return {"format": import_format, "checkedAgainst": branch_id or "main",
                "identifier": worker._identifier,
                "schemaVersion": contract.FORMAT_VERSION, "summary": summary, "rows": sample,
                "rowsTruncated": len(changed) > len(sample),
                "unknownColumns": contract.unknown_columns(records), "hints": hints}

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
                # What an import's rows find their entities by (identifier.py); None for others.
                "identifier": row.identity_strategy if row.job_type == "ingest" else None,
                # A replace sent with allowMassDelete: it deletes past the replace guard's limits.
                "allowMassDelete": bool(row.allow_mass_delete),
                # Where its identifier came from, and the replace guard's limits it runs under
                # (``services.import_settings``); None for a job made before they were kept.
                "importSettings": row.import_settings if row.job_type == "ingest" else None,
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
