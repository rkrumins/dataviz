"""Spanner exception → reason code classifier.

Buckets google-cloud-spanner exceptions into stable codes that flow into
preflight results, metrics, and the test-connection UI. Keep the strings
stable: dashboards key off them.
"""
from __future__ import annotations

import asyncio
from typing import Final


_AUTH_TOKENS: Final = ("permission", "unauthenticated", "credentials", "iam ")
_TIMEOUT_TOKENS: Final = ("timeout", "deadline")


def classify_spanner_error(exc: BaseException) -> str:
    """Return a short, stable reason code for a Spanner exception.

    Inspects the exception class name and message; matches before
    cleartext error formatting (which Google may change between SDK
    releases).
    """
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "connect_timeout"

    msg = f"{type(exc).__name__}: {exc!s}".lower()

    if any(t in msg for t in _AUTH_TOKENS):
        return "auth_error"
    if "not found" in msg and "database" in msg:
        return "database_not_found"
    if "property_graph" in msg and ("does not exist" in msg or "not found" in msg or "unknown" in msg):
        return "spanner_edition_unsupported"
    if "postgresql" in msg or "pg_catalog" in msg or "dialect" in msg:
        return "dialect_unsupported"
    if any(t in msg for t in _TIMEOUT_TOKENS):
        # Return ``connect_timeout`` uniformly — call sites that want to
        # distinguish connect vs. query timeout do so via ``asyncio.TimeoutError``
        # at the wait_for boundary, before reaching the classifier.
        return "connect_timeout"
    if "unavailable" in msg:
        return "service_unavailable"
    if "aborted" in msg:
        return "transaction_aborted"
    return f"error: {msg[:120]}"


def is_transient(exc: BaseException) -> bool:
    """True if the exception should be retried with backoff."""
    cls = type(exc).__name__
    return cls in ("ServiceUnavailable", "DeadlineExceeded", "Aborted", "InternalServerError")
