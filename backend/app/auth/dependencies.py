"""
FastAPI dependency functions for authentication and authorization.

These are thin adapters that read the session cookie off the incoming
request and delegate to the application's ``IdentityService``. The
service does all the work — these helpers only translate auth failure
into the right HTTP status.

When the auth service is extracted into its own process, only the
``IdentityService`` implementation on ``app.state`` changes — every call
site (``Depends(get_current_user)``, etc.) keeps working unchanged.
"""
from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, Request, status

from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.interface import IdentityService, User

logger = logging.getLogger(__name__)


def _identity_service(request: Request) -> IdentityService:
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state — see backend/app/main.py"
        )
    return svc


async def get_current_user(request: Request) -> User:
    """Return the authenticated user or raise 401.

    The access token is read from the ``nx_access`` HttpOnly cookie set
    by /api/v1/auth/login.
    """
    user = await _identity_service(request).validate_session(read_access_cookie(request))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return user


async def get_optional_user(request: Request) -> User | None:
    """Like ``get_current_user`` but returns ``None`` instead of raising 401.

    Useful for endpoints that work for both authenticated and anonymous
    users (e.g. created_by attribution that defaults to a sentinel).
    """
    return await _identity_service(request).validate_session(read_access_cookie(request))


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """Require that the authenticated user has the 'admin' role.

    Raises 403 otherwise. The role is materialised on the User DTO at
    session-validation time, so this check is purely in-memory.
    """
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user
