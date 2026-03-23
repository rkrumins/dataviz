"""
JWT configuration — reads secrets and tunables from environment variables.

In development (no JWT_SECRET_KEY set) a random key is generated per process
and a warning is logged.  Production deployments MUST set JWT_SECRET_KEY.
"""
import os
import secrets
import logging

logger = logging.getLogger(__name__)

_DEFAULT_ALGORITHM = "HS256"
_DEFAULT_EXPIRY_MINUTES = 60


def _resolve_secret() -> str:
    key = os.getenv("JWT_SECRET_KEY")
    if key:
        return key
    generated = secrets.token_urlsafe(64)
    logger.warning(
        "JWT_SECRET_KEY is not set — using a random ephemeral key. "
        "Tokens will not survive restarts.  Set JWT_SECRET_KEY in production."
    )
    return generated


JWT_SECRET_KEY: str = _resolve_secret()
JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", _DEFAULT_ALGORITHM)
JWT_EXPIRY_MINUTES: int = int(os.getenv("JWT_EXPIRY_MINUTES", str(_DEFAULT_EXPIRY_MINUTES)))
JWT_ISSUER: str = os.getenv("JWT_ISSUER", "nexus-lineage")
JWT_AUDIENCE: str = os.getenv("JWT_AUDIENCE", "nexus-lineage")
