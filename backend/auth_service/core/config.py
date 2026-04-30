"""
Auth-service configuration — environment-driven.

Production deployments MUST set JWT_SECRET_KEY. In dev (no secret set) a
random ephemeral key is generated per process and a warning is logged;
restarting the app invalidates all outstanding sessions.
"""
import logging
import os
import secrets

logger = logging.getLogger(__name__)

_DEFAULT_ALGORITHM = "HS256"
# RBAC Phase 1: short access-token TTL paired with Redis revocation
# set. Old default was 15 minutes; the design plan calls for ≤5 min so
# revocation lag stays within enterprise tolerances. Operators can
# override JWT_EXPIRY_MINUTES to fall back to the longer window if the
# revocation set is unavailable in their environment.
_DEFAULT_ACCESS_EXPIRY_MINUTES = 5
_DEFAULT_REFRESH_EXPIRY_DAYS = 7


def _resolve_secret() -> str:
    key = os.getenv("JWT_SECRET_KEY")
    if key:
        return key
    generated = secrets.token_urlsafe(64)
    logger.warning(
        "JWT_SECRET_KEY is not set — using a random ephemeral key. "
        "Tokens will not survive restarts. Set JWT_SECRET_KEY in production."
    )
    return generated


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
