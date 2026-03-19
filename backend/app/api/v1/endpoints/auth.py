"""
Public authentication endpoints: signup, login, forgot-password, reset-password.

POST /api/v1/auth/signup            → 201 + message
POST /api/v1/auth/login             → 200 + LoginResponse (JWT + user)
POST /api/v1/auth/forgot-password   → 200 + message (always succeeds)
POST /api/v1/auth/reset-password    → 200 + message
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password, verify_password
from backend.app.auth.jwt import create_access_token
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.common.models.auth import (
    SignUpRequest,
    SignUpResponse,
    LoginRequest,
    LoginResponse,
    UserPublicResponse,
    ForgotPasswordRequest,
    ResetPasswordRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()

limiter = Limiter(key_func=get_remote_address)

# Pre-computed Argon2id hash used for constant-time login responses when
# the user doesn't exist.  The actual plaintext doesn't matter — it just
# needs to be a valid Argon2id hash so verify_password runs in the same
# time as a real check.
_DUMMY_HASH = hash_password("__timing_dummy_do_not_use__")


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
    # 1. Password strength
    _check_password_strength(body.password)

    # 2. Check email uniqueness — return the same 201 response regardless
    # to prevent email enumeration attacks.
    existing = await user_repo.get_user_by_email(session, body.email)
    if existing is not None:
        logger.debug("Signup attempt with existing email (suppressed)")
        return SignUpResponse(message="Account created. Awaiting administrator approval.")

    # 3. Hash password
    hashed = hash_password(body.password)

    # 4. Create user (status=pending)
    user = await user_repo.create_user(
        session,
        email=body.email,
        password_hash=hashed,
        first_name=body.first_name,
        last_name=body.last_name,
        status="pending",
    )

    # 5. Create pending approval record
    await user_repo.create_approval(session, user.id, status="pending")

    # 6. Outbox event
    await user_repo.create_outbox_event(
        session,
        event_type="user.created",
        payload={"user_id": user.id, "email": user.email},
    )

    logger.info("User signed up: %s (pending approval)", user.id)
    return SignUpResponse(message="Account created. Awaiting administrator approval.")


# ── POST /auth/login ──────────────────────────────────────────────────

@router.post("/login", response_model=LoginResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    body: LoginRequest,
    session: AsyncSession = Depends(get_db_session),
):
    _invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
    )

    # 1. Find user
    user = await user_repo.get_user_by_email(session, body.email)

    # 2. Verify password — always run a hash comparison to prevent timing
    #    side-channels that reveal whether an email exists.
    if user is None:
        # Dummy verify so the response time is indistinguishable from a real
        # user with a wrong password (Argon2id is deliberately slow).
        verify_password(body.password, _DUMMY_HASH)
        raise _invalid

    if not verify_password(body.password, user.password_hash):
        raise _invalid

    # 3. Check status — use a single generic message to avoid leaking
    #    whether an email exists and what state the account is in.
    if user.status != "active":
        raise _invalid

    # 4. Build JWT
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    token = create_access_token(user_id=user.id, email=user.email, role=role)

    # 5. Build response
    user_resp = await _build_user_response(session, user)
    logger.info("User logged in: %s", user.id)
    return LoginResponse(accessToken=token, user=user_resp)


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
