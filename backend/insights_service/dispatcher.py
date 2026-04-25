"""Kind → handler registry for the insights-service worker.

A handler is an async callable ``(session, envelope) -> None`` that runs
inside the worker's per-job DB transaction. Each collector module
(``collector.py``, ``discovery.py``, ``schema.py``) calls
:func:`register_handler` at import time to wire its kind into the map.

The worker calls :func:`get_handler(envelope.kind)` to dispatch each
incoming message. Unknown kinds raise ``ValueError``; the worker treats
that as a malformed-message DLQ event so a buggy producer can't poison
the consumer loop.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from .schemas import JobEnvelope

logger = logging.getLogger(__name__)


JobHandler = Callable[[AsyncSession, JobEnvelope], Awaitable[None]]


_HANDLERS: dict[str, JobHandler] = {}


def register_handler(kind: str, handler: JobHandler) -> None:
    """Register the handler for one job kind. Last write wins.

    Modules call this at import time. Re-registration replaces the
    existing handler — useful for tests that swap in a fake.
    """
    if kind in _HANDLERS and _HANDLERS[kind] is not handler:
        logger.info("Replacing existing handler for kind=%s", kind)
    _HANDLERS[kind] = handler


def get_handler(kind: str) -> JobHandler:
    try:
        return _HANDLERS[kind]
    except KeyError as exc:
        raise ValueError(
            f"No insights handler registered for kind {kind!r}; "
            f"known kinds: {sorted(_HANDLERS)}"
        ) from exc


def registered_kinds() -> list[str]:
    return sorted(_HANDLERS)


# ── Eager registration of the built-in handlers ──────────────────────
# Handler modules import this module to register, but importing them
# back here would create circular imports. Instead, the worker imports
# the handler modules at startup (see __main__.py) which triggers their
# self-registration. ``__main__`` then asserts at least the stats_poll
# kind is wired before XREADGROUP starts.
