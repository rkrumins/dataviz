"""Repository: ``user_identities``.

A user can hold N identities (one per linked IdP) plus optionally a
local password. This module owns:

  * The hot find-or-provision lookup at SSO login
    (``get_by_subject``).
  * The lifecycle of identity linking and unlinking.
  * The "does this user still have any way to log in?" invariant
    that must hold before we let an unlink succeed.

The Phase-2 ``user_repo.get_user_by_external_identity`` is removed in
favour of ``get_by_subject``. The Phase-2 ``user_repo.link_user_to_provider``
that mutated ``UserORM`` columns is gone — linking is now an additive
row in this table.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.db.models import UserIdentityORM, UserORM


class IdentityNotFound(LookupError):
    """Used by /me/identities/{id} DELETE to map to a 404."""


class LastAuthenticatorError(RuntimeError):
    """Refusal to unlink the user's only remaining way to authenticate
    (no password AND no other identities). Raised so the route layer
    can surface a 409 with structured detail."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Lookup ──────────────────────────────────────────────────────────


async def get_by_subject(
    session: AsyncSession, *, provider_id: str, external_id: str,
) -> Optional[UserIdentityORM]:
    """Return the identity row for the given provider+subject pair, or
    None. The (provider_id, external_id) UNIQUE makes this safe for
    the SSO login hot path."""
    result = await session.execute(
        select(UserIdentityORM).where(
            UserIdentityORM.provider_id == provider_id,
            UserIdentityORM.external_id == external_id,
        )
    )
    return result.scalar_one_or_none()


async def get_by_id(
    session: AsyncSession, identity_id: str,
) -> Optional[UserIdentityORM]:
    result = await session.execute(
        select(UserIdentityORM).where(UserIdentityORM.id == identity_id)
    )
    return result.scalar_one_or_none()


async def list_for_user(
    session: AsyncSession, user_id: str,
) -> list[UserIdentityORM]:
    """List a user's linked identities, with ``.provider`` populated.

    The eager load is load-bearing, not an optimisation. ``UserIdentityORM
    .provider`` is a default ``lazy="select"`` relationship, so touching it on
    an AsyncSession after the rows are detached from their statement raises
    ``MissingGreenlet`` rather than emitting a query. The 24h SSO re-auth path
    (``LocalIdentityService._latest_identity_slug``) reads ``.provider.slug``
    to build the re-login URL, and that lives in ``auth_service``, which may
    not import ``backend.app.*`` — so the fix belongs here, at the source of
    the rows.

    Without it, an SSO session crossing the re-auth ceiling gets a 500 from
    ``POST /auth/refresh`` instead of the structured
    ``{"error": "sso_reauth_required"}`` the frontend needs to bounce the user
    to their IdP, and the browser retries into the same 500 indefinitely.
    """
    result = await session.execute(
        select(UserIdentityORM)
        .where(UserIdentityORM.user_id == user_id)
        .options(selectinload(UserIdentityORM.provider))
        .order_by(UserIdentityORM.created_at.asc())
    )
    return list(result.scalars().all())


# ── Lifecycle ───────────────────────────────────────────────────────


async def create_identity(
    session: AsyncSession,
    *,
    user_id: str,
    provider_id: str,
    external_id: str,
    email_at_link: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> UserIdentityORM:
    """Insert a new identity row. Caller MUST have already enforced any
    linking policy guardrails (see ``service.complete_sso_login``)."""
    row = UserIdentityORM(
        user_id=user_id,
        provider_id=provider_id,
        external_id=external_id,
        email_at_link=email_at_link,
        created_at=_now(),
        last_login_at=_now(),
        metadata_=json.dumps(metadata or {}, default=str),
    )
    session.add(row)
    await session.flush()
    return row


async def touch_last_login(
    session: AsyncSession, identity_id: str,
    *,
    metadata: Optional[dict] = None,
) -> None:
    row = await get_by_id(session, identity_id)
    if row is None:
        return
    row.last_login_at = _now()
    if metadata is not None:
        row.metadata_ = json.dumps(metadata, default=str)
    await session.flush()


async def delete_identity(
    session: AsyncSession,
    *,
    identity_id: str,
    enforce_last_authenticator: bool = True,
) -> None:
    """Remove an identity row.

    When ``enforce_last_authenticator`` is True (the self-service
    path) we refuse the delete if it would leave the user unable to
    log in. Admins call with ``False`` to force-unlink (e.g. wiping a
    breached identity before resetting the user's password).
    """
    row = await get_by_id(session, identity_id)
    if row is None:
        raise IdentityNotFound(identity_id)

    if enforce_last_authenticator:
        from backend.auth_service.core.password import is_password_set

        user_q = await session.execute(
            select(UserORM).where(UserORM.id == row.user_id)
        )
        user = user_q.scalar_one_or_none()
        if user is None:
            # Orphan — let the cascade clean it up.
            await session.execute(
                delete(UserIdentityORM).where(UserIdentityORM.id == identity_id)
            )
            return
        other_q = await session.execute(
            select(UserIdentityORM.id).where(
                UserIdentityORM.user_id == row.user_id,
                UserIdentityORM.id != identity_id,
            )
        )
        has_other = other_q.first() is not None
        has_password = is_password_set(user.password_hash)
        if not has_other and not has_password:
            raise LastAuthenticatorError(
                "Removing this identity would lock the user out — set a "
                "password or link another identity first."
            )

    await session.execute(
        delete(UserIdentityORM).where(UserIdentityORM.id == identity_id)
    )


async def has_any_identity(session: AsyncSession, user_id: str) -> bool:
    result = await session.execute(
        select(UserIdentityORM.id).where(UserIdentityORM.user_id == user_id)
    )
    return result.first() is not None
