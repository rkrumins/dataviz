"""Admin endpoint: platform SSO posture (``app_auth_config``).

Three posture switches exposed at ``/api/v1/admin/sso/config``:

  * ``ssoEnabled`` — master kill-switch.
  * ``allowLocalLogin`` — when false, password login is refused.
  * ``allowJitProvisioning`` — when false, SSO logins for unknown
    subjects raise ``jit_disabled``.

The PATCH endpoint guards against operator self-lockout:

  * Refuses ``allowLocalLogin=false`` when any active admin lacks an
    SSO identity (HTTP 409 with the offending admin list).
  * Refuses ``ssoEnabled=false`` AND ``allowLocalLogin=false`` together
    (there'd be no way to log in).
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    UserIdentityORM,
    UserORM,
    UserRoleORM,
)
from backend.app.db.repositories import app_auth_config_repo, user_repo
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
    version: int
    updated_at: str = Field(alias="updatedAt")


class AuthConfigPatch(BaseModel):
    """Partial-update body. All fields optional; pass ``expectedVersion``
    to bind the change to the version the admin saw."""
    model_config = ConfigDict(populate_by_name=True)
    sso_enabled: Optional[bool] = Field(default=None, alias="ssoEnabled")
    allow_local_login: Optional[bool] = Field(default=None, alias="allowLocalLogin")
    allow_jit_provisioning: Optional[bool] = Field(default=None, alias="allowJitProvisioning")
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
        version=snap.version,
        updated_at=snap.updated_at,
    )


async def _admins_without_sso_identity(session: AsyncSession) -> list[dict]:
    """Return the (id, email) of every active admin who has neither a
    usable password nor any SSO identity. Used to refuse the toggle
    ``allow_local_login=false`` when it would produce a lockout."""
    # Pull admins by user_roles where role_name='admin'.
    admin_q = await session.execute(
        select(UserORM)
        .join(UserRoleORM, UserRoleORM.user_id == UserORM.id)
        .where(
            UserRoleORM.role_name == "admin",
            UserORM.status == "active",
            UserORM.deleted_at.is_(None),
        )
    )
    admins = list(admin_q.scalars().all())
    offending: list[dict] = []
    for admin in admins:
        # If they have a password, they're fine for local-login OFF
        # (they can still log in via SSO too, just not via password).
        # Wait — the toggle is allow_local_login. When OFF, password
        # login is refused. So admins MUST have at least one SSO
        # identity; having a password is irrelevant once local login
        # is forbidden.
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
      * Setting both ``ssoEnabled=false`` AND ``allowLocalLogin=false``
        in one transaction is rejected (no way in).
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
                "actor": admin.id,
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
        allow_local_login=bool(row.allow_local_login),
        allow_jit_provisioning=bool(row.allow_jit_provisioning),
        version=int(row.version or 1),
        updated_at=row.updated_at or "",
    )
