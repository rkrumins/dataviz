"""Which API key, if any, the current request is acting through.

Set by the auth dependency when a request authenticates with a key, and read
by the outbox writers, so every event such a request produces names the key
it came through — including events written by work the request spawns, which
inherits the context. A request made in a browser session leaves it unset.
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Optional

current_api_key_id: ContextVar[Optional[str]] = ContextVar(
    "current_api_key_id", default=None,
)


def stamp(payload: Optional[dict]) -> dict:
    """``payload`` with ``api_key_id`` added when a key is acting — a copy, so
    the caller's dict is never changed under it."""
    out = dict(payload or {})
    key_id = current_api_key_id.get()
    if key_id and "api_key_id" not in out:
        out["api_key_id"] = key_id
    return out
