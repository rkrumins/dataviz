"""Request-scoped activity context: which request, and the reason a person gave.

Every domain event lands in ``outbox_events`` inside the transaction that made
the change, and the relay turns it into a row of the activity ledger. Two facts
about an event are not known where it is emitted, only where the request came
in: the request it belongs to, and — for a manual operation — WHY the person
did it. Threading both through every service signature down to ~80 emit sites
would be churn with no payoff, so the request binds them here once and the two
outbox writers read them back (:func:`envelope`).

The reason travels as the ``X-Activity-Reason`` header rather than a body
field. A header reaches every verb — removing a group member is a body-less
``DELETE`` — and it leaves every request schema untouched. It is percent-encoded
by the client because a header value is Latin-1 on the wire, and it is
optional everywhere: the API never requires a reason, and an absent one is
recorded as absent rather than invented.

**Why these key names.** Existing payloads already use ``reason`` for a
*system* reason — why a sign-in failed, why a session was revoked — and
``request_id`` for an access request's id. The envelope must never overwrite
either, so it uses ``stated_reason`` (what a person typed) and
``correlation_id`` (the HTTP request), and only fills a key that is absent.

Stdlib only: the aggregation control plane imports this, and it must start
without the web tier's auth configuration.
"""
from __future__ import annotations

import re
import unicodedata
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from typing import Any, Optional
from urllib.parse import unquote

#: The request header a person's stated reason travels in.
REASON_HEADER = "X-Activity-Reason"

#: Longest stated reason kept. A sentence or two — the ledger records why
#: something was done, it is not a place to paste an incident write-up.
MAX_REASON_CHARS = 500

#: Envelope keys merged into outbox payloads (see the module docstring for why
#: they are not ``reason`` / ``request_id``).
STATED_REASON_KEY = "stated_reason"
CORRELATION_KEY = "correlation_id"

#: A client-supplied ``X-Request-ID`` is honoured only in this shape. It is
#: now stored in the ledger, so an arbitrary string from the client must not
#: become an arbitrary string in an audit record.
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class ActivityContext:
    """What the current request can tell an emitter about itself."""

    correlation_id: Optional[str] = None
    stated_reason: Optional[str] = None


_current: ContextVar[ActivityContext] = ContextVar(
    "activity_context", default=ActivityContext(),
)


def current() -> ActivityContext:
    """The context bound for this request (empty outside one)."""
    return _current.get()


def bind(ctx: ActivityContext) -> Token:
    """Bind ``ctx`` for the rest of this task (and tasks it starts)."""
    return _current.set(ctx)


def reset(token: Token) -> None:
    _current.reset(token)


def valid_correlation_id(value: Optional[str]) -> Optional[str]:
    """``value`` when it is a well-formed correlation id, else ``None``."""
    if value and _CORRELATION_ID.match(value):
        return value
    return None


def clean_reason(value: Any) -> Optional[str]:
    """Normalise free text a person typed into one bounded, printable line.

    Control and format characters go (a bidi override in an audit record is a
    way to make it read as something it does not say), runs of whitespace
    collapse, and the result is capped. Empty after all that means no reason.
    """
    if not isinstance(value, str):
        return None
    text = "".join(
        ch if unicodedata.category(ch) not in ("Cc", "Cf") else " "
        for ch in value
    )
    text = _WHITESPACE.sub(" ", text).strip()
    if not text:
        return None
    return text[:MAX_REASON_CHARS]


def parse_stated_reason(header_value: Optional[str]) -> Optional[str]:
    """The ``X-Activity-Reason`` header, decoded and cleaned."""
    if not header_value:
        return None
    # Bound the work before decoding: a percent-encoded character is at most
    # twelve bytes on the wire, so anything longer than this cannot shrink
    # to fit the cap anyway.
    return clean_reason(unquote(header_value[: MAX_REASON_CHARS * 12], errors="replace"))


def envelope(payload: dict[str, Any]) -> dict[str, Any]:
    """``payload`` with this request's correlation id and stated reason added.

    Only keys the payload does not already carry are filled, so an emitter
    that knows better (the control plane, recording a forwarded reason) always
    wins, and a payload is never rewritten under its own key names.
    """
    ctx = current()
    if ctx.correlation_id and CORRELATION_KEY not in payload:
        payload[CORRELATION_KEY] = ctx.correlation_id
    if ctx.stated_reason and STATED_REASON_KEY not in payload:
        payload[STATED_REASON_KEY] = ctx.stated_reason
    return payload


@dataclass(frozen=True)
class Provenance:
    """Who performed an operation, why, and in which request.

    The explicit twin of :class:`ActivityContext`, for the places a context
    variable cannot reach: the hop from the web tier to the aggregation
    control plane is an HTTP call, so the person travels in the forwarded
    body and arrives here. ``record=False`` lets a caller attribute work (a
    job row's ``triggered_by``) without writing a second ledger event for an
    action that is already being recorded once.
    """

    actor_id: Optional[str]
    stated_reason: Optional[str] = None
    correlation_id: Optional[str] = None
    record: bool = True

    def without_recording(self) -> "Provenance":
        return replace(self, record=False)


def provenance_for(user: Any) -> Provenance:
    """The authenticated user plus whatever this request said about itself."""
    ctx = current()
    actor = getattr(user, "id", None) or None
    return Provenance(
        actor_id=str(actor) if actor else None,
        stated_reason=ctx.stated_reason,
        correlation_id=ctx.correlation_id,
    )
