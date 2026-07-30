"""
JWT token helpers — access, refresh, and invite.

Three token families share the same signing key but use distinct audiences
so a token of one type can never be presented in place of another:

    access  : aud = JWT_AUDIENCE                 (short-lived, ~15 min)
    refresh : aud = JWT_AUDIENCE + ":refresh"    (longer, ~7 days, carries jti+family)
    invite  : aud = JWT_AUDIENCE + ":invite"     (signup invite, ~72 h)
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta

import jwt

from .config import (
    JWT_SECRET_KEY,
    JWT_ALGORITHM,
    JWT_EXPIRY_MINUTES,
    JWT_ISSUER,
    JWT_AUDIENCE,
    JWT_REFRESH_EXPIRY_DAYS,
)

_REFRESH_AUDIENCE = f"{JWT_AUDIENCE}:refresh"
_INVITE_AUDIENCE = f"{JWT_AUDIENCE}:invite"
_OIDC_STATE_AUDIENCE = f"{JWT_AUDIENCE}:oidc_state"
_SAML_STATE_AUDIENCE = f"{JWT_AUDIENCE}:saml_state"
_MOCK_IDENTITY_AUDIENCE = f"{JWT_AUDIENCE}:mock_identity"
_LINK_INTENT_AUDIENCE = f"{JWT_AUDIENCE}:link_intent"
_DRYRUN_AUDIENCE = f"{JWT_AUDIENCE}:dryrun"


# ── Access tokens ────────────────────────────────────────────────────

def create_access_token(
    user_id: str,
    email: str,
    role: str,
    extra: dict | None = None,
) -> str:
    """Create a signed access JWT."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRY_MINUTES),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_token(token: str, *, verify_exp: bool = True) -> dict:
    """Decode an access JWT.

    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure
    (including audience mismatch — i.e. a refresh token presented as access).

    ``verify_exp=False`` is for logout, which needs the ``sid`` out of the
    token in order to tombstone it. A token a moment past ``exp`` still has
    a live tombstone window to fill (the tombstone TTL deliberately outlives
    the token), and refusing to parse it would skip the revocation in
    exactly the case where the user has been sitting on the page long
    enough to want out. The signature is still verified, so the ``sid``
    cannot be forged into someone else's session.
    """
    return jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=JWT_AUDIENCE,
        options={"verify_exp": verify_exp},
    )


# ── Refresh tokens ───────────────────────────────────────────────────

@dataclass(frozen=True)
class RefreshClaims:
    sub: str                 # user id
    jti: str                 # unique token id (for revocation tracking)
    family_id: str           # rotation chain id (for reuse detection)
    exp: int                 # unix epoch
    # IdP-issued authentication instant for SSO sessions (epoch
    # seconds). Propagated through rotation so the 24h SSO re-auth
    # check on /refresh can read it directly from the token. NULL for
    # local password sessions (which keep their 7-day refresh TTL and
    # are not subject to the SSO ceiling).
    auth_time: int | None = None
    # When this token was minted, in epoch MILLISECONDS. Compared
    # against the user's ``sessions_valid_from`` cutoff on /refresh so a
    # revocation cannot be walked around by rotating.
    #
    # Milliseconds rather than the standard second-granular ``iat``
    # because both ends of that comparison routinely land in the same
    # second: revoking and then immediately refreshing, or revoking and
    # then immediately signing back in. At second precision one of those
    # two has to be wrong — either a doomed token survives or a
    # legitimate new one is refused.
    #
    # ``0`` means "this token cannot say when it was minted". Note that a
    # token merely predating the ``mat`` claim is NOT one of those: every
    # token this module has ever issued carries ``iat``, and the decoder
    # falls back to it, so legacy tokens still date themselves to the
    # second. Reaching 0 therefore takes a token with neither claim — not
    # something ``create_refresh_token`` can produce. Against a revocation
    # cutoff that is treated as failure, not as licence; see
    # ``_refresh_predates_cutoff``.
    mint_ms: int = 0


def create_refresh_token(
    user_id: str,
    family_id: str | None = None,
    extra: dict | None = None,
    *,
    auth_time: int | None = None,
    jti: str | None = None,
    expires_at_epoch: int | None = None,
    mint_ms: int | None = None,
) -> tuple[str, RefreshClaims]:
    """Create a signed refresh JWT.

    Returns (token, claims). When *family_id* is None a new family is started
    (this is what /login does). Pass an existing family_id when rotating from
    /refresh so the chain can be tracked for reuse-detection.

    ``auth_time`` (epoch seconds) anchors the SSO re-auth ceiling. It is
    propagated forward unchanged on every rotation so the check on
    ``/refresh`` measures elapsed wall-clock time since the user actually
    authenticated at the IdP, not since the last token rotation.

    ``jti`` / ``expires_at_epoch`` / ``mint_ms`` override the generated
    values. They exist for one caller: the rotation grace window, which
    re-mints the successor a concurrent refresh already minted so both
    racers end up holding the same token instead of one of them being
    mistaken for a thief. Only the identity of the token matters there,
    not its bytes — two tokens carrying the same ``jti`` are consumed by
    the same next rotation.
    """
    now = datetime.now(timezone.utc)
    expires_at = (
        datetime.fromtimestamp(expires_at_epoch, tz=timezone.utc)
        if expires_at_epoch is not None
        else now + timedelta(days=JWT_REFRESH_EXPIRY_DAYS)
    )
    minted_ms = mint_ms if mint_ms is not None else int(now.timestamp() * 1000)
    jti = jti or secrets.token_urlsafe(16)
    fam = family_id or secrets.token_urlsafe(16)
    payload: dict = {
        "sub": user_id,
        "jti": jti,
        "fam": fam,
        "iss": JWT_ISSUER,
        "aud": _REFRESH_AUDIENCE,
        "iat": now,
        # Millisecond mint instant. ``iat`` is kept as-is for the
        # standard claim; this one exists because the revocation cutoff
        # needs sub-second resolution. See ``RefreshClaims.mint_ms``.
        "mat": minted_ms,
        "exp": expires_at,
    }
    if auth_time is not None:
        payload["auth_time"] = int(auth_time)
    if extra:
        payload.update(extra)
    token = jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    claims = RefreshClaims(
        sub=user_id,
        jti=jti,
        family_id=fam,
        exp=int(expires_at.timestamp()),
        auth_time=int(auth_time) if auth_time is not None else None,
        mint_ms=minted_ms,
    )
    return token, claims


def decode_refresh_token(
    token: str, *, verify_exp: bool = True,
) -> RefreshClaims:
    """Decode a refresh JWT into RefreshClaims.

    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure.

    ``verify_exp=False`` is for the rate limiter, which buckets requests
    by ``fam``: an expired token still needs a stable bucket, or every
    expired refresh would fall back to the shared IP bucket — the exact
    pile-up the family key exists to avoid. The signature is still
    verified, so the bucket label cannot be forged.
    """
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_REFRESH_AUDIENCE,
        options={"verify_exp": verify_exp},
    )
    sub = payload.get("sub")
    jti = payload.get("jti")
    fam = payload.get("fam")
    exp = payload.get("exp")
    if not (sub and jti and fam and exp):
        raise jwt.InvalidTokenError("Refresh token missing required claims")
    auth_time_raw = payload.get("auth_time")
    auth_time: int | None
    if auth_time_raw is None:
        auth_time = None
    else:
        try:
            auth_time = int(auth_time_raw)
        except (TypeError, ValueError):
            raise jwt.InvalidTokenError("Refresh token auth_time is malformed")
    # Prefer the millisecond claim. Tokens minted before it existed fall
    # back to the standard second-granular ``iat``, which is enough to
    # place them safely on one side of a cutoff stamped later. A token
    # carrying neither reads as 0 — "cannot tell" — which the cutoff
    # check refuses rather than waves through, because nothing this
    # module issues lands there.
    try:
        mint_ms = int(payload.get("mat") or 0)
    except (TypeError, ValueError):
        mint_ms = 0
    if not mint_ms:
        try:
            mint_ms = int(payload.get("iat") or 0) * 1000
        except (TypeError, ValueError):
            mint_ms = 0
    return RefreshClaims(
        sub=sub, jti=jti, family_id=fam, exp=int(exp), auth_time=auth_time,
        mint_ms=mint_ms,
    )


# ── Invite tokens ────────────────────────────────────────────────────

def invite_expiry(expires_in_hours: int) -> str:
    """When an invite minted now would lapse, as an ISO string.

    Shared with ``create_invite_token`` so extending or regenerating a
    link cannot compute a different deadline from the one issuing it —
    the row and the token have to agree on the instant a link dies.
    """
    return (
        datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
    ).isoformat()


def create_invite_token(
    role: str,
    created_by: str,
    expires_in_hours: int = 72,
    *,
    workspace_id: str | None = None,
    email: str | None = None,
    group_ids: list[str] | None = None,
    jti: str | None = None,
    token_version: int | None = None,
) -> tuple[str, str]:
    """Create a signed invite JWT. Returns (token, expires_at_iso).

    Phase 11: the token can now carry an optional ``workspace_id``
    (for workspace-scoped role invites) and an optional ``email``
    (for email-bound invites — privileged roles pin a target address
    so a forwarded link can't escalate an unintended identity). Both
    are omitted from the payload when ``None`` so existing global,
    shareable invites are unchanged on the wire.

    Phase 13: also optional ``group_ids`` — a list of internal Group
    ids the new user should be added to on signup. Omitted from the
    payload when ``None`` / empty.

    Phase 15: optional ``jti`` — the id of the ``invites`` row backing
    this token. When present, that row is what actually decides whether
    the invite may still be redeemed and what it grants; the payload
    below becomes a cached copy. Omitted when ``None`` so a caller that
    does not use the ledger produces exactly the token it always did,
    which is what keeps tokens minted before the ledger existed valid.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=expires_in_hours)
    payload = {
        "purpose": "invite",
        "role": role,
        "created_by": created_by,
        "iss": JWT_ISSUER,
        "aud": _INVITE_AUDIENCE,
        "iat": now,
        "exp": expires_at,
    }
    if workspace_id is not None:
        payload["workspace_id"] = workspace_id
    if email is not None:
        payload["email"] = email
    if group_ids:
        payload["group_ids"] = list(group_ids)
    if jti is not None:
        payload["jti"] = jti
    if token_version is not None:
        # ``tv``: which generation of this link the URL belongs to.
        # Regenerating bumps the row's version, which strands every URL
        # minted at an older one. Omitted when None so tokens issued
        # before rotation existed stay byte-identical.
        payload["tv"] = token_version
    token = jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token, expires_at.isoformat()


def decode_invite_token(token: str) -> dict:
    """Decode an invite JWT. Returns the payload dict.

    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure.
    """
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_INVITE_AUDIENCE,
    )
    if payload.get("purpose") != "invite":
        raise jwt.InvalidTokenError("Not an invite token")
    return payload


# ── OIDC flow-state tokens ───────────────────────────────────────────
#
# The Authorization-Code + PKCE dance needs ``state``, ``nonce`` and the
# PKCE ``code_verifier`` to survive the round-trip to the IdP. Rather
# than a server-side session store we sign them into a short-lived,
# HttpOnly cookie. The signature makes the cookie tamper-proof; the
# short expiry bounds the window for a stolen-cookie replay.

def create_oidc_state_token(
    *,
    state: str,
    nonce: str,
    code_verifier: str,
    next_path: str,
    expires_in_minutes: int = 10,
) -> str:
    """Sign the in-flight OIDC handshake parameters into a JWT."""
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": "oidc_state",
        "state": state,
        "nonce": nonce,
        "cv": code_verifier,
        "next": next_path,
        "iss": JWT_ISSUER,
        "aud": _OIDC_STATE_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_oidc_state_token(token: str) -> dict:
    """Decode an OIDC flow-state JWT. Returns the payload dict.

    Raises jwt.ExpiredSignatureError or jwt.InvalidTokenError on failure.
    """
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_OIDC_STATE_AUDIENCE,
    )
    if payload.get("purpose") != "oidc_state":
        raise jwt.InvalidTokenError("Not an OIDC state token")
    return payload


# ── SAML flow-state tokens ───────────────────────────────────────────
#
# The SAML AuthnRequest/Response round-trip uses ``RelayState`` to bind
# the post-login bounce target. We sign the next_path + a random
# anti-CSRF nonce into a short-lived HttpOnly cookie that the ACS
# handler compares against the relay-state echoed back by the IdP.

def create_saml_state_token(
    *,
    relay_state: str,
    next_path: str,
    expires_in_minutes: int = 10,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": "saml_state",
        "rs": relay_state,
        "next": next_path,
        "iss": JWT_ISSUER,
        "aud": _SAML_STATE_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_saml_state_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_SAML_STATE_AUDIENCE,
    )
    if payload.get("purpose") != "saml_state":
        raise jwt.InvalidTokenError("Not a SAML state token")
    return payload


# ── Custom-IdP mock identity tokens (dev/demo only) ──────────────────
#
# Signed envelope carrying an AD-style identity payload (external_id,
# email, names, claims, groups, auth_time). The payload is OPAQUE to
# this module — fields are validated by the custom provider. Signing
# with the platform secret stops a casual tampering of the cookie /
# header value; the route layer additionally refuses to operate unless
# AUTH_CUSTOM_PROVIDER_ENABLED is true and ENV is non-prod (enforced
# at startup in core/config.py).

def create_mock_identity_token(
    payload: dict, *, expires_in_minutes: int = 10,
) -> str:
    now = datetime.now(timezone.utc)
    envelope = {
        "purpose": "mock_identity",
        "payload": payload,
        "iss": JWT_ISSUER,
        "aud": _MOCK_IDENTITY_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    return jwt.encode(envelope, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_mock_identity_token(token: str) -> dict:
    envelope = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_MOCK_IDENTITY_AUDIENCE,
    )
    if envelope.get("purpose") != "mock_identity":
        raise jwt.InvalidTokenError("Not a mock-identity token")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise jwt.InvalidTokenError("Mock identity payload missing")
    return payload


# ── Link-intent tokens (self-service "link this IdP to me") ──────────
#
# A logged-in user can ask to attach a new SSO identity to their
# current account. We need to remember "who initiated this flow" and
# "which provider they're linking to" across the IdP round-trip. The
# signed cookie ``nx_link_intent`` carries those two ids; the SSO
# callback checks it before deciding whether to provision a new user
# or attach the verified identity to ``user_id``.


def create_link_intent_token(
    *, user_id: str, provider_id: str, expires_in_minutes: int = 10,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": "link_intent",
        "user_id": user_id,
        "provider_id": provider_id,
        "iss": JWT_ISSUER,
        "aud": _LINK_INTENT_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_link_intent_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_LINK_INTENT_AUDIENCE,
    )
    if payload.get("purpose") != "link_intent":
        raise jwt.InvalidTokenError("Not a link-intent token")
    return payload


# ── Dry-run tokens ("what would happen if I signed in here?") ────────
#
# An admin starts a real IdP round-trip from the provider form. The
# signed ``nx_dryrun`` cookie marks the flow so the callback computes the
# outcome and renders it instead of minting a session. Minted only by an
# admin-authed endpoint, which is what keeps this from being a way for
# an anonymous caller to probe identities.


def create_dryrun_token(
    *, admin_id: str, provider_id: str, expires_in_minutes: int = 10,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": "dryrun",
        "admin_id": admin_id,
        "provider_id": provider_id,
        "iss": JWT_ISSUER,
        "aud": _DRYRUN_AUDIENCE,
        "iat": now,
        "exp": now + timedelta(minutes=expires_in_minutes),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_dryrun_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        JWT_SECRET_KEY,
        algorithms=[JWT_ALGORITHM],
        issuer=JWT_ISSUER,
        audience=_DRYRUN_AUDIENCE,
    )
    if payload.get("purpose") != "dryrun":
        raise jwt.InvalidTokenError("Not a dry-run token")
    return payload
