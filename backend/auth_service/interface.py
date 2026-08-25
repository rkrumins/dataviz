"""
Public interface for the authentication service.

Anything outside the auth module — FastAPI dependencies, other services,
the future remote client — interacts with auth through ``IdentityService``
and the DTOs defined here. Implementations live in ``service.py``.

When this module is extracted into its own microservice, ``IdentityService``
becomes the wire contract: a ``RemoteIdentityService`` would implement the
same protocol over HTTP, and call sites would not change.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from backend.common.display_name import resolve_display_name


# ── Domain DTOs ──────────────────────────────────────────────────────

class User(BaseModel):
    """The authenticated identity as seen by consumers of this service.

    This is the cross-service contract: when auth becomes its own
    microservice, this is what /auth/me returns over HTTP.

    Phase 3 adds ``attributes``: the operator-mapped IdP extras
    (department, employee_id, manager, cost_center, …) persisted on
    the user row by ``set_user_idp_metadata``. The full list of
    linked SSO identities lives on a separate ``/me/identities``
    endpoint, not on this DTO, so the wire shape of /me / /login /
    /refresh stays tight.
    """
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    email: str
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    # Stored override; None means "derive from first + last".
    chosen_display_name: Optional[str] = Field(None, alias="chosenDisplayName")
    role: str
    status: str
    auth_provider: str = Field("local", alias="authProvider")
    created_at: str = Field("", alias="createdAt")
    updated_at: str = Field("", alias="updatedAt")
    # Chosen avatar illustration, or None to fall back to initials.
    avatar_id: Optional[str] = Field(None, alias="avatarId")
    # True while the account is holding a password it must rotate before
    # it can do anything else. See ``get_current_user``.
    must_change_password: bool = Field(False, alias="mustChangePassword")
    # IdP-mapped attributes. Empty dict for local-only users.
    attributes: dict = Field(default_factory=dict)

    @property
    def display_name(self) -> str:
        return resolve_display_name(
            self.chosen_display_name, self.first_name, self.last_name,
        )


@dataclass(frozen=True)
class SessionTokens:
    """The set of tokens issued by login/refresh.

    The CSRF token is *not* HttpOnly — the frontend reads it from the
    ``nx_csrf`` cookie and echoes it back as the ``X-CSRF-Token`` header
    on state-changing requests. The double-submit comparison is what
    proves the request was initiated by a same-origin script with cookie
    access.
    """
    access_token: str
    access_max_age_seconds: int
    refresh_token: str
    refresh_max_age_seconds: int
    csrf_token: str


# ── Service protocol ─────────────────────────────────────────────────

@runtime_checkable
class IdentityService(Protocol):
    """The boundary every auth consumer crosses.

    Today implemented in-process (``LocalIdentityService``); tomorrow can
    be implemented as an HTTP client (``RemoteIdentityService``) without
    any change to call sites.
    """

    async def validate_session(self, access_token: Optional[str]) -> Optional[User]:
        """Return the authenticated user or ``None`` if the token is missing,
        invalid, expired, or the user is not active."""
        ...

    async def login(self, email: str, password: str) -> tuple[User, SessionTokens]:
        """Authenticate by credentials and issue a fresh session.

        Raises ``InvalidCredentials`` for any failure (wrong password,
        unknown email, inactive account) — never reveals which.
        """
        ...

    async def logout(
        self,
        refresh_token: Optional[str],
        access_token: Optional[str] = None,
    ) -> None:
        """End the session: revoke the refresh family AND tombstone the
        access token's ``sid`` so the token already in the caller's
        hands stops being honoured. Idempotent.

        ``access_token`` is optional only so a caller with no access
        cookie (an already-expired session signing out) still works —
        not because it is safe to omit. Omitting it when one is present
        leaves the access token live until it expires.
        """
        ...

    async def refresh(self, refresh_token: str) -> tuple[User, SessionTokens]:
        """Rotate a refresh token: returns new (user, tokens).

        Raises ``InvalidRefreshToken`` if the token is missing/invalid/expired,
        or — critically — if the same refresh token is presented twice
        (reuse detection: revokes the entire family).
        """
        ...

    async def get_user(self, user_id: str) -> Optional[User]:
        """Look up a user by id. Returns ``None`` if not found or deleted."""
        ...

    async def complete_sso_login(self, identity) -> tuple[User, SessionTokens]:
        """Find-or-provision a user from a verified SSO ``ProviderIdentity``
        and issue a fresh session.

        Applies the identity-linking guardrails. Raises ``SSOAuthError``
        when linking is unsafe (the caller surfaces a generic failure).
        """
        ...


# ── Errors ───────────────────────────────────────────────────────────

class AuthError(Exception):
    """Base class for all auth-service errors that callers should handle."""


class InvalidCredentials(AuthError):
    """Wrong email / password combination, or account not active."""


class InvalidRefreshToken(AuthError):
    """Refresh token is missing, malformed, expired, or reused.

    ``foreign`` marks the subset that can never become valid here: the
    token verified against no key in our ring, or carries another
    environment's issuer/audience. Those are unrecoverable in a way that
    an expired or reused token is not, so the router evicts the cookie
    rather than letting the browser re-present it forever.
    """

    def __init__(self, *args, foreign: bool = False) -> None:
        super().__init__(*args)
        self.foreign = foreign


class SSOAuthError(AuthError):
    """SSO login could not be completed — e.g. the IdP subject's email
    collides with an existing account and auto-linking is unsafe. The
    route maps this to a generic failure; the reason is audited, not
    shown to the browser."""


class SsoReauthRequired(AuthError):
    """The SSO session has exceeded ``SSO_SESSION_MAX_AGE_HOURS`` since
    the user actually authenticated at the IdP. The refresh family is
    revoked and the caller must redirect the user to ``login_url`` (an
    IdP-bound /auth/{oidc,saml,custom}/login URL with ``force=1``) to
    re-authenticate.

    The router translates this into a 401 with a structured body so the
    frontend can follow the redirect transparently."""

    def __init__(self, login_url: str, *, provider: str):
        super().__init__("sso_reauth_required")
        self.login_url = login_url
        self.provider = provider


class LocalLoginDisabled(AuthError):
    """Phase 4: the platform is in SSO-only mode
    (``app_auth_config.allow_local_login = false``). The router
    surfaces this as a 403 with a structured body so the FE can
    redirect to the dynamic providers picker instead of showing the
    generic "invalid credentials" message."""

    def __init__(self) -> None:
        super().__init__("local_login_disabled")


__all__ = [
    "User",
    "SessionTokens",
    "IdentityService",
    "AuthError",
    "InvalidCredentials",
    "InvalidRefreshToken",
    "SSOAuthError",
    "SsoReauthRequired",
    "LocalLoginDisabled",
]
