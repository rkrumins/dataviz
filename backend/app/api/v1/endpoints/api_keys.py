"""API keys: your own, the one making this request, and everyone's.

Mounted three ways:

``/api/v1/me/api-keys``
    A person managing their own keys from the browser. Minting one — create
    or rotate — needs a fresh proof that it is them (step-up): their password,
    or a sign-in at their identity provider within the last few minutes. The
    token is in the response that creates it and nowhere else, ever.
``/api/v1/api-keys/self``
    A key describing or revoking itself — allowed even when it is paused,
    expired or used from an address it does not allow, so whoever finds a
    leaked key can always end it.
``/api/v1/admin/api-keys`` (and ``/admin/users/{id}/api-keys/revoke-all``)
    The inventory for auditors, and revocation for user administrators.

Another person's key id answers 404 everywhere a person manages their own:
the reads filter on the owner in SQL (``api_key_repo``).
"""
from __future__ import annotations

import ipaddress
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth import api_key_auth, api_key_surface
from backend.app.auth.api_key_auth import (
    ENABLED_FLAG,
    MAX_LIFETIME_FLAG,
    SSO_WINDOW_FLAG,
)
from backend.app.auth.dependencies import (
    _identity_service,
    get_current_user,
    requires,
)
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    ApiKeyORM,
    UserIdentityORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    view_is_live,
)
from backend.app.db.repositories import (
    api_key_repo,
    notification_repo,
    outbox_event_repo,
    user_repo,
)
from backend.app.services import api_key_service, permission_service, view_access
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.cookies import read_access_cookie
from backend.auth_service.core import api_keys
from backend.auth_service.core.config import RATELIMIT_LOGIN_PER_ACCOUNT
from backend.auth_service.core.password import is_password_set, verify_password
from backend.auth_service.core.tokens import (
    AUTH_TIME_CLAIM,
    SIGNIN_CLAIM,
    SIGNIN_SSO,
    decode_token,
)
from backend.auth_service.interface import User
from backend.auth_service.ratelimit import get_account_limiter
from backend.common.display_name import resolve_display_name

logger = logging.getLogger(__name__)

router = APIRouter()
self_router = APIRouter()
admin_router = APIRouter()
admin_users_router = APIRouter()

# Minting asks for a password, which makes it a credential oracle: limited
# per address like the password-change route, and per account below.
limiter = Limiter(key_func=get_remote_address)

#: Active keys one person may hold. Enough for every integration a person
#: runs; few enough that a forgotten key is noticed.
MAX_ACTIVE_KEYS = 25
#: How recently an SSO session must have authenticated at its identity
#: provider to mint a key.
STEP_UP_SECONDS = 15 * 60
_STEP_UP_SCOPE = "stepup"
_STEP_UP_NEXT = "/me/api-keys"
_MAX_IDS = 100
_MAX_CIDRS = 20
_PICKER_MAX = 50

#: How a stored refusal reads as a status a person sees.
_STATUS_BY_REFUSAL = {
    None: "active",
    "revoked": "revoked",
    "expired": "expired",
    "owner_inactive": "owner_inactive",
    "owner_reauth_required": "paused",
}


# ── Shapes ──────────────────────────────────────────────────────────


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class KeyPermissions(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    views: Literal["none", "read", "write"] = "none"
    data: Literal["none", "read", "write"] = "none"
    publish: bool = False


class KeySelection(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    workspaces: List[str] = Field(default_factory=list, max_length=_MAX_IDS)
    views: List[str] = Field(default_factory=list, max_length=_MAX_IDS)
    data_sources: List[str] = Field(
        default_factory=list, alias="dataSources", max_length=_MAX_IDS,
    )


KeyResources = Union[Literal["all"], KeySelection]


class _Expiry(_Model):
    """Every key's expiry is a choice made out loud: a date, or "never"."""
    expires_at: Optional[str] = Field(None, alias="expiresAt", max_length=40)
    never_expires: bool = Field(False, alias="neverExpires")
    current_password: Optional[str] = Field(None, alias="currentPassword", max_length=1024)


class CreateApiKeyRequest(_Expiry):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: str = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    permissions: KeyPermissions
    resources: KeyResources
    allowed_cidrs: List[str] = Field(
        default_factory=list, alias="allowedCidrs", max_length=_MAX_CIDRS,
    )


class RotateApiKeyRequest(_Expiry):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    #: How long the old key keeps working beside the new one.
    grace_seconds: Literal[0, 3600, 86400, 604800] = Field(0, alias="graceSeconds")
    #: Neither expiry field set: the new key lives as long as the old one did.


class ApiKeyDTO(_Model):
    id: str
    name: str
    description: Optional[str] = None
    prefix: str
    kind: str
    permissions: dict
    resources: Union[Literal["all"], dict]
    allowed_cidrs: List[str] = Field(default_factory=list, alias="allowedCidrs")
    #: When it stops working — its own expiry or the deployment's maximum
    #: lifetime, whichever is sooner. ``None``: never.
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    #: ``active`` | ``paused`` (its owner must sign in again) | ``expired``
    #: | ``revoked`` | ``owner_inactive``.
    status: str
    created_at: str = Field(alias="createdAt")
    created_ip: Optional[str] = Field(None, alias="createdIp")
    last_used_at: Optional[str] = Field(None, alias="lastUsedAt")
    last_used_ip: Optional[str] = Field(None, alias="lastUsedIp")
    last_used_user_agent: Optional[str] = Field(None, alias="lastUsedUserAgent")
    revoked_at: Optional[str] = Field(None, alias="revokedAt")
    revoked_by: Optional[str] = Field(None, alias="revokedBy")
    revoked_reason: Optional[str] = Field(None, alias="revokedReason")
    rotated_from: Optional[str] = Field(None, alias="rotatedFrom")


class CreatedApiKey(_Model):
    key: ApiKeyDTO
    #: The key itself. Shown here, once; it cannot be retrieved again.
    token: str


class Access(_Model):
    views: Literal["none", "read", "write"] = "none"
    data: Literal["none", "read", "write"] = "none"
    publish: bool = False


class WorkspaceAccess(Access):
    id: str
    name: str


class ResourceAccess(_Model):
    id: str
    name: Optional[str] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    #: ``none`` when the owner can no longer reach it, or it no longer exists.
    level: Literal["none", "read", "write"]


class EffectiveAccess(_Model):
    workspaces: List[WorkspaceAccess]
    views: List[ResourceAccess] = Field(default_factory=list)
    data_sources: List[ResourceAccess] = Field(default_factory=list, alias="dataSources")


class ApiKeyDetail(ApiKeyDTO):
    effective_access: EffectiveAccess = Field(alias="effectiveAccess")


class StepUp(_Model):
    method: Literal["password", "sso"]
    #: SSO only: the session authenticated recently enough to mint now.
    fresh: bool = False


class Policy(_Model):
    enabled: bool
    max_lifetime_days: Optional[int] = Field(None, alias="maxLifetimeDays")
    sso_sign_in_window_days: Optional[int] = Field(None, alias="ssoSignInWindowDays")
    max_active_keys: int = Field(MAX_ACTIVE_KEYS, alias="maxActiveKeys")


class ApiKeyOptions(_Model):
    policy: Policy
    step_up: StepUp = Field(alias="stepUp")
    active_keys: int = Field(alias="activeKeys")
    #: Every workspace the person can reach, with what they can do there.
    workspaces: List[WorkspaceAccess]


class PickerItem(_Model):
    id: str
    name: str
    workspace_id: str = Field(alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    level: Literal["read", "write"]


class SelfDescription(_Model):
    id: str
    name: str
    prefix: str
    kind: str
    status: str
    user_id: str = Field(alias="userId")
    permissions: dict
    resources: Union[Literal["all"], dict]
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    created_at: str = Field(alias="createdAt")


class Owner(_Model):
    id: str
    email: str
    display_name: str = Field(alias="displayName")


class AdminApiKeyDTO(ApiKeyDTO):
    owner: Owner


class AdminApiKeyList(_Model):
    items: List[AdminApiKeyDTO]
    total: int


# ── Policy and status ───────────────────────────────────────────────


class _PolicyValues:
    def __init__(self, enabled: bool, max_lifetime_days, sso_window_days):
        self.enabled = enabled
        self.max_lifetime_days = max_lifetime_days
        self.sso_window_days = sso_window_days


async def _policy(session: AsyncSession) -> _PolicyValues:
    values = await feature_flags.get_all(session)
    return _PolicyValues(
        enabled=bool(values.get(ENABLED_FLAG, fail_safe_default(ENABLED_FLAG))),
        max_lifetime_days=api_key_auth._days(values.get(MAX_LIFETIME_FLAG, "none")),
        sso_window_days=api_key_auth._days(values.get(SSO_WINDOW_FLAG, "30")),
    )


async def _identity_facts(
    session: AsyncSession, user_ids: set[str],
) -> dict[str, tuple[int, Optional[str]]]:
    if not user_ids:
        return {}
    rows = (await session.execute(
        select(
            UserIdentityORM.user_id,
            func.count(UserIdentityORM.id),
            func.max(UserIdentityORM.last_login_at),
        )
        .where(UserIdentityORM.user_id.in_(sorted(user_ids)))
        .group_by(UserIdentityORM.user_id)
    )).all()
    return {uid: (int(count or 0), last) for uid, count, last in rows}


def _status(key: ApiKeyORM, owner: UserORM, facts, policy: _PolicyValues) -> str:
    count, last = facts.get(owner.id, (0, None))
    reason = api_keys.lifecycle_refusal(
        key, owner,
        identity_count=count, idp_last_login_at=last,
        now=datetime.now(timezone.utc),
        sso_signin_window_days=policy.sso_window_days,
        max_lifetime_days=policy.max_lifetime_days,
    )
    return _STATUS_BY_REFUSAL.get(reason, reason)


def _fields(key: ApiKeyORM, owner: UserORM, facts, policy: _PolicyValues) -> dict:
    expiry = api_keys.effective_expiry(key, max_lifetime_days=policy.max_lifetime_days)
    return dict(
        id=key.id, name=key.name, description=key.description,
        prefix=key.token_prefix, kind=key.kind,
        permissions=api_key_repo.loads(key.permissions, {}),
        resources=api_key_repo.loads(key.resources, {}),
        allowed_cidrs=api_key_repo.loads(key.allowed_cidrs, []),
        expires_at=expiry.isoformat() if expiry else None,
        status=_status(key, owner, facts, policy),
        created_at=key.created_at, created_ip=key.created_ip,
        last_used_at=key.last_used_at, last_used_ip=key.last_used_ip,
        last_used_user_agent=key.last_used_user_agent,
        revoked_at=key.revoked_at, revoked_by=key.revoked_by,
        revoked_reason=key.revoked_reason, rotated_from=key.rotated_from,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Step-up ─────────────────────────────────────────────────────────


def _refused(code: str, message: str, **extra) -> HTTPException:
    # 403, never 401: the browser app reads 401 as a dead session and signs
    # the person out — the opposite of "confirm it's you".
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error": code, "message": message, **extra},
    )


def _session_claims(request: Request) -> dict:
    try:
        return decode_token(read_access_cookie(request) or "")
    except Exception:  # noqa: BLE001 — get_current_user already accepted it
        return {}


def _step_up_method(payload: dict, account: Optional[UserORM]) -> str:
    if payload.get(SIGNIN_CLAIM) == SIGNIN_SSO:
        return "sso"
    if account is not None and is_password_set(account.password_hash):
        return "password"
    return "sso"


def _fresh(payload: dict) -> bool:
    auth_time = payload.get(AUTH_TIME_CLAIM)
    return isinstance(auth_time, (int, float)) and time.time() - auth_time <= STEP_UP_SECONDS


async def _step_up(
    request: Request, user: User, session: AsyncSession, password: Optional[str],
) -> None:
    """Confirm it is really the account's owner before a key is minted: a
    session left open on a shared machine must not be enough to walk away
    with a credential that outlives it."""
    payload = _session_claims(request)
    account = await user_repo.get_user_by_id(session, user.id)
    if _step_up_method(payload, account) == "sso":
        if _fresh(payload):
            return
        raise _refused(
            "step_up_required",
            "Confirm it's you: sign in again with your identity provider, then try again.",
            method="sso",
            loginUrl=await _identity_service(request).step_up_url(
                user.id, next_path=_STEP_UP_NEXT,
            ),
        )
    if not password:
        raise _refused(
            "step_up_required", "Enter your password to confirm it's you.", method="password",
        )
    accounts = get_account_limiter()
    if not await accounts.check(_STEP_UP_SCOPE, user.id, RATELIMIT_LOGIN_PER_ACCOUNT):
        retry = await accounts.retry_after_seconds(
            _STEP_UP_SCOPE, user.id, RATELIMIT_LOGIN_PER_ACCOUNT,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"error": "rate_limited", "message": "Too many attempts. Try again later."},
            headers={"Retry-After": str(retry)},
        )
    if not verify_password(password, account.password_hash):
        await accounts.record(_STEP_UP_SCOPE, user.id, RATELIMIT_LOGIN_PER_ACCOUNT)
        raise _refused("step_up_failed", "That password is not right.", method="password")
    await accounts.reset(_STEP_UP_SCOPE, user.id, RATELIMIT_LOGIN_PER_ACCOUNT)


# ── Validation ──────────────────────────────────────────────────────


def _invalid(message: str, **extra) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"error": "invalid_api_key_request", "message": message, **extra},
    )


def _checked_permissions(permissions: KeyPermissions) -> dict:
    if permissions.views == "none" and permissions.data == "none":
        raise _invalid("A key must be able to do something: give it access to views or data.")
    if permissions.publish and permissions.views != "write":
        raise _invalid("Publishing needs write access to views.")
    return {"views": permissions.views, "data": permissions.data, "publish": permissions.publish}


def _owner_reach(claims: PermissionClaims) -> tuple[bool, set[str]]:
    org_wide = bool(
        {"system:admin", "system:org-admin", "system:org-viewer"} & set(claims.global_perms)
    )
    return org_wide, set(claims.ws_perms)


async def _checked_resources(
    session: AsyncSession, user: User, owner: PermissionClaims, resources: KeyResources,
):
    """``"all"``, or a selection of things the owner can reach today. A key can
    never reach further than its owner, so naming something the owner cannot
    reach would only be a key that silently does less than it says."""
    if resources == "all":
        return "all"
    workspaces = sorted(set(resources.workspaces))
    views = sorted(set(resources.views))
    sources = sorted(set(resources.data_sources))
    if not (workspaces or views or sources):
        raise _invalid("Choose at least one workspace, view or data source, or all of them.")

    org_wide, reachable_ws = _owner_reach(owner)
    unknown: dict[str, list[str]] = {}
    if workspaces:
        existing = set((await session.execute(
            select(WorkspaceORM.id).where(
                WorkspaceORM.id.in_(workspaces), WorkspaceORM.deleted_at.is_(None),
            )
        )).scalars().all())
        bad = [w for w in workspaces if w not in existing or not (org_wide or w in reachable_ws)]
        if bad:
            unknown["workspaces"] = bad
    if views:
        rows = (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(views), view_is_live())
        )).scalars().all()
        ctx = await view_access.ViewerContext.build(session, user=user, claims=owner)
        readable = {v.id for v in rows if await view_access.can_read_view(session, ctx, v)}
        bad = [v for v in views if v not in readable]
        if bad:
            unknown["views"] = bad
    if sources:
        rows = (await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id).where(
                WorkspaceDataSourceORM.id.in_(sources),
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).all()
        readable = {
            ds for ds, ws in rows
            if has_permission(owner, "workspace:datasource:read", workspace_id=ws)
        }
        bad = [d for d in sources if d not in readable]
        if bad:
            unknown["dataSources"] = bad
    if unknown:
        raise _invalid(
            "Some of these don't exist, or aren't yours to give a key.", unknown=unknown,
        )
    return {"workspaces": workspaces, "views": views, "dataSources": sources}


def _checked_expiry(
    body: _Expiry, policy: _PolicyValues, *, default_lifetime: Optional[timedelta] = None,
    default_never: bool = False,
) -> Optional[str]:
    """The expiry to store. ``default_*`` stand in for a rotation that keeps
    the old key's choice; a new key must say."""
    now = _now()
    cap = (
        now + timedelta(days=policy.max_lifetime_days)
        if policy.max_lifetime_days is not None else None
    )
    if body.expires_at and body.never_expires:
        raise _invalid("Choose an expiry date or that the key never expires, not both.")
    if body.never_expires or (not body.expires_at and default_never):
        if cap is not None:
            if default_never and not body.never_expires:
                return cap.isoformat()
            raise _invalid(
                f"Keys here must expire within {policy.max_lifetime_days} days.",
            )
        return None
    if body.expires_at:
        expires = api_keys.parse_instant(body.expires_at)
        if expires is None:
            raise _invalid("The expiry date could not be read.")
    elif default_lifetime is not None:
        expires = now + default_lifetime
    else:
        raise _invalid("Choose when the key expires, or that it never does.")
    if expires <= now:
        raise _invalid("The expiry date must be in the future.")
    if cap is not None and expires > cap:
        if body.expires_at:
            raise _invalid(
                f"Keys here must expire within {policy.max_lifetime_days} days.",
            )
        expires = cap
    return expires.isoformat()


def _checked_cidrs(cidrs: List[str]) -> list[str]:
    out: list[str] = []
    for raw in cidrs:
        try:
            out.append(str(ipaddress.ip_network(raw.strip(), strict=False)))
        except ValueError:
            raise _invalid(f"'{raw}' is not an address or network (for example 203.0.113.0/24).")
    return sorted(set(out))


def _client_ip(request: Request) -> Optional[str]:
    return request.client.host if request.client else None


# ── Effective access ────────────────────────────────────────────────


def _level(perms: set[str], read: str, write: str) -> str:
    if write in perms:
        return "write"
    return "read" if read in perms else "none"


def _access(perms: set[str]) -> dict:
    return dict(
        views=_level(perms, "workspace:view:read", "workspace:view:edit"),
        data=_level(perms, "workspace:datasource:read", "workspace:datasource:manage"),
        publish="workspace:view:publish" in perms,
    )


def _perms_in(claims: PermissionClaims, workspace_id: str) -> set[str]:
    return {
        p for p in permission_service.KEY_GRANTABLE_PERMISSIONS
        if has_permission(claims, p, workspace_id=workspace_id)
    }


async def _workspace_names(session: AsyncSession, ids) -> dict[str, str]:
    ids = sorted(set(ids))
    if not ids:
        return {}
    rows = (await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(ids))
    )).all()
    return dict(rows)


async def _effective_access(
    session: AsyncSession, key: ApiKeyORM, owner_user: User,
) -> EffectiveAccess:
    """What this key can do right now: its owner's live access, narrowed by
    the key — per workspace, and per view and data source it names."""
    claims = await permission_service.resolve_for_api_key(
        session, key.user_id, api_key_service.scope_of(key),
    )
    scope = claims.key_scope
    names = await _workspace_names(session, claims.ws_perms)
    workspaces = [
        WorkspaceAccess(id=ws, name=names.get(ws, ws), **_access(_perms_in(claims, ws)))
        for ws in sorted(claims.ws_perms, key=lambda w: names.get(w, w).lower())
    ]
    views: list[ResourceAccess] = []
    if scope.view_ids:
        rows = {v.id: v for v in (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(sorted(scope.view_ids)), view_is_live())
        )).scalars().all()}
        ctx = await view_access.ViewerContext.build(session, user=owner_user, claims=claims)
        for vid in sorted(scope.view_ids):
            view = rows.get(vid)
            level = "none"
            if view is not None:
                if await view_access.can_edit_view(session, ctx, view):
                    level = "write"
                elif await view_access.can_read_view(session, ctx, view):
                    level = "read"
            views.append(ResourceAccess(
                id=vid, name=view.name if view else None,
                workspace_id=view.workspace_id if view else None, level=level,
            ))
    sources: list[ResourceAccess] = []
    if scope.data_source_ids:
        rows = {d.id: d for d in (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id.in_(sorted(scope.data_source_ids)),
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalars().all()}
        for dsid in sorted(scope.data_source_ids):
            ds = rows.get(dsid)
            level = (
                _access(_perms_in(claims, ds.workspace_id))["data"]
                if ds is not None else "none"
            )
            sources.append(ResourceAccess(
                id=dsid, name=(ds.label or ds.graph_name or ds.id) if ds else None,
                workspace_id=ds.workspace_id if ds else None, level=level,
            ))
    return EffectiveAccess(workspaces=workspaces, views=views, data_sources=sources)


# ── Records ─────────────────────────────────────────────────────────


async def _record(session: AsyncSession, verb: str, key: ApiKeyORM, **payload) -> None:
    await outbox_event_repo.emit(
        session,
        event_type=f"identity.api_key.{verb}",
        aggregate_type="user",
        aggregate_id=key.user_id,
        payload={
            "user_id": key.user_id,
            "key_id": key.id,
            "key_name": key.name,
            "token_prefix": key.token_prefix,
            **payload,
        },
    )


async def _revoke(
    session: AsyncSession, key: ApiKeyORM, *, by: str, reason: str,
) -> bool:
    revoked = await api_key_repo.revoke(session, key.id, by=by, reason=reason)
    if revoked:
        await _record(session, "revoked", key, revoked_by=by, reason=reason)
    api_key_service.forget(key.id)
    return revoked


# ── Your own keys ───────────────────────────────────────────────────


async def _owner_and_facts(session: AsyncSession, user: User):
    owner = await user_repo.get_user_by_id(session, user.id)
    if owner is None:
        raise HTTPException(status_code=404, detail="User not found")
    return owner, await _identity_facts(session, {user.id})


@router.get("/options", response_model=ApiKeyOptions)
async def get_api_key_options(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Everything the create form needs: the deployment's policy, how this
    session confirms it is you, and what you can reach in each workspace."""
    policy = await _policy(session)
    owner_claims = await permission_service.resolve(session, user.id, sid="")
    org_wide, reachable = _owner_reach(owner_claims)
    if org_wide:
        reachable = set(await _all_workspace_ids(session))
    names = await _workspace_names(session, reachable)
    payload = _session_claims(request)
    account = await user_repo.get_user_by_id(session, user.id)
    return ApiKeyOptions(
        policy=Policy(
            enabled=policy.enabled,
            max_lifetime_days=policy.max_lifetime_days,
            sso_sign_in_window_days=policy.sso_window_days,
        ),
        step_up=StepUp(method=_step_up_method(payload, account), fresh=_fresh(payload)),
        active_keys=await api_key_repo.count_active_for_user(session, user.id),
        workspaces=[
            WorkspaceAccess(id=ws, name=names.get(ws, ws), **_access(_perms_in(owner_claims, ws)))
            for ws in sorted(reachable, key=lambda w: names.get(w, w).lower())
            if ws in names
        ],
    )


async def _all_workspace_ids(session: AsyncSession) -> list[str]:
    from backend.app.db.repositories import workspace_repo
    return await workspace_repo.list_workspace_ids(session)


@router.get("/resources", response_model=List[PickerItem])
async def search_api_key_resources(
    type: Literal["view", "data_source"] = Query(...),
    q: Optional[str] = Query(None, max_length=200),
    workspace_id: Optional[str] = Query(None, alias="workspaceId", max_length=128),
    limit: int = Query(20, ge=1, le=_PICKER_MAX),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Views or data sources you can give a key, with what you can do to each
    — including views reached through a grant or published to everyone."""
    owner = await permission_service.resolve(session, user.id, sid="")
    needle = f"%{q.strip().lower()}%" if q and q.strip() else None
    if type == "view":
        ctx = await view_access.ViewerContext.build(session, user=user, claims=owner)
        scope = await view_access.build_read_scope(session, ctx)
        stmt = select(ViewORM).where(view_access.readable_views_clause(scope), view_is_live())
        if workspace_id:
            stmt = stmt.where(ViewORM.workspace_id == workspace_id)
        if needle:
            stmt = stmt.where(func.lower(ViewORM.name).like(needle))
        rows = (await session.execute(stmt.order_by(ViewORM.name).limit(limit))).scalars().all()
        names = await _workspace_names(session, {v.workspace_id for v in rows if v.workspace_id})
        out = []
        for view in rows:
            writable = await view_access.can_edit_view(session, ctx, view)
            out.append(PickerItem(
                id=view.id, name=view.name, workspace_id=view.workspace_id,
                workspace_name=names.get(view.workspace_id),
                level="write" if writable else "read",
            ))
        return out

    org_wide, reachable = _owner_reach(owner)
    stmt = select(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.deleted_at.is_(None))
    if not org_wide:
        stmt = stmt.where(WorkspaceDataSourceORM.workspace_id.in_(sorted(reachable)))
    if workspace_id:
        stmt = stmt.where(WorkspaceDataSourceORM.workspace_id == workspace_id)
    if needle:
        stmt = stmt.where(func.lower(func.coalesce(
            WorkspaceDataSourceORM.label, WorkspaceDataSourceORM.graph_name,
            WorkspaceDataSourceORM.id,
        )).like(needle))
    rows = (await session.execute(
        stmt.order_by(WorkspaceDataSourceORM.label).limit(limit * 2)
    )).scalars().all()
    names = await _workspace_names(session, {d.workspace_id for d in rows})
    out = []
    for ds in rows:
        level = _access(_perms_in(owner, ds.workspace_id))["data"]
        if level == "none":
            continue
        out.append(PickerItem(
            id=ds.id, name=ds.label or ds.graph_name or ds.id,
            workspace_id=ds.workspace_id, workspace_name=names.get(ds.workspace_id),
            level=level,
        ))
    return out[:limit]


@router.get("", response_model=List[ApiKeyDTO])
async def list_my_api_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Your keys, newest first — revoked and expired ones too, as history."""
    owner, facts = await _owner_and_facts(session, user)
    policy = await _policy(session)
    return [
        ApiKeyDTO(**_fields(key, owner, facts, policy))
        for key in await api_key_repo.list_for_user(session, user.id)
    ]


@router.get("/{key_id}", response_model=ApiKeyDetail)
async def get_my_api_key(
    key_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """One of your keys, and what it can do right now."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    owner, facts = await _owner_and_facts(session, user)
    policy = await _policy(session)
    return ApiKeyDetail(
        **_fields(key, owner, facts, policy),
        effective_access=await _effective_access(session, key, user),
    )


@router.post("", response_model=CreatedApiKey, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def create_my_api_key(
    request: Request,
    response: Response,
    body: CreateApiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a key that acts as you, limited to what you choose. The token
    is in this response and nowhere else."""
    policy = await _policy(session)
    if not policy.enabled:
        raise _refused("api_keys_disabled", "API keys are turned off for this deployment.")
    owner = await permission_service.resolve(session, user.id, sid="")
    permissions = _checked_permissions(body.permissions)
    resources = await _checked_resources(session, user, owner, body.resources)
    expires_at = _checked_expiry(body, policy)
    cidrs = _checked_cidrs(body.allowed_cidrs)
    if await api_key_repo.count_active_for_user(session, user.id) >= MAX_ACTIVE_KEYS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "too_many_api_keys",
                "message": f"You can have {MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use.",
            },
        )
    await _step_up(request, user, session, body.current_password)

    generated = api_keys.generate(api_keys.KIND_PERSONAL)
    key = await api_key_repo.create(
        session,
        user_id=user.id, kind=api_keys.KIND_PERSONAL, created_by=user.id,
        name=body.name.strip(), description=(body.description or "").strip() or None,
        token_prefix=generated.display_prefix, token_hash=generated.token_hash,
        permissions=permissions, resources=resources, allowed_cidrs=cidrs,
        expires_at=expires_at, created_ip=_client_ip(request),
        created_user_agent=request.headers.get("user-agent"),
    )
    await _record(
        session, "created", key,
        created_by=user.id, permissions=permissions, resources=resources,
        expires_at=expires_at, allowed_cidrs=cidrs, client_ip=_client_ip(request),
    )
    await session.commit()
    account, facts = await _owner_and_facts(session, user)
    response.headers["Cache-Control"] = "no-store"
    return CreatedApiKey(key=ApiKeyDTO(**_fields(key, account, facts, policy)), token=generated.token)


@router.post("/{key_id}/rotate", response_model=CreatedApiKey)
@limiter.limit("5/minute")
async def rotate_my_api_key(
    request: Request,
    response: Response,
    key_id: str,
    body: RotateApiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Replace a key with a new token that can do exactly the same, keeping
    the old one working for a grace period while you swap it over."""
    old = await api_key_repo.get_for_user(session, user.id, key_id)
    if old is None:
        raise HTTPException(status_code=404, detail="API key not found")
    if old.revoked_at:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "api_key_revoked", "message": "A revoked key cannot be rotated. Create a new one."},
        )
    policy = await _policy(session)
    if not policy.enabled:
        raise _refused("api_keys_disabled", "API keys are turned off for this deployment.")
    created = api_keys.parse_instant(old.created_at)
    old_expiry = api_keys.parse_instant(old.expires_at)
    expires_at = _checked_expiry(
        body, policy,
        default_lifetime=(old_expiry - created) if old_expiry and created else None,
        default_never=old.expires_at is None,
    )
    await _step_up(request, user, session, body.current_password)

    generated = api_keys.generate(old.kind)
    key = await api_key_repo.create(
        session,
        user_id=user.id, kind=old.kind, created_by=user.id,
        name=old.name, description=old.description,
        token_prefix=generated.display_prefix, token_hash=generated.token_hash,
        permissions=api_key_repo.loads(old.permissions, {}),
        resources=api_key_repo.loads(old.resources, {}),
        allowed_cidrs=api_key_repo.loads(old.allowed_cidrs, []),
        expires_at=expires_at, created_ip=_client_ip(request),
        created_user_agent=request.headers.get("user-agent"), rotated_from=old.id,
    )
    if body.grace_seconds:
        await api_key_repo.set_expiry(
            session, old.id, (_now() + timedelta(seconds=body.grace_seconds)).isoformat(),
        )
        api_key_service.forget(old.id)
    else:
        await api_key_repo.revoke(session, old.id, by=user.id, reason="rotated")
        api_key_service.forget(old.id)
    await _record(
        session, "rotated", key,
        created_by=user.id, previous_key_id=old.id, grace_seconds=body.grace_seconds,
        expires_at=expires_at, client_ip=_client_ip(request),
    )
    await session.commit()
    account, facts = await _owner_and_facts(session, user)
    response.headers["Cache-Control"] = "no-store"
    return CreatedApiKey(key=ApiKeyDTO(**_fields(key, account, facts, policy)), token=generated.token)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_my_api_key(
    key_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke one of your keys. Immediate, and permanent."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    await _revoke(session, key, by=user.id, reason="owner")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── The key making this request ─────────────────────────────────────


async def _this_key(request: Request, session: AsyncSession) -> tuple[api_key_auth.ApiKeyContext, ApiKeyORM]:
    context = await api_key_auth.authenticate(request)
    if context is None or context.rule.level != api_key_surface.SELF:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "api_key_required", "message": "Call this with the API key itself."},
            headers={"WWW-Authenticate": 'Bearer realm="api"'},
        )
    key = await api_key_repo.get(session, context.key_id)
    if key is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return context, key


@self_router.get("/self", response_model=SelfDescription)
async def describe_this_key(
    request: Request, session: AsyncSession = Depends(get_db_session),
):
    """The key making this request: what it may do, until when, and whether
    it is working — answered even when it is paused or expired."""
    context, key = await _this_key(request, session)
    return SelfDescription(
        id=key.id, name=key.name, prefix=key.token_prefix, kind=key.kind,
        status=(
            "active" if context.active
            else _STATUS_BY_REFUSAL.get(context.status, context.status)
        ),
        user_id=key.user_id,
        permissions=api_key_repo.loads(key.permissions, {}),
        resources=api_key_repo.loads(key.resources, {}),
        expires_at=context.expires_at, created_at=key.created_at,
    )


@self_router.delete("/self", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_this_key(
    request: Request, session: AsyncSession = Depends(get_db_session),
):
    """Revoke the key making this request — for whoever finds one where it
    should not be. Works whatever the key's state, short of already revoked."""
    _context, key = await _this_key(request, session)
    await _revoke(session, key, by=key.user_id, reason="self")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Everyone's keys ─────────────────────────────────────────────────


def _owner_dto(owner: UserORM) -> Owner:
    return Owner(
        id=owner.id, email=owner.email,
        display_name=resolve_display_name(
            getattr(owner, "display_name", None), owner.first_name, owner.last_name,
        ),
    )


@admin_router.get(
    "", response_model=AdminApiKeyList,
    dependencies=[Depends(requires("system:audit:read"))],
)
async def list_api_keys(
    owner_id: Optional[str] = Query(None, alias="ownerId", max_length=128),
    status_filter: Optional[Literal["active", "expired", "revoked"]] = Query(None, alias="status"),
    unused_days: Optional[int] = Query(None, alias="unusedDays", ge=1, le=3650),
    q: Optional[str] = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100_000),
    session: AsyncSession = Depends(get_db_session),
):
    """Every key on the platform, with its owner — filter to one person, a
    status, or keys nobody has used in a while."""
    rows, total = await api_key_repo.list_all(
        session, owner_id=owner_id, status=status_filter, unused_days=unused_days,
        search=q, limit=limit, offset=offset,
    )
    policy = await _policy(session)
    facts = await _identity_facts(session, {owner.id for _key, owner in rows})
    return AdminApiKeyList(
        items=[
            AdminApiKeyDTO(**_fields(key, owner, facts, policy), owner=_owner_dto(owner))
            for key, owner in rows
        ],
        total=total,
    )


async def _tell_owner(
    session: AsyncSession, owner_id: str, admin_id: str, *,
    title: str, body: str, resource_id: str,
) -> None:
    await notification_repo.notify(
        session, user_ids=[owner_id], kind="api_key_revoked_by_admin",
        title=title, body=body, link="/me/api-keys", actor_id=admin_id,
        resource_type="api_key", resource_id=resource_id,
    )


@admin_router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_revoke_api_key(
    key_id: str,
    admin: User = Depends(requires("system:users:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    key = await api_key_repo.get(session, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    if await _revoke(session, key, by=admin.id, reason="admin"):
        await _tell_owner(
            session, key.user_id, admin.id, resource_id=key.id,
            title="An administrator revoked one of your API keys",
            body=(
                f"“{key.name}” ({key.token_prefix}…) no longer works. "
                "Create a new key if you still need one."
            ),
        )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_users_router.post("/{user_id}/api-keys/revoke-all")
async def admin_revoke_all_api_keys(
    user_id: str,
    admin: User = Depends(requires("system:users:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke every key a person holds — the step to take beside ending their
    sessions, which does not touch keys."""
    keys = await api_key_repo.revoke_all_for_user(session, user_id, by=admin.id, reason="admin")
    for key in keys:
        await _record(session, "revoked", key, revoked_by=admin.id, reason="admin")
        api_key_service.forget(key.id)
    if keys:
        await _tell_owner(
            session, user_id, admin.id, resource_id=user_id,
            title="An administrator revoked your API keys",
            body=(
                f"All {len(keys)} of your API keys were revoked. "
                "Create new ones if you still need them."
            ),
        )
    await session.commit()
    return {"revoked": len(keys)}
