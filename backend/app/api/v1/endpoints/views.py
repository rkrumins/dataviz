"""
Saved views and assignment rule-set endpoints.

All resources are scoped to a specific registered connection so that
different graph databases can have independent view/layer configurations.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import connection_repo, assignment_repo
from backend.common.models.management import (
    RuleSetCreateRequest,
    RuleSetResponse,
    SavedViewCreateRequest,
    SavedViewResponse,
)

router = APIRouter()


async def _require_connection(session: AsyncSession, connection_id: str) -> None:
    if not await connection_repo.get_connection(session, connection_id):
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")


# ------------------------------------------------------------------ #
# Assignment Rule Sets                                                #
# ------------------------------------------------------------------ #

@router.get("/rule-sets", response_model=List[RuleSetResponse])
async def list_rule_sets(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List all assignment rule sets for this connection."""
    await _require_connection(session, connection_id)
    return await assignment_repo.list_rule_sets(session, connection_id)


@router.post("/rule-sets", response_model=RuleSetResponse, status_code=201)
async def create_rule_set(
    connection_id: str = Path(...),
    req: RuleSetCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new assignment rule set for this connection."""
    await _require_connection(session, connection_id)
    return await assignment_repo.create_rule_set(session, connection_id, req)


@router.get("/rule-sets/{rule_set_id}", response_model=RuleSetResponse)
async def get_rule_set(
    connection_id: str = Path(...),
    rule_set_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single assignment rule set."""
    await _require_connection(session, connection_id)
    rs = await assignment_repo.get_rule_set(session, rule_set_id)
    if not rs:
        raise HTTPException(status_code=404, detail=f"Rule set '{rule_set_id}' not found")
    return rs


@router.put("/rule-sets/{rule_set_id}", response_model=RuleSetResponse)
async def update_rule_set(
    connection_id: str = Path(...),
    rule_set_id: str = Path(...),
    req: RuleSetCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Replace an existing assignment rule set."""
    await _require_connection(session, connection_id)
    rs = await assignment_repo.update_rule_set(session, rule_set_id, req)
    if not rs:
        raise HTTPException(status_code=404, detail=f"Rule set '{rule_set_id}' not found")
    return rs


@router.delete("/rule-sets/{rule_set_id}", status_code=204)
async def delete_rule_set(
    connection_id: str = Path(...),
    rule_set_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete an assignment rule set."""
    await _require_connection(session, connection_id)
    deleted = await assignment_repo.delete_rule_set(session, rule_set_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Rule set '{rule_set_id}' not found")


@router.post("/rule-sets/{rule_set_id}/apply")
async def apply_rule_set(
    connection_id: str = Path(...),
    rule_set_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Mark a rule set as default and return a confirmation.

    The actual assignment computation is triggered client-side via
    ``POST /assignments/compute`` using the saved layers_config.
    """
    await _require_connection(session, connection_id)
    from backend.app.db.repositories.assignment_repo import RuleSetCreateRequest as _RSReq
    rs = await assignment_repo.get_rule_set(session, rule_set_id)
    if not rs:
        raise HTTPException(status_code=404, detail=f"Rule set '{rule_set_id}' not found")
    # Promote to default
    update_req = RuleSetCreateRequest(
        name=rs.name,
        description=rs.description,
        is_default=True,
        layers_config=rs.layersConfig,
    )
    updated = await assignment_repo.update_rule_set(session, rule_set_id, update_req)
    return {"status": "applied", "ruleSetId": rule_set_id, "isDefault": updated.isDefault}


# ------------------------------------------------------------------ #
# Saved Views                                                        #
# ------------------------------------------------------------------ #

@router.get("/views", response_model=List[SavedViewResponse])
async def list_views(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List all saved views for this connection (most recently updated first)."""
    await _require_connection(session, connection_id)
    return await assignment_repo.list_views(session, connection_id)


@router.post("/views", response_model=SavedViewResponse, status_code=201)
async def create_view(
    connection_id: str = Path(...),
    req: SavedViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new saved view for this connection."""
    await _require_connection(session, connection_id)
    return await assignment_repo.create_view(session, connection_id, req)


@router.get("/views/{view_id}", response_model=SavedViewResponse)
async def get_view(
    connection_id: str = Path(...),
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single saved view."""
    await _require_connection(session, connection_id)
    view = await assignment_repo.get_view(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.put("/views/{view_id}", response_model=SavedViewResponse)
async def update_view(
    connection_id: str = Path(...),
    view_id: str = Path(...),
    req: SavedViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Replace an existing saved view."""
    await _require_connection(session, connection_id)
    view = await assignment_repo.update_view(session, view_id, req)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.delete("/views/{view_id}", status_code=204)
async def delete_view(
    connection_id: str = Path(...),
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a saved view."""
    await _require_connection(session, connection_id)
    deleted = await assignment_repo.delete_view(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
