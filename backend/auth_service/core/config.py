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
import logging
import os
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
# RBAC Phase 1: short access-token TTL paired with Redis revocation
# set. Old default was 15 minutes; the design plan calls for ≤5 min so
# revocation lag stays within enterprise tolerances. Operators can
# override JWT_EXPIRY_MINUTES to fall back to the longer window if the
# revocation set is unavailable in their environment.
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


JWT_SECRET_KEY: str = _resolve_secret()
JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", _DEFAULT_ALGORITHM)
JWT_EXPIRY_MINUTES: int = int(
    os.getenv("JWT_EXPIRY_MINUTES", str(_DEFAULT_ACCESS_EXPIRY_MINUTES))
)
JWT_REFRESH_EXPIRY_DAYS: int = int(
    os.getenv("JWT_REFRESH_EXPIRY_DAYS", str(_DEFAULT_REFRESH_EXPIRY_DAYS))
)
JWT_ISSUER: str = os.getenv("JWT_ISSUER", "nexus-lineage")
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
