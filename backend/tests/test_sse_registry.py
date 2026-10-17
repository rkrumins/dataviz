"""The SSE path registry, and the two properties that depend on it.

Streaming routes have to be exempt from the request-deadline middleware,
because a stream is open for as long as its client is listening. The
middleware used to decide membership with ``path.endswith("/events")``,
which is a guess about naming rather than a statement about behaviour.
It guessed wrong in the direction that matters: ``POST
/api/v1/telemetry/events`` is an ordinary JSON write, and it ran with no
timeout and no readiness gate purely because of what it was called.

These tests pin the replacement — explicit registration — and the
adjacent property nobody declares anywhere: that a ``text/event-stream``
response is not swallowed by the compression middleware.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.common import sse_registry


@pytest.fixture
def registry():
    """A clean registry, restored afterwards.

    Production registrations happen at module import time, so a test that
    cleared the registry and left it cleared would un-register the real
    streams for everything that ran after it.
    """
    saved = sse_registry.registered_sse_paths()
    sse_registry.reset_for_testing()
    yield sse_registry
    sse_registry.reset_for_testing()
    for path in saved:
        sse_registry.register_sse_path(path)


def test_exact_path_matches(registry):
    registry.register_sse_path("/api/v1/changes/stream")
    assert registry.is_sse_path("/api/v1/changes/stream")
    assert not registry.is_sse_path("/api/v1/changes")


def test_template_matches_concrete_ids(registry):
    """The middleware sees real ids, not the route template."""
    registry.register_sse_path("/api/v1/admin/jobs/{job_id}/events")
    assert registry.is_sse_path("/api/v1/admin/jobs/agg_7f3a/events")
    assert registry.is_sse_path("/api/v1/admin/jobs/x/events")


def test_template_segment_does_not_span_slashes(registry):
    """``{job_id}`` is one segment, not a wildcard.

    With ``.+`` instead of ``[^/]+`` this template would also match
    ``/api/v1/admin/jobs/a/b/c/events`` and quietly re-introduce the
    over-matching that explicit registration exists to remove.
    """
    registry.register_sse_path("/api/v1/admin/jobs/{job_id}/events")
    assert not registry.is_sse_path("/api/v1/admin/jobs/a/b/c/events")


def test_unregistered_events_suffix_is_not_a_stream(registry):
    """The telemetry bug, stated as a test."""
    registry.register_sse_path("/api/v1/admin/jobs/{job_id}/events")
    assert not registry.is_sse_path("/api/v1/telemetry/events")


def test_registration_is_idempotent(registry):
    registry.register_sse_path("/api/v1/changes/stream")
    registry.register_sse_path("/api/v1/changes/stream")
    assert registry.registered_sse_paths() == ("/api/v1/changes/stream",)


def test_production_streams_are_registered():
    """Whatever else moves, the real streams must stay declared.

    Importing ``main`` pulls in the routers, which register their own
    paths beside their handlers.
    """
    import backend.app.main  # noqa: F401

    assert sse_registry.is_sse_path(
        "/api/v1/admin/data-sources/ds_1/aggregation-jobs/agg_1/events"
    ), "the aggregation job stream lost its registration"


async def test_event_stream_response_is_not_compressed():
    """A ``text/event-stream`` body must reach the client unbuffered.

    Compression and streaming are in direct tension: a gzip encoder
    accumulates small writes in its internal buffer and emits nothing
    until it has enough to be worth a block. A change feed that is silent
    except for a periodic heartbeat would deliver those heartbeats late
    or not at all — and it would look fine in any test that only asserts
    the bytes eventually arrive.

    Starlette excludes ``text/event-stream`` from GZipMiddleware by
    default, so this holds today. It is asserted rather than assumed
    because the guarantee lives in a transitive dependency that this repo
    does not pin: ``requirements.txt`` pins ``fastapi>=0.141.1`` with no
    upper bound and no starlette line at all. If a future resolve lands a
    version without that exclusion, or someone passes an explicit
    ``exclude_content_types``, this is the test that says so.
    """
    from starlette.applications import Starlette
    from starlette.middleware.gzip import GZipMiddleware
    from starlette.responses import StreamingResponse
    from starlette.routing import Route

    frame = b'data: {"topic":"announcements","version":1}\n\n'

    async def stream(request):
        async def frames():
            for _ in range(3):
                yield frame

        return StreamingResponse(frames(), media_type="text/event-stream")

    app = Starlette(routes=[Route("/sse", stream)])
    # Same configuration as backend/app/main.py.
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=1)

    start: dict = {}
    chunks: list[bytes] = []
    inbound = [
        {"type": "http.request", "body": b"", "more_body": False},
        {"type": "http.disconnect"},
    ]

    async def receive():
        return inbound.pop(0) if inbound else {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            start.update(dict(message["headers"]))
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await app(
        {
            "type": "http",
            "method": "GET",
            "path": "/sse",
            "query_string": b"",
            # The browser always asks for compression; that request is
            # what the middleware acts on.
            "headers": [(b"accept-encoding", b"gzip, deflate, br")],
            "app": app,
        },
        receive,
        send,
    )

    assert b"content-encoding" not in start, (
        "SSE response was compressed — frames will sit in the encoder's "
        "buffer instead of reaching the client"
    )
    # Each frame arrives whole and on its own, not coalesced into one
    # block at the end.
    assert [c for c in chunks if c] == [frame, frame, frame]
