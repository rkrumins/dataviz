"""
Pydantic DTOs for authentication and user management.

Follows the project convention of Field(alias="camelCase") with
model_config = ConfigDict(populate_by_name=True) so that both
snake_case (Python) and camelCase (JSON) are accepted.
"""
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
import re

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


# ── Requests ───────────────────────────────────────────────────────────

class SignUpRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    email: str
    password: str = Field(min_length=8)
    first_name: str = Field(alias="firstName", min_length=1, max_length=100)
    last_name: str = Field(alias="lastName", min_length=1, max_length=100)
    invite_token: Optional[str] = Field(None, alias="inviteToken")

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Invalid email format")
        return v


class LoginRequest(BaseModel):
    email: str
    password: str


class ApproveRejectRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    rejection_reason: Optional[str] = Field(None, alias="rejectionReason", max_length=500)


class ChangeRoleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    role: str = Field(min_length=1, max_length=50)

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        allowed = {"admin", "user", "viewer"}
        if v not in allowed:
            raise ValueError(f"Role must be one of: {', '.join(sorted(allowed))}")
        return v


class AdminResetPasswordRequest(BaseModel):
    """Admin sets a new password for a user directly."""
    model_config = ConfigDict(populate_by_name=True)

    new_password: str = Field(alias="newPassword", min_length=8)


class ForgotPasswordRequest(BaseModel):
    """User requests a password reset from the login page."""
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Invalid email format")
        return v


class ResetPasswordRequest(BaseModel):
    """User resets password using a token."""
    model_config = ConfigDict(populate_by_name=True)

    token: str = Field(min_length=1)
    new_password: str = Field(alias="newPassword", min_length=8)


# ── Responses ──────────────────────────────────────────────────────────

class UserPublicResponse(BaseModel):
    """Public-facing user profile (safe to send to the user themselves)."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    email: str
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    display_name: str = Field(alias="displayName")
    status: str
    role: str
    created_at: str = Field(alias="createdAt")


class AdminUserResponse(BaseModel):
    """Extended user info for admin views."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    email: str
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    display_name: str = Field(alias="displayName")
    status: str
    role: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    reset_requested: bool = Field(False, alias="resetRequested")


class LoginResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    access_token: str = Field(alias="accessToken")
    user: UserPublicResponse


class SignUpResponse(BaseModel):
    message: str


class ResetTokenResponse(BaseModel):
    """Returned to admin when they generate a reset token for a user."""
    model_config = ConfigDict(populate_by_name=True)

    reset_token: str = Field(alias="resetToken")
    expires_at: str = Field(alias="expiresAt")


class CreateInviteRequest(BaseModel):
    """Admin creates an invite link with optional role and expiry."""
    model_config = ConfigDict(populate_by_name=True)

    role: str = Field("user", min_length=1, max_length=50)
    expires_in_hours: int = Field(72, alias="expiresInHours", ge=1, le=720)

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        allowed = {"admin", "user", "viewer"}
        if v not in allowed:
            raise ValueError(f"Role must be one of: {', '.join(sorted(allowed))}")
        return v


class InviteTokenResponse(BaseModel):
    """Returned to admin after generating an invite."""
    model_config = ConfigDict(populate_by_name=True)

    invite_token: str = Field(alias="inviteToken")
    role: str
    expires_at: str = Field(alias="expiresAt")


class InviteVerifyResponse(BaseModel):
    """Returned to the signup page when validating an invite token."""
    model_config = ConfigDict(populate_by_name=True)

    valid: bool
    role: Optional[str] = None
