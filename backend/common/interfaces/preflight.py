"""
Provider preflight — fast, deadline-bounded reachability probe.

The contract every graph provider's preflight must satisfy:

    1. Wall-clock bounded by ``deadline_s + 200ms`` (asyncio scheduling slack).
    2. Returns a ``PreflightResult`` for connectivity outcomes — never raises
       for network / DNS / TCP failures. Raises only for programmer errors.
    3. Cancellation-clean: cancelling the task during DNS / TCP / TLS / app-
       level handshake leaves zero orphan tasks and zero leaked sockets.
    4. Does NOT touch the production driver pool or run schema work. The
       expensive work is reserved for ``connect()`` / ``reconcile()``, which
       only run after preflight has confirmed reachability.

This module provides reusable building blocks; each provider's ``preflight``
composes the appropriate strategy with its own (host, port, credentials).
"""
from __future__ import annotations

import asyncio
import logging
import socket
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PreflightResult:
    ok: bool
    reason: str
    elapsed_ms: int
    peer: str | None = None

    @classmethod
    def success(cls, peer: str, elapsed_ms: int) -> "PreflightResult":
        return cls(ok=True, reason="ok", elapsed_ms=elapsed_ms, peer=peer)

    @classmethod
    def failure(cls, reason: str, elapsed_ms: int) -> "PreflightResult":
        return cls(ok=False, reason=reason, elapsed_ms=elapsed_ms, peer=None)


def _classify(exc: BaseException) -> str:
    """Return a short reason code for common preflight failures.

    Concrete codes — these flow into metrics/logs and the user-facing
    test-result error string. Keep them stable: dashboards key off them.
    """
    if isinstance(exc, asyncio.TimeoutError) or isinstance(exc, TimeoutError):
        return "connect_timeout"
    if isinstance(exc, socket.gaierror):
        return "dns_unresolvable"
    if isinstance(exc, ConnectionRefusedError):
        return "tcp_refused"
    if isinstance(exc, OSError):
        # No route to host, network unreachable, etc.
        return f"os_error: {exc.strerror or exc!r}"[:120]
    return f"error: {type(exc).__name__}: {exc!s}"[:120]


async def tcp_preflight(host: str, port: int, *, deadline_s: float) -> PreflightResult:
    """Open a TCP connection to ``host:port`` within ``deadline_s`` seconds
    and immediately close it. Returns a Result; never raises for connectivity
    failure.

    Use this for backends where reachability is sufficient (no app-level
    handshake required, or the handshake is trivially expensive to verify
    elsewhere).
    """
    t0 = time.monotonic()
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=deadline_s,
        )
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return PreflightResult.success(peer=f"{host}:{port}", elapsed_ms=elapsed_ms)
    except asyncio.CancelledError:
        # Cancellation hygiene — propagate, don't dress up as a Result.
        raise
    except BaseException as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return PreflightResult.failure(reason=_classify(exc), elapsed_ms=elapsed_ms)
    finally:
        if writer is not None:
            try:
                writer.close()
                # wait_closed can hang on a half-open socket — bound it.
                await asyncio.wait_for(writer.wait_closed(), timeout=0.25)
            except (asyncio.TimeoutError, Exception):
                # Best-effort close; nothing to do if the peer is unresponsive.
                pass


def _redis_auth_reason(line: bytes, *, had_password: bool) -> str | None:
    """Classify a RESP ``-`` error reply into a stable auth reason code.

    Returns ``"auth_required"`` (server requires authentication but none was
    provided), ``"auth_failed"`` (credentials were rejected), or ``None`` when
    the error is not an auth problem (the caller may then continue or surface a
    generic ``redis_error``). These codes flow into the test-result string and
    the frontend maps them to distinct, user-clear messages.
    """
    upper = line.decode(errors="replace").strip().upper()
    if "NOAUTH" in upper:
        # NOAUTH with a password sent = the AUTH didn't stick (rejected);
        # without a password = the server requires auth we never supplied.
        return "auth_failed" if had_password else "auth_required"
    if (
        "WRONGPASS" in upper
        or "INVALID USERNAME-PASSWORD" in upper
        or "INVALID PASSWORD" in upper
    ):
        return "auth_failed"
    return None


async def redis_ping_preflight(
    host: str, port: int, *, deadline_s: float, password: str | None = None
) -> PreflightResult:
    """TCP-connect + send RESP ``PING`` + read the reply within
    ``deadline_s``. Confirms the peer is actually a Redis-protocol server,
    not just a port that happens to accept TCP.

    Used by FalkorDB (which speaks Redis protocol) and any other
    Redis-compatible backend.
    """
    t0 = time.monotonic()
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=deadline_s,
        )

        had_password = bool(password)
        # AUTH first if a password is configured. Inspect the reply: a
        # credential-rejection error (-WRONGPASS / invalid username-password)
        # means the creds are wrong → ``auth_failed``. A non-credential error
        # (e.g. the server has no auth set and rejects an unexpected AUTH) is
        # ignored — we fall through to PING, preserving the old behavior.
        if password:
            pw = password.encode()
            auth = b"*2\r\n$4\r\nAUTH\r\n$" + str(len(pw)).encode() + b"\r\n" + pw + b"\r\n"
            writer.write(auth)
            await writer.drain()
            # Read just enough to clear the reply line. Bound by remaining budget.
            remaining = max(0.05, deadline_s - (time.monotonic() - t0))
            auth_reply = await asyncio.wait_for(reader.readline(), timeout=remaining)
            if auth_reply and auth_reply.startswith(b"-"):
                reason = _redis_auth_reason(auth_reply, had_password=True)
                if reason is not None:
                    elapsed_ms = int((time.monotonic() - t0) * 1000)
                    return PreflightResult.failure(reason=reason, elapsed_ms=elapsed_ms)

        writer.write(b"*1\r\n$4\r\nPING\r\n")
        await writer.drain()

        remaining = max(0.05, deadline_s - (time.monotonic() - t0))
        line = await asyncio.wait_for(reader.readline(), timeout=remaining)
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        # Accept +PONG (no auth) or +OK as "the server is alive". An error
        # reply is classified: NOAUTH without a password = ``auth_required``
        # (server requires auth, none given); NOAUTH/WRONGPASS with a password
        # = ``auth_failed`` (rejected); any other error = generic
        # ``redis_error`` with the raw text for debugging.
        if not line:
            return PreflightResult.failure(
                reason="empty_reply", elapsed_ms=elapsed_ms,
            )
        if line.startswith(b"-"):
            reason = _redis_auth_reason(line, had_password=had_password)
            if reason is None:
                reason = f"redis_error: {line.decode(errors='replace').strip()}"[:120]
            return PreflightResult.failure(reason=reason, elapsed_ms=elapsed_ms)
        return PreflightResult.success(peer=f"{host}:{port}", elapsed_ms=elapsed_ms)

    except asyncio.CancelledError:
        raise
    except BaseException as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return PreflightResult.failure(reason=_classify(exc), elapsed_ms=elapsed_ms)
    finally:
        if writer is not None:
            try:
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=0.25)
            except (asyncio.TimeoutError, Exception):
                pass


async def http_head_preflight(
    url: str, *, deadline_s: float, headers: dict | None = None,
) -> PreflightResult:
    """Issue an HTTP HEAD against ``url`` within ``deadline_s``. Any reply
    with a status code (200, 401, 404, etc.) counts as reachable; only
    transport-level failures (DNS, TCP, TLS, timeout) count as failure.
    """
    t0 = time.monotonic()
    try:
        import httpx  # local import — DataHub-only dep
    except ImportError:
        return PreflightResult.failure(
            reason="httpx_not_installed", elapsed_ms=0,
        )
    try:
        async with httpx.AsyncClient(timeout=deadline_s, follow_redirects=False) as client:
            response = await client.head(url, headers=headers or {})
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return PreflightResult.success(
            peer=str(response.url), elapsed_ms=elapsed_ms,
        )
    except asyncio.CancelledError:
        raise
    except BaseException as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return PreflightResult.failure(reason=_classify(exc), elapsed_ms=elapsed_ms)
