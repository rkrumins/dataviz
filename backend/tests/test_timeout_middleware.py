"""
P0.1 — TimeoutMiddleware response-stream invariants.

These tests pin the contract that fixes the "never recovers" freeze:

    T-1  Exactly one terminal http.response.body (more_body=False) per request.
    T-2  Timeout-after-response-started → emit closing empty body chunk.
    T-3  Timeout-after-response-completed → emit nothing further.
    T-4  send is never called after a terminal body chunk.
    T-5  asyncio.timeout (not wait_for) drives cancellation cleanly.
    T-6  First state transition wins; subsequent are no-ops.

Without this contract, a single timeout poisons the keepalive connection
with `RuntimeError: No response returned` and `Response content shorter than
Content-Length`, and the backend ratchets toward an unrecoverable state.

The tests exercise the middleware as raw ASGI — no FastAPI / TestClient —
so failures pinpoint the contract, not the framework around it.
"""
import asyncio
import os

import pytest

from backend.app.main import _TimeoutMiddleware


# ── ASGI helpers ─────────────────────────────────────────────────────


def _http_scope(path: str = "/api/v1/health") -> dict:
    return {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }


class _Receiver:
    """Minimal ASGI receive callable — yields a single http.disconnect on
    a long delay so handlers that await receive() do not return prematurely.
    """

    def __init__(self) -> None:
        self._called = False

    async def __call__(self) -> dict:
        if self._called:
            # Block forever so a handler awaiting receive() does not race.
            await asyncio.Event().wait()
        self._called = True
        return {"type": "http.request", "body": b"", "more_body": False}


class _Sink:
    """Records every ASGI message sent through it. Lets tests assert on
    the exact wire output the middleware produces."""

    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def __call__(self, message: dict) -> None:
        # Defensive copy so test mutations don't corrupt history.
        self.messages.append(dict(message))

    @property
    def started(self) -> bool:
        return any(m["type"] == "http.response.start" for m in self.messages)

    @property
    def status(self) -> int | None:
        for m in self.messages:
            if m["type"] == "http.response.start":
                return m["status"]
        return None

    @property
    def terminal_chunks(self) -> int:
        return sum(
            1
            for m in self.messages
            if m["type"] == "http.response.body" and not m.get("more_body", False)
        )

    @property
    def total_body(self) -> bytes:
        return b"".join(
            m.get("body", b"")
            for m in self.messages
            if m["type"] == "http.response.body"
        )


# ── Inner-app factories ──────────────────────────────────────────────


def _instant_app(status: int = 200, body: bytes = b"ok") -> object:
    """Inner app that returns immediately — happy path."""

    async def app(scope, receive, send):
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain")],
        })
        await send({"type": "http.response.body", "body": body, "more_body": False})

    return app


def _slow_before_start_app(delay: float) -> object:
    """Inner app that sleeps before sending anything. Models a handler
    blocked on a slow upstream BEFORE writing the response."""

    async def app(scope, receive, send):
        await asyncio.sleep(delay)
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        })
        await send({"type": "http.response.body", "body": b"late", "more_body": False})

    return app


def _slow_after_start_app(delay: float, partial_body: bytes = b"partial-") -> object:
    """Inner app that emits start + a partial body chunk, then hangs.
    Models a streaming response stalled after headers were sent."""

    async def app(scope, receive, send):
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        })
        await send({
            "type": "http.response.body",
            "body": partial_body,
            "more_body": True,
        })
        # Hang.
        await asyncio.sleep(delay)
        # This terminal chunk should never be reached because the timeout
        # cancels the inner task first.
        await send({"type": "http.response.body", "body": b"end", "more_body": False})

    return app


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _short_timeouts(monkeypatch):
    """Use 200ms timeouts so tests run fast. The middleware reads env
    vars at construction; we set them BEFORE building the middleware."""
    monkeypatch.setenv("HTTP_TIMEOUT_HEALTH_SECS", "0.2")
    monkeypatch.setenv("HTTP_TIMEOUT_GRAPH_SECS", "0.2")
    monkeypatch.setenv("HTTP_TIMEOUT_AGGREGATION_SECS", "0.2")
    monkeypatch.setenv("HTTP_TIMEOUT_DEFAULT_SECS", "0.2")


# ── Tests ────────────────────────────────────────────────────────────


async def test_happy_path_passes_through_unchanged():
    """Sanity: a fast inner app produces exactly the messages it sent."""
    mw = _TimeoutMiddleware(_instant_app(status=200, body=b"hello"))
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    assert sink.status == 200
    assert sink.total_body == b"hello"
    assert sink.terminal_chunks == 1


async def test_timeout_before_response_started_emits_504():
    """T-2 (clean case): handler hangs before sending anything → 504."""
    mw = _TimeoutMiddleware(_slow_before_start_app(delay=2.0))
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    assert sink.status == 504
    assert sink.terminal_chunks == 1
    body_text = sink.total_body.decode()
    assert "timed out" in body_text.lower()


async def test_timeout_after_response_started_emits_closing_chunk():
    """T-2 (stream-corruption case): the bug we are actually fixing.

    Before the fix: ASGI stream was left half-open, uvicorn raised
    'Response content shorter than Content-Length', BaseHTTPMiddleware
    raised 'No response returned' upstream.

    After the fix: middleware emits a final empty body chunk so the ASGI
    contract is satisfied; the wire response is truncated but well-formed.
    """
    mw = _TimeoutMiddleware(_slow_after_start_app(delay=2.0))
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    # Inner app's http.response.start was forwarded.
    assert sink.started
    assert sink.status == 200

    # Exactly one terminal body chunk total — the partial chunk had
    # more_body=True, the inner app's planned final chunk never ran,
    # and our middleware emitted exactly one closing empty chunk.
    assert sink.terminal_chunks == 1, (
        f"Expected exactly 1 terminal chunk; got {sink.terminal_chunks}. "
        f"Messages: {sink.messages}"
    )

    # The terminal chunk must be empty body, more_body=False.
    terminal = next(
        m for m in sink.messages
        if m["type"] == "http.response.body" and not m.get("more_body", False)
    )
    assert terminal.get("body", b"") == b""

    # The partial body chunk from the inner app must have been forwarded.
    assert b"partial-" in sink.total_body


async def test_handler_completes_just_before_timeout_no_double_send():
    """T-3: inner app finishes successfully — middleware must not emit
    any extra chunks even if timing is tight."""
    mw = _TimeoutMiddleware(_instant_app(status=201, body=b"created"))
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    assert sink.status == 201
    assert sink.total_body == b"created"
    assert sink.terminal_chunks == 1


async def test_send_after_terminal_is_dropped():
    """T-4: if the inner app emits ANY further send after a terminal
    body chunk, ``tracked_send`` must drop it silently. This protects
    the wire from a misbehaving handler emitting two terminators."""

    async def double_terminal_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"a", "more_body": False})
        # Bug: emits a second terminal — should be dropped by tracked_send.
        await send({"type": "http.response.body", "body": b"b", "more_body": False})

    mw = _TimeoutMiddleware(double_terminal_app)
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    assert sink.terminal_chunks == 1
    # Only the first body chunk reached the wire.
    assert sink.total_body == b"a"


async def test_no_runtime_error_no_response_returned_under_repeated_timeouts():
    """The original incident: repeated timeouts cascaded into the wider
    middleware chain. Run 200 forced-timeout requests through the
    middleware and assert no exceptions escape."""
    mw = _TimeoutMiddleware(_slow_after_start_app(delay=2.0))

    errors = []
    for _ in range(200):
        sink = _Sink()
        try:
            await mw(_http_scope(), _Receiver(), sink)
        except Exception as exc:  # pragma: no cover - any raise is a regression
            errors.append(repr(exc))
        else:
            # Each timed-out request must still yield exactly one terminal chunk.
            assert sink.terminal_chunks == 1

    assert not errors, f"Middleware raised {len(errors)} times: {errors[:3]}"


async def test_sse_path_bypasses_timeout():
    """SSE bypass: long-lived /events streams must not be cancelled."""

    completed = asyncio.Event()

    async def long_stream_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        # A stream slower than the timeout — must not be cut off.
        await asyncio.sleep(0.5)  # > 0.2s default timeout
        await send({"type": "http.response.body", "body": b"event1\n", "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        completed.set()

    mw = _TimeoutMiddleware(long_stream_app)
    sink = _Sink()
    await mw(_http_scope("/api/v1/views/events"), _Receiver(), sink)

    assert completed.is_set(), "SSE stream was cut off by the timeout middleware"
    assert sink.terminal_chunks == 1


async def test_non_http_scope_passes_through():
    """Lifespan / websocket / etc must not be touched by the HTTP-only
    timeout — call the inner app directly."""
    called = []

    async def app(scope, receive, send):
        called.append(scope["type"])

    mw = _TimeoutMiddleware(app)
    await mw({"type": "lifespan"}, _Receiver(), _Sink())
    await mw({"type": "websocket", "path": "/ws"}, _Receiver(), _Sink())

    assert called == ["lifespan", "websocket"]


async def test_inner_app_exception_propagates():
    """A non-timeout exception from the inner app must propagate
    unchanged — the middleware is a deadline enforcer, not an error
    swallower."""

    class _InnerBoom(RuntimeError):
        pass

    async def boom_app(scope, receive, send):
        raise _InnerBoom("inner exploded")

    mw = _TimeoutMiddleware(boom_app)
    with pytest.raises(_InnerBoom, match="inner exploded"):
        await mw(_http_scope(), _Receiver(), _Sink())


async def test_no_orphan_tasks_after_timeout():
    """T-5: ``asyncio.timeout()`` cancels the inner task cleanly. After
    the middleware returns, no pending tasks should remain from this
    request's processing."""
    baseline = {t for t in asyncio.all_tasks() if not t.done()}

    mw = _TimeoutMiddleware(_slow_after_start_app(delay=10.0))
    sink = _Sink()
    await mw(_http_scope(), _Receiver(), sink)

    # Give the loop a tick to finalize cancellation.
    await asyncio.sleep(0.05)

    after = {t for t in asyncio.all_tasks() if not t.done()}
    leaked = after - baseline - {asyncio.current_task()}
    assert not leaked, f"Orphan tasks after timeout: {[t.get_name() for t in leaked]}"
