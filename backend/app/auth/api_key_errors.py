"""The refusals an API key can earn, shaped in one place.

RFC 6750 §3 gives bearer credentials a standard way to say why a request was
refused, and clients and gateways read it: a refused *credential* answers 401
with ``WWW-Authenticate: Bearer error="invalid_token"``; a credential that is
fine but may not do what it asked answers 403 with
``error="insufficient_scope"``. The body keeps this API's own structured
``detail`` — ``error`` is a stable code a client can branch on, ``message``
is for a person — so a refusal reads the same as every other one here.

No imports from the rest of the app: endpoints and the auth path both use it.
"""
from __future__ import annotations

from fastapi import HTTPException, status


def _challenge(error: str, description: str) -> dict[str, str]:
    safe = description.replace('"', "'")
    return {
        "WWW-Authenticate": (
            f'Bearer realm="api", error="{error}", error_description="{safe}"'
        ),
    }


def invalid_key(code: str, message: str, **extra) -> HTTPException:
    """The key itself is not honoured: unknown, revoked, expired, paused."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"error": code, "message": message, **extra},
        headers=_challenge("invalid_token", message),
    )


def key_forbidden(code: str, message: str, **extra) -> HTTPException:
    """The key is honoured but may not do this."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error": code, "message": message, **extra},
        headers=_challenge("insufficient_scope", message),
    )


def out_of_scope(message: str) -> HTTPException:
    """The request reaches past the views, data sources or workspaces the key
    was limited to."""
    return key_forbidden("api_key_out_of_scope", message)


__all__ = ["invalid_key", "key_forbidden", "out_of_scope"]
