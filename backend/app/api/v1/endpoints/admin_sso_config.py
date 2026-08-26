"""Admin endpoint: platform SSO posture (``app_auth_config``).

Three posture switches exposed at ``/api/v1/admin/sso/config``:

  * ``ssoEnabled`` — master kill-switch.
  * ``allowLocalLogin`` — when false, password login is refused.
  * ``allowJitProvisioning`` — when false, SSO logins for unknown
    subjects raise ``jit_disabled``.

The PATCH endpoint guards against operator self-lockout:

  * Refuses ``allowLocalLogin=false`` when any active admin lacks an
    SSO identity (HTTP 409 with the offending admin list).
  * Refuses any change that would leave ``ssoEnabled`` AND
    ``allowLocalLogin`` both false. The patch is merged with the stored
    row before the check, so the combination is unreachable whether it
    arrives in one PATCH or as two sequential ones in either order.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    GroupMemberORM,
    RoleBindingORM,
    UserIdentityORM,
    UserORM,
)
from backend.app.db.repositories import app_auth_config_repo, user_repo
from backend.app.db.repositories.binding_repo import _is_expired
from backend.common.roles import RoleName
from backend.app.db.repositories.app_auth_config_repo import (
    ConflictingVersion,
)
from backend.auth_service.core.password import is_password_set
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


class AuthConfigDTO(BaseModel):
    """Public view of the singleton. ``version`` is the optimistic-
    concurrency token the FE echoes back on PATCH so two admins can't
    silently overwrite each other."""
    model_config = ConfigDict(populate_by_name=True)
    sso_enabled: bool = Field(alias="ssoEnabled")
    allow_local_login: bool = Field(alias="allowLocalLogin")
    allow_jit_provisioning: bool = Field(alias="allowJitProvisioning")
    email_first_login: bool = Field(default=False, alias="emailFirstLogin")
    version: int
    updated_at: str = Field(alias="updatedAt")


class AuthConfigPatch(BaseModel):
    """Partial-update body. All fields optional; pass ``expectedVersion``
    to bind the change to the version the admin saw."""
    model_config = ConfigDict(populate_by_name=True)
    sso_enabled: Optional[bool] = Field(default=None, alias="ssoEnabled")
    allow_local_login: Optional[bool] = Field(default=None, alias="allowLocalLogin")
    allow_jit_provisioning: Optional[bool] = Field(default=None, alias="allowJitProvisioning")
    email_first_login: Optional[bool] = Field(default=None, alias="emailFirstLogin")
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")


@router.get("", response_model=AuthConfigDTO, response_model_by_alias=True)
async def get_config(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    snap = await app_auth_config_repo.get_snapshot(session)
    return AuthConfigDTO(
        sso_enabled=snap.sso_enabled,
        allow_local_login=snap.allow_local_login,
        allow_jit_provisioning=snap.allow_jit_provisioning,
        email_first_login=getattr(snap, "email_first_login", False),
        version=snap.version,
        updated_at=snap.updated_at,
    )


async def _super_admin_user_ids(session: AsyncSession) -> set[str]:
    """User ids that effectively hold ``super_admin`` (the role carrying
    ``system:admin``) via the canonical ``role_bindings`` table.

    Phase 5 renamed ``admin`` -> ``super_admin`` and moved authority from
    the legacy ``user_roles`` table to ``role_bindings``. This resolves
    both direct user bindings and indirect bindings via group membership,
    skipping expired (time-bound) bindings.
    """
    now = datetime.now(timezone.utc)
    bindings = await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.role_name == RoleName.SUPER_ADMIN.value,
            RoleBindingORM.scope_type == "global",
        )
    )
    direct_user_ids: set[str] = set()
    group_ids: set[str] = set()
    for b in bindings.scalars().all():
        if _is_expired(b.expires_at, now=now):
            continue
        if b.subject_type == "user":
            direct_user_ids.add(b.subject_id)
        elif b.subject_type == "group":
            group_ids.add(b.subject_id)

    user_ids = set(direct_user_ids)
    if group_ids:
        members = await session.execute(
            select(GroupMemberORM.user_id).where(
                GroupMemberORM.group_id.in_(group_ids)
            )
        )
        user_ids.update(members.scalars().all())
    return user_ids


async def _admins_without_sso_identity(session: AsyncSession) -> list[dict]:
    """Return the (id, email) of every active super-admin who has no SSO
    identity. Used to refuse the toggle ``allow_local_login=false`` when
    it would produce a lockout (once local login is off, an admin MUST
    have at least one SSO identity to get back in)."""
    user_ids = await _super_admin_user_ids(session)
    if not user_ids:
        return []
    admin_q = await session.execute(
        select(UserORM).where(
            UserORM.id.in_(user_ids),
            UserORM.status == "active",
            UserORM.deleted_at.is_(None),
        )
    )
    offending: list[dict] = []
    for admin in admin_q.scalars().all():
        ident = await session.execute(
            select(UserIdentityORM.id).where(UserIdentityORM.user_id == admin.id)
        )
        if ident.first() is None:
            offending.append({"id": admin.id, "email": admin.email})
    return offending


@router.patch("", response_model=AuthConfigDTO, response_model_by_alias=True)
async def update_config(
    body: AuthConfigPatch,
    request: Request,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Update the singleton with optimistic concurrency.

    Lockout safeguards:

      * If the patch sets ``allowLocalLogin=false``, every active
        admin must have at least one SSO identity. Otherwise we
        return 409 ``would_lock_out_admin`` with the offending list.
      * Any patch whose RESULT would have both ``ssoEnabled`` and
        ``allowLocalLogin`` false is rejected (no way in). The check
        runs against the merged target state, so turning the second
        switch off in a later PATCH hits the same 409 as setting both
        at once.
    """
    snap = await app_auth_config_repo.get_snapshot(session)
    target_sso = body.sso_enabled if body.sso_enabled is not None else snap.sso_enabled
    target_local = (
        body.allow_local_login if body.allow_local_login is not None
        else snap.allow_local_login
    )

    if not target_sso and not target_local:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "error": "both_login_modes_disabled",
                "message": "Cannot disable both SSO and local login — the "
                           "platform would be unreachable.",
            },
        )
    if not target_local:
        offending = await _admins_without_sso_identity(session)
        if offending:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "error": "would_lock_out_admin",
                    "adminsWithoutSso": offending,
                    "message": "Disabling local login would lock out the "
                               "listed admins (no linked SSO identity).",
                },
            )

    try:
        row = await app_auth_config_repo.update_config(
            session,
            expected_version=body.expected_version,
            sso_enabled=body.sso_enabled,
            allow_local_login=body.allow_local_login,
            allow_jit_provisioning=body.allow_jit_provisioning,
            email_first_login=body.email_first_login,
            updated_by=admin.id,
        )
    except ConflictingVersion as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))

    # Audit + cache invalidation. Best-effort: a failed audit must
    # NOT block the change (the row update is committed already).
    try:
        await user_repo.create_outbox_event(
            session, event_type="auth.config.updated",
            payload={
                "actor_id": admin.id,
                "sso_enabled": bool(row.sso_enabled),
                "allow_local_login": bool(row.allow_local_login),
                "allow_jit_provisioning": bool(row.allow_jit_provisioning),
                "version": int(row.version or 1),
            },
        )
    except Exception:  # noqa: BLE001
        pass

    svc = getattr(request.app.state, "identity_service", None)
    if svc is not None and hasattr(svc, "invalidate_auth_config_cache"):
        try:
            await svc.invalidate_auth_config_cache()
        except Exception:  # noqa: BLE001
            pass

    return AuthConfigDTO(
        sso_enabled=bool(row.sso_enabled),
        email_first_login=bool(getattr(row, "email_first_login", False)),
        allow_local_login=bool(row.allow_local_login),
        allow_jit_provisioning=bool(row.allow_jit_provisioning),
        version=int(row.version or 1),
        updated_at=row.updated_at or "",
    )


class EndSsoSessionsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    dry_run: bool = Field(default=False, alias="dryRun")


class EndSsoSessionsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    users_affected: int = Field(alias="usersAffected")
    tokens_revoked: int = Field(alias="tokensRevoked")
    dry_run: bool = Field(alias="dryRun")


@router.post("/end-sso-sessions", response_model=EndSsoSessionsResponse,
             response_model_by_alias=True)
async def end_sso_sessions(
    body: Optional[EndSsoSessionsRequest] = None,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """End every session minted through any SSO provider.

    The companion the master switch never had: turning ``ssoEnabled``
    off stops new SSO sign-ins, while the people already signed in keep
    rotating until their ceilings fire — up to 24 hours. This ends them
    now, sweeping every refresh row that names an IdP; password
    sessions are untouched (their rows carry no provider), so the
    "switch back to local accounts" story starts immediately.

    Deliberately callable whatever ``ssoEnabled`` currently says — the
    switch is usually already off by the time an operator reaches for
    this. ``dryRun`` answers the confirm dialog's count.
    """
    body = body or EndSsoSessionsRequest()

    from backend.app.db.repositories import refresh_token_repo
    from backend.app.services.revocation_service import (
        revoke_provider_sessions,
    )

    if body.dry_run:
        users = await refresh_token_repo.count_active_provider_users(
            session, provider_id=None,
        )
        return EndSsoSessionsResponse(
            users_affected=users, tokens_revoked=0, dry_run=True,
        )

    outcome = await revoke_provider_sessions(
        None, session=session, reason="sso_disabled_all",
    )
    try:
        await user_repo.create_outbox_event(
            session, event_type="auth.config.sso_sessions_ended",
            payload={
                "actor_id": admin.id,
                "users_affected": outcome["users"],
                "tokens_revoked": outcome["tokens"],
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return EndSsoSessionsResponse(
        users_affected=outcome["users"], tokens_revoked=outcome["tokens"],
        dry_run=False,
    )
