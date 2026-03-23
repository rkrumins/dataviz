"""
Enterprise Catalog endpoints — CRUD for data products (Catalog Items).
Catalog Items abstract a physical provider's namespace (e.g. graph) into a manageable entity.
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.db.repositories import catalog_repo, provider_repo
from backend.common.models.management import (
    CatalogItemCreateRequest,
    CatalogItemUpdateRequest,
    CatalogItemResponse,
    ProviderImpactResponse,
)

router = APIRouter()


class CatalogItemBindingResponse(BaseModel):
    id: str
    provider_id: str = Field(alias="providerId")
    source_identifier: Optional[str] = Field(None, alias="sourceIdentifier")
    name: str
    bound_workspace_id: Optional[str] = Field(None, alias="boundWorkspaceId")
    bound_workspace_name: Optional[str] = Field(None, alias="boundWorkspaceName")

    class Config:
        populate_by_name = True


@router.get("", response_model=List[CatalogItemResponse])
async def list_catalog_items(
    provider_id: Optional[str] = Query(None, alias="providerId"),
    session: AsyncSession = Depends(get_db_session),
):
    """List all registered catalog items (optionally filtered by provider)."""
    return await catalog_repo.list_catalog_items(session, provider_id)


@router.post("", response_model=CatalogItemResponse, status_code=201)
async def create_catalog_item(
    req: CatalogItemCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a raw provider namespace/graph into a Catalog Item."""
    if not await provider_repo.get_provider(session, req.provider_id):
        raise HTTPException(status_code=404, detail=f"Provider '{req.provider_id}' not found")

    return await catalog_repo.create_catalog_item(session, req)


@router.post("/cleanup", status_code=200)
async def cleanup_duplicates(
    session: AsyncSession = Depends(get_db_session),
):
    """Remove duplicate catalog items (keeps earliest per provider+source). Returns count deleted."""
    deleted = await catalog_repo.cleanup_duplicate_catalog_items(session)
    return {"deleted": deleted}


@router.get("/bindings", response_model=List[CatalogItemBindingResponse])
async def list_catalog_bindings(
    provider_id: Optional[str] = Query(None, alias="providerId"),
    session: AsyncSession = Depends(get_db_session),
):
    """Return catalog items enriched with their workspace binding (if any).
    Each catalog item can be bound to at most one workspace (1:1 constraint).
    """
    from backend.app.db.models import CatalogItemORM, WorkspaceORM

    stmt = (
        select(
            CatalogItemORM.id,
            CatalogItemORM.provider_id,
            CatalogItemORM.source_identifier,
            CatalogItemORM.name,
            WorkspaceDataSourceORM.workspace_id,
            WorkspaceORM.name.label("workspace_name"),
        )
        .outerjoin(
            WorkspaceDataSourceORM,
            CatalogItemORM.id == WorkspaceDataSourceORM.catalog_item_id,
        )
        .outerjoin(
            WorkspaceORM,
            WorkspaceDataSourceORM.workspace_id == WorkspaceORM.id,
        )
    )
    if provider_id:
        stmt = stmt.where(CatalogItemORM.provider_id == provider_id)
    stmt = stmt.order_by(CatalogItemORM.created_at)

    result = await session.execute(stmt)
    return [
        CatalogItemBindingResponse(
            id=row.id,
            providerId=row.provider_id,
            sourceIdentifier=row.source_identifier,
            name=row.name,
            boundWorkspaceId=row.workspace_id,
            boundWorkspaceName=row.workspace_name,
        )
        for row in result.all()
    ]


@router.get("/{item_id}", response_model=CatalogItemResponse)
async def get_catalog_item(
    item_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single catalog item."""
    item = await catalog_repo.get_catalog_item(session, item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item '{item_id}' not found")
    return item


@router.put("/{item_id}", response_model=CatalogItemResponse)
async def update_catalog_item(
    item_id: str = Path(...),
    req: CatalogItemUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a catalog item (name, description, ACLs, status)."""
    item = await catalog_repo.update_catalog_item(session, item_id, req)
    if not item:
        raise HTTPException(status_code=404, detail=f"Catalog item '{item_id}' not found")
    # Note: If ACLs change such that workspaces lose access, 
    # the application layer might need to handle evaluating active subscriptions.
    return item


@router.delete("/{item_id}", status_code=204)
async def delete_catalog_item(
    item_id: str = Path(...),
    force: bool = Query(False),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a catalog item. Rejects if workspaces are still subscribed unless force=true."""
    from backend.app.db.models import WorkspaceDataSourceORM
    from sqlalchemy import select, delete as sa_delete

    if not force:
        # Check for active subscriptions
        result = await session.execute(
            select(WorkspaceDataSourceORM.id)
            .where(WorkspaceDataSourceORM.catalog_item_id == item_id)
            .limit(1)
        )
        if result.scalar_one_or_none():
             raise HTTPException(
                status_code=409,
                detail="Cannot delete catalog item: one or more workspaces still subscribe to it. Use force=true to override.",
            )
    else:
        # Force mode: de-allocate from all workspaces first
        await session.execute(
            sa_delete(WorkspaceDataSourceORM)
            .where(WorkspaceDataSourceORM.catalog_item_id == item_id)
        )

    deleted = await catalog_repo.delete_catalog_item(session, item_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Catalog item '{item_id}' not found")

@router.get("/{item_id}/impact", response_model=ProviderImpactResponse)
async def get_catalog_item_impact(
    item_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session)
):
    item = await catalog_repo.get_catalog_item_orm(session, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Catalog item not found")
    return await catalog_repo.get_catalog_item_impact(session, item_id)
