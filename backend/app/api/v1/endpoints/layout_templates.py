"""Layout templates: reusable Context View layer arrangements, with a lifecycle.

Mounted at ``/api/v1/layout-templates`` for every signed-in user. Who sees a
template and what they may do with it is decided per template by
``services/template_access.py`` — built-in, organization, workspace or
personal, plus shares with people and groups.

  GET    ""                       every template the caller can use
  POST   ""                       keep a new one
  GET    /{id}                    one (404 when missing, deleted or not theirs to see)
  PUT    /{id}                    edit, or change who can use it
  DELETE /{id}                    soft delete — ``POST /{id}/restore`` undoes it
  PUT    /{id}/hidden             hide or show a built-in for everyone
  GET    /{id}/versions[/{v}]     every version of its layers (newest first), or one
  POST   /{id}/versions/{v}/restore   make version v's layers the newest version
  PUT    /{id}/featured           spotlight it at the top of the library (managers)
  POST|DELETE /{id}/favourite     the caller's favourites
  POST|DELETE /{id}/promotion-request   ask (or stop asking) for it to be offered to everyone
  POST   /{id}/promotion-request/approve|decline   a manager's answer
  GET    /promotion-requests      the pending ones (managers)
  GET|POST /{id}/grants           shares (owner or workspace admin)
  PUT|DELETE /{id}/grants/{gid}

A template's layers are versioned: changing them makes a new version, and a view
built from an older one is offered the difference (``views.context_model_version``).

Duplicating is a client-side GET then POST. API keys never reach these routes
(``auth/api_key_surface.py`` is deny-by-default).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.view_grants import hydrate_subject
from backend.app.api.v1.view_read_scope import readable_clause
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.models import ContextModelORM, ViewORM
from backend.app.db.repositories import (
    grant_repo, group_repo, layout_template_repo, notification_repo, user_repo,
    view_repo, workspace_repo,
)
from backend.app.services import template_access
from backend.app.services.activity import recorder
from backend.app.services.layout_config import strip_placements
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.template_access import MANAGE, RESOURCE, TemplateViewer
from backend.auth_service.interface import User
from backend.common.models.layout_templates import (
    LayoutTemplateCreateRequest,
    LayoutTemplateFeaturedRequest,
    LayoutTemplateHiddenRequest,
    LayoutTemplateNoteRequest,
    LayoutTemplateListResponse,
    LayoutTemplateResponse,
    LayoutTemplateUpdateRequest,
    LayoutTemplateVersionListResponse,
    LayoutTemplateVersionResponse,
    LayoutTemplateVersionSummary,
)
from backend.common.models.rbac import ViewGrantCreateRequest, ViewGrantResponse

router = APIRouter()

_NOT_FOUND = "Template not found"


# ── helpers ──────────────────────────────────────────────────────────

async def _viewer(session: AsyncSession, user: User, claims: PermissionClaims) -> TemplateViewer:
    return await TemplateViewer.build(session, user=user, claims=claims)


async def _readable(session: AsyncSession, ctx: TemplateViewer, template_id: str) -> ContextModelORM:
    row = await layout_template_repo.get_template(session, template_id)
    if row is None or not template_access.can_read(ctx, row):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return row


async def _shareable(session: AsyncSession, ctx: TemplateViewer, template_id: str) -> ContextModelORM:
    row = await _readable(session, ctx, template_id)
    if not template_access.can_share(ctx, row):
        raise HTTPException(
            status_code=403,
            detail="Only its owner or a workspace admin can share this template.",
        )
    return row


async def _checked_layers(session: AsyncSession, layers: list, previous: list) -> list:
    """The structure a template keeps — placements stripped — refused (422)
    when a new or changed rule can never match: the check a view's save makes,
    so a view built from the template saves too."""
    layers = strip_placements(layers)
    try:
        await view_repo.check_layer_rules(session, {"layers": layers}, {"layers": previous})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return layers


async def _check_audience(
    session: AsyncSession, ctx: TemplateViewer, visibility: str, workspace_id: Optional[str],
    refusal: Optional[str],
) -> None:
    problem = template_access.audience_problem(visibility, workspace_id)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    if refusal:
        raise HTTPException(status_code=403, detail=refusal)
    if workspace_id and not await workspace_repo.names_by_id(session, [workspace_id]):
        raise HTTPException(status_code=404, detail="Workspace not found")


def _target(row: ContextModelORM) -> dict:
    return {
        "workspace_id": row.workspace_id,
        "target_type": RESOURCE,
        "target_id": row.id,
        "target_label": row.name,
    }


async def _responses(
    session: AsyncSession, ctx: TemplateViewer, rows: list[ContextModelORM],
    *, user: User, claims: PermissionClaims,
) -> list[LayoutTemplateResponse]:
    ids = [r.id for r in rows]
    readable, _scope = await readable_clause(session, user, claims)
    usage = await view_repo.count_views_grouped(
        session, ViewORM.context_model_id, readable=readable, ids=ids,
    )
    ws_names = await workspace_repo.names_by_id(
        session, {r.workspace_id for r in rows if r.workspace_id},
    )
    shareable = {r.id for r in rows if template_access.can_share(ctx, r)}
    grants = await grant_repo.count_grants_for_resources(
        session, resource_type=RESOURCE, resource_ids=sorted(shareable),
    )
    favourites = await layout_template_repo.favourite_ids(session, user.id, ids)
    last_used = await view_repo.last_built_from(session, user.id, ids)
    defaults: dict[str, list] = {}
    for ws_id, ws_name, tid in await workspace_repo.defaults_for_templates(session, ids):
        if has_permission(claims, "workspace:view:read", workspace_id=ws_id):
            defaults.setdefault(tid, []).append({"workspaceId": ws_id, "workspaceName": ws_name})
    return [
        LayoutTemplateResponse(
            id=r.id,
            name=r.name,
            description=r.description,
            category=r.category,
            visibility=r.visibility,
            builtIn=r.system_key is not None,
            hidden=r.system_key is not None and not r.is_active,
            workspaceId=r.workspace_id,
            workspaceName=ws_names.get(r.workspace_id) if r.workspace_id else None,
            layers=layout_template_repo.layers_of(r),
            createdBy=r.created_by,
            createdAt=r.created_at,
            updatedAt=r.updated_at,
            usageCount=usage.get(r.id, 0),
            grantCount=grants.get(r.id, 0) if r.id in shareable else None,
            version=r.version,
            featured=bool(r.is_pinned) and (r.system_key is not None or r.visibility == "enterprise"),
            isFavourite=r.id in favourites,
            lastUsedAt=last_used.get(r.id),
            defaultFor=defaults.get(r.id, []),
            promotionRequest=_promotion_request(ctx, r),
            access=template_access.access_envelope(ctx, r),
        )
        for r in rows
    ]


def _promotion_request(ctx: TemplateViewer, row: ContextModelORM) -> Optional[dict]:
    """A pending request to offer it to everyone — for whoever asked, whoever
    may change its audience, and the managers who answer."""
    if row.promotion_requested_at is None:
        return None
    if not (ctx.is_manager or row.promotion_requested_by == ctx.user_id or template_access.can_share(ctx, row)):
        return None
    return {
        "requestedBy": row.promotion_requested_by,
        "requestedAt": row.promotion_requested_at,
        "note": row.promotion_request_note,
    }


async def _response(
    session: AsyncSession, ctx: TemplateViewer, row: ContextModelORM,
    *, user: User, claims: PermissionClaims,
) -> LayoutTemplateResponse:
    return (await _responses(session, ctx, [row], user=user, claims=claims))[0]


def _grant_response(grant, subject) -> ViewGrantResponse:
    return ViewGrantResponse(
        grant_id=grant.id,
        role=grant.role_name,
        granted_at=grant.granted_at,
        granted_by=grant.granted_by,
        subject=subject,
    )


async def _grant_on(session: AsyncSession, template_id: str, grant_id: str):
    grants = await grant_repo.list_grants_for_resource(
        session, resource_type=RESOURCE, resource_id=template_id,
    )
    target = next((g for g in grants if g.id == grant_id), None)
    if target is None:
        # A grant id from another template the caller manages is not reachable here.
        raise HTTPException(status_code=404, detail="Grant not found on this template")
    return target


def _version_summary(v) -> dict:
    return dict(
        version=v.version, name=v.name, changeNote=v.change_note,
        layerCount=len(layout_template_repo.layers_of(v)),
        createdBy=v.created_by, createdAt=v.created_at,
    )


async def _new_layers_version(
    session: AsyncSession, row: ContextModelORM, layers: list, *, user: User, note: Optional[str],
) -> None:
    """Make ``layers`` the template's newest version."""
    await layout_template_repo.update_template(
        session, row, {"layers": layers, "version": row.version + 1},
    )
    await layout_template_repo.add_version(session, row, created_by=user.id, change_note=note)


async def _tell_view_owners(session: AsyncSession, row: ContextModelORM, user: User, note: Optional[str]) -> None:
    """Whoever built a live view from an older version hears there is a new one
    — once until they read it, and never the person who made the change."""
    owners = await view_repo.template_owners_behind(session, row.id, row.version)
    if owners:
        await notification_repo.notify(
            session,
            user_ids=sorted(owners),
            kind="layout_template.updated",
            title=f'"{row.name}" has a new version',
            body=note or "See what changed and apply it to the views you built from it.",
            link=f"/templates/{row.id}",
            actor_id=user.id,
            resource_type=RESOURCE,
            resource_id=row.id,
            dedupe_unread=True,
        )


# ── Templates ────────────────────────────────────────────────────────

@router.get("", response_model=LayoutTemplateListResponse)
async def list_layout_templates(
    include_hidden: bool = Query(False, alias="includeHidden"),
    limit: int = Query(500, ge=1, le=500),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Every template the caller can use. ``includeHidden`` adds the built-ins
    hidden for everyone — visible only to template managers."""
    ctx = await _viewer(session, user, claims)
    where = template_access.readable_templates_clause(ctx)
    if not include_hidden:
        where = and_(where, or_(
            ContextModelORM.system_key.is_(None), ContextModelORM.is_active.is_(True),
        ))
    rows, total = await layout_template_repo.list_templates(session, where, limit=limit)
    items = await _responses(session, ctx, rows, user=user, claims=claims)
    return LayoutTemplateListResponse(items=items, total=total)


@router.post("", response_model=LayoutTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_layout_template(
    req: LayoutTemplateCreateRequest = Body(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    await _check_audience(
        session, ctx, req.visibility, req.workspace_id,
        template_access.creation_refusal(ctx, req.visibility, req.workspace_id),
    )
    row = await layout_template_repo.create_template(
        session,
        name=req.name,
        description=req.description,
        category=req.category,
        visibility=req.visibility,
        workspace_id=req.workspace_id,
        layers=await _checked_layers(session, req.layers, []),
        created_by=user.id,
    )
    await recorder.record_for_request(
        session, "visualization.layout_template.created", **_target(row),
        details={"visibility": row.visibility},
    )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.get("/promotion-requests", response_model=LayoutTemplateListResponse)
async def list_layout_template_promotion_requests(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Templates whose owners ask for them to be offered to everyone — for the
    managers who answer. Declared before ``/{template_id}``."""
    ctx = await _viewer(session, user, claims)
    if not ctx.is_manager:
        raise HTTPException(status_code=403, detail="Only template managers answer these requests.")
    where = and_(
        ContextModelORM.is_template.is_(True), ContextModelORM.deleted_at.is_(None),
        ContextModelORM.promotion_requested_at.isnot(None), ContextModelORM.visibility != "enterprise",
    )
    rows, total = await layout_template_repo.list_templates(session, where, limit=500)
    items = await _responses(session, ctx, rows, user=user, claims=claims)
    return LayoutTemplateListResponse(items=items, total=total)


@router.get("/{template_id}", response_model=LayoutTemplateResponse)
async def get_layout_template(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    return await _response(session, ctx, row, user=user, claims=claims)


@router.put("/{template_id}", response_model=LayoutTemplateResponse)
async def update_layout_template(
    template_id: str,
    req: LayoutTemplateUpdateRequest = Body(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Partial: an absent field is left as it is. Leaving the workspace tier
    clears the workspace; naming one for another tier is a 422."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if not template_access.can_edit(ctx, row):
        raise HTTPException(status_code=403, detail=(
            "A built-in template can't be changed. Duplicate it to make one of your own."
            if row.system_key is not None else "You can't edit this template."
        ))

    changes: dict = {}
    sent = req.model_fields_set
    visibility = req.visibility or row.visibility
    if visibility == "workspace":
        workspace_id = req.workspace_id or row.workspace_id
    else:
        workspace_id = req.workspace_id if "workspace_id" in sent else None
    if (visibility, workspace_id) != (row.visibility, row.workspace_id):
        await _check_audience(
            session, ctx, visibility, workspace_id,
            template_access.move_refusal(ctx, row, visibility, workspace_id),
        )
        changes.update(visibility=visibility, workspace_id=workspace_id)
    if req.name is not None:
        changes["name"] = req.name
    for column in ("description", "category"):
        if column in sent:
            changes[column] = getattr(req, column)
    new_layers = None
    if req.layers is not None:
        # Locked, so two editors saving at once make versions n+1 and n+2.
        await session.refresh(row, with_for_update=True)
        current = layout_template_repo.layers_of(row)
        checked = await _checked_layers(session, req.layers, current)
        # The studio sends every layer back; only a real change is a new version.
        if checked != current:
            new_layers = checked

    if changes or new_layers is not None:
        await layout_template_repo.update_template(session, row, changes)
        details: dict = {"changed": sorted(changes) + (["layers"] if new_layers is not None else [])}
        if new_layers is not None:
            await _new_layers_version(session, row, new_layers, user=user, note=req.change_note)
            details["version"] = row.version
            if req.notify_users and row.visibility != "private":
                await _tell_view_owners(session, row, user, req.change_note)
        await recorder.record_for_request(
            session, "visualization.layout_template.updated", **_target(row), details=details,
        )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.get("/{template_id}/versions", response_model=LayoutTemplateVersionListResponse)
async def list_layout_template_versions(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    versions = await layout_template_repo.list_versions(session, row.id)
    return LayoutTemplateVersionListResponse(
        items=[LayoutTemplateVersionSummary(**_version_summary(v)) for v in versions],
    )


@router.get("/{template_id}/versions/{version}", response_model=LayoutTemplateVersionResponse)
async def get_layout_template_version(
    template_id: str,
    version: int,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    found = await layout_template_repo.get_version(session, row.id, version)
    if found is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return LayoutTemplateVersionResponse(
        **_version_summary(found), layers=layout_template_repo.layers_of(found),
    )


@router.post("/{template_id}/versions/{version}/restore", response_model=LayoutTemplateResponse)
async def restore_layout_template_version(
    template_id: str,
    version: int,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Make version ``version``'s layers the newest version — a new version, so
    the history keeps what it replaced. Nothing changes when they already are."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if not template_access.can_edit(ctx, row):
        raise HTTPException(status_code=403, detail="You can't edit this template.")
    found = await layout_template_repo.get_version(session, row.id, version)
    if found is None:
        raise HTTPException(status_code=404, detail="Version not found")
    await session.refresh(row, with_for_update=True)
    current = layout_template_repo.layers_of(row)
    layers = await _checked_layers(session, layout_template_repo.layers_of(found), current)
    if layers != current:
        await _new_layers_version(session, row, layers, user=user, note=f"Restored version {version}")
        await recorder.record_for_request(
            session, "visualization.layout_template.version_restored", **_target(row),
            details={"restoredFrom": version, "version": row.version},
        )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layout_template(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Soft delete: views built from it keep their layers, and the same id
    comes back — shares and all — with ``POST /{id}/restore``."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if not template_access.can_delete(ctx, row):
        raise HTTPException(status_code=403, detail="You can't delete this template.")
    await layout_template_repo.set_deleted(session, row, user.id)
    await recorder.record_for_request(
        session, "visualization.layout_template.deleted", **_target(row),
    )


@router.post("/{template_id}/restore", response_model=LayoutTemplateResponse)
async def restore_layout_template(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await layout_template_repo.get_template(session, template_id)
    # Whoever may delete it may undo that; to anyone else it does not exist.
    if row is None or not template_access.can_delete(ctx, row):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if row.deleted_at is not None:
        await layout_template_repo.set_deleted(session, row, None)
        await recorder.record_for_request(
            session, "visualization.layout_template.restored", **_target(row),
        )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.put("/{template_id}/hidden", response_model=LayoutTemplateResponse)
async def set_layout_template_hidden(
    template_id: str,
    req: LayoutTemplateHiddenRequest = Body(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Hide a built-in from everyone but template managers, or show it again."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if not template_access.can_hide(ctx, row):
        raise HTTPException(status_code=403, detail=(
            "Only a built-in template can be hidden. Delete this one instead."
            if row.system_key is None else
            "Hiding a built-in template needs the Manage templates permission."
        ))
    if row.is_active == req.hidden:
        await layout_template_repo.update_template(session, row, {"is_active": not req.hidden})
        await recorder.record_for_request(
            session,
            "visualization.layout_template.hidden" if req.hidden
            else "visualization.layout_template.shown",
            **_target(row),
        )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.put("/{template_id}/featured", response_model=LayoutTemplateResponse)
async def set_layout_template_featured(
    template_id: str,
    req: LayoutTemplateFeaturedRequest = Body(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Spotlight a template at the top of everyone's library, or stop."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if not template_access.can_feature(ctx, row):
        raise HTTPException(status_code=403, detail=(
            "Only a template manager can feature a template, and only one everyone can use."
        ))
    if bool(row.is_pinned) != req.featured:
        await layout_template_repo.update_template(session, row, {"is_pinned": req.featured})
        await recorder.record_for_request(
            session,
            "visualization.layout_template.featured" if req.featured
            else "visualization.layout_template.unfeatured",
            **_target(row),
        )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.post("/{template_id}/favourite", response_model=LayoutTemplateResponse)
async def favourite_layout_template(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """One of the caller's favourites — theirs alone. Asking twice is fine."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    await layout_template_repo.set_favourite(session, row.id, user.id, True)
    return await _response(session, ctx, row, user=user, claims=claims)


@router.delete("/{template_id}/favourite", status_code=status.HTTP_204_NO_CONTENT)
async def unfavourite_layout_template(
    template_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """No longer a favourite — allowed even after losing access, so nobody keeps
    one they can't remove."""
    await layout_template_repo.set_favourite(session, template_id, user.id, False)


@router.post("/{template_id}/promotion-request", response_model=LayoutTemplateResponse)
async def request_layout_template_promotion(
    template_id: str,
    req: Optional[LayoutTemplateNoteRequest] = Body(None),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask for a team's template to be offered to the whole organization. The
    template managers hear about it, and may read the template until they answer."""
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if row.promotion_requested_at is not None:
        raise HTTPException(status_code=409, detail="Already asked — a template manager will answer.")
    if not template_access.can_request_promotion(ctx, row):
        raise HTTPException(status_code=403, detail=(
            "Only its owner or a workspace admin can ask for this template to be offered to everyone."
        ))
    note = ((req.note or "").strip() or None) if req else None
    layout_template_repo.set_promotion_request(row, requested_by=user.id, note=note)
    await session.flush()
    managers = await notification_repo.users_with_global_permission(session, MANAGE)
    await notification_repo.notify(
        session,
        user_ids=sorted(managers),
        kind="layout_template.promotion_requested",
        title=f'Offer "{row.name}" to everyone?',
        body=note or "Its owner asks for this layout template to be offered to the whole organization.",
        link=f"/templates/{row.id}",
        actor_id=user.id,
        resource_type=RESOURCE,
        resource_id=row.id,
    )
    await recorder.record_for_request(
        session, "visualization.layout_template.promotion_requested", **_target(row),
    )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.delete("/{template_id}/promotion-request", status_code=status.HTTP_204_NO_CONTENT)
async def withdraw_layout_template_promotion(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _readable(session, ctx, template_id)
    if row.promotion_requested_at is None:
        return
    if row.promotion_requested_by != user.id and not template_access.can_share(ctx, row):
        raise HTTPException(
            status_code=403,
            detail="Only whoever asked, or whoever may share it, can withdraw this request.",
        )
    layout_template_repo.set_promotion_request(row, requested_by=None, note=None)
    await recorder.record_for_request(
        session, "visualization.layout_template.promotion_withdrawn", **_target(row),
    )


async def _answer_promotion(
    session: AsyncSession, ctx: TemplateViewer, template_id: str, *, approve: bool,
    note: Optional[str], user: User,
) -> ContextModelORM:
    row = await _readable(session, ctx, template_id)
    if not template_access.can_decide_promotion(ctx, row):
        if row.promotion_requested_at is None:
            raise HTTPException(status_code=409, detail="There is no request to answer.")
        raise HTTPException(status_code=403, detail="Only template managers answer these requests.")
    requester = row.promotion_requested_by
    if approve:
        # A manager's call: no rights over its current audience are needed.
        await layout_template_repo.update_template(
            session, row, {"visibility": "enterprise", "workspace_id": None},
        )
    layout_template_repo.set_promotion_request(row, requested_by=None, note=None)
    await session.flush()
    if requester:
        await notification_repo.notify(
            session,
            user_ids=[requester],
            kind="layout_template.promotion_approved" if approve else "layout_template.promotion_declined",
            title=(f'"{row.name}" is now offered to everyone' if approve
                   else f'"{row.name}" stays as it was'),
            body=note or (
                "A template manager approved your request; template managers look after it from now on."
                if approve else "A template manager declined your request to offer it to everyone."
            ),
            link=f"/templates/{row.id}",
            actor_id=user.id,
            resource_type=RESOURCE,
            resource_id=row.id,
        )
    await recorder.record_for_request(
        session,
        "visualization.layout_template.promotion_approved" if approve
        else "visualization.layout_template.promotion_declined",
        **_target(row),
    )
    return row


@router.post("/{template_id}/promotion-request/approve", response_model=LayoutTemplateResponse)
async def approve_layout_template_promotion(
    template_id: str,
    req: Optional[LayoutTemplateNoteRequest] = Body(None),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Offer it to the whole organization — template managers look after it from then on."""
    ctx = await _viewer(session, user, claims)
    row = await _answer_promotion(
        session, ctx, template_id, approve=True, note=req.note if req else None, user=user,
    )
    return await _response(session, ctx, row, user=user, claims=claims)


@router.post("/{template_id}/promotion-request/decline", response_model=LayoutTemplateResponse)
async def decline_layout_template_promotion(
    template_id: str,
    req: Optional[LayoutTemplateNoteRequest] = Body(None),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _answer_promotion(
        session, ctx, template_id, approve=False, note=req.note if req else None, user=user,
    )
    return await _response(session, ctx, row, user=user, claims=claims)


# ── Shares ───────────────────────────────────────────────────────────

@router.get("/{template_id}/grants", response_model=list[ViewGrantResponse])
async def list_layout_template_grants(
    template_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    await _shareable(session, ctx, template_id)
    grants = await grant_repo.list_grants_for_resource(
        session, resource_type=RESOURCE, resource_id=template_id,
    )
    return [
        _grant_response(g, await hydrate_subject(session, g.subject_type, g.subject_id))
        for g in grants
    ]


@router.post(
    "/{template_id}/grants", response_model=ViewGrantResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_layout_template_grant(
    template_id: str,
    body: ViewGrantCreateRequest,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _shareable(session, ctx, template_id)
    if body.subject_type == "user":
        if await user_repo.get_user_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="User not found")
    elif body.subject_type == "group":
        if await group_repo.get_group_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="Group not found")
    else:
        raise HTTPException(status_code=400, detail="subjectType must be 'user' or 'group'")
    if await grant_repo.find_grant(
        session, resource_type=RESOURCE, resource_id=template_id,
        subject_type=body.subject_type, subject_id=body.subject_id,
    ) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="They already have access to this template",
        )
    try:
        grant = await grant_repo.create_grant(
            session, resource_type=RESOURCE, resource_id=template_id,
            subject_type=body.subject_type, subject_id=body.subject_id,
            role_name=body.role, granted_by=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    recipients = (
        [body.subject_id] if body.subject_type == "user"
        else [m.user_id for m in await group_repo.list_group_members(session, body.subject_id)]
    )
    await notification_repo.notify(
        session,
        user_ids=recipients,
        kind="layout_template.shared",
        title=f'The layout template "{row.name}" was shared with you',
        body=(
            "You can use it for new views and edit it." if body.role == "editor"
            else "You can use it for new views."
        ),
        link=f"/templates/{template_id}",
        actor_id=user.id,
        resource_type=RESOURCE,
        resource_id=template_id,
    )
    await recorder.record_for_request(
        session, "visualization.layout_template.grant_added", **_target(row),
        details={"subjectType": body.subject_type, "subjectId": body.subject_id, "role": body.role},
    )
    return _grant_response(grant, await hydrate_subject(session, body.subject_type, body.subject_id))


@router.put("/{template_id}/grants/{grant_id}", response_model=ViewGrantResponse)
async def update_layout_template_grant(
    template_id: str,
    grant_id: str,
    role: str = Body(..., embed=True),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Change a share's role (viewer ↔ editor) in place."""
    if role not in grant_repo.VALID_GRANT_ROLES:
        raise HTTPException(
            status_code=422,
            detail=f"role must be one of: {', '.join(sorted(grant_repo.VALID_GRANT_ROLES))}",
        )
    ctx = await _viewer(session, user, claims)
    row = await _shareable(session, ctx, template_id)
    target = await _grant_on(session, template_id, grant_id)
    if target.role_name != role:
        previous = target.role_name
        target.role_name = role
        await session.flush()
        await recorder.record_for_request(
            session, "visualization.layout_template.grant_updated", **_target(row),
            details={
                "subjectType": target.subject_type, "subjectId": target.subject_id,
                "role": {"from": previous, "to": role},
            },
        )
    return _grant_response(target, await hydrate_subject(session, target.subject_type, target.subject_id))


@router.delete("/{template_id}/grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layout_template_grant(
    template_id: str,
    grant_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    ctx = await _viewer(session, user, claims)
    row = await _shareable(session, ctx, template_id)
    target = await _grant_on(session, template_id, grant_id)
    await grant_repo.delete_grant(session, grant_id)
    await recorder.record_for_request(
        session, "visualization.layout_template.grant_removed", **_target(row),
        details={"subjectType": target.subject_type, "subjectId": target.subject_id},
    )
