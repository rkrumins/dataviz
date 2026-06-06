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
        # Platform tiers — what kind of system account this user is.
        # Orthogonal to workspace bindings (managed inside each
        # workspace's Members tab). Every user has exactly one tier:
        #   * ``user``         — default, no global perms.
        #   * ``org_auditor``  — read-only across every workspace.
        #   * ``org_admin``    — cross-workspace operator.
        #   * ``super_admin``  — platform owner.
        # Workspace-template roles (workspace_admin/member/viewer/
        # data_engineer) are deliberately rejected here; they're bound
        # per-workspace via the workspace-members endpoint.
        allowed = {"user", "org_auditor", "org_admin", "super_admin"}
        if v not in allowed:
            raise ValueError(f"Role must be one of: {', '.join(sorted(allowed))}")
        return v


class UpdateUserRequest(BaseModel):
    """Admin-side identity edit. All fields optional; ``None`` leaves
    the field unchanged. Email is intentionally NOT mutable here — it
    changes the SSO identity key and needs its own re-link flow."""
    model_config = ConfigDict(populate_by_name=True)

    first_name: Optional[str] = Field(default=None, alias="firstName", min_length=1, max_length=120)
    last_name: Optional[str] = Field(default=None, alias="lastName", min_length=1, max_length=120)


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
    """Admin creates an invite link with optional role / workspace /
    target email.

    Phase 11: any role can be invited — global tiers, workspace
    tiers, and custom roles. The endpoint (not this DTO) validates
    the role against the catalogue, classifies its scope, and
    enforces the privilege tiering:

      * ``role`` omitted → a plain activated account (no binding).
      * ``role`` + ``workspace_id`` → a workspace-scoped binding
        (workspace tiers + custom workspace roles).
      * ``role`` alone → a global binding (super_admin / org_admin /
        custom global roles).
      * Privileged roles (anything granting ``workspace:admin`` or a
        ``system:*`` perm) require ``email`` so the invite is bound
        to a single identity and can't be forwarded to escalate
        someone else.

    The static validator only does shape checks — it can't see
    custom roles in the DB, so the real role validation lives in the
    endpoint.
    """
    model_config = ConfigDict(populate_by_name=True)

    role: Optional[str] = Field(None, min_length=1, max_length=64)
    workspace_id: Optional[str] = Field(None, alias="workspaceId", max_length=64)
    email: Optional[str] = Field(None, max_length=254)
    # Phase 13: optional group memberships to attach on signup. Each
    # id is validated against the catalogue in the endpoint; protected
    # groups are rejected.
    group_ids: Optional[list[str]] = Field(None, alias="groupIds")
    # Phase 14: opt-in escape hatch for shareable group invites.
    # Default ``False`` keeps the safe default (groups require an
    # email pin). Setting ``True`` skips the groups-email check on the
    # endpoint side, lets the link be forwarded, and emits a distinct
    # audit event so the override is reviewable. Privileged-role
    # invites still require email regardless — the override only
    # relaxes the groups rule.
    allow_shareable_with_groups: Optional[bool] = Field(
        False, alias="allowShareableWithGroups",
    )
    # Cap matches the longest preset the FE exposes ("90d" = 2160h).
    # Beyond that, the admin should generate a fresh invite — anything
    # multi-month becomes a real audit/lifecycle concern.
    expires_in_hours: int = Field(72, alias="expiresInHours", ge=1, le=2160)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip().lower()
        if not v:
            return None
        # Cheap shape check — a full RFC validator is overkill; the
        # signup flow compares against the submitted email anyway.
        if "@" not in v or v.startswith("@") or v.endswith("@"):
            raise ValueError("email must be a valid address")
        return v


class InviteTokenResponse(BaseModel):
    """Returned to admin after generating an invite."""
    model_config = ConfigDict(populate_by_name=True)

    invite_token: str = Field(alias="inviteToken")
    role: Optional[str] = None
    # Phase 11: echo the scope + email pin so the admin UI can
    # render "Viewer in Finance, sent to alice@x.com".
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    email: Optional[str] = None
    # Phase 13: groups attached on signup, echoed back for the
    # success card.
    group_ids: Optional[list[str]] = Field(default=None, alias="groupIds")
    expires_at: str = Field(alias="expiresAt")


class InviteVerifyResponse(BaseModel):
    """Returned to the signup page when validating an invite token."""
    model_config = ConfigDict(populate_by_name=True)

    valid: bool
    role: Optional[str] = None
    # Phase 11: workspace context + email pin so the signup page can
    # show "You'll join Finance as Viewer" and lock the email field
    # for email-bound invites.
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    workspace_name: Optional[str] = Field(default=None, alias="workspaceName")
    email: Optional[str] = None
    # Phase 13: group ids + friendly names so the signup banner can
    # render "You'll join the Engineering and Data Platform groups."
    group_ids: Optional[list[str]] = Field(default=None, alias="groupIds")
    group_names: Optional[list[str]] = Field(default=None, alias="groupNames")
