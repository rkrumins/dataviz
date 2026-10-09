"""Moving views between environments: export to a file, and import from one.

Mounted at ``/api/v1/views/transfer``, ahead of the core views router so no ``/{view_id}``
route can capture these paths. Runs in its own 120s timeout tier (``main._TimeoutMiddleware``):
a large view's identity check is legitimately longer than the 30s default.

    POST /export      one or more views (optionally at a given version) → a View Bundle file
    POST /inspect     a file (raw body) → is it sound, is it already here, where does it belong
    POST /reconcile   views bound to targets → what matches there, and what would be written
    POST /import      one view → written, with an ``import`` version that proves what was stored;
                      or, on a version-controlled data source, staged in a draft to go live with it
    POST /packages    views WITH their graph data → a View Package, built by an export job
    POST /packages/uploads            a package to import, sent in parts (PUT …/parts/{n}), then
                                      completed (POST …/complete): checked by an inspect job
    GET  /packages/{uploadId}         the checked package, described as /inspect describes a file
    POST /packages/inspect            a package of at most 100 MB as one raw body, uploaded so
    POST /packages/{uploadId}/data    its data → a new draft of the target, by an import job that
                                      reads the upload in place; the view then follows into that
                                      draft (/import, stage)
    POST /packages/{uploadId}/new-source  its data → a NEW data source, whose first version a job
                                      seeds from the upload in place; the views then follow, live

Import is one view per call: every request stays well inside the timeout tier, a multi-view
import reports honest progress, one failure doesn't block the rest, and ``requestId`` makes a
retry safe.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Type, TypeVar

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import (
    _domain_errors, export_scope_of, get_import_export_service, get_versioning_service,
)
from backend.app.api.v1.endpoints.large_json import json_response
from backend.app.api.v1.endpoints.view_guards import editable_view, may_edit_view, readable_view
from backend.app.api.v1.endpoints.views import (
    _compute_ontology_digest,
    _viewer_context,
    authorize_view_create,
)
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed, require_feature
from backend.app.api.v1.versioning_gate import require_versioning_enabled
from backend.app.auth.dependencies import get_optional_user, get_permission_claims, rbac_flag
from backend.app.db.engine import get_db_session
from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import data_source_repo, view_activity_repo, view_repo
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.versioning.import_export import uploads
from backend.app.services.view_transfer import importing, limits, package
from backend.app.services.view_transfer.bundle import BundleError, check_depth, parse_bundle
from backend.app.services.view_transfer.export import export_views, preview as export_preview, seal
from backend.app.services.view_transfer.inspect import identity_matches, target_suggestions, view_payload
from backend.app.services.view_transfer.references import Rewrite, reference_layout
from backend.app.services.view_transfer.sources import effective_data_source, ontology_match
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.view_transfer import HistoryEntry, Manifest

logger = logging.getLogger(__name__)
# The whole feature is a preview behind one switch (Admin → Features); each route below also
# answers to its own direction's switch.
router = APIRouter(dependencies=[Depends(require_feature("viewPortabilityEnabled"))])


def _actor(user) -> Optional[str]:
    return user.id if user else None


def _slug(text: Optional[str], fallback: str = "view") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:60].strip("-")
    return slug or fallback


class ExportViewRef(BaseModel):
    viewId: str = Field(..., min_length=1, max_length=128)
    version: Optional[int] = Field(None, ge=1)


class ExportRequest(BaseModel):
    views: List[ExportViewRef] = Field(..., min_length=1, max_length=limits.MAX_VIEWS_PER_BUNDLE)
    message: Optional[str] = Field(None, max_length=500)


@router.post("/export", dependencies=[Depends(require_feature("viewExportEnabled"))])
async def export_view_file(
    req: ExportRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Download views as a View Bundle file.

    Each view exports as a real version: the one asked for, or its current design, sealed as a
    new version first if it has unsaved changes and the caller may edit it (anyone else gets its
    latest version). Every view needs read access; one the caller can't read fails the whole
    export with the same 404 a direct read would give.
    """
    seen = set()
    requests = []
    for ref in req.views:
        if ref.viewId in seen:
            raise HTTPException(status_code=422, detail=f"View '{ref.viewId}' is listed twice")
        seen.add(ref.viewId)
        view = await readable_view(session, ref.viewId, user, claims)
        requests.append((view, ref.version, await may_edit_view(session, view, user, claims)))

    try:
        bundle, sealed = await export_views(session, requests, actor=_actor(user), message=req.message)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    for item in sealed:
        await view_activity_repo.record_view_activity(
            session, view_id=item.row.id, workspace_id=item.row.workspace_id, action="exported",
            actor=_actor(user), summary=f"Exported v{item.version.version} to a file",
            changes={"version": item.version.version, "definitionHash": item.version.content_hash},
        )

    if len(sealed) == 1:
        only = sealed[0]
        filename = f"{_slug(only.label.get('name'))}.v{only.version.version}.view.json"
    else:
        filename = f"{len(sealed)}-views.view.json"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Bundle-Hash": bundle["bundleHash"],
    }
    if len(sealed) == 1:
        headers["X-Definition-Hash"] = sealed[0].version.content_hash
        headers["X-View-Version"] = str(sealed[0].version.version)
    body = await asyncio.to_thread(lambda: json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8"))
    return Response(content=body, media_type="application/json", headers=headers)


# ── A view with its data: the View Package ──────────────────────────────────


class PackageRequest(BaseModel):
    views: List[ExportViewRef] = Field(..., min_length=1, max_length=limits.MAX_VIEWS_PER_BUNDLE)
    #: ``view``: the one view's own entities; ``source``: the whole data source.
    scope: Literal["view", "source"] = "view"
    #: ``published``, or ``draft``: the caller's own draft of the view.
    dataVersion: Literal["published", "draft"] = "published"
    message: Optional[str] = Field(None, max_length=500)
    #: Makes the request safe to send again: the same id answers with the job it started.
    requestId: Optional[str] = Field(None, min_length=8, max_length=128)


class ExportPreviewRequest(BaseModel):
    viewIds: List[str] = Field(..., min_length=1, max_length=limits.MAX_VIEWS_PER_BUNDLE)


@router.post("/export/preview", dependencies=[Depends(require_feature("viewExportEnabled"))])
async def preview_view_export(
    req: ExportPreviewRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """What exporting these views as they stand would write, in one request however many are
    selected: per view, the version it goes out as, whether that includes unsaved changes (only
    for someone who may edit it), its counts and an estimated size. Writes nothing. A view the
    caller can't read is a 404, as it would be for the export itself."""
    views = []
    for view_id in dict.fromkeys(req.viewIds):
        view = await readable_view(session, view_id, user, claims)
        views.append(await export_preview(session, view, may_seal=await may_edit_view(session, view, user, claims)))
    return await json_response({"views": views})


@router.post("/packages", status_code=202, dependencies=[Depends(require_feature("viewExportEnabled")),
                                                         Depends(require_feature("graphExportEnabled"))])
async def export_view_package(
    req: PackageRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
    ie=Depends(get_import_export_service),
):
    """Package views with their graph data, for another environment to import into a draft.

    A package holds views from ONE version-controlled data source. Here the views are sealed as
    versions, exactly as a view file's are, and published data is pinned to the commit it stands
    at; an export job builds the package off the request — the views' file, then the data streamed
    into it (the view's own entities, as its sealed version places them, or the whole source). Poll
    and download it through the data source's export endpoints; the download is named for it.
    Sending the same ``requestId`` again answers with the job it started.
    """
    if req.scope == "view" and len(req.views) != 1:
        raise HTTPException(status_code=422, detail=(
            "A package of one view's data holds that one view. Package the whole data source to "
            "take several views."))
    seen = set()
    requests = []
    for ref in req.views:
        if ref.viewId in seen:
            raise HTTPException(status_code=422, detail=f"View '{ref.viewId}' is listed twice")
        seen.add(ref.viewId)
        view = await readable_view(session, ref.viewId, user, claims)
        requests.append((view, ref.version, await may_edit_view(session, view, user, claims)))
    first = requests[0][0]
    workspace_id = first.workspace_id
    sources = {(ds.id if ds else None) for ds in [await effective_data_source(session, row) for row, _, _ in requests]}
    ds_id = next(iter(sources))
    if len(sources) != 1 or ds_id is None or any(row.workspace_id != workspace_id for row, _, _ in requests):
        raise HTTPException(status_code=422, detail="A package holds views from one data source.")
    if not has_permission(claims, "workspace:datasource:read", workspace_id=workspace_id):
        raise HTTPException(status_code=403, detail="Missing permission: workspace:datasource:read")
    graph = await svc.get_graph_by_data_source(ds_id)
    if graph is None or graph.get("workspace_id") != workspace_id:
        raise HTTPException(status_code=422, detail={
            "type": "not_versioned",
            "message": "Only a data source under version control can be packaged with its data.",
        })
    actor = _actor(user)
    branch_id = None
    if req.dataVersion == "draft":
        resolved = await svc.resolve_graph(data_source_id=ds_id, actor=actor, workspace_id=workspace_id,
                                           open_draft_if_absent=False, originating_view_id=first.id)
        branch_id = ((resolved or {}).get("my_draft") or {}).get("branch_id")
        if not branch_id:
            raise HTTPException(status_code=422, detail="You have no draft of this view to package.")
    key = f"package:{req.requestId}" if req.requestId else None
    if key:
        started = await ie.find_job(graph_id=graph["graph_id"], idempotency_key=key)
        if started is not None:
            return _package_started(started, req.requestId)

    try:
        sealed = [await seal(session, row, number, actor=actor, message=req.message, may_seal=may_seal)
                  for row, number, may_seal in requests]
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if req.scope == "view" and await asyncio.to_thread(export_scope_of, sealed[0].definition, []) is None:
        raise HTTPException(status_code=422, detail=package.NO_PLACEMENTS)
    for item in sealed:
        await view_activity_repo.record_view_activity(
            session, view_id=item.row.id, workspace_id=item.row.workspace_id, action="exported",
            actor=actor, summary=f"Exported v{item.version.version} with its data to a package",
            changes={"version": item.version.version, "definitionHash": item.version.content_hash,
                     "package": {"scope": req.scope, "dataVersion": req.dataVersion}},
        )
    if len(sealed) == 1:
        filename = f"{_slug(sealed[0].label.get('name'))}.v{sealed[0].version.version}.view-package.zip"
    else:
        filename = f"{len(sealed)}-views.view-package.zip"
    views = [{"viewId": item.row.id, "version": item.version.version} for item in sealed]
    # The job reads these versions from another process, so they are committed before it exists.
    await session.commit()

    try:
        with _domain_errors():
            created = await ie.create_export_job(
                workspace_id=workspace_id, data_source_id=ds_id, graph_id=graph["graph_id"], actor=actor,
                export_format="ndjson", scope_view_id=first.id if req.scope == "view" else None,
                branch_id=branch_id, provider_id=graph.get("provider_id"),
                as_of_seq=None if branch_id else graph.get("main_head_commit_seq"), idempotency_key=key,
                package={"fileName": filename, "scope": req.scope, "dataVersion": req.dataVersion,
                         "views": views, "actor": actor},
            )
    except IntegrityError:                  # the same requestId, sent twice at once
        return _package_started(await ie.find_job(graph_id=graph["graph_id"], idempotency_key=key),
                                req.requestId)
    status = await ie.start_export(created["job_id"])
    return {"jobId": created["job_id"], "graphId": graph["graph_id"], "workspaceId": workspace_id,
            "fileName": filename, "status": status, "views": views, "requestId": req.requestId}


def _package_started(job: Dict[str, Any], request_id: Optional[str]) -> Dict[str, Any]:
    """What ``POST /packages`` answered when it started ``job``."""
    return {"jobId": job["jobId"], "graphId": job["graphId"], "workspaceId": job["workspaceId"],
            "fileName": job.get("fileName"), "status": job["status"],
            "views": (job.get("package") or {}).get("views") or [], "requestId": request_id}


# ── Importing a package: uploaded in parts, checked by a job, its data read in place ─────


class PackageUploadRequest(BaseModel):
    fileName: str = Field(..., max_length=500)
    size: int = Field(..., gt=0)


@contextmanager
def _upload_errors():
    try:
        yield
    except uploads.UploadError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


async def _importer(user) -> None:
    """Who may bring a package's data in: someone signed in, where version control is on."""
    await require_versioning_enabled()
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to import a view with its data.")


async def _package_upload(ie, upload_id: str, user) -> Dict[str, Any]:
    with _upload_errors():
        return await uploads.load_package(ie.store, upload_id, user.id)


async def _upload_state(ie, record: Dict[str, Any], *, received: bool = False) -> Dict[str, Any]:
    """The upload as its dialog follows it: ``uploading`` until it is completed, ``inspecting``
    while its job checks it (with the job's progress), then ``ready`` or ``invalid`` (with why).
    ``received`` adds the parts stored whole (every part, once the upload is completed). While it
    is uploading, ``partUrls`` says where each part goes straight to the store, if the store hands
    out such URLs; parts sent there count as received like any other."""
    state = {"uploadId": record["uploadId"], "fileName": record["fileName"], "size": record["size"],
             "partBytes": record["partBytes"], "parts": record["parts"],
             "expiresAt": uploads.expires_at(record).isoformat(), "jobId": record.get("jobId")}
    if record.get("error"):
        state.update(status="invalid", error=record["error"])
    elif record.get("archive"):
        state["status"] = "ready"
    elif record.get("jobId"):
        job = await ie.get_job(record["jobId"]) or {}
        if job.get("status") == "failed":           # the check broke (not a verdict): complete again
            state.update(status="invalid", error={"code": "inspect_failed", "message": job.get("errorMessage")
                                                  or "The package couldn't be checked. Try again."})
        else:
            state.update(status="inspecting", phase=job.get("phase"), progress=job.get("progress"),
                         processed=job.get("processed"), total=job.get("total"))
    else:
        state["status"] = "uploading"
        # Signing a 10 GiB upload's 640 URLs takes a quarter of a second of CPU: off the loop.
        part_urls = await asyncio.to_thread(_part_urls, ie.store, record)
        if part_urls:
            state["partUrls"] = part_urls
    if received:
        state["received"] = (list(range(record["parts"])) if record.get("jobId")
                             else await uploads.received(ie.store, record))
    return state


def _part_urls(store, record: Dict[str, Any]) -> Optional[List[str]]:
    """A presigned PUT per part, each signed for its part's exact size, when the store presigns
    (only one that does takes ``size``); ``None`` when parts go through ``PUT …/parts/{n}``."""
    def key(n: int) -> str:
        return uploads.upload_key(record, f"part-{n:05d}")

    if store.upload_target(key(0)).mode != "presigned":
        return None
    return [store.upload_target(key(n), size=uploads.part_size(record, n)).url for n in range(record["parts"])]


async def _inspect(ie, record: Dict[str, Any]) -> Dict[str, Any]:
    """Queue the upload's check, once (asking again answers with the same job; a check that broke
    is queued again). Every part must be in. Returns the record as it now stands.

    Repeatable at every step: a completion that died after creating the job — before recording it
    on the upload, or before queuing it — left a pending job no worker claims and an upload that
    still reads ``uploading``. The next completion finds that job (``created`` False) and finishes
    what the first started: it records the job on the upload if the stored record (read again)
    still lacks it, and queues a pending job — ``start_inspect`` only touches a pending row, and a
    pending inspection is queued already unless no completion got that far."""
    if not record.get("jobId"):
        have = set(await uploads.received(ie.store, record))
        missing = [n for n in range(record["parts"]) if n not in have]
        if missing:
            raise HTTPException(status_code=409, detail={
                "type": "parts_missing", "missing": missing,
                "message": f"{len(missing)} of the file's {record['parts']} parts haven't arrived yet. "
                           "Send them, then complete the upload."})
        job_id, created = await ie.create_inspect_job(upload_id=record["uploadId"],
                                                      source_uri=uploads.record_key(record))
        if not created:
            record = await uploads.read_record(ie.store, uploads.record_key(record))
        if not record.get("jobId"):     # recorded before it is queued, so before it can run
            record = {**record, "jobId": job_id}
            await uploads.save(ie.store, record)
    job = await ie.get_job(record["jobId"]) or {}
    if job.get("status") == "pending":
        await ie.start_inspect(record["jobId"])
    elif job.get("status") == "failed" and not record.get("error"):
        await ie.requeue_failed(record["jobId"])
    return record


@router.post("/packages/uploads", status_code=201, dependencies=[Depends(require_feature("viewImportEnabled"))])
async def create_package_upload(
    body: PackageUploadRequest,
    user=Depends(get_optional_user),
    ie=Depends(get_import_export_service),
):
    """Start uploading a view package: how it is to be split (``partBytes``, ``parts``). Send each
    part with ``PUT …/parts/{n}``, several at once and in any order, then complete the upload. A
    package too large to take is refused here, before any of it is sent (413)."""
    await _importer(user)
    with _upload_errors():
        record = await uploads.create_package(ie.store, owner=user.id, file_name=body.fileName, size=body.size)
    return {**await _upload_state(ie, record), "received": []}


@router.get("/packages/uploads/{upload_id}", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def get_package_upload(
    upload_id: str,
    user=Depends(get_optional_user),
    ie=Depends(get_import_export_service),
):
    """Where the upload stands: the parts that arrived (what to send again to resume it), and once
    completed, its check (``inspecting``, then ``ready`` or ``invalid``)."""
    await _importer(user)
    return await _upload_state(ie, await _package_upload(ie, upload_id, user), received=True)


@router.put("/packages/uploads/{upload_id}/parts/{part}",
            dependencies=[Depends(require_feature("viewImportEnabled"))])
async def put_package_upload_part(
    upload_id: str, part: int, request: Request,
    user=Depends(get_optional_user),
    ie=Depends(get_import_export_service),
):
    """One part of the package, the raw request body. Sending a part again replaces it — until the
    upload is completed: what was checked is what is imported."""
    await _importer(user)
    record = await _package_upload(ie, upload_id, user)
    if record.get("jobId"):
        raise HTTPException(status_code=409, detail="This upload is complete. Upload the file again to change it.")
    with _upload_errors():
        size = await uploads.put_part(ie.store, record, part, request.stream())
    return {"part": part, "size": size}


@router.post("/packages/uploads/{upload_id}/complete", status_code=202,
             dependencies=[Depends(require_feature("viewImportEnabled"))])
async def complete_package_upload(
    upload_id: str,
    user=Depends(get_optional_user),
    ie=Depends(get_import_export_service),
):
    """Every part is in: check the package, on a job of its own (``GET …/uploads/{id}`` follows
    it; ``GET /packages/{id}`` then describes it). Asking again answers with the same check."""
    await _importer(user)
    record = await _inspect(ie, await _package_upload(ie, upload_id, user))
    state = await _upload_state(ie, record)
    return {"uploadId": upload_id, "jobId": record["jobId"], "status": state["status"]}


async def _file_range(path: str, start: int, length: int):
    f = await asyncio.to_thread(open, path, "rb")
    try:
        await asyncio.to_thread(f.seek, start)
        while length > 0:
            chunk = await asyncio.to_thread(f.read, min(length, 1024 * 1024))
            if not chunk:
                return
            length -= len(chunk)
            yield chunk
    finally:
        await asyncio.to_thread(f.close)


@router.post("/packages/inspect", status_code=202, dependencies=[Depends(require_feature("viewImportEnabled"))])
async def inspect_view_package(
    request: Request,
    user=Depends(get_optional_user),
    ie=Depends(get_import_export_service),
):
    """A package of at most 100 MB sent whole (the raw body), for scripts: stored as an upload and
    checked as one sent in parts is. Returns ``{uploadId, jobId}``; follow it as such an upload."""
    await _importer(user)
    path = await _spool(request, limits.MAX_PACKAGE_BYTES)
    try:
        with open(path, "rb") as f:
            head = f.read(4)
        if head != _ZIP_MAGIC:
            raise HTTPException(status_code=422, detail={
                "type": "invalid_package", "code": "view_file",
                "message": "This is a view file, without data. Import it with \"Import a view\".",
            })
        with _upload_errors():
            record = await uploads.create_package(ie.store, owner=user.id, file_name="package.zip",
                                                  size=os.path.getsize(path))
            for n in range(record["parts"]):
                await uploads.put_part(ie.store, record, n, _file_range(
                    path, n * record["partBytes"], uploads.part_size(record, n)))
    finally:
        os.unlink(path)
    record = await _inspect(ie, record)
    return {"uploadId": record["uploadId"], "jobId": record["jobId"]}


async def _spool(request: Request, cap: int) -> str:
    """The request body in a temporary file (the caller removes it), refused (413) as soon as it
    passes ``cap``."""
    too_big = HTTPException(status_code=413, detail={
        "type": "invalid_package", "code": "too_large",
        "message": f"This file is larger than {cap // (1024 * 1024)} MB, the most a package can be "
                   "in one request. Upload it in parts.",
    })
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise too_big
    fd, path = tempfile.mkstemp(suffix=".zip")
    size = 0
    try:
        with os.fdopen(fd, "wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > cap:
                    raise too_big
                await asyncio.to_thread(out.write, chunk)
    except BaseException:
        os.unlink(path)
        raise
    return path


async def _read_json(store, key: str) -> Optional[Dict[str, Any]]:
    if not (await store.stat(key)).exists:
        return None
    return json.loads(b"".join([c async for c in store.open_stream(key)]).decode("utf-8"))


_EXPIRED = "This package upload has expired. Choose the file again."


def _gone() -> HTTPException:
    """The package's upload, or a part of it, is gone: expired and swept. 410 ``upload_expired``,
    typed, so the wizard asks for the file again on this answer and on no other — a 404 here also
    means a missing workspace or view."""
    return HTTPException(status_code=410, detail={"type": "upload_expired", "message": _EXPIRED})


async def _package_to_read(ie, upload_id: str, user) -> Dict[str, Any]:
    """The upload a package route reads, or :func:`_gone` — for one that was never this person's
    too: the same answer either way, as the upload routes give their 404."""
    try:
        return await _package_upload(ie, upload_id, user)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise _gone()
        raise


@router.get("/packages/{upload_id}", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def get_view_package(
    upload_id: str,
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
    ie=Depends(get_import_export_service),
):
    """A checked package, described as ``/inspect`` describes a view file — plus the package
    itself (its parts, verified or not, and what its data holds by type: ``package.data.
    typeStats``), and per source, the semantic layer here that is its own (``ontologyMatch``).
    Only data sources under version control can take its data, since it goes into a draft, so each
    suggested target says whether it is (``versioned``). 409 until the check is done; 422 when the
    file is no package to import; 410 ``upload_expired`` once it is gone."""
    await _importer(user)
    record = await _package_to_read(ie, upload_id, user)
    state = await _upload_state(ie, record)
    if state["status"] == "invalid":
        raise HTTPException(status_code=422, detail={"type": "invalid_package", **state["error"]})
    if state["status"] != "ready":
        raise HTTPException(status_code=409, detail={"type": "not_ready", "status": state["status"],
                                                     "jobId": state["jobId"]})
    inspection = await _read_json(ie.store, uploads.upload_key(record, package.INSPECTION))
    key = uploads.upload_key(record, package.UPLOAD_BUNDLE)
    if inspection is None or not (await ie.store.stat(key)).exists:
        raise _gone()
    raw = b"".join([c async for c in ie.store.open_stream(key)])
    parsed = await asyncio.to_thread(parse_bundle, raw)            # checked when it was uploaded

    ctx = await _viewer_context(session, user, claims) if rbac_flag("RBAC_ENFORCE_VIEWS") else None
    suggestions = await target_suggestions(session, parsed, claims)
    versioned: Dict[str, bool] = {}
    for items in suggestions.values():
        for item in items:
            ds = item.get("dataSourceId")
            if ds not in versioned:
                graph = await svc.get_graph_by_data_source(ds) if ds else None
                versioned[ds] = graph is not None and graph.get("workspace_id") == item.get("workspaceId")
            item["versioned"] = versioned[ds]
    bundle = parsed.bundle.model_dump(mode="json", exclude={"views"})
    return await json_response({
        "uploadId": upload_id,
        "package": inspection["package"],
        "bundle": bundle,
        "integrity": parsed.integrity,
        "notices": parsed.notices,
        "views": await asyncio.to_thread(view_payload, parsed),
        "identityMatches": await identity_matches(session, parsed, ctx),
        "targetSuggestions": suggestions,
        "ontologyMatch": await ontology_match(session, claims, bundle["sources"],
                                              (bundle.get("generator") or {}).get("environment")),
        "expiresAt": state["expiresAt"],
    })


class PackageDataRequest(BaseModel):
    workspaceId: str = Field(..., max_length=128)
    dataSourceId: str = Field(..., max_length=128)
    #: The view here the package's view will update, if it updates one: the draft is for it.
    viewId: Optional[str] = Field(None, max_length=128)
    draftName: Optional[str] = Field(None, max_length=200)


#: How close to its expiry an upload stops taking new imports: a job created now is pinned against
#: the sweep (uploads.jobs_input_prefixes), and this keeps the sweep from beating it to the upload.
_EXPIRY_MARGIN = timedelta(hours=1)


@router.post("/packages/{upload_id}/data", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def import_package_data(
    upload_id: str,
    body: PackageDataRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
    ie=Depends(get_import_export_service),
):
    """Bring a checked package's graph data into a new draft of the target data source: the first
    half of importing a view with its data. The view follows into the same draft (``/import`` with
    ``stage`` and this draft as ``target.branchId``), so the two are reviewed and published
    together. It only ever adds and updates: a package never deletes anything.

    The import job reads the data from the upload where it is — nothing is copied — and the upload
    is kept while any job may still read it. Each target (data source, and view) gets its own draft
    and job; asking again for the same target answers with its job, or, when that job failed,
    queues it again: it resumes into the same draft from where it stopped. A job still queued or
    running is never queued twice. Progress is the import job's, through the data source's import
    endpoints. 409 until the package is checked; 410 ``upload_expired`` when the upload is gone or
    about to expire.
    """
    await _importer(user)
    record = await _package_to_read(ie, upload_id, user)
    if not record.get("archive"):
        state = await _upload_state(ie, record)
        raise HTTPException(status_code=409, detail={
            "type": "not_inspected", "status": state["status"],
            "message": "This package hasn't been checked yet. Wait for its check to finish."})

    workspace = await session.get(WorkspaceORM, body.workspaceId)
    if workspace is None or workspace.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Workspace '{body.workspaceId}' not found")
    ds = await data_source_repo.get_data_source_orm(session, body.dataSourceId)
    if ds is None or ds.workspace_id != body.workspaceId:
        raise HTTPException(status_code=422, detail="That data source isn't part of this workspace.")
    graph = await _draft_graph(svc, importing.Target(body.workspaceId, body.dataSourceId), claims)
    if body.viewId:
        row = await editable_view(session, body.viewId, user, claims)
        view_ds = await effective_data_source(session, row)
        if view_ds is None or view_ds.id != body.dataSourceId:
            raise HTTPException(status_code=422, detail="That view reads another data source.")

    key = f"pkgdata:{upload_id}:{body.viewId or '-'}"
    names = record.get("views") or []
    name = (body.draftName or (f"Import: {names[0]}" if len(names) == 1 else f"Import: {len(names)} views"))[:200]
    # Once checked, the upload's record is never written again: its imports read it while they run.
    started = await ie.find_job(graph_id=graph["graph_id"], idempotency_key=key)
    if started is not None:
        if started["status"] == "failed":
            if len(await uploads.received(ie.store, record)) != record["parts"]:
                raise _gone()
            await ie.requeue_failed(started["jobId"])    # a second retry racing this one finds it queued
        return _data_started(started, body, name)
    if datetime.now(timezone.utc) >= uploads.expires_at(record) - _EXPIRY_MARGIN:
        raise HTTPException(status_code=410, detail={
            "type": "upload_expired",
            "message": "This package upload is about to expire. Choose the file again to import it."})

    with _domain_errors():
        branch_id = await svc.open_draft(graph_id=graph["graph_id"], owner=user.id, name=name,
                                         originating_view_id=body.viewId)
        try:
            created = await ie.create_import_job(
                workspace_id=body.workspaceId, data_source_id=body.dataSourceId, graph_id=graph["graph_id"],
                actor=user.id, import_format="ndjson", source_uri=uploads.record_key(record),
                branch_id=branch_id, reconcile_mode="upsert", idempotency_key=key, name=name,
            )
        except IntegrityError:              # the same target, asked for twice at once
            return _data_started(await ie.find_job(graph_id=graph["graph_id"], idempotency_key=key), body, name)
    await ie.start_import(created["job_id"])
    return _data_started({"jobId": created["job_id"], "branchId": branch_id, "graphId": graph["graph_id"]},
                         body, name)


def _data_started(job: Dict[str, Any], body: PackageDataRequest, draft_name: str) -> Dict[str, Any]:
    """What ``/data`` answers for the import ``job`` it started (or had started) for this target."""
    return {"jobId": job["jobId"], "branchId": job["branchId"], "graphId": job["graphId"],
            "workspaceId": body.workspaceId, "dataSourceId": body.dataSourceId, "viewId": body.viewId,
            "draftName": draft_name}


# ── A new data source from a package ─────────────────────────────────────────


class NewSourceRequest(BaseModel):
    #: Makes the request safe to send again: the browser keeps it per file.
    requestId: str = Field(..., pattern=r"^nsr_[0-9a-f]{32}$")
    workspaceId: str = Field(..., max_length=128)
    providerId: str = Field(..., max_length=128)
    label: str = Field(..., min_length=1, max_length=200)
    graphName: str = Field(..., min_length=1, max_length=64)
    #: The semantic layer to bind — a draft one too (made from the package's types) — or none.
    ontologyId: Optional[str] = Field(None, max_length=128)


#: Where an upload notes the data source it created (``new-source.json`` beside its record): the
#: record itself is never written once checked — its imports read it while they run.
_NEW_SOURCE_HINT = "new-source.json"
_NEW_SOURCE_PERMISSION = "workspace:datasource:manage"
_SEED_ENFORCEMENT = "permissive"


@asynccontextmanager
async def _per_upload(upload_id: str):
    """One new-source request per upload at a time, across every API pod: an advisory lock held by
    a transaction of its own, on a dedicated management connection, from before the upload's
    existing source is looked for until the new one's job is queued — so a retry racing the first
    request finds what it created instead of creating a second. Transaction-scoped, so it goes with
    the transaction whatever ends the request (and holds behind a transaction-mode pooler)."""
    from sqlalchemy import text

    from backend.app.db.engine import PoolRole, get_engine

    async with get_engine(PoolRole.WEB).connect() as conn:
        async with conn.begin():
            await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                               {"k": f"pkg-new-source:{upload_id}"})
            yield


async def _bundle_origin(store, record: Dict[str, Any]) -> Dict[str, Any]:
    """What the new source records of the views' file: its hash and where it was made."""
    key = uploads.upload_key(record, package.UPLOAD_BUNDLE)
    if not (await store.stat(key)).exists:
        raise _gone()
    raw = b"".join([c async for c in store.open_stream(key)])
    bundle = await asyncio.to_thread(json.loads, raw)
    source = next(iter((bundle.get("sources") or {}).values()), None) or {}
    return {"bundleHash": bundle.get("bundleHash"),
            "sourceEnvironment": (bundle.get("generator") or {}).get("environment"),
            "sourceDataSource": (source.get("dataSource") or {}).get("id")}


async def _seed_ontology(session: AsyncSession, claims: PermissionClaims, ontology_id: Optional[str],
                         workspace_id: str):
    """The semantic layer a new source binds: one that exists and the caller can see — a draft
    too. 422 ``ontology_unknown`` otherwise (for one the caller can't see as well: its existence
    is not leaked).

    A workspace-scoped caller sees only layers some data source of theirs is bound to, so the
    draft "Create from this package" has just made is invisible to them until something binds it.
    One who may manage semantic layers in the workspace may therefore bind a draft nothing is
    bound to yet — never a published layer, nor one another source already reads."""
    from sqlalchemy import func, select

    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.db.repositories import ontology_definition_repo
    from backend.app.services.workspace_visibility import ensure_ontology_visible

    if not ontology_id:
        return None
    unknown = HTTPException(status_code=422, detail={
        "type": "ontology_unknown",
        "message": "That semantic layer doesn't exist here. Choose another, or none."})
    ont = await ontology_definition_repo.get_ontology(session, ontology_id)
    if ont is None or getattr(ont, "deleted_at", None):
        raise unknown
    try:
        await ensure_ontology_visible(session, claims, ontology_id)
    except HTTPException:
        unbound_draft = (
            not getattr(ont, "is_published", True)
            and has_permission(claims, "workspace:ontology:manage", workspace_id=workspace_id)
            and not await session.scalar(select(func.count()).select_from(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.ontology_id == ontology_id,
                WorkspaceDataSourceORM.deleted_at.is_(None))))
        if not unbound_draft:
            raise unknown
    return ont


def _new_source_answer(ds, origin: Dict[str, Any], job: Dict[str, Any]) -> Dict[str, Any]:
    return {"dataSourceId": ds.id, "graphId": job["graph_id"], "jobId": job["job_id"],
            "status": job["status"], "label": ds.label, "graphName": ds.graph_name,
            "ontologyId": ds.ontology_id, "enforcement": _SEED_ENFORCEMENT,
            "requestId": origin.get("requestId")}


@router.post("/packages/{upload_id}/new-source", status_code=202,
             dependencies=[Depends(require_feature("viewImportEnabled"))])
async def create_source_from_package(
    upload_id: str,
    response: Response,
    body: NewSourceRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
    ie=Depends(get_import_export_service),
):
    """Make a brand-new data source of a checked package's data: a managed source on the chosen
    FalkorDB provider, under a graph name nothing else uses, bound to the chosen semantic layer (or
    none), whose first version on main IS the package's data — copied by a job (``origin:
    'package'``) that keeps the package's entity ids. No draft, nothing to publish; follow the job
    through the data source's bootstrap status. The views then follow, imported live.

    The request moves no data: it provisions the source, queues the job and answers 202. Asking
    again with the same ``requestId`` — or for the same target, once this upload has made one —
    answers 200 with what the first request made, finishing anything it left undone (a request
    that died after making the data source queues its job). One upload makes one source per
    workspace: another target is 409 ``upload_consumed``. 409 ``not_inspected`` until the package
    is checked; 410 ``upload_expired`` when the upload is gone or about to expire; 422 for a provider
    that isn't usable, a semantic layer that isn't there, or a graph name that is taken (with a free
    ``suggestion``); 502 ``provisioning_failed`` when the version store couldn't be made — the data
    source this request made is removed, never one it found."""
    from backend.app.services import managed_sources
    from backend.app.services.versioning.bootstrap_worker import (
        BootstrapConflict, create_bootstrap_job)

    await _importer(user)
    record = await _package_to_read(ie, upload_id, user)
    if not record.get("archive"):
        state = await _upload_state(ie, record)
        raise HTTPException(status_code=409, detail={
            "type": "not_inspected", "status": state["status"],
            "message": "This package hasn't been checked yet. Wait for its check to finish."})
    workspace = await session.get(WorkspaceORM, body.workspaceId)
    if workspace is None or workspace.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Workspace '{body.workspaceId}' not found")
    if not has_permission(claims, _NEW_SOURCE_PERMISSION, workspace_id=body.workspaceId):
        raise HTTPException(status_code=403, detail=f"Missing permission: {_NEW_SOURCE_PERMISSION}")

    async with _per_upload(upload_id):
        ds = await managed_sources.find_origin_data_source(session, body.workspaceId, upload_id)
        created, ont = ds is None, None
        if ds is not None:
            origin = managed_sources.origin_of(ds.extra_config) or {}
            same = (origin.get("requestId") == body.requestId
                    or (ds.provider_id == body.providerId
                        and ds.graph_name == body.graphName.strip().lower()))
            if not same:
                raise HTTPException(status_code=409, detail={
                    "type": "upload_consumed", "dataSourceId": ds.id,
                    "message": "This package already made a data source here. Open it, or give it "
                               "up to make another."})
        else:
            if datetime.now(timezone.utc) >= uploads.expires_at(record) - _EXPIRY_MARGIN:
                raise HTTPException(status_code=410, detail={
                    "type": "upload_expired",
                    "message": "This package upload is about to expire. Choose the file again."})
            await managed_sources.assert_provider_usable(session, body.workspaceId, body.providerId,
                                                         subject="New data sources")
            ont = await _seed_ontology(session, claims, body.ontologyId, body.workspaceId)
            graph_name = await managed_sources.claim_graph_name(session, body.providerId,
                                                                body.graphName)
            origin = {"kind": "viewPackage", "uploadId": upload_id, "requestId": body.requestId,
                      **await _bundle_origin(ie.store, record),
                      "createdAt": datetime.now(timezone.utc).isoformat()}
            ds_id, _name = await managed_sources.create_managed_data_source(
                session, body.workspaceId, provider_id=body.providerId,
                ontology_id=body.ontologyId, label=body.label, actor=user.id,
                graph_name=graph_name, origin=origin)
            ds = await data_source_repo.get_data_source_orm(session, ds_id)

        inspection = await _read_json(ie.store, uploads.upload_key(record, package.INSPECTION)) or {}
        found = inspection.get("package") or {}
        data = found.get("data") or {}
        type_stats = data.get("typeStats")
        if ds.ontology_id and not created:
            try:                                    # only for a job not queued yet: never refuses
                ont = await _seed_ontology(session, claims, ds.ontology_id, body.workspaceId)
            except HTTPException:
                ont = None
        coverage = managed_sources.ontology_coverage(type_stats, ont) if ont is not None else None
        try:
            job = await create_bootstrap_job(
                data_source_id=ds.id, workspace_id=body.workspaceId, actor=user.id,
                falkor_graph_name=ds.graph_name, falkor_provider=ds.provider_id,
                base_ontology_id=ds.ontology_id, ontology_enforcement=_SEED_ENFORCEMENT,
                origin="package", payload_uri=uploads.record_key(record), upload_id=upload_id,
                package={"integrity": found.get("integrity"), "scope": found.get("scope"),
                         "manifest": {"nodes": data.get("nodes"), "edges": data.get("edges"),
                                      "version": data.get("version")},
                         "typeStats": type_stats, "bytes": record["archive"].get("bytes"),
                         "bundleHash": origin.get("bundleHash"),
                         "sourceEnvironment": origin.get("sourceEnvironment")},
                coverage=coverage)
        except BootstrapConflict as exc:
            raise HTTPException(status_code=409, detail=exc.detail)
        except Exception:
            logger.exception("new source from package %s: the version store failed (ds=%s)",
                             record["uploadId"], ds.id)
            # Only what THIS request made, and only while nothing stands on it: a data source found
            # here is someone's earlier attempt, and one with a graph has a job to give up instead.
            if created and await svc.get_graph_by_data_source(ds.id) is None:
                await managed_sources.drop_managed_data_source(session, ds.id)
            raise HTTPException(status_code=502, detail={
                "type": "provisioning_failed",
                "message": "The new data source's version store could not be created."})
        # No aggregation is registered here: a job dispatched now would run on the still-empty key
        # and stamp its marker there, which the seed's emptiness check then finds. The seed's
        # finalize queues the first rollup build, once the copy is live.

    answer = _new_source_answer(ds, origin, job)
    try:
        await ie.store.put_stream(uploads.upload_key(record, _NEW_SOURCE_HINT), _bytes_of(
            json.dumps({**answer, "workspaceId": body.workspaceId}).encode("utf-8")))
    except Exception:                                   # a hint: the data source is the record
        logger.warning("could not note the new source on upload %s", record["uploadId"],
                       exc_info=True)
    if not created:
        response.status_code = 200
    return answer


async def _bytes_of(data: bytes):
    yield data


# ── Import ──────────────────────────────────────────────────────────────────

Action = Literal["create", "copy", "update", "overwrite"]
Strategy = Literal["replace", "merge"]

_ZIP_MAGIC = b"PK\x03\x04"


def _bundle_error(exc: BundleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "type": "invalid_bundle", "code": exc.code, "message": str(exc),
    })


async def _read_capped(request: Request, cap: int, message: Optional[str] = None) -> bytes:
    """The request body, refused (413) as soon as it passes ``cap`` rather than after buffering
    all of it."""
    too_big = HTTPException(status_code=413, detail={
        "type": "invalid_bundle", "code": "too_large",
        "message": message or f"This file is larger than {cap // (1024 * 1024)} MB, the most a view file can be.",
    })
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise too_big
    chunks: List[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > cap:
            raise too_big
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/inspect", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def inspect_view_file(
    request: Request,
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Read a view file (the raw body) without writing anything.

    Returns the file's views with each one's integrity, the views here that already ARE one of
    them (same identity, readable by the caller, with how the two stand), and per source in the
    file the data sources here it most likely belongs to, measured on a sample of its entities.
    """
    raw = await _read_capped(request, limits.MAX_BUNDLE_BYTES)
    if raw.startswith(_ZIP_MAGIC):
        raise HTTPException(status_code=422, detail={
            "type": "invalid_bundle", "code": "package",
            "message": "This is a view package (a view with its data). Import it with "
                       "\"Import a view with its data\".",
        })
    try:
        parsed = await asyncio.to_thread(parse_bundle, raw)
    except BundleError as exc:
        raise _bundle_error(exc)
    ctx = await _viewer_context(session, user, claims) if rbac_flag("RBAC_ENFORCE_VIEWS") else None
    return await json_response({
        "bundle": parsed.bundle.model_dump(mode="json", exclude={"views"}),
        "integrity": parsed.integrity,
        "notices": parsed.notices,
        "views": await asyncio.to_thread(view_payload, parsed),
        "identityMatches": await identity_matches(session, parsed, ctx),
        "targetSuggestions": await target_suggestions(session, parsed, claims),
    })


class Resolutions(BaseModel):
    """The importer's answers to what didn't match, applied before anything is checked or
    written: entities remapped to others or dropped, types mapped to this graph's or dropped."""
    remap: Dict[str, str] = Field(default_factory=dict)
    drop: List[str] = Field(default_factory=list)
    typeMap: Dict[str, str] = Field(default_factory=dict)
    dropTypes: List[str] = Field(default_factory=list)
    relTypeMap: Dict[str, str] = Field(default_factory=dict)
    dropRelTypes: List[str] = Field(default_factory=list)

    def to_rewrite(self) -> Rewrite:
        return Rewrite(
            urn_map=dict(self.remap), drop_urns=set(self.drop),
            type_map=dict(self.typeMap), drop_types=set(self.dropTypes),
            rel_type_map=dict(self.relTypeMap), drop_rel_types=set(self.dropRelTypes),
        )

    def summary(self, sample: int = 200) -> Dict[str, Any]:
        """What the version's provenance keeps: every type decision, and entity decisions as
        counts with a sample (a remap of 100k entities is not provenance, it's a second copy)."""
        return {
            "remapped": len(self.remap), "dropped": len(self.drop),
            "remap": dict(list(self.remap.items())[:sample]), "drop": self.drop[:sample],
            "typeMap": self.typeMap, "dropTypes": self.dropTypes,
            "relTypeMap": self.relTypeMap, "dropRelTypes": self.dropRelTypes,
        }


class TargetRef(BaseModel):
    """Where a view goes: a workspace (and data source) for a new view, a view to update."""
    workspaceId: Optional[str] = Field(None, max_length=128)
    dataSourceId: Optional[str] = Field(None, max_length=128)
    viewId: Optional[str] = Field(None, max_length=128)
    #: One of the caller's drafts of that data source: checked against as the draft reads (a
    #: package's data counts as there), and, when staging, the draft the view goes into.
    branchId: Optional[str] = Field(None, max_length=128)


class ReconcileView(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    portableId: Optional[str] = Field(None, max_length=128)
    definition: Dict[str, Any]
    viewType: str = Field("graph", max_length=64)
    manifest: Manifest = Field(default_factory=Manifest)
    history: List[str] = Field(default_factory=list)       # the file's version hashes
    target: TargetRef
    action: Action
    strategy: Strategy = "replace"
    resolutions: Resolutions = Field(default_factory=Resolutions)


class ReconcileRequest(BaseModel):
    views: List[ReconcileView] = Field(..., min_length=1, max_length=limits.MAX_VIEWS_PER_BUNDLE)


async def _resolve_target(
    session: AsyncSession, target: TargetRef, action: str, portable_id: Optional[str],
    user, claims: PermissionClaims, svc: Optional[GraphVersioningService] = None,
) -> importing.Target:
    """Check the caller may import there, and pin down the data source (and draft) it reads.

    Update and overwrite need edit access to the view and keep the view's own scope. Create and
    copy need ``workspace:view:create`` in the workspace, and a data source that is part of it.
    A draft named in the target must be the caller's own open draft of that data source.
    """
    resolved = await _resolve_scope(session, target, action, portable_id, user, claims)
    if target.branchId:
        if svc is None or user is None:
            raise HTTPException(status_code=422, detail="Drafts can't be read here.")
        graph = await svc.get_graph_by_data_source(resolved.data_source_id) if resolved.data_source_id else None
        if graph is None or graph.get("workspace_id") != resolved.workspace_id:
            raise HTTPException(status_code=422, detail="That draft isn't a draft of this data source.")
        with _domain_errors():
            await svc.claim_draft(graph_id=graph["graph_id"], branch_id=target.branchId, actor=user.id)
        resolved.branch_id = target.branchId
    return resolved


async def _resolve_scope(
    session: AsyncSession, target: TargetRef, action: str, portable_id: Optional[str],
    user, claims: PermissionClaims,
) -> importing.Target:
    if action in ("update", "overwrite"):
        if not target.viewId:
            raise HTTPException(status_code=422, detail="Choose the view to update.")
        row = await editable_view(session, target.viewId, user, claims)
        if action == "update" and portable_id and row.portable_id != portable_id:
            raise HTTPException(status_code=422, detail=(
                f"'{row.name}' isn't this view, so it can't be updated from it. "
                "Overwrite it instead, or import a separate copy."))
        ds = await effective_data_source(session, row)
        return importing.Target(row.workspace_id, ds.id if ds else row.data_source_id, row)

    if not target.workspaceId:
        raise HTTPException(status_code=422, detail="Choose a workspace to import into.")
    workspace = await session.get(WorkspaceORM, target.workspaceId)
    if workspace is None or workspace.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Workspace '{target.workspaceId}' not found")
    if rbac_flag("RBAC_ENFORCE_VIEWS") and not has_permission(
            claims, "workspace:view:create", workspace_id=target.workspaceId):
        raise HTTPException(status_code=403, detail="Missing permission: workspace:view:create")
    if target.dataSourceId:
        ds = await data_source_repo.get_data_source_orm(session, target.dataSourceId)
        if ds is None or ds.workspace_id != target.workspaceId:
            raise HTTPException(status_code=422, detail="That data source isn't part of this workspace.")
    return importing.Target(target.workspaceId, target.dataSourceId)


#: A /reconcile or /import body: a file's designs, each possibly with the file's own copy too.
_MAX_REQUEST_BYTES = 2 * limits.MAX_BUNDLE_BYTES

_Body = TypeVar("_Body", bound=BaseModel)


async def _body(request: Request, model: Type[_Body]) -> _Body:
    """The request body as ``model``, parsed and validated in a worker thread.

    FastAPI would do it on the event loop, and a view's design with its manifest runs to tens of
    megabytes: about a second (46 MB) that every other request this worker serves would wait out.
    A body that doesn't validate is refused as FastAPI refuses one, with a 422 listing the errors.
    """
    raw = await _read_capped(request, _MAX_REQUEST_BYTES,
                             f"This request is larger than {_MAX_REQUEST_BYTES // (1024 * 1024)} MB.")
    try:
        return await asyncio.to_thread(model.model_validate_json, raw)
    except ValidationError as exc:
        raise RequestValidationError(
            [{**error, "loc": ("body", *error["loc"])} for error in exc.errors(include_url=False)])


def _exported(manifest: Manifest) -> Dict[str, Dict[str, Any]]:
    return {urn: info.model_dump() for urn, info in manifest.entities.items()}


def _checked_definition(definition: Dict[str, Any]) -> Dict[str, Any]:
    try:
        check_depth(definition)
    except BundleError as exc:
        raise _bundle_error(exc)
    return definition


def _assignment_count(definition: Dict[str, Any]) -> int:
    assignments = (reference_layout(definition) or {}).get("assignments")
    return len(assignments) if isinstance(assignments, dict) else 0


@router.post("/reconcile", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def reconcile_view_file(
    request: Request,
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """What each view would be, and how well it matches, where it's going. Writes nothing.

    For each view: the definition that would be written (the file's, merged with the view here
    when asked, with the resolutions applied) and its reconciliation against the target graph,
    or the caller's draft of it when the target names one. Views sharing a target graph share
    one identity lookup.
    """
    req = await _body(request, ReconcileRequest)

    def checked() -> List[tuple]:
        """Each view's definition checked, and its manifest as the reconciler reads it. Both walk
        whole designs, so this runs in a worker thread."""
        seen = set()
        total = 0
        out = []
        for view in req.views:
            if view.key in seen:
                raise HTTPException(status_code=422, detail=f"Key '{view.key}' is used twice")
            seen.add(view.key)
            definition = _checked_definition(view.definition)
            total += _assignment_count(definition)
            if total > limits.MAX_ASSIGNMENTS_PER_BUNDLE:
                raise HTTPException(status_code=422, detail=(
                    f"These views hold more than {limits.MAX_ASSIGNMENTS_PER_BUNDLE:,} assignments. "
                    "Check them in smaller groups."))
            out.append((view, definition, _exported(view.manifest)))
        return out

    items = []
    for view, definition, exported in await asyncio.to_thread(checked):
        items.append(importing.ReconcileItem(
            key=view.key, definition=definition, view_type=view.viewType,
            exported=exported,
            entities_resolved=view.manifest.entitiesResolved,
            history_hashes=view.history, action=view.action, strategy=view.strategy,
            rewrite=view.resolutions.to_rewrite(),
            target=await _resolve_target(session, view.target, view.action, view.portableId, user, claims, svc),
        ))
    return await json_response(await importing.reconcile_items(session, items))


class ImportMetadata(BaseModel):
    name: str = Field(..., min_length=1, max_length=limits.MAX_NAME_LENGTH)
    description: Optional[str] = Field(None, max_length=10_000)
    icon: Optional[str] = Field(None, max_length=128)
    tags: List[str] = Field(default_factory=list, max_length=200)
    viewType: str = Field("graph", max_length=64)
    visibility: Optional[str] = None               # new views only


class ImportOrigin(BaseModel):
    """Where the view came from, as the file says: recorded in the version's provenance."""
    portableId: Optional[str] = Field(None, max_length=128)
    sourceViewId: Optional[str] = Field(None, max_length=128)
    version: Optional[int] = None
    definitionHash: Optional[str] = Field(None, max_length=128)
    name: Optional[str] = Field(None, max_length=limits.MAX_NAME_LENGTH)
    environment: Optional[str] = Field(None, max_length=128)
    exportedAt: Optional[str] = Field(None, max_length=64)
    exportedBy: Optional[str] = Field(None, max_length=limits.MAX_NAME_LENGTH)
    fileName: Optional[str] = Field(None, max_length=500)


class ImportRequest(BaseModel):
    action: Action
    strategy: Strategy = "replace"
    target: TargetRef
    metadata: ImportMetadata
    #: The definition to write: ``effectiveDefinition`` from /reconcile, plus any edits made in
    #: the wizard since. The server canonicalises, validates and hashes it again.
    definition: Dict[str, Any]
    origin: ImportOrigin = Field(default_factory=ImportOrigin)
    #: The file's own definition, sent when ``definition`` differs from it (entities remapped
    #: or dropped, a merge, edits in the wizard). Kept with the version so a later file from the
    #: same lineage still finds it as the version the two sides last agreed on.
    originDefinition: Optional[Dict[str, Any]] = None
    manifest: Manifest = Field(default_factory=Manifest)
    history: List[HistoryEntry] = Field(default_factory=list)
    resolutions: Resolutions = Field(default_factory=Resolutions)
    #: The target's design hash when it was reviewed; the import is refused (409) if it moved.
    expectedTargetHash: Optional[str] = Field(None, max_length=128)
    requestId: Optional[str] = Field(None, min_length=8, max_length=128)
    batchId: Optional[str] = Field(None, max_length=128)
    #: Import into a draft of the (version-controlled) data source rather than live: the view
    #: changes, or appears, when the draft is published or its review merges.
    stage: bool = False


_DRAFT_PERMISSION = "workspace:datasource:manage"


async def _draft_graph(svc: GraphVersioningService, target: importing.Target, claims: PermissionClaims) -> dict:
    """The versioned graph a staged import's draft is opened on, once the caller may open one."""
    graph = (await svc.get_graph_by_data_source(target.data_source_id)
             if target.data_source_id else None)
    if graph is None or graph.get("workspace_id") != target.workspace_id:
        raise HTTPException(status_code=422, detail={
            "type": "not_versioned",
            "message": "This data source isn't under version control, so there's no draft to import into.",
        })
    if not has_permission(claims, _DRAFT_PERMISSION, workspace_id=target.workspace_id):
        raise HTTPException(status_code=403, detail=f"Missing permission: {_DRAFT_PERMISSION}")
    return graph


async def _answer(session: AsyncSession, result: Dict[str, Any], actor: Optional[str]) -> Dict[str, Any]:
    """The import's result, with the view as it now reads: on its draft, when it was staged."""
    staged = result.get("staged")
    if staged is None:
        row = await session.get(ViewORM, result["viewId"])
        if row is not None and row.draft_branch_id:
            staged = {"branchId": row.draft_branch_id}
            result = {**result, "staged": staged}
    view = await view_repo.get_view_enriched(session, result["viewId"], user_id=actor,
                                             branch_id=(staged or {}).get("branchId"))
    return {"view": view, **result}


@router.post("/import", dependencies=[Depends(require_feature("viewImportEnabled"))])
async def import_view_file(
    request: Request,
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    svc: GraphVersioningService = Depends(get_versioning_service),
):
    """Write one view from a file: a new view, a copy, or a new version of a view here.

    Everything happens in one transaction: the view, its ``import`` version (with where it came
    from and how well it matched) and the activity entry. The response re-reads what was
    stored and says whether it is exactly what was sent (``integrity.verified``), or how the
    rules here adjusted it. Retrying with the same ``requestId`` returns the first result.

    With ``stage``, the import goes into a draft of the data source instead (see
    ``importing.stage_update`` and ``importing.stage_new``) and the response names it.
    """
    req = await _body(request, ImportRequest)
    actor = _actor(user)
    if req.stage:
        await require_versioning_enabled()
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in to import into a draft.")
        if req.action in ("create", "copy") and (req.metadata.visibility or "private") not in importing.STAGED_VISIBILITIES:
            raise HTTPException(status_code=422, detail=(
                "A view imported into a draft goes live as private or shared with its workspace. "
                "Publish it to everyone once it's live."))
    if req.target.branchId and not req.stage:
        raise HTTPException(status_code=422, detail=(
            "A view checked against a draft goes into that draft: import it with stage set."))
    if req.requestId:
        previous = await importing.replay(session, req.requestId, actor)
        if previous is not None:
            return await json_response(await _answer(session, previous, actor))

    def checked() -> Dict[str, Dict[str, Any]]:
        """The definitions checked and the manifest read, in a worker thread: both walk whole designs."""
        _checked_definition(req.definition)
        if req.originDefinition is not None:
            _checked_definition(req.originDefinition)
        if _assignment_count(req.definition) > limits.MAX_ASSIGNMENTS_PER_BUNDLE:
            raise HTTPException(status_code=422, detail=(
                f"This view holds more than {limits.MAX_ASSIGNMENTS_PER_BUNDLE:,} assignments."))
        return _exported(req.manifest)

    exported = await asyncio.to_thread(checked)
    definition = req.definition
    target = await _resolve_target(session, req.target, req.action, req.origin.portableId, user, claims, svc)
    view_type = req.metadata.viewType
    if req.action in ("create", "copy"):
        await authorize_view_create(claims, session, workspace_id=target.workspace_id,
                                    data_source_id=target.data_source_id,
                                    visibility=req.metadata.visibility)
        await ensure_view_mode_allowed(view_type, session)
    elif target.view is not None and view_type != target.view.view_type:
        # Same rule as editing a view: only a CHANGE of layout has to be one offered here.
        await ensure_view_mode_allowed(view_type, session)

    item = importing.ImportItem(
        action=req.action, target=target,
        metadata=req.metadata.model_dump(),
        definition=definition,
        provenance=req.origin.model_dump(),
        history=[h.model_dump() for h in req.history][-limits.MAX_HISTORY_ENTRIES:],
        exported=exported,
        entities_resolved=req.manifest.entitiesResolved,
        resolutions_summary=req.resolutions.summary(),
        expected_target_hash=req.expectedTargetHash,
        request_id=req.requestId, batch_id=req.batchId, strategy=req.strategy,
        origin_definition=req.originDefinition,
    )
    graph = await _draft_graph(svc, target, claims) if req.stage else None

    async def own_draft_for(row: ViewORM) -> str:
        """An update goes into the importer's draft for the view: the one they have open, or a
        new one (a person has one draft per view); or into the draft the target names."""
        if target.branch_id:
            return target.branch_id
        with _domain_errors():
            resolved = await svc.resolve_graph(
                data_source_id=target.data_source_id, actor=actor, workspace_id=target.workspace_id,
                open_draft_if_absent=True, originating_view_id=row.id,
            )
        draft = (resolved or {}).get("my_draft")
        if not draft:
            raise HTTPException(status_code=409, detail="A draft couldn't be opened for this view.")
        return draft["branch_id"]

    async def new_draft_for(row: ViewORM) -> str:
        """A new view gets a draft of its own, named for it; or goes into the draft the target
        names (the one its package's data went into), which becomes its draft if it has no view."""
        with _domain_errors():
            if target.branch_id:
                await svc.claim_draft(graph_id=graph["graph_id"], branch_id=target.branch_id,
                                      actor=actor, view_id=row.id)
                return target.branch_id
            return await svc.open_draft(graph_id=graph["graph_id"], owner=actor,
                                        name=f"Import: {row.name}"[:200], originating_view_id=row.id)

    digest = await _compute_ontology_digest(session, target.workspace_id, target.data_source_id)
    try:
        async with session.begin_nested():
            if not req.stage:
                result = await importing.import_item(session, item, actor=actor, ontology_digest=digest)
            elif target.view is not None:
                result = await importing.stage_update(session, item, actor=actor, open_draft=own_draft_for)
            else:
                result = await importing.stage_new(session, item, actor=actor, ontology_digest=digest,
                                                   open_draft=new_draft_for)
    except importing.AlreadyImported:
        result = await importing.replay(session, req.requestId, actor)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return await json_response(await _answer(session, result, actor))
