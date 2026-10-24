"""Who may run a native query, and on which data source.

The route's gates have already held the caller to the workspace's data plane
(membership, or a view they can read, pinned to its own source) and the
feature switch. On top of that, one of:

* ``workspace:native-query:read`` with data source access in the workspace —
  every role that reads data sources has it by default, and an administrator
  can take it from any role; or
* a share of the request's ``viewId`` — to the caller or a group they are in
  — that opts in to querying its data source, for that view's own source
  only. A view open to the whole organization or workspace never does.

API keys never: native queries are for people at the console (the route is
also off the API-key surface, which refuses keys before this runs).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, view_is_live
from backend.app.db.repositories import data_source_repo, grant_repo
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


@dataclass(frozen=True)
class NativeAccess:
    #: The data source the query runs on.
    data_source_id: str
    #: Its name now, for the activity record.
    data_source_label: str
    #: ``permission`` or ``grant``.
    via: str


class NativeAccessDenied(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


async def authorize(
    session: AsyncSession, *, user: User, claims: PermissionClaims, workspace_id: str,
    data_source_id: Optional[str], view_id: Optional[str],
) -> NativeAccess:
    """The caller's way to a native query here — or ``NativeAccessDenied``."""
    if claims.key_scope is not None:
        raise NativeAccessDenied(403, "Native queries can't be run with an API key.")
    source = await _source(session, workspace_id, data_source_id)
    if source is None:
        raise NativeAccessDenied(404, "This workspace has no data source to query.")
    ctx = await view_access.ViewerContext.build(session, user=user, claims=claims)
    label = source.label or source.graph_name or source.id
    if view_access.may_query_sources(ctx, workspace_id):
        return NativeAccess(source.id, label, "permission")
    if view_id and await _view_grants_it(session, ctx, workspace_id, view_id, source.id):
        return NativeAccess(source.id, label, "grant")
    raise NativeAccessDenied(
        403,
        "You can't run your own queries on this data source. Ask a workspace admin for the "
        "native query permission, or for a share of this view that lets you query its data.",
    )


async def _source(session: AsyncSession, workspace_id: str, data_source_id: Optional[str]):
    if data_source_id:
        row = await data_source_repo.get_data_source_orm(session, data_source_id)
        return row if row is not None and row.workspace_id == workspace_id else None
    return await data_source_repo.get_primary_data_source(session, workspace_id)


async def _view_grants_it(
    session: AsyncSession, ctx: view_access.ViewerContext, workspace_id: str, view_id: str,
    source_id: str,
) -> bool:
    view = (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id, view_is_live())
    )).scalar_one_or_none()
    if view is None or view.workspace_id != workspace_id:
        return False
    if not await view_access.can_read_view(session, ctx, view):
        return False
    resolved = view.data_source_id
    if resolved is None:
        primary = await data_source_repo.get_primary_data_source(session, workspace_id)
        resolved = primary.id if primary else None
    if resolved != source_id:
        return False
    return await grant_repo.has_source_query_grant(
        session, view_id=view.id, user_id=ctx.user_id, group_ids=list(ctx.group_ids),
    )
