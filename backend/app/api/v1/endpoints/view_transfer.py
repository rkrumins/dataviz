"""Moving views between environments: export to a file, and import from one.

Mounted at ``/api/v1/views/transfer``, ahead of the core views router so no ``/{view_id}``
route can capture these paths. Runs in its own 120s timeout tier (``main._TimeoutMiddleware``):
a large view's identity check is legitimately longer than the 30s default.

    POST /export      one or more views (optionally at a given version) → a View Bundle file
    POST /inspect     a file (raw body) → is it sound, is it already here, where does it belong
    POST /reconcile   views bound to targets → what matches there, and what would be written
    POST /import      one view → written, with an ``import`` version that proves what was stored;
                      or, on a version-controlled data source, staged in a draft to go live with it

Import is one view per call: every request stays well inside the timeout tier, a multi-view
import reports honest progress, one failure doesn't block the rest, and ``requestId`` makes a
retry safe.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import _domain_errors, get_versioning_service
from backend.app.api.v1.endpoints.view_guards import editable_view, readable_view
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
from backend.app.services.view_transfer import importing, limits
from backend.app.services.view_transfer.bundle import BundleError, check_depth, parse_bundle
from backend.app.services.view_transfer.export import export_views
from backend.app.services.view_transfer.inspect import identity_matches, target_suggestions, view_payload
from backend.app.services.view_transfer.references import Rewrite, reference_layout
from backend.app.services.view_transfer.sources import effective_data_source
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.view_transfer import HistoryEntry, Manifest

logger = logging.getLogger(__name__)
router = APIRouter()


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
    new version first if it has unsaved changes. Every view needs read access; one the caller
    can't read fails the whole export with the same 404 a direct read would give.
    """
    seen = set()
    requests = []
    for ref in req.views:
        if ref.viewId in seen:
            raise HTTPException(status_code=422, detail=f"View '{ref.viewId}' is listed twice")
        seen.add(ref.viewId)
        requests.append((await readable_view(session, ref.viewId, user, claims), ref.version))

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
    body = json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")
    return Response(content=body, media_type="application/json", headers=headers)


# ── Import ──────────────────────────────────────────────────────────────────

Action = Literal["create", "copy", "update", "overwrite"]
Strategy = Literal["replace", "merge"]

_ZIP_MAGIC = b"PK\x03\x04"


def _bundle_error(exc: BundleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "type": "invalid_bundle", "code": exc.code, "message": str(exc),
    })


async def _read_capped(request: Request, cap: int) -> bytes:
    """The request body, refused (413) as soon as it passes ``cap`` rather than after buffering
    all of it."""
    too_big = HTTPException(status_code=413, detail={
        "type": "invalid_bundle", "code": "too_large",
        "message": f"This file is larger than {cap // (1024 * 1024)} MB, the most a view file can be.",
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
        parsed = parse_bundle(raw)
    except BundleError as exc:
        raise _bundle_error(exc)
    ctx = await _viewer_context(session, user, claims) if rbac_flag("RBAC_ENFORCE_VIEWS") else None
    return {
        "bundle": parsed.bundle.model_dump(mode="json", exclude={"views"}),
        "integrity": parsed.integrity,
        "notices": parsed.notices,
        "views": view_payload(parsed),
        "identityMatches": await identity_matches(session, parsed, ctx),
        "targetSuggestions": await target_suggestions(session, parsed, claims),
    }


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
    user, claims: PermissionClaims,
) -> importing.Target:
    """Check the caller may import there, and pin down the data source it reads.

    Update and overwrite need edit access to the view and keep the view's own scope. Create and
    copy need ``workspace:view:create`` in the workspace, and a data source that is part of it.
    """
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
    req: ReconcileRequest = Body(...),
    user=Depends(get_optional_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """What each view would be, and how well it matches, where it's going. Writes nothing.

    For each view: the definition that would be written (the file's, merged with the view here
    when asked, with the resolutions applied) and its reconciliation against the target graph.
    Views sharing a target data source share one identity lookup.
    """
    seen = set()
    total = 0
    items = []
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
        items.append(importing.ReconcileItem(
            key=view.key, definition=definition, view_type=view.viewType,
            exported={urn: info.model_dump() for urn, info in view.manifest.entities.items()},
            entities_resolved=view.manifest.entitiesResolved,
            history_hashes=view.history, action=view.action, strategy=view.strategy,
            rewrite=view.resolutions.to_rewrite(),
            target=await _resolve_target(session, view.target, view.action, view.portableId, user, claims),
        ))
    return await importing.reconcile_items(session, items)


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
    req: ImportRequest = Body(...),
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
    actor = _actor(user)
    if req.stage:
        await require_versioning_enabled()
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in to import into a draft.")
        if req.action in ("create", "copy") and (req.metadata.visibility or "private") not in importing.STAGED_VISIBILITIES:
            raise HTTPException(status_code=422, detail=(
                "A view imported into a draft goes live as private or shared with its workspace. "
                "Publish it to everyone once it's live."))
    if req.requestId:
        previous = await importing.replay(session, req.requestId, actor)
        if previous is not None:
            return await _answer(session, previous, actor)

    definition = _checked_definition(req.definition)
    if req.originDefinition is not None:
        _checked_definition(req.originDefinition)
    if _assignment_count(definition) > limits.MAX_ASSIGNMENTS_PER_BUNDLE:
        raise HTTPException(status_code=422, detail=(
            f"This view holds more than {limits.MAX_ASSIGNMENTS_PER_BUNDLE:,} assignments."))
    target = await _resolve_target(session, req.target, req.action, req.origin.portableId, user, claims)
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
        exported={urn: info.model_dump() for urn, info in req.manifest.entities.items()},
        entities_resolved=req.manifest.entitiesResolved,
        resolutions_summary=req.resolutions.summary(),
        expected_target_hash=req.expectedTargetHash,
        request_id=req.requestId, batch_id=req.batchId, strategy=req.strategy,
        origin_definition=req.originDefinition,
    )
    graph = await _draft_graph(svc, target, claims) if req.stage else None

    async def own_draft_for(row: ViewORM) -> str:
        """An update goes into the importer's draft for the view: the one they have open, or a
        new one (a person has one draft per view)."""
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
        """A new view gets a draft of its own, named for it."""
        with _domain_errors():
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
    return await _answer(session, result, actor)
