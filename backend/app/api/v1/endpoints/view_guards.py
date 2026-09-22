"""Load a view for a caller, enforcing the same access rules as the core views routes.

The versions and transfer routers act on views too. They reuse ``views.py``'s loader and the
``view_access`` evaluator through these two functions rather than restating the rules, so the
answer to "may this person read / edit this view" has one definition.
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.views import _load_view_orm, _viewer_context
from backend.app.auth.dependencies import rbac_flag
from backend.app.db.models import ViewORM
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


async def readable_view(
    session: AsyncSession, view_id: str, user: Optional[User], claims: PermissionClaims,
) -> ViewORM:
    """The view, or 404 when it doesn't exist or the caller can't read it.

    404 rather than 403 for an unreadable view, like ``GET /views/{id}``, so a view's existence
    stays private from people with no access path to it.
    """
    view = await _load_view_orm(session, view_id)
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_read_view(session, ctx, view):
            raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


async def editable_view(
    session: AsyncSession, view_id: str, user: Optional[User], claims: PermissionClaims,
) -> ViewORM:
    """The view, or 404 when unreadable and 403 when readable but not editable."""
    view = await readable_view(session, view_id, user, claims)
    if rbac_flag("RBAC_ENFORCE_VIEWS"):
        ctx = await _viewer_context(session, user, claims)
        if not await view_access.can_edit_view(session, ctx, view):
            raise HTTPException(status_code=403, detail="Missing permission: workspace:view:edit")
    return view
