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
    # it can do anything else. See ``_hold_for_password_change`` in
    # ``backend/app/auth/dependencies.py``.
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


@dataclass(frozen=True)
class ApiKeyPolicy:
    """The deployment's rules for API keys, read by the caller per request.

    ``sso_signin_window_days``: an owner with an SSO identity must have signed
    in through their identity provider within this many days, or their keys
    pause. ``None`` turns the rule off.

    ``max_lifetime_days``: no key outlives this many days from its creation,
    whatever expiry it was minted with — applied to existing keys too. ``None``
    means no maximum.

    ``service_account_grace_days``: how long a service account's keys keep
    working after its last manager in good standing has gone; 0 pauses them
    as soon as that is noticed.
    """
    sso_signin_window_days: Optional[int] = 30
    max_lifetime_days: Optional[int] = None
    service_account_grace_days: int = 14


@dataclass(frozen=True)
class ApiKeyIdentity:
    """A request authenticated by an API key: who it acts as, and through
    which key.

    ``claims`` is whatever the injected claims resolver produced — opaque
    here, the application's permission claims for this key.

    ``status`` is ``active`` for a key that may act. A caller that asked for
    inactive keys too (a key inspecting or revoking itself) also receives the
    reason it would otherwise have been refused, and ``claims`` is then
    ``None``: such a key may describe or end itself and nothing more.
    """
    key_id: str
    kind: str
    user: "User"
    claims: object
    expires_at: Optional[str]
    status: str = "active"


#: How a step-up can confirm that an SSO session is still its person, by the
#: provider the session signed in through (``StepUpTarget.confirms``):
#:
#: * ``proven`` — OIDC or SAML: the provider reports when the person
#:   authenticated, and can be made to ask again.
#: * ``gateway_live`` — an Enterprise gateway this server can ask, now,
#:   whether the company session on the request is still live.
#: * ``gateway_sign_in`` — a gateway only the browser talks to: a sign-in
#:   through it is the gateway's answer.
#: * ``none`` — a portal, which can say neither.
STEP_UP_CONFIRMS = ("proven", "gateway_live", "gateway_sign_in", "none")

#: What a gateway says when asked about the company session behind a
#: session (``confirm_live_session``).
LIVE_SESSION_ANSWERS = ("confirmed", "absent", "rejected", "unreachable")


@dataclass(frozen=True)
class StepUpTarget:
    """Where to send someone to prove it is them again, and how the provider
    their session signed in through can confirm it (``STEP_UP_CONFIRMS``).
    ``unreachable``: that provider is confirmed down (``sso_outage_slugs``),
    so neither sending anyone to it nor asking it can confirm anything until
    it is back. ``slug``: that provider's, for a sign-in the page runs in
    place — a gateway's."""
    login_url: str
    confirms: str
    unreachable: bool = False
    slug: Optional[str] = None


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

    async def login(
        self, email: str, password: str, *, client: Optional[dict] = None,
    ) -> tuple[User, SessionTokens]:
        """Authenticate by credentials and issue a fresh session.

        Raises ``InvalidCredentials`` for any failure (wrong password,
        unknown email, inactive account) — never reveals which to the
        caller. ``client`` (where the attempt came from) is recorded with
        a refusal, alongside which of those it was.
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

    async def refresh(
        self, refresh_token: str, *,
        ambient_cookies: Optional[dict] = None,
        ambient_headers: Optional[dict] = None,
    ) -> tuple[User, SessionTokens]:
        """Rotate a refresh token: returns new (user, tokens).

        Raises ``InvalidRefreshToken`` if the token is missing/invalid/expired,
        or — critically — if the same refresh token is presented twice
        (reuse detection: revokes the entire family).

        ``ambient_cookies`` / ``ambient_headers`` are the inbound request's
        own, forwarded so a session minted by a back-channel provider can be
        re-confirmed with its IdP on this rotation — which is what stops our
        session outliving the upstream session that created it. Declared here
        because the route layer passes them; both default to None, and a
        session that needs them and is not given them is treated as having no
        ambient token, so a caller that forgets to forward gets a re-auth
        prompt rather than a free pass.

        May also raise ``SsoReauthRequired`` — for the 24h re-auth ceiling, or
        when the upstream IdP no longer backs this session.
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

    async def validate_api_key(
        self,
        token: str,
        *,
        client_ip: Optional[str],
        user_agent: Optional[str],
        policy: ApiKeyPolicy,
        allow_inactive: bool = False,
    ) -> ApiKeyIdentity:
        """Authenticate a request by API key, checked afresh every time.

        Raises ``ApiKeyRejected`` when the key is not honoured — unknown,
        revoked, expired, its owner suspended or due to sign in again, or
        presented from an address the key does not allow — and
        ``ApiKeyLookupUnavailable`` when the answer could not be read, which
        must never be mistaken for a bad key.

        ``allow_inactive`` lets a key that is merely paused or expired through
        with its ``status`` set, for the routes where a key describes or
        revokes itself. A revoked or unknown key is refused regardless.
        """
        ...

    async def step_up_target(
        self, user_id: str, *, next_path: str, provider_id: Optional[str] = None,
    ) -> StepUpTarget:
        """Where this person signs in again to confirm it is them, returning
        to ``next_path``, and how that provider can confirm it.

        ``provider_id`` is the provider the session signed in through; without
        one, the provider they signed in with most recently."""
        ...

    async def confirm_live_session(
        self, provider_id: str, *, ambient_cookies: dict, ambient_headers: dict,
    ) -> str:
        """Ask the gateway ``provider_id`` names whether the company session
        on this request is still live — one of ``LIVE_SESSION_ANSWERS``:
        ``absent`` when the request carries none, ``rejected`` when the
        gateway says it has ended, ``unreachable`` when it did not answer in
        time. Never raises for the gateway's sake."""
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
    collides with an existing account and auto-linking is unsafe.

    The route maps this to a generic failure and the full story is
    audited. ``deny_reasons`` is the one deliberate exception: for
    ``unsafe_auto_link`` the fetch-based routes surface it so the
    sign-in page can say which rule refused the link — disclosure to
    someone who has just proved control of the colliding email at the
    IdP, not to an anonymous caller."""

    def __init__(self, code: str, *, deny_reasons: tuple[str, ...] = (),
                 user_id: Optional[str] = None):
        super().__init__(code)
        self.deny_reasons = deny_reasons
        #: The existing account the refusal concerns, when there is one —
        #: for the audit record, never for the caller.
        self.user_id = user_id


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


class ApiKeyRejected(AuthError):
    """An API key was presented and is not honoured. ``reason`` is a stable
    code: ``malformed``, ``unknown``, ``revoked``, ``expired``,
    ``owner_inactive``, ``owner_reauth_required`` or ``ip_not_allowed``."""

    def __init__(self, reason: str, *, key_id: Optional[str] = None):
        super().__init__(reason)
        self.reason = reason
        self.key_id = key_id


class ApiKeyLookupUnavailable(AuthError):
    """Whether the key is valid could not be determined — the store did not
    answer. The caller answers 503, never 401: a database blip must not read
    to a client as "your credential is bad"."""


__all__ = [
    "User",
    "SessionTokens",
    "ApiKeyPolicy",
    "ApiKeyIdentity",
    "ApiKeyRejected",
    "ApiKeyLookupUnavailable",
    "IdentityService",
    "AuthError",
    "InvalidCredentials",
    "InvalidRefreshToken",
    "SSOAuthError",
    "SsoReauthRequired",
]
