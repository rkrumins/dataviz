"""People's profiles.

Routes (mounted from ``api.py`` at ``/people``):

  GET   /{user_id}   who they are, the workspaces they run and the data they are a
                     contact for — only what the reader can open (404 for a service
                     account or an id that names nobody)

The views someone made: ``GET /views?createdBy=``. Rules:
``backend.app.services.discussions.profiles``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.services.discussions import access, profiles
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.discussions import ProfileResponse

router = APIRouter()


@router.get("/{user_id}", response_model=ProfileResponse, response_model_by_alias=True)
async def get_profile(
    user_id: str = Path(..., max_length=200),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await profiles.profile(session, access.Caller(user=user, claims=claims), user_id)
