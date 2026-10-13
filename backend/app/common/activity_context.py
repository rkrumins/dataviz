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
from typing import Any, Mapping, Optional
from urllib.parse import quote, unquote

#: The request header a person's stated reason travels in.
REASON_HEADER = "X-Activity-Reason"

#: Who is acting, as the web tier tells the aggregation control plane on a
#: proxied call. Set by the web tier from the authenticated session — never
#: copied from a client's request — and read by the control plane only on
#: its internal, token-authenticated channel.
ACTOR_HEADER = "X-Activity-Actor"

#: The correlation id, on the same hop (the web tier's ``X-Request-ID``).
CORRELATION_HEADER = "X-Request-ID"

#: The API key the person is acting through, on the same hop. Like the actor,
#: set from the request's authentication, never from its client.
API_KEY_HEADER = "X-Activity-Api-Key"

#: Longest stated reason kept. A sentence or two — the ledger records why
#: something was done, it is not a place to paste an incident write-up.
MAX_REASON_CHARS = 500

#: Envelope keys merged into outbox payloads (see the module docstring for why
#: they are not ``reason`` / ``request_id``).
STATED_REASON_KEY = "stated_reason"
CORRELATION_KEY = "correlation_id"
#: The API key a change was made with. A payload that is ABOUT a key names it
#: under ``key_id`` instead, so the two never collide.
API_KEY_KEY = "api_key_id"

#: A client-supplied ``X-Request-ID`` is honoured only in this shape. It is
#: now stored in the ledger, so an arbitrary string from the client must not
#: become an arbitrary string in an audit record.
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

#: An actor id as the control plane will accept it from the web tier: a user
#: id, or one of the service names a payload uses.
_ACTOR_ID = re.compile(r"^[A-Za-z0-9._:@-]{1,128}$")

_WHITESPACE = re.compile(r"\s+")

#: Unicode categories :func:`clean_text` replaces: control, format, surrogate.
_UNPRINTABLE = frozenset({"Cc", "Cf", "Cs"})


@dataclass(frozen=True)
class ActivityContext:
    """What the current request can tell an emitter about itself."""

    correlation_id: Optional[str] = None
    stated_reason: Optional[str] = None
    #: The authenticated person, once authentication has run.
    actor_id: Optional[str] = None
    #: The API key they authenticated with, when they used one.
    api_key_id: Optional[str] = None


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


def bind_actor(actor_id: Optional[str], *, api_key_id: Optional[str] = None) -> None:
    """Record who is acting, and through which API key if any, for the rest
    of this request.

    Called where authentication succeeds. No reset is needed: the binding
    lives in the request's own task context, which ends with the request.
    """
    if actor_id:
        _current.set(replace(
            current(), actor_id=str(actor_id), api_key_id=api_key_id or None,
        ))


def valid_correlation_id(value: Optional[str]) -> Optional[str]:
    """``value`` when it is a well-formed correlation id, else ``None``."""
    if value and _CORRELATION_ID.match(value):
        return value
    return None


def clean_text(value: Any, limit: int) -> Optional[str]:
    """Untrusted text as one bounded, printable line, or ``None``.

    Control, format and lone-surrogate characters go: a bidi override in an
    audit record is a way to make it read as something it does not say, and
    a NUL or a lone surrogate (which a JSON ``\\ud800`` escape decodes to) is
    a value Postgres refuses to store. Runs of whitespace collapse and the
    result is capped. Empty after all that is ``None``.
    """
    if not isinstance(value, str):
        return None
    # Bound the work: collapsing whitespace can shrink a value, but not by
    # more than this.
    value = value[: limit * 8]
    if not (value.isascii() and value.isprintable()):
        value = "".join(
            ch if unicodedata.category(ch) not in _UNPRINTABLE else " "
            for ch in value
        )
    return _WHITESPACE.sub(" ", value).strip()[:limit] or None


def clean_reason(value: Any) -> Optional[str]:
    """Normalise free text a person typed into one bounded, printable line."""
    return clean_text(value, MAX_REASON_CHARS)


def parse_stated_reason(header_value: Optional[str]) -> Optional[str]:
    """The ``X-Activity-Reason`` header, decoded and cleaned."""
    if not header_value:
        return None
    # Bound the work before decoding: a percent-encoded character is at most
    # twelve bytes on the wire, so anything longer than this cannot shrink
    # to fit the cap anyway.
    return clean_reason(unquote(header_value[: MAX_REASON_CHARS * 12], errors="replace"))


def envelope(payload: dict[str, Any]) -> dict[str, Any]:
    """``payload`` with this request's correlation id, stated reason and API
    key added.

    Only keys the payload does not already carry are filled, so an emitter
    that knows better (the control plane, recording a forwarded reason) always
    wins, and a payload is never rewritten under its own key names.
    """
    ctx = current()
    if ctx.correlation_id and CORRELATION_KEY not in payload:
        payload[CORRELATION_KEY] = ctx.correlation_id
    if ctx.stated_reason and STATED_REASON_KEY not in payload:
        payload[STATED_REASON_KEY] = ctx.stated_reason
    if ctx.api_key_id and API_KEY_KEY not in payload:
        payload[API_KEY_KEY] = ctx.api_key_id
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
    #: The API key the person acted through, when they used one.
    api_key_id: Optional[str] = None

    def without_recording(self) -> "Provenance":
        return replace(self, record=False)


def current_provenance() -> Optional[Provenance]:
    """This request's person, reason and correlation id — ``None`` when no
    person is acting (a scheduled job, an anonymous request)."""
    ctx = current()
    if not ctx.actor_id:
        return None
    return Provenance(
        actor_id=ctx.actor_id,
        stated_reason=ctx.stated_reason,
        correlation_id=ctx.correlation_id,
        api_key_id=ctx.api_key_id,
    )


def forward_headers() -> dict[str, str]:
    """This request's activity context as headers, for a call to the
    aggregation control plane (see :data:`ACTOR_HEADER`)."""
    ctx = current()
    headers: dict[str, str] = {}
    if ctx.actor_id:
        headers[ACTOR_HEADER] = ctx.actor_id
    if ctx.stated_reason:
        headers[REASON_HEADER] = quote(ctx.stated_reason, safe="")
    if ctx.correlation_id:
        headers[CORRELATION_HEADER] = ctx.correlation_id
    if ctx.api_key_id:
        headers[API_KEY_HEADER] = ctx.api_key_id
    return headers


def from_forwarded(headers: Mapping[str, str]) -> ActivityContext:
    """The context :func:`forward_headers` sent, read back and re-validated.

    Only for a channel that is already authenticated as the web tier; a
    value in the wrong shape is dropped rather than trusted.
    """
    actor = headers.get(ACTOR_HEADER)
    key = headers.get(API_KEY_HEADER)
    return ActivityContext(
        correlation_id=valid_correlation_id(headers.get(CORRELATION_HEADER)),
        stated_reason=parse_stated_reason(headers.get(REASON_HEADER)),
        actor_id=actor if actor and _ACTOR_ID.match(actor) else None,
        api_key_id=key if key and _ACTOR_ID.match(key) else None,
    )


def provenance_for(user: Any) -> Provenance:
    """The authenticated user plus whatever this request said about itself."""
    ctx = current()
    actor = getattr(user, "id", None) or None
    return Provenance(
        actor_id=str(actor) if actor else None,
        stated_reason=ctx.stated_reason,
        correlation_id=ctx.correlation_id,
        api_key_id=ctx.api_key_id,
    )
