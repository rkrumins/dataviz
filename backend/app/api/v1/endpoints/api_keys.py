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
    The inventory for auditors — its counts, one key in detail, a CSV export
    — and revocation, with a note to the owner, for user administrators.

Another person's key id answers 404 everywhere a person manages their own:
the reads filter on the owner in SQL (``api_key_repo``).
"""
from __future__ import annotations

import csv
import io
import ipaddress
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional, Union

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
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
from backend.app.common.bulkhead import Bulkhead, Busy
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db import engine as db_engine
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
    api_key_usage_repo,
    app_auth_config_repo,
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
    AUTH_TIME_PROVEN_CLAIM,
    IDP_VOUCHED_AT_CLAIM,
    SIGNIN_CLAIM,
    SIGNIN_PROVIDER_CLAIM,
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
#: Whether a sign-in the identity provider did not prove fresh may stand in
#: for one — for portal connections, which can neither prove one nor be asked
#: (a gateway is asked: ``_sso_step_up``). Off by default.
SSO_ROUND_TRIP_FLAG = "apiKeySsoRoundTripStepUp"
#: How long a gateway may take to say whether a company session is live
#: before a step-up is answered "try again", and how soon to.
_GATEWAY_RETRY_SECONDS = 30
#: How soon to try again while the provider a step-up needs is confirmed
#: down: the reachability prober looks once a minute.
_OUTAGE_RETRY_SECONDS = 60
#: How far ahead of this server's clock a provider's may be.
_CLOCK_SKEW_SECONDS = 60
_STEP_UP_SCOPE = "stepup"
_STEP_UP_NEXT = "/me/api-keys"
_MAX_IDS = 100
_MAX_CIDRS = 20
_PICKER_MAX = 50
#: Days of usage on a key in a list (its sparkline), and in its detail.
_USAGE_LIST_DAYS = 14
_USAGE_DETAIL_DAYS = 30
#: Rows the CSV export writes at most, read in pages of this many.
_EXPORT_MAX = 10_000
_EXPORT_PAGE = 500
#: Exports streaming at once, per process: each reads a page at a time for as
#: long as its download lasts, which the request deadline does not cut short.
_EXPORTS = Bulkhead("API key exports", 2, wait_seconds=10.0, retry_after_seconds=30)

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


class KeyDraft(_Expiry):
    """A key as someone has described it, before it exists — what creating
    one takes, and what a preview of it takes."""
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: str = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    permissions: KeyPermissions
    resources: KeyResources
    allowed_cidrs: List[str] = Field(
        default_factory=list, alias="allowedCidrs", max_length=_MAX_CIDRS,
    )


class CreateApiKeyRequest(KeyDraft):
    current_password: Optional[str] = Field(None, alias="currentPassword", max_length=1024)


class RotateApiKeyRequest(_Expiry):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    #: How long the old key keeps working beside the new one. Ignored when the
    #: old key no longer works (renewing it): there is nothing to keep.
    grace_seconds: Literal[0, 3600, 86400, 604800] = Field(0, alias="graceSeconds")
    #: Neither expiry field set: the new key lives as long as the old one did.
    current_password: Optional[str] = Field(None, alias="currentPassword", max_length=1024)


class UpdateApiKeyRequest(_Model):
    """What a key is called and what it is for — never what it may do."""
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)


class UsageSummary(_Model):
    """A key's use over the last 30 days, and per day for the last 14."""
    requests_30d: int = Field(0, alias="requests30d")
    writes_30d: int = Field(0, alias="writes30d")
    refused_30d: int = Field(0, alias="refused30d")
    errors_30d: int = Field(0, alias="errors30d")
    #: Requests per UTC day, oldest first, today last.
    daily14: List[int] = Field(default_factory=lambda: [0] * _USAGE_LIST_DAYS)


class UsageDay(_Model):
    day: str
    requests: int = 0
    writes: int = 0
    refused: int = 0
    errors: int = 0


class KeyRef(_Model):
    id: str
    name: str
    prefix: str


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
    #: What an administrator said when revoking it, if anything.
    revoked_note: Optional[str] = Field(None, alias="revokedNote")
    rotated_from: Optional[str] = Field(None, alias="rotatedFrom")
    usage: UsageSummary = Field(default_factory=UsageSummary)


class LastUse(_Model):
    last_used_at: Optional[str] = Field(None, alias="lastUsedAt")
    last_used_ip: Optional[str] = Field(None, alias="lastUsedIp")
    last_used_user_agent: Optional[str] = Field(None, alias="lastUsedUserAgent")


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
    #: Set when the key reaches every workspace through its owner's
    #: organisation-wide role: what it may do in all of them, rather than a
    #: list of every workspace on the platform.
    every_workspace: Optional[Access] = Field(None, alias="everyWorkspace")


class ApiKeyDetail(ApiKeyDTO):
    effective_access: EffectiveAccess = Field(alias="effectiveAccess")
    #: Requests per UTC day for the last 30 days, oldest first.
    usage_days: List[UsageDay] = Field(default_factory=list, alias="usageDays")
    #: The key this one replaced, and the key that replaced it.
    replaces: Optional[KeyRef] = None
    replaced_by: Optional[KeyRef] = Field(None, alias="replacedBy")


class ApiKeyPreview(_Model):
    """A key as it would be if created now — nothing is created."""
    permissions: dict
    resources: Union[Literal["all"], dict]
    allowed_cidrs: List[str] = Field(default_factory=list, alias="allowedCidrs")
    #: When it would stop working, in UTC; ``None``: never.
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    effective_access: EffectiveAccess = Field(alias="effectiveAccess")
    active_keys: int = Field(alias="activeKeys")
    max_active_keys: int = Field(MAX_ACTIVE_KEYS, alias="maxActiveKeys")


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
    #: The address this request came from, as the server sees it — what a
    #: key limited to "this address" would be limited to.
    client_ip: Optional[str] = Field(None, alias="clientIp")
    #: Where someone who signs in through an identity provider signs in again
    #: — to resume paused keys.
    sso_sign_in_url: Optional[str] = Field(None, alias="ssoSignInUrl")
    #: False when this session cannot confirm it is you and the deployment
    #: does not accept a round trip instead: minting will be refused with
    #: ``step_up_unavailable`` until it can.
    step_up_available: bool = Field(True, alias="stepUpAvailable")
    #: Why not, when it is False: ``provider`` (a sign-in provider that cannot
    #: confirm a fresh sign-in), ``passwords_off`` (password sign-in is
    #: switched off, so a password confirms nothing), ``system_account`` (a
    #: break-glass account, which holds no keys) or ``idp_unreachable`` (the
    #: session's provider is confirmed down, until it is back).
    step_up_reason: Optional[Literal[
        "provider", "passwords_off", "system_account", "idp_unreachable",
    ]] = Field(None, alias="stepUpReason")


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
    #: Whose it is and what it reaches — for a key that works. One that is
    #: paused or expired says only what it is and why it stopped: it may be
    #: in hands it was never meant for.
    user_id: Optional[str] = Field(None, alias="userId")
    permissions: Optional[dict] = None
    resources: Optional[Union[Literal["all"], dict]] = None
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    created_at: str = Field(alias="createdAt")


class Owner(_Model):
    id: str
    email: str
    display_name: str = Field(alias="displayName")
    #: Their face as every page draws it: the picked illustration, whether a
    #: picture is stored, and whether the account is gone.
    avatar_id: Optional[str] = Field(default=None, alias="avatarId")
    has_image: bool = Field(default=False, alias="hasImage")
    deleted: bool = False


class AdminApiKeyDTO(ApiKeyDTO):
    owner: Owner


class AdminApiKeyList(_Model):
    items: List[AdminApiKeyDTO]
    total: int


class AdminApiKeyDetail(AdminApiKeyDTO):
    effective_access: EffectiveAccess = Field(alias="effectiveAccess")
    usage_days: List[UsageDay] = Field(default_factory=list, alias="usageDays")
    replaces: Optional[KeyRef] = None
    replaced_by: Optional[KeyRef] = Field(None, alias="replacedBy")


class StatusCounts(_Model):
    active: int = 0
    paused: int = 0
    owner_inactive: int = Field(0, alias="ownerInactive")
    expired: int = 0
    revoked: int = 0


class AdminApiKeyStats(_Model):
    total: int = 0
    by_status: StatusCounts = Field(alias="byStatus")
    expiring_soon: int = Field(0, alias="expiringSoon")
    never_expires: int = Field(0, alias="neverExpires")
    unused90: int = 0
    revoked30d: int = 0


class AdminRevokeRequest(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    #: Shown to the owner with the notice, and kept on the key.
    note: Optional[str] = Field(None, max_length=500)


# ── Policy and status ───────────────────────────────────────────────


class _PolicyValues:
    def __init__(
        self, enabled: bool, max_lifetime_days, sso_window_days, sso_round_trip=False,
        passwords_allowed=True,
    ):
        self.enabled = enabled
        self.max_lifetime_days = max_lifetime_days
        self.sso_window_days = sso_window_days
        self.sso_round_trip = sso_round_trip
        #: The Passwords switch (``allow_local_login``) — never the emergency
        #: window, which opens password sign-in only until it closes.
        self.passwords_allowed = passwords_allowed


async def _policy(session: AsyncSession) -> _PolicyValues:
    values = await feature_flags.get_all(session)
    posture = await app_auth_config_repo.get_snapshot(session)
    return _PolicyValues(
        enabled=bool(values.get(ENABLED_FLAG, fail_safe_default(ENABLED_FLAG))),
        max_lifetime_days=api_key_auth._days(values.get(MAX_LIFETIME_FLAG, "none")),
        sso_window_days=api_key_auth._days(values.get(SSO_WINDOW_FLAG, "30")),
        sso_round_trip=values.get(SSO_ROUND_TRIP_FLAG, fail_safe_default(SSO_ROUND_TRIP_FLAG)) is True,
        passwords_allowed=posture.allow_local_login,
    )


async def _identity_facts(
    session: AsyncSession, user_ids: set[str],
) -> dict[str, tuple[int, Optional[str]]]:
    if not user_ids:
        return {}
    rows = (await session.execute(
        select(
            UserIdentityORM.user_id,
            func.count(),
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
        passwords_allowed=policy.passwords_allowed,
    )
    return _STATUS_BY_REFUSAL.get(reason, reason)


async def _usage(
    session: AsyncSession, key_ids, *, days: int = _USAGE_DETAIL_DAYS,
) -> dict[str, dict[str, tuple[int, int, int, int]]]:
    return await api_key_usage_repo.by_day(session, key_ids, days=days)


def _summary(per_day: dict[str, tuple[int, int, int, int]]) -> UsageSummary:
    totals = [sum(day[i] for day in per_day.values()) for i in range(4)]
    return UsageSummary(
        requests_30d=totals[0], writes_30d=totals[1],
        refused_30d=totals[2], errors_30d=totals[3],
        daily14=[
            per_day.get(day, (0, 0, 0, 0))[0]
            for day in api_key_usage_repo.last_days(_USAGE_LIST_DAYS)
        ],
    )


def _usage_days(per_day: dict[str, tuple[int, int, int, int]]) -> list[UsageDay]:
    return [
        UsageDay(day=day, **dict(zip(("requests", "writes", "refused", "errors"),
                                     per_day.get(day, (0, 0, 0, 0)))))
        for day in api_key_usage_repo.last_days(_USAGE_DETAIL_DAYS)
    ]


def _fields(
    key: ApiKeyORM, owner: UserORM, facts, policy: _PolicyValues, usage=None,
) -> dict:
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
        revoked_reason=key.revoked_reason, revoked_note=key.revoked_note,
        rotated_from=key.rotated_from,
        usage=_summary((usage or {}).get(key.id, {})),
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


def _fresh(payload: dict, *, proven: bool = False) -> bool:
    """The session authenticated at its identity provider within the
    step-up window — and, with ``proven``, the provider itself asserted when
    (``AUTH_TIME_PROVEN_CLAIM``), rather than the sign-in standing in for it."""
    if not _within_step_up_window(payload.get(AUTH_TIME_CLAIM)):
        return False
    return not proven or payload.get(AUTH_TIME_PROVEN_CLAIM) is True


def _vouched_recently(payload: dict) -> bool:
    """The session's provider vouched for it within the step-up window
    (``IDP_VOUCHED_AT_CLAIM``): for a gateway the browser talks to, a sign-in
    through it — the gateway's own answer, minutes ago."""
    return _within_step_up_window(payload.get(IDP_VOUCHED_AT_CLAIM))


def _within_step_up_window(instant) -> bool:
    """``instant`` (epoch seconds) is in the last ``STEP_UP_SECONDS`` — and
    not ahead of now by more than a minute of clock skew: a time in the
    future says nothing about the last few minutes."""
    if not isinstance(instant, (int, float)):
        return False
    return -_CLOCK_SKEW_SECONDS <= time.time() - instant <= STEP_UP_SECONDS


_UNAVAILABLE = (
    "Your sign-in provider can't confirm a fresh sign-in, so API keys can't be created or "
    "rotated here. An administrator can allow it under Administration → Features → "
    "Authentication."
)
_PASSWORDS_OFF = (
    "Password sign-in is switched off here, so a password can't confirm it's you: API keys "
    "can't be created, rotated or renewed with one. Sign in with single sign-on to manage them."
)
_SYSTEM_ACCOUNT = (
    "This is a break-glass account, kept for when nobody else can sign in, so it can't have API "
    "keys. Make them from your own account."
)
_PROVIDER_DOWN = (
    "Your sign-in provider isn't answering, so it can't confirm it's you: API keys can't be "
    "created, rotated or renewed through it until it's back. Try again later."
)


def _provider_down() -> HTTPException:
    """The provider the session came from is confirmed down: nothing it could
    say would arrive. Try again later — rather than wait on it, or be sent to
    its error page, or to the sign-in page and its password doors."""
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error": "idp_unreachable", "message": _PROVIDER_DOWN, "reason": "idp_unreachable"},
        headers={"Retry-After": str(_OUTAGE_RETRY_SECONDS)},
    )


def _sign_in_again(target, message: str) -> HTTPException:
    """Sign in again through the session's provider, then try again — or,
    while it is confirmed down, try again later (``_provider_down``).

    An Enterprise gateway's sign-in runs in the browser, so the page signs in
    through it again in place (``gateway``, its slug) rather than going to
    its sign-in route, which could only fail here: that route cannot complete
    a browser exchange, and refuses a company session the gateway has just
    refused."""
    if target.unreachable:
        return _provider_down()
    if target.confirms in ("gateway_live", "gateway_sign_in"):
        return _refused("step_up_required", message, method="sso", gateway=target.slug)
    return _refused("step_up_required", message, method="sso", loginUrl=target.login_url)


def _minting_refusal(
    account: Optional[UserORM], method: str, policy: _PolicyValues,
) -> Optional[HTTPException]:
    """Why this session may not confirm a new key at all, whatever it would
    prove — asked before anything is checked, so a right password and a wrong
    one get the same answer, and neither counts against the account.

    A break-glass account holds no keys, however it signed in: like a cloud
    account's root user, it is for when nobody else can get in, and a key
    would let something run as it every day. And only the Passwords switch
    makes a password a lasting way in. The emergency window opens password
    sign-in for a few hours while an identity provider is down, and a Super
    Admin may use one during a confirmed outage; a key made then would
    outlive both."""
    if account is not None and account.is_system_account:
        return _refused(
            "step_up_unavailable", _SYSTEM_ACCOUNT, method=method, reason="system_account",
        )
    if method == "password" and not policy.passwords_allowed:
        return _refused(
            "step_up_unavailable", _PASSWORDS_OFF, method="password", reason="passwords_off",
        )
    return None


async def _sso_step_up(
    request: Request, user: User, payload: dict, policy: _PolicyValues, *,
    ask_gateway: bool = True,
) -> tuple[Optional[str], Optional[HTTPException]]:
    """How a session signed in through an identity provider confirms it is
    the person: ``(method, None)`` when it does, else ``(None, refusal)``.

    Only something that happened in the last few minutes counts — a session
    a provider re-issued silently from one it still held proves nothing about
    who is at the keyboard — asked of the provider the session came from:

    * ``sso_proven`` — OIDC or SAML said when the person authenticated;
    * ``gateway_live`` — an Enterprise gateway this server can ask confirms
      the company session on this request is live, now. It fails closed: a
      gateway that does not answer mints nothing (503, try again);
    * ``gateway_sign_in`` — a gateway only the browser talks to vouched for
      the session by signing it in, minutes ago;
    * ``sso_round_trip`` — anything else signed in that recently, where the
      deployment accepts it (``SSO_ROUND_TRIP_FLAG``).

    Otherwise a sign-in the provider can make fresh is asked for
    (``step_up_required``); a provider that cannot — a portal, without the
    switch — gets a plain "unavailable" rather than an endless loop of
    signing in again. While the provider is confirmed down, anything that
    would ask it or send the person to it is answered at once: try again
    later (``_provider_down``). ``ask_gateway`` False — the create form,
    before anything is submitted — takes a gateway that can be asked as
    confirming without asking it."""
    if _fresh(payload, proven=True):
        return "sso_proven", None
    provider_id = payload.get(SIGNIN_PROVIDER_CLAIM)
    identity = _identity_service(request)
    target = await identity.step_up_target(
        user.id, next_path=_STEP_UP_NEXT, provider_id=provider_id,
    )
    if target.confirms == "gateway_live":
        if target.unreachable:
            # Nothing waits, holding a connection, for a gateway that is down.
            return None, _provider_down()
        if not ask_gateway:
            return "gateway_live", None
        answer = await identity.confirm_live_session(
            provider_id, ambient_cookies=dict(request.cookies),
            ambient_headers=dict(request.headers),
        )
        if answer == "confirmed":
            return "gateway_live", None
        if answer == "unreachable":
            return None, HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": "gateway_unreachable",
                    "message": (
                        "Your company sign-in didn't answer, so it can't confirm it's you "
                        "right now. Try again in a moment."
                    ),
                },
                headers={"Retry-After": str(_GATEWAY_RETRY_SECONDS)},
            )
        return None, _sign_in_again(
            target, "Your company sign-in has ended: sign in again, then try again.",
        )
    if target.confirms == "gateway_sign_in":
        if _vouched_recently(payload):
            return "gateway_sign_in", None
        return None, _sign_in_again(
            target,
            "Confirm it's you: sign in again through your company sign-in, then try again.",
        )
    if policy.sso_round_trip and _fresh(payload):
        return "sso_round_trip", None
    if policy.sso_round_trip or (target.confirms == "proven" and not _fresh(payload)):
        return None, _sign_in_again(
            target, "Confirm it's you: sign in again with your identity provider, then try again.",
        )
    return None, _refused("step_up_unavailable", _UNAVAILABLE, method="sso", reason="provider")


async def _step_up(
    request: Request, user: User, session: AsyncSession, password: Optional[str],
    policy: _PolicyValues,
) -> str:
    """Confirm it is really the account's owner before a key is minted: a
    session left open on a shared machine must not be enough to walk away
    with a credential that outlives it. Returns how it was confirmed
    (``password``, or a method of ``_sso_step_up``), for the record."""
    payload = _session_claims(request)
    account = await user_repo.get_user_by_id(session, user.id)
    how = _step_up_method(payload, account)
    refusal = _minting_refusal(account, how, policy)
    if refusal is not None:
        raise refusal
    if how == "sso":
        method, refusal = await _sso_step_up(request, user, payload, policy)
        if refusal is not None:
            raise refusal
        return method
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
    return "password"


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
    # Stored in UTC whatever offset it was given in: expiries are compared as
    # text, and only one offset compares correctly.
    try:
        return expires.astimezone(timezone.utc).isoformat()
    except OverflowError:
        raise _invalid("The expiry date is too far in the future.") from None


def _checked_cidrs(cidrs: List[str]) -> list[str]:
    out: list[str] = []
    for raw in cidrs:
        try:
            out.append(str(ipaddress.ip_network(raw.strip(), strict=False)))
        except ValueError:
            raise _invalid(f"'{raw}' is not an address or network (for example 203.0.113.0/24).")
    return sorted(set(out))


def _client_ip(request: Request) -> Optional[str]:
    return api_keys.client_address(request.client.host if request.client else None)


async def _validated_draft(
    session: AsyncSession, user: User, body: KeyDraft, policy: _PolicyValues,
) -> tuple[dict, object, Optional[str], list[str]]:
    """The permissions, resources, expiry and networks a key described by
    ``body`` would have — or the 422 saying why it can't. Shared by create
    and preview, so a preview never says yes to what create refuses."""
    if not body.name.strip():
        raise _invalid("A key needs a name.")
    owner = await permission_service.resolve(session, user.id, sid="")
    permissions = _checked_permissions(body.permissions)
    resources = await _checked_resources(session, user, owner, body.resources)
    expires_at = _checked_expiry(body, policy)
    cidrs = _checked_cidrs(body.allowed_cidrs)
    return permissions, resources, expires_at, cidrs


def _too_many(hint: str = "Revoke one you no longer use.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error": "too_many_api_keys",
            "message": f"You can have {MAX_ACTIVE_KEYS} active keys. {hint}",
        },
    )


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
    session: AsyncSession, owner_user, scope: permission_service.KeyScope,
) -> EffectiveAccess:
    """What a key with ``scope`` can do right now: its owner's live access,
    narrowed by the key — per workspace, and per view and data source it
    names. ``owner_user`` needs only an ``id``."""
    claims = await permission_service.resolve_for_api_key(session, owner_user.id, scope)
    scope = claims.key_scope
    names = await _workspace_names(session, claims.ws_perms)
    workspaces = [
        WorkspaceAccess(id=ws, name=names.get(ws, ws), **_access(_perms_in(claims, ws)))
        for ws in sorted(claims.ws_perms, key=lambda w: names.get(w, w).lower())
    ]
    every = Access(**_access(set(scope.org_perms))) if scope.org_perms else None
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
    return EffectiveAccess(
        workspaces=workspaces, views=views, data_sources=sources, every_workspace=every,
    )


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
    note: Optional[str] = None, **extra,
) -> bool:
    await api_key_repo.hold_principal(session, key.user_id)
    revoked = await api_key_repo.revoke(session, key.id, by=by, reason=reason, note=note)
    if revoked:
        await _record(
            session, "revoked", key, revoked_by=by, reason=reason,
            **({"note": note} if note else {}), **extra,
        )
    api_key_service.forget(key.id)
    return revoked


async def _ref(session: AsyncSession, key_id: Optional[str]) -> Optional[KeyRef]:
    other = await api_key_repo.get(session, key_id) if key_id else None
    return KeyRef(id=other.id, name=other.name, prefix=other.token_prefix) if other else None


async def _lineage(session: AsyncSession, key: ApiKeyORM) -> tuple[Optional[KeyRef], Optional[KeyRef]]:
    """The key this one replaced, and the key that replaced it."""
    successor = await api_key_repo.successor_of(session, key.id)
    return (
        await _ref(session, key.rotated_from),
        KeyRef(id=successor.id, name=successor.name, prefix=successor.token_prefix)
        if successor else None,
    )


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
    session confirms it is you (and whether it can), what you can reach in
    each workspace, and the address you are calling from."""
    policy = await _policy(session)
    owner_claims = await permission_service.resolve(session, user.id, sid="")
    org_wide, reachable = _owner_reach(owner_claims)
    names = (
        await _all_workspace_names(session) if org_wide
        else await _workspace_names(session, reachable)
    )
    payload = _session_claims(request)
    account = await user_repo.get_user_by_id(session, user.id)
    method = _step_up_method(payload, account)
    sign_in_url = None
    if (await _identity_facts(session, {user.id})).get(user.id, (0, None))[0]:
        target = await _identity_service(request).step_up_target(
            user.id, next_path=_STEP_UP_NEXT, provider_id=payload.get(SIGNIN_PROVIDER_CLAIM),
        )
        # Not while it is confirmed down: that page cannot answer. Nor for a
        # gateway only the browser reaches: its sign-in route can't complete.
        sign_in_url = (
            None if target.unreachable or target.confirms == "gateway_sign_in"
            else target.login_url
        )
    fresh = False
    refusal = _minting_refusal(account, method, policy)
    if refusal is None and method == "sso":
        # Past step-up now, or after signing in again — not "never, here".
        # A gateway that can be asked is asked when the form is submitted.
        confirmed, refusal = await _sso_step_up(
            request, user, payload, policy, ask_gateway=False,
        )
        fresh = confirmed is not None
    # A refusal that says why is one signing in again would not change.
    reason = refusal.detail.get("reason") if refusal is not None else None
    return ApiKeyOptions(
        policy=Policy(
            enabled=policy.enabled,
            max_lifetime_days=policy.max_lifetime_days,
            sso_sign_in_window_days=policy.sso_window_days,
        ),
        step_up=StepUp(method=method, fresh=fresh),
        active_keys=await api_key_repo.count_active_for_user(
            session, user.id, max_lifetime_days=policy.max_lifetime_days,
        ),
        workspaces=[
            WorkspaceAccess(id=ws, name=names[ws], **_access(_perms_in(owner_claims, ws)))
            for ws in sorted(names, key=lambda w: names[w].lower())
        ],
        client_ip=_client_ip(request),
        sso_sign_in_url=sign_in_url,
        step_up_available=reason is None,
        step_up_reason=reason,
    )


async def _all_workspace_names(session: AsyncSession) -> dict[str, str]:
    """Every live workspace's name, without spelling the ids out — for an
    organisation-wide owner, whose reach is every workspace."""
    rows = (await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.deleted_at.is_(None))
    )).all()
    return dict(rows)


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
    history: Literal["recent", "all"] = Query("recent"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Your keys, newest first: those still in date, and those that ended in
    the last 90 days — or, with ``history=all``, every one you have had, up
    to the newest 500."""
    owner, facts = await _owner_and_facts(session, user)
    policy = await _policy(session)
    keys = await api_key_repo.list_for_user(session, user.id, history=history == "all")
    usage = await _usage(session, [k.id for k in keys])
    return [ApiKeyDTO(**_fields(key, owner, facts, policy, usage)) for key in keys]


@router.post("/preview", response_model=ApiKeyPreview)
@limiter.limit("30/minute")
async def preview_my_api_key(
    request: Request,
    body: KeyDraft,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """What a key described like this would be able to do, were it created
    now. Validated exactly as creating it is; nothing is created, and no
    proof that it is you is needed to look."""
    policy = await _policy(session)
    permissions, resources, expires_at, cidrs = await _validated_draft(
        session, user, body, policy,
    )
    scope = permission_service.key_scope_from_profile(
        "preview", kind=api_keys.KIND_PERSONAL, permissions=permissions, resources=resources,
    )
    return ApiKeyPreview(
        permissions=permissions, resources=resources, allowed_cidrs=cidrs,
        expires_at=expires_at,
        effective_access=await _effective_access(session, user, scope),
        active_keys=await api_key_repo.count_active_for_user(
            session, user.id, max_lifetime_days=policy.max_lifetime_days,
        ),
    )


@router.get("/{key_id}", response_model=ApiKeyDetail)
async def get_my_api_key(
    key_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """One of your keys: what it can do right now, how much it has been used,
    and what it replaced or was replaced by."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    owner, facts = await _owner_and_facts(session, user)
    policy = await _policy(session)
    usage = await _usage(session, [key.id])
    replaces, replaced_by = await _lineage(session, key)
    return ApiKeyDetail(
        **_fields(key, owner, facts, policy, usage),
        effective_access=await _effective_access(session, user, api_key_service.scope_of(key)),
        usage_days=_usage_days(usage.get(key.id, {})),
        replaces=replaces, replaced_by=replaced_by,
    )


@router.get("/{key_id}/last-use", response_model=LastUse)
async def get_my_api_key_last_use(
    key_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """When, and from where, one of your keys was last used — and nothing
    else, in one read: for a page waiting on a new key's first call."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return LastUse(
        last_used_at=key.last_used_at, last_used_ip=key.last_used_ip,
        last_used_user_agent=key.last_used_user_agent,
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
    permissions, resources, expires_at, cidrs = await _validated_draft(
        session, user, body, policy,
    )

    async def _at_limit() -> bool:
        return await api_key_repo.count_active_for_user(
            session, user.id, max_lifetime_days=policy.max_lifetime_days,
        ) >= MAX_ACTIVE_KEYS

    if await _at_limit():  # before asking anyone to prove anything
        raise _too_many()
    confirmed_by = await _step_up(request, user, session, body.current_password, policy)
    # Counted again and minted under one lock: two requests racing each
    # other cannot both pass the limit.
    await api_key_repo.hold_principal(session, user.id)
    if await _at_limit():
        raise _too_many()

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
        step_up=confirmed_by,
    )
    await session.commit()
    account, facts = await _owner_and_facts(session, user)
    response.headers["Cache-Control"] = "no-store"
    return CreatedApiKey(key=ApiKeyDTO(**_fields(key, account, facts, policy)), token=generated.token)


@router.patch("/{key_id}", response_model=ApiKeyDTO)
async def update_my_api_key(
    key_id: str,
    body: UpdateApiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Rename a key, or say what it is for. What it may do, where it reaches
    and when it expires stay as they were made: change those by rotating it
    or making a new one."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    if key.revoked_at:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "api_key_revoked", "message": "A revoked key is a record; it can't be changed."},
        )
    fields = body.model_fields_set
    if not ({"name", "description"} & fields):
        raise _invalid("Nothing to change: send a name or a description.")
    name = body.name.strip() if "name" in fields and body.name is not None else key.name
    if not name:
        raise _invalid("A key needs a name.")
    description = (
        (body.description or "").strip() or None
        if "description" in fields else key.description
    )
    changes = {
        field: {"from": before, "to": after}
        for field, before, after in (
            ("name", key.name, name), ("description", key.description, description),
        )
        if before != after
    }
    if changes:
        await api_key_repo.update_details(session, key.id, name=name, description=description)
        await _record(session, "updated", key, updated_by=user.id, changes=changes)
        await session.commit()
        await session.refresh(key)
    owner, facts = await _owner_and_facts(session, user)
    policy = await _policy(session)
    usage = await _usage(session, [key.id])
    return ApiKeyDTO(**_fields(key, owner, facts, policy, usage))


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
    the old one working for a grace period while you swap it over — or, for
    a key that has expired, renew it: a new token, nothing to keep."""
    policy = await _policy(session)
    if not policy.enabled:
        raise _refused("api_keys_disabled", "API keys are turned off for this deployment.")
    old = await api_key_repo.get_for_user(session, user.id, key_id)
    if old is None:
        raise HTTPException(status_code=404, detail="API key not found")

    async def _replaceable() -> None:
        if old.revoked_at:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": "api_key_revoked", "message": "A revoked key cannot be rotated. Create a new one."},
            )
        if await api_key_repo.has_successor(session, old.id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "error": "api_key_rotated",
                    "message": "This key was already replaced. Rotate its replacement instead.",
                },
            )

    await _replaceable()  # before asking anyone to prove anything
    confirmed_by = await _step_up(request, user, session, body.current_password, policy)
    # Everything below decides on the key as it stands under the lock: a
    # revocation racing this rotation either lands first (and is seen) or
    # waits for it (and revokes the old key, which has its successor).
    await api_key_repo.hold_principal(session, user.id)
    await session.refresh(old)
    await _replaceable()
    old_expiry = api_keys.effective_expiry(old, max_lifetime_days=policy.max_lifetime_days)
    renewing = old_expiry is not None and old_expiry <= _now()
    grace = 0 if renewing else body.grace_seconds
    # A renewal adds a live key, and so does keeping the old one working
    # beside its replacement; only a rotation that ends the old key at once
    # leaves the count where it was.
    if (renewing or grace) and await api_key_repo.count_active_for_user(
        session, user.id, max_lifetime_days=policy.max_lifetime_days,
    ) >= MAX_ACTIVE_KEYS:
        raise _too_many(
            "Revoke one you no longer use." if renewing else
            "Rotate without a grace period, or revoke one you no longer use."
        )
    created = api_keys.parse_instant(old.created_at)
    stored_expiry = api_keys.parse_instant(old.expires_at)
    expires_at = _checked_expiry(
        body, policy,
        default_lifetime=(stored_expiry - created) if stored_expiry and created else None,
        default_never=old.expires_at is None,
    )

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
    if grace:
        await api_key_repo.set_expiry(
            session, old.id, (_now() + timedelta(seconds=grace)).isoformat(),
        )
    else:
        await api_key_repo.revoke(session, old.id, by=user.id, reason="rotated")
    api_key_service.forget(old.id)
    await _record(
        session, "rotated", key,
        created_by=user.id, previous_key_id=old.id, grace_seconds=grace,
        renewed=renewing, expires_at=expires_at, client_ip=_client_ip(request),
        step_up=confirmed_by,
    )
    await session.commit()
    account, facts = await _owner_and_facts(session, user)
    response.headers["Cache-Control"] = "no-store"
    return CreatedApiKey(key=ApiKeyDTO(**_fields(key, account, facts, policy)), token=generated.token)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_my_api_key(
    key_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke one of your keys. Immediate, and permanent."""
    key = await api_key_repo.get_for_user(session, user.id, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    await _revoke(session, key, by=user.id, reason="owner", client_ip=_client_ip(request))
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
    reach = dict(
        user_id=key.user_id,
        permissions=api_key_repo.loads(key.permissions, {}),
        resources=api_key_repo.loads(key.resources, {}),
    ) if context.active else {}
    return SelfDescription(
        id=key.id, name=key.name, prefix=key.token_prefix, kind=key.kind,
        status=(
            "active" if context.active
            else _STATUS_BY_REFUSAL.get(context.status, context.status)
        ),
        expires_at=context.expires_at, created_at=key.created_at, **reach,
    )


@self_router.delete("/self", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_this_key(
    request: Request, session: AsyncSession = Depends(get_db_session),
):
    """Revoke the key making this request — for whoever finds one where it
    should not be. Works whatever the key's state, short of already revoked."""
    _context, key = await _this_key(request, session)
    await _revoke(session, key, by=key.user_id, reason="self", client_ip=_client_ip(request))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Everyone's keys ─────────────────────────────────────────────────


def _owner_dto(owner: UserORM, faces: dict[str, dict]) -> Owner:
    """``faces``: the page's owners as ``user_repo.get_identities_by_ids``
    reads them — whether each has a picture, without reading the picture."""
    face = faces.get(owner.id) or {}
    return Owner(
        id=owner.id, email=owner.email,
        display_name=resolve_display_name(
            getattr(owner, "display_name", None), owner.first_name, owner.last_name,
        ),
        avatar_id=face.get("avatar_id"), has_image=bool(face.get("has_image")),
        deleted=owner.deleted_at is not None,
    )


_Status = Literal["active", "paused", "owner_inactive", "expired", "revoked"]
_Focus = Literal["expiring_soon", "never_expires", "unused", "recently_revoked"]
_Sort = Literal["created", "lastUsed", "expires", "name"]


class _InventoryFilters:
    """The inventory's filters, as the list, its counts and its export take them."""

    def __init__(
        self,
        owner_id: Optional[str] = Query(None, alias="ownerId", max_length=128),
        status_filter: Optional[_Status] = Query(None, alias="status"),
        focus: Optional[_Focus] = Query(None),
        unused_days: Optional[int] = Query(None, alias="unusedDays", ge=1, le=3650),
        q: Optional[str] = Query(None, max_length=200),
        sort: _Sort = Query("created"),
        order: Literal["asc", "desc"] = Query("desc"),
    ):
        self.owner_id = owner_id
        self.status = status_filter
        self.focus = focus
        self.unused_days = unused_days
        self.q = q
        self.sort = sort
        self.order = order

    def query(self, policy: _PolicyValues) -> dict:
        return dict(
            owner_id=self.owner_id, status=self.status, focus=self.focus,
            unused_days=self.unused_days, search=self.q, sort=self.sort, order=self.order,
            max_lifetime_days=policy.max_lifetime_days, sso_window_days=policy.sso_window_days,
            passwords_allowed=policy.passwords_allowed,
        )


@admin_router.get(
    "", response_model=AdminApiKeyList,
    dependencies=[Depends(requires("system:audit:read"))],
)
async def list_api_keys(
    filters: _InventoryFilters = Depends(),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100_000),
    session: AsyncSession = Depends(get_db_session),
):
    """Every key on the platform, with its owner — filter to one person, a
    status, keys expiring soon, never expiring or nobody has used in a while,
    and sort by when they were made, last used or expire."""
    policy = await _policy(session)
    rows, total = await api_key_repo.list_all(
        session, **filters.query(policy), limit=limit, offset=offset,
    )
    facts = await _identity_facts(session, {owner.id for _key, owner in rows})
    usage = await _usage(session, [key.id for key, _owner in rows])
    faces = await user_repo.get_identities_by_ids(session, [owner.id for _key, owner in rows])
    return AdminApiKeyList(
        items=[
            AdminApiKeyDTO(
                **_fields(key, owner, facts, policy, usage), owner=_owner_dto(owner, faces),
            )
            for key, owner in rows
        ],
        total=total,
    )


@admin_router.get(
    "/stats", response_model=AdminApiKeyStats,
    dependencies=[Depends(requires("system:audit:read"))],
)
async def api_key_stats(
    owner_id: Optional[str] = Query(None, alias="ownerId", max_length=128),
    q: Optional[str] = Query(None, max_length=200),
    session: AsyncSession = Depends(get_db_session),
):
    """The inventory's counts — by status, and the ones worth a look — over
    the same owner and search the list is showing."""
    policy = await _policy(session)
    counts = await api_key_repo.stats(
        session, owner_id=owner_id, search=q,
        max_lifetime_days=policy.max_lifetime_days, sso_window_days=policy.sso_window_days,
        passwords_allowed=policy.passwords_allowed,
    )
    return AdminApiKeyStats(
        total=counts["total"],
        by_status=StatusCounts(
            active=counts["active"], paused=counts["paused"],
            owner_inactive=counts["owner_inactive"], expired=counts["expired"],
            revoked=counts["revoked"],
        ),
        expiring_soon=counts["expiring_soon"], never_expires=counts["never_expires"],
        unused90=counts["unused"], revoked30d=counts["recently_revoked"],
    )


_CSV_COLUMNS = (
    "id", "name", "prefix", "owner_id", "owner_email", "status", "views", "data",
    "publish", "reaches", "networks", "created_at", "expires_at", "last_used_at",
    "last_used_ip", "requests_30d", "revoked_at", "revoked_reason",
)


def _cell(value) -> str:
    """A value as a CSV cell a spreadsheet shows as text: a leading ``=``,
    ``+``, ``-``, ``@``, tab or CR would otherwise run as a formula when an
    auditor opens the file — and key names are whatever their owners typed."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _reaches(resources) -> str:
    if resources == "all" or not isinstance(resources, dict):
        return "everything"
    parts = []
    for key, label in (("workspaces", "workspace"), ("views", "view"), ("dataSources", "data source")):
        count = len(resources.get(key) or [])
        if count:
            parts.append(f"{count} {label}{'' if count == 1 else 's'}")
    return ", ".join(parts) or "nothing"


@admin_router.get(
    "/export.csv", dependencies=[Depends(requires("system:audit:read"))],
)
async def export_api_keys(
    filters: _InventoryFilters = Depends(),
    # Ends with this function, before the download starts: the pages are read
    # in sessions of their own, so no connection sits idle while it streams.
    session: AsyncSession = Depends(get_db_session, scope="function"),
):
    """The inventory as a CSV — the credential report auditors ask for — with
    the list's filters and order, up to 10,000 keys. Which keys, and in what
    order, is read once; their rows a page at a time, each in a short session
    of its own. Two exports stream at once per process; a third is told to
    retry (429)."""
    if _EXPORTS.full:
        # Before a byte is sent: once the response has started, a 429 is no
        # longer possible.
        raise Busy(_EXPORTS.kind, _EXPORTS.retry_after_seconds)
    policy = await _policy(session)
    ids = await api_key_repo.list_ids(session, **filters.query(policy), limit=_EXPORT_MAX)

    async def stream():
        out = io.StringIO()
        # Every cell quoted: a spreadsheet splitting on ``;`` would otherwise
        # cut an unquoted name in two, past ``_cell``'s reach.
        writer = csv.writer(out, quoting=csv.QUOTE_ALL)
        writer.writerow(_CSV_COLUMNS)
        yield out.getvalue()
        # Held while the rows stream, and released when the stream ends or the
        # client goes away.
        async with _EXPORTS.slot():
            for start in range(0, len(ids), _EXPORT_PAGE):
                async with db_engine.get_async_session() as page_session:
                    rows = await api_key_repo.get_with_owners(
                        page_session, ids[start:start + _EXPORT_PAGE],
                    )
                    facts = await _identity_facts(page_session, {o.id for _k, o in rows})
                    usage = await _usage(page_session, [k.id for k, _o in rows])
                out.seek(0)
                out.truncate()
                for key, owner in rows:
                    fields = _fields(key, owner, facts, policy, usage)
                    profile = fields["permissions"]
                    writer.writerow([_cell(v) for v in (
                        key.id, key.name, key.token_prefix, owner.id, owner.email,
                        fields["status"], profile.get("views"), profile.get("data"),
                        "yes" if profile.get("publish") else "no",
                        _reaches(fields["resources"]), " ".join(fields["allowed_cidrs"]),
                        key.created_at, fields["expires_at"], key.last_used_at,
                        key.last_used_ip, fields["usage"].requests_30d,
                        key.revoked_at, key.revoked_reason,
                    )])
                yield out.getvalue()

    stamp = _now().strftime("%Y%m%d")
    return StreamingResponse(
        stream(), media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="api-keys-{stamp}.csv"',
            "X-Total-Count": str(len(ids)),
            "Cache-Control": "no-store",
        },
    )


@admin_router.get(
    "/{key_id}", response_model=AdminApiKeyDetail,
    dependencies=[Depends(requires("system:audit:read"))],
)
async def get_api_key(key_id: str, session: AsyncSession = Depends(get_db_session)):
    """One key in detail: whose it is, what it can do right now, how much it
    has been used, and what it replaced or was replaced by."""
    key = await api_key_repo.get(session, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    owner = await user_repo.get_user_by_id(session, key.user_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="API key not found")
    policy = await _policy(session)
    facts = await _identity_facts(session, {owner.id})
    usage = await _usage(session, [key.id])
    replaces, replaced_by = await _lineage(session, key)
    faces = await user_repo.get_identities_by_ids(session, [owner.id])
    return AdminApiKeyDetail(
        **_fields(key, owner, facts, policy, usage), owner=_owner_dto(owner, faces),
        effective_access=await _effective_access(session, owner, api_key_service.scope_of(key)),
        usage_days=_usage_days(usage.get(key.id, {})),
        replaces=replaces, replaced_by=replaced_by,
    )


async def _tell_owner(
    session: AsyncSession, owner_id: str, admin_id: str, *,
    title: str, body: str, resource_id: str, note: Optional[str] = None,
) -> None:
    if note:
        body = f"{body} The administrator said: “{note}”"
    await notification_repo.notify(
        session, user_ids=[owner_id], kind="api_key_revoked_by_admin",
        title=title, body=body, link="/me/api-keys", actor_id=admin_id,
        resource_type="api_key", resource_id=resource_id,
    )


async def _admin_revoke(
    session: AsyncSession, key_id: str, admin: User, note: Optional[str],
) -> None:
    key = await api_key_repo.get(session, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    note = (note or "").strip() or None
    if await _revoke(session, key, by=admin.id, reason="admin", note=note):
        await _tell_owner(
            session, key.user_id, admin.id, resource_id=key.id, note=note,
            title="An administrator revoked one of your API keys",
            body=(
                f"“{key.name}” ({key.token_prefix}…) no longer works. "
                "Create a new key if you still need one."
            ),
        )
    await session.commit()


@admin_router.post("/{key_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def admin_revoke_api_key_with_note(
    key_id: str,
    body: Optional[AdminRevokeRequest] = Body(None),
    admin: User = Depends(requires("system:users:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke someone's key, optionally telling them why."""
    await _admin_revoke(session, key_id, admin, body.note if body else None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_revoke_api_key(
    key_id: str,
    admin: User = Depends(requires("system:users:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    await _admin_revoke(session, key_id, admin, None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_users_router.post("/{user_id}/api-keys/revoke-all")
async def admin_revoke_all_api_keys(
    user_id: str,
    body: Optional[AdminRevokeRequest] = Body(None),
    admin: User = Depends(requires("system:users:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke every key a person holds — the step to take beside ending their
    sessions, which does not touch keys."""
    note = ((body.note if body else None) or "").strip() or None
    keys = await api_key_repo.revoke_all_for_user(
        session, user_id, by=admin.id, reason="admin", note=note,
    )
    for key in keys:
        await _record(
            session, "revoked", key, revoked_by=admin.id, reason="admin",
            **({"note": note} if note else {}),
        )
        api_key_service.forget(key.id)
    if keys:
        await _tell_owner(
            session, user_id, admin.id, resource_id=user_id, note=note,
            title="An administrator revoked your API keys",
            body=(
                f"All {len(keys)} of your API keys were revoked. "
                "Create new ones if you still need them."
            ),
        )
    await session.commit()
    return {"revoked": len(keys)}
