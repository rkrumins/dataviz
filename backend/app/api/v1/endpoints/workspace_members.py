"""Workspace membership endpoints (RBAC Phase 2).

Mounted at ``/api/v1/admin/workspaces/{ws_id}/members`` for the admin
flow. Workspace admins use the same path; the ``workspace:admin``
permission gates write operations, so a user bound as Admin in the
workspace can manage members without holding global ``system:admin``.

  GET    /admin/workspaces/{ws_id}/members              list bindings + roles
  POST   /admin/workspaces/{ws_id}/members              create binding
  DELETE /admin/workspaces/{ws_id}/members/{binding}    revoke binding
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.common.display_name import resolve_display_name
from backend.app.db.models import GroupORM, UserORM, WorkspaceORM
from backend.app.db.repositories import binding_repo, group_repo, role_repo, user_repo
from backend.app.services.permission_service import simulate_for_user
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    ImpactPreviewResponse,
    ImpactPreviewUser,
    WorkspaceAccessGrant,
    WorkspaceAccessResponse,
    WorkspaceAccessUser,
    WorkspaceMemberCreateRequest,
    WorkspaceMemberExpiryUpdateRequest,
    WorkspaceMemberResponse,
    WorkspaceMemberSubject,
)


# Precedence for the single "effective role" badge. Higher wins; a role
# not listed (a custom workspace role) ranks below the built-ins but is
# still carried in ``roles`` and every ``grant`` — the badge is a
# convenience, never the whole picture.
_WS_ROLE_RANK = {
    "workspace_admin": 3,
    "workspace_member": 2,
    "workspace_viewer": 1,
}


def _effective_role(roles: list[str]) -> str:
    """The one role to badge a user with: the highest-precedence built-in
    they hold, else their first role by name. ``roles`` is never empty —
    a user only appears here because at least one route grants them one."""
    return min(roles, key=lambda r: (-_WS_ROLE_RANK.get(r, 0), r))


logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────

async def _hydrate_subject(
    session: AsyncSession, subject_type: str, subject_id: str
) -> WorkspaceMemberSubject:
    """Resolve display fields for the bound subject.

    Best-effort: returns a row with ``display_name=None`` when the
    subject was deleted (the binding is then orphaned and the admin
    needs to revoke it manually).
    """
    if subject_type == "user":
        row = await session.execute(select(UserORM).where(UserORM.id == subject_id))
        user_orm = row.scalar_one_or_none()
        if user_orm is None:
            return WorkspaceMemberSubject(type=subject_type, id=subject_id)
        # The chosen display name wins over the reconstructed halves —
        # rebuilding "first last" here ignored the override column and,
        # for a full-name-only IdP, rendered a raw user id in the UI.
        shown = resolve_display_name(
            user_orm.display_name, user_orm.first_name,
            user_orm.last_name,
        )
        return WorkspaceMemberSubject(
            type="user",
            id=subject_id,
            display_name=shown or user_orm.email or None,
            secondary=user_orm.email,
        )

    row = await session.execute(select(GroupORM).where(GroupORM.id == subject_id))
    group_orm = row.scalar_one_or_none()
    if group_orm is None:
        return WorkspaceMemberSubject(type=subject_type, id=subject_id)
    member_count = await group_repo.count_members(session, group_orm.id)
    return WorkspaceMemberSubject(
        type="group",
        id=subject_id,
        display_name=group_orm.name,
        secondary=f"{member_count} member{'s' if member_count != 1 else ''}",
    )


async def _ensure_workspace_exists(session: AsyncSession, ws_id: str) -> None:
    row = await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == ws_id,
            WorkspaceORM.deleted_at.is_(None),
        )
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Workspace not found")


# ── Routes ───────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=list[WorkspaceMemberResponse],
    response_model_by_alias=True,
)
async def list_members(
    ws_id: str,
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _ensure_workspace_exists(session, ws_id)
    bindings = await binding_repo.list_for_scope(
        session, scope_type="workspace", scope_id=ws_id,
    )
    out: list[WorkspaceMemberResponse] = []
    for b in bindings:
        subject = await _hydrate_subject(session, b.subject_type, b.subject_id)
        out.append(
            WorkspaceMemberResponse(
                binding_id=b.id,
                role=b.role_name,
                granted_at=b.granted_at,
                granted_by=b.granted_by,
                expires_at=b.expires_at,
                subject=subject,
            )
        )
    return out


@router.get(
    "/effective",
    response_model=WorkspaceAccessResponse,
    response_model_by_alias=True,
)
async def list_effective_access(
    ws_id: str,
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
) -> WorkspaceAccessResponse:
    """The flattened, inheritance-aware access list for the workspace.

    ``GET /members`` lists the BINDINGS — a group bound here is one row,
    and to learn who that actually lets in you had to open the group
    elsewhere. This resolves them: every distinct person who can reach
    the workspace, bound directly or a member of any bound group, with a
    grant per route that got them there. A user in three bound groups
    (and perhaps bound directly too) appears ONCE, with a grant per
    route, so "who can actually get in, and how" reads off one list.
    """
    await _ensure_workspace_exists(session, ws_id)
    bindings = await binding_repo.list_for_scope(
        session, scope_type="workspace", scope_id=ws_id,
    )

    # Names for every bound group, in one query, so a grant can say which
    # group it came through.
    group_ids = [b.subject_id for b in bindings if b.subject_type == "group"]
    group_names: dict[str, str] = {}
    if group_ids:
        rows = await session.execute(
            select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(group_ids))
        )
        group_names = {gid: name for gid, name in rows.all()}

    grants_by_user: dict[str, list[WorkspaceAccessGrant]] = {}
    direct_ids: set[str] = set()
    via_group_ids: set[str] = set()

    for b in bindings:
        if b.subject_type == "user":
            grants_by_user.setdefault(b.subject_id, []).append(
                WorkspaceAccessGrant(
                    role=b.role_name, via="direct", binding_id=b.id,
                    expires_at=b.expires_at,
                )
            )
            direct_ids.add(b.subject_id)
        elif b.subject_type == "group":
            gname = group_names.get(b.subject_id)
            members = await group_repo.list_group_members(session, b.subject_id)
            for m in members:
                grants_by_user.setdefault(m.user_id, []).append(
                    WorkspaceAccessGrant(
                        role=b.role_name, via="group", binding_id=b.id,
                        group_id=b.subject_id, group_name=gname,
                        expires_at=b.expires_at,
                    )
                )
                via_group_ids.add(m.user_id)

    # One batched identity lookup for the whole page — names, emails,
    # avatars, and the deleted flag (a deleted account that still holds
    # access is exactly what an admin needs to see and remove).
    identities = await user_repo.get_identities_by_ids(
        session, list(grants_by_user.keys()),
    )

    users: list[WorkspaceAccessUser] = []
    for uid, grants in grants_by_user.items():
        ident = identities.get(uid)
        roles = sorted({g.role for g in grants})
        users.append(
            WorkspaceAccessUser(
                user_id=uid,
                display_name=(ident["name"] or None) if ident else None,
                email=ident["email"] if ident else None,
                avatar_id=ident["avatar_id"] if ident else None,
                status=ident["status"] if ident else None,
                deleted=ident["deleted"] if ident else False,
                roles=roles,
                effective_role=_effective_role(roles),
                # Direct routes first, then by group name, then role —
                # stable and readable in the drawer.
                grants=sorted(
                    grants,
                    key=lambda g: (
                        g.via != "direct", (g.group_name or "").lower(), g.role,
                    ),
                ),
            )
        )

    users.sort(key=lambda u: (u.display_name or u.user_id).lower())

    return WorkspaceAccessResponse(
        users=users,
        total_users=len(users),
        direct_users=len(direct_ids),
        via_group_users=len(via_group_ids),
    )


@router.post(
    "",
    response_model=WorkspaceMemberResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_member_binding(
    ws_id: str,
    body: WorkspaceMemberCreateRequest,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _ensure_workspace_exists(session, ws_id)

    # Subject must exist before we bind it.
    if body.subject_type == "user":
        if await user_repo.get_user_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="User not found")
    elif body.subject_type == "group":
        if await group_repo.get_group_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="Group not found")
    else:
        raise HTTPException(
            status_code=400,
            detail="subjectType must be 'user' or 'group'",
        )

    # Phase 3: validate the role exists AND is bindable in this scope.
    # A workspace-scoped role (scope_type='workspace', scope_id='ws_y')
    # cannot be bound in a different workspace.
    role_def = await role_repo.get_role(session, body.role)
    if role_def is None:
        raise HTTPException(
            status_code=400,
            detail=f"Role '{body.role}' does not exist",
        )
    if not await role_repo.role_is_bindable_in_scope(
        session,
        role_name=body.role,
        binding_scope_type="workspace",
        binding_scope_id=ws_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Role '{body.role}' is scoped to workspace "
                f"'{role_def.scope_id}' and cannot be bound here."
            ),
        )

    existing = await binding_repo.find_binding(
        session,
        subject_type=body.subject_type,
        subject_id=body.subject_id,
        role_name=body.role,
        scope_type="workspace",
        scope_id=ws_id,
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Member already has this role in the workspace",
        )

    try:
        binding = await binding_repo.create_binding(
            session,
            subject_type=body.subject_type,
            subject_id=body.subject_id,
            role_name=body.role,
            scope_type="workspace",
            scope_id=ws_id,
            granted_by=admin.id,
            expires_at=body.expires_at,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # The subject's existing JWT pre-dates this binding, so its
    # ``ws_perms`` doesn't include the workspace yet — ``GET /workspaces``
    # would silently exclude it from their sidebar. Revoke sessions to
    # force a fresh claim resolve on next request. For ``subject_type
    # == 'group'`` the helper fans out across every group member, so
    # every user who inherits this binding loses their stale token.
    revoked = await revoke_subject_sessions(
        body.subject_type, body.subject_id, session=session,
        reason="workspace_binding_added",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_bound",
        payload={
            "workspace_id": ws_id,
            "binding_id": binding.id,
            "subject_type": body.subject_type,
            "subject_id": body.subject_id,
            "role": body.role,
            "actor_id": admin.id,
            "expires_at": body.expires_at,
            "sessions_revoked": revoked,
        },
    )
    subject = await _hydrate_subject(session, body.subject_type, body.subject_id)
    return WorkspaceMemberResponse(
        binding_id=binding.id,
        role=binding.role_name,
        granted_at=binding.granted_at,
        granted_by=binding.granted_by,
        expires_at=binding.expires_at,
        subject=subject,
    )


@router.put(
    "/{binding_id}/expiry",
    response_model=WorkspaceMemberResponse,
    response_model_by_alias=True,
)
async def update_member_expiry(
    ws_id: str,
    binding_id: str,
    body: WorkspaceMemberExpiryUpdateRequest,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Phase 7: extend / change / clear a binding's expiry.

    Used to extend a contractor's access window without re-creating
    the binding (which would lose its ``granted_at`` provenance and
    break audit links). ``expires_at`` / ``expires_in`` both
    accepted; sending neither clears the expiry → permanent.

    Does NOT kill the affected user's session. An expiry extension
    is non-narrowing (the user keeps the access they had); an expiry
    shortening is rare and the JWT TTL is the floor on staleness.
    Callers who want immediate effect should follow up with the
    revoke endpoint instead.
    """
    binding = await binding_repo.get_binding(session, binding_id)
    if binding is None or binding.scope_type != "workspace" or binding.scope_id != ws_id:
        raise HTTPException(
            status_code=404,
            detail="Binding not found in this workspace",
        )

    updated = await binding_repo.update_binding_expiry(
        session, binding_id, expires_at=body.expires_at,
    )
    assert updated is not None  # we just fetched it

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_expiry_updated",
        payload={
            "workspace_id": ws_id,
            "binding_id": binding_id,
            "subject_type": updated.subject_type,
            "subject_id": updated.subject_id,
            "role": updated.role_name,
            "new_expires_at": body.expires_at,
            "actor_id": admin.id,
        },
    )

    subject = await _hydrate_subject(
        session, updated.subject_type, updated.subject_id,
    )
    return WorkspaceMemberResponse(
        binding_id=updated.id,
        role=updated.role_name,
        granted_at=updated.granted_at,
        granted_by=updated.granted_by,
        expires_at=updated.expires_at,
        subject=subject,
    )


@router.delete(
    "/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_member_binding(
    ws_id: str,
    binding_id: str,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    binding = await binding_repo.get_binding(session, binding_id)
    if binding is None or binding.scope_type != "workspace" or binding.scope_id != ws_id:
        raise HTTPException(
            status_code=404,
            detail="Binding not found in this workspace",
        )
    await binding_repo.delete_binding(session, binding_id)

    # Phase 7: kill the affected user's (or every group member's)
    # live sessions so the demotion takes effect immediately rather
    # than waiting up to JWT_EXPIRY_MINUTES for the next refresh.
    # Phase 9: pass ``reason`` so the per-user
    # ``user.session_revoked`` audit events show why.
    revoked_count = await revoke_subject_sessions(
        binding.subject_type, binding.subject_id,
        session=session, reason="workspace_binding_revoked",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_revoked",
        payload={
            "workspace_id": ws_id,
            "binding_id": binding_id,
            "subject_type": binding.subject_type,
            "subject_id": binding.subject_id,
            "role": binding.role_name,
            "actor_id": admin.id,
            "sessions_revoked": revoked_count,
        },
    )
    logger.info(
        "Binding %s revoked from workspace %s by %s (sessions killed: %d)",
        binding_id, ws_id, admin.id, revoked_count,
    )


# ── Impact preview (Phase 4.4) ──────────────────────────────────────


@router.post(
    "/{binding_id}/preview-revoke",
    response_model=ImpactPreviewResponse,
    response_model_by_alias=True,
)
async def preview_revoke_binding(
    ws_id: str,
    binding_id: str,
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
) -> ImpactPreviewResponse:
    """Read-only sibling of ``DELETE /admin/workspaces/{ws_id}/members/{binding_id}``.

    Computes which users would lose what permissions if the named
    binding were revoked. For a user binding, only one user is
    affected; for a group binding, every group member is.
    """
    binding = await binding_repo.get_binding(session, binding_id)
    if binding is None or binding.scope_type != "workspace" or binding.scope_id != ws_id:
        raise HTTPException(
            status_code=404,
            detail="Binding not found in this workspace",
        )

    if binding.subject_type == "user":
        user_ids = [binding.subject_id]
    elif binding.subject_type == "group":
        members = await group_repo.list_group_members(session, binding.subject_id)
        user_ids = [m.user_id for m in members]
    else:
        user_ids = []

    aggregate_gained: set[str] = set()
    aggregate_lost: set[str] = set()
    affected_ws: set[str] = set()
    user_impact: list[ImpactPreviewUser] = []

    for uid in user_ids:
        before_g, before_w = await simulate_for_user(session, uid)
        after_g, after_w = await simulate_for_user(
            session, uid, excluded_binding_id=binding_id,
        )
        # Diff identical to the role-preview helpers.
        gained = (after_g - before_g)
        lost = (before_g - after_g)
        for w in before_w.keys() | after_w.keys():
            gained |= (after_w.get(w, set()) - before_w.get(w, set()))
            lost |= (before_w.get(w, set()) - after_w.get(w, set()))
            if before_w.get(w, set()) != after_w.get(w, set()):
                affected_ws.add(w)
        if not gained and not lost:
            continue
        user_orm = await user_repo.get_user_by_id(session, uid)
        display_name = None
        email = None
        if user_orm is not None:
            full = resolve_display_name(
                getattr(user_orm, "display_name", None),
                user_orm.first_name, user_orm.last_name,
            )
            display_name = full or user_orm.email
            email = user_orm.email
        user_impact.append(
            ImpactPreviewUser(
                user_id=uid,
                display_name=display_name,
                email=email,
                gained=sorted(gained),
                lost=sorted(lost),
            )
        )
        aggregate_gained.update(gained)
        aggregate_lost.update(lost)

    return ImpactPreviewResponse(
        affected_users=len(user_impact),
        affected_workspaces=len(affected_ws),
        gained_perms=sorted(aggregate_gained),
        lost_perms=sorted(aggregate_lost),
        user_impact=user_impact,
    )
