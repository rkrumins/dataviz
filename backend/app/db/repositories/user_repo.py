"""
Repository: users, user_roles, user_approvals, outbox_events.

All functions are module-level async coroutines that accept a SQLAlchemy
AsyncSession as the first argument (matching the project-wide pattern).
Queries on users exclude soft-deleted rows (deleted_at IS NULL) by default.
"""
import json
import secrets
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    UserORM,
    UserRoleORM,
    UserApprovalORM,
    OutboxEventORM,
    RoleBindingORM,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Users ──────────────────────────────────────────────────────────────

async def create_user(
    session: AsyncSession,
    email: str,
    password_hash: str,
    first_name: str,
    last_name: str,
    status: str = "pending",
    signup_source: str = "local_signup",
    signup_provider_id: Optional[str] = None,
) -> UserORM:
    """Local-password (or invite/admin) signup. Phase 4 carries
    ``signup_source`` (default ``'local_signup'``); the invite + admin
    flows pass ``'invite'`` / ``'admin_created'``."""
    user = UserORM(
        email=email.strip().lower(),
        password_hash=password_hash,
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        status=status,
        signup_source=signup_source,
        signup_provider_id=signup_provider_id,
    )
    session.add(user)
    await session.flush()
    return user


async def get_user_by_email(session: AsyncSession, email: str) -> Optional[UserORM]:
    result = await session.execute(
        select(UserORM).where(
            UserORM.email == email.strip().lower(),
            UserORM.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def get_user_by_id(session: AsyncSession, user_id: str) -> Optional[UserORM]:
    result = await session.execute(
        select(UserORM).where(
            UserORM.id == user_id,
            UserORM.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


# ── SSO provisioning (identity rows live in user_identity_repo) ────────


async def create_sso_user(
    session: AsyncSession,
    *,
    email: str,
    first_name: str,
    last_name: str,
    password_hash: str,
    signup_source: str = "sso_jit",
    signup_provider_id: Optional[str] = None,
) -> UserORM:
    """JIT-provision an IdP-owned account. Active immediately (the IdP
    authenticated the subject); no role bindings — permissions stay
    default-deny until a group/role mapping or admin grant lands.

    ``password_hash`` is the disabled-sentinel from
    ``auth_service.core.password.disabled_password_hash()`` so the
    local password path can never authenticate this account. The
    actual SSO subject lives in ``user_identities`` — call
    ``user_identity_repo.create_identity()`` in the same transaction.

    Phase 4: ``signup_source`` defaults to ``'sso_jit'`` and
    ``signup_provider_id`` records the IdP that provisioned the
    account, so the admin lookup surface can answer "how did this
    user sign up?" without replaying the audit log.
    """
    user = UserORM(
        email=email.strip().lower(),
        password_hash=password_hash,
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        status="active",
        signup_source=signup_source,
        signup_provider_id=signup_provider_id,
    )
    session.add(user)
    await session.flush()
    return user


async def disable_password(
    session: AsyncSession, user_id: str, disabled_hash: str,
) -> Optional[UserORM]:
    """Replace a user's password hash with the disabled sentinel.
    Used when an admin force-migrates a local account to SSO-only
    so the password path can never authenticate them again."""
    user = await get_user_by_id(session, user_id)
    if user is None:
        return None
    user.password_hash = disabled_hash
    user.updated_at = _now()
    await session.flush()
    return user


async def set_user_idp_metadata(
    session: AsyncSession,
    *,
    user_id: str,
    idp_groups: list[str],
    raw_claims: Optional[dict] = None,
    attributes: Optional[dict] = None,
    source_provider_id: Optional[str] = None,
) -> Optional[UserORM]:
    """Persist the latest IdP-asserted groups, raw claims, and
    operator-mapped extra attributes (department, employee_id, …)
    into ``users.metadata_``. Called from ``complete_sso_login`` on
    every SSO login so the admin UI / ``/me`` can surface the most
    recent snapshot.

    The metadata column is a free-form JSON document; we merge rather
    than overwrite — other top-level keys (UI prefs, etc.) survive.

    Phase 4: ``attributes`` are ALSO projected into
    ``user_external_attributes`` so the admin lookup surface can
    resolve a user by ``staff_id=12345`` via an indexed query.
    """
    user = await get_user_by_id(session, user_id)
    if user is None:
        return None
    try:
        meta = json.loads(user.metadata_ or "{}")
        if not isinstance(meta, dict):
            meta = {}
    except (ValueError, TypeError):
        meta = {}
    meta["idp_groups"] = list(idp_groups)
    if raw_claims is not None:
        meta["idp_last_claims"] = raw_claims
    if attributes is not None:
        # Merge attribute keys so subsequent IdPs add to (not replace)
        # the picture. Last-writer wins per key.
        merged_attrs = dict(meta.get("attributes", {}))
        merged_attrs.update(attributes)
        meta["attributes"] = merged_attrs
    meta["idp_last_login_at"] = _now()
    user.metadata_ = json.dumps(meta, default=str)
    user.updated_at = _now()
    await session.flush()

    # Indexed projection so the admin lookup endpoint can resolve
    # users by attribute value. Best-effort: a write error here MUST
    # NOT roll back the login (the JSON snapshot is the source of
    # truth; the index is for query convenience).
    if attributes:
        try:
            from backend.app.db.repositories import user_attribute_repo
            await user_attribute_repo.upsert_for_user(
                session,
                user_id=user_id,
                attributes=attributes,
                source_provider_id=source_provider_id,
            )
        except Exception:  # noqa: BLE001 — defensive
            pass

    return user


# ── Admin search / fan-out lookup (Phase 4) ────────────────────────────


async def search_users(
    session: AsyncSession,
    *,
    q: str,
    limit: int = 20,
) -> list[UserORM]:
    """Free-text fan-out across email + first/last name. Used by the
    admin ``/admin/users/search`` endpoint. The identities / external-
    attribute scans live in their own repos; the endpoint joins
    results."""
    q = (q or "").strip()
    if not q:
        return []
    needle = f"%{q}%"
    result = await session.execute(
        select(UserORM)
        .where(
            UserORM.deleted_at.is_(None),
        )
        .where(
            (UserORM.email.ilike(needle))
            | (UserORM.first_name.ilike(needle))
            | (UserORM.last_name.ilike(needle))
            | (UserORM.id == q)
        )
        .order_by(UserORM.email.asc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def list_users(
    session: AsyncSession,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[UserORM]:
    stmt = select(UserORM).where(UserORM.deleted_at.is_(None))
    if status:
        stmt = stmt.where(UserORM.status == status)
    stmt = stmt.order_by(UserORM.created_at.desc()).limit(limit).offset(offset)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def count_users(session: AsyncSession, status: Optional[str] = None) -> int:
    stmt = select(func.count()).select_from(UserORM).where(UserORM.deleted_at.is_(None))
    if status:
        stmt = stmt.where(UserORM.status == status)
    result = await session.execute(stmt)
    return result.scalar_one()


async def update_user_status(session: AsyncSession, user_id: str, status: str) -> Optional[UserORM]:
    user = await get_user_by_id(session, user_id)
    if user is None:
        return None
    user.status = status
    user.updated_at = _now()
    await session.flush()
    return user


# ── Roles ──────────────────────────────────────────────────────────────
#
# Two tables track a user's role state and they need to stay in sync:
#
#   * ``user_roles``  — legacy Phase-0 table used by ``require_admin``'s
#     fallback path and surfaced on the ``User.role`` DTO field for
#     display. CHECK-constraint-bound to the post-Phase-5 taxonomy.
#   * ``role_bindings`` — canonical (subject, role, scope) store the
#     resolver reads to build ``PermissionClaims`` for the JWT.
#
# Phase 6 invariant: **every write that grants a global role goes
# through this module and updates both tables in one transaction**.
# Writing to one without the other produces the "Alice is promoted to
# super_admin in the UI but every endpoint 403s her" footgun the audit
# called out (issue #1).

# Roles that are global-only and meaningful when assigned via the
# ``/admin/users/{id}/role`` flow. The workspace-template roles
# (workspace_admin / workspace_member / workspace_viewer) describe
# powers inside a workspace and are bound via the workspace-members
# endpoint instead.
GLOBAL_ASSIGNABLE_ROLES: frozenset[str] = frozenset({
    "super_admin",
    "org_admin",
})


async def assign_role(session: AsyncSession, user_id: str, role_name: str) -> UserRoleORM:
    """Write a single ``user_roles`` row.

    Low-level helper kept for legacy call sites + tests that exercise
    the legacy table directly. New code that wants a user to actually
    have permissions should call ``set_global_role`` instead, which
    updates ``role_bindings`` too.
    """
    role = UserRoleORM(user_id=user_id, role_name=role_name)
    session.add(role)
    await session.flush()
    return role


async def set_global_role(
    session: AsyncSession,
    user_id: str,
    role_name: str,
    *,
    granted_by: Optional[str] = None,
) -> None:
    """Set the user's single global role, syncing both stores.

    Replaces all existing rows in ``user_roles`` AND all existing
    global-scope rows in ``role_bindings`` for this user. The two
    writes happen in one transaction so the legacy display and the
    JWT claim cannot drift.

    ``role_name`` must be in ``GLOBAL_ASSIGNABLE_ROLES`` — assigning
    a workspace-template role globally is semantically meaningless
    (no workspace context) and would silently grant nothing once the
    resolver's category × scope filter runs.

    Raises ``ValueError`` for an unsupported role name; the endpoint
    layer maps that to 400.
    """
    if role_name not in GLOBAL_ASSIGNABLE_ROLES:
        raise ValueError(
            f"role_name must be one of {sorted(GLOBAL_ASSIGNABLE_ROLES)}, "
            f"got {role_name!r}"
        )

    # 1. Legacy ``user_roles`` table — replace.
    await session.execute(
        delete(UserRoleORM).where(UserRoleORM.user_id == user_id)
    )
    session.add(UserRoleORM(user_id=user_id, role_name=role_name))

    # 2. Canonical ``role_bindings`` — drop existing global bindings
    #    for this user, insert the new one. Workspace-scope bindings
    #    (set via the workspace-members endpoint) are left untouched
    #    so promoting a workspace_admin to super_admin globally
    #    doesn't yank their workspace memberships.
    await session.execute(
        delete(RoleBindingORM).where(
            RoleBindingORM.subject_type == "user",
            RoleBindingORM.subject_id == user_id,
            RoleBindingORM.scope_type == "global",
        )
    )
    session.add(RoleBindingORM(
        subject_type="user",
        subject_id=user_id,
        role_name=role_name,
        scope_type="global",
        scope_id=None,
        granted_by=granted_by,
        source="local",
    ))

    await session.flush()


async def clear_global_role(session: AsyncSession, user_id: str) -> None:
    """Drop every global role row for this user, from both stores.

    Used when a user is suspended / rejected and we want the next
    login to surface zero permissions even if the legacy
    ``user.role`` field falls back to the ``workspace_member``
    sentinel.
    """
    await session.execute(
        delete(UserRoleORM).where(UserRoleORM.user_id == user_id)
    )
    await session.execute(
        delete(RoleBindingORM).where(
            RoleBindingORM.subject_type == "user",
            RoleBindingORM.subject_id == user_id,
            RoleBindingORM.scope_type == "global",
        )
    )
    await session.flush()


async def get_user_roles(session: AsyncSession, user_id: str) -> list[str]:
    result = await session.execute(
        select(UserRoleORM.role_name).where(UserRoleORM.user_id == user_id)
    )
    return list(result.scalars().all())


# ── Approvals ──────────────────────────────────────────────────────────

async def create_approval(
    session: AsyncSession,
    user_id: str,
    status: str = "pending",
    approved_by: Optional[str] = None,
    rejection_reason: Optional[str] = None,
) -> UserApprovalORM:
    approval = UserApprovalORM(
        user_id=user_id,
        status=status,
        approved_by=approved_by,
        rejection_reason=rejection_reason,
        resolved_at=_now() if status != "pending" else None,
    )
    session.add(approval)
    await session.flush()
    return approval


async def resolve_approval(
    session: AsyncSession,
    user_id: str,
    status: str,
    approved_by: str,
    rejection_reason: Optional[str] = None,
) -> Optional[UserApprovalORM]:
    """Resolve the pending approval for a user."""
    result = await session.execute(
        select(UserApprovalORM).where(
            UserApprovalORM.user_id == user_id,
            UserApprovalORM.status == "pending",
        )
    )
    approval = result.scalar_one_or_none()
    if approval is None:
        return None
    approval.status = status
    approval.approved_by = approved_by
    approval.rejection_reason = rejection_reason
    approval.resolved_at = _now()
    await session.flush()
    return approval


# ── Outbox ─────────────────────────────────────────────────────────────

async def create_outbox_event(
    session: AsyncSession,
    event_type: str,
    payload: dict,
) -> OutboxEventORM:
    event = OutboxEventORM(
        event_type=event_type,
        payload=json.dumps(payload),
    )
    session.add(event)
    await session.flush()
    return event


# ── Password management ───────────────────────────────────────────────

async def update_password(session: AsyncSession, user_id: str, password_hash: str) -> Optional[UserORM]:
    user = await get_user_by_id(session, user_id)
    if user is None:
        return None
    user.password_hash = password_hash
    user.reset_token_hash = None
    user.reset_token_expires_at = None
    user.updated_at = _now()
    await session.flush()
    return user


def _hash_token(token: str) -> str:
    """SHA-256 hash a reset token for safe storage."""
    return hashlib.sha256(token.encode()).hexdigest()


async def create_reset_token(
    session: AsyncSession,
    user_id: str,
    expiry_hours: int = 1,
) -> tuple[str, str]:
    """Generate a reset token, store its hash, and return (raw_token, expires_at)."""
    user = await get_user_by_id(session, user_id)
    if user is None:
        raise ValueError("User not found")
    raw_token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=expiry_hours)).isoformat()
    user.reset_token_hash = _hash_token(raw_token)
    user.reset_token_expires_at = expires_at
    user.updated_at = _now()
    await session.flush()
    return raw_token, expires_at


async def verify_reset_token(session: AsyncSession, token: str) -> Optional[UserORM]:
    """Find the user matching a reset token (if valid and not expired)."""
    token_hash = _hash_token(token)
    result = await session.execute(
        select(UserORM).where(
            UserORM.reset_token_hash == token_hash,
            UserORM.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()
    if user is None:
        return None
    # Check expiry
    if user.reset_token_expires_at:
        expires = datetime.fromisoformat(user.reset_token_expires_at)
        if datetime.now(timezone.utc) > expires:
            return None
    return user


async def clear_reset_token(session: AsyncSession, user_id: str) -> None:
    user = await get_user_by_id(session, user_id)
    if user:
        user.reset_token_hash = None
        user.reset_token_expires_at = None
        user.updated_at = _now()
        await session.flush()


async def flag_reset_requested(session: AsyncSession, user_id: str) -> None:
    """Mark a user as having requested a password reset (without creating
    a token).  Sets a sentinel value on reset_token_hash so that
    has_pending_reset() returns True for the admin dashboard."""
    user = await get_user_by_id(session, user_id)
    if user:
        user.reset_token_hash = "__requested__"
        user.reset_token_expires_at = None
        user.updated_at = _now()
        await session.flush()


async def has_pending_reset(session: AsyncSession, user_id: str) -> bool:
    """Check if a user has a pending reset request or a non-expired reset token."""
    user = await get_user_by_id(session, user_id)
    if user is None or not user.reset_token_hash:
        return False
    # Sentinel means user requested a reset but admin hasn't generated a token yet
    if user.reset_token_hash == "__requested__":
        return True
    if user.reset_token_expires_at:
        expires = datetime.fromisoformat(user.reset_token_expires_at)
        return datetime.now(timezone.utc) <= expires
    return False


# ── Role management ───────────────────────────────────────────────────

async def replace_roles(
    session: AsyncSession,
    user_id: str,
    new_role: str,
    *,
    granted_by: Optional[str] = None,
) -> None:
    """Replace the user's global role across both stores.

    Thin wrapper over ``set_global_role`` kept under the legacy name
    for existing call sites. New code should call ``set_global_role``
    directly — the kwarg surface there matches the explicit two-table
    write semantics.
    """
    await set_global_role(session, user_id, new_role, granted_by=granted_by)


# ── Group membership shortcuts (RBAC Phase 1) ─────────────────────────
# Thin wrappers around group_repo so call sites that already have the
# user repo handy don't need to import group_repo directly. Kept here
# rather than as new top-level helpers because the typical caller is
# user-centric ("add this user to a group", "what groups is this user
# in?"). For full group lifecycle (CRUD, member listing) use
# ``group_repo`` directly.

async def add_to_group(
    session: AsyncSession,
    user_id: str,
    group_id: str,
    added_by: Optional[str] = None,
):
    from . import group_repo  # local import to avoid circular import
    return await group_repo.add_member(session, group_id, user_id, added_by=added_by)


async def remove_from_group(
    session: AsyncSession, user_id: str, group_id: str
) -> bool:
    from . import group_repo
    return await group_repo.remove_member(session, group_id, user_id)


async def get_groups_for_user(session: AsyncSession, user_id: str) -> list[str]:
    """Group ids the user belongs to. Hot path; called on every login."""
    from . import group_repo
    return await group_repo.get_user_groups(session, user_id)
