"""What a native read-only query can fail with — shared by the guard in front
of every engine and the engines themselves, so a refusal reads the same
whichever of them made it.

All are ``ValueError``s: the query was wrong, or too big, or too slow — never
a sign the data source is unwell — so the circuit breaker never counts them.
``position`` is where in the query text the problem is, when known.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional


class NativeQueryError(ValueError):
    code = "native_query_failed"

    def __init__(self, message: str, *, position: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.position = position


class NativeQueryRefused(NativeQueryError):
    """The guard refused it before it ran: not a read, or reaches outside
    the graph."""
    code = "native_query_refused"


class NativeQuerySyntaxError(NativeQueryError):
    """The text isn't a query the engine can read."""
    code = "native_query_syntax"


class NativeQueryWriteRefused(NativeQueryError):
    """The engine itself found a write in it."""
    code = "native_query_write_refused"


class NativeQueryTooLarge(NativeQueryError):
    """Its answer is bigger than a native query may return, or it needs more
    memory than the engine allows one query."""
    code = "native_query_too_large"


class NativeQueryTimeout(NativeQueryError):
    """It ran out of time."""
    code = "native_query_timeout"


@dataclass(frozen=True)
class NativeQueryResult:
    """What an engine answered: its column names, and its rows as cells
    (``services/native_query/cells``) — at most the row cap it was given."""

    columns: List[str]
    rows: List[List[Any]]
