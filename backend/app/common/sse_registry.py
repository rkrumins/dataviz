"""Explicit registry of Server-Sent-Events routes.

The timeout middleware has to know which routes stream, because a stream
must not be raced by a request deadline: an SSE response is open for as
long as the client is listening, and cancelling it mid-flight leaves the
ASGI stream half-open (see ``_TimeoutMiddleware``'s docstring for what
that cascades into).

It used to answer that question with ``path.endswith("/events")``, which
is a guess about naming rather than a statement about behaviour — and it
guessed wrong. ``POST /api/v1/telemetry/events`` is an ordinary JSON
write that happens to end in the same word, and it was silently running
with no timeout and no readiness gate because of it. A route either
streams or it doesn't; that is a fact its own module knows and nothing
else can infer.

So streaming routes declare themselves:

    from backend.app.common.sse_registry import register_sse_path

    register_sse_path("/api/v1/.../{job_id}/events")

Templated segments are written exactly as the route declares them —
``{job_id}`` matches one path segment — because the middleware sees the
concrete path with real ids substituted in, not the template.
"""
from __future__ import annotations

import re
from typing import Pattern

__all__ = ["register_sse_path", "is_sse_path", "registered_sse_paths", "reset_for_testing"]


_exact: set[str] = set()
_patterns: list[Pattern[str]] = []
_registered: list[str] = []


def _template_to_pattern(template: str) -> Pattern[str]:
    """Compile ``/a/{x}/b`` into a regex matching ``/a/anything/b``.

    ``[^/]+`` rather than ``.+`` so a template segment matches exactly
    one path segment — otherwise ``/{id}/events`` would also match
    ``/a/b/c/events`` and re-introduce the over-matching this module
    exists to remove.
    """
    parts = re.split(r"(\{[^}]+\})", template)
    compiled = "".join(
        r"[^/]+" if part.startswith("{") and part.endswith("}") else re.escape(part)
        for part in parts
    )
    return re.compile(rf"^{compiled}$")


def register_sse_path(path: str) -> None:
    """Declare ``path`` as a streaming route. Idempotent.

    Call at module import time, next to the route it describes, so the
    declaration cannot drift away from the handler.
    """
    if path in _registered:
        return
    _registered.append(path)
    if "{" in path:
        _patterns.append(_template_to_pattern(path))
    else:
        _exact.add(path)


def is_sse_path(path: str) -> bool:
    """True if ``path`` is a registered streaming route."""
    if path in _exact:
        return True
    return any(pattern.match(path) for pattern in _patterns)


def registered_sse_paths() -> tuple[str, ...]:
    """The registered templates, for diagnostics and tests."""
    return tuple(_registered)


def reset_for_testing() -> None:
    """Drop all registrations. Tests only."""
    _exact.clear()
    _patterns.clear()
    _registered.clear()
