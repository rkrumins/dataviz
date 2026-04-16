"""
Cookie-based authentication endpoints.

Mounted at ``/api/v1/auth/`` alongside the legacy router (which still owns
signup, password reset, and invite verification — those endpoints don't
issue session cookies). All endpoints here go through the
``IdentityService`` on ``request.app.state``, so swapping the in-process
implementation for an HTTP client only requires touching app startup.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..cookies import (
    clear_session_cookies,
    read_access_cookie,
    read_refresh_cookie,
    set_session_cookies,
)
from ..interface import (
    IdentityService,
    InvalidCredentials,
    InvalidRefreshToken,
    User,
)

logger = logging.getLogger(__name__)

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


# ── Request / response models ─────────────────────────────────────────

class LoginBody(BaseModel):
    email: str
    password: str


class SessionResponse(BaseModel):
    """Returned by /login and /me. The access token lives in the
    ``nx_access`` cookie — never in the response body."""
    model_config = ConfigDict(populate_by_name=True)
    user: User


class _Ack(BaseModel):
    """Tiny ack body for /logout and /refresh so clients can switch on it."""
    ok: bool = True


# ── Helpers ───────────────────────────────────────────────────────────

def _identity_service(request: Request) -> IdentityService:
    """Pull the configured IdentityService off the app. Configured in main.py."""
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state. "
            "Set it during startup (see backend/app/main.py)."
        )
    return svc


# ── POST /auth/login ──────────────────────────────────────────────────

@router.post(
    "/login",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
@limiter.limit("10/minute")
async def login(
    request: Request,
    response: Response,
    body: LoginBody,
):
    """Authenticate by email + password.

    On success: sets ``nx_access``, ``nx_refresh``, and ``nx_csrf`` cookies
    and returns ``{ user }``. The access token is never in the response body.
    """
    svc = _identity_service(request)
    try:
        user, tokens = await svc.login(body.email, body.password)
    except InvalidCredentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    set_session_cookies(response, tokens)
    logger.info("Login succeeded for user=%s", user.id)
    return SessionResponse(user=user)


# ── POST /auth/logout ─────────────────────────────────────────────────

@router.post("/logout", response_model=_Ack)
async def logout(request: Request, response: Response):
    """Revoke the refresh-token family and clear all session cookies.

    Idempotent: returning ``ok=true`` regardless of whether a session was
    present so clients can call this freely (e.g. on every app boot).
    """
    svc = _identity_service(request)
    refresh = read_refresh_cookie(request)
    await svc.logout(refresh)
    clear_session_cookies(response)
    return _Ack()


# ── POST /auth/refresh ────────────────────────────────────────────────

@router.post(
    "/refresh",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
@limiter.limit("30/minute")
async def refresh(request: Request, response: Response):
    """Rotate the refresh token and reissue access + refresh + CSRF cookies.

    Returns the current ``user`` so the frontend can keep its in-memory
    profile fresh on long-lived tabs.
    """
    svc = _identity_service(request)
    token = read_refresh_cookie(request)
    if not token:
        clear_session_cookies(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )
    try:
        user, tokens = await svc.refresh(token)
    except InvalidRefreshToken as exc:
        clear_session_cookies(response)
        logger.info("Refresh rejected: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token invalid or expired",
        )

    set_session_cookies(response, tokens)
    return SessionResponse(user=user)


# ── GET /auth/me ──────────────────────────────────────────────────────

@router.get(
    "/me",
    response_model=SessionResponse,
    response_model_by_alias=True,
)
async def me(request: Request):
    """Validate the access cookie and return the current user.

    The frontend calls this on app boot to determine whether to render
    the dashboard (200) or redirect to /login (401).
    """
    svc = _identity_service(request)
    user = await svc.validate_session(read_access_cookie(request))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return SessionResponse(user=user)
