"""Access-request endpoints (RBAC Phase 4.3).

Closes the "I clicked Edit, got 403, now what?" loop. Any
authenticated user can ask a workspace admin for access at a
specific role; admins see a per-workspace inbox and can approve
(atomically minting a binding) or deny.

Routes (mounted from ``api.py``):

  POST   /api/v1/access-requests
         Submit a new request. Any authenticated user.
  GET    /api/v1/me/access-requests?status=
         Caller's own queue (My Access page).
  GET    /api/v1/admin/workspaces/{ws_id}/access-requests?status=pending
         Admin inbox, gated by ``workspace:admin`` for that ws.
  POST   /api/v1/admin/access-requests/{req_id}/approve
         Approve and atomically create the role binding.
  POST   /api/v1/admin/access-requests/{req_id}/deny
         Deny with optional resolution note.

Outbox events fire on every state transition:

  * ``rbac.access_request.created``
  * ``rbac.access_request.approved``
  * ``rbac.access_request.denied``

These set up SIEM relay for compliance — the table itself is the
source of truth for the request state machine.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import AccessRequestORM, UserORM, WorkspaceORM
from backend.app.db.repositories import (
    access_request_repo,
    binding_repo,
    role_repo,
    user_repo,
)
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    AccessRequestCreate,
    AccessRequestRequester,
    AccessRequestResolve,
    AccessRequestResponse,
    AccessRequestTarget,
)


logger = logging.getLogger(__name__)


# Three routers — each mounts on a different prefix in api.py so the
# auth gate is naturally scoped.
public_router = APIRouter()    # /access-requests              (any auth user)
me_router = APIRouter()        # /me/access-requests           (any auth user)
admin_ws_router = APIRouter()  # /admin/workspaces/{ws_id}/... (workspace:admin)
admin_router = APIRouter()     # /admin/access-requests/{id}/* (lookup → workspace:admin)


# ── Helpers ──────────────────────────────────────────────────────────


async def _hydrate_requester(
    session: AsyncSession, user_id: str
) -> AccessRequestRequester:
    """Best-effort identity resolution for the inbox.

    Returns a ``id``-only payload when the user row is gone — we
    still surface the request so the admin can clean it up.
    """
    row = await session.execute(select(UserORM).where(UserORM.id == user_id))
    user_orm = row.scalar_one_or_none()
    if user_orm is None:
        return AccessRequestRequester(id=user_id)
    full_name = f"{user_orm.first_name} {user_orm.last_name}".strip() or user_orm.email
    return AccessRequestRequester(
        id=user_orm.id,
        email=user_orm.email,
        display_name=full_name,
    )


async def _hydrate_target(
    session: AsyncSession, target_type: str, target_id: str
) -> AccessRequestTarget:
    """Resolve a workspace target to its name. ``label`` is left
    ``None`` when the workspace was deleted or the type is something
    we don't yet know how to label."""
    if target_type == "workspace":
        row = await session.execute(
            select(WorkspaceORM).where(WorkspaceORM.id == target_id)
        )
        ws = row.scalar_one_or_none()
        if ws is not None:
            return AccessRequestTarget(type="workspace", id=target_id, label=ws.name)
    return AccessRequestTarget(type=target_type, id=target_id)


async def _to_response(
    session: AsyncSession, row
) -> AccessRequestResponse:
    return AccessRequestResponse(
        id=row.id,
        requester=await _hydrate_requester(session, row.requester_id),
        target=await _hydrate_target(session, row.target_type, row.target_id),
        requested_role=row.requested_role,
        justification=row.justification,
        status=row.status,
        created_at=row.created_at,
        resolved_at=row.resolved_at,
        resolved_by=row.resolved_by,
        resolution_note=row.resolution_note,
    )


# ── Submit a new request ─────────────────────────────────────────────


@public_router.post(
    "",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def submit_access_request(
    body: AccessRequestCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Any authenticated user can ask for access.

    Validates the target exists, the role is bindable in the target
    scope, and there isn't already a pending request from this user
    for the same target+role pair (we surface the existing one
    instead of creating a duplicate).
    """
    if body.target_type != "workspace":
        raise HTTPException(
            status_code=400,
            detail="Only target_type='workspace' is supported",
        )

    # Target workspace must exist (and not be soft-deleted).
    ws_row = await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == body.target_id,
            WorkspaceORM.deleted_at.is_(None),
        )
    )
    if ws_row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Role must exist + be bindable in this workspace.
    role_def = await role_repo.get_role(session, body.requested_role)
    if role_def is None:
        raise HTTPException(
            status_code=400,
            detail=f"Role '{body.requested_role}' does not exist",
        )
    if not await role_repo.role_is_bindable_in_scope(
        session,
        role_name=body.requested_role,
        binding_scope_type="workspace",
        binding_scope_id=body.target_id,
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Role '{body.requested_role}' cannot be bound in this workspace."
            ),
        )

    # Short-circuit duplicates so the user gets a stable single row
    # rather than a stack of identical asks the admin has to triage.
    existing = await access_request_repo.find_pending_for(
        session,
        requester_id=user.id,
        target_type=body.target_type,
        target_id=body.target_id,
        requested_role=body.requested_role,
    )
    if existing is not None:
        return await _to_response(session, existing)

    row = await access_request_repo.create(
        session,
        requester_id=user.id,
        target_type=body.target_type,
        target_id=body.target_id,
        requested_role=body.requested_role,
        justification=body.justification,
    )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.created",
        payload={
            "request_id": row.id,
            "requester_id": user.id,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "requested_role": row.requested_role,
        },
    )
    return await _to_response(session, row)


# ── Self-service: my requests ────────────────────────────────────────


@me_router.get(
    "/access-requests",
    response_model=list[AccessRequestResponse],
    response_model_by_alias=True,
)
async def list_my_access_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Caller's own queue. Optional ``?status=`` filter for the My
    Access page's "pending only" toggle."""
    try:
        rows = await access_request_repo.list_for_requester(
            session, requester_id=user.id, status=status_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [await _to_response(session, r) for r in rows]


# ── Admin inbox: requests against a workspace ───────────────────────


@admin_ws_router.get(
    "",
    response_model=list[AccessRequestResponse],
    response_model_by_alias=True,
)
async def list_workspace_access_requests(
    ws_id: str,
    status_filter: str | None = Query(default="pending", alias="status"),
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Admin inbox for one workspace. Defaults to pending-only so the
    workflow lands on the actionable queue."""
    try:
        rows = await access_request_repo.list_for_target(
            session,
            target_type="workspace",
            target_id=ws_id,
            status=status_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [await _to_response(session, r) for r in rows]


# ── Resolve (approve / deny) ────────────────────────────────────────


async def _load_pending_for_admin(
    session: AsyncSession, request_id: str, admin: User
) -> AccessRequestORM:
    """Load the request and confirm the caller is allowed to resolve it.

    Authorization is keyed off the *target* — only an admin of the
    request's target workspace may approve or deny. Implemented in a
    helper rather than as a FastAPI dep because the workspace id we
    need to gate against is in the row, not the URL. Permission
    claims are resolved from the DB rather than the JWT so a freshly
    granted workspace:admin role takes effect immediately.
    """
    from backend.app.services.permission_service import has_permission, resolve

    row = await access_request_repo.get(session, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Access request not found")
    if row.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Access request already {row.status}",
        )
    if row.target_type != "workspace":
        raise HTTPException(
            status_code=400,
            detail="Only workspace requests are resolvable",
        )
    claims = await resolve(session, admin.id)
    if not has_permission(claims, "workspace:admin", workspace_id=row.target_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="workspace:admin required",
        )
    return row


@admin_router.post(
    "/{request_id}/approve",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def approve_access_request(
    request_id: str = Path(...),
    body: AccessRequestResolve | None = None,
    admin: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Atomically approve a request and create the role binding.

    Idempotent at the binding level: if an equivalent binding already
    exists (e.g. the admin granted access manually before approving),
    we still flip the request to ``approved`` and skip the duplicate
    create. The user gets the access either way.
    """
    row = await _load_pending_for_admin(session, request_id, admin)

    # Validate the role is still bindable — by the time the admin
    # acts, the role might have been deleted or its scope changed.
    role_def = await role_repo.get_role(session, row.requested_role)
    if role_def is None:
        raise HTTPException(
            status_code=400,
            detail=f"Role '{row.requested_role}' no longer exists.",
        )
    if not await role_repo.role_is_bindable_in_scope(
        session,
        role_name=row.requested_role,
        binding_scope_type="workspace",
        binding_scope_id=row.target_id,
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Role '{row.requested_role}' is no longer bindable in this workspace."
            ),
        )

    existing = await binding_repo.find_binding(
        session,
        subject_type="user",
        subject_id=row.requester_id,
        role_name=row.requested_role,
        scope_type="workspace",
        scope_id=row.target_id,
    )
    if existing is None:
        try:
            await binding_repo.create_binding(
                session,
                subject_type="user",
                subject_id=row.requester_id,
                role_name=row.requested_role,
                scope_type="workspace",
                scope_id=row.target_id,
                granted_by=admin.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    note = body.note if body is not None else None
    try:
        resolved = await access_request_repo.resolve(
            session,
            request_id=request_id,
            new_status="approved",
            resolver_id=admin.id,
            note=note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    assert resolved is not None  # we just loaded it

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.approved",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "actor_id": admin.id,
        },
    )
    logger.info(
        "Access request %s approved by %s (workspace=%s, role=%s)",
        resolved.id, admin.id, resolved.target_id, resolved.requested_role,
    )
    return await _to_response(session, resolved)


@admin_router.post(
    "/{request_id}/deny",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def deny_access_request(
    request_id: str = Path(...),
    body: AccessRequestResolve | None = None,
    admin: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Deny a request with an optional resolution note.

    No binding is created. The row stays ``denied`` so the user sees
    the outcome (and the admin's note) on their My Access page.
    """
    await _load_pending_for_admin(session, request_id, admin)

    note = body.note if body is not None else None
    try:
        resolved = await access_request_repo.resolve(
            session,
            request_id=request_id,
            new_status="denied",
            resolver_id=admin.id,
            note=note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    assert resolved is not None

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.denied",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "actor_id": admin.id,
            "note": resolved.resolution_note,
        },
    )
    logger.info(
        "Access request %s denied by %s (workspace=%s, role=%s)",
        resolved.id, admin.id, resolved.target_id, resolved.requested_role,
    )
    return await _to_response(session, resolved)
