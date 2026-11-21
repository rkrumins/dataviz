"""Workspace requests: asking for a workspace of your own, and answering.

Anyone signed in may ask for a workspace — a name, what it is for, the teammates to
add and the graphs they made in the Playground to bring along. The people who create
workspaces (``system:workspaces:create``: Org and Super Admins) answer:

* **approve** — optionally with another name or description. The workspace is
  created; the requester becomes its Workspace Admin and the teammates its Members;
  then each chosen Playground graph moves into it with its views
  (``data_source_transfer.move``). A graph that can't move is recorded in the
  request's ``outcome`` and the rest go on: the workspace is never lost to one.
* **send back** — with a question; the requester edits and resubmits.
* **decline** — with an optional reason.

The requester may withdraw an open request. One open request per person.

Every transition writes a ``workspace.request.*`` outbox event; the approvers hear of
new and resubmitted requests, and the requester of every answer, through the Inbox.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    ViewORM, WorkspaceDataSourceORM, WorkspaceORM, WorkspaceRequestORM, view_is_live,
)
from backend.app.db.repositories import (
    notification_repo,
    outbox_event_repo,
    user_repo,
    workspace_repo,
    workspace_request_repo as repo,
)
from backend.app.services import data_source_transfer, workspace_access
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.playground_policy import get_playground, graphs_made_by
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.management import DataSourceMoveRequest, WorkspaceCreateRequest
from backend.common.models.rbac import (
    WorkspaceRequestCreate,
    WorkspaceRequestDetail,
    WorkspaceRequestPerson,
    WorkspaceRequestPlaygroundActivity,
    WorkspaceRequestResponse,
    WorkspaceRequestSource,
)
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

PURPOSES = ("team", "project", "poc", "reporting", "other")
NAME_MAX = 120
APPROVER_PERMISSION = "system:workspaces:create"
_ADMIN_ROLE = "workspace_admin"
_MEMBER_ROLE = "workspace_member"
_APPROVERS_LINK = "/workspaces?tab=requests"
_REQUESTER_LINK = "/my/access?tab=workspaces"
_STATUS_WORDS = {
    "pending": "waiting for an answer",
    "changes_requested": "sent back for changes",
    "approved": "already approved",
    "declined": "already declined",
    "withdrawn": "already withdrawn",
}


# ── small helpers ────────────────────────────────────────────────────


def _refuse(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


def _clean(text: Optional[str]) -> Optional[str]:
    return (text.strip() if text else None) or None


def _reason(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("error") or detail)
    return str(detail)


async def _name_of(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


async def _emit(session: AsyncSession, event_type: str, row: WorkspaceRequestORM, actor_id: str,
                **extra) -> None:
    await outbox_event_repo.emit(
        session, event_type=event_type, aggregate_id=row.id, aggregate_type="workspace_request",
        payload={"request_id": row.id, "requester_id": row.requester_id, "name": row.name,
                 "actor_id": actor_id, **extra},
    )


async def _move(session: AsyncSession, row: WorkspaceRequestORM, new_status: str, verb: str, *,
                actor_id: str, **fields) -> None:
    """The transition, or a 409 saying why it can't happen from where the request is."""
    try:
        await repo.transition(session, row, new_status, actor_id=actor_id, **fields)
    except ValueError:
        raise _refuse(status.HTTP_409_CONFLICT, "wrong_status",
                      f"This request is {_STATUS_WORDS[row.status]}, so it can't be {verb}.")


# ── what may be asked for ────────────────────────────────────────────


async def _check_name(session: AsyncSession, raw: Optional[str]) -> str:
    """The trimmed name, free among the live workspaces — or 422 / 409 ``name_taken``
    with the first free ``"<name> 2"``, ``"<name> 3"``…"""
    name = (raw or "").strip()
    if not 1 <= len(name) <= NAME_MAX:
        raise HTTPException(status_code=422, detail=f"A workspace name is 1 to {NAME_MAX} characters.")
    taken = {
        (n or "").strip().lower() for n in (await session.execute(
            select(WorkspaceORM.name).where(WorkspaceORM.deleted_at.is_(None))
        )).scalars().all()
    }
    if name.lower() in taken:
        n = 2
        while f"{name} {n}".lower() in taken:
            n += 1
        raise _refuse(status.HTTP_409_CONFLICT, "name_taken",
                      f"There is already a workspace called {name}.", suggestion=f"{name} {n}")
    return name


async def _check_sources(session: AsyncSession, requester_id: str, ids: list[str]) -> list[str]:
    """Only live graphs the requester made in the Playground may come along."""
    ids = list(dict.fromkeys(i for i in ids if i))
    if not ids:
        return []
    playground = await get_playground(session)
    found = set() if playground is None else set((await session.execute(
        select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.id.in_(ids),
            WorkspaceDataSourceORM.workspace_id == playground.id,
            WorkspaceDataSourceORM.created_by == requester_id,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
    )).scalars().all())
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Only graphs you made in the Playground can come along. Not one of yours: "
                   f"{', '.join(missing)}.",
        )
    return ids


async def _active_people(session: AsyncSession, ids: list[str]) -> set[str]:
    identities = await user_repo.get_identities_by_ids(session, ids)
    return {
        uid for uid, ident in identities.items()
        if ident["status"] == "active" and not ident["deleted"] and not is_service_account(uid)
    }


async def _check_teammates(session: AsyncSession, requester_id: str, ids: list[str]) -> list[str]:
    """Active people only; the requester is the workspace's admin, not a teammate."""
    ids = list(dict.fromkeys(i for i in ids if i and i != requester_id))
    if not ids:
        return []
    active = await _active_people(session, ids)
    missing = [i for i in ids if i not in active]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Teammates must be people with an active account. Not found or not active: "
                   f"{', '.join(missing)}.",
        )
    return ids


async def _validated(session: AsyncSession, requester_id: str, body: WorkspaceRequestCreate) -> dict:
    if body.purpose not in PURPOSES:
        raise HTTPException(status_code=422, detail=f"Purpose must be one of: {', '.join(PURPOSES)}.")
    return {
        "name": await _check_name(session, body.name),
        "description": _clean(body.description),
        "purpose": body.purpose,
        "team_name": _clean(body.team_name),
        "teammate_ids": await _check_teammates(session, requester_id, body.teammate_ids),
        "playground_source_ids": await _check_sources(session, requester_id, body.playground_source_ids),
        "data_needs": _clean(body.data_needs),
        "note": _clean(body.note),
    }


async def _tell_approvers(session: AsyncSession, row: WorkspaceRequestORM, kind: str, title: str) -> None:
    await notification_repo.notify(
        session,
        user_ids=await notification_repo.users_with_global_permission(session, APPROVER_PERMISSION),
        kind=kind, title=title, body=row.note or row.description, link=_APPROVERS_LINK,
        actor_id=row.requester_id, resource_type="workspace_request", resource_id=row.id,
    )


# ── the requester ────────────────────────────────────────────────────


async def submit(session: AsyncSession, user: User, body: WorkspaceRequestCreate) -> WorkspaceRequestORM:
    """Ask for a workspace. 409 ``request_open`` when the person already has one open."""
    def _open(existing: WorkspaceRequestORM) -> HTTPException:
        return _refuse(status.HTTP_409_CONFLICT, "request_open",
                       "You already have a workspace request open. Change or withdraw it first.",
                       requestId=existing.id)

    existing = await repo.find_open_for(session, user.id)
    if existing is not None:
        raise _open(existing)
    fields = await _validated(session, user.id, body)
    row, created = await repo.create(session, requester_id=user.id, **fields)
    if not created:
        raise _open(row)
    await _emit(session, "workspace.request.submitted", row, user.id)
    await _tell_approvers(session, row, "workspace_request.submitted",
                          f"{await _name_of(session, user.id)} asked for a workspace: {row.name}")
    return row


async def own(session: AsyncSession, user: User, request_id: str, *,
              for_update: bool = False) -> WorkspaceRequestORM:
    """The caller's own request, or 404 — someone else's is not theirs to know of."""
    row = await repo.get(session, request_id, for_update=for_update)
    if row is None or row.requester_id != user.id:
        raise HTTPException(status_code=404, detail="Workspace request not found")
    return row


async def resubmit(session: AsyncSession, user: User, request_id: str,
                   body: WorkspaceRequestCreate) -> WorkspaceRequestORM:
    """Answer an approver's question: edit the request and send it again."""
    row = await own(session, user, request_id, for_update=True)
    if row.status != "changes_requested":
        raise _refuse(status.HTTP_409_CONFLICT, "wrong_status",
                      f"This request is {_STATUS_WORDS[row.status]}, so it can't be resubmitted.")
    fields = await _validated(session, user.id, body)
    for column in ("name", "description", "purpose", "team_name", "data_needs", "note"):
        setattr(row, column, fields[column])
    row.teammate_ids = json.dumps(fields["teammate_ids"])
    row.playground_source_ids = json.dumps(fields["playground_source_ids"])
    await _move(session, row, "pending", "resubmitted", actor_id=user.id)
    await _emit(session, "workspace.request.resubmitted", row, user.id)
    await _tell_approvers(session, row, "workspace_request.resubmitted",
                          f"{await _name_of(session, user.id)} updated their workspace request: {row.name}")
    return row


async def withdraw(session: AsyncSession, user: User, request_id: str) -> WorkspaceRequestORM:
    row = await own(session, user, request_id, for_update=True)
    await _move(session, row, "withdrawn", "withdrawn", actor_id=user.id)
    await _emit(session, "workspace.request.withdrawn", row, user.id)
    return row


# ── the approvers ────────────────────────────────────────────────────


async def _to_answer(session: AsyncSession, request_id: str, approver: User) -> WorkspaceRequestORM:
    """Lock the request, so two answers decide one after the other. Nobody answers
    their own."""
    row = await repo.get(session, request_id, for_update=True)
    if row is None:
        raise HTTPException(status_code=404, detail="Workspace request not found")
    if row.requester_id == approver.id:
        raise _refuse(status.HTTP_403_FORBIDDEN, "own_request", "You can't answer your own request.")
    return row


async def send_back(session: AsyncSession, approver: User, request_id: str,
                    question: str) -> WorkspaceRequestORM:
    row = await _to_answer(session, request_id, approver)
    question = (question or "").strip()
    if not question:
        raise HTTPException(status_code=422, detail="Ask the question the requester should answer.")
    await _move(session, row, "changes_requested", "sent back", actor_id=approver.id, question=question)
    await _emit(session, "workspace.request.sent_back", row, approver.id, question=question)
    await notification_repo.notify(
        session, user_ids=[row.requester_id], kind="workspace_request.sent_back",
        title=f"A question about your workspace request: {row.name}", body=question,
        link=_REQUESTER_LINK, actor_id=approver.id, resource_type="workspace_request",
        resource_id=row.id,
    )
    return row


async def decline(session: AsyncSession, approver: User, request_id: str,
                  reason: Optional[str]) -> WorkspaceRequestORM:
    row = await _to_answer(session, request_id, approver)
    reason = _clean(reason)
    await _move(session, row, "declined", "declined", actor_id=approver.id, note=reason)
    await _emit(session, "workspace.request.declined", row, approver.id, reason=reason)
    await notification_repo.notify(
        session, user_ids=[row.requester_id], kind="workspace_request.declined",
        title=f"Your workspace request was declined: {row.name}",
        body=reason or "No reason was given.", link=_REQUESTER_LINK, actor_id=approver.id,
        resource_type="workspace_request", resource_id=row.id,
    )
    return row


async def _bind(session: AsyncSession, ws_id: str, user_id: str, role: str, actor_id: str) -> None:
    """Grant ``role`` in the new workspace, end the person's sessions so their next
    request reads it, and record it as the members page does."""
    binding, outcome = await workspace_access.grant_role(
        session, subject_type="user", subject_id=user_id, role=role, ws_id=ws_id, granted_by=actor_id,
    )
    revoked = await revoke_subject_sessions("user", user_id, session=session, reason="workspace_binding_added")
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_bound",
        payload={
            "workspace_id": ws_id, "binding_id": binding.id, "subject_type": "user",
            "subject_id": user_id, "role": role, "actor_id": actor_id, "expires_at": None,
            "sessions_revoked": revoked, "idp_exception": False,
            "reactivated": outcome == "reactivated",
        },
    )


async def _move_source(session: AsyncSession, ds_id: str, playground_id: Optional[str], ws_id: str,
                       claims: PermissionClaims, actor_id: str) -> Optional[str]:
    """Move one Playground graph, with its views, into the new workspace. None when it
    moved; otherwise why not. The move commits (or rolls back) by itself."""
    if playground_id is None:
        return "There is no Playground to move it from."
    try:
        ds = await data_source_transfer.source_in(session, ds_id, playground_id)
    except HTTPException:
        return "It is no longer in the Playground."
    try:
        pre = await data_source_transfer.preflight(session, ds=ds, to_ws_id=ws_id, claims=claims,
                                                   purpose="move")
        await data_source_transfer.move(
            session, ds_id=ds_id, from_ws_id=playground_id, claims=claims, user_id=actor_id,
            req=DataSourceMoveRequest(targetWorkspaceId=ws_id, previewToken=pre.token),
        )
        return None
    except HTTPException as exc:
        await session.rollback()
        return _reason(exc)
    except Exception:  # noqa: BLE001 — the workspace is made; one graph must not undo the answer
        logger.exception("could not move data source %s into workspace %s", ds_id, ws_id)
        await session.rollback()
        return "It couldn't be moved. Try moving it from the Playground."


async def approve(session: AsyncSession, approver: User, claims: PermissionClaims, request_id: str, *,
                  name: Optional[str] = None, description: Optional[str] = None) -> WorkspaceRequestORM:
    """Create the workspace, bind its people and bring the Playground graphs along.

    The workspace, its bindings and the approval are committed first; each graph's
    move then commits on its own (it must, to put the version store right on a
    failure), so a graph that can't move is recorded and never takes the workspace
    with it."""
    row = await _to_answer(session, request_id, approver)
    if not repo.can_move(row.status, "approved"):
        raise _refuse(status.HTTP_409_CONFLICT, "wrong_status",
                      f"This request is {_STATUS_WORDS[row.status]}, so it can't be approved.")
    ws_name = await _check_name(session, row.name if name is None else name)
    ws_description = row.description if description is None else _clean(description)

    created = await workspace_repo.create_workspace(
        session, WorkspaceCreateRequest(name=ws_name, description=ws_description, dataSources=[]),
    )
    ws = await session.get(WorkspaceORM, created.id)
    ws.created_by = row.requester_id
    ws_id = ws.id
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.created",
        payload={"workspace_id": ws_id, "name": ws_name, "actor_id": approver.id,
                 "data_source_count": 0, "request_id": row.id},
    )
    await _bind(session, ws_id, row.requester_id, _ADMIN_ROLE, approver.id)
    teammates = repo.ids_of(row.teammate_ids)
    still_active = await _active_people(session, teammates) if teammates else set()
    added = [uid for uid in teammates if uid in still_active]
    for uid in added:
        await _bind(session, ws_id, uid, _MEMBER_ROLE, approver.id)
    if added:
        requester_name = await _name_of(session, row.requester_id)
        await notification_repo.notify(
            session, user_ids=added, kind="workspace.member_added",
            title=f"You were added to {ws_name}",
            body=f"As {workspace_access.role_label(_MEMBER_ROLE)}. {requester_name} asked for this "
                 "workspace and named you as a teammate.",
            link=f"/workspaces/{ws_id}", actor_id=approver.id, resource_type="workspace",
            resource_id=ws_id,
        )

    source_ids = repo.ids_of(row.playground_source_ids)
    outcome: dict = {"movedSources": [], "failedSources": [], "membersAdded": added, "workspaceId": ws_id}
    row.outcome = json.dumps(outcome)
    await _move(session, row, "approved", "approved", actor_id=approver.id, workspace_id=ws_id)
    await _emit(session, "workspace.request.approved", row, approver.id, workspace_id=ws_id)
    requester_id = row.requester_id
    await session.commit()

    if source_ids:
        playground = await get_playground(session)
        playground_id = playground.id if playground is not None else None
        for ds_id in source_ids:
            why = await _move_source(session, ds_id, playground_id, ws_id, claims, approver.id)
            if why is None:
                outcome["movedSources"].append(ds_id)
            else:
                outcome["failedSources"].append({"id": ds_id, "reason": why})
        await session.refresh(row)   # a failed move's rollback expired it
        row.outcome = json.dumps(outcome)

    moved, failed = len(outcome["movedSources"]), len(outcome["failedSources"])
    graphs = ""
    if moved:
        graphs += f" {moved} of your Playground graphs moved in with their views."
    if failed:
        graphs += f" {failed} couldn't move and stay in the Playground."
    await notification_repo.notify(
        session, user_ids=[requester_id], kind="workspace_request.approved",
        title=f"Your workspace {ws_name} is ready",
        body=f"You're its {workspace_access.role_label(_ADMIN_ROLE)}.{graphs}",
        link=f"/workspaces/{ws_id}?welcome=1", actor_id=approver.id,
        resource_type="workspace_request", resource_id=request_id,
    )
    await session.flush()
    return row


# ── reads ────────────────────────────────────────────────────────────


async def _view_counts(session: AsyncSession, ds_ids: list[str]) -> dict[str, int]:
    if not ds_ids:
        return {}
    return dict((await session.execute(
        select(ViewORM.data_source_id, func.count(ViewORM.id))
        .where(ViewORM.data_source_id.in_(ds_ids), view_is_live())
        .group_by(ViewORM.data_source_id)
    )).all())


async def to_responses(session: AsyncSession, rows: list[WorkspaceRequestORM]) -> list[WorkspaceRequestResponse]:
    """Requests as the API returns them: names, graph labels and view counts in a
    handful of id-correlated queries however many there are."""
    if not rows:
        return []
    teammates = {r.id: repo.ids_of(r.teammate_ids) for r in rows}
    sources = {r.id: repo.ids_of(r.playground_source_ids) for r in rows}
    people = await user_repo.get_identities_by_ids(
        session, sorted({r.requester_id for r in rows} | {u for ids in teammates.values() for u in ids}),
    )
    ds_ids = sorted({d for ids in sources.values() for d in ids})
    labels = dict((await session.execute(
        select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label)
        .where(WorkspaceDataSourceORM.id.in_(ds_ids))
    )).all()) if ds_ids else {}
    views = await _view_counts(session, ds_ids)

    def _name(uid: str) -> Optional[str]:
        ident = people.get(uid)
        return (ident["name"] or ident["email"]) if ident else None

    return [
        WorkspaceRequestResponse(
            id=r.id, requester_id=r.requester_id, requester_name=_name(r.requester_id), name=r.name,
            description=r.description, purpose=r.purpose, team_name=r.team_name,
            teammate_ids=teammates[r.id],
            teammates=[WorkspaceRequestPerson(id=u, display_name=_name(u)) for u in teammates[r.id]],
            playground_source_ids=sources[r.id],
            playground_sources=[
                WorkspaceRequestSource(id=d, label=labels.get(d), view_count=views.get(d, 0))
                for d in sources[r.id]
            ],
            data_needs=r.data_needs, note=r.note, status=r.status, question=r.question,
            created_at=r.created_at, updated_at=r.updated_at, resolved_at=r.resolved_at,
            resolved_by=r.resolved_by, resolution_note=r.resolution_note, workspace_id=r.workspace_id,
            outcome=json.loads(r.outcome) if r.outcome else None,
        )
        for r in rows
    ]


async def detail(session: AsyncSession, row: WorkspaceRequestORM) -> WorkspaceRequestDetail:
    """A request as an approver reads it: the requester's email, and what they have
    built in the Playground — their live graphs there and the live views on them."""
    base = (await to_responses(session, [row]))[0]
    ident = (await user_repo.get_identities_by_ids(session, [row.requester_id])).get(row.requester_id)
    activity = WorkspaceRequestPlaygroundActivity()
    playground = await get_playground(session)
    if playground is not None:
        graphs = await graphs_made_by(session, playground.id, row.requester_id)
        if graphs:
            mine = list((await session.execute(
                select(WorkspaceDataSourceORM.id).where(
                    WorkspaceDataSourceORM.workspace_id == playground.id,
                    WorkspaceDataSourceORM.created_by == row.requester_id,
                    WorkspaceDataSourceORM.deleted_at.is_(None),
                )
            )).scalars().all())
            activity = WorkspaceRequestPlaygroundActivity(
                graphs=graphs, views=sum((await _view_counts(session, mine)).values()),
            )
    return WorkspaceRequestDetail(
        **base.model_dump(), requester_email=ident["email"] if ident else None,
        playground_activity=activity,
    )
