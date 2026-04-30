"""
FastAPI dependency functions for authentication and authorization.

These are thin adapters that read the session cookie off the incoming
request and delegate to the application's ``IdentityService``. The
service does all the work — these helpers only translate auth failure
into the right HTTP status.

When the auth service is extracted into its own process, only the
``IdentityService`` implementation on ``app.state`` changes — every call
site (``Depends(get_current_user)``, etc.) keeps working unchanged.

RBAC Phase 1 adds ``get_permission_claims`` and ``requires(perm, scope)``
alongside the existing helpers. They are NOT yet wired into endpoints —
``require_admin`` continues to gate ``/admin/*`` until Phase 2 swaps it
for ``requires("system:admin")``. Shipping the helpers now means every
endpoint we touch in Phase 2 can adopt them with a one-line change.
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Optional

import jwt as pyjwt
from fastapi import Depends, HTTPException, Request, status

from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.core.tokens import decode_token
from backend.auth_service.interface import IdentityService, User
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.app.services.revocation_service import (
    RevocationBackendError,
    get_revocation_service,
)

logger = logging.getLogger(__name__)


# Permissions that take effect under the fail-closed Redis policy. Any
# endpoint guarded by one of these will reject the request when the
# revocation set is unreachable, on the principle that an outage must
# not silently widen access for sensitive operations. Reads and view
# manipulation fall back to fail-open (the JWT claim is honoured even
# if revocation cannot be verified) so a Redis incident doesn't
# black-hole the read path.
_FAIL_CLOSED_PERMISSIONS = frozenset({
    "system:admin",
    "users:manage",
    "groups:manage",
    "workspace:admin",
})


# ── Per-area RBAC enforcement kill-switches (Phase 2) ────────────────
# Each area can be turned off independently for fast rollback if the
# new enforcement causes a production incident. Default ON so the
# protection ships with the release; operators set the env var to
# ``false`` only as an emergency lever.

def _flag(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("false", "0", "no", "off")


def rbac_flag(name: str) -> bool:
    """Read a kill-switch at request time.

    Reads the env var on every call so tests can flip a flag mid-run
    via ``monkeypatch.setenv`` without touching module state.
    """
    return _flag(name)


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


async def require_admin(
    request: Request,
    user: User = Depends(get_current_user),
) -> User:
    """Require that the authenticated user is an admin.

    Phase 2 transition: accepts EITHER the legacy ``user.role == "admin"``
    DTO field OR a ``system:admin`` permission claim in the JWT. Both
    are equivalent for genuine admins, and the dual check makes the
    swap non-breaking — tokens minted before Phase 1 (no claims) still
    pass via the role string, and tokens minted after Phase 1 pass via
    the claim.

    The legacy role check stays the source of truth when the
    ``RBAC_ENFORCE_ADMIN`` env var is explicitly set to ``false``
    (emergency rollback). Default behaviour is to honour both.

    The dependency does NOT consult the Redis revocation set — Phase 1
    keeps revocation behind the new ``requires(...)`` factory only.
    Endpoints that need revocation honoured should migrate to
    ``Depends(requires("system:admin"))`` directly; that's a one-line
    change and is encouraged for new admin endpoints.
    """
    # Legacy path — still authoritative when the kill-switch is on.
    legacy_allow = user.role == "admin"

    if not rbac_flag("RBAC_ENFORCE_ADMIN"):
        if legacy_allow:
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )

    # Enforcement on: also try the claim path so post-Phase-1 tokens
    # without a populated User.role can still authenticate as admin.
    claim_allow = False
    try:
        claims = get_permission_claims(request)
        claim_allow = has_permission(claims, "system:admin")
    except HTTPException:
        # 401 from get_permission_claims → no claims; fall back to
        # legacy. If legacy also fails we 403 below.
        pass

    if legacy_allow or claim_allow:
        return user

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Admin access required",
    )


# ── RBAC Phase 1: permission-claim plumbing ─────────────────────────

def get_permission_claims(request: Request) -> PermissionClaims:
    """Decode the access JWT and return the embedded permission claims.

    Raises 401 if the token is missing, invalid, or expired. Used as a
    sibling of ``get_current_user`` — both depend on the same cookie,
    and FastAPI's dependency cache means they only decode the JWT
    once per request when used together.

    A token issued before Phase 1 (no claims embedded) yields an empty
    ``PermissionClaims`` rather than raising — those tokens still
    authenticate (``get_current_user`` succeeds via the legacy
    ``role`` claim) and the user simply has no permissions until
    their next login. The JWT TTL is short, so this path is rare.
    """
    token = read_access_cookie(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    try:
        payload = decode_token(token)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return PermissionClaims.from_jwt_dict(payload)


def requires(
    permission: str,
    *,
    workspace: Optional[str] = None,
) -> Callable:
    """Build a FastAPI dependency that enforces ``permission``.

    Usage::

        @router.post("/workspaces/{workspace_id}/views")
        async def create_view(
            workspace_id: str,
            user: User = Depends(requires("workspace:view:create", workspace="workspace_id")),
        ): ...

    ``workspace`` is the **path parameter name** holding the workspace
    id — the dependency reads it from ``request.path_params``. Pass
    ``None`` for global permissions.

    The dependency:
      1. Resolves ``get_current_user`` (401 on miss)
      2. Reads the permission claims from the JWT
      3. Checks the revocation set — fail-closed for sensitive
         permissions, fail-open for read paths (see
         ``_FAIL_CLOSED_PERMISSIONS``).
      4. Checks ``has_permission(claims, permission, workspace_id=...)``
         and 403s on miss.
    """
    fail_closed = permission in _FAIL_CLOSED_PERMISSIONS

    async def _dependency(
        request: Request,
        user: User = Depends(get_current_user),
        claims: PermissionClaims = Depends(get_permission_claims),
    ) -> User:
        # Revocation check.
        revocation = get_revocation_service()
        try:
            if claims.sid and await revocation.is_revoked(claims.sid):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Session revoked",
                )
        except RevocationBackendError as exc:
            if fail_closed:
                logger.warning(
                    "Revocation backend unavailable on fail-closed path "
                    "(perm=%s user=%s): %s",
                    permission, user.id, exc,
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Authorization temporarily unavailable",
                )
            # Fail-open: log and continue with the JWT claims as-is.
            logger.warning(
                "Revocation backend unavailable on fail-open path "
                "(perm=%s user=%s): %s — honouring JWT claim",
                permission, user.id, exc,
            )

        # Resolve workspace id from the path, if scoped.
        workspace_id: Optional[str] = None
        if workspace is not None:
            workspace_id = request.path_params.get(workspace)
            if not workspace_id:
                # Programmer error — surfacing as 500 because it's not the
                # caller's fault.
                raise RuntimeError(
                    f"requires(workspace={workspace!r}) but path param "
                    f"is missing on {request.url.path!r}"
                )

        if not has_permission(claims, permission, workspace_id=workspace_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing permission: {permission}",
            )
        return user

    return _dependency
