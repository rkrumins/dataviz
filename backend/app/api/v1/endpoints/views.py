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
    ViewListResponse,
    ViewFacetsResponse,
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


@router.get("/facets", response_model=ViewFacetsResponse)
async def get_view_facets(
    session: AsyncSession = Depends(get_db_session),
) -> ViewFacetsResponse:
    """Return distinct tags, view types, and creators across non-deleted views.

    Used to populate the Explorer's Tag / View Type / Creator filter
    dropdowns from the authoritative DB-wide set of values rather than
    deriving them from the currently-loaded page (which would miss
    tags/creators beyond the first page at scale).
    """
    return await view_repo.get_view_facets(session)


@router.get("/", response_model=ViewListResponse)
async def list_views(
    visibility: Optional[str] = Query(None),
    visibility_in: Optional[List[str]] = Query(None, alias="visibilityIn"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceIds"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    view_type: Optional[str] = Query(None, alias="viewType"),
    view_types: Optional[List[str]] = Query(None, alias="viewTypes"),
    created_by: Optional[str] = Query(None, alias="createdBy"),
    created_by_in: Optional[List[str]] = Query(None, alias="createdByIn"),
    created_after: Optional[str] = Query(None, alias="createdAfter"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    attention_only: bool = Query(False, alias="attentionOnly"),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
) -> ViewListResponse:
    """List accessible views as a paginated envelope.

    Returns ``{ items, total, hasMore, nextOffset }``. ``total`` is the
    authoritative count of matches so callers never have to infer "is
    there another page?" from array length.

    Filter params (single/multi pairs — the multi-value param wins when both are sent):
    - ``workspaceId`` / ``workspaceIds``
    - ``visibility`` / ``visibilityIn``
    - ``viewType`` / ``viewTypes``
    - ``createdBy`` / ``createdByIn``

    Additional filters:
    - ``createdAfter`` — ISO timestamp; returns views created on or after.
    - ``tags`` — OR semantics across the supplied tags.
    - ``attentionOnly`` — stale (>90d), inactive workspace/source, or
      broken data source reference. Mirrors the frontend health model
      so pagination stays accurate on large catalogs.
    """
    return await view_repo.list_views_filtered(
        session,
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_after=created_after,
        search=search,
        tags=tags,
        limit=limit,
        offset=offset,
        user_id=_user_id(user),
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
    )


@router.post("/", response_model=ViewResponse, status_code=201)
async def create_view(
    req: ViewCreateRequest = Body(...),
    user=Depends(get_optional_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspaceId is required.

    Captures the current ontology digest on the new row so later edits
    can detect ontology drift. Records created_by as the authenticated
    user's ID so views can be filtered by creator in the Explorer.
    """
    digest = await _compute_ontology_digest(
        session, req.workspace_id, req.data_source_id,
    )
    return await view_repo.create_view(
        session, req, ontology_digest=digest, user_id=_user_id(user),
    )


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
