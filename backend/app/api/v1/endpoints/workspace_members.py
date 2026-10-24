"""Workspace membership endpoints (RBAC Phase 2).

Mounted at ``/api/v1/admin/workspaces/{ws_id}/members`` for the admin
flow. Workspace admins use the same path; the ``workspace:admin``
permission gates removing people and changing their access, so a user
bound as Admin in the workspace can manage members without holding
global ``system:admin``. Seeing who is in and adding people needs only
``workspace:members:add`` — the Workspace steward, who adds people one at
a time as Viewer or Member (``workspace_access`` holds the ceilings).

  GET    /admin/workspaces/{ws_id}/members                list bindings + roles
  GET    /admin/workspaces/{ws_id}/members/grant-options  what the caller may grant
  POST   /admin/workspaces/{ws_id}/members                create binding
  PUT    /admin/workspaces/{ws_id}/members/{binding}/expiry  move its end date
  DELETE /admin/workspaces/{ws_id}/members/{binding}      revoke binding

A person hears in their Inbox when they are added, removed, or their end
date moves. People who reach the workspace through a team don't: the team
was bound, not them.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.common.display_name import resolve_display_name
from backend.common.service_accounts import is_service_account
from backend.app.db.models import GroupORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import (
    binding_repo,
    group_repo,
    notification_repo,
    role_repo,
    user_repo,
)
from backend.app.services import workspace_access
from backend.app.services.permission_service import PermissionClaims, simulate_for_user
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    AccessProvenance,
    ImpactPreviewResponse,
    ImpactPreviewUser,
    RequestableRole,
    WorkspaceAccessGrant,
    WorkspaceAccessResponse,
    WorkspaceAccessUser,
    WorkspaceGrantGroup,
    WorkspaceGrantOptions,
    WorkspaceGrantSource,
    WorkspaceIdpRoute,
    WorkspaceMemberCreateRequest,
    WorkspaceMemberExpiryUpdateRequest,
    WorkspaceMemberResponse,
    WorkspaceMemberSubject,
)


# Precedence for the single "effective role" badge. Higher wins; a role
# not listed (a custom workspace role) ranks below the built-ins but is
# still carried in ``roles`` and every ``grant`` — the badge is a
# convenience, never the whole picture. An organization-wide role badges
# what it amounts to here: Super Admin and Org Admin above a workspace
# admin, Org Auditor alongside a viewer.
_WS_ROLE_RANK = {
    "super_admin": 6,
    "org_admin": 5,
    "workspace_admin": 4,
    "workspace_steward": 3,
    "workspace_member": 2,
    "workspace_viewer": 1,
    "org_auditor": 1,
}


def _effective_role(roles: list[str]) -> str:
    """The one role to badge a user with: the highest-precedence built-in
    they hold, else their first role by name. ``roles`` is never empty —
    a user only appears here because at least one route grants them one."""
    return min(roles, key=lambda r: (-_WS_ROLE_RANK.get(r, 0), r))


logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────

async def _hydrate_subjects(
    session: AsyncSession, subjects: list[tuple[str, str]],
) -> dict[tuple[str, str], WorkspaceMemberSubject]:
    """Resolve display fields for bound subjects, keyed by
    ``(subject_type, subject_id)``.

    Three queries for any number of subjects — users, groups, group member
    counts — where resolving them one at a time cost a query or two per
    binding, and a workspace with thousands of members that many.

    Best-effort: a subject that was deleted is absent from the map, and the
    caller renders its binding with ``display_name=None`` (the binding is
    then orphaned and the admin needs to revoke it manually).
    """
    user_ids = [sid for stype, sid in subjects if stype == "user"]
    group_ids = [sid for stype, sid in subjects if stype == "group"]
    out: dict[tuple[str, str], WorkspaceMemberSubject] = {}

    # ``name`` is ``resolve_display_name``: the chosen display name wins over
    # the reconstructed halves — rebuilding "first last" here ignored the
    # override column and, for a full-name-only IdP, rendered a raw user id
    # in the UI. Soft-deleted users are included, as they always were here.
    for uid, ident in (await user_repo.get_identities_by_ids(session, user_ids)).items():
        # A service account's address is a placeholder nobody can write to.
        email = None if is_service_account(uid) else ident["email"]
        out[("user", uid)] = WorkspaceMemberSubject(
            type="user",
            id=uid,
            display_name=ident["name"] or email or None,
            secondary=email,
        )

    if group_ids:
        counts = await group_repo.count_members_batch(session, group_ids)
        rows = await session.execute(
            select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(group_ids))
        )
        for gid, name in rows.all():
            member_count = counts.get(gid, 0)
            out[("group", gid)] = WorkspaceMemberSubject(
                type="group",
                id=gid,
                display_name=name,
                secondary=f"{member_count} member{'s' if member_count != 1 else ''}",
            )
    return out


async def _hydrate_subject(
    session: AsyncSession, subject_type: str, subject_id: str
) -> WorkspaceMemberSubject:
    """Resolve display fields for one bound subject (see :func:`_hydrate_subjects`)."""
    resolved = await _hydrate_subjects(session, [(subject_type, subject_id)])
    return resolved.get((subject_type, subject_id)) or WorkspaceMemberSubject(
        type=subject_type, id=subject_id,
    )


async def _ensure_workspace_exists(session: AsyncSession, ws_id: str) -> WorkspaceORM:
    row = await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == ws_id,
            WorkspaceORM.deleted_at.is_(None),
        )
    )
    ws = row.scalar_one_or_none()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


# ── Routes ───────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=list[WorkspaceMemberResponse],
    response_model_by_alias=True,
)
async def list_members(
    ws_id: str,
    _admin: User = Depends(requires(workspace_access.MEMBERS_ADD, workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _ensure_workspace_exists(session, ws_id)
    bindings = await binding_repo.list_for_scope(
        session, scope_type="workspace", scope_id=ws_id,
    )
    subjects = await _hydrate_subjects(
        session, [(b.subject_type, b.subject_id) for b in bindings],
    )
    out: list[WorkspaceMemberResponse] = []
    for b in bindings:
        subject = subjects.get((b.subject_type, b.subject_id)) or WorkspaceMemberSubject(
            type=b.subject_type, id=b.subject_id,
        )
        out.append(
            WorkspaceMemberResponse(
                binding_id=b.id,
                role=b.role_name,
                granted_at=b.granted_at,
                granted_by=b.granted_by,
                expires_at=b.expires_at,
                subject=subject,
                idp_exception=bool(b.idp_exception),
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
    _admin: User = Depends(requires(workspace_access.MEMBERS_ADD, workspace="ws_id")),
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

    People who reach every workspace through an organization-wide role
    are listed too (``via="org"``), and every grant says how it came
    about (``provenance``): added directly, an approved request, an
    exception, the identity provider's groups, a team, or that role.
    """
    await _ensure_workspace_exists(session, ws_id)
    bindings = await binding_repo.list_for_scope(
        session, scope_type="workspace", scope_id=ws_id,
    )

    # Every bound group, in one query, so a grant can say which group it
    # came through and whether the identity provider fills it.
    group_ids = [b.subject_id for b in bindings if b.subject_type == "group"]
    groups: dict[str, GroupORM] = {}
    if group_ids:
        rows = await session.execute(select(GroupORM).where(GroupORM.id.in_(group_ids)))
        groups = {g.id: g for g in rows.scalars().all()}

    # (user, binding, via, group, membership) for every route in.
    routes: list[tuple] = []
    for b in bindings:
        if b.subject_type == "user":
            routes.append((b.subject_id, b, "direct", None, None))
        elif b.subject_type == "group":
            for m in await group_repo.list_group_members(session, b.subject_id):
                routes.append((m.user_id, b, "group", groups.get(b.subject_id), m))
    routes += [
        (uid, b, "org", group, m)
        for uid, b, group, m in await workspace_access.org_wide_grants(session)
    ]
    reader = await workspace_access.provenance_reader(session, [r[0] for r in routes])

    grants_by_user: dict[str, list[WorkspaceAccessGrant]] = {}
    ids_by_via: dict[str, set[str]] = {"direct": set(), "group": set(), "org": set()}
    for uid, b, via, group, m in routes:
        if via == "direct":
            how = reader.binding(b, uid)
        elif via == "group":
            how = reader.membership(m, group, uid)
        else:
            how = reader.org_role(b, uid, m, group)
        grants_by_user.setdefault(uid, []).append(
            WorkspaceAccessGrant(
                role=b.role_name, via=via, binding_id=b.id,
                group_id=b.subject_id if b.subject_type == "group" else None,
                group_name=group.name if group else None,
                expires_at=b.expires_at,
                provenance=AccessProvenance(**how),
            )
        )
        ids_by_via[via].add(uid)

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
                email=ident["email"] if ident and not is_service_account(uid) else None,
                avatar_id=ident["avatar_id"] if ident else None,
                status=ident["status"] if ident else None,
                deleted=ident["deleted"] if ident else False,
                roles=roles,
                effective_role=_effective_role(roles),
                # Direct routes first, then through groups, then
                # organization-wide; by group name, then role — stable
                # and readable in the drawer.
                grants=sorted(
                    grants,
                    key=lambda g: (
                        ("direct", "group", "org").index(g.via),
                        (g.group_name or "").lower(), g.role,
                    ),
                ),
            )
        )

    users.sort(key=lambda u: (u.display_name or u.user_id).lower())

    return WorkspaceAccessResponse(
        users=users,
        total_users=len(users),
        direct_users=len(ids_by_via["direct"]),
        via_group_users=len(ids_by_via["group"]),
        org_wide_users=len(ids_by_via["org"]),
    )


@router.get(
    "/grant-options",
    response_model=WorkspaceGrantOptions,
    response_model_by_alias=True,
)
async def get_grant_options(
    ws_id: str,
    _user: User = Depends(requires(workspace_access.MEMBERS_ADD, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> WorkspaceGrantOptions:
    """What the caller may hand out here: the roles, teams and
    identity-provider groups already narrowed to what they could grant
    themselves — and the data sources any of them reads, restricted ones
    marked, so whoever lets someone in sees what they open. Backs Add
    member and answering an access request."""
    ws = await _ensure_workspace_exists(session, ws_id)
    sources = (await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == ws_id, WorkspaceDataSourceORM.deleted_at.is_(None))
        .order_by(WorkspaceDataSourceORM.label)
    )).scalars().all()
    roles = [
        RequestableRole(name=r.name, description=r.description, is_system=r.is_system)
        for r, perms in await workspace_access.workspace_roles(session, ws_id)
        if workspace_access.can_grant(claims, ws_id, r.name, perms)
    ]
    routes = await workspace_access.idp_routes(session, ws_id)
    route_perms = await role_repo.role_names_with_permissions(
        session, sorted({r["role"] for r in routes}),
    )
    return WorkspaceGrantOptions(
        tier=workspace_access.tier(claims, ws_id),
        access_mode=ws.access_mode or "app",
        roles=roles,
        groups=[
            WorkspaceGrantGroup(**g)
            for g in await workspace_access.addable_groups(session, claims, ws_id)
        ],
        idp_routes=[
            WorkspaceIdpRoute(**r) for r in routes
            if workspace_access.can_grant(claims, ws_id, r["role"], route_perms.get(r["role"], []))
        ],
        data_sources=[
            WorkspaceGrantSource(id=d.id, label=d.label, restricted=bool(d.is_restricted)) for d in sources
        ],
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
    admin: User = Depends(requires(workspace_access.MEMBERS_ADD, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Grant a person or a group a role here. A steward adds people, not
    groups, as Viewer or Member; an admin grants any role whose permissions
    they hold. A lapsed grant of the same role is made current again.

    For a workspace whose access its identity provider decides, adding a
    person needs ``exception: true``, and the grant is marked as one.
    """
    ws = await _ensure_workspace_exists(session, ws_id)
    if body.subject_type == "group" and workspace_access.tier(claims, ws_id) != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Stewards add people one at a time; binding a group is for workspace admins",
        )

    # Subject must exist before we bind it.
    if body.subject_type == "user":
        if await user_repo.get_user_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="User not found")
        if is_service_account(body.subject_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A service account's roles are given on its own page, under Service accounts",
            )
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

    perms = (await role_repo.role_names_with_permissions(session, [body.role])).get(body.role, [])
    if not workspace_access.can_grant(claims, ws_id, body.role, perms):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=workspace_access.ceiling_refusal(claims, ws_id, body.role),
        )
    exception = (ws.access_mode or "app") == "idp" and body.subject_type == "user"
    if exception and not body.exception:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "type": "idp_managed",
                "message": (
                    "Its identity provider decides who is in this workspace. Add the person to "
                    "the provider's group, or confirm adding them here as an exception."
                ),
            },
        )
    if exception:
        refusal = workspace_access.exception_refusal(claims, ws_id, body.expires_at)
        if refusal:
            raise HTTPException(status_code=refusal[0], detail=refusal[1])

    try:
        binding, outcome = await workspace_access.grant_role(
            session,
            subject_type=body.subject_type,
            subject_id=body.subject_id,
            role=body.role,
            ws_id=ws_id,
            granted_by=admin.id,
            expires_at=body.expires_at,
            idp_exception=exception,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if outcome == "existing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Member already has this role in the workspace",
        )

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
            "idp_exception": exception,
            "reactivated": outcome == "reactivated",
        },
    )
    if body.subject_type == "user":
        until = f" until {binding.expires_at[:10]}" if binding.expires_at else ""
        await notification_repo.notify(
            session,
            user_ids=[body.subject_id],
            kind="workspace.member_added",
            title=f"You were added to {ws.name}",
            body=f"As {workspace_access.role_label(body.role)}{until}." + (
                " Granted as an exception: its identity provider otherwise decides who is in."
                if exception else ""
            ),
            link=f"/workspaces/{ws_id}",
            actor_id=admin.id,
            resource_type="workspace",
            resource_id=ws_id,
        )
    subject = await _hydrate_subject(session, body.subject_type, body.subject_id)
    return WorkspaceMemberResponse(
        binding_id=binding.id,
        role=binding.role_name,
        granted_at=binding.granted_at,
        granted_by=binding.granted_by,
        expires_at=binding.expires_at,
        subject=subject,
        idp_exception=bool(binding.idp_exception),
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
    claims: PermissionClaims = Depends(get_permission_claims),
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

    The person hears about it, is reminded again before the new end, and a
    request they made to keep the access reads as answered. An exception to
    the identity provider is confirmed as one again (``exception``) and keeps
    an end, 90 days away at most.
    """
    binding = await binding_repo.get_binding(session, binding_id)
    if binding is None or binding.scope_type != "workspace" or binding.scope_id != ws_id:
        raise HTTPException(
            status_code=404,
            detail="Binding not found in this workspace",
        )
    if binding.idp_exception:
        if not body.exception:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "type": "idp_managed",
                    "message": "This access is an exception to the identity provider. Confirm it stays one.",
                },
            )
        refusal = workspace_access.exception_refusal(claims, ws_id, body.expires_at)
        if refusal:
            raise HTTPException(status_code=refusal[0], detail=refusal[1])

    updated = await binding_repo.update_binding_expiry(
        session, binding_id, expires_at=body.expires_at,
    )
    assert updated is not None  # we just fetched it
    updated.expiry_reminded_at = None
    if updated.subject_type == "user":
        ends = f"now ends on {updated.expires_at[:10]}" if updated.expires_at else "no longer ends"
        await workspace_access.settle_extension_requests(
            session, binding_id=binding_id, resolver_id=admin.id,
            note=f"A workspace admin changed it: your access {ends}.",
            expires_at=updated.expires_at,
        )
        ws = await session.get(WorkspaceORM, ws_id)
        await notification_repo.notify(
            session,
            user_ids=[updated.subject_id],
            kind="workspace.access_end_changed",
            title=f"Your access to {ws.name if ws else 'a workspace'} {ends}",
            body=f"Your {workspace_access.role_label(updated.role_name)} access was changed by a workspace admin.",
            link=f"/workspaces/{ws_id}",
            actor_id=admin.id,
            resource_type="role_binding",
            resource_id=binding_id,
        )

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
        idp_exception=bool(updated.idp_exception),
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
    if binding.subject_type == "user":
        ws = await session.get(WorkspaceORM, ws_id)
        if ws is not None:
            await workspace_access.notify_removed(session, ws, binding, actor_id=admin.id)

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
