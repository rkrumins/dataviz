"""Someone's profile, as the reader may see it: who they are, the workspaces they run and
the data they are a contact for — only workspaces and sources the reader can open.

A service account, or an id that names nobody, has no profile (404). A deleted
account keeps one: a former member, by name. The views someone made are
``GET /views?createdBy=``, which scopes itself.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.db.repositories import data_source_contact_repo, group_repo, user_repo
from backend.app.services.discussions import readers as rd
from backend.app.services.discussions.access import Caller, not_found
from backend.app.services.discussions.people import people_map
from backend.app.services.permission_service import has_permission
from backend.common.models.discussions import NamedRef, ProfileDataContact, ProfilePerson, ProfileResponse
from backend.common.service_accounts import is_service_account


async def profile(session: AsyncSession, caller: Caller, user_id: str) -> ProfileResponse:
    if is_service_account(user_id) or not await user_repo.get_identities_by_ids(session, [user_id]):
        raise not_found("person")
    person = (await people_map(session, [user_id]))[user_id]

    def reads(ws_id: str, permission: str = "workspace:view:read") -> bool:
        return has_permission(caller.claims, permission, workspace_id=ws_id)

    run = sorted(ws for ws in await rd.workspaces_run_by(session, user_id) if reads(ws))
    groups = await group_repo.get_user_groups(session, user_id)
    rows = await data_source_contact_repo.list_for_people(session, user_id=user_id, group_ids=groups)
    sources = {
        ds.id: ds for ds in (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id.in_(sorted({r.data_source_id for r in rows})),
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalars().all()
    } if rows else {}
    shown = [(r, sources[r.data_source_id]) for r in rows if r.data_source_id in sources
             and reads(sources[r.data_source_id].workspace_id, "workspace:datasource:read")]
    names = await rd.workspace_names(session, run + [ds.workspace_id for _, ds in shown])
    return ProfileResponse(
        person=ProfilePerson(**person.model_dump(), is_service_account=False),
        is_me=user_id == caller.id,
        workspaces_they_run=[NamedRef(id=ws, name=names.get(ws, ws)) for ws in run],
        data_contacts=[
            ProfileDataContact(data_source_id=ds.id, data_source_name=ds.label or ds.graph_name or ds.id,
                               workspace_id=ds.workspace_id, workspace_name=names.get(ds.workspace_id),
                               role=r.role, via="direct" if r.subject_type == "user" else "group")
            for r, ds in shown
        ],
    )
