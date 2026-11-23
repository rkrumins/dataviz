"""A workspace's own groups.

Groups are platform-wide — one group can be bound in many workspaces — and the
platform's group list is ``system:groups:manage``'s. A group a workspace *owns*
(``groups.workspace_id``) is managed from that workspace instead, by its admins
(``workspace:admin`` there, which Org and Super Admins hold everywhere): its name, its
role here, who is in it, and its link to an identity-provider group. Its name always
carries the workspace's, ``"<workspace> · <name>"``, since group names are unique
across the platform. Groups an approved workspace request makes are the workspace's.

Anyone who sees the workspace's members (``workspace:members:add``) sees every group
bound in it, owned or not; only owned ones are changed here (403 ``not_owned``).

What a group's members may do is everything its bindings carry, wherever they are.
So who is in an owned group is changed here only while every binding it carries is
one the caller could make (403 ``reaches_beyond_workspace`` — a platform
administrator bound it elsewhere, say), and never for a group that manages a service
account (409 ``manages_service_accounts``: its members act as the account; the
Groups admin page handles that). People the identity provider put in a group
(``source='sso'``) leave it through the identity provider (409 ``managed_by_idp``).

Linking a group to an identity-provider group is a platform administrator's call;
anyone else's asks for it (``backend.app.services.idp_links``).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GroupMemberORM, GroupORM, IdpGroupRoleMappingORM, RoleBindingORM, WorkspaceORM
from backend.app.db.repositories import (
    binding_repo,
    grant_repo,
    group_repo,
    idp_group_mapping_repo,
    idp_link_request_repo,
    notification_repo,
    role_repo,
    service_account_repo,
    user_repo,
)
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services import idp_links, workspace_access
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    WorkspaceGroupCreate,
    WorkspaceGroupIdpLink,
    WorkspaceGroupMember,
    WorkspaceGroupPendingLink,
    WorkspaceGroupResponse,
    WorkspaceGroupUpdate,
    WorkspaceRequestPerson,
)
from backend.common.service_accounts import is_service_account

SHORT_NAME_MAX = 80
_PREVIEW = 5
_SEP = " · "


def _refuse(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


def full_name(ws_name: str, short: str) -> str:
    return f"{ws_name.strip()}{_SEP}{short.strip()}"


def short_name(name: str, ws_name: str) -> str:
    """The name without its workspace's prefix, when it has it."""
    prefix = f"{ws_name.strip()}{_SEP}"
    return name[len(prefix):] if name.startswith(prefix) and len(name) > len(prefix) else name


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(text: Optional[str]) -> Optional[str]:
    return (text.strip() if text else None) or None


def _short(raw: Optional[str]) -> str:
    short = (raw or "").strip()
    if not 1 <= len(short) <= SHORT_NAME_MAX:
        raise HTTPException(status_code=422, detail=f"A group name is 1 to {SHORT_NAME_MAX} characters.")
    return short


async def workspace(session: AsyncSession, ws_id: str) -> WorkspaceORM:
    ws = await session.get(WorkspaceORM, ws_id)
    if ws is None or ws.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


async def _bindings(session: AsyncSession, ws_id: str, group_ids: Optional[list[str]] = None,
                    *, include_expired: bool = False) -> dict[str, list[RoleBindingORM]]:
    """``{group: its bindings in the workspace}``, current ones unless asked."""
    stmt = select(RoleBindingORM).where(
        RoleBindingORM.subject_type == "group", RoleBindingORM.scope_type == "workspace",
        RoleBindingORM.scope_id == ws_id,
    )
    if group_ids is not None:
        stmt = stmt.where(RoleBindingORM.subject_id.in_(group_ids))
    out: dict[str, list[RoleBindingORM]] = {}
    now = _now()
    for b in (await session.execute(stmt)).scalars().all():
        if include_expired or not _is_expired(b.expires_at, now=now):
            out.setdefault(b.subject_id, []).append(b)
    return out


def _role(bindings: list[RoleBindingORM]) -> Optional[str]:
    """The role a group holds here — its latest grant, should it have two."""
    return max(bindings, key=lambda b: (b.granted_at or "", b.role_name)).role_name if bindings else None


async def _groups_here(session: AsyncSession, ws_id: str, group_ids: Optional[list[str]] = None) -> list[GroupORM]:
    """Live groups bound in the workspace, or owned by it."""
    bound = await _bindings(session, ws_id, group_ids)
    clause = GroupORM.workspace_id == ws_id
    if bound:
        clause = clause | GroupORM.id.in_(list(bound))
    stmt = select(GroupORM).where(clause, GroupORM.deleted_at.is_(None))
    if group_ids is not None:
        stmt = stmt.where(GroupORM.id.in_(group_ids))
    return sorted((await session.execute(stmt)).scalars().all(), key=lambda g: g.name.lower())


async def _responses(session: AsyncSession, ws: WorkspaceORM, groups: list[GroupORM]) -> list[WorkspaceGroupResponse]:
    """The groups as the API returns them, in a handful of id-correlated queries."""
    if not groups:
        return []
    ids = [g.id for g in groups]
    bound = await _bindings(session, ws.id, ids)
    counts = await group_repo.count_members_batch(session, ids)
    previews = await group_repo.member_preview_batch(session, ids, per_group=_PREVIEW)
    mappings = (await session.execute(
        select(IdpGroupRoleMappingORM).where(
            IdpGroupRoleMappingORM.target_type == "group_membership",
            IdpGroupRoleMappingORM.target_group_id.in_(ids),
        ).order_by(IdpGroupRoleMappingORM.idp_group)
    )).scalars().all()
    providers = await workspace_access.provider_names(session) if mappings else {}
    pending = await idp_link_request_repo.pending_for_groups(session, ids)
    askers = await user_repo.get_identities_by_ids(session, sorted({p.requested_by for p in pending.values()}))
    out = []
    for g in groups:
        role = _role(bound.get(g.id, []))
        ask = pending.get(g.id)
        asker = askers.get(ask.requested_by) if ask else None
        out.append(WorkspaceGroupResponse(
            id=g.id, name=g.name, short_name=short_name(g.name, ws.name), description=g.description,
            owned=g.workspace_id == ws.id, role=role, role_label=workspace_access.role_label(role) if role else None,
            member_count=counts.get(g.id, 0),
            member_preview=[WorkspaceRequestPerson(id=p["id"], display_name=p["name"]) for p in previews.get(g.id, [])],
            source=g.source,
            idp_links=[
                WorkspaceGroupIdpLink(mapping_id=m.id, idp_group=m.idp_group, provider_id=m.provider_id,
                                      provider_name=providers.get(m.provider_id) if m.provider_id else None)
                for m in mappings if m.target_group_id == g.id
            ],
            pending_idp_link=WorkspaceGroupPendingLink(
                request_id=ask.id, idp_group=ask.idp_group, requested_by=ask.requested_by,
                requested_by_name=(asker["name"] or asker["email"]) if asker else None, requested_at=ask.requested_at,
            ) if ask else None,
            created_at=g.created_at,
        ))
    return out


async def list_groups(session: AsyncSession, ws_id: str) -> list[WorkspaceGroupResponse]:
    ws = await workspace(session, ws_id)
    return await _responses(session, ws, await _groups_here(session, ws_id))


async def one(session: AsyncSession, ws: WorkspaceORM, group: GroupORM) -> WorkspaceGroupResponse:
    return (await _responses(session, ws, [group]))[0]


async def group_here(session: AsyncSession, ws_id: str, group_id: str) -> GroupORM:
    """A live group bound in the workspace or owned by it, or 404."""
    found = await _groups_here(session, ws_id, [group_id])
    if not found:
        raise HTTPException(status_code=404, detail="Group not found in this workspace")
    return found[0]


async def owned(session: AsyncSession, ws_id: str, group_id: str) -> GroupORM:
    """A group the workspace owns — 403 ``not_owned`` for one only bound here."""
    group = await group_here(session, ws_id, group_id)
    if group.workspace_id != ws_id:
        raise _refuse(status.HTTP_403_FORBIDDEN, "not_owned",
                      "This group isn't the workspace's own, so it's managed on the platform's Groups page.")
    return group


async def _free(session: AsyncSession, full: str, short: str, *, except_id: Optional[str] = None) -> None:
    """409 ``group_name_taken`` — with the first free short name — when a group, even
    a deleted one, holds ``full`` (``uq_groups_name``)."""
    taken = set((await session.execute(
        select(GroupORM.name).where(GroupORM.name.like(f"{full}%"), GroupORM.id != (except_id or ""))
    )).scalars().all())
    if full not in taken:
        return
    n = 2
    while f"{full} {n}" in taken:
        n += 1
    raise _refuse(status.HTTP_409_CONFLICT, "group_name_taken", f"There is already a group called {full}.",
                  suggestion=f"{short} {n}")


async def _check_ceiling(session: AsyncSession, claims: PermissionClaims, ws_id: str, role: str) -> None:
    perms = (await role_repo.role_names_with_permissions(session, [role])).get(role, [])
    if not workspace_access.can_grant(claims, ws_id, role, perms):
        raise HTTPException(status_code=403, detail=workspace_access.ceiling_refusal(claims, ws_id, role))


async def _check_membership_change(session: AsyncSession, claims: PermissionClaims, group: GroupORM) -> None:
    """Changing who is in a group grants or takes away everything it carries."""
    if await service_account_repo.accounts_managed_by_team(session, group.id):
        raise _refuse(status.HTTP_409_CONFLICT, "manages_service_accounts",
                      "This group manages service accounts, so whoever is in it can act as them. "
                      "Change it on the platform's Groups page.")
    if has_permission(claims, "system:admin"):
        return
    carried = await binding_repo.list_for_subject(session, subject_type="group", subject_id=group.id)
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in carried}))
    for b in carried:
        if b.scope_type != "workspace" or not workspace_access.can_grant(
            claims, b.scope_id, b.role_name, perms.get(b.role_name, []),
        ):
            raise _refuse(status.HTTP_403_FORBIDDEN, "reaches_beyond_workspace",
                          "This group also carries access you can't grant, so only someone who can "
                          "grant that may change who is in it or delete it.")


async def _active_people(session: AsyncSession, ids: list[str]) -> list[str]:
    """``ids``, deduplicated — or 422 naming any that isn't an active person."""
    ids = list(dict.fromkeys(i for i in ids if i))
    found = await user_repo.get_identities_by_ids(session, ids)
    missing = [
        i for i in ids
        if is_service_account(i) or i not in found or found[i]["status"] != "active" or found[i]["deleted"]
    ]
    if missing:
        raise HTTPException(status_code=422, detail=f"Group members must be people with an active account. "
                                                    f"Not found or not active: {', '.join(missing)}.")
    return ids


async def _bound_event(session: AsyncSession, ws_id: str, group_id: str, binding: RoleBindingORM, outcome: str,
                       actor_id: str, revoked: int) -> None:
    await user_repo.create_outbox_event(
        session, event_type="rbac.workspace.member_bound",
        payload={
            "workspace_id": ws_id, "binding_id": binding.id, "subject_type": "group", "subject_id": group_id,
            "role": binding.role_name, "actor_id": actor_id, "expires_at": None, "sessions_revoked": revoked,
            "idp_exception": False, "reactivated": outcome == "reactivated",
        },
    )


async def _join(session: AsyncSession, ws: WorkspaceORM, group: GroupORM, user_ids: list[str], role: Optional[str],
                actor_id: str) -> None:
    """Put people in the group: their sessions end so their next request carries it,
    it is recorded, and they hear of it."""
    for uid in user_ids:
        await group_repo.add_member(session, group.id, uid, added_by=actor_id)
        revoked = await revoke_subject_sessions("user", uid, session=session, reason="group_membership_added")
        await user_repo.create_outbox_event(
            session, event_type="rbac.group.member_added",
            payload={"group_id": group.id, "user_id": uid, "actor_id": actor_id, "sessions_revoked": revoked,
                     "via": "workspace", "workspace_id": ws.id},
        )
    if user_ids:
        access = f", with {workspace_access.role_label(role)} access" if role else ""
        await notification_repo.notify(
            session, user_ids=user_ids, kind="workspace.member_added", title=f"You were added to {group.name}",
            body=f"A group in {ws.name}{access}.", link=f"/workspaces/{ws.id}", actor_id=actor_id,
            resource_type="workspace", resource_id=ws.id,
        )


async def _link_or_ask(session: AsyncSession, claims: PermissionClaims, user: User, ws_id: str, group: GroupORM,
                       idp_group: str, provider_id: Optional[str]) -> None:
    if has_permission(claims, idp_links.LINK_PERMISSION):
        await idp_links.link_group(session, group_id=group.id, idp_group=idp_group, provider_id=provider_id,
                                   actor_id=user.id)
    else:
        await idp_links.request_link(session, group=group, ws_id=ws_id, idp_group=idp_group,
                                     provider_id=provider_id, requested_by=user.id)


# ── Changes ──────────────────────────────────────────────────────────


async def create(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str,
                 body: WorkspaceGroupCreate) -> WorkspaceGroupResponse:
    """Make a group the workspace owns, bound here with ``role``, with its people in
    it — and linked to its identity-provider group, or that link asked for."""
    ws = await workspace(session, ws_id)
    short = _short(body.name)
    full = full_name(ws.name, short)
    await _free(session, full, short)
    await _check_ceiling(session, claims, ws_id, body.role)
    people = await _active_people(session, body.member_ids)
    idp_group = idp_links.clean_idp_group(body.idp_group) if _clean(body.idp_group) else None

    group = await group_repo.create_group(session, name=full, description=_clean(body.description),
                                          workspace_id=ws_id, created_by=user.id)
    await user_repo.create_outbox_event(
        session, event_type="rbac.group.created",
        payload={"group_id": group.id, "name": group.name, "actor_id": user.id, "workspace_id": ws_id},
    )
    binding, outcome = await workspace_access.grant_role(
        session, subject_type="group", subject_id=group.id, role=body.role, ws_id=ws_id, granted_by=user.id,
    )
    await _bound_event(session, ws_id, group.id, binding, outcome, user.id, 0)
    await _join(session, ws, group, people, body.role, user.id)
    if idp_group:
        await _link_or_ask(session, claims, user, ws_id, group, idp_group, None)
    return await one(session, ws, group)


async def update(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str, group_id: str,
                 body: WorkspaceGroupUpdate) -> WorkspaceGroupResponse:
    """Rename it (it keeps its workspace's prefix), describe it, or change its role
    here — the new role is granted and the old one removed, and its members' sessions
    end so their next request carries the change."""
    ws = await workspace(session, ws_id)
    group = await owned(session, ws_id, group_id)
    changed = False
    if body.name is not None:
        short = _short(body.name)
        full = full_name(ws.name, short)
        if full != group.name:
            await _free(session, full, short, except_id=group.id)
            group.name = full
            changed = True
    if "description" in body.model_fields_set and _clean(body.description) != group.description:
        group.description = _clean(body.description)
        changed = True
    if changed:
        await session.flush()
        await user_repo.create_outbox_event(
            session, event_type="rbac.group.updated",
            payload={"group_id": group.id, "actor_id": user.id, "workspace_id": ws_id},
        )

    held = (await _bindings(session, ws_id, [group.id], include_expired=True)).get(group.id, [])
    current = _role([b for b in held if not _is_expired(b.expires_at, now=_now())])
    if body.role is not None and body.role != current:
        await _check_ceiling(session, claims, ws_id, body.role)
        binding, outcome = await workspace_access.grant_role(
            session, subject_type="group", subject_id=group.id, role=body.role, ws_id=ws_id, granted_by=user.id,
        )
        old = [b for b in held if b.role_name != body.role]
        for b in old:
            await binding_repo.delete_binding(session, b.id)
        revoked = await revoke_subject_sessions("group", group.id, session=session, reason="workspace_role_changed")
        await _bound_event(session, ws_id, group.id, binding, outcome, user.id, revoked)
        for b in old:
            await user_repo.create_outbox_event(
                session, event_type="rbac.workspace.member_revoked",
                payload={"workspace_id": ws_id, "binding_id": b.id, "subject_type": "group",
                         "subject_id": group.id, "role": b.role_name, "actor_id": user.id,
                         "sessions_revoked": revoked},
            )
    return await one(session, ws, group)


async def delete(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str, group_id: str) -> None:
    """Delete it as the Groups page does — every binding and grant it held goes, and
    its members' sessions end — and with it its identity-provider links and any link
    still asked for."""
    await workspace(session, ws_id)
    group = await owned(session, ws_id, group_id)
    await _check_membership_change(session, claims, group)
    members = await group_repo.list_group_members(session, group.id)
    await group_repo.soft_delete_group(session, group.id)
    n_bindings = await binding_repo.delete_subject_bindings(session, subject_type="group", subject_id=group.id)
    n_grants = await grant_repo.delete_subject_grants(session, subject_type="group", subject_id=group.id)
    links = (await session.execute(
        select(IdpGroupRoleMappingORM.id, IdpGroupRoleMappingORM.idp_group)
        .where(IdpGroupRoleMappingORM.target_group_id == group.id)
    )).all()
    for mapping_id, idp_group in links:
        await idp_group_mapping_repo.delete_mapping(session, mapping_id)
        await user_repo.create_outbox_event(
            session, event_type="rbac.sso_mapping.deleted",
            payload={"mapping_id": mapping_id, "target_type": "group_membership", "idp_group": idp_group,
                     "actor_id": user.id},
        )
    if links:
        await idp_group_mapping_repo.remove_orphaned_sso_grants(session, group_ids=[group.id])
    await idp_links.cancel_for_group(session, group.id, user.id)
    revoked = 0
    for m in members:
        revoked += await revoke_subject_sessions("user", m.user_id, session=session, reason="group_deleted")
    await user_repo.create_outbox_event(
        session, event_type="rbac.group.deleted",
        payload={"group_id": group.id, "actor_id": user.id, "bindings_revoked": n_bindings,
                 "grants_revoked": n_grants, "sessions_revoked": revoked, "workspace_id": ws_id},
    )


# ── Membership ───────────────────────────────────────────────────────


async def members(session: AsyncSession, ws_id: str, group_id: str) -> list[WorkspaceGroupMember]:
    await workspace(session, ws_id)
    group = await group_here(session, ws_id, group_id)
    rows = await group_repo.list_group_members(session, group.id)
    people = await user_repo.get_identities_by_ids(session, [m.user_id for m in rows])
    return [_member(m, people.get(m.user_id)) for m in rows]


def _member(m: GroupMemberORM, ident: Optional[dict]) -> WorkspaceGroupMember:
    ident = ident or {}
    return WorkspaceGroupMember(id=m.user_id, display_name=ident.get("name") or ident.get("email") or None,
                                email=ident.get("email"), source=m.source or "local", added_at=m.added_at)


async def add_member(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str, group_id: str,
                     user_id: str) -> WorkspaceGroupMember:
    ws = await workspace(session, ws_id)
    group = await owned(session, ws_id, group_id)
    await _check_membership_change(session, claims, group)
    [uid] = await _active_people(session, [user_id])
    if await session.get(GroupMemberORM, (group.id, uid)) is not None:
        raise _refuse(status.HTTP_409_CONFLICT, "already_member", "They're already in this group.")
    current = _role((await _bindings(session, ws_id, [group.id])).get(group.id, []))
    await _join(session, ws, group, [uid], current, user.id)
    member = await session.get(GroupMemberORM, (group.id, uid))
    return _member(member, (await user_repo.get_identities_by_ids(session, [uid])).get(uid))


async def remove_member(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str, group_id: str,
                        user_id: str) -> None:
    await workspace(session, ws_id)
    group = await owned(session, ws_id, group_id)
    member = await session.get(GroupMemberORM, (group.id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="They aren't in this group")
    if member.source == "sso":
        raise _refuse(status.HTTP_409_CONFLICT, "managed_by_idp",
                      "Your identity provider put them in this group; they leave it there.")
    await _check_membership_change(session, claims, group)
    await group_repo.remove_member(session, group.id, user_id)
    revoked = await revoke_subject_sessions("user", user_id, session=session, reason="group_membership_removed")
    await user_repo.create_outbox_event(
        session, event_type="rbac.group.member_removed",
        payload={"group_id": group.id, "user_id": user_id, "actor_id": user.id, "sessions_revoked": revoked,
                 "via": "workspace", "workspace_id": ws_id},
    )


# ── The identity provider ────────────────────────────────────────────


async def link(session: AsyncSession, user: User, claims: PermissionClaims, ws_id: str, group_id: str,
               idp_group: str, provider_id: Optional[str]) -> WorkspaceGroupResponse:
    """Link the group to an identity-provider group — a platform administrator at
    once, anyone else by asking one."""
    ws = await workspace(session, ws_id)
    group = await owned(session, ws_id, group_id)
    await _link_or_ask(session, claims, user, ws_id, group, idp_group, provider_id)
    return await one(session, ws, group)


async def unlink(session: AsyncSession, user: User, ws_id: str, group_id: str, mapping_id: str) -> None:
    """Remove a link, as the SSO mappings page does: the people it put in the group
    leave it, unless another link still reaches it."""
    await workspace(session, ws_id)
    group = await group_here(session, ws_id, group_id)
    mapping = await idp_group_mapping_repo.get_mapping(session, mapping_id)
    if mapping is None or mapping.target_type != "group_membership" or mapping.target_group_id != group.id:
        raise HTTPException(status_code=404, detail="That link isn't this group's")
    idp_group = mapping.idp_group
    await idp_group_mapping_repo.delete_mapping(session, mapping_id)
    swept = await idp_group_mapping_repo.remove_orphaned_sso_grants(session, group_ids=[group.id])
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.deleted",
        payload={"mapping_id": mapping_id, "target_type": "group_membership", "idp_group": idp_group,
                 "actor_id": user.id, "stale_grants_cleared": swept},
    )
