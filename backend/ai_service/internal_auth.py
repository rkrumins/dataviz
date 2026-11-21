"""Who is calling the AI service, and on whose behalf.

The web tier is the only edge (ADR-031). It authenticates the person — a
browser session or an API key — checks the switch and the permission, and
forwards the request here with:

* ``Authorization: Bearer <AI_INTERNAL_TOKEN>`` — proof the caller is the web
  tier (the aggregation control plane's pattern, ADR-019): required in
  production, a loud warning elsewhere;
* ``X-AI-Delegation: nxdlg_…`` — the person's read-only delegation, which
  every call this service makes back to the platform presents;
* ``X-AI-User-Id`` / ``-Name`` / ``-Email`` — who they are, for wording and
  for "my" in a question ("datasets I own");
* ``X-AI-Admin: 1`` — set only on the administration routes, which the web
  tier gates on ``system:admin`` before forwarding;
* the activity headers (``X-Activity-Actor`` and the rest).

Nothing here re-checks permissions: the edge did, and the delegation carries
them to every read. What this module guarantees is that a request without
the internal token never gets that far.
"""
from __future__ import annotations

import hmac
import logging
import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import unquote

from fastapi import HTTPException, Request, status

from backend.app.common import activity_context

logger = logging.getLogger(__name__)

INTERNAL_TOKEN_ENV = "AI_INTERNAL_TOKEN"
DELEGATION_HEADER = "X-AI-Delegation"
USER_ID_HEADER = "X-AI-User-Id"
USER_NAME_HEADER = "X-AI-User-Name"
USER_EMAIL_HEADER = "X-AI-User-Email"
ADMIN_HEADER = "X-AI-Admin"
ORIGIN_HEADER = "X-AI-Origin"  # browser | api_key
#: ``view`` when the person reaches the view only through a share, not its
#: workspace: the platform keeps every read inside that view.
REACH_HEADER = "X-AI-Reach"

_EXEMPT_PATHS = frozenset({"/health", "/metrics"})


def get_internal_token() -> Optional[str]:
    token = os.getenv(INTERNAL_TOKEN_ENV, "").strip()
    return token or None


def internal_auth_headers() -> dict[str, str]:
    """What the web tier attaches to reach this service."""
    token = get_internal_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def assert_auth_mode_allowed() -> None:
    """Refuse to start unauthenticated in production; warn elsewhere."""
    if get_internal_token():
        logger.info("AI service internal auth ENABLED")
        return
    message = (
        f"AI service internal auth is DISABLED: {INTERNAL_TOKEN_ENV} is unset, so "
        "anything that can reach this port can ask questions as anyone whose "
        "delegation it holds, and read the AI administration routes."
    )
    if os.getenv("ENV", "dev").strip().lower() in ("prod", "production"):
        raise RuntimeError(message + f" Set {INTERNAL_TOKEN_ENV} before deploying.")
    logger.warning("%s This is a dev-only mode.", message)


@dataclass(frozen=True)
class Caller:
    """The person a request is for, as the web tier vouched."""

    user_id: str
    display_name: str
    email: str
    delegation: str
    is_admin: bool = False
    origin: str = "browser"
    view_only: bool = False


def _header(request: Request, name: str, limit: int = 320) -> str:
    raw = request.headers.get(name) or ""
    return activity_context.clean_text(unquote(raw), limit) or ""


async def require_internal_token(request: Request) -> None:
    """Every route but the probes needs the web tier's token (when one is set)."""
    if request.url.path in _EXEMPT_PATHS:
        return
    expected = get_internal_token()
    if expected is None:
        return
    header = request.headers.get("authorization") or ""
    provided = header[len("Bearer "):].strip() if header.startswith("Bearer ") else ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "internal_auth", "message": "Invalid or missing internal token."},
        )


async def bind_forwarded_activity(request: Request):
    token = activity_context.bind(activity_context.from_forwarded(request.headers))
    try:
        yield
    finally:
        activity_context.reset(token)


def caller(request: Request) -> Caller:
    """The person this request is for. 401 when the web tier sent none."""
    user_id = _header(request, USER_ID_HEADER, 128)
    delegation = (request.headers.get(DELEGATION_HEADER) or "").strip()
    if not user_id or not delegation:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "no_caller", "message": "No person to answer for."},
        )
    return Caller(
        user_id=user_id,
        display_name=_header(request, USER_NAME_HEADER, 200),
        email=_header(request, USER_EMAIL_HEADER, 320),
        delegation=delegation,
        is_admin=(request.headers.get(ADMIN_HEADER) == "1"),
        origin=(request.headers.get(ORIGIN_HEADER) or "browser")[:16],
        view_only=(request.headers.get(REACH_HEADER) == "view"),
    )


def admin_caller(request: Request) -> Caller:
    """A caller on an administration route — the web tier checked
    ``system:admin`` and said so."""
    who = caller(request)
    if not who.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "not_admin", "message": "AI administration needs an administrator."},
        )
    return who
