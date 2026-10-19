"""Find a workspace: the organization's workspaces, for anyone signed in.

Behind the ``workspaceDirectoryEnabled`` switch, which ships off: turning it
on tells everyone which workspaces exist. Lists every workspace its admins
haven't hidden, plus the ones the caller can open (hidden or not), each with
what it is for, how many people and data sources it has, who answers its
requests (ids — the client names them), how access works, and where the
caller stands: the roles they hold there, and their open request.

  GET /api/v1/workspace-directory
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.models import WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import access_request_repo
from backend.app.services import workspace_access
from backend.app.services.permission_service import resolve
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    WorkspaceDirectoryEntry,
    WorkspaceDirectoryRequest,
    WorkspaceDirectoryResponse,
)

router = APIRouter(dependencies=[Depends(require_feature("workspaceDirectoryEnabled"))])

#: Approvers named on a card; the rest are a count.
_APPROVERS_SHOWN = 3


@router.get("", response_model=WorkspaceDirectoryResponse, response_model_by_alias=True)
async def list_workspace_directory(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> WorkspaceDirectoryResponse:
    claims = await resolve(session, user.id)
    workspaces = [
        w for w in (await session.execute(
            select(WorkspaceORM)
            .where(WorkspaceORM.deleted_at.is_(None))
            .order_by(func.lower(WorkspaceORM.name))
        )).scalars().all()
        if w.directory_listed or workspace_access.can_open(claims, w.id)
    ]
    ids = [w.id for w in workspaces]
    sources = dict((await session.execute(
        select(WorkspaceDataSourceORM.workspace_id, func.count())
        .where(
            WorkspaceDataSourceORM.workspace_id.in_(ids),
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
        .group_by(WorkspaceDataSourceORM.workspace_id)
    )).all()) if ids else {}
    audience = await workspace_access.audience(session, ids)
    held = await workspace_access.roles_held(session, user.id, ids)
    open_requests = {
        r.target_id: r for r in await access_request_repo.list_for_requester(
            session, requester_id=user.id, status="open",
        )
    }

    entries = []
    for w in workspaces:
        people, approvers = audience[w.id]
        request = open_requests.get(w.id)
        entries.append(WorkspaceDirectoryEntry(
            id=w.id,
            name=w.name,
            description=w.description,
            data_source_count=sources.get(w.id, 0),
            people_count=len(people),
            approver_ids=sorted(approvers)[:_APPROVERS_SHOWN],
            approver_count=len(approvers),
            access_mode=w.access_mode or "app",
            access_note=w.access_note,
            directory_listed=w.directory_listed is not False,
            request_policy=w.request_policy or "approval",
            can_open=workspace_access.can_open(claims, w.id),
            your_roles=sorted(held.get(w.id, set())),
            open_request=WorkspaceDirectoryRequest(
                id=request.id,
                status=request.status,
                requested_role=request.requested_role,
                created_at=request.created_at,
                idp_group=request.idp_group,
            ) if request else None,
        ))
    return WorkspaceDirectoryResponse(entries=entries)
