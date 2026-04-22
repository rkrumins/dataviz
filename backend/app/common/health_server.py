"""
Tiny asyncio HTTP /health endpoint shared across headless worker services.

Pure stdlib — no aiohttp, no FastAPI, no extra process. Starts a TCP
listener that responds to any request with a JSON payload built by the
caller. Used by the aggregation worker and the stats service to expose
a liveness probe without pulling in a full web framework.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable

logger = logging.getLogger(__name__)


async def run_health_server(
    port: int,
    *,
    role: str,
    status_payload_fn: Callable[[], dict],
) -> asyncio.base_events.Server:
    """Start a minimal HTTP health endpoint on ``port``.

    Returns the started ``asyncio.Server`` so callers can close it at
    shutdown. ``status_payload_fn`` is invoked per request; its return
    value is merged with a baseline {status, uptime, role}.
    """
    start_time = time.monotonic()

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        except Exception:
            pass

        try:
            extra = status_payload_fn() or {}
        except Exception as exc:
            logger.warning("health payload fn raised: %s", exc)
            extra = {"payload_error": str(exc)[:200]}

        body = json.dumps(
            {
                "status": "healthy",
                "role": role,
                "uptime": int(time.monotonic() - start_time),
                **extra,
            }
        )
        response = (
            f"HTTP/1.1 200 OK\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n{body}"
        )
        try:
            writer.write(response.encode())
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_server(_handle, "0.0.0.0", port)
    logger.info("Health endpoint (%s) listening on port %d", role, port)
    return server
