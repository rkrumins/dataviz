"""Questions and conversations about views and data sources.

Routes (mounted from ``api.py`` at ``/discussions``):

  GET    /subjects/{type}/{id}/people          who to ask: view owners, data contacts, fallback

Every route answers 404 ``not_found`` for a subject the caller can't open. What is
decided where: ``backend.app.services.discussions``.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.services.discussions import access, routing
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.discussions import WhoToAskResponse

router = APIRouter()

SubjectPath = Literal["view", "data_source"]


def _caller(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> access.Caller:
    return access.Caller(user=user, claims=claims)


@router.get("/subjects/{subject_type}/{subject_id}/people", response_model=WhoToAskResponse,
            response_model_by_alias=True)
async def who_to_ask(
    subject_type: SubjectPath = Path(...),
    subject_id: str = Path(...),
    caller: access.Caller = Depends(_caller),
    session: AsyncSession = Depends(get_db_session),
):
    """The people to ask about this view or data source, and whether each can open it."""
    subject = await access.readable_subject(session, caller, subject_type, subject_id)
    readers = await access.readers_of(session, subject)
    return await routing.present(session, await routing.who_to_ask(session, subject, readers))
