"""Endpoints under ``/api/v1/me`` — current-user introspection.

Phase 1 ships ``GET /me/permissions`` so the frontend can hydrate its
permissions store at login and on every silent refresh. The endpoint
re-emits the permission claims that are already in the access JWT —
the JWT is HttpOnly so the frontend can't decode it directly, and a
dedicated endpoint keeps that boundary clean.

Phase 4.2 adds ``GET /me/access`` — the same payload an admin sees on
the "By user" tab, but keyed off the caller's own ``user_id``. Powers
the self-service "My access" page so end users can answer the
question "what can I do, and how did I get that?" without filing a
ticket.

``GET /me/session`` is the one the frontend boots and polls on. It
answers "who am I, what may I do, and when does this token die" in a
single round trip, resolving permissions from the DATABASE rather than
by re-reading the access token. See its docstring for why that
distinction is the whole point.

The classic ``GET /auth/me`` (returns the User DTO) lives in the auth
service router and is unaffected by this module.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.permissions_admin import compute_user_access
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.services import permission_service
from backend.app.services.nav_catalogue import get_catalogue
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.core.tokens import decode_token
from backend.auth_service.interface import User
from backend.common.models.rbac import NavCatalogueResponse, UserAccessResponse


logger = logging.getLogger(__name__)

router = APIRouter()


class PermissionsResponse(BaseModel):
    """Wire shape of the permission claim.

    Field names mirror the JWT claim shape so the FE store can be
    populated by spreading the response object directly.
    """
    sid: str
    global_perms: list[str] = Field(default_factory=list, alias="global")
    ws: dict[str, list[str]] = Field(default_factory=dict)

    model_config = {
        "populate_by_name": True,
    }


class SessionStateResponse(BaseModel):
    """Everything the frontend needs to render a session, in one answer.

    Replaces the boot-time sequence of ``GET /auth/me`` followed by
    ``GET /me/permissions``. Two calls meant two chances to half-fail, and
    the frontend had to invent a policy for every combination — which it
    did, three times, differently.
    """
    model_config = ConfigDict(populate_by_name=True)

    user: User
    permissions: PermissionsResponse
    # When the presented access token expires, ISO-8601. The client uses
    # this to renew BEFORE the token dies instead of discovering it via a
    # 401. ``None`` only when the token could not be read (test wiring
    # that overrides the auth dependency); a client seeing None falls back
    # to reactive refresh.
    access_expires_at: Optional[str] = Field(None, alias="accessExpiresAt")
    # True when the database disagrees with the permission claims baked
    # into the presented token — i.e. someone's access changed and their
    # token has not caught up. The client's move is to rotate, which
    # re-mints the token from these same DB claims. See the endpoint
    # docstring for why the client must be told rather than left to guess.
    stale_claims: bool = Field(False, alias="staleClaims")


def _claims_fingerprint(
    global_perms: object, ws_perms: object,
) -> tuple:
    """Order-independent identity of a permission set, for comparison only.

    ``resolve`` builds its buckets from query results and the JWT carries
    whatever order they were serialised in, so a raw ``==`` reports
    differences that do not exist — and a false ``staleClaims`` costs a
    token rotation on every poll.
    """
    globals_ = tuple(sorted(global_perms or ()))
    buckets = tuple(
        (ws_id, tuple(sorted(perms or ())))
        for ws_id, perms in sorted((ws_perms or {}).items())
    )
    return globals_, buckets


@router.get(
    "/permissions",
    response_model=PermissionsResponse,
    response_model_by_alias=True,
)
async def get_my_permissions(
    # ``get_current_user`` runs FIRST in the dependency chain and is
    # the only place that checks the Redis revocation set. Without it
    # here, a revoked session (binding removed, user dropped from a
    # group) would still get a 200 here because the JWT itself is
    # syntactically valid and ``get_permission_claims`` just decodes
    # it — no revocation check. This endpoint is polled every 60s by
    # the FE permission poller (``store/permissionPoller.ts``) to
    # catch idle-user permission updates, so it has to honour the
    # revocation set: a revoked sid here triggers a 401, which the
    # FE's silent refresh path catches, rotates the JWT with fresh DB
    # claims, and the next poll returns the new state.
    _user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> PermissionsResponse:
    """Return the permission claims embedded in the caller's access token.

    SUPERSEDED by ``GET /me/session``. Kept so a client mid-deploy keeps
    working, and unchanged on purpose — it is still a pure token decode
    with no DB hit, which is the only property that made it cheap enough
    to poll.

    Do not reach for it in new code. Because it reads the token rather
    than the database, it cannot see a permission change until the token
    rotates: polling it after an admin grants you a role returns the old
    answer, indefinitely, with a 200. ``/me/session`` answers the same
    question from the database and says whether the token needs rotating.
    """
    return PermissionsResponse(
        sid=claims.sid,
        global_perms=list(claims.global_perms),
        ws={ws_id: list(perms) for ws_id, perms in claims.ws_perms.items()},
    )


@router.get(
    "/session",
    response_model=SessionStateResponse,
    response_model_by_alias=True,
)
async def get_my_session(
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> SessionStateResponse:
    """The caller's whole session state, resolved from the database.

    **Why this exists.** ``GET /me/permissions`` re-reads the permission
    claims out of the access token. That makes it cheap, and it makes it
    unable to observe a permission change: polling it re-decodes the same
    unchanged token and reports the same claims back. Dynamic RBAC only
    actually landed when the token happened to rotate, so a grant or a
    demotion took up to a full access-token lifetime to appear — and the
    poller that existed to close that gap could not close it, because the
    thing it polled could not see it.

    This endpoint asks the database instead, via the same
    ``permission_service.resolve`` that mints the claims on login and
    refresh. One resolver, so the answer the UI gates on and the answer
    the next token will carry cannot drift.

    **Why ``staleClaims`` is on the wire.** Enforcement stays where it
    is: ``requires(...)`` reads the JWT, on every request, with no DB hit.
    So DB-resolved claims can be AHEAD of what the server will actually
    honour — the moment after a grant, this endpoint says yes while
    ``requires`` still says no. Hiding that would trade a stale-by-15-
    minutes UI for a UI that offers controls the API then refuses. Instead
    we report the divergence and let the client rotate, which re-mints the
    token from these claims and closes the gap in one round trip.

    Deliberately a pure read: no rotation, no cookie writes, no side
    effects. It is polled, and a polled endpoint that mutates session
    state is a foot-gun.
    """
    resolved = await permission_service.resolve(session, user.id, sid=claims.sid)

    stale = _claims_fingerprint(
        resolved.global_perms, resolved.ws_perms,
    ) != _claims_fingerprint(claims.global_perms, claims.ws_perms)

    return SessionStateResponse(
        user=user,
        permissions=PermissionsResponse(
            sid=resolved.sid,
            global_perms=list(resolved.global_perms),
            ws={ws: list(perms) for ws, perms in resolved.ws_perms.items()},
        ),
        access_expires_at=_access_expiry_iso(request),
        stale_claims=stale,
    )


def _access_expiry_iso(request: Request) -> Optional[str]:
    """``exp`` of the presented access token, ISO-8601, or None.

    Read here rather than threaded through a dependency because this is
    the only caller that needs it. Every failure returns None: the client
    treats a missing expiry as "renew reactively", which is what it did
    before this field existed, so an unreadable token degrades to the old
    behaviour instead of breaking the boot.
    """
    token = read_access_cookie(request)
    if not token:
        return None
    try:
        payload = decode_token(token)
    except pyjwt.InvalidTokenError:
        return None
    exp = payload.get("exp")
    if not exp:
        return None
    try:
        return datetime.fromtimestamp(int(exp), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


@router.get(
    "/access",
    response_model=UserAccessResponse,
    response_model_by_alias=True,
)
async def get_my_access(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> UserAccessResponse:
    """Return the caller's own access map.

    Same shape as the admin ``GET /admin/users/{user_id}/access`` —
    every binding (direct + via group), the resolved effective
    permission map, and the user's group memberships. Differs only in
    that ``user_id`` is taken from the authenticated session, never
    the URL, so a non-admin user can never read someone else's access.
    Backs the "My access" self-service page.
    """
    response = await compute_user_access(session, user.id)
    if response is None:
        # The current_user dependency only succeeds on a live session,
        # so the user must exist. A None here means the row was deleted
        # mid-request; treat as 404 rather than 500.
        raise HTTPException(status_code=404, detail="User not found")
    return response


@router.get(
    "/nav",
    response_model=NavCatalogueResponse,
    response_model_by_alias=True,
)
async def get_nav_catalogue(
    _user: User = Depends(get_current_user),
) -> NavCatalogueResponse:
    """Return the navigation visibility catalogue (Phase 16).

    The section→permission map the frontend uses to gate sidebar and
    admin nav items. Static (not personalised) — every authenticated
    user gets the same catalogue and evaluates each spec against their
    own claims client-side. Centralising it here means the FE no
    longer hardcodes these gates and can't drift from the backend
    ``requires(...)`` enforcement (see ``test_nav_catalogue.py``).
    """
    return get_catalogue()
