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

from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.core.tokens import decode_token
from backend.auth_service.interface import IdentityService, User
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
    has_permission_any_workspace,
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
    # Phase 5: renamed to ``system:*`` prefix to match category;
    # see ``docs/RBAC.md`` for the rename map.
    "system:admin",
    "system:org-admin",
    "system:users:manage",
    "system:groups:manage",
    "system:workspaces:create",
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

    Phase 10: also consults the Redis revocation set so a forced
    session-kill (admin promote / demote / suspend) takes effect on
    the very next request — not just on routes that happen to use
    ``requires(...)``. The check is fail-open on Redis outage: a
    Redis incident must not lock every authenticated user out of
    the platform; the JWT TTL is still the staleness floor. Fail-
    closed only applies on routes that explicitly opt-in via
    ``requires(...)`` against a sensitive permission.
    """
    user = await _identity_service(request).validate_session(read_access_cookie(request))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    # Phase 10: pull the sid from the JWT (the decode is cheap and
    # the result is already cached by FastAPI deps if the caller
    # also takes get_permission_claims). A missing sid means the
    # token predates the revocation feature — treat as not-revoked
    # and let the JWT TTL handle it.
    token = read_access_cookie(request)
    sid = ""
    if token:
        try:
            payload = decode_token(token)
            sid = payload.get("sid", "") or ""
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            # validate_session already rejected this above — defensive.
            sid = ""

    if sid:
        try:
            if await get_revocation_service().is_revoked(sid):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Session revoked",
                )
        except RevocationBackendError as exc:
            logger.warning(
                "Revocation backend unavailable in get_current_user "
                "(user=%s): %s — honouring JWT", user.id, exc,
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
    """Require that the authenticated user is a Super Admin.

    Phase 10: the dual-mode legacy / claim check is gone. Phase 6
    made the two stores (``user_roles`` + ``role_bindings``) agree
    by construction, and ``get_current_user`` (Phase 10) now
    honours the revocation set on EVERY request. A stale JWT
    without ``system:admin`` triggers a 403 → the FE silent-refresh
    mints a fresh JWT with re-resolved claims → retry succeeds.

    The legacy DTO-role path used to mask a real bug: a promoted
    user's ``User.role`` flipped to ``super_admin`` (from the
    ``user_roles`` re-read) but their JWT carried empty
    ``global_perms``. ``require_admin`` accepted the role string
    and let them in; every route using ``requires(...)`` then 403'd
    because the claim was missing. The user saw a half-functional
    admin page. Dropping the legacy path forces a single consistent
    state: if you don't have the claim, you don't have admin.
    """
    claims = get_permission_claims(request)
    if has_permission(claims, "system:admin"):
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


async def _audit_access_denied(
    session: AsyncSession,
    *,
    user_id: str,
    permission: str,
    scope_obj: dict,
) -> None:
    """Emit one ``user.access_denied`` outbox event per (user, perm,
    scope, hour). Best-effort — any failure is swallowed so the 403
    is never blocked.

    Sampling uses the existing revocation backend (Redis in prod, an
    in-memory set in tests). Without sampling, a hostile script that
    hammers a forbidden endpoint would generate one outbox row per
    request and drown the audit signal. The hour bucket strikes a
    balance: enough granularity to spot incidents in graphs, low
    enough volume that the outbox table doesn't bloat.
    """
    try:
        import time
        scope_key = f"{scope_obj.get('type','global')}:{scope_obj.get('id') or '-'}"
        hour_bucket = int(time.time()) // 3600
        dedupe_key = (
            f"rbac:denied:{user_id}:{permission}:{scope_key}:{hour_bucket}"
        )

        backend = get_revocation_service()._backend  # type: ignore[attr-defined]
        try:
            already = await backend.exists(dedupe_key)
        except Exception:
            # Sampling backend unavailable — fall through and emit.
            # Better to over-audit on Redis outage than to lose the
            # signal entirely.
            already = False
        if already:
            return
        try:
            await backend.set_with_ttl(dedupe_key, 3600)
        except Exception:
            pass  # Sample mark is best-effort.

        await user_repo.create_outbox_event(
            session,
            event_type="user.access_denied",
            payload={
                "user_id": user_id,
                "permission": permission,
                "scope": scope_obj,
                "hour_bucket": hour_bucket,
            },
        )
        # Commit — the dep doesn't own the handler's transaction, so
        # we have to push our row through ourselves. Failures here
        # are logged but never raised.
        await session.commit()
    except Exception as exc:
        logger.warning(
            "Failed to emit access_denied audit (user=%s perm=%s scope=%s): %s",
            user_id, permission, scope_obj, exc,
        )


def requires(
    permission: str,
    *,
    workspace: Optional[str] = None,
    workspace_any: bool = False,
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

    Phase 18: ``workspace_any=True`` enforces a workspace-scoped perm
    **without** a workspace path param — the caller must hold the perm
    in any one of their workspace buckets (or the
    ``system:admin``/``system:org-admin`` global shortcuts). Used by
    the list/get endpoints on otherwise-global resources (ontologies,
    providers, catalog) where the URL has no workspace context but a
    workspace-bound user is allowed to read the catalogue (results are
    then filtered server-side to the workspaces they touch).
    ``workspace`` and ``workspace_any`` are mutually exclusive.

    The dependency:
      1. Resolves ``get_current_user`` (401 on miss)
      2. Reads the permission claims from the JWT
      3. Checks the revocation set — fail-closed for sensitive
         permissions, fail-open for read paths (see
         ``_FAIL_CLOSED_PERMISSIONS``).
      4. Checks ``has_permission(claims, permission, workspace_id=...)``
         (or ``has_permission_any_workspace`` when ``workspace_any=True``)
         and 403s on miss.
    """
    if workspace is not None and workspace_any:
        raise ValueError(
            "requires(): pass either `workspace=<path_param>` or "
            "`workspace_any=True`, not both"
        )
    fail_closed = permission in _FAIL_CLOSED_PERMISSIONS

    async def _dependency(
        request: Request,
        user: User = Depends(get_current_user),
        claims: PermissionClaims = Depends(get_permission_claims),
        # Audit-session: separate from any session the handler may
        # take, since the handler's session is rolled back on a 403
        # and would drop the audit row with it. FastAPI's dep cache
        # gives the same instance to the handler if it also takes
        # ``Depends(get_db_session)``, but we always commit on the
        # success path here so the audit row outlives the rollback.
        session: AsyncSession = Depends(get_db_session),
    ) -> User:
        # Phase 10: revocation is now enforced inside
        # ``get_current_user`` for every authenticated request, so
        # by the time we get here we know the sid hasn't been
        # revoked. For fail-closed permissions we still want the
        # Redis-outage 503 behaviour (a sensitive route shouldn't
        # be reached if we can't confirm the session is alive), so
        # we run a second, opt-in revocation probe here.
        if fail_closed:
            try:
                if claims.sid and await get_revocation_service().is_revoked(claims.sid):
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Session revoked",
                    )
            except RevocationBackendError as exc:
                logger.warning(
                    "Revocation backend unavailable on fail-closed path "
                    "(perm=%s user=%s): %s",
                    permission, user.id, exc,
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Authorization temporarily unavailable",
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

        if workspace_any:
            allowed = has_permission_any_workspace(claims, permission)
        else:
            allowed = has_permission(claims, permission, workspace_id=workspace_id)
        if not allowed:
            # Phase 5: structured 403 body so the FE can route by
            # ``detail.error`` instead of regex-matching on the prose.
            # The ``detail`` string is kept as-is so existing
            # test-suite scrapers and the access-denied modal in
            # AppLayout (which parses ``Missing permission: <perm>``)
            # keep working unchanged. New consumers should read the
            # structured fields.
            scope_obj = (
                {"type": "workspace", "id": workspace_id}
                if workspace_id is not None
                else {"type": "global", "id": None}
            )
            # Phase 6: best-effort audit emission. Sampled hourly per
            # (user, permission, scope) so a hammering script can't
            # bloat the outbox. Never blocks the 403.
            await _audit_access_denied(
                session,
                user_id=user.id,
                permission=permission,
                scope_obj=scope_obj,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "missing_permission",
                    "permission": permission,
                    "scope": scope_obj,
                    "message": f"Missing permission: {permission}",
                },
            )
        return user

    # Phase 16: tag the closure so the live FastAPI route graph is
    # introspectable. The nav-catalogue drift test walks app.routes and
    # reads these to assert each catalogue entry matches the gate that
    # actually enforces it. Harmless metadata; no runtime effect.
    _dependency.required_permission = permission  # type: ignore[attr-defined]
    _dependency.workspace_param = workspace  # type: ignore[attr-defined]
    _dependency.workspace_any = workspace_any  # type: ignore[attr-defined]

    return _dependency
