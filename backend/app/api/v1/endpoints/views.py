"""
View endpoints (top-level, cross-workspace).

Views are visual renderings of context models (or ad-hoc graphs).
Mounted at /api/v1/views
"""
import logging
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import view_repo
from backend.app.auth.dependencies import get_optional_user
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine
from backend.common.models.management import (
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Fallback user_id when no auth token is present (backward compatibility).
_ANONYMOUS_USER = "anonymous"


def _user_id(user) -> str:
    """Extract user_id from the optional user dependency, or fall back to anonymous."""
    return user.id if user else _ANONYMOUS_USER


async def _compute_ontology_digest(
    session: AsyncSession,
    workspace_id: Optional[str],
    data_source_id: Optional[str],
) -> Optional[str]:
    """Resolve the active ontology for a view's scope and return its digest.

    Best-effort: if the engine can't be built (no workspace, provider down,
    unresolvable ontology), returns None so the caller stores NULL — the
    wizard treats NULL as "drift check unavailable" and just skips the
    banner. Drift detection is a UX feature, never a save blocker.
    """
    if not workspace_id:
        return None
    try:
        engine = await ContextEngine.for_workspace(
            workspace_id, provider_registry, session, data_source_id=data_source_id,
        )
        return await engine.get_ontology_digest()
    except Exception as exc:
        logger.warning(
            "Ontology digest computation failed for ws=%s ds=%s: %s",
            workspace_id, data_source_id, exc,
        )
        return None


@router.get("/popular", response_model=List[ViewResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited enterprise-visible views."""
    return await view_repo.list_popular_views(
        session, limit=limit, user_id=_user_id(user),
    )


@router.get("/", response_model=List[ViewResponse])
async def list_views(
    visibility: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """List accessible views with optional filtering."""
    return await view_repo.list_views_filtered(
        session,
        visibility=visibility,
        workspace_id=workspace_id,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        search=search,
        tags=tags,
        limit=limit,
        offset=offset,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
    )


@router.post("/", response_model=ViewResponse, status_code=201)
async def create_view(
    req: ViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspaceId is required.

    Captures the current ontology digest on the new row so later edits
    can detect ontology drift.
    """
    digest = await _compute_ontology_digest(
        session, req.workspace_id, req.data_source_id,
    )
    return await view_repo.create_view(session, req, ontology_digest=digest)


@router.get("/{view_id}", response_model=ViewResponse)
async def get_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single view by ID, enriched with workspace context and favourite data."""
    view = await view_repo.get_view_enriched(
        session, view_id, user_id=_user_id(user),
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.put("/{view_id}", response_model=ViewResponse)
async def update_view(
    view_id: str = Path(...),
    req: ViewUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing view.

    Refreshes the stored ontology digest to the CURRENT ontology state so
    subsequent edits will flag drift only for changes that happen after
    this save — every explicit save resets the drift baseline.
    """
    existing = await view_repo.get_view(session, view_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    digest = await _compute_ontology_digest(
        session, existing.workspace_id, existing.data_source_id,
    )
    view = await view_repo.update_view(session, view_id, req, ontology_digest=digest)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.delete("/{view_id}", status_code=204)
async def delete_view(
    view_id: str = Path(...),
    permanent: bool = Query(False),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a view. Soft-deletes by default; pass ?permanent=true to remove from DB."""
    if permanent:
        deleted = await view_repo.permanently_delete_view(session, view_id)
    else:
        deleted = await view_repo.delete_view(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")


@router.post("/{view_id}/restore", response_model=ViewResponse)
async def restore_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Restore a soft-deleted view."""
    restored = await view_repo.restore_view(session, view_id)
    if not restored:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found or not deleted")
    view = await view_repo.get_view_enriched(session, view_id, user_id=_user_id(user))
    return view


@router.put("/{view_id}/visibility", response_model=ViewResponse)
async def update_view_visibility(
    view_id: str = Path(...),
    visibility: str = Body(..., embed=True),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Change the visibility of a view (private | workspace | enterprise)."""
    if visibility not in ("private", "workspace", "enterprise"):
        raise HTTPException(status_code=422, detail="visibility must be one of: private, workspace, enterprise")
    view = await view_repo.update_visibility(
        session, view_id, visibility, user_id=_user_id(user),
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user."""
    view = await view_repo.get_view(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    created = await view_repo.favourite_view(session, view_id, _user_id(user))
    return {"favourited": True, "created": created}


@router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str = Path(...),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user."""
    removed = await view_repo.unfavourite_view(session, view_id, _user_id(user))
    if not removed:
        raise HTTPException(status_code=404, detail="Favourite not found")
