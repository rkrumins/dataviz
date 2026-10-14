"""Saved filters: a person's named Explorer filter sets, kept on the server so
they follow the person to any browser.

Mounted at ``/views/saved-filters`` BEFORE ``views.router`` (api.py), so no
``/views/{view_id}`` route can take "saved-filters" for a view id. Every route
is the signed-in caller's own — ``saved_view_filter_repo`` reaches only their
rows — and nothing here is an admin path: an administrator sees their own
filters like anyone else.
"""
from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import saved_view_filter_repo as repo
from backend.auth_service.interface import User
from backend.common.models.management import (
    SavedViewFilterCreateRequest,
    SavedViewFilterOrderRequest,
    SavedViewFilterResponse,
    SavedViewFilterUpdateRequest,
)

router = APIRouter()

# Someone else's filter answers exactly as one that does not exist, so an id
# never tells anyone whose it is.
_NOT_FOUND = "Saved filter not found"


def _out(row) -> SavedViewFilterResponse:
    return SavedViewFilterResponse(
        id=row.id, name=row.name, query=row.query, position=row.position,
        created_at=row.created_at, updated_at=row.updated_at,
    )


@router.get("", response_model=List[SavedViewFilterResponse])
async def list_saved_filters(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> List[SavedViewFilterResponse]:
    """The caller's saved filters, in their order."""
    return [_out(row) for row in await repo.list_filters(session, user.id)]


@router.post("", response_model=SavedViewFilterResponse, status_code=201)
async def create_saved_filter(
    body: SavedViewFilterCreateRequest = Body(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> SavedViewFilterResponse:
    """Save a filter last in the caller's list."""
    try:
        row = await repo.create_filter(session, user.id, name=body.name, query=body.query)
    except repo.SavedFilterError as err:
        raise HTTPException(status_code=err.status, detail=err.detail)
    return _out(row)


# Declared before ``/{filter_id}``, which would otherwise take "order" for an id.
@router.put("/order", response_model=List[SavedViewFilterResponse])
async def reorder_saved_filters(
    body: SavedViewFilterOrderRequest = Body(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> List[SavedViewFilterResponse]:
    """Put every one of the caller's filters in a new order."""
    try:
        rows = await repo.reorder_filters(session, user.id, body.ids)
    except repo.SavedFilterError as err:
        raise HTTPException(status_code=err.status, detail=err.detail)
    return [_out(row) for row in rows]


@router.put("/{filter_id}", response_model=SavedViewFilterResponse)
async def update_saved_filter(
    filter_id: str = Path(...),
    body: SavedViewFilterUpdateRequest = Body(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> SavedViewFilterResponse:
    """Rename a filter, replace its query, or both."""
    try:
        row = await repo.update_filter(
            session, user.id, filter_id, name=body.name, query=body.query,
        )
    except repo.SavedFilterError as err:
        raise HTTPException(status_code=err.status, detail=err.detail)
    if row is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return _out(row)


@router.delete("/{filter_id}", status_code=204)
async def delete_saved_filter(
    filter_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """Delete a filter; the ones after it move up."""
    if not await repo.delete_filter(session, user.id, filter_id):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return Response(status_code=204)
