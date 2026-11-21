"""A data source's data contacts: its Owner and its Stewards, the people to ask about it.

* **Reading** them takes ``workspace:datasource:read``. A source naming nobody shows
  the contacts derived from it (who created it, and the people named on the data
  requests connected as it) with ``provenance: derived``, or none (``fallback``: a
  question goes to the workspace's admins). The first save writes them down.
* **Changing the Stewards** takes ``workspace:datasource:manage``; **changing the
  Owner** takes ``workspace:admin`` too — or being the current Owner (named, or the
  derived one, directly or through the group named). Otherwise 403 ``owner_locked``.
* A save sends the whole set with the ``updatedAt`` it was read at; a set changed
  since answers 409 ``stale`` with what it is now. At most ten Stewards
  (422 ``too_many``); people must have an active account (422 ``not_active``) and a
  group at most 50 members (422 ``group_too_large``).

Each change writes ``workspace.data_source.contacts_changed`` (ids only) and tells the
people newly named directly (``data_source.contact_added``). The switch
(``conversationsEnabled``) gates saving; reading never.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GroupORM, WorkspaceDataSourceORM
from backend.app.db.repositories import (
    data_source_contact_repo as repo,
    group_repo,
    notification_repo,
    outbox_event_repo,
)
from backend.app.jobs import metrics
from backend.app.services.discussions import readers as rd
from backend.app.services.discussions.access import refuse, require_person
from backend.app.services.discussions.people import people_map
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.models.discussions import ContactEntry, DataContactsResponse, DataContactsUpdate
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

FLAG = "conversationsEnabled"
READ = "workspace:datasource:read"
MANAGE = "workspace:datasource:manage"
GROUP_MAX = 50


def source_link(workspace_id: str, data_source_id: str) -> str:
    return f"/workspaces/{workspace_id}?tab=data&section=sources&ds={data_source_id}"


async def live_source(session: AsyncSession, workspace_id: str, data_source_id: str, *,
                      for_update: bool = False) -> WorkspaceDataSourceORM:
    stmt = select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.id == data_source_id, WorkspaceDataSourceORM.workspace_id == workspace_id,
        WorkspaceDataSourceORM.deleted_at.is_(None),
    )
    if for_update:
        stmt = stmt.with_for_update()
    ds = (await session.execute(stmt)).scalar_one_or_none()
    if ds is None:
        raise refuse(404, "not_found", "That data source doesn't exist in this workspace.")
    return ds


def _current_owner(rows, derived_owner: Optional[str]) -> Optional[tuple[str, str]]:
    if rows:
        owner = next((r for r in rows if r.role == "owner"), None)
        return (owner.subject_type, owner.subject_id) if owner else None
    return ("user", derived_owner) if derived_owner else None


async def _is_owner(session: AsyncSession, user: User, owner: Optional[tuple[str, str]]) -> bool:
    if owner is None:
        return False
    kind, sid = owner
    if kind == "user":
        return sid == user.id
    return sid in await group_repo.get_user_groups(session, user.id)


async def is_named_contact(session: AsyncSession, user: User, data_source_id: str) -> bool:
    """Whether the source names ``user`` its Owner or a Steward — directly, or through
    a group they are in. Derived contacts don't count: only someone written down does."""
    rows = await repo.list_for_source(session, data_source_id)
    if any(r.subject_type == "user" and r.subject_id == user.id for r in rows):
        return True
    named_groups = {r.subject_id for r in rows if r.subject_type == "group"}
    return bool(named_groups) and not named_groups.isdisjoint(await group_repo.get_user_groups(session, user.id))


async def read(session: AsyncSession, user: User, claims: PermissionClaims,
               ds: WorkspaceDataSourceORM) -> DataContactsResponse:
    """The source's contacts as the caller sees them, with what they may change."""
    rows = await repo.list_for_source(session, ds.id)
    derived_owner, known = (None, [])
    if not rows:
        derived_owner, known = await rd.derived_contacts(session, rd.source_subject(ds))
    if rows:
        refs = [(r.role, r.subject_type, r.subject_id) for r in rows]
        vias = {"owner": "named_owner", "steward": "named_steward"}
        provenance = "named"
    else:
        refs = ([("owner", "user", derived_owner)] if derived_owner else []) + [("steward", "user", u) for u in known]
        vias = {"owner": "created_source", "steward": "data_request"}
        provenance = "derived" if refs else "fallback"

    group_ids = [sid for _, kind, sid in refs if kind == "group"]
    groups = dict((await session.execute(
        select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(group_ids))
    )).all()) if group_ids else {}
    counts = await group_repo.count_members_batch(session, group_ids)
    people = await people_map(session, [sid for _, kind, sid in refs if kind == "user"] + [user.id])

    def entry(role: str, kind: str, sid: str) -> ContactEntry:
        name = (groups.get(sid) or "A removed group") if kind == "group" else people[sid].display_name
        return ContactEntry(subject_type=kind, subject_id=sid, name=name, via=vias[role],
                            member_count=counts.get(sid, 0) if kind == "group" else None)

    entries = [(role, entry(role, kind, sid)) for role, kind, sid in refs]
    on = await feature_flags.is_enabled_self_session(FLAG, default=False)
    can_edit = on and not is_service_account(user.id) and has_permission(claims, MANAGE, workspace_id=ds.workspace_id)
    can_edit_owner = can_edit and (
        has_permission(claims, "workspace:admin", workspace_id=ds.workspace_id)
        or await _is_owner(session, user, _current_owner(rows, derived_owner))
    )
    return DataContactsResponse(
        owner=next((e for role, e in entries if role == "owner"), None),
        stewards=[e for role, e in entries if role == "steward"],
        provenance=provenance, updated_at=repo.updated_at(rows), can_edit=can_edit,
        can_edit_owner=can_edit_owner, people=people,
    )


async def _check_subjects(session: AsyncSession, refs: list[tuple[str, str]]) -> None:
    users = [sid for kind, sid in refs if kind == "user"]
    active = await rd.active_people(session, users)
    for sid in users:
        if sid not in active:
            raise refuse(422, "not_active", "Data contacts must be people with an active account.", subjectId=sid)
    group_ids = [sid for kind, sid in refs if kind == "group"]
    if not group_ids:
        return
    live = set((await session.execute(
        select(GroupORM.id).where(GroupORM.id.in_(group_ids), GroupORM.deleted_at.is_(None))
    )).scalars().all())
    counts = await group_repo.count_members_batch(session, group_ids)
    for sid in group_ids:
        if sid not in live:
            raise refuse(422, "not_active", "That group no longer exists.", subjectId=sid)
        if counts.get(sid, 0) > GROUP_MAX:
            raise refuse(422, "group_too_large",
                         f"A group named as a data contact can have at most {GROUP_MAX} members.", subjectId=sid)


async def save(session: AsyncSession, user: User, claims: PermissionClaims, workspace_id: str,
               data_source_id: str, body: DataContactsUpdate) -> DataContactsResponse:
    """Replace the source's contacts (the route checks the switch and ``…:manage``)."""
    require_person(user)
    ds = await live_source(session, workspace_id, data_source_id, for_update=True)
    rows = await repo.list_for_source(session, ds.id)
    if body.expected_updated_at != repo.updated_at(rows):
        raise refuse(409, "stale", "Someone changed these data contacts since you opened them.",
                     current=(await read(session, user, claims, ds)).model_dump(by_alias=True))

    owner = (body.owner.subject_type, body.owner.subject_id) if body.owner else None
    stewards = [s for s in dict.fromkeys((s.subject_type, s.subject_id) for s in body.stewards) if s != owner]
    if len(stewards) > repo.STEWARDS_MAX:
        raise refuse(422, "too_many", f"A data source can have at most {repo.STEWARDS_MAX} Stewards.")
    await _check_subjects(session, ([owner] if owner else []) + stewards)

    derived_owner = None if rows else (await rd.derived_contacts(session, rd.source_subject(ds)))[0]
    current = _current_owner(rows, derived_owner)
    if owner != current and not (
        has_permission(claims, "workspace:admin", workspace_id=ds.workspace_id)
        or await _is_owner(session, user, current)
    ):
        raise refuse(403, "owner_locked", "Only a workspace admin or the current Owner can change the Owner.")

    before = {(r.role, r.subject_type, r.subject_id) for r in rows}
    after = ({("owner", *owner)} if owner else set()) | {("steward", *s) for s in stewards}
    if before == after:
        return await read(session, user, claims, ds)

    now = datetime.now(timezone.utc).isoformat()
    await repo.replace(session, ds.id, owner=owner, stewards=stewards, added_by=user.id, now=now)
    await outbox_event_repo.emit(
        session, event_type="workspace.data_source.contacts_changed", aggregate_id=ds.id,
        aggregate_type="data_source",
        payload={"data_source_id": ds.id, "workspace_id": ds.workspace_id, "actor_id": user.id,
                 "owner": list(owner) if owner else None, "stewards": [list(s) for s in stewards]},
    )
    metrics.increment("data_source_contacts_saved_total")
    added = sorted({sid for role, kind, sid in after - before if kind == "user"} - {sid for _, k, sid in before})
    if added:
        name = ds.label or ds.graph_name or "a data source"
        try:
            await notification_repo.notify(
                session, user_ids=added, kind="data_source.contact_added",
                title=f"You're now a data contact for {name}",
                body="People who can open it will ask you about its data.",
                link=source_link(ds.workspace_id, ds.id), actor_id=user.id,
                resource_type="data_source", resource_id=ds.id,
            )
        except Exception:  # noqa: BLE001 — telling people never undoes the save
            logger.exception("data_source.contact_added failed ds=%s", ds.id)
    return await read(session, user, claims, ds)
