"""Compatibility shim — see ``backend.auth_service.core.password``."""
from backend.auth_service.core.password import (  # noqa: F401
    hash_password,
    verify_password,
)
