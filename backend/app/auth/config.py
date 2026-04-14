"""Compatibility shim — the canonical home for these symbols is
``backend.auth_service.core.config``. New code should import from there;
this module exists only so existing call sites keep working during the
transition to the dedicated auth service.
"""
from backend.auth_service.core.config import (  # noqa: F401
    JWT_SECRET_KEY,
    JWT_ALGORITHM,
    JWT_EXPIRY_MINUTES,
    JWT_ISSUER,
    JWT_AUDIENCE,
)
