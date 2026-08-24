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
import time
from typing import Callable, Optional

import jwt as pyjwt
from fastapi import Depends, HTTPException, Request, status

from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth_service.cookies import (
    ForeignSession,
    raise_if_foreign_session,
    read_access_cookie,
)
from backend.auth_service.core.tokens import decode_token, is_foreign_token_error
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


#: Every kill-switch that gates a real authorization check, so startup
#: can say what state they are in rather than leaving it to a grep.
#:
#: These are not feature flags. ``RBAC_ENFORCE_VIEWS`` guards nineteen
#: checks in ``endpoints/views.py``, including the ``can_read_view``
#: object-level test, and the routes it guards take
#: ``get_optional_user`` — which never 401s. Turned off, the flag is not
#: "less strict"; it is the only authorization on that surface, gone,
#: at runtime, with no redeploy and nothing in the audit log.
RBAC_ENFORCEMENT_FLAGS = (
    "RBAC_ENFORCE_VIEWS",
    "RBAC_ENFORCE_WORKSPACES",
)


def rbac_flag(name: str) -> bool:
    """Read a kill-switch at request time.

    Reads the env var on every call so tests can flip a flag mid-run
    via ``monkeypatch.setenv`` without touching module state. That is
    also what makes an accidental production value take effect
    instantly, which is why ``assert_rbac_enforcement_intact`` runs at
    startup.
    """
    return _flag(name)


def assert_rbac_enforcement_intact() -> None:
    """Refuse to serve production with authorization switched off.

    The switches exist for fast rollback if new enforcement causes an
    incident, and that is a real need — so they are not being removed.
    But an emergency lever left down is indistinguishable from one
    nobody pulled, and nothing anywhere reported the difference. Now the
    process will not start.
    """
    disabled = [n for n in RBAC_ENFORCEMENT_FLAGS if not _flag(n)]
    if not disabled:
        return
    if os.getenv("ENV", "dev").strip().lower() in ("prod", "production"):
        raise RuntimeError(
            f"RBAC enforcement is disabled ({', '.join(disabled)}) and ENV is "
            "production. These are emergency rollback levers, not settings — "
            "with them off, the surfaces they guard have no authorization at "
            "all. Unset them, or set ENV appropriately for a non-production "
            "deployment."
        )
    logger.warning(
        "RBAC enforcement DISABLED for: %s. The surfaces these guard have no "
        "authorization while this holds.", ", ".join(disabled),
    )


def _identity_service(request: Request) -> IdentityService:
    svc = getattr(request.app.state, "identity_service", None)
    if svc is None:
        raise RuntimeError(
            "IdentityService not configured on app.state — see backend/app/main.py"
        )
    return svc


#: The only routes reachable while a forced password change is pending.
#: Kept to what the change screen itself needs — read who you are, set
#: the new password, or give up and sign out. Anything else would let
#: the account keep working around the rotation it is being held for.
_PASSWORD_CHANGE_ALLOWED_PATHS = frozenset({
    "/api/v1/users/me",
    "/api/v1/users/me/password",
    "/api/v1/auth/me",
    "/api/v1/auth/logout",
    "/api/v1/auth/refresh",
    "/api/v1/me/identities",
})


def _password_change_exempt(request: Request) -> bool:
    """True if this request is part of getting the password changed."""
    return request.url.path.rstrip("/") in _PASSWORD_CHANGE_ALLOWED_PATHS


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
        raise_if_foreign_session(request)
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
            # Phase 19: an account holding a password it must rotate can
            # reach the handful of routes needed to rotate it, and
            # nothing else. Enforced here rather than in the SPA because
            # a client-side redirect is a suggestion, not a control —
            # the API has to be the thing that refuses.
            if payload.get("mcp") and not _password_change_exempt(request):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": "password_change_required",
                        "message": (
                            "This account is using a default or "
                            "administrator-set password. Choose a new one "
                            "before continuing."
                        ),
                    },
                )
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
    claims = await get_permission_claims(request)
    if has_permission(claims, "system:admin"):
        return user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Admin access required",
    )


# ── RBAC Phase 1: permission-claim plumbing ─────────────────────────

async def get_permission_claims(request: Request) -> PermissionClaims:
    """Decode the access JWT and return this session's permission claims.

    Raises 401 if the token is missing, invalid, or expired. Used as a
    sibling of ``get_current_user`` — both depend on the same cookie,
    and FastAPI's dependency cache means they only decode the JWT
    once per request when used together.

    A token issued before Phase 1 (no claims embedded) yields an empty
    ``PermissionClaims`` rather than raising — those tokens still
    authenticate (``get_current_user`` succeeds via the legacy
    ``role`` claim) and the user simply has no permissions until
    their next login. The JWT TTL is short, so this path is rare.

    **Where the workspace grants come from.** The session store, always.
    They are unbounded — about 200 bytes of cookie per workspace a user is
    bound to — and a cookie has a hard 4096-byte ceiling, so the mint
    cannot put them in the token and no longer offers the option.

    The one remaining branch on the token is a compatibility path, not a
    design choice:

    * Token carries ``ws`` → it was minted before the split, and it has no
      store entry because nothing wrote one for that ``sid``. Honour what
      it carries. This is what keeps a tab that was already open across
      the deploy fully authorised instead of 403ing on every workspace
      route until the user re-logs in.
    * Token omits ``ws`` → the current shape. Resolve from the store, and
      from the database if the store cannot answer. See
      ``_workspace_grants_from_store``.

    The first branch is **self-draining**: after one refresh lifetime no
    token can still carry ``ws``, and it can be deleted along with
    ``token_carries_ws`` and ``_decode_ws``'s inline layout.

    When neither source can answer, the returned claims carry
    ``ws_available=False`` and an empty map. Callers that needed the
    workspace half must treat that as 503, not as a denial — see
    ``requires``.
    """
    token = read_access_cookie(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    try:
        payload = decode_token(token)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
        if is_foreign_token_error(exc):
            raise ForeignSession() from exc
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    claims = PermissionClaims.from_jwt_dict(payload)
    if PermissionClaims.token_carries_ws(payload):
        return claims
    grants = await _workspace_grants_from_store(
        claims.sid, str(payload.get("sub") or ""),
    )
    return claims.with_ws(grants)


async def _workspace_grants_from_store(
    sid: str, user_id: str,
) -> Optional[dict[str, tuple[str, ...]]]:
    """Workspace grants for a token that does not carry its own.

    Redis → Postgres → ``None``, in that order, and the ordering is the
    whole point. The tempting shortcut is to treat an unreachable store as
    "no workspace grants", which reads as a successful request that happens
    to authorise nothing — a denial dressed up as a 200, and exactly the
    failure shape (silent, data-dependent, unlogged) that the oversized
    cookie produced in the first place. So a store miss escalates to the
    database rather than degrading, and ``None`` — "nothing could answer" —
    is a distinct result from ``{}`` — "the user holds nothing".

    This runs on every current-shape token, but it is not a second round
    trip: the revocation tombstone was already being fetched from the same
    place, and ``read_session`` pipelines the two into one call. The
    database step is the rare one — it needs the store to be unavailable.
    """
    if not sid:
        return {}
    try:
        state = await get_revocation_service().read_session(sid)
        if state.claims is not None:
            return PermissionClaims.from_jwt_dict(state.claims).ws_perms
        logger.warning(
            "No stored workspace grants for sid=%s; resolving from the "
            "database. Expected only if the session entry expired.", sid,
        )
    except Exception as exc:  # noqa: BLE001 — any store failure escalates
        logger.warning(
            "Session store unavailable for sid=%s (%s); resolving "
            "workspace grants from the database.", sid, exc,
        )
    return await _workspace_grants_from_db(user_id)


#: Postgres-fallback results, keyed by user id. Only the *fallback* is
#: cached, never the store read — that distinction is the point.
#:
#: The store is read on every request because it costs nothing extra (the
#: revocation tombstone was already being fetched from the same place in
#: the same round trip) and because reading it live is what makes a
#: permission change take effect immediately rather than at the next token
#: rotation. Caching that would give back the staleness the split was
#: partly meant to remove.
#:
#: The database fallback is the opposite case: it only runs when the store
#: cannot answer, which in practice means Redis is down — precisely when
#: every request in the fleet would otherwise turn into a permission
#: query. A short cache turns that from per-request into per-session-per
#: -window, which is the difference between a degraded cache and a
#: saturated database.
_DB_FALLBACK_TTL_SECONDS = 30
_db_fallback_cache: dict[str, tuple[float, dict[str, tuple[str, ...]]]] = {}
#: Bounded so an outage cannot turn this into a memory leak. Small: it
#: only holds users seen during a store outage inside one 30s window.
_DB_FALLBACK_CACHE_MAX = 2048


def _cached_db_fallback(user_id: str) -> Optional[dict[str, tuple[str, ...]]]:
    entry = _db_fallback_cache.get(user_id)
    if entry is None:
        return None
    expires_at, grants = entry
    if expires_at < time.monotonic():
        _db_fallback_cache.pop(user_id, None)
        return None
    return grants


def _remember_db_fallback(
    user_id: str, grants: dict[str, tuple[str, ...]],
) -> None:
    if len(_db_fallback_cache) >= _DB_FALLBACK_CACHE_MAX:
        # Wholesale clear rather than LRU bookkeeping: this only fills
        # during an outage, and the cost of a cleared cache is one extra
        # query per session, not a correctness problem.
        _db_fallback_cache.clear()
    _db_fallback_cache[user_id] = (
        time.monotonic() + _DB_FALLBACK_TTL_SECONDS, grants,
    )


def reset_db_fallback_cache() -> None:
    """Drop the fallback cache. For tests, and for a targeted flush."""
    _db_fallback_cache.clear()


async def _workspace_grants_from_db(
    user_id: str,
) -> Optional[dict[str, tuple[str, ...]]]:
    """Last resort: re-resolve from Postgres.

    Keyed on the user id from the token's ``sub`` rather than on the sid,
    because the session index only runs user → sids and cannot be walked
    backwards. ``sub`` is signed, so trusting it here is no weaker than
    trusting the rest of the token.

    Opens its own short-lived session rather than taking one as a
    dependency. Declaring a session dependency here would acquire a
    connection from the pool for every one of the ~70 endpoints that
    depend on these claims, including those that never touch the
    database — turning a rare fallback into permanent pool pressure.

    Returns ``{}`` only when the user genuinely has no workspace grants,
    and ``None`` when the database could not answer either. The two are
    kept apart because an empty map is a *claim about the user*: hand it
    to ``requires`` and it becomes "Missing permission: …", a 403 stating
    as fact something the server never established. Collapsing them is
    how the "you don't have permissions" flash gets built. ``None``
    reaches the caller as ``ws_available=False``, and the endpoints that
    need the workspace half answer 503 instead.
    """
    if not user_id:
        # No ``sub`` on a token that otherwise verified. Nothing to look
        # up, and nothing to be wrong about: this session has no user to
        # hold workspace grants.
        return {}
    cached = _cached_db_fallback(user_id)
    if cached is not None:
        return cached

    from backend.app.db.engine import get_session_factory
    from backend.app.services import permission_service

    try:
        factory = get_session_factory()
        async with factory() as session:
            resolved = await permission_service.resolve(session, user_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "No grant source could answer for user=%s (store unavailable, "
            "database fallback failed: %s) — workspace access is unknown, "
            "not empty", user_id, exc,
        )
        return None
    _remember_db_fallback(user_id, resolved.ws_perms)
    return resolved.ws_perms


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
         and 403s on miss — except when the miss was decided against a
         workspace map that no source could supply, which is a 503.
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

        # A denial reached by consulting a workspace map that nothing could
        # populate is not a denial — it is an unanswered question, and 403
        # answers it wrongly and permanently ("you may not" rather than
        # "ask again"). The check is here rather than in
        # ``get_permission_claims`` because only here is it known whether
        # the missing half was needed: a global permission is decided
        # entirely by the token, so a store outage must not touch it.
        if not allowed and not claims.ws_available and (
            workspace_any or workspace_id is not None
        ):
            logger.warning(
                "Cannot establish workspace grants for user=%s (perm=%s "
                "workspace=%s); answering 503 rather than 403",
                user.id, permission, workspace_id,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authorization temporarily unavailable",
            )

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


