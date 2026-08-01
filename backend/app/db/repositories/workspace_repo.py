"""
Repository for workspaces table.
Workspaces are operational contexts that contain one or more data sources
(each binding a Provider + Graph Name + Blueprint).
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import select, delete, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import (
    WorkspaceORM,
    WorkspaceDataSourceORM,
    ViewORM,
    RoleBindingORM,
    RoleORM,
)
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
    DataSourceResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _ds_to_response(row: WorkspaceDataSourceORM) -> DataSourceResponse:
    # Resolve display label: explicit label → graph_name (physical asset) → catalog item name
    resolved_label = row.label
    if not resolved_label and row.graph_name:
        resolved_label = row.graph_name
    if not resolved_label and hasattr(row, 'catalog_item') and row.catalog_item:
        resolved_label = row.catalog_item.name or row.catalog_item.source_identifier
    return DataSourceResponse(
        id=row.id,
        workspaceId=row.workspace_id,
        catalogItemId=row.catalog_item_id,
        ontologyId=row.ontology_id,
        label=resolved_label,
        isPrimary=bool(row.is_primary),
        isActive=bool(row.is_active),
        projectionMode=row.projection_mode,
        dedicatedGraphName=row.dedicated_graph_name,
        providerId=row.provider_id,
        graphName=row.graph_name,
        accessLevel=row.access_level,
        # Mirror data_source_repo._to_response — this parallel serializer backs
        # the workspace list/detail reads, so omitting these made a saved
        # identity/name mapping silently read back as the default on refresh
        # (same duplicated-serializer drift the aggregationStatus note below hit).
        # NULL / unset → the platform defaults so clients never special-case them.
        identityProperty=(getattr(row, "identity_property", None) or "urn"),
        nameProperty=(getattr(row, "name_property", None) or "name"),
        sourceMode=row.source_mode,
        writeBackEnabled=bool(row.write_back_enabled),
        # The column existed and was never mapped, so DataSourceResponse fell back to
        # its "none" default for EVERY source. The workspace list therefore reported
        # the whole estate as un-aggregated — a workspace holding 2.1M nodes across 8
        # sources rendered a grey "Not aggregated" chip, and the Health filter's
        # Ready / Syncing / Needs-attention options could never match anything.
        aggregationStatus=row.aggregation_status or "none",
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


def _to_response(row: WorkspaceORM) -> WorkspaceResponse:
    ds_list = [_ds_to_response(ds) for ds in (row.data_sources or [])]
    return WorkspaceResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        dataSources=ds_list,
        isDefault=bool(row.is_default),
        isActive=bool(row.is_active),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
        publishPolicy=row.publish_policy or "request",
    )


# ------------------------------------------------------------------ #
# Queries (with eager loading of data_sources)                         #
# ------------------------------------------------------------------ #

def _ws_query():
    # A soft-deleted data source is in the trash: it must never be embedded in a
    # workspace's dataSources (that leak kept off-boarded sources alive in the
    # Workspaces list and the View Wizard). Same predicate as
    # data_source_repo._live() and the get_workspace_impact query below — one
    # predicate, one meaning. Filtered at the eager load so no other read path,
    # present or future, has to remember to re-apply it.
    return select(WorkspaceORM).options(
        selectinload(
            WorkspaceORM.data_sources.and_(
                WorkspaceDataSourceORM.deleted_at.is_(None)
            )
        )
    )


async def _counts_by_workspace(session: AsyncSession) -> tuple[dict, dict]:
    """Members and live views per workspace, in TWO grouped queries.

    Not N+1: the workspaces page renders 25 cards, and asking each one for its
    own member count would be 25 round-trips for two numbers.
    """
    members = dict((await session.execute(
        select(RoleBindingORM.scope_id, func.count())
        .where(RoleBindingORM.scope_type == "workspace")
        .group_by(RoleBindingORM.scope_id)
    )).all())

    views = dict((await session.execute(
        select(ViewORM.workspace_id, func.count())
        .where(ViewORM.deleted_at.is_(None))
        .group_by(ViewORM.workspace_id)
    )).all())

    return members, views


async def list_workspaces(session: AsyncSession) -> List[WorkspaceResponse]:
    result = await session.execute(
        _ws_query().order_by(WorkspaceORM.created_at)
    )
    rows = result.scalars().unique().all()

    members, views = await _counts_by_workspace(session)

    out: List[WorkspaceResponse] = []
    for r in rows:
        resp = _to_response(r)
        resp.member_count = int(members.get(r.id, 0) or 0)
        resp.view_count = int(views.get(r.id, 0) or 0)
        out.append(resp)
    return out


async def list_workspaces_page(
    session: AsyncSession,
    *,
    limit: int,
    offset: int = 0,
    search: Optional[str] = None,
    permitted_ids: Optional[List[str]] = None,
) -> Tuple[List[WorkspaceResponse], int]:
    """Return one page of workspaces plus the total matching the same filters.

    RBAC is applied IN SQL (via ``permitted_ids``) rather than after the fetch,
    so the total — and therefore the page count the UI renders — describes the
    workspaces this caller can actually see. ``permitted_ids=None`` means "no
    restriction" (system admin / enforcement disabled); an empty list means the
    caller can see nothing, which is not the same thing.

    Ordered by name so paging is stable and alphabetical (the order a person
    scanning a list expects), with id as a tiebreaker for determinism.
    """
    filters = []
    if permitted_ids is not None:
        if not permitted_ids:
            return [], 0
        filters.append(WorkspaceORM.id.in_(permitted_ids))
    if search and search.strip():
        filters.append(WorkspaceORM.name.ilike(f"%{search.strip()}%"))

    total_stmt = select(func.count()).select_from(WorkspaceORM)
    if filters:
        total_stmt = total_stmt.where(*filters)
    total = int((await session.execute(total_stmt)).scalar_one())

    page_stmt = _ws_query()
    if filters:
        page_stmt = page_stmt.where(*filters)
    page_stmt = (
        page_stmt.order_by(WorkspaceORM.name, WorkspaceORM.id)
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(page_stmt)
    return [_to_response(r) for r in result.scalars().unique().all()], total


async def get_workspace(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceResponse]:
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == workspace_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_workspace_orm(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceORM]:
    """Return the raw ORM row with data_sources eagerly loaded."""
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == workspace_id)
    )
    return result.scalar_one_or_none()


async def get_default_workspace(
    session: AsyncSession,
) -> Optional[WorkspaceORM]:
    """Return the default workspace (is_default=True, is_active=True)."""
    result = await session.execute(
        _ws_query()
        .where(
            WorkspaceORM.is_default == True,  # noqa: E712
            WorkspaceORM.is_active == True,
        )
    )
    return result.scalar_one_or_none()


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def create_workspace(
    session: AsyncSession,
    req: WorkspaceCreateRequest,
    make_default: bool = False,
) -> WorkspaceResponse:
    ws = WorkspaceORM(
        name=req.name,
        description=req.description,
        is_default=make_default,
        is_active=True,
    )
    session.add(ws)
    await session.flush()  # assigns ws.id

    # Create data source rows
    from .catalog_repo import get_catalog_item_orm
    for i, ds_req in enumerate(req.data_sources):
        if ds_req.catalog_item_id:
            # Catalog-based: resolve provider and graph name from catalog item
            cat = await get_catalog_item_orm(session, ds_req.catalog_item_id)
            if not cat:
                raise ValueError(f"Catalog Item '{ds_req.catalog_item_id}' not found")
            provider_id = cat.provider_id
            graph_name = cat.source_identifier
            label = ds_req.label or cat.name or cat.source_identifier
        elif ds_req.provider_id:
            # Direct provider+graph: used by bootstrap and direct API calls
            provider_id = ds_req.provider_id
            graph_name = ds_req.graph_name
            label = ds_req.label or ds_req.graph_name or "default"
        else:
            raise ValueError("DataSource requires either catalogItemId or providerId")

        ds = WorkspaceDataSourceORM(
            workspace_id=ws.id,
            catalog_item_id=ds_req.catalog_item_id,
            provider_id=provider_id,
            graph_name=graph_name,
            ontology_id=ds_req.ontology_id,
            label=label,
            is_primary=(i == 0),  # first data source is primary by default
            is_active=True,
        )
        session.add(ds)

    await session.flush()

    # Reload with data_sources
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == ws.id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row)


async def update_workspace(
    session: AsyncSession,
    workspace_id: str,
    req: WorkspaceUpdateRequest,
) -> Optional[WorkspaceResponse]:
    row = await get_workspace_orm(session, workspace_id)
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.publish_policy is not None:
        if req.publish_policy not in ("request", "open"):
            raise ValueError("publishPolicy must be 'request' or 'open'")
        row.publish_policy = req.publish_policy

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_workspace(
    session: AsyncSession, workspace_id: str
) -> bool:
    result = await session.execute(
        delete(WorkspaceORM).where(WorkspaceORM.id == workspace_id)
    )
    return result.rowcount > 0


async def set_default(
    session: AsyncSession, workspace_id: str
) -> bool:
    """Demote all others, then promote target."""
    await session.execute(
        update(WorkspaceORM).values(is_default=False)
    )
    result = await session.execute(
        update(WorkspaceORM)
        .where(WorkspaceORM.id == workspace_id)
        .values(is_default=True, updated_at=datetime.now(timezone.utc).isoformat())
    )
    return result.rowcount > 0


async def get_workspace_impact(
    session: AsyncSession, workspace_id: str,
) -> "WorkspaceImpactResponse":
    """The blast radius of DELETING a workspace.

    This is not "what is inside the container". Deleting a workspace CASCADES:
    ``views.workspace_id`` is ON DELETE CASCADE, so its views are HARD-deleted —
    they never reach the soft-delete/restore path the Explorer uses, and no
    "Restore" will bring them back. The endpoint reports what will actually be
    destroyed so the dialog can say it before the click, not after.

    Deleted (soft-deleted) views are counted too: the cascade removes those rows
    as well, so a view someone expected to restore later also disappears.
    """
    from backend.common.models.management import (
        ImpactedEntity,
        WorkspaceImpactResponse,
    )

    views = (await session.execute(
        select(ViewORM.id, ViewORM.name)
        .where(ViewORM.workspace_id == workspace_id)
        .order_by(ViewORM.name)
    )).all()

    sources = (await session.execute(
        select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )).all()

    member_count = (await session.execute(
        select(func.count())
        .select_from(RoleBindingORM)
        .where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id == workspace_id,
        )
    )).scalar_one()

    role_count = (await session.execute(
        select(func.count())
        .select_from(RoleORM)
        .where(
            RoleORM.scope_type == "workspace",
            RoleORM.scope_id == workspace_id,
        )
    )).scalar_one()

    return WorkspaceImpactResponse(
        views=[ImpactedEntity(id=v.id, name=v.name, type="view") for v in views],
        dataSources=[
            ImpactedEntity(id=d.id, name=d.label or d.id, type="data_source")
            for d in sources
        ],
        memberCount=int(member_count or 0),
        customRoleCount=int(role_count or 0),
    )
