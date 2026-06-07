"""Repository: ``app_auth_config`` (singleton).

One row per platform; the migration seeds it on first deploy. The
shape mirrors ``feature_flags_repo``: upsert with optimistic
``version`` bump so two admins racing on the SSO settings page can't
silently overwrite each other.

The ``LocalIdentityService`` consumes a denormalised snapshot via the
``AuthConfigSnapshot`` dataclass exposed at the top of this module —
the auth_service stays free of ``backend.app`` imports (enforced by
``test_auth_service_isolation``); the snapshot is injected through
the same hook pattern as the existing repos.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AppAuthConfigORM


_SINGLETON_ID = "singleton"


@dataclass(frozen=True)
class AuthConfigSnapshot:
    """Plain dataclass the auth_service sees. Keep field shape stable
    — see ``auth_service.app_auth_config.AuthConfigSnapshot`` mirror."""
    sso_enabled: bool
    allow_local_login: bool
    allow_jit_provisioning: bool
    version: int
    updated_at: str


class ConflictingVersion(RuntimeError):
    """The PATCH submitted an outdated version. The admin layer turns
    this into a 409 so the FE can refresh and retry."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_row(session: AsyncSession) -> Optional[AppAuthConfigORM]:
    result = await session.execute(
        select(AppAuthConfigORM).where(AppAuthConfigORM.id == _SINGLETON_ID)
    )
    return result.scalar_one_or_none()


async def get_snapshot(session: AsyncSession) -> AuthConfigSnapshot:
    """Convert the singleton row into the plain dataclass the auth
    service consumes. Falls back to all-true defaults if the row is
    missing (defensive — the migration seeds it, but a partial
    upgrade shouldn't take the whole login flow down)."""
    row = await get_row(session)
    if row is None:
        return AuthConfigSnapshot(
            sso_enabled=True,
            allow_local_login=True,
            allow_jit_provisioning=True,
            version=0,
            updated_at="",
        )
    return AuthConfigSnapshot(
        sso_enabled=bool(row.sso_enabled),
        allow_local_login=bool(row.allow_local_login),
        allow_jit_provisioning=bool(row.allow_jit_provisioning),
        version=int(row.version or 1),
        updated_at=row.updated_at or "",
    )


async def update_config(
    session: AsyncSession,
    *,
    expected_version: Optional[int] = None,
    sso_enabled: Optional[bool] = None,
    allow_local_login: Optional[bool] = None,
    allow_jit_provisioning: Optional[bool] = None,
    updated_by: Optional[str] = None,
) -> AppAuthConfigORM:
    """Update one or more fields with optimistic concurrency. When
    ``expected_version`` is supplied and doesn't match the stored
    value, raises :class:`ConflictingVersion`.

    Returns the freshly-updated row."""
    row = await get_row(session)
    if row is None:
        # Seeder didn't run; create the singleton inline.
        row = AppAuthConfigORM(
            id=_SINGLETON_ID,
            sso_enabled=True,
            allow_local_login=True,
            allow_jit_provisioning=True,
            version=1,
            updated_at=_now(),
            updated_by=updated_by,
        )
        session.add(row)
        await session.flush()

    if (
        expected_version is not None
        and int(row.version or 1) != expected_version
    ):
        raise ConflictingVersion(
            f"version mismatch: expected {expected_version}, got {row.version}"
        )

    if sso_enabled is not None:
        row.sso_enabled = bool(sso_enabled)
    if allow_local_login is not None:
        row.allow_local_login = bool(allow_local_login)
    if allow_jit_provisioning is not None:
        row.allow_jit_provisioning = bool(allow_jit_provisioning)
    row.version = int(row.version or 1) + 1
    row.updated_at = _now()
    row.updated_by = updated_by
    await session.flush()
    return row
