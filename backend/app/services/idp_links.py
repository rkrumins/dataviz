"""Linking groups to the identity provider, and asking for it.

A group linked to an identity-provider group (a ``group_membership`` mapping) is
filled at each SSO sign-in with the people the identity provider puts in it. Making
that link is a platform administrator's call (``system:admin``, the SSO rules' own
bar), so:

* a platform administrator links at once (:func:`link_group`);
* anyone else — a workspace admin, or an Org Admin approving a workspace request —
  asks (:func:`request_link`); the platform administrators hear of it and link
  (:func:`link_request`) or decline (:func:`decline_request`). Deleting the group
  cancels it (:func:`cancel_for_group`).

A mapping made any way at all for a group with a pending request for that same
identity-provider group closes the request as linked (:func:`settle_pending`). A
request an approved workspace request made keeps that request's ``outcome`` in step.

There is no directory of the identity provider's groups to read. What is known of
them is what each person's sign-in asserted, snapshotted at every SSO sign-in
(``users.metadata.idp_groups``, ``user_identities.metadata.groups``). Suggestions and
previews read those snapshots: a person sees only their own — group names say a lot
about an organization — and a platform administrator sees everyone's, with how many
people's snapshots hold each.
"""
from __future__ import annotations

import json
from typing import Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupORM,
    IdpGroupRoleMappingORM,
    IdpLinkRequestORM,
    IdpProviderORM,
    UserIdentityORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    idp_group_mapping_repo,
    idp_link_request_repo as repo,
    notification_repo,
    user_repo,
    workspace_request_repo,
)
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    IdpGroupPreview,
    IdpGroupSuggestion,
    IdpLinkRequestResponse,
    WorkspaceRequestPerson,
)

#: Linking a group to the identity provider: the SSO rules' own bar.
LINK_PERMISSION = "system:admin"
IDP_GROUP_MAX = 200
_ADMINS_LINK = "/workspaces?tab=requests"
_PREVIEW_PEOPLE = 10
PREVIEW_NOTE = (
    "Who had this group at their last sign-in through your identity provider. The "
    "record is updated at each SSO sign-in, so someone added to the group since appears "
    "after their next one."
)


def _refuse(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


def clean_idp_group(raw: Optional[str]) -> str:
    name = (raw or "").strip()
    if not 1 <= len(name) <= IDP_GROUP_MAX:
        raise HTTPException(status_code=422, detail=f"An identity-provider group is 1 to {IDP_GROUP_MAX} characters.")
    return name


async def _name_of(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


async def _check_provider(session: AsyncSession, provider_id: Optional[str]) -> None:
    if provider_id and await session.get(IdpProviderORM, provider_id) is None:
        raise HTTPException(status_code=422, detail="That identity-provider connection doesn't exist.")


async def _linked_to(session: AsyncSession, group_id: str, idp_group: str) -> list[IdpGroupRoleMappingORM]:
    return list((await session.execute(
        select(IdpGroupRoleMappingORM).where(
            IdpGroupRoleMappingORM.target_type == "group_membership",
            IdpGroupRoleMappingORM.target_group_id == group_id,
            IdpGroupRoleMappingORM.idp_group == idp_group,
        )
    )).scalars().all())


# ── Linking ──────────────────────────────────────────────────────────


async def link_group(session: AsyncSession, *, group_id: str, idp_group: str, provider_id: Optional[str],
                     actor_id: str) -> IdpGroupRoleMappingORM:
    """Link the group to the identity-provider group, from ``provider_id`` (none: any
    connection). 409 ``already_linked`` when it is; 400 ``link_refused`` when the SSO
    rules refuse it (the group grants what an IdP group may never) — nothing written."""
    idp_group = clean_idp_group(idp_group)
    provider_id = provider_id or None
    await _check_provider(session, provider_id)
    if any(m.provider_id == provider_id for m in await _linked_to(session, group_id, idp_group)):
        raise _refuse(status.HTTP_409_CONFLICT, "already_linked", f"This group is already linked to {idp_group}.")
    try:
        async with session.begin_nested():
            mapping = await idp_group_mapping_repo.create_group_membership_mapping(
                session, idp_group=idp_group, target_group_id=group_id, provider_id=provider_id,
                created_by=actor_id,
            )
    except (idp_group_mapping_repo.MappingValidationError, ValueError) as exc:
        raise _refuse(status.HTTP_400_BAD_REQUEST, "link_refused", str(exc))
    await user_repo.create_outbox_event(
        session, event_type="rbac.sso_mapping.created",
        payload={"mapping_id": mapping.id, "target_type": "group_membership", "idp_group": mapping.idp_group,
                 "target_group_id": group_id, "provider_id": provider_id, "actor_id": actor_id},
    )
    await settle_pending(session, mapping, actor_id)
    return mapping


async def settle_pending(session: AsyncSession, mapping: IdpGroupRoleMappingORM, actor_id: str) -> None:
    """A mapping was made: the group's pending request for that identity-provider
    group, if it has one, is linked by it."""
    if mapping.target_type != "group_membership" or not mapping.target_group_id:
        return
    pending = (await repo.pending_for_groups(session, [mapping.target_group_id])).get(mapping.target_group_id)
    if pending is not None and pending.idp_group == mapping.idp_group:
        await _close_linked(session, pending, mapping, actor_id)


async def _close_linked(session: AsyncSession, pending: IdpLinkRequestORM, mapping: IdpGroupRoleMappingORM,
                        actor_id: str) -> None:
    await repo.resolve(session, pending, "linked", actor_id=actor_id, mapping_id=mapping.id)
    await _emit(session, "rbac.idp_link_request.linked", pending, actor_id, mapping_id=mapping.id)
    await _settle_outcome(session, pending)
    group = await session.get(GroupORM, pending.group_id)
    await notification_repo.notify(
        session, user_ids=[pending.requested_by], kind="idp_link.linked",
        title=f"{group.name if group else 'Your group'} is linked to {pending.idp_group}",
        body="Members of the identity-provider group join it at their next sign-in.",
        link=f"/workspaces/{pending.workspace_id}?tab=members", actor_id=actor_id,
        resource_type="idp_link_request", resource_id=pending.id,
    )


async def _emit(session: AsyncSession, event_type: str, row: IdpLinkRequestORM, actor_id: Optional[str],
                **extra) -> None:
    await user_repo.create_outbox_event(
        session, event_type=event_type,
        payload={"request_id": row.id, "group_id": row.group_id, "workspace_id": row.workspace_id,
                 "idp_group": row.idp_group, "provider_id": row.provider_id, "source": row.source,
                 "source_id": row.source_id, "requested_by": row.requested_by, "actor_id": actor_id, **extra},
    )


async def _settle_outcome(session: AsyncSession, row: IdpLinkRequestORM) -> None:
    """Keep an approved workspace request's record in step with the link it asked for:
    out of ``idpLinksPending``, into ``idpLinksCreated`` or ``idpLinksDeclined``."""
    if row.source != "workspace_request" or not row.source_id:
        return
    request = await workspace_request_repo.get(session, row.source_id)
    if request is None or not request.outcome:
        return
    outcome = json.loads(request.outcome)
    waiting = outcome.get("idpLinksPending") or []
    if not any(w.get("groupId") == row.group_id for w in waiting):
        return
    outcome["idpLinksPending"] = [w for w in waiting if w.get("groupId") != row.group_id]
    if row.status == "linked":
        outcome["idpLinksCreated"] = [*(outcome.get("idpLinksCreated") or []),
                                      {"groupId": row.group_id, "idpGroup": row.idp_group}]
    elif row.status == "declined":
        outcome["idpLinksDeclined"] = [*(outcome.get("idpLinksDeclined") or []),
                                       {"groupId": row.group_id, "idpGroup": row.idp_group,
                                        "reason": row.resolution_note}]
    request.outcome = json.dumps(outcome)
    await session.flush()


# ── Asking, and answering ────────────────────────────────────────────


async def request_link(session: AsyncSession, *, group: GroupORM, ws_id: str, idp_group: str,
                       provider_id: Optional[str], requested_by: str, source: str = "workspace",
                       source_id: Optional[str] = None, actor_id: Optional[str] = None) -> IdpLinkRequestORM:
    """Ask the platform administrators to link ``group``. 409 ``link_pending`` (with its
    ``requestId``) when the group already waits for one; 409 ``already_linked``."""
    idp_group = clean_idp_group(idp_group)
    provider_id = provider_id or None
    await _check_provider(session, provider_id)
    if await _linked_to(session, group.id, idp_group):
        raise _refuse(status.HTTP_409_CONFLICT, "already_linked", f"This group is already linked to {idp_group}.")
    row, created = await repo.create(
        session, group_id=group.id, workspace_id=ws_id, idp_group=idp_group, provider_id=provider_id,
        requested_by=requested_by, source=source, source_id=source_id,
    )
    if not created:
        raise _refuse(status.HTTP_409_CONFLICT, "link_pending",
                      f"This group is already waiting to be linked to {row.idp_group}.", requestId=row.id)
    actor_id = actor_id or requested_by
    await _emit(session, "rbac.idp_link_request.created", row, actor_id)
    await notification_repo.notify(
        session,
        user_ids=await notification_repo.users_with_global_permission(session, LINK_PERMISSION),
        kind="idp_link.requested",
        title=f"{await _name_of(session, requested_by)} asks to link {group.name} to {idp_group}",
        body="Linking it lets your identity provider decide who is in the group, at each sign-in.",
        link=_ADMINS_LINK, actor_id=actor_id, resource_type="idp_link_request", resource_id=row.id,
    )
    return row


async def _pending(session: AsyncSession, request_id: str, verb: str) -> IdpLinkRequestORM:
    row = await repo.get(session, request_id, for_update=True)
    if row is None:
        raise HTTPException(status_code=404, detail="Link request not found")
    if row.status != "pending":
        raise _refuse(status.HTTP_409_CONFLICT, "wrong_status", f"This request is {row.status}, so it can't be {verb}.")
    return row


async def link_request(session: AsyncSession, admin: User, request_id: str,
                       provider_id: Optional[str]) -> IdpLinkRequestORM:
    """Make the link asked for — from ``provider_id``, else the connection asked for,
    else any; or, when the group is linked to that identity-provider group already,
    take that link as the answer. The requester hears of it."""
    row = await _pending(session, request_id, "linked")
    existing = await _linked_to(session, row.group_id, row.idp_group)
    if existing:
        await _close_linked(session, row, existing[0], admin.id)
    else:
        await link_group(session, group_id=row.group_id, idp_group=row.idp_group,
                         provider_id=provider_id or row.provider_id, actor_id=admin.id)
    return row


async def decline_request(session: AsyncSession, admin: User, request_id: str,
                          reason: Optional[str]) -> IdpLinkRequestORM:
    row = await _pending(session, request_id, "declined")
    reason = (reason or "").strip() or None
    await repo.resolve(session, row, "declined", actor_id=admin.id, note=reason)
    await _emit(session, "rbac.idp_link_request.declined", row, admin.id, reason=reason)
    await _settle_outcome(session, row)
    group = await session.get(GroupORM, row.group_id)
    await notification_repo.notify(
        session, user_ids=[row.requested_by], kind="idp_link.declined",
        title=f"Not linked to {row.idp_group}: {group.name if group else row.group_id}",
        body=reason or "No reason was given.", link=f"/workspaces/{row.workspace_id}?tab=members",
        actor_id=admin.id, resource_type="idp_link_request", resource_id=row.id,
    )
    return row


async def cancel_for_group(session: AsyncSession, group_id: str, actor_id: str) -> None:
    """The group is going: its pending request goes with it."""
    pending = (await repo.pending_for_groups(session, [group_id])).get(group_id)
    if pending is None:
        return
    await repo.resolve(session, pending, "cancelled", actor_id=actor_id)
    await _emit(session, "rbac.idp_link_request.cancelled", pending, actor_id)
    await _settle_outcome(session, pending)


# ── What sign-ins asserted ───────────────────────────────────────────


def _groups_in(raw: Optional[str], key: str) -> set[str]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return set()
    groups = value.get(key) if isinstance(value, dict) else None
    return {g.strip() for g in groups if isinstance(g, str) and g.strip()} if isinstance(groups, list) else set()


async def snapshots(session: AsyncSession, user_ids: Optional[list[str]] = None) -> dict[str, set[str]]:
    """``{user: the identity-provider groups their last sign-ins asserted}`` — the
    latest one's (``users.metadata``) and each connection's (``user_identities``) — for
    ``user_ids``, or everyone. Deleted accounts are left out."""
    people = select(UserORM.id, UserORM.metadata_).where(
        UserORM.deleted_at.is_(None), UserORM.metadata_.like('%"idp_groups"%'),
    )
    identities = select(UserIdentityORM.user_id, UserIdentityORM.metadata_).where(
        UserIdentityORM.metadata_.like('%"groups"%'),
    )
    gone = select(UserORM.id).where(UserORM.deleted_at.is_not(None))
    if user_ids is not None:
        people = people.where(UserORM.id.in_(user_ids))
        identities = identities.where(UserIdentityORM.user_id.in_(user_ids))
        gone = gone.where(UserORM.id.in_(user_ids))
    deleted = set((await session.execute(gone)).scalars().all())
    out: dict[str, set[str]] = {}
    for uid, raw in (await session.execute(people)).all():
        if groups := _groups_in(raw, "idp_groups"):
            out.setdefault(uid, set()).update(groups)
    for uid, raw in (await session.execute(identities)).all():
        if uid not in deleted and (groups := _groups_in(raw, "groups")):
            out.setdefault(uid, set()).update(groups)
    return out


def _seen(snaps: dict[str, set[str]]) -> dict[str, set[str]]:
    """``{identity-provider group: the people whose snapshot holds it}``."""
    seen: dict[str, set[str]] = {}
    for uid, groups in snaps.items():
        for g in groups:
            seen.setdefault(g, set()).add(uid)
    return seen


async def suggestions(session: AsyncSession, user: User, *, everyone: bool, q: Optional[str],
                      limit: int) -> list[IdpGroupSuggestion]:
    """Identity-provider groups whose name holds ``q`` (any case). ``everyone`` (a
    platform administrator): every snapshot's, the most seen first, with counts.
    Otherwise only the caller's own sign-ins', by name, without counts."""
    needle = (q or "").strip().lower()
    if everyone:
        seen = _seen(await snapshots(session))
        found = sorted(((g, len(u)) for g, u in seen.items() if needle in g.lower()),
                       key=lambda gc: (-gc[1], gc[0].lower()))
        return [IdpGroupSuggestion(idp_group=g, seen_count=c) for g, c in found[:limit]]
    own = (await snapshots(session, [user.id])).get(user.id, set())
    found = sorted((g for g in own if needle in g.lower()), key=str.lower)
    return [IdpGroupSuggestion(idp_group=g) for g in found[:limit]]


async def preview(session: AsyncSession, idp_group: str) -> IdpGroupPreview:
    """Who had ``idp_group`` at their last sign-in, and how many."""
    idp_group = clean_idp_group(idp_group)
    holders = sorted(_seen(await snapshots(session)).get(idp_group, set()))
    names = await user_repo.get_identities_by_ids(session, holders)
    people = sorted(
        (WorkspaceRequestPerson(id=u, display_name=(names[u]["name"] or names[u]["email"]) if u in names else None)
         for u in holders),
        key=lambda p: ((p.display_name or p.id).lower(), p.id),
    )
    return IdpGroupPreview(idp_group=idp_group, seen_count=len(holders), people=people[:_PREVIEW_PEOPLE],
                           note=PREVIEW_NOTE)


# ── Reads ────────────────────────────────────────────────────────────


async def to_responses(session: AsyncSession, rows: Iterable[IdpLinkRequestORM]) -> list[IdpLinkRequestResponse]:
    """Requests as the API returns them, with the group's, workspace's and requester's
    names and how many people's sign-ins asserted the identity-provider group."""
    rows = list(rows)
    if not rows:
        return []
    groups = dict((await session.execute(
        select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(sorted({r.group_id for r in rows})))
    )).all())
    workspaces = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(sorted({r.workspace_id for r in rows})))
    )).all())
    people = await user_repo.get_identities_by_ids(session, sorted({r.requested_by for r in rows}))
    seen = _seen(await snapshots(session))

    def _name(uid: str) -> Optional[str]:
        ident = people.get(uid)
        return (ident["name"] or ident["email"]) if ident else None

    return [
        IdpLinkRequestResponse(
            id=r.id, group_id=r.group_id, group_name=groups.get(r.group_id), workspace_id=r.workspace_id,
            workspace_name=workspaces.get(r.workspace_id), idp_group=r.idp_group, provider_id=r.provider_id,
            requested_by=r.requested_by, requested_by_name=_name(r.requested_by), requested_at=r.requested_at,
            status=r.status, source=r.source, source_id=r.source_id, resolved_by=r.resolved_by,
            resolved_at=r.resolved_at, resolution_note=r.resolution_note,
            seen_count=len(seen.get(r.idp_group, ())),
        )
        for r in rows
    ]
