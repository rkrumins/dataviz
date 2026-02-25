"""
Admin Blueprint endpoints — CRUD for ontology blueprints.
Blueprints are standalone, versioned, reusable semantic configurations.
Published blueprints are immutable; updates create new versions.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import blueprint_repo
from backend.common.models.management import (
    BlueprintCreateRequest,
    BlueprintUpdateRequest,
    BlueprintResponse,
)

router = APIRouter()


@router.get("", response_model=List[BlueprintResponse])
async def list_blueprints(
    all_versions: bool = False,
    session: AsyncSession = Depends(get_db_session),
):
    """List blueprints. By default returns only the latest version of each."""
    if all_versions:
        return await blueprint_repo.list_blueprints(session)
    return await blueprint_repo.list_latest_blueprints(session)


@router.post("", response_model=BlueprintResponse, status_code=201)
async def create_blueprint(
    req: BlueprintCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new blueprint (starts at version 1, unpublished)."""
    return await blueprint_repo.create_blueprint(session, req)


@router.get("/{blueprint_id}", response_model=BlueprintResponse)
async def get_blueprint(
    blueprint_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a specific blueprint by ID."""
    bp = await blueprint_repo.get_blueprint(session, blueprint_id)
    if not bp:
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found")
    return bp


@router.put("/{blueprint_id}", response_model=BlueprintResponse)
async def update_blueprint(
    blueprint_id: str = Path(...),
    req: BlueprintUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Update a blueprint. If published, creates a new version instead.
    Returns the updated or newly created blueprint.
    """
    bp = await blueprint_repo.update_blueprint(session, blueprint_id, req)
    if not bp:
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found")
    return bp


@router.delete("/{blueprint_id}", status_code=204)
async def delete_blueprint(
    blueprint_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a blueprint. Rejects if workspaces still reference it."""
    if await blueprint_repo.has_workspaces(session, blueprint_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete blueprint: one or more workspaces still reference it.",
        )
    deleted = await blueprint_repo.delete_blueprint(session, blueprint_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found")


@router.post("/{blueprint_id}/publish", response_model=BlueprintResponse)
async def publish_blueprint(
    blueprint_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Mark a blueprint as published (immutable after this)."""
    bp = await blueprint_repo.publish_blueprint(session, blueprint_id)
    if not bp:
        raise HTTPException(status_code=404, detail=f"Blueprint '{blueprint_id}' not found")
    return bp
