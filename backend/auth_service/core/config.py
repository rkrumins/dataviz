"""
Auth-service configuration — environment-driven.

``JWT_SECRET_KEY`` MUST be set explicitly (>= 32 chars) in every
environment — production, dev, and test. There is intentionally **no
ephemeral fallback**: a per-process random key silently invalidates
every outstanding session on restart and masks a missing-secret
misconfiguration in production. Absence or a too-weak value fails fast
at import so the process never starts in an insecure state.

Local-dev convenience: when ``ENV`` is NOT a production-looking value
AND a ``.env`` / ``.env.dev`` file exists in CWD, we auto-source it
via ``python-dotenv`` so operators don't have to ``export
JWT_SECRET_KEY=...`` before every ``uvicorn`` invocation. Both gates
have to pass; either fails closed -> we never load the file. A stray
``.env`` baked into a prod container is therefore inert.
"""
import hashlib
import logging
import os
import re
from pathlib import Path

# ── Gated .env auto-load (local dev only) ────────────────────────────
# Two layered gates: ENV check + CWD file existence. ``override=False``
# keeps anything already exported in the shell authoritative over the
# file value. Missing python-dotenv falls back to the explicit-export
# path silently — operators can still ``export JWT_SECRET_KEY=...``.
_dev_env = os.getenv("ENV", "dev").strip().lower()
if _dev_env not in {"prod", "production"}:
    for _candidate in (".env.dev", ".env"):
        _path = Path(_candidate)
        if _path.is_file():
            try:
                from dotenv import load_dotenv as _load_dotenv  # noqa: WPS433
                _load_dotenv(_path, override=False)
            except ImportError:
                # python-dotenv missing -> stay on the bare-env path.
                pass
            break  # prefer .env.dev over .env; first hit wins

logger = logging.getLogger(__name__)

_DEFAULT_ALGORITHM = "HS256"
# HS256 needs a high-entropy shared secret. 32 chars is the floor we
# accept; anything shorter is rejected as weak.
_MIN_SECRET_LENGTH = 32
# RBAC Phase 1: short access-token TTL paired with the Redis revocation
# set. The design plan calls for ≤5 min so revocation lag stays within
# enterprise tolerances; the shipped .env files and the k8s configmap
# use 15, which is the documented ceiling.
#
# Raising this is not free and the cost used to be invisible. Permission
# claims ride in the token, so this is how long a revoked or demoted
# session keeps working, and the Redis tombstone has to be held for the
# whole window — which is why RBAC_REVOCATION_TTL_SECONDS is derived
# from this value rather than configured beside it, and why startup
# refuses to boot if an explicit override makes the tombstone shorter.
# See ``_assert_session_config_coherent`` in backend/app/main.py.
_DEFAULT_ACCESS_EXPIRY_MINUTES = 5
_DEFAULT_REFRESH_EXPIRY_DAYS = 7


class MissingSigningSecret(RuntimeError):
    """Raised at import when JWT_SECRET_KEY is unset or too weak."""


def _resolve_secret() -> str:
    key = os.getenv("JWT_SECRET_KEY")
    if not key:
        raise MissingSigningSecret(
            "JWT_SECRET_KEY is not set. Set a high-entropy secret "
            f"(>= {_MIN_SECRET_LENGTH} chars) in the environment — there "
            "is no ephemeral fallback. Generate one with "
            "`python -c 'import secrets; print(secrets.token_urlsafe(48))'`."
        )
    if len(key) < _MIN_SECRET_LENGTH:
        raise MissingSigningSecret(
            f"JWT_SECRET_KEY is too weak ({len(key)} chars); "
            f"require >= {_MIN_SECRET_LENGTH}."
        )
    return key


def _resolve_retired_secrets() -> tuple[str, ...]:
    """Keys accepted for VERIFICATION but never used to sign.

    Without this, changing ``JWT_SECRET_KEY`` invalidates every
    outstanding session the instant the new value lands — and during a
    rolling update, pods holding the old and new key both serve traffic,
    so the same user's requests flip between authenticated and 401 with
    no session affinity to pin them. Carrying the previous key here
    makes rotation and rollouts non-disruptive: sign with the new key,
    keep accepting the old one until the refresh TTL has drained, then
    drop it.

    Comma-separated, most-recent first. Each entry is held to the same
    length floor as the signing key, and duplicates of the active key
    are dropped so the ring never verifies the same secret twice.
    """
    raw = os.getenv("JWT_SECRET_KEY_PREVIOUS", "")
    keys: list[str] = []
    for candidate in raw.split(","):
        key = candidate.strip()
        if not key:
            continue
        if len(key) < _MIN_SECRET_LENGTH:
            raise MissingSigningSecret(
                f"JWT_SECRET_KEY_PREVIOUS contains a key that is too weak "
                f"({len(key)} chars); require >= {_MIN_SECRET_LENGTH}. "
                "Retired keys are still trusted for verification, so they "
                "carry the same strength requirement as the active one."
            )
        if key != JWT_SECRET_KEY and key not in keys:
            keys.append(key)
    return tuple(keys)


def key_id(secret: str) -> str:
    """Short, non-reversible fingerprint of a signing key.

    Emitted as the JWT ``kid`` header so verification selects the right
    key directly instead of trial-decoding, and logged at startup so two
    environments can be told apart without ever exposing the secret.
    """
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:8]


JWT_SECRET_KEY: str = _resolve_secret()
JWT_SECRET_KEYS_PREVIOUS: tuple[str, ...] = _resolve_retired_secrets()
JWT_SECRET_KEY_ID: str = key_id(JWT_SECRET_KEY)
# (kid, key) pairs in verification-preference order: active key first.
JWT_VERIFICATION_KEYS: tuple[tuple[str, str], ...] = tuple(
    (key_id(k), k) for k in (JWT_SECRET_KEY, *JWT_SECRET_KEYS_PREVIOUS)
)
JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", _DEFAULT_ALGORITHM)
JWT_EXPIRY_MINUTES: int = int(
    os.getenv("JWT_EXPIRY_MINUTES", str(_DEFAULT_ACCESS_EXPIRY_MINUTES))
)
JWT_REFRESH_EXPIRY_DAYS: int = int(
    os.getenv("JWT_REFRESH_EXPIRY_DAYS", str(_DEFAULT_REFRESH_EXPIRY_DAYS))
)
# ── Environment identity ─────────────────────────────────────────────
# Distinguishes one deployment of this app from another (``dev``,
# ``uat``, ...). Optional: leave it unset and every value below is
# byte-identical to what a single-environment deployment already emits.
#
# Set it when two environments can be open in the same browser. Cookie
# jars are keyed by DOMAIN, not by cluster, so two deployments that use
# the same cookie names overwrite each other's session even when they
# run on different clusters entirely. Because the tokens also carry
# identical ``iss``/``aud``, the receiving side cannot tell a foreign
# token from its own and the only symptom is an opaque
# "Signature verification failed" — the failure this setting removes.
#
# Constrained to a cookie-name-safe alphabet: it becomes part of the
# cookie name, and a stray separator would silently produce a cookie the
# browser refuses to store.
_ENV_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
AUTH_ENVIRONMENT_ID: str = os.getenv("AUTH_ENVIRONMENT_ID", "").strip().lower()
if AUTH_ENVIRONMENT_ID and not _ENV_ID_PATTERN.match(AUTH_ENVIRONMENT_ID):
    raise RuntimeError(
        f"AUTH_ENVIRONMENT_ID={AUTH_ENVIRONMENT_ID!r} is invalid. Use 1-32 "
        "chars of [a-z0-9_-] starting alphanumeric (e.g. 'dev', 'uat') — "
        "the value becomes part of the session cookie names."
    )

_BASE_ISSUER: str = os.getenv("JWT_ISSUER", "nexus-lineage")
# Binding the environment into the issuer is what turns a cross-environment
# token from an unexplained signature failure into an InvalidIssuerError —
# a condition the caller can actually recognise and recover from by
# evicting the cookie instead of looping on 401.
JWT_ISSUER: str = (
    f"{_BASE_ISSUER}:{AUTH_ENVIRONMENT_ID}" if AUTH_ENVIRONMENT_ID else _BASE_ISSUER
)
JWT_AUDIENCE: str = os.getenv("JWT_AUDIENCE", "nexus-lineage")

# Cookie configuration. SameSite=Lax is safe for top-level navigation;
# Secure is enforced by default and can only be disabled in dev/test.
COOKIE_SECURE: bool = os.getenv("AUTH_COOKIE_SECURE", "true").lower() != "false"
COOKIE_DOMAIN: str | None = os.getenv("AUTH_COOKIE_DOMAIN") or None
COOKIE_SAMESITE: str = os.getenv("AUTH_COOKIE_SAMESITE", "lax").lower()


# ── SSO session lifetime (Phase 2.E) ─────────────────────────────────
# Re-auth ceiling: SSO users must complete a fresh IdP authentication at
# least once every ``SSO_SESSION_MAX_AGE_HOURS`` (default 24). Enforced
# on every /refresh by comparing the provider-issued auth_time embedded
# in the refresh JWT. Local password sessions are NOT subject to this
# ceiling — their refresh cookie still lives ``JWT_REFRESH_EXPIRY_DAYS``.
SSO_SESSION_MAX_AGE_HOURS: float = float(
    os.getenv("SSO_SESSION_MAX_AGE_HOURS", "24")
)
SSO_SESSION_MAX_AGE_SECONDS: int = int(SSO_SESSION_MAX_AGE_HOURS * 3600)


# Rotation grace window. Refresh-token rotation treats a re-presented
# jti as a stolen-chain replay and kills the whole family. That is right
# for an attacker and wrong for the far more common causes: two tabs
# refreshing on the same cookie within milliseconds of each other, a
# retried POST, a tab restored from bfcache, or a rotation whose
# Set-Cookie never made it back to the browser. Inside this window the
# re-presentation is answered with the successor the first caller
# already minted, so both racers converge on one token and nobody is
# signed out. Outside it, reuse detection is unchanged.
#
# The cost, stated plainly: an attacker who already holds the stolen
# refresh cookie and presents it within this window gets the same
# successor rather than tripping detection. That is the same bargain
# Auth0 and IdentityServer strike with their rotation reuse intervals.
# Set to 0 to refuse it — at the price of signing users out of every tab
# whenever two of them rotate at once, which is what this fixes.
REFRESH_ROTATION_GRACE_SECONDS: int = int(
    os.getenv("REFRESH_ROTATION_GRACE_SECONDS", "30")
)


# ── Rate limits ──────────────────────────────────────────────────────
#
# Two different jobs, so two different keys.
#
# The per-IP limits are a coarse flood guard and nothing more. Behind a
# NAT or an ingress every user shares one address, so a tight per-IP cap
# does not stop an attacker (they have many addresses) while it does
# stop an office (they have one). The previous 10/minute on /login meant
# the eleventh person to arrive at 09:00 was refused. Real DoS handling
# belongs at the proxy; these values are sized so a legitimate tenant
# never reaches them — roughly 3x the peak a 2000-seat deployment
# produces during a morning sign-in rush.
#
# The per-account limits are the security control. They key on the
# account being attacked rather than the address attacking it, so they
# hold whether the traffic comes from one IP or ten thousand, and a
# spray against one user cannot be widened by renting more addresses.
RATELIMIT_LOGIN_PER_IP: str = os.getenv("RATELIMIT_LOGIN_PER_IP", "1000/minute")
RATELIMIT_SENSITIVE_PER_IP: str = os.getenv(
    "RATELIMIT_SENSITIVE_PER_IP", "200/minute"
)
# Refresh is keyed per rotation family (one browser session), so this is
# already per-user and needs no headroom for tenant size. A session needs
# ~4 rotations an hour; 30/minute is ~450x that.
RATELIMIT_REFRESH_PER_SESSION: str = os.getenv(
    "RATELIMIT_REFRESH_PER_SESSION", "30/minute"
)

# Counted on FAILURES only and cleared on a successful sign-in, so
# someone who signs in correctly twenty times a day is never throttled
# while a spray against one account stops at ten.
RATELIMIT_LOGIN_PER_ACCOUNT: str = os.getenv(
    "RATELIMIT_LOGIN_PER_ACCOUNT", "10 per 15 minutes"
)
# Counted on every request: password-reset responses are deliberately
# identical whether or not the account exists, so there is no failure to
# distinguish. This bounds mailbombing one person's inbox.
RATELIMIT_PASSWORD_RESET_PER_ACCOUNT: str = os.getenv(
    "RATELIMIT_PASSWORD_RESET_PER_ACCOUNT", "3/hour"
)


# ── Custom Identity Provider (Phase 2.B; dev/demo only) ──────────────
# The Custom provider reads a JWT-signed cookie/header that simulates an
# IdP returning AD-style attributes (first/last/email/external_id/claims/
# groups). It is hard-gated by AUTH_CUSTOM_PROVIDER_ENABLED and is
# refused at startup when ENV is a production-looking value.
ENV: str = os.getenv("ENV", "dev").strip().lower()
AUTH_CUSTOM_PROVIDER_ENABLED: bool = (
    os.getenv("AUTH_CUSTOM_PROVIDER_ENABLED", "false").lower() == "true"
)
_PROD_ENV_VALUES = {"prod", "production"}
if AUTH_CUSTOM_PROVIDER_ENABLED and ENV in _PROD_ENV_VALUES:
    raise RuntimeError(
        "AUTH_CUSTOM_PROVIDER_ENABLED=true is forbidden in production. "
        "The Custom IdP is a dev/demo mock that trusts a self-signed "
        "cookie payload; running it in prod would bypass real SSO. "
        "Set AUTH_CUSTOM_PROVIDER_ENABLED=false or change ENV."
    )
