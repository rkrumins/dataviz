"""Data requests: asking for data to be connected to a workspace, and connecting it.

Anyone who can read a workspace's data sources (``workspace:datasource:read``) may
ask for more: where the data lives (Snowflake, a dbt project, a file…), what of it,
why, by when, and the people who know it. Everyone who can read the workspace sees
its requests.

The platform team — whoever creates workspaces (``system:workspaces:create``: Org and
Super Admins) — answers every workspace's requests: **start** (takes it on, as its
assignee), **connect** (optionally naming the data source it became, which must be in
that workspace) or **decline** (with an optional reason). A workspace's own data
people (``workspace:datasource:manage`` there) may start and connect their
workspace's requests too — they can add the source themselves — but declining is the
platform team's. The requester may withdraw a request nobody has taken yet.

Every transition writes a ``workspace.data_request.*`` outbox event. A new request
reaches the platform team and the workspace's admins through the Inbox; each answer
reaches the requester.

:func:`create_for_workspace` makes requests server-side, for a flow that asks for data
on someone's behalf (a workspace request's "Data you'll need", say).
"""
from __future__ import annotations

import logging
from typing import Iterable, Optional, Union

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataRequestORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import (
    data_request_repo as repo,
    notification_repo,
    outbox_event_repo,
    user_repo,
)
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.models.rbac import DataRequestCreate, DataRequestResponse, WorkspaceRequestPerson
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

TITLE_MAX = 120
#: Who may ask, in the workspace asked for.
ASK_PERMISSION = "workspace:datasource:read"
#: The platform team: answers every workspace's requests.
PLATFORM_PERMISSION = "system:workspaces:create"
#: A workspace's own data people: may start and connect that workspace's requests.
WORKSPACE_FULFIL_PERMISSION = "workspace:datasource:manage"
_PLATFORM_LINK = "/workspaces?tab=requests"
_STATUS_WORDS = {
    "pending": "waiting for someone to take it",
    "in_progress": "already being connected",
    "connected": "already connected",
    "declined": "already declined",
    "withdrawn": "already withdrawn",
}


def workspace_link(workspace_id: str) -> str:
    """Where a workspace's requests are followed: its data sources."""
    return f"/workspaces/{workspace_id}?tab=data&section=sources"


# ── small helpers ────────────────────────────────────────────────────


def _refuse(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


def _clean(text: Optional[str]) -> Optional[str]:
    return (text.strip() if text else None) or None


async def _name_of(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


async def _emit(session: AsyncSession, event_type: str, row: DataRequestORM, actor_id: str,
                **extra) -> None:
    await outbox_event_repo.emit(
        session, event_type=event_type, aggregate_id=row.id, aggregate_type="data_request",
        payload={"request_id": row.id, "workspace_id": row.workspace_id, "requester_id": row.requested_by,
                 "title": row.title, "system": row.system, "actor_id": actor_id, **extra},
    )


async def _move(session: AsyncSession, row: DataRequestORM, new_status: str, verb: str, *,
                actor_id: str, **fields) -> None:
    """The transition, or a 409 saying why it can't happen from where the request is."""
    try:
        await repo.transition(session, row, new_status, actor_id=actor_id, **fields)
    except ValueError:
        raise _refuse(status.HTTP_409_CONFLICT, "wrong_status",
                      f"This request is {_STATUS_WORDS[row.status]}, so it can't be {verb}.")


async def _workspace(session: AsyncSession, workspace_id: str) -> WorkspaceORM:
    """A live workspace that takes data requests — not the Playground, which holds no
    production data."""
    ws = await session.get(WorkspaceORM, workspace_id)
    if ws is None or ws.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if ws.kind == "playground":
        raise _refuse(422, "playground", "The Playground takes no production data, so data can't be asked for there.")
    return ws


async def _check_contacts(session: AsyncSession, requester_id: str, ids: list[str]) -> list[str]:
    """People with an active account; the requester is the requester, not a contact."""
    ids = list(dict.fromkeys(i for i in ids if i and i != requester_id))
    if not ids:
        return []
    identities = await user_repo.get_identities_by_ids(session, ids)
    active = {
        uid for uid, ident in identities.items()
        if ident["status"] == "active" and not ident["deleted"] and not is_service_account(uid)
    }
    missing = [i for i in ids if i not in active]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"The people who know the data must have an active account. Not found or not active: "
                   f"{', '.join(missing)}.",
        )
    return ids


async def _validated(session: AsyncSession, requester_id: str, body: DataRequestCreate) -> dict:
    title = (body.title or "").strip()
    if not 1 <= len(title) <= TITLE_MAX:
        raise HTTPException(status_code=422, detail=f"A request's title is 1 to {TITLE_MAX} characters.")
    return {
        "title": title, "system": body.system, "details": _clean(body.details),
        "purpose": _clean(body.purpose), "urgency": body.urgency,
        "contact_ids": await _check_contacts(session, requester_id, body.contact_ids),
    }


async def _tell_of_new(session: AsyncSession, ws: WorkspaceORM, row: DataRequestORM) -> None:
    """The platform team, on their queue; the workspace's admins, on the workspace."""
    who = await _name_of(session, row.requested_by)
    title = f"{who} asked for data in {ws.name}: {row.title}"
    platform = await notification_repo.users_with_global_permission(session, PLATFORM_PERMISSION)
    common = dict(kind="data_request.submitted", title=title, body=row.details or row.purpose,
                  actor_id=row.requested_by, resource_type="data_request", resource_id=row.id)
    await notification_repo.notify(session, user_ids=platform, link=_PLATFORM_LINK, **common)
    admins = await notification_repo.users_who_can(session, workspace_id=ws.id, permission="workspace:admin")
    await notification_repo.notify(session, user_ids=admins - platform, link=workspace_link(ws.id), **common)


async def _tell_requester(session: AsyncSession, row: DataRequestORM, kind: str, title: str,
                          body: Optional[str], actor_id: str) -> None:
    await notification_repo.notify(
        session, user_ids=[row.requested_by], kind=kind, title=title, body=body,
        link=workspace_link(row.workspace_id), actor_id=actor_id, resource_type="data_request",
        resource_id=row.id,
    )


# ── asking ───────────────────────────────────────────────────────────


async def create_for_workspace(
    session: AsyncSession,
    *,
    workspace_id: str,
    requested_by: str,
    items: Iterable[Union[DataRequestCreate, dict]],
) -> list[DataRequestORM]:
    """Ask for data in a workspace on ``requested_by``'s behalf, one request per item
    (a :class:`DataRequestCreate` or its JSON). Checks what is asked for, records it,
    and tells the platform team and the workspace's admins — but neither the switch nor who
    may ask: that is the caller's to decide. Flushes; the caller commits."""
    ws = await _workspace(session, workspace_id)
    bodies = [i if isinstance(i, DataRequestCreate) else DataRequestCreate.model_validate(i) for i in items]
    fields = [await _validated(session, requested_by, b) for b in bodies]
    rows: list[DataRequestORM] = []
    for f in fields:
        row = await repo.create(session, workspace_id=ws.id, requested_by=requested_by, **f)
        await _emit(session, "workspace.data_request.submitted", row, requested_by)
        await _tell_of_new(session, ws, row)
        rows.append(row)
    return rows


async def submit(session: AsyncSession, user: User, workspace_id: str, body: DataRequestCreate) -> DataRequestORM:
    """Ask for data in a workspace the caller may read (the route checks that)."""
    return (await create_for_workspace(session, workspace_id=workspace_id, requested_by=user.id, items=[body]))[0]


async def withdraw(session: AsyncSession, user: User, request_id: str) -> DataRequestORM:
    """Withdraw one's own request while nobody has taken it."""
    row = await repo.get(session, request_id, for_update=True)
    if row is None or row.requested_by != user.id:
        raise HTTPException(status_code=404, detail="Data request not found")
    await _move(session, row, "withdrawn", "withdrawn", actor_id=user.id)
    await _emit(session, "workspace.data_request.withdrawn", row, user.id)
    return row


# ── answering ────────────────────────────────────────────────────────


def can_fulfil(claims: PermissionClaims, workspace_id: str) -> bool:
    """The platform team, or the workspace's own data people."""
    return has_permission(claims, PLATFORM_PERMISSION) or has_permission(
        claims, WORKSPACE_FULFIL_PERMISSION, workspace_id=workspace_id,
    )


async def _to_answer(session: AsyncSession, claims: PermissionClaims, request_id: str, *,
                     platform_only: bool = False) -> DataRequestORM:
    """Lock the request, so two answers decide one after the other — once the caller
    is shown to be someone who may answer it. Anyone else gets a 404 for a workspace
    they can't read, a 403 for one they can."""
    row = await repo.get(session, request_id, for_update=True)
    if row is None or not (
        has_permission(claims, PLATFORM_PERMISSION)
        or has_permission(claims, ASK_PERMISSION, workspace_id=row.workspace_id)
    ):
        raise HTTPException(status_code=404, detail="Data request not found")
    allowed = has_permission(claims, PLATFORM_PERMISSION) if platform_only else can_fulfil(claims, row.workspace_id)
    if not allowed:
        raise _refuse(status.HTTP_403_FORBIDDEN, "not_fulfiller",
                      "Only the platform team can decline a data request." if platform_only
                      else "Only the platform team, or people who manage this workspace's data, can answer it.")
    return row


async def start(session: AsyncSession, actor: User, claims: PermissionClaims, request_id: str) -> DataRequestORM:
    """Take a request on: the caller becomes its assignee."""
    row = await _to_answer(session, claims, request_id)
    await _move(session, row, "in_progress", "started", actor_id=actor.id)
    await _emit(session, "workspace.data_request.started", row, actor.id)
    await _tell_requester(session, row, "data_request.started",
                          f"{await _name_of(session, actor.id)} is connecting your data: {row.title}",
                          "You'll hear here again once it's connected.", actor.id)
    return row


async def connect(session: AsyncSession, actor: User, claims: PermissionClaims, request_id: str, *,
                  data_source_id: Optional[str] = None, note: Optional[str] = None) -> DataRequestORM:
    """Mark a request connected — naming the data source it became, which must be a
    live one in the request's workspace."""
    row = await _to_answer(session, claims, request_id)
    label: Optional[str] = None
    if data_source_id:
        ds = (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id == data_source_id,
                WorkspaceDataSourceORM.workspace_id == row.workspace_id,
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if ds is None:
            raise _refuse(422, "data_source_elsewhere",
                          "That data source isn't in this request's workspace.")
        label = ds.label or ds.graph_name
    note = _clean(note)
    await _move(session, row, "connected", "connected", actor_id=actor.id, note=note,
                data_source_id=data_source_id or None)
    await _emit(session, "workspace.data_request.connected", row, actor.id, data_source_id=data_source_id or None)
    body = note or (f"It's in the workspace as {label}." if label else "It's in the workspace now.")
    await _tell_requester(session, row, "data_request.connected", f"Your data is connected: {row.title}",
                          body, actor.id)
    return row


async def decline(session: AsyncSession, actor: User, claims: PermissionClaims, request_id: str,
                  reason: Optional[str]) -> DataRequestORM:
    row = await _to_answer(session, claims, request_id, platform_only=True)
    reason = _clean(reason)
    await _move(session, row, "declined", "declined", actor_id=actor.id, note=reason)
    await _emit(session, "workspace.data_request.declined", row, actor.id, reason=reason)
    await _tell_requester(session, row, "data_request.declined", f"Your data request was declined: {row.title}",
                          reason or "No reason was given.", actor.id)
    return row


# ── reads ────────────────────────────────────────────────────────────


async def to_responses(session: AsyncSession, rows: list[DataRequestORM]) -> list[DataRequestResponse]:
    """Requests as the API returns them: people, workspaces and sources by name, in a
    handful of id-correlated queries however many there are."""
    if not rows:
        return []
    contacts = {r.id: repo.ids_of(r.contact_ids) for r in rows}
    people = await user_repo.get_identities_by_ids(session, sorted(
        {r.requested_by for r in rows} | {r.assignee_id for r in rows if r.assignee_id}
        | {u for ids in contacts.values() for u in ids}
    ))
    ws_ids = sorted({r.workspace_id for r in rows})
    ws_names = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(ws_ids))
    )).all())
    ds_ids = sorted({r.data_source_id for r in rows if r.data_source_id})
    labels = {
        i: label or graph for i, label, graph in (await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label, WorkspaceDataSourceORM.graph_name)
            .where(WorkspaceDataSourceORM.id.in_(ds_ids))
        )).all()
    } if ds_ids else {}

    def _name(uid: Optional[str]) -> Optional[str]:
        ident = people.get(uid) if uid else None
        return (ident["name"] or ident["email"]) if ident else None

    return [
        DataRequestResponse(
            id=r.id, workspace_id=r.workspace_id, workspace_name=ws_names.get(r.workspace_id),
            requested_by=r.requested_by, requester_name=_name(r.requested_by), title=r.title,
            system=r.system, details=r.details, purpose=r.purpose, urgency=r.urgency,
            contact_ids=contacts[r.id],
            contacts=[WorkspaceRequestPerson(id=u, display_name=_name(u)) for u in contacts[r.id]],
            status=r.status, assignee_id=r.assignee_id, assignee_name=_name(r.assignee_id),
            resolution_note=r.resolution_note, data_source_id=r.data_source_id,
            data_source_label=labels.get(r.data_source_id) if r.data_source_id else None,
            created_at=r.created_at, updated_at=r.updated_at, resolved_at=r.resolved_at,
            resolved_by=r.resolved_by,
        )
        for r in rows
    ]
