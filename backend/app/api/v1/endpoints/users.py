"""
User endpoints (authenticated) and admin user management endpoints.

Authenticated:
    GET  /api/v1/users/me

Admin:
    GET   /api/v1/admin/users?status=pending
    POST  /api/v1/admin/users/{user_id}/approve
    POST  /api/v1/admin/users/{user_id}/reject
    PUT   /api/v1/admin/users/{user_id}/role
    POST  /api/v1/admin/users/{user_id}/suspend
    POST  /api/v1/admin/users/{user_id}/reactivate
    POST  /api/v1/admin/users/{user_id}/reset-password
    POST  /api/v1/admin/users/{user_id}/generate-reset-token
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, require_admin
from backend.app.auth.password import hash_password
from backend.app.api.v1.endpoints.auth import _check_password_strength
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.common.models.auth import (
    AdminUserResponse,
    AdminResetPasswordRequest,
    ApproveRejectRequest,
    ChangeRoleRequest,
    CreateInviteRequest,
    InviteTokenResponse,
    ResetTokenResponse,
    UpdateUserRequest,
    UserPublicResponse,
)

logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────

async def _public_response(session: AsyncSession, user) -> UserPublicResponse:
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    return UserPublicResponse(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        displayName=f"{user.first_name} {user.last_name}",
        status=user.status,
        role=role,
        createdAt=user.created_at,
    )


async def _admin_response(session: AsyncSession, user) -> AdminUserResponse:
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    has_reset = await user_repo.has_pending_reset(session, user.id)
    return AdminUserResponse(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        displayName=f"{user.first_name} {user.last_name}",
        status=user.status,
        role=role,
        createdAt=user.created_at,
        updatedAt=user.updated_at,
        resetRequested=has_reset,
    )


# ── Authenticated user routes ─────────────────────────────────────────

router = APIRouter()


@router.get("/me", response_model=UserPublicResponse)
async def get_me(
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await _public_response(session, current_user)


# ── Admin routes ───────────────────────────────────────────────────────

admin_router = APIRouter()


@admin_router.get("", response_model=list[AdminUserResponse])
async def list_users(
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    users = await user_repo.list_users(session, status=status_filter, limit=limit, offset=offset)
    return [await _admin_response(session, u) for u in users]


@admin_router.post("/{user_id}/approve", status_code=status.HTTP_200_OK)
async def approve_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status != "pending":
        raise HTTPException(status_code=409, detail=f"User is already '{user.status}', not pending")

    # Activate user. Phase 6: no automatic role assignment — approval
    # only marks the account as active; workspace access is granted
    # separately via the workspace-members endpoint. The ``User.role``
    # DTO field falls back to ``workspace_member`` via
    # ``_primary_role`` for display when no rows exist.
    await user_repo.update_user_status(session, user_id, "active")

    # Resolve approval record
    await user_repo.resolve_approval(
        session, user_id, status="approved", approved_by=admin.id,
    )

    # Outbox
    await user_repo.create_outbox_event(
        session,
        event_type="user.approved",
        payload={"user_id": user_id, "approved_by": admin.id},
    )

    logger.info("User %s approved by %s", user_id, admin.id)
    return {"detail": "User approved"}


@admin_router.post("/{user_id}/reject", status_code=status.HTTP_200_OK)
async def reject_user(
    user_id: str,
    body: ApproveRejectRequest = None,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status != "pending":
        raise HTTPException(status_code=409, detail=f"User is already '{user.status}', not pending")

    reason = body.rejection_reason if body else None

    await user_repo.update_user_status(session, user_id, "suspended")
    await user_repo.resolve_approval(
        session, user_id,
        status="rejected",
        approved_by=admin.id,
        rejection_reason=reason,
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.rejected",
        payload={"user_id": user_id, "rejected_by": admin.id, "reason": reason},
    )

    logger.info("User %s rejected by %s", user_id, admin.id)
    return {"detail": "User rejected"}


# ── Identity edit ─────────────────────────────────────────────────────

@admin_router.patch("/{user_id}", response_model=AdminUserResponse)
async def update_user_identity(
    user_id: str,
    body: UpdateUserRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an admin-editable identity field on a user.

    Only first / last name are mutable; email change is a separate
    re-link flow because it's the SSO identity key. Display name is
    derived from first + last on the server (single source of truth).
    """
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    updates: dict[str, str] = {}
    if body.first_name is not None and body.first_name.strip():
        updates["first_name"] = body.first_name.strip()
    if body.last_name is not None and body.last_name.strip():
        updates["last_name"] = body.last_name.strip()
    if not updates:
        # Nothing to do — return the current state so the client can
        # refresh without a separate GET.
        return await _admin_response(session, user)

    await user_repo.update_identity(session, user_id, **updates)

    await user_repo.create_outbox_event(
        session,
        event_type="user.identity_updated",
        payload={
            "user_id": user_id,
            "updated_fields": list(updates.keys()),
            "updated_by": admin.id,
        },
    )

    logger.info("User %s identity updated by %s: %s", user_id, admin.id, list(updates.keys()))

    refreshed = await user_repo.get_user_by_id(session, user_id)
    return await _admin_response(session, refreshed)


# ── Role change ───────────────────────────────────────────────────────

@admin_router.put("/{user_id}/role", status_code=status.HTTP_200_OK)
async def change_user_role(
    user_id: str,
    body: ChangeRoleRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent changing own role (protect the super admin)
    if user.id == admin.id:
        raise HTTPException(status_code=403, detail="Cannot change your own role")

    # Phase 6: ``replace_roles`` now writes both ``user_roles`` (legacy
    # display) and ``role_bindings`` (canonical claims). The
    # ChangeRoleRequest DTO restricts ``body.role`` to the
    # globally-assignable set, but ``set_global_role`` re-validates so
    # the contract is enforced at the repo boundary too — a defensive
    # 400 covers the case where someone slips a workspace-template
    # role past the DTO via a custom client.
    try:
        await user_repo.replace_roles(
            session, user_id, body.role, granted_by=admin.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Phase 7: kill the target user's live sessions so the new claim
    # (promotion OR demotion) takes effect on the next request, not
    # at the end of the current JWT TTL. Best-effort.
    # Phase 9: ``reason`` lands in the audit ``user.session_revoked``.
    from backend.app.services.revocation_service import revoke_subject_sessions
    revoked = await revoke_subject_sessions(
        "user", user_id, session=session, reason="role_changed",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.role_changed",
        payload={
            "user_id": user_id,
            "new_role": body.role,
            "changed_by": admin.id,
            "sessions_revoked": revoked,
        },
    )

    logger.info(
        "User %s role changed to '%s' by %s (sessions killed: %d)",
        user_id, body.role, admin.id, revoked,
    )
    return {"detail": f"Role changed to '{body.role}'"}


# ── Suspend ───────────────────────────────────────────────────────────

@admin_router.post("/{user_id}/suspend", status_code=status.HTTP_200_OK)
async def suspend_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=403, detail="Cannot suspend yourself")
    if user.status == "suspended":
        raise HTTPException(status_code=409, detail="User is already suspended")

    await user_repo.update_user_status(session, user_id, "suspended")

    await user_repo.create_outbox_event(
        session,
        event_type="user.suspended",
        payload={"user_id": user_id, "suspended_by": admin.id},
    )

    logger.info("User %s suspended by %s", user_id, admin.id)
    return {"detail": "User suspended"}


# ── Reactivate ────────────────────────────────────────────────────────

@admin_router.post("/{user_id}/reactivate", status_code=status.HTTP_200_OK)
async def reactivate_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status == "active":
        raise HTTPException(status_code=409, detail="User is already active")

    await user_repo.update_user_status(session, user_id, "active")

    # Phase 6: reactivation no longer auto-assigns a global role —
    # any previous role_bindings / user_roles rows survived the
    # suspend (we only flipped status), and the legacy display
    # fallback covers the empty case.

    await user_repo.create_outbox_event(
        session,
        event_type="user.reactivated",
        payload={"user_id": user_id, "reactivated_by": admin.id},
    )

    logger.info("User %s reactivated by %s", user_id, admin.id)
    return {"detail": "User reactivated"}


# ── Admin password reset (direct) ────────────────────────────────────

@admin_router.post("/{user_id}/reset-password", status_code=status.HTTP_200_OK)
async def admin_reset_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Admin directly sets a new password for a user."""
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    _check_password_strength(body.new_password)
    hashed = hash_password(body.new_password)
    await user_repo.update_password(session, user_id, hashed)

    await user_repo.create_outbox_event(
        session,
        event_type="user.password_reset_by_admin",
        payload={"user_id": user_id, "reset_by": admin.id},
    )

    logger.info("Password reset for user %s by admin %s", user_id, admin.id)
    return {"detail": "Password has been reset"}


# ── Generate reset token (for admin to share with user) ──────────────

@admin_router.post(
    "/{user_id}/generate-reset-token",
    response_model=ResetTokenResponse,
    status_code=status.HTTP_200_OK,
)
async def generate_reset_token(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Generate a reset token that the admin can share with the user."""
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    raw_token, expires_at = await user_repo.create_reset_token(session, user_id)

    await user_repo.create_outbox_event(
        session,
        event_type="user.reset_token_generated",
        payload={"user_id": user_id, "generated_by": admin.id},
    )

    logger.info("Reset token generated for user %s by admin %s", user_id, admin.id)
    return ResetTokenResponse(resetToken=raw_token, expiresAt=expires_at)


# ── Invite link ──────────────────────────────────────────────────────

# Phase 11: workspace-template system roles. Stored ``scope_type=
# 'global'`` in the roles table (they bind to any workspace) but
# they are NOT globally meaningful — an invite for one of these
# MUST carry a workspace_id.
_WORKSPACE_TEMPLATE_ROLES = frozenset({
    "workspace_admin", "workspace_member", "workspace_viewer",
})
_GLOBAL_TIER_ROLES = frozenset({"super_admin", "org_admin"})


def _role_is_privileged(perms: list[str]) -> bool:
    """A role is privileged (→ requires an email-bound invite) if it
    grants ``workspace:admin`` or any ``system:*`` permission. Custom
    roles are classified automatically from their permission bundle."""
    return any(p == "workspace:admin" or p.startswith("system:") for p in perms)


@admin_router.post(
    "/invite",
    response_model=InviteTokenResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_invite(
    body: CreateInviteRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Generate a signed invite token that lets a new user sign up and
    be auto-activated with the specified role. The frontend constructs
    the full URL from its own origin.

    Phase 11 — tiered invites:
      * ``role`` omitted → plain activated account.
      * Workspace-tier / custom-workspace roles → require a
        ``workspace_id`` (custom workspace roles fix it to the role's
        own scope).
      * Global-tier / custom-global roles → no workspace.
      * Privileged roles (grant ``workspace:admin`` or any
        ``system:*``) → require a target ``email`` so the link is
        bound to one identity and can't be forwarded to escalate
        another user.
    """
    from backend.app.auth.jwt import create_invite_token
    from backend.app.db.repositories import group_repo, role_repo, workspace_repo

    resolved_workspace_id: Optional[str] = None
    resolved_group_ids: list[str] = []

    # Phase 13: validate any attached groups first. Reject unknown
    # or protected groups (the latter exist to defend IdP-mapped
    # collections from accidental admin additions; they can't be
    # invite-targeted either).
    if body.group_ids:
        for gid in body.group_ids:
            grp = await group_repo.get_group_by_id(session, gid)
            if grp is None:
                raise HTTPException(
                    status_code=400, detail=f"Unknown group '{gid}'",
                )
            if getattr(grp, "is_protected", False):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Group '{grp.name}' is protected and cannot be "
                        f"added through invite links."
                    ),
                )
            resolved_group_ids.append(gid)

    # Phase 14: classify the role's privilege up-front so we can apply
    # the right email rule below. ``role_is_privileged`` only true when
    # a role is attached AND it carries workspace:admin or system:*.
    role = None
    role_is_privileged = False
    if body.role is not None:
        role = await role_repo.get_role(session, body.role)
        if role is None:
            raise HTTPException(
                status_code=400, detail=f"Unknown role '{body.role}'",
            )
        bundles = await role_repo.role_names_with_permissions(session, [body.role])
        perms = bundles.get(body.role, [])
        role_is_privileged = _role_is_privileged(perms)

    # Email rules, most restrictive first:
    # 1. Privileged role → email always required (override doesn't
    #    apply; this is a per-identity escalation vector).
    if role_is_privileged and not body.email:
        raise HTTPException(
            status_code=400,
            detail=(
                "This role is privileged and must be sent to a specific "
                "email address — a shareable link could be forwarded to "
                "escalate another identity. Provide a target email."
            ),
        )
    # 2. Phase 14: groups → email required UNLESS the admin opts into
    #    a shareable group invite. The override is intentional and
    #    audit-logged; it serves the "everyone on the team click this
    #    to join the Designers group" workflow.
    if (
        resolved_group_ids
        and not body.email
        and not body.allow_shareable_with_groups
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invites that attach groups must be sent to a specific "
                "email address. To create a shareable group invite, "
                "explicitly set ``allowShareableWithGroups: true`` — "
                "the link will be forwardable and reusable, so only "
                "use it for low-stakes groups."
            ),
        )
    # Track whether the override is actually being used so we can
    # emit the distinct audit event below.
    is_shareable_groups_override = bool(
        resolved_group_ids
        and not body.email
        and body.allow_shareable_with_groups
    )

    if role is not None:

        # Scope classification.
        is_workspace_role = (
            body.role in _WORKSPACE_TEMPLATE_ROLES
            or role.scope_type == "workspace"
        )
        if is_workspace_role:
            if role.scope_type == "workspace":
                # Custom workspace role — workspace is fixed to its scope.
                resolved_workspace_id = role.scope_id
                if body.workspace_id and body.workspace_id != role.scope_id:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Role '{body.role}' is scoped to workspace "
                            f"'{role.scope_id}' and cannot be invited into a "
                            f"different workspace."
                        ),
                    )
            else:
                # Workspace template — admin must pick a workspace.
                if not body.workspace_id:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Role '{body.role}' is workspace-scoped; a "
                            f"workspace must be selected for the invite."
                        ),
                    )
                resolved_workspace_id = body.workspace_id

            # Confirm the target workspace exists.
            if not await workspace_repo.get_workspace_orm(session, resolved_workspace_id):
                raise HTTPException(
                    status_code=404,
                    detail=f"Workspace '{resolved_workspace_id}' not found",
                )
            # Bindability guard (mirrors workspace-members POST).
            if not await role_repo.role_is_bindable_in_scope(
                session, role_name=body.role,
                binding_scope_type="workspace",
                binding_scope_id=resolved_workspace_id,
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Role '{body.role}' cannot be bound in workspace "
                        f"'{resolved_workspace_id}'."
                    ),
                )
        else:
            # Global role — reject a stray workspace_id.
            if body.workspace_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Role '{body.role}' is global and cannot be "
                        f"workspace-scoped."
                    ),
                )

    token, expires_at = create_invite_token(
        role=body.role,
        created_by=admin.id,
        expires_in_hours=body.expires_in_hours,
        workspace_id=resolved_workspace_id,
        email=body.email,
        group_ids=resolved_group_ids or None,
    )

    # Phase 14: distinct audit event when the shareable-groups override
    # was used, so an auditor can review who bypassed the email-pin
    # rule for group invites. Regular email-bound or no-groups invites
    # keep the standard event type.
    audit_event_type = (
        "user.invite_created_shareable_with_groups"
        if is_shareable_groups_override
        else "user.invite_created"
    )
    await user_repo.create_outbox_event(
        session,
        event_type=audit_event_type,
        payload={
            "role": body.role,
            "workspace_id": resolved_workspace_id,
            "email": body.email,
            "group_ids": resolved_group_ids,
            "shareable_groups_override": is_shareable_groups_override,
            "created_by": admin.id,
            "expires_at": expires_at,
        },
    )

    logger.info(
        "Invite token created by admin %s (role=%s ws=%s groups=%d email_bound=%s override=%s)",
        admin.id, body.role, resolved_workspace_id,
        len(resolved_group_ids), bool(body.email),
        is_shareable_groups_override,
    )
    return InviteTokenResponse(
        inviteToken=token,
        role=body.role,
        workspaceId=resolved_workspace_id,
        email=body.email,
        groupIds=resolved_group_ids or None,
        expiresAt=expires_at,
    )
