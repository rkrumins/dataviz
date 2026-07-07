"""Tests for redis_ping_preflight auth classification.

Distinguishes "server requires auth, none provided" (auth_required) from
"credentials rejected" (auth_failed), and stays regression-safe: a no-auth
server that rejects an unexpected AUTH still proceeds to PING and succeeds.

Drives the real preflight against a tiny in-process asyncio server scripted
to emit canned RESP replies.
"""
import asyncio

import pytest

from backend.common.interfaces.preflight import redis_ping_preflight


async def _run_preflight(replies: list[bytes], *, password=None):
    """Start a server that emits ``replies`` in order, then run preflight."""
    async def handle(reader, writer):
        writer.write(b"".join(replies))
        await writer.drain()
        try:
            # Give the client time to read its reply line(s) before close.
            await asyncio.sleep(0.2)
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        return await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=1.0, password=password,
        )


@pytest.mark.asyncio
async def test_no_password_server_requires_auth_is_auth_required():
    res = await _run_preflight([b"-NOAUTH Authentication required.\r\n"])
    assert res.ok is False
    assert res.reason == "auth_required"


@pytest.mark.asyncio
async def test_wrong_password_is_auth_failed():
    res = await _run_preflight(
        [b"-WRONGPASS invalid username-password pair\r\n", b"+PONG\r\n"],
        password="bad",
    )
    assert res.ok is False
    assert res.reason == "auth_failed"


@pytest.mark.asyncio
async def test_noauth_after_password_is_auth_failed():
    # AUTH replied +OK but the session is still unauthenticated → PING NOAUTH.
    res = await _run_preflight(
        [b"+OK\r\n", b"-NOAUTH Authentication required.\r\n"],
        password="x",
    )
    assert res.ok is False
    assert res.reason == "auth_failed"


@pytest.mark.asyncio
async def test_password_to_noauth_server_still_succeeds():
    # Regression guard: a server with no auth set rejects the unexpected AUTH
    # with a non-credential -ERR; preflight must ignore it and PING-succeed.
    res = await _run_preflight(
        [b"-ERR Client sent AUTH, but no password is set.\r\n", b"+PONG\r\n"],
        password="x",
    )
    assert res.ok is True


@pytest.mark.asyncio
async def test_plain_pong_succeeds():
    res = await _run_preflight([b"+PONG\r\n"])
    assert res.ok is True


@pytest.mark.asyncio
async def test_other_error_stays_generic_redis_error():
    res = await _run_preflight([b"-ERR unknown command\r\n"])
    assert res.ok is False
    assert res.reason.startswith("redis_error:")


@pytest.mark.asyncio
async def test_two_arg_auth_sent_when_username_set():
    """Redis 6 ACL named users need RESP `AUTH <user> <pass>` (3-element)."""
    received = {}

    async def handle(reader, writer):
        received["bytes"] = await reader.read(128)  # the AUTH command
        writer.write(b"+OK\r\n+PONG\r\n")
        await writer.drain()
        await asyncio.sleep(0.1)
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        res = await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=1.0, username="alice", password="pw",
        )
    assert res.ok is True
    assert b"*3" in received["bytes"]      # 3-element array → AUTH user pass
    assert b"alice" in received["bytes"]
