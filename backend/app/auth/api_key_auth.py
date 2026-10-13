"""Authenticating a request by API key, and holding it to what the key covers.

A request that presents ``Authorization: Bearer nxpat_…`` takes this path and
no other. Its cookies were already removed by ``CSRFMiddleware``, so there is
no session to fall back on: a key that is not honoured is a 401 even on a
route that would otherwise serve anonymous callers.

``authenticate(request)`` runs once per request — every auth dependency calls
it, and the answer is kept on ``request.state`` — in this order:

1. API keys are switched on (Administration → Features), and authorization
   enforcement is intact. A key is never honoured with RBAC switched off.
2. The address is not over its budget of unknown or malformed keys, and
   the key is within its own rate limit — both before the lookup, so a
   client replaying a bad key, or a busy one being told to slow down, costs
   no database read. A key that exists but is refused (revoked, expired) is
   charged to its own budget, not its address: one integration looping on
   a dead key must not lock out the healthy ones behind the same NAT.
3. The identity service validates the key, its owner and the deployment
   policy (``validate_api_key``).
4. The endpoint is on the key surface (``api_key_surface``).
5. A key whose permissions are all read-only only reads.
6. Every view and data source the request names is one the key covers, and
   lives in the workspace the path names (the resource fence).

What it leaves behind: the user and claims for the dependencies to return,
the key's id on ``request.state`` for the access log, and the owner and the
key in the activity context (``common/activity_context``) — so every outbox
event the request writes, here or in the control plane it calls, names both.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException, Request, status
from sqlalchemy import select

from backend.app.auth import api_key_errors, api_key_surface
from backend.app.common import activity_context
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db import engine as db_engine
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.core.api_keys import (
    address_bucket,
    bearer_api_key,
    client_address,
    hash_token,
    looks_valid,
)
from backend.auth_service.core.config import (
    RATELIMIT_API_KEY,
    RATELIMIT_API_KEY_FAILURES_PER_IP,
)
from backend.auth_service.interface import (
    ApiKeyLookupUnavailable,
    ApiKeyPolicy,
    ApiKeyRejected,
    User,
)
from backend.auth_service.ratelimit import get_account_limiter

logger = logging.getLogger(__name__)

ENABLED_FLAG = "apiKeysEnabled"
MAX_LIFETIME_FLAG = "apiKeyMaxLifetime"
SSO_WINDOW_FLAG = "apiKeySsoSignInWindow"

_FAILURE_SCOPE = "apikey-refused-ip"
_KEY_SCOPE = "apikey"

#: What a client is told for each refusal. Specific on purpose: the caller
#: holds the key, and "revoked" or "paused until its owner signs in" is what
#: lets whoever runs the integration fix it.
_REFUSALS: dict[str, tuple[str, str]] = {
    "malformed": (
        "invalid_api_key",
        "The API key is not valid. Check that it was copied in full.",
    ),
    "unknown": ("invalid_api_key", "The API key is not valid."),
    "revoked": ("api_key_revoked", "This API key has been revoked."),
    "expired": ("api_key_expired", "This API key has expired."),
    "owner_inactive": (
        "api_key_owner_inactive",
        "The account this API key belongs to is not active.",
    ),
    "owner_reauth_required": (
        "owner_reauth_required",
        "This API key is paused until its owner signs in again.",
    ),
    "ip_not_allowed": (
        "api_key_ip_not_allowed",
        "This API key cannot be used from this address.",
    ),
}


@dataclass(frozen=True)
class ApiKeyContext:
    key_id: str
    user: User
    #: ``None`` only for a key that is not active, reaching a self route.
    claims: Optional[PermissionClaims]
    expires_at: Optional[str]
    rule: api_key_surface.Rule
    reads: bool
    #: ``active``, or — on a self route only — why it would be refused.
    status: str = "active"

    @property
    def active(self) -> bool:
        return self.status == "active"


_UNSET = object()


async def authenticate(request: Request) -> Optional[ApiKeyContext]:
    """The request's API key context, or ``None`` when it presents no key.
    Raises the refusal when it presents one that may not do this.

    On a self route a key that is not active still comes back, with its
    ``status`` set; ``acting(request)`` is what every other dependency
    uses, and it refuses such a key."""
    # Whether a key is presented at all is decided before anything else is
    # touched: most requests carry none, and a caller holding only a bare
    # request-like object (no headers, no state) must pass through untouched.
    headers = getattr(request, "headers", None)
    token = bearer_api_key(headers) if headers is not None else None
    if token is None:
        return None
    cached = getattr(request.state, "api_key", _UNSET)
    if cached is not _UNSET:
        if isinstance(cached, HTTPException):
            raise cached
        return cached
    request.state.auth_method = "api_key"
    try:
        context = await _authenticate(request, token)
    except HTTPException as exc:
        request.state.api_key = exc
        raise
    request.state.api_key = context
    request.state.api_key_id = context.key_id
    request.state.user_id = context.user.id
    request.state.api_key_expires_at = context.expires_at
    activity_context.bind_actor(context.user.id, api_key_id=context.key_id)
    return context


async def acting(request: Request) -> Optional[ApiKeyContext]:
    """``authenticate``, for everything that acts as the key's owner: a key
    that may only describe or revoke itself is refused here."""
    context = await authenticate(request)
    if context is not None and not context.active:
        code, message = _REFUSALS.get(context.status, _REFUSALS["unknown"])
        raise api_key_errors.invalid_key(code, message)
    return context


def reads_only(request: Request) -> bool:
    """Whether this request is made with an API key and only reads."""
    context = getattr(request.state, "api_key", None)
    return isinstance(context, ApiKeyContext) and context.reads


async def hold_to_data_source(
    request: Request, data_source_id: Optional[str], workspace_id: Optional[str],
) -> None:
    """Refuse a key request reaching a data source its key does not cover.

    For the places that resolve a data source the request named only
    indirectly — a graph, a pull request, a view's source. Authenticates
    itself (cached), so it holds whatever order the route's dependencies run
    in. A data source not named (a view on its workspace's primary) is
    covered only by a key that covers the whole workspace.
    """
    context = await acting(request)
    if context is None:
        return
    if not context.claims.key_scope.selects_data_source(data_source_id, workspace_id):
        raise api_key_errors.out_of_scope("This API key does not cover this data source.")


def _unavailable(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error": "api_keys_unavailable", "message": message},
        headers={"Retry-After": "5"},
    )


def _days(value) -> Optional[int]:
    """A ladder flag's rung as days; anything that is not a number is "no
    limit"."""
    try:
        days = int(str(value))
    except (TypeError, ValueError):
        return None
    return days if days > 0 else None


async def _policy() -> ApiKeyPolicy:
    """The kill switch and the policy, from the flag cache. A flag that
    cannot be read refuses the request: these decide whether a credential is
    honoured at all, so not knowing is not permission."""
    try:
        enabled = await feature_flags.is_enabled_self_session(
            ENABLED_FLAG, default=fail_safe_default(ENABLED_FLAG),
        )
        lifetime = await feature_flags.get_value_self_session(MAX_LIFETIME_FLAG, "none")
        window = await feature_flags.get_value_self_session(SSO_WINDOW_FLAG, "30")
    except Exception as exc:  # noqa: BLE001
        logger.warning("API key policy unreadable: %s", exc)
        raise _unavailable("API key policy cannot be read right now. Try again shortly.")
    if not enabled:
        raise api_key_errors.invalid_key(
            "api_keys_disabled", "API keys are turned off for this deployment.",
        )
    return ApiKeyPolicy(
        sso_signin_window_days=_days(window), max_lifetime_days=_days(lifetime),
    )


def _client_ip(request: Request) -> Optional[str]:
    return client_address(request.client.host if request.client else None)


async def _too_many(
    scope: str, identity: str, limit: str, *, consumed: bool = False,
) -> HTTPException:
    retry = await get_account_limiter().retry_after_seconds(
        scope, identity, limit, consumed=consumed,
    )
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "error": "rate_limited",
            "message": "Too many requests with this API key. Slow down and retry.",
        },
        headers={"Retry-After": str(retry)},
    )


async def _authenticate(request: Request, token: str) -> ApiKeyContext:
    from backend.app.auth.dependencies import _identity_service, rbac_flag

    if not (rbac_flag("RBAC_ENFORCE_VIEWS") and rbac_flag("RBAC_ENFORCE_WORKSPACES")):
        raise _unavailable(
            "API keys are unavailable while authorization enforcement is switched off.",
        )
    policy = await _policy()

    limiter = get_account_limiter()
    client_ip = _client_ip(request)
    address = address_bucket(client_ip)
    if not await limiter.check(_FAILURE_SCOPE, address, RATELIMIT_API_KEY_FAILURES_PER_IP):
        raise await _too_many(_FAILURE_SCOPE, address, RATELIMIT_API_KEY_FAILURES_PER_IP)
    if not looks_valid(token):
        await limiter.record(_FAILURE_SCOPE, address, RATELIMIT_API_KEY_FAILURES_PER_IP)
        raise api_key_errors.invalid_key(*_REFUSALS["malformed"])
    # Every request a key makes counts against its own budget — refused
    # ones included — keyed by its hash, which is one-to-one with the key.
    bucket = hash_token(token)
    if not await limiter.consume(_KEY_SCOPE, bucket, RATELIMIT_API_KEY):
        raise await _too_many(_KEY_SCOPE, bucket, RATELIMIT_API_KEY, consumed=True)

    rule = api_key_surface.rule_for(request)
    itself = rule is not None and rule.level == api_key_surface.SELF
    try:
        identity = await _identity_service(request).validate_api_key(
            token,
            client_ip=client_ip,
            user_agent=request.headers.get("user-agent"),
            policy=policy,
            allow_inactive=itself,
        )
    except ApiKeyRejected as exc:
        if exc.key_id:
            request.state.api_key_id = exc.key_id
        else:
            await limiter.record(_FAILURE_SCOPE, address, RATELIMIT_API_KEY_FAILURES_PER_IP)
        code, message = _REFUSALS.get(exc.reason, _REFUSALS["unknown"])
        raise api_key_errors.invalid_key(code, message)
    except ApiKeyLookupUnavailable:
        raise _unavailable("API keys cannot be checked right now. Try again shortly.")

    request.state.api_key_id = identity.key_id
    if itself:
        # Describing or ending itself: no scope to hold it to, and allowed
        # to every key — a read-only one included.
        return ApiKeyContext(
            key_id=identity.key_id, user=identity.user,
            claims=identity.claims if identity.status == "active" else None,
            expires_at=identity.expires_at, rule=rule,
            reads=api_key_surface.is_read(request, rule), status=identity.status,
        )
    claims = identity.claims
    scope = getattr(claims, "key_scope", None)
    if not isinstance(claims, PermissionClaims) or scope is None:
        # Never act on a key whose scope did not come through: without it the
        # identity-based checks could not tell this is a key at all.
        logger.error("API key %s resolved without a scope; refusing", identity.key_id)
        raise _unavailable("API keys cannot be checked right now. Try again shortly.")

    if rule is None:
        raise api_key_errors.key_forbidden(
            "api_key_not_allowed",
            "This endpoint cannot be called with an API key.",
        )
    reads = api_key_surface.is_read(request, rule)
    if scope.read_only and not reads:
        raise api_key_errors.key_forbidden(
            "api_key_read_only",
            "This API key can only read; this request would change something.",
        )

    await _fence(request, rule, scope, reads=reads)

    return ApiKeyContext(
        key_id=identity.key_id,
        user=identity.user,
        claims=claims,
        expires_at=identity.expires_at,
        rule=rule,
        reads=reads,
    )


# ── The resource fence ──────────────────────────────────────────────

_LOCATION_TTL_SECONDS = 30
_LOCATION_CACHE_MAX = 20_000


@dataclass(frozen=True)
class _Place:
    """Where a view or data source lives. For a view, also the data source
    it renders when it names one (``None`` means its workspace's primary)."""
    workspace_id: Optional[str]
    data_source_id: Optional[str] = None


_NOWHERE = _Place(None)
_locations: dict[tuple[str, str], tuple[float, _Place]] = {}


def reset_for_tests() -> None:
    _locations.clear()


async def _locate(kind: str, ids: list[str]) -> dict[str, _Place]:
    """Where each view or data source lives. Deleted ones keep their place:
    restoring one is still an act on it. Short-lived cache: where a thing
    lives rarely changes, and a move is out of a key's reach for half a
    minute at most."""
    from backend.app.db.models import ViewORM, WorkspaceDataSourceORM

    now = time.monotonic()
    found: dict[str, _Place] = {}
    missing: list[str] = []
    for item in ids:
        hit = _locations.get((kind, item))
        if hit is not None and hit[0] > now:
            found[item] = hit[1]
        else:
            missing.append(item)
    if missing:
        async with db_engine.get_async_session() as session:
            if kind == "view":
                rows = (await session.execute(
                    select(ViewORM.id, ViewORM.workspace_id, ViewORM.data_source_id)
                    .where(ViewORM.id.in_(missing))
                )).all()
                located = {r[0]: _Place(r[1], r[2]) for r in rows}
            else:
                rows = (await session.execute(
                    select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id)
                    .where(WorkspaceDataSourceORM.id.in_(missing))
                )).all()
                located = {r[0]: _Place(r[1]) for r in rows}
        if len(_locations) + len(missing) > _LOCATION_CACHE_MAX:
            _locations.clear()
        for item in missing:
            found[item] = located.get(item, _NOWHERE)
            _locations[(kind, item)] = (now + _LOCATION_TTL_SECONDS, found[item])
    return found


def _not_in_workspace(kind: str, resource_id: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"{kind} '{resource_id}' not found",
    )


async def _fence(request: Request, rule, scope, *, reads: bool) -> None:
    """Hold the request to the views, data sources and workspaces the key
    covers, as far as the request names them. What it names only indirectly
    — a graph, a pull request, a workspace's primary data source — is held
    where that is resolved (see ``api_key_surface``)."""
    path = request.path_params
    query = request.query_params
    workspace_id = path.get("ws_id") or path.get("workspace_id")

    view_ids = [v for v in (path.get("view_id"),) if v]
    path_ds_ids = [d for d in (path.get("ds_id"), path.get("data_source_id")) if d]
    ds_ids = list(path_ds_ids)
    query_view = query.get("viewId")
    query_ds = query.get("dataSourceId")
    # On a filtered list these are filters, not targets: the handler narrows
    # its results to what the key covers either way.
    if rule.level != api_key_surface.FILTERED:
        if query_view:
            view_ids.append(query_view)
        if query_ds:
            ds_ids.append(query_ds)

    view_at = await _locate("view", view_ids) if view_ids else {}
    ds_at = await _locate("data_source", ds_ids) if ds_ids else {}

    for view_id in view_ids:
        where = view_at.get(view_id, _NOWHERE).workspace_id
        if workspace_id and where and where != workspace_id:
            raise _not_in_workspace("View", view_id)
        if not scope.selects_view(view_id, where):
            raise api_key_errors.out_of_scope("This API key does not cover this view.")

    # Reading a view's data is reading the data source it renders — the
    # read-only path a person who can open the view has, through the data
    # plane's capability gate (on ``RESOURCE`` routes; the surface test holds
    # every one that takes ``dataSourceId`` to that gate). Only ever for the
    # ``dataSourceId`` the gate pins to the view: a data source named in the
    # path is a route about that source itself — its jobs, its pull
    # requests — which a view of it does not open. Not a whole-source export
    # either: that is more than a view's reach.
    through_view = (
        view_at.get(query_view, _NOWHERE).data_source_id
        if reads and rule.level == api_key_surface.RESOURCE
        and query_view and query_view in view_ids
        and scope.allows("workspace:view:read")
        else None
    )
    for ds_id in ds_ids:
        where = ds_at.get(ds_id, _NOWHERE).workspace_id
        if workspace_id and where and where != workspace_id:
            raise _not_in_workspace("Data source", ds_id)
        if scope.selects_data_source(ds_id, where):
            continue
        if ds_id == through_view and ds_id == query_ds and ds_id not in path_ds_ids:
            continue
        raise api_key_errors.out_of_scope("This API key does not cover this data source.")

    if workspace_id:
        if rule.level == api_key_surface.WORKSPACE:
            if not scope.selects_workspace(workspace_id):
                raise api_key_errors.out_of_scope(
                    "This API key does not cover this whole workspace.",
                )
        elif not scope.touches_workspace(workspace_id):
            raise api_key_errors.out_of_scope("This API key does not cover this workspace.")
        if (
            rule.level == api_key_surface.DATA_SOURCE
            and not scope.selects_workspace(workspace_id)
            and not query_ds
        ):
            raise api_key_errors.out_of_scope(
                "Name the data source with dataSourceId: this API key does not "
                "cover the whole workspace.",
            )


__all__ = [
    "ApiKeyContext", "acting", "authenticate", "hold_to_data_source",
    "reads_only", "reset_for_tests",
]
