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

    # 2. Validate invite token (if provided)
    invite_role = None
    invite_admin = None
    if body.invite_token:
        try:
            payload = decode_invite_token(body.invite_token)
            invite_role = payload.get("role", "user")
            invite_admin = payload.get("created_by")
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invite link is invalid or has expired.",
            )

    # 3. Check email uniqueness — return the same 201 response regardless
    # to prevent email enumeration attacks.
    existing = await user_repo.get_user_by_email(session, body.email)
    if existing is not None:
        logger.debug("Signup attempt with existing email (suppressed)")
        msg = "Account created and activated." if invite_role else "Account created. Awaiting administrator approval."
        return SignUpResponse(message=msg)

    # 4. Hash password
    hashed = hash_password(body.password)

    # 5. Create user — auto-activate if invited, otherwise pending
    user_status = "active" if invite_role else "pending"
    user = await user_repo.create_user(
        session,
        email=body.email,
        password_hash=hashed,
        first_name=body.first_name,
        last_name=body.last_name,
        status=user_status,
    )

    if invite_role:
        # Invited: assign the role from the invite and mark as approved
        await user_repo.assign_role(session, user.id, invite_role)
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
                "invited_by": invite_admin,
            },
        )
        logger.info("User signed up via invite: %s (role=%s)", user.id, invite_role)
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
async def verify_invite(token: str):
    """Validate an invite token and return the assigned role."""
    from backend.app.auth.jwt import decode_invite_token
    import jwt as pyjwt

    try:
        payload = decode_invite_token(token)
        return InviteVerifyResponse(valid=True, role=payload.get("role", "user"))
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return InviteVerifyResponse(valid=False, role=None)
