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
    """Phase 15: an invited signup can come back already signed in.

    The invitee was pre-approved and pre-activated by the invite itself,
    so sending them to a login form to retype the credentials they just
    chose is friction that buys nothing.
    """
    model_config = ConfigDict(populate_by_name=True)

    message: str
    #: True when session cookies were issued on this response.
    auto_signed_in: bool = Field(default=False, alias="autoSignedIn")
    user: Optional[UserPublicResponse] = None
    #: Where to land them — the invited workspace when the invite was
    #: workspace-scoped, otherwise the app root.
    redirect_to: Optional[str] = Field(default=None, alias="redirectTo")


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
    # Phase 15: seat cap. None = unlimited until expiry, which is what
    # every invite used to be. A cap is the cheapest possible answer to
    # "this link leaked": the damage is bounded before anyone notices.
    max_uses: Optional[int] = Field(None, alias="maxUses", ge=1, le=1000)
    # Phase 15: restrict a SHAREABLE link to one mail domain. The middle
    # ground between "anyone holding the URL" and "one named person" —
    # it makes a link safe to drop in a team channel. Ignored when
    # ``email`` pins a single address, which is strictly narrower.
    email_domain: Optional[str] = Field(None, alias="emailDomain", max_length=253)

    @field_validator("email_domain")
    @classmethod
    def validate_email_domain(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Accept "@company.com" as well — it is what people type.
        v = v.strip().lower().lstrip("@")
        if not v:
            return None
        if "." not in v or v.startswith(".") or v.endswith(".") or "@" in v:
            raise ValueError("emailDomain must be a bare domain, e.g. 'company.com'")
        return v

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
    # Phase 15: the ledger row backing this token, so the admin UI can
    # link straight from the success card to the link it just created.
    invite_id: Optional[str] = Field(default=None, alias="inviteId")
    max_uses: Optional[int] = Field(default=None, alias="maxUses")
    email_domain: Optional[str] = Field(default=None, alias="emailDomain")


class BulkInviteRequest(CreateInviteRequest):
    """One email-pinned link per address, from the same settings.

    Inherits every rule of a single invite — role, workspace, groups,
    expiry, seat cap — because a bulk invite IS a single invite repeated,
    and re-declaring the fields is how the two drift apart.

    ``email`` on the parent is ignored here; ``emails`` supplies it. A
    pinned link per person, rather than one shared link, is the point:
    each is separately revocable and separately attributable.
    """
    model_config = ConfigDict(populate_by_name=True)

    emails: list[str] = Field(min_length=1, max_length=200)


class BulkInviteResult(BaseModel):
    """What happened for one address."""
    model_config = ConfigDict(populate_by_name=True)

    email: str
    #: created | already_a_user | invalid_email | duplicate | failed
    outcome: str
    invite_token: Optional[str] = Field(default=None, alias="inviteToken")
    invite_id: Optional[str] = Field(default=None, alias="inviteId")
    #: Why it did not produce a link, when it did not.
    detail: Optional[str] = None


class BulkInviteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    created: int
    skipped: int
    results: list[BulkInviteResult]
    expires_at: str = Field(alias="expiresAt")


class InviteActivityItem(BaseModel):
    """Somebody joined through one of my links."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    email: str
    user_id: str = Field(alias="userId")
    redeemed_at: str = Field(alias="redeemedAt")
    invite_id: str = Field(alias="inviteId")
    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    workspace_name: Optional[str] = Field(default=None, alias="workspaceName")


class RedeemInviteRequest(BaseModel):
    """Apply an invite to the already-authenticated caller — the SSO
    route into an invitation."""
    model_config = ConfigDict(populate_by_name=True)

    invite_token: str = Field(alias="inviteToken", min_length=1)


class RedeemInviteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: False when the invite was valid but there was nothing to apply —
    #: the account already had access. Not an error: they are signed in,
    #: which is what they were trying to do.
    applied: bool
    message: str
    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    redirect_to: str = Field(alias="redirectTo")


class ExtendInviteRequest(BaseModel):
    """Give an existing link more time, and optionally more seats.

    ``additional_uses`` is relative to what has ALREADY been used, so
    "add 5" means five more people can join — not five more than the
    original cap, which on a spent link would be none.
    """
    model_config = ConfigDict(populate_by_name=True)

    expires_in_hours: int = Field(72, alias="expiresInHours", ge=1, le=2160)
    additional_uses: Optional[int] = Field(
        None, alias="additionalUses", ge=1, le=1000,
    )


class InviteSummaryResponse(BaseModel):
    """One row in the admin's list of outstanding links.

    Carries NO token, deliberately. "Copy the link again" is a tempting
    convenience, but it would turn a read-only list into a place where
    credentials can be harvested — the link is copyable at the moment it
    is created, and re-sharing should mean minting a fresh, separately
    revocable one.
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    workspace_name: Optional[str] = Field(default=None, alias="workspaceName")
    email: Optional[str] = None
    email_domain: Optional[str] = Field(default=None, alias="emailDomain")
    group_ids: list[str] = Field(default_factory=list, alias="groupIds")
    group_names: list[str] = Field(default_factory=list, alias="groupNames")
    max_uses: Optional[int] = Field(default=None, alias="maxUses")
    use_count: int = Field(alias="useCount")
    redemption_count: int = Field(alias="redemptionCount")
    #: active | revoked | expired | exhausted — derived, never stored.
    status: str
    created_by: str = Field(alias="createdBy")
    created_at: str = Field(alias="createdAt")
    expires_at: str = Field(alias="expiresAt")
    revoked_at: Optional[str] = Field(default=None, alias="revokedAt")
    revoked_by: Optional[str] = Field(default=None, alias="revokedBy")


class InviteRedemptionResponse(BaseModel):
    """Who came in through a link, and when."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    user_id: str = Field(alias="userId")
    email: str
    redeemed_at: str = Field(alias="redeemedAt")


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
    #: Why the link is unusable, when ``valid`` is False. "Invalid or expired"
    #: covers four genuinely different situations — the admin revoked it, the
    #: seats ran out, it aged out, or invite links are switched off entirely —
    #: and only one of them means "ask for a new link". Without this the page
    #: has to guess, and it guessed wrong.
    #:
    #: One of: ``expired`` | ``revoked`` | ``exhausted`` | ``domain_mismatch``
    #: | ``links_disabled`` | ``invalid``.
    reason: Optional[str] = None
    #: Seats left on a capped link; None when uncapped. Surfaced so a
    #: capped link can say "2 spots left" rather than silently failing
    #: for whoever clicks one too late — the person turned away is the
    #: one who most needed to know the limit existed.
    seats_remaining: Optional[int] = Field(default=None, alias="seatsRemaining")
    #: When the link stops working, so the page can show the deadline
    #: rather than only discovering it after a failed submit.
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")


# ── Admin-created accounts ────────────────────────────────────────────
#
# The other way in. An invite is the user provisioning themselves from a
# link you handed them; this is you provisioning them directly, which is
# what you need when there is nobody to hand a link TO yet — a contractor
# starting Monday, a service account, a migration from another tool.

class AdminCreateUserRequest(BaseModel):
    """Create one account outright.

    Grant fields mirror ``CreateInviteRequest`` deliberately: the same
    role / workspace / group rules apply, because the account that comes
    out the far end is the same account either way.
    """
    model_config = ConfigDict(populate_by_name=True)

    email: str
    first_name: str = Field(alias="firstName", min_length=1, max_length=100)
    last_name: str = Field(alias="lastName", min_length=1, max_length=100)

    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    group_ids: Optional[list[str]] = Field(default=None, alias="groupIds")

    #: How they will first sign in.
    #:   setup_link — account exists with no usable password; the admin
    #:                shares a one-time link and the user sets their own.
    #:                Nobody but them ever knows it, so this is default.
    #:   password   — the admin sets one and communicates it out of band.
    #:   sso_only   — no local password at all; they sign in via the IdP.
    credential: str = Field(default="setup_link")
    #: Required iff ``credential == 'password'``.
    password: Optional[str] = None

    #: Skip the pending queue. An account an admin typed out by hand has
    #: already been approved by the act of typing it.
    activate: bool = True


class AdminCreateUserResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    email: str
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    status: str
    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    group_ids: list[str] = Field(default_factory=list, alias="groupIds")
    #: Present only for ``credential == 'setup_link'``. Shown once.
    setup_token: Optional[str] = Field(default=None, alias="setupToken")
    setup_expires_at: Optional[str] = Field(default=None, alias="setupExpiresAt")


class BulkCreateUsersRequest(BaseModel):
    """Several accounts from one set of settings.

    Names are optional per row because the usual source is a column of
    addresses; when absent they are derived from the local part, which is
    a better placeholder than an empty string and is editable afterwards.
    """
    model_config = ConfigDict(populate_by_name=True)

    users: list["BulkCreateUserRow"] = Field(min_length=1, max_length=200)

    role: Optional[str] = None
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    group_ids: Optional[list[str]] = Field(default=None, alias="groupIds")
    credential: str = Field(default="setup_link")
    activate: bool = True


class BulkCreateUserRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    email: str
    first_name: Optional[str] = Field(default=None, alias="firstName")
    last_name: Optional[str] = Field(default=None, alias="lastName")


class BulkCreateUserResult(BaseModel):
    """What happened for one row."""
    model_config = ConfigDict(populate_by_name=True)

    email: str
    #: created | already_a_user | invalid_email | duplicate | failed
    outcome: str
    user_id: Optional[str] = Field(default=None, alias="userId")
    setup_token: Optional[str] = Field(default=None, alias="setupToken")
    detail: Optional[str] = None


class BulkCreateUsersResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    created: int
    skipped: int
    results: list[BulkCreateUserResult]
