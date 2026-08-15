"""``GET /api/v1/changes`` — the change manifest.

One request that answers, for every resource a client is showing, "has
this moved since you last looked?" Nine always-mounted surfaces used to
ask that question separately, on nine timers, and the answer was almost
always no.

The manifest is a map of topic to version counter. A client compares it
against what it holds and refetches only the endpoints whose version
differs. The endpoints themselves are unchanged and remain the source of
truth — this says *when* to call them, never *what* they return.

Beyond replacing the nine polls, this is also the backstop for the
streaming transport: on connect and on every reconnect a client reads
the manifest, so a change that happened while it was disconnected shows
up as a version mismatch. That is what lets the stream be lossy, which
in turn is what lets it be cheap.

**Topics come from the session, not the request.** See
``changes/topics.py`` — a caller cannot name a topic, only narrow the
set its identity already implies.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.changes import topics as change_topics
from backend.app.changes.hub import get_hub
from backend.app.changes.registry import get_registry
from backend.app.common.sse_registry import register_sse_path
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

register_sse_path("/api/v1/changes/stream")


# How often a quiet stream emits a comment frame.
#
# The binding constraint is nginx's ``proxy_read_timeout 180s``, which IS
# an idle timeout and so IS satisfied by heartbeats. 25s leaves ~7x
# margin, enough to survive a couple of dropped frames, and is short
# enough to detect a dead intermediary well inside that window.
#
# The GKE backend-service ``timeoutSec`` is a different animal and no
# heartbeat helps with it: it bounds the whole exchange rather than the
# idle gap, so it caps stream *lifetime*. That is handled by keeping
# streams deliberately short-lived (below) and sizing the LB timeout
# above that in ``deploy/k8s/.../backendconfig.yaml``.
_HEARTBEAT_SECONDS = float(os.getenv("CHANGES_SSE_HEARTBEAT_SECONDS", "25"))

# Maximum lifetime of one stream. Deliberately far below the access
# token's validity: the handler authenticates once at open and cannot
# re-read the cookie afterwards (the ASGI scope is frozen, so a token
# rotated by /auth/refresh is invisible to a stream already running).
# Closing on a schedule and letting the client reconnect keeps every
# stream's authorization fresh by construction, and gives the load
# balancer's own ceiling something predictable to sit above.
_MAX_STREAM_SECONDS = float(os.getenv("CHANGES_SSE_MAX_SECONDS", "900"))

# Concurrent streams per process. Unlike the job stream next door this
# costs no Redis connection — the hub is the only reader — so the bound
# is memory and event-loop fairness rather than a pool. Generous, and
# refusing is harmless: the client falls back to polling the manifest.
_MAX_CONCURRENT_STREAMS = int(os.getenv("CHANGES_SSE_MAX_CONCURRENT", "500"))

# Reconnect hint, jittered per connection. Set on EVERY open, because
# after a hard replica loss the browser reuses the last value it was
# given — an un-jittered one would bring every orphaned client back at
# the same instant.
_RETRY_BASE_MS = int(os.getenv("CHANGES_SSE_RETRY_BASE_MS", "3000"))

_stream_slots = asyncio.Semaphore(_MAX_CONCURRENT_STREAMS)


class ChangeManifest(BaseModel):
    """Topic → version. Absent topics are 0."""

    topics: dict[str, int] = Field(default_factory=dict)


@router.get(
    "",
    response_model=ChangeManifest,
    summary="Version counters for everything this session subscribes to",
)
async def get_change_manifest(
    topics: Optional[str] = Query(
        default=None,
        description=(
            "Comma-separated subset to return. Can only narrow the set "
            "this session is entitled to; unknown or forbidden names are "
            "dropped silently."
        ),
    ),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> ChangeManifest:
    # ``ws_available=False`` means no source could answer what this
    # session may see — not that it may see nothing. Answering 200 with a
    # partial manifest would present as "realtime quietly stopped
    # working"; 503 says what is true and the client retries. This
    # matches what ``requires`` and ``GET /me/permissions`` already do.
    if not claims.ws_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session claims unavailable; retry shortly.",
            headers={"Retry-After": "5"},
        )

    allowed = change_topics.topics_for_user(str(user.id))
    requested = (
        [t.strip() for t in topics.split(",") if t.strip()]
        if topics is not None
        else None
    )
    wanted = change_topics.narrow(allowed, requested)

    try:
        versions = await get_registry().snapshot(wanted)
    except Exception:
        # The registry raises rather than reporting zeros, because zeros
        # would read as "everything changed" and every client would
        # refetch everything — the worst possible response to a backend
        # that is already unwell.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Change registry unavailable; retry shortly.",
            headers={"Retry-After": "5"},
        )

    return ChangeManifest(topics=versions)


def _frame(event: str, data: dict) -> bytes:
    return (
        f"event: {event}\n"
        f"data: {json.dumps(data, separators=(',', ':'))}\n\n"
    ).encode("utf-8")


@router.get(
    "/stream",
    summary="Server-Sent Events stream of change notifications",
)
async def stream_changes(
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
):
    """Push ``{topic, version}`` as things change, instead of being asked.

    The client still owns correctness: it reconciles against
    ``GET /api/v1/changes`` on connect, on every ``resync``, and whenever
    it reconnects. That is what lets this stream be lossy — and lossy is
    what lets it be cheap, because nothing here has to be durable,
    ordered, or acknowledged.
    """
    if not claims.ws_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session claims unavailable; retry shortly.",
            headers={"Retry-After": "5"},
        )

    hub = get_hub()
    # Check readiness here rather than trusting the app-level gate: the
    # SSE bypass in _TimeoutMiddleware returns BEFORE the readiness gate,
    # so this handler is reachable while the process is still starting —
    # which is precisely when 300 clients are reconnecting into a rolling
    # deploy.
    if not hub.ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Change hub is starting; retry shortly.",
            headers={"Retry-After": "5"},
        )

    try:
        await asyncio.wait_for(_stream_slots.acquire(), timeout=0.05)
    except (asyncio.TimeoutError, TimeoutError):
        # Refusing costs the client nothing but liveliness: it falls back
        # to polling the manifest, which is still one request for every
        # surface it owns.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Too many streams on this process; retry shortly.",
            headers={"Retry-After": "10"},
        )

    topics = change_topics.topics_for_user(str(user.id))
    subscriber = hub.subscribe(topics)
    deadline = time.monotonic() + _MAX_STREAM_SECONDS
    retry_ms = _RETRY_BASE_MS + random.randint(0, _RETRY_BASE_MS)

    async def _frames():
        try:
            # Per-connection reconnect hint, jittered. Sent first so the
            # browser has it even if the connection dies immediately.
            yield f"retry: {retry_ms}\n\n".encode("utf-8")
            # ~2KB of padding. `X-Accel-Buffering: no` handles nginx, but
            # an intermediary that buffers on byte count rather than
            # honouring that header would otherwise hold the whole stream
            # until it had enough bytes to bother forwarding.
            yield (": " + " " * 2048 + "\n\n").encode("utf-8")

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Planned end of life. Say so, so the client reconnects
                    # deliberately (with a fresh cookie) instead of treating
                    # it as an error.
                    yield _frame("reauth", {"reason": "max-lifetime"})
                    return

                woken = await subscriber.wait(
                    timeout=min(_HEARTBEAT_SECONDS, remaining)
                )
                if await request.is_disconnected():
                    return
                if not woken:
                    yield b": hb\n\n"
                    continue

                pending, needs_resync = subscriber.drain()
                if needs_resync:
                    # We cannot prove what was missed, so we do not guess:
                    # the client re-reads the manifest, which is
                    # authoritative.
                    yield _frame("resync", {})
                if pending:
                    yield _frame("changed", {"topics": pending})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("change stream error: %s", exc, exc_info=True)
            yield _frame("error", {"detail": "stream error"})
        finally:
            # Both in ``finally``: the common exit is the client going
            # away, which arrives as GeneratorExit rather than a return.
            # Anything on the happy path only would leak a subscriber and
            # a slot per closed tab until the process had neither.
            hub.unsubscribe(subscriber)
            _stream_slots.release()

    return StreamingResponse(
        _frames(),
        media_type="text/event-stream",
        headers={
            # ``no-cache`` is mandatory on SSE; nginx and friends will
            # otherwise buffer the entire response. ``X-Accel-Buffering``
            # disables proxy_buffering specifically so frames flow within
            # sub-second latency.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
