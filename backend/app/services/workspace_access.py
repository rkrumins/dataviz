"""Who may let whom into a workspace.

Joining a workspace is decided here, for every path that does it — answering
an access request, the Members tab, the reconciler that closes a request once
the identity provider grants it:

* **Ceilings.** A workspace admin (Org Admin and Super Admin through their
  shortcuts) may grant any workspace role whose permissions they hold
  themselves. Someone who may only add people (``workspace:members:add`` —
  the Workspace steward) grants Viewer or Member, nothing more.
* **What may be asked for.** Workspace roles that don't administer the
  workspace or let people in: asking is for access, not for authority.
* **Teams.** Adding someone to an app-managed group bound in the workspace is
  granting everything that group carries, everywhere it is bound — so a team
  qualifies only if every one of its bindings is one the approver could make.
* **The identity provider.** A workspace whose access its IdP decides is
  reached through the IdP groups its mappings route into it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AccessRequestORM,
    GroupMemberORM,
    GroupORM,
    IdpGroupRoleMappingORM,
    IdpProviderORM,
    RoleBindingORM,
    RoleORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    binding_repo,
    group_repo,
    notification_repo,
    role_repo,
    user_repo,
)
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services.permission_service import PermissionClaims, has_permission

logger = logging.getLogger(__name__)

MEMBERS_ADD = "workspace:members:add"
#: All a steward may grant: the people who know a team let colleagues in,
#: they don't make administrators.
STEWARD_GRANTABLE_ROLES = frozenset({"workspace_viewer", "workspace_member"})
#: Platform roles reach every workspace without a binding in any.
ORG_WIDE_PERMISSIONS = ("system:admin", "system:org-admin", "system:org-viewer")
#: The order requestable roles are offered in; custom roles follow by name.
_ROLE_ORDER = ("workspace_viewer", "workspace_member", "workspace_data_engineer")
#: How the built-in workspace roles read in a sentence (the Inbox).
_ROLE_LABELS = {
    "workspace_viewer": "Viewer",
    "workspace_member": "Member",
    "workspace_data_engineer": "Data engineer",
    "workspace_steward": "Steward",
    "workspace_admin": "Admin",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def role_label(role_name: str) -> str:
    return _ROLE_LABELS.get(role_name, role_name)


def is_org_wide(claims: PermissionClaims) -> bool:
    """Answers requests in every workspace: Super Admin and Org Admin."""
    return any(p in claims.global_perms for p in ("system:admin", "system:org-admin"))


def can_open(claims: PermissionClaims, ws_id: str) -> bool:
    """Any grant in the workspace, or a platform role that reaches every
    workspace — the rule the workspace list reads by."""
    return any(p in claims.global_perms for p in ORG_WIDE_PERMISSIONS) or bool(claims.ws_perms.get(ws_id))


def tier(claims: PermissionClaims, ws_id: str) -> Optional[str]:
    """``'admin'``, ``'steward'``, or ``None`` when they may not let anyone in."""
    if has_permission(claims, "workspace:admin", workspace_id=ws_id):
        return "admin"
    if has_permission(claims, MEMBERS_ADD, workspace_id=ws_id):
        return "steward"
    return None


def can_grant(claims: PermissionClaims, ws_id: str, role_name: str, perms: Iterable[str]) -> bool:
    """Whether the caller may grant ``role_name`` in the workspace. Only its
    workspace permissions count: a binding in a workspace confers no other."""
    level = tier(claims, ws_id)
    if level == "admin":
        return all(
            has_permission(claims, p, workspace_id=ws_id) for p in perms if p.startswith("workspace:")
        )
    if level == "steward":
        return role_name in STEWARD_GRANTABLE_ROLES
    return False


def ceiling_refusal(claims: PermissionClaims, ws_id: str, role_name: str) -> str:
    """Why :func:`can_grant` said no, in a sentence for the person refused."""
    if tier(claims, ws_id) == "steward":
        return "Stewards can grant Viewer or Member; ask a workspace admin for anything more"
    return f"You can only grant roles whose permissions you hold yourself — not '{role_name}'"


def is_requestable(perms: Iterable[str]) -> bool:
    perms = set(perms)
    return "workspace:admin" not in perms and MEMBERS_ADD not in perms


def answerable_workspace_ids(claims: PermissionClaims) -> Optional[list[str]]:
    """Workspaces whose requests the caller answers; ``None`` means all."""
    if is_org_wide(claims):
        return None
    return [ws for ws in claims.ws_perms if has_permission(claims, MEMBERS_ADD, workspace_id=ws)]


async def workspace_roles(session: AsyncSession, ws_id: str) -> list[tuple[RoleORM, list[str]]]:
    """Roles that can be bound in the workspace and are about it: at least
    one workspace permission, no platform one. Viewer, Member and Data
    engineer first, then the rest by name."""
    roles = await role_repo.list_roles(session, scope_type="workspace", scope_id=ws_id)
    perms = await role_repo.role_names_with_permissions(session, [r.name for r in roles])
    kept = [
        (r, perms.get(r.name, [])) for r in roles
        if any(p.startswith("workspace:") for p in perms.get(r.name, []))
        and not any(p.startswith("system:") for p in perms.get(r.name, []))
    ]
    rank = {name: i for i, name in enumerate(_ROLE_ORDER)}
    return sorted(kept, key=lambda rp: (rank.get(rp[0].name, len(rank)), rp[0].name))


async def addable_groups(
    session: AsyncSession, claims: PermissionClaims, ws_id: str,
) -> list[dict]:
    """App-managed teams bound in the workspace that the caller may add
    someone to: not protected, not filled by the identity provider, and
    every binding they carry — in any workspace — one the caller could
    make there. A group bound globally never qualifies."""
    bound = [
        b for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id)
        if b.subject_type == "group"
    ]
    group_ids = sorted({b.subject_id for b in bound})
    if not group_ids:
        return []
    groups = (await session.execute(
        select(GroupORM).where(
            GroupORM.id.in_(group_ids),
            GroupORM.deleted_at.is_(None),
            GroupORM.source == "local",
            GroupORM.is_protected.is_(False),
        )
    )).scalars().all()
    if not groups:
        return []
    carried = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_type == "group",
            RoleBindingORM.subject_id.in_([g.id for g in groups]),
        )
    )).scalars().all()
    perms = await role_repo.role_names_with_permissions(
        session, sorted({b.role_name for b in carried}),
    )
    counts = await group_repo.count_members_batch(session, [g.id for g in groups])
    out = []
    for group in sorted(groups, key=lambda g: g.name.lower()):
        mine = [b for b in carried if b.subject_id == group.id]
        if all(
            b.scope_type == "workspace"
            and can_grant(claims, b.scope_id, b.role_name, perms.get(b.role_name, []))
            for b in mine
        ):
            out.append({
                "id": group.id,
                "name": group.name,
                "member_count": counts.get(group.id, 0),
                "roles": sorted({b.role_name for b in mine if b.scope_id == ws_id}),
            })
    return out


async def grant_role(
    session: AsyncSession,
    *,
    subject_type: str,
    subject_id: str,
    role: str,
    ws_id: str,
    granted_by: str,
    expires_at: Optional[str] = None,
    request_id: Optional[str] = None,
    idp_exception: bool = False,
) -> tuple[RoleBindingORM, str]:
    """Grant ``role`` in the workspace. Returns the binding and
    ``'created'``, ``'reactivated'`` (a lapsed grant, made current and the
    app's own), or ``'existing'`` (they already hold it; left untouched)."""
    existing = await binding_repo.find_binding(
        session, subject_type=subject_type, subject_id=subject_id, role_name=role,
        scope_type="workspace", scope_id=ws_id,
    )
    if existing is None:
        binding = await binding_repo.create_binding(
            session, subject_type=subject_type, subject_id=subject_id, role_name=role,
            scope_type="workspace", scope_id=ws_id, granted_by=granted_by,
            expires_at=expires_at, access_request_id=request_id, idp_exception=idp_exception,
        )
        return binding, "created"
    if _is_expired(existing.expires_at, now=_now()):
        existing.expires_at = expires_at
        existing.granted_by = granted_by
        existing.granted_at = _now().isoformat()
        existing.source = "local"
        existing.access_request_id = request_id
        existing.idp_exception = idp_exception
        await session.flush()
        return existing, "reactivated"
    return existing, "existing"


async def audience(session: AsyncSession, ws_ids: Iterable[str]) -> dict[str, tuple[set[str], set[str]]]:
    """``{workspace: (people, approvers)}``: who holds a current grant in
    each workspace — directly or through a group — and which of them may
    let people in."""
    ids = list(dict.fromkeys(ws_ids))
    out: dict[str, tuple[set[str], set[str]]] = {ws: (set(), set()) for ws in ids}
    if not ids:
        return out
    now = _now()
    bindings = [
        b for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.scope_type == "workspace", RoleBindingORM.scope_id.in_(ids),
            )
        )).scalars().all()
        if not _is_expired(b.expires_at, now=now)
    ]
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in bindings}))
    group_ids = sorted({b.subject_id for b in bindings if b.subject_type == "group"})
    members: dict[str, set[str]] = {}
    if group_ids:
        rows = (await session.execute(
            select(GroupMemberORM.group_id, GroupMemberORM.user_id)
            .join(GroupORM, GroupORM.id == GroupMemberORM.group_id)
            .where(GroupMemberORM.group_id.in_(group_ids), GroupORM.deleted_at.is_(None))
        )).all()
        for gid, uid in rows:
            members.setdefault(gid, set()).add(uid)
    for b in bindings:
        people, approvers = out[b.scope_id]
        users = {b.subject_id} if b.subject_type == "user" else members.get(b.subject_id, set())
        people |= users
        if {"workspace:admin", MEMBERS_ADD} & set(perms.get(b.role_name, [])):
            approvers |= users
    return out


async def roles_held(session: AsyncSession, user_id: str, ws_ids: Iterable[str]) -> dict[str, set[str]]:
    """The roles a person holds now in each of ``ws_ids``, by any route."""
    wanted = set(ws_ids)
    group_ids = await group_repo.get_user_groups(session, user_id)
    out: dict[str, set[str]] = {}
    for b in await binding_repo.list_for_user_with_groups(session, user_id=user_id, group_ids=group_ids):
        if b.scope_type == "workspace" and b.scope_id in wanted:
            out.setdefault(b.scope_id, set()).add(b.role_name)
    return out


async def provider_names(session: AsyncSession) -> dict[str, str]:
    rows = (await session.execute(select(IdpProviderORM.id, IdpProviderORM.display_name))).all()
    return {pid: name for pid, name in rows}


async def idp_routes(session: AsyncSession, ws_id: str) -> list[dict]:
    """IdP groups whose members reach the workspace: mappings that bind a
    role in it, and mappings that fill a group bound in it."""
    bound_groups: dict[str, list[str]] = {}
    for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id):
        if b.subject_type == "group":
            bound_groups.setdefault(b.subject_id, []).append(b.role_name)
    mappings = (await session.execute(select(IdpGroupRoleMappingORM))).scalars().all()
    providers = await provider_names(session)
    group_names = {}
    if bound_groups:
        group_names = dict((await session.execute(
            select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(list(bound_groups)))
        )).all())
    routes = []
    for m in mappings:
        provider = providers.get(m.provider_id) if m.provider_id else None
        if m.target_type == "role_binding" and m.scope_type == "workspace" and m.scope_id == ws_id:
            routes.append({"idp_group": m.idp_group, "provider": provider, "role": m.role_name})
        elif m.target_type == "group_membership" and m.target_group_id in bound_groups:
            for role in sorted(bound_groups[m.target_group_id]):
                routes.append({
                    "idp_group": m.idp_group, "provider": provider, "role": role,
                    "via_group_id": m.target_group_id,
                    "via_group_name": group_names.get(m.target_group_id),
                })
    return sorted(routes, key=lambda r: (r["idp_group"].lower(), r.get("role") or ""))


async def fulfil_idp_routed_requests(session: AsyncSession, *, user_id: str) -> int:
    """Close the person's requests that wait on their identity provider in
    workspaces it now grants them — called by the SSO reconciler, the
    moment that access arrives. Returns how many it closed."""
    waiting = (await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.requester_id == user_id,
            AccessRequestORM.status == "awaiting_idp",
        )
    )).scalars().all()
    if not waiting:
        return 0
    ws_ids = sorted({r.target_id for r in waiting})
    now = _now()
    sso_groups = list((await session.execute(
        select(GroupMemberORM.group_id).where(
            GroupMemberORM.user_id == user_id, GroupMemberORM.source == "sso",
        )
    )).scalars().all())
    candidates = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id.in_(ws_ids),
        )
    )).scalars().all()
    reached = {
        b.scope_id for b in candidates
        if not _is_expired(b.expires_at, now=now) and (
            (b.subject_type == "user" and b.subject_id == user_id and b.source == "sso")
            or (b.subject_type == "group" and b.subject_id in sso_groups)
        )
    }
    names = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(ws_ids))
    )).all())
    closed = 0
    for row in waiting:
        if row.target_id not in reached:
            continue
        row.status = "approved"
        row.fulfilled_at = now.isoformat()
        closed += 1
        name = names.get(row.target_id) or "the workspace"
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.access_request.fulfilled",
            payload={
                "request_id": row.id,
                "requester_id": row.requester_id,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "workspace_id": row.target_id,
                "idp_group": row.idp_group,
            },
        )
        await notification_repo.notify(
            session,
            user_ids=[row.requester_id],
            kind="access_request.fulfilled",
            title=f"You can now open {name}",
            body=f'Your access arrived through "{row.idp_group}".',
            link=f"/workspaces/{row.target_id}",
            resource_type="access_request",
            resource_id=row.id,
        )
        if row.resolved_by and row.resolved_by != row.requester_id:
            await notification_repo.notify(
                session,
                user_ids=[row.resolved_by],
                kind="access_request.fulfilled",
                title=f"Access to {name} arrived",
                body=f'The person you pointed to "{row.idp_group}" can now open it.',
                link="/workspaces?tab=requests",
                resource_type="access_request",
                resource_id=row.id,
            )
    if closed:
        await session.flush()
    return closed
