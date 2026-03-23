"""
FastAPI dependency functions for authentication and authorization.

Usage in endpoints:
    @router.get("/me")
    async def me(user = Depends(get_current_user)):
        ...

    @router.get("/admin/users")
    async def list_users(user = Depends(require_admin)):
        ...
"""
import logging

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from .jwt import decode_token

logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl="/api/v1/auth/login",
    auto_error=False,
)


async def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Decode the JWT, load the user from the DB, and return the ORM object.
    Raises 401 if the token is missing, invalid, expired, or the user is
    not active.
    """
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id: str | None = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    user = await user_repo.get_user_by_id(session, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    if user.status != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is not active",
        )
    return user


async def get_optional_user(
    token: str | None = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Like get_current_user but returns None when no token is present,
    instead of raising 401.  Useful for endpoints that work for both
    authenticated and anonymous users.
    """
    if token is None:
        return None
    try:
        return await get_current_user(token=token, session=session)
    except HTTPException:
        return None


async def require_admin(
    user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Require that the authenticated user has the 'admin' role.
    Raises 403 otherwise.
    """
    roles = await user_repo.get_user_roles(session, user.id)
    if "admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user
