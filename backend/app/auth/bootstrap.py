"""The built-in administrator: seeded once, and made to choose its own password.

The first administrator is created from ``ADMIN_EMAIL`` / ``ADMIN_PASSWORD``
when the database has no users. Whatever that password is, somebody other
than the administrator chose it — it sits in a ``.env`` file, a Secret or a
values file, and often in this repository's examples — so the account must
replace it at its first sign-in.

Accounts created before that rule are caught at startup: a system account
still signing in with the configured starting password, or with any
password this repository publishes, is made to change it at its next
sign-in. An account that has already chosen its own password is left alone
even when ``ADMIN_PASSWORD`` has since been set to that password — operators
often do, so scripts can sign in — unless it is a published one.

The requirement holds password sign-ins only: an account that also signs in
through an identity provider keeps doing so (see
``auth_service.core.tokens.password_change_pending``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password, verify_password
from backend.app.db.models import OutboxEventORM, UserORM
from backend.app.db.repositories import user_repo
from backend.auth_service.core.password import is_password_set

logger = logging.getLogger(__name__)

DEFAULT_ADMIN_EMAIL = "admin@nexuslineage.local"
DEFAULT_ADMIN_PASSWORD = "changeme"

#: Every ``ADMIN_PASSWORD`` value this repository ships — in the example
#: environment files, the quickstart compose file, the Kubernetes and Helm
#: examples and the setup docs — plus the code default. An account holding
#: one of these holds a password that is public knowledge.
#: ``test_system_admin_bootstrap.py`` fails when an example adds a new one.
PUBLISHED_PASSWORDS = frozenset({
    DEFAULT_ADMIN_PASSWORD,
    "admin123",
    "REPLACE_ME",
    "change-me",
    "CHANGE_ME_random_16_chars",
    "<admin-password>",
})


def admin_email() -> str:
    """``ADMIN_EMAIL``, or the default when it is unset or empty."""
    email = os.getenv("ADMIN_EMAIL")
    if not email:
        return DEFAULT_ADMIN_EMAIL
    return email


def starting_password() -> str:
    """``ADMIN_PASSWORD``, or the default when it is unset or empty.

    An empty value is a misconfiguration, not a choice: password sign-in
    refuses an empty password, so an administrator seeded with one could
    never sign in at all.
    """
    password = os.getenv("ADMIN_PASSWORD")
    if not password:
        return DEFAULT_ADMIN_PASSWORD
    return password


async def seed_system_admin(session: AsyncSession) -> Optional[str]:
    """Create the built-in administrator if the database has no users.

    Returns its email when it was created, ``None`` when users already
    exist. Raises ``IntegrityError`` when another worker created it first;
    the caller treats that as the expected outcome of a race.
    """
    if await user_repo.count_users(session) != 0:
        return None
    email = admin_email()
    user = await user_repo.create_user(
        session,
        email=email,
        password_hash=hash_password(starting_password()),
        first_name="System",
        last_name="Admin",
        status="active",
    )
    user.must_change_password = True
    # The seeded admin is the deployment's break-glass account: it keeps
    # password sign-in even when the platform enforces SSO, and forced
    # sign-out sweeps skip it. Marked here because this is the one account
    # that exists before any operator can mark anything.
    await user_repo.set_system_account(session, user.id, True)
    # Phase 6: ``set_global_role`` writes both ``user_roles`` (legacy
    # display) and ``role_bindings`` (canonical claims) so the bootstrap
    # admin actually has system:admin in their JWT, not just on the DTO.
    await user_repo.set_global_role(
        session, user.id, "super_admin", granted_by="system",
    )
    await user_repo.create_approval(
        session, user.id, status="approved", approved_by="system",
    )
    return email


#: Events that mean an account's password was chosen by the account itself
#: — a change from Account settings or a reset link — or set from the host by
#: the operator recovering it, or set by an administrator on their own
#: account. (An administrator setting somebody else's password marks the
#: account to change it, so that case never reaches the check below.)
_OWN_PASSWORD_EVENTS = (
    "user.password_changed",
    "user.password_reset_completed",
    "user.password_reset_by_admin",
)


async def _has_chosen_own_password(session: AsyncSession, user_id: str) -> bool:
    """Whether the audit trail shows this account choosing its password.

    Read from ``outbox_events``, which keeps every event; older events
    carry the account only in their payload, so both are matched.
    """
    rows = (await session.execute(
        select(OutboxEventORM.event_type, OutboxEventORM.payload).where(
            OutboxEventORM.event_type.in_(_OWN_PASSWORD_EVENTS),
            or_(
                OutboxEventORM.aggregate_id == user_id,
                OutboxEventORM.payload.contains(user_id, autoescape=True),
            ),
        )
    )).all()
    for event_type, raw in rows:
        try:
            payload = json.loads(raw or "{}")
        except ValueError:
            continue
        if payload.get("user_id") != user_id:
            continue
        if event_type != "user.password_reset_by_admin":
            return True
        if payload.get("via") == "cli" or payload.get("reset_by") == user_id:
            return True
    return False


async def hold_unchanged_system_accounts(session: AsyncSession) -> list[str]:
    """Make each system account still on a password it didn't choose change it.

    Checks every system account that has a password and isn't already
    held against every published password, and — unless the account has
    chosen its own password before — against the configured starting
    password. Returns the ids it held. A few Argon2 verifications per
    system account, run off the event loop; there is normally one such
    account.
    """
    published = sorted(PUBLISHED_PASSWORDS)
    accounts = (await session.execute(
        select(UserORM.id, UserORM.password_hash).where(
            UserORM.is_system_account.is_(True),
            UserORM.deleted_at.is_(None),
            UserORM.must_change_password.is_(False),
        )
    )).all()
    held: list[str] = []
    for user_id, password_hash in accounts:
        if not is_password_set(password_hash):
            continue
        # ``ADMIN_PASSWORD`` matching is only evidence of an unchanged
        # starting password while the account has never chosen one.
        candidates = (
            published if await _has_chosen_own_password(session, user_id)
            else [starting_password(), *published]
        )
        for candidate in candidates:
            if await asyncio.to_thread(verify_password, candidate, password_hash):
                await user_repo.set_must_change_password(session, user_id, True)
                held.append(user_id)
                break
    return held
