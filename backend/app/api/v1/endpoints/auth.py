"""
Public authentication endpoints — the no-cookie subset: signup,
forgot-password, reset-password, verify-invite.

The cookie-issuing endpoints (/login, /logout, /refresh, /me) live in
``backend.auth_service.api.router`` and are mounted alongside this
router under /api/v1/auth/. They will follow into the extracted auth
service in a later move; the flows here remain because they don't yet
have a clean home in the new module.

POST /api/v1/auth/signup            → 201 + message
POST /api/v1/auth/forgot-password   → 200 + message (always succeeds)
POST /api/v1/auth/reset-password    → 200 + message
GET  /api/v1/auth/verify-invite     → 200 + InviteVerifyResponse
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.common.models.auth import (
    SignUpRequest,
    SignUpResponse,
    UserPublicResponse,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    InviteVerifyResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

limiter = Limiter(key_func=get_remote_address)


# ── helpers ────────────────────────────────────────────────────────────

def _check_password_strength(password: str) -> None:
    """
    Server-side password strength check using zxcvbn.
    Rejects passwords with score < 3.
    """
    try:
        from zxcvbn import zxcvbn
        result = zxcvbn(password)
        if result["score"] < 3:
            feedback = result.get("feedback", {})
            suggestions = feedback.get("suggestions", [])
            warning = feedback.get("warning", "")
            msg = "Password is too weak."
            if warning:
                msg += f" {warning}."
            if suggestions:
                msg += " " + " ".join(suggestions)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=msg,
            )
    except ImportError:
        # zxcvbn not installed — fall back to length-only check
        if len(password) < 8:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Password must be at least 8 characters.",
            )


async def _build_user_response(session: AsyncSession, user) -> UserPublicResponse:
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


# Phase 11: workspace-template system roles are bound at workspace
# scope on invite; super_admin/org_admin go through set_global_role
# (which also writes the legacy user_roles display row).
_INVITE_GLOBAL_TIER = frozenset({"super_admin", "org_admin"})


async def _grant_invite_role(
    session,
    *,
    user_id: str,
    role: str,
    workspace_id: Optional[str],
    granted_by: Optional[str],
) -> None:
    """Apply the invite's role to a freshly-created user.

    Global tiers (super_admin / org_admin) go through
    ``set_global_role`` so the legacy display badge stays correct.
    Everything else — workspace templates and custom roles — is a
    plain ``role_binding`` at the right scope.

    Re-validates bindability at signup time: the role could have
    been deleted or rescoped since the invite was minted. If it's
    no longer bindable we activate the user anyway (the invite is
    still valid) and log — we never 500 the signup over a stale
    role reference.
    """
    from backend.app.db.repositories import role_repo, binding_repo

    if role in _INVITE_GLOBAL_TIER:
        try:
            await user_repo.set_global_role(
                session, user_id, role, granted_by=granted_by,
            )
        except ValueError as exc:
            logger.warning(
                "Invite global role %s no longer assignable for %s: %s",
                role, user_id, exc,
            )
        return

    scope_type = "workspace" if workspace_id else "global"
    bindable = await role_repo.role_is_bindable_in_scope(
        session, role_name=role,
        binding_scope_type=scope_type, binding_scope_id=workspace_id,
    )
    if not bindable:
        logger.warning(
            "Invite role %s no longer bindable in scope %s/%s for %s; "
            "activating without a binding.",
            role, scope_type, workspace_id, user_id,
        )
        return

    await binding_repo.create_binding(
        session,
        subject_type="user",
        subject_id=user_id,
        role_name=role,
        scope_type=scope_type,
        scope_id=workspace_id,
        granted_by=granted_by,
    )


# ── POST /auth/signup ─────────────────────────────────────────────────

@router.post("/signup", response_model=SignUpResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def signup(
    request: Request,
    body: SignUpRequest,
    session: AsyncSession = Depends(get_db_session),
):
    import jwt as pyjwt
    from backend.app.auth.jwt import decode_invite_token

    # 1. Password strength
    _check_password_strength(body.password)

    # 2. Validate invite token (if provided). Phase 11: a valid
    # invite auto-activates the account and grants the token's role —
    # global tiers, workspace tiers, AND custom roles. The token
    # carries ``role`` + optional ``workspace_id`` (workspace-scoped
    # invites) + optional ``email`` (privileged roles pin a target
    # address so a forwarded link can't escalate an unintended user).
    invite_valid = False
    invite_role = None
    invite_admin = None
    invite_workspace_id = None
    invite_email = None
    invite_group_ids: list[str] = []
    if body.invite_token:
        try:
            payload = decode_invite_token(body.invite_token)
            invite_valid = True
            invite_role = payload.get("role")  # may be None (plain invite)
            invite_admin = payload.get("created_by")
            invite_workspace_id = payload.get("workspace_id")
            invite_email = payload.get("email")
            raw_groups = payload.get("group_ids") or []
            if isinstance(raw_groups, list):
                invite_group_ids = [g for g in raw_groups if isinstance(g, str)]
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invite link is invalid or has expired.",
            )

    # 2b. Email pin (Phase 11): an email-bound invite can only be
    # accepted by the pinned address. We check BEFORE the
    # enumeration-safe uniqueness short-circuit so a mismatched email
    # is a clear 400 rather than a silent no-op.
    if invite_email and invite_email.strip().lower() != body.email.strip().lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This invite is for a different email address.",
        )

    # 3. Check email uniqueness — return the same 201 response regardless
    # to prevent email enumeration attacks.
    existing = await user_repo.get_user_by_email(session, body.email)
    if existing is not None:
        logger.debug("Signup attempt with existing email (suppressed)")
        msg = "Account created and activated." if invite_valid else "Account created. Awaiting administrator approval."
        return SignUpResponse(message=msg)

    # 4. Hash password
    hashed = hash_password(body.password)

    # 5. Create user — auto-activate if invited, otherwise pending
    user_status = "active" if invite_valid else "pending"
    user = await user_repo.create_user(
        session,
        email=body.email,
        password_hash=hashed,
        first_name=body.first_name,
        last_name=body.last_name,
        status=user_status,
    )

    if invite_valid:
        # Invited: mark as approved + (optionally) grant the role.
        if invite_role:
            await _grant_invite_role(
                session,
                user_id=user.id,
                role=invite_role,
                workspace_id=invite_workspace_id,
                granted_by=invite_admin,
            )

        # Phase 13: attach the user to each group from the invite.
        # Best-effort: a group deleted after minting just logs +
        # continues — we'd rather activate the user with partial
        # group membership than 500 the signup.
        attached_groups: list[str] = []
        if invite_group_ids:
            from backend.app.db.repositories import group_repo
            for gid in invite_group_ids:
                grp = await group_repo.get_group_by_id(session, gid)
                if grp is None:
                    logger.warning(
                        "Invite group %s no longer exists; skipping for %s",
                        gid, user.id,
                    )
                    continue
                try:
                    await group_repo.add_member(
                        session, gid, user.id, added_by=invite_admin,
                    )
                    attached_groups.append(gid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Failed to add %s to group %s: %s — continuing.",
                        user.id, gid, exc,
                    )

        await user_repo.create_approval(
            session, user.id, status="approved", approved_by=invite_admin,
        )
        await user_repo.create_outbox_event(
            session,
            event_type="user.created_via_invite",
            payload={
                "user_id": user.id,
                "email": user.email,
                "role": invite_role,
                "workspace_id": invite_workspace_id,
                "group_ids": attached_groups,
                "invited_by": invite_admin,
            },
        )
        logger.info(
            "User signed up via invite: %s (role=%s ws=%s groups=%d)",
            user.id, invite_role, invite_workspace_id, len(attached_groups),
        )
        return SignUpResponse(message="Account created and activated. You can now sign in.")
    else:
        # Standard signup: pending approval
        await user_repo.create_approval(session, user.id, status="pending")
        await user_repo.create_outbox_event(
            session,
            event_type="user.created",
            payload={"user_id": user.id, "email": user.email},
        )
        logger.info("User signed up: %s (pending approval)", user.id)
        return SignUpResponse(message="Account created. Awaiting administrator approval.")


# /auth/login lives in backend.auth_service.api.router (cookie-based).


# ── POST /auth/forgot-password ──────────────────────────────────────

@router.post("/forgot-password")
@limiter.limit("3/minute")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Request a password reset. Always returns 200 to prevent email enumeration.
    If the user exists, a reset token is created and an outbox event is written
    so the admin panel can surface the request.
    """
    user = await user_repo.get_user_by_email(session, body.email)
    if user is not None and user.status in ("active", "pending"):
        # Flag the user as having requested a reset — do NOT generate a
        # token here. The admin will see the flag in the dashboard and
        # generate a shareable token via the admin endpoint.
        await user_repo.flag_reset_requested(session, user.id)
        await user_repo.create_outbox_event(
            session,
            event_type="user.password_reset_requested",
            payload={"user_id": user.id, "email": user.email},
        )
        logger.info("Password reset requested for user %s", user.id)
    # Always return the same response regardless of whether the user exists
    return {
        "message": "If an account with that email exists, a password reset has been initiated. Please contact your administrator for the reset token.",
    }


# ── POST /auth/reset-password ───────────────────────────────────────

@router.post("/reset-password")
@limiter.limit("5/minute")
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Reset password using a valid reset token.
    """
    # 1. Validate token
    user = await user_repo.verify_reset_token(session, body.token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token.",
        )

    # 2. Validate password strength
    _check_password_strength(body.new_password)

    # 3. Update password (also clears the reset token)
    hashed = hash_password(body.new_password)
    await user_repo.update_password(session, user.id, hashed)

    await user_repo.create_outbox_event(
        session,
        event_type="user.password_reset_completed",
        payload={"user_id": user.id},
    )

    logger.info("Password reset completed for user %s", user.id)
    return {"message": "Password has been reset successfully. You can now sign in."}


# ── GET /auth/verify-invite ──────────────────────────────────────────

@router.get("/verify-invite", response_model=InviteVerifyResponse)
async def verify_invite(
    token: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Validate an invite token and return the assigned role + scope.

    Phase 11: also surfaces the workspace (id + friendly name) and
    the pinned email so the signup page can render "You'll join
    Finance as Viewer" and lock the email field for email-bound
    invites.
    """
    from backend.app.auth.jwt import decode_invite_token
    import jwt as pyjwt

    try:
        payload = decode_invite_token(token)
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return InviteVerifyResponse(valid=False, role=None)

    workspace_id = payload.get("workspace_id")
    workspace_name = None
    if workspace_id:
        from backend.app.db.repositories import workspace_repo
        ws = await workspace_repo.get_workspace_orm(session, workspace_id)
        if ws is not None:
            workspace_name = ws.name

    # Phase 13: resolve group names so the signup page can render
    # "You'll join the Engineering and Data Platform groups."
    group_ids_raw = payload.get("group_ids") or []
    group_ids: list[str] = (
        [g for g in group_ids_raw if isinstance(g, str)]
        if isinstance(group_ids_raw, list) else []
    )
    group_names: list[str] = []
    if group_ids:
        from backend.app.db.repositories import group_repo
        for gid in group_ids:
            grp = await group_repo.get_group_by_id(session, gid)
            group_names.append(grp.name if grp else gid)

    return InviteVerifyResponse(
        valid=True,
        role=payload.get("role"),
        workspaceId=workspace_id,
        workspaceName=workspace_name,
        email=payload.get("email"),
        groupIds=group_ids or None,
        groupNames=group_names or None,
    )
