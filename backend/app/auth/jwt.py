"""Compatibility shim — see ``backend.auth_service.core.tokens``.

Originally named ``jwt.py``; the canonical module is now ``tokens.py``
inside the auth service so the future microservice can be lifted as-is.
"""
from backend.auth_service.core.tokens import (  # noqa: F401
    create_access_token,
    decode_token,
    create_invite_token,
    decode_invite_token,
)
