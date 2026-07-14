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
    if (
        "WITHOUT ANY PASSWORD CONFIGURED" in upper
        or "CLIENT SENT AUTH, BUT NO PASSWORD IS SET" in upper
    ):
        # We sent credentials to an instance that has NO auth configured. Not a
        # failure: the graph is reachable. The connection layer drops the stale
        # credentials and reconnects (see falkordb_connection.with_auth_negotiation);
        # the probe reports the instance as healthy so a leftover password on a
        # provider row can't show a working graph as down.
        return "auth_not_configured"
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


# Preflight reasons that mean "the instance ANSWERED, but the graph credentials
# are missing/wrong" — i.e. reachable-but-misconfigured, NOT an outage. A caller
# deciding whether to gate/pre-trip a provider MUST treat these differently from a
# real unreachability (tcp_refused, dns, timeout): the network path works, only the
# config is wrong, so blocking behind a breaker would keep the provider down even
# after the operator fixes the credentials. ``auth_not_configured`` is NOT here —
# the preflight already treats it as healthy (it falls through to PING).
AUTH_REACHABLE_REASONS = ("auth_required", "auth_failed")


def is_auth_reachable_reason(reason: str | None) -> bool:
    """True when a preflight failure reason means reachable-but-misconfigured
    (missing/wrong graph auth), rather than a genuine outage."""
    if not reason:
        return False
    r = reason.strip().lower()
    return any(m in r for m in AUTH_REACHABLE_REASONS)


def _resp_auth(username: str | None, password: str) -> bytes:
    """RESP-encode ``AUTH [username] password``. The two-arg form is required
    for Redis 6+ ACL named users; the one-arg form targets the default user."""
    pw = password.encode()
    if username:
        u = username.encode()
        return (
            b"*3\r\n$4\r\nAUTH\r\n"
            b"$" + str(len(u)).encode() + b"\r\n" + u + b"\r\n"
            b"$" + str(len(pw)).encode() + b"\r\n" + pw + b"\r\n"
        )
    return b"*2\r\n$4\r\nAUTH\r\n$" + str(len(pw)).encode() + b"\r\n" + pw + b"\r\n"


async def redis_ping_preflight(
    host: str,
    port: int,
    *,
    deadline_s: float,
    password: str | None = None,
    username: str | None = None,
    ssl_context: "ssl.SSLContext | None" = None,
) -> PreflightResult:
    """TCP(/TLS)-connect + send RESP ``PING`` + read the reply within
    ``deadline_s``. Confirms the peer is actually a Redis-protocol server,
    not just a port that happens to accept TCP.

    When ``ssl_context`` is provided the probe completes a real TLS handshake
    (so a TLS-only server isn't wrongly marked unreachable). When ``username``
    is provided the two-arg ``AUTH user pass`` is used (Redis 6 ACL users).

    Used by FalkorDB (which speaks Redis protocol) and any other
    Redis-compatible backend.
    """
    t0 = time.monotonic()
    writer = None
    try:
        open_kwargs: dict = {}
        if ssl_context is not None:
            open_kwargs = {"ssl": ssl_context, "server_hostname": host}
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, **open_kwargs),
            timeout=deadline_s,
        )

        had_password = bool(password)
        # AUTH first if a password is configured. Inspect the reply: a
        # credential-rejection error (-WRONGPASS / invalid username-password)
        # means the creds are wrong → ``auth_failed``. A non-credential error
        # (e.g. the server has no auth set and rejects an unexpected AUTH) is
        # ignored — we fall through to PING, preserving the old behavior.
        if password:
            auth = _resp_auth(username, password)
            writer.write(auth)
            await writer.drain()
            # Read just enough to clear the reply line. Bound by remaining budget.
            remaining = max(0.05, deadline_s - (time.monotonic() - t0))
            auth_reply = await asyncio.wait_for(reader.readline(), timeout=remaining)
            if auth_reply and auth_reply.startswith(b"-"):
                reason = _redis_auth_reason(auth_reply, had_password=True)
                # "auth_not_configured" = we sent credentials to an instance that has
                # none. The instance is REACHABLE — fall through to PING and report it
                # healthy (the connection layer drops the stale credentials). Failing
                # here would show a working graph as down over a leftover password.
                if reason is not None and reason != "auth_not_configured":
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
