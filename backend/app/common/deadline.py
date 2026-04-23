"""Request-scoped deadline propagation.

Paired with the ASGI timeout middleware in ``backend/app/main.py``:
``/graph/*`` requests get a soft deadline (what the handler *should*
finish within) in addition to the existing hard timeout (what the
middleware will forcibly abort at).

Handlers on the `/graph/*` prefix read ``Deadline.current()`` and, if
they see they're close to or past the soft deadline, return a graceful
fallback (e.g. ``DerivedStatus.UNAVAILABLE``) instead of getting killed
mid-flight.

No current call site depends on deadline propagation across background
tasks — ``ContextVar`` is intentionally not passed to
``asyncio.create_task`` workers.
"""
from __future__ import annotations

import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional

_current_deadline: ContextVar[Optional["Deadline"]] = ContextVar(
    "current_deadline", default=None
)


@dataclass(frozen=True)
class Deadline:
    """A monotonic deadline for the current request."""

    # ``time.monotonic()`` second at which the soft budget is exhausted.
    expires_monotonic: float

    def remaining(self) -> float:
        """Seconds left before the soft deadline. Can be negative."""
        return self.expires_monotonic - time.monotonic()

    def expired(self) -> bool:
        return self.remaining() <= 0

    def has_time(self, min_seconds: float) -> bool:
        """True if at least ``min_seconds`` of budget remain."""
        return self.remaining() >= min_seconds

    @classmethod
    def for_budget(cls, budget_seconds: float) -> "Deadline":
        return cls(expires_monotonic=time.monotonic() + budget_seconds)

    @classmethod
    def current(cls) -> Optional["Deadline"]:
        return _current_deadline.get()

    def set_current(self):
        return _current_deadline.set(self)
