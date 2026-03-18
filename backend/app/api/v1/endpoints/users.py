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
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.common.models.auth import (
    AdminUserResponse,
    AdminResetPasswordRequest,
    ApproveRejectRequest,
    ChangeRoleRequest,
    ResetTokenResponse,
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

    # Activate user + assign default role
    await user_repo.update_user_status(session, user_id, "active")
    await user_repo.assign_role(session, user_id, "user")

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

    await user_repo.replace_roles(session, user_id, body.role)

    await user_repo.create_outbox_event(
        session,
        event_type="user.role_changed",
        payload={"user_id": user_id, "new_role": body.role, "changed_by": admin.id},
    )

    logger.info("User %s role changed to '%s' by %s", user_id, body.role, admin.id)
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

    # Ensure they have at least the 'user' role
    roles = await user_repo.get_user_roles(session, user_id)
    if not roles:
        await user_repo.assign_role(session, user_id, "user")

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
