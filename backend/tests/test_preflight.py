"""
Wire-level tests for ``redis_ping_preflight``.

These tests stand up a fake asyncio TCP server that records the bytes the
preflight sends and replies with whatever the test wants, so the AUTH wire
form is verified directly. No real FalkorDB required.

The auth-wire-form assertion is the regression guard: preflight must send
the same AUTH form the production pool sends, otherwise onboarding's
"test connection" green-lights configurations that the first real query
cannot use.
"""
from __future__ import annotations

import asyncio
import pytest

from backend.common.interfaces.preflight import redis_ping_preflight


class _FakeRedis:
    """Minimal asyncio TCP server that records the first AUTH and PING it
    sees and replies with scripted lines. Closes after one client.
    """

    def __init__(self, *, auth_reply: bytes = b"+OK\r\n", ping_reply: bytes = b"+PONG\r\n"):
        self.auth_reply = auth_reply
        self.ping_reply = ping_reply
        self.received: bytes = b""
        self._server: asyncio.base_events.Server | None = None
        self.host = "127.0.0.1"
        self.port = 0

    async def start(self):
        self._server = await asyncio.start_server(self._handle, self.host, 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self):
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read until we have at least one full RESP command. We don't
            # implement a real RESP parser — we just keep reading and reply
            # to AUTH then PING in order.
            saw_auth = False
            while True:
                # Read a chunk; bail when client closes or after PING reply.
                data = await reader.read(4096)
                if not data:
                    return
                self.received += data
                if not saw_auth and b"AUTH" in self.received:
                    writer.write(self.auth_reply)
                    await writer.drain()
                    saw_auth = True
                if b"PING" in self.received:
                    writer.write(self.ping_reply)
                    await writer.drain()
                    return
        except (ConnectionResetError, BrokenPipeError):
            return
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


@pytest.fixture
async def fake_redis():
    server = _FakeRedis()
    await server.start()
    try:
        yield server
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_preflight_sends_acl_auth_form_when_username_and_password_set(fake_redis):
    """``username`` + ``password`` MUST produce ``AUTH <user> <pw>`` wire form
    (RESP array of 3). This is the form the production pool sends, so
    preflight must send it too.
    """
    result = await redis_ping_preflight(
        fake_redis.host, fake_redis.port,
        deadline_s=2.0,
        username="myuser",
        password="mypass",
    )

    assert result.ok, f"preflight failed: {result.reason}"
    expected_auth = (
        b"*3\r\n$4\r\nAUTH\r\n"
        b"$6\r\nmyuser\r\n"
        b"$6\r\nmypass\r\n"
    )
    assert expected_auth in fake_redis.received, (
        f"Expected ACL AUTH form not found. Received: {fake_redis.received!r}"
    )


@pytest.mark.asyncio
async def test_preflight_sends_legacy_auth_form_when_only_password_set(fake_redis):
    """``password`` only MUST produce ``AUTH <pw>`` wire form (RESP array of 2),
    matching the legacy ``requirepass`` form. No regression on this path.
    """
    result = await redis_ping_preflight(
        fake_redis.host, fake_redis.port,
        deadline_s=2.0,
        password="mypass",
    )

    assert result.ok, f"preflight failed: {result.reason}"
    legacy_auth = b"*2\r\n$4\r\nAUTH\r\n$6\r\nmypass\r\n"
    assert legacy_auth in fake_redis.received, (
        f"Expected legacy AUTH form not found. Received: {fake_redis.received!r}"
    )
    # Make sure we did NOT send the ACL form.
    assert b"*3\r\n$4\r\nAUTH" not in fake_redis.received


@pytest.mark.asyncio
async def test_preflight_skips_auth_when_no_credentials(fake_redis):
    """No credentials configured → preflight must not send AUTH at all."""
    result = await redis_ping_preflight(
        fake_redis.host, fake_redis.port,
        deadline_s=2.0,
    )

    assert result.ok, f"preflight failed: {result.reason}"
    assert b"AUTH" not in fake_redis.received


@pytest.mark.asyncio
async def test_preflight_surfaces_auth_rejection_as_failure():
    """Server returns ``-WRONGPASS`` to AUTH → preflight must return a
    failure result (not a success), so onboarding's test-connection step
    surfaces the auth problem instead of letting it slip past.

    This is the regression guard for the original bug: previously the
    preflight discarded the AUTH reply and only checked PING, so a
    ``requirepass``-only server that rejected ``AUTH <user> <pw>`` could
    still leave PING in a state that read as success.
    """
    server = _FakeRedis(
        auth_reply=b"-WRONGPASS invalid username-password pair or user is disabled.\r\n",
    )
    await server.start()
    try:
        result = await redis_ping_preflight(
            server.host, server.port,
            deadline_s=2.0,
            username="bogus",
            password="bogus",
        )
    finally:
        await server.stop()

    assert not result.ok
    assert "WRONGPASS" in result.reason or "invalid username" in result.reason
