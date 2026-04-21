"""Transparent timeout proxy for async Redis clients.

Wraps a ``redis.asyncio.Redis`` instance so that **every** async method call
and every ``pipeline().execute()`` is bounded by ``asyncio.wait_for()``.

This is the Redis equivalent of :class:`CircuitBreakerProxy` — a transparent
``__getattr__``-based proxy that applies a policy (timeout) to every outbound
call without requiring call-site changes.  Consumers use ``self._redis.hget()``,
``pipe.execute()``, etc. as normal; the timeout is enforced automatically.

Why a proxy instead of per-call wrapping
----------------------------------------
* **Enforced by default** — new Redis calls automatically get timeout
  protection.  Developers cannot forget to wrap.
* **Zero call-site noise** — ``await self._redis.hget(key, field)`` instead
  of ``await self._redis_op(self._redis.hget(key, field))``.
* **Pipeline-aware** — ``.pipeline()`` returns a :class:`_TimeoutPipeline`
  whose ``.execute()`` is also timeout-guarded.
* **Reusable** — works for FalkorDB, Neo4j, or any future provider that
  needs Redis with timeout protection.
"""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Any

logger = logging.getLogger(__name__)


class _TimeoutPipeline:
    """Wraps a Redis pipeline so ``.execute()`` is timeout-guarded.

    Pipeline command methods (``sadd``, ``hget``, ``scard``, etc.) are
    forwarded untouched — they only queue locally. The timeout applies
    to ``.execute()`` which is the single network round-trip.
    """

    __slots__ = ("_pipeline", "_timeout")

    def __init__(self, pipeline: Any, timeout: float) -> None:
        self._pipeline = pipeline
        self._timeout = timeout

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pipeline, name)

    async def execute(self, *args: Any, **kwargs: Any) -> Any:
        """Timeout-guarded pipeline execution."""
        return await asyncio.wait_for(
            self._pipeline.execute(*args, **kwargs),
            timeout=self._timeout,
        )

    async def __aenter__(self) -> "_TimeoutPipeline":
        await self._pipeline.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._pipeline.__aexit__(*exc)

    def __repr__(self) -> str:
        return f"_TimeoutPipeline(timeout={self._timeout}s)"


class TimeoutRedis:
    """Transparent async proxy that adds ``asyncio.wait_for()`` to every
    Redis call.

    Usage::

        from redis.asyncio import Redis
        raw = Redis.from_url("redis://localhost:6379")
        redis = TimeoutRedis(raw, timeout=3.0)

        # All calls now have a 3s deadline — no wrapping needed:
        await redis.hget("key", "field")
        await redis.hset("key", "field", "value")

        pipe = redis.pipeline(transaction=False)
        pipe.sadd("set_key", "member")
        results = await pipe.execute()   # also 3s deadline

        # Cleanup — proper lifecycle method, no need to access .client:
        await redis.aclose()

    Parameters
    ----------
    client:
        The underlying ``redis.asyncio.Redis`` instance.
    timeout:
        Default per-operation deadline in seconds.
    """

    __slots__ = ("_client", "_timeout", "_method_cache")

    def __init__(self, client: Any, *, timeout: float = 3.0) -> None:
        self._client = client
        self._timeout = timeout
        # Cache wrapped methods to avoid creating a new closure on every
        # attribute access. Key = method name, value = timed wrapper.
        # This matters in hot paths (materialization loops with 5000+ calls).
        self._method_cache: dict[str, Any] = {}

    @property
    def client(self) -> Any:
        """Access the unwrapped Redis client (e.g. for diagnostics)."""
        return self._client

    # ── Lifecycle ────────────────────────────────────────────────────

    async def aclose(self) -> None:
        """Close the underlying Redis connection / pool."""
        self._method_cache.clear()
        await self._client.aclose()

    async def close(self) -> None:
        """Alias for ``aclose()`` (some Redis versions use this name)."""
        await self.aclose()

    # ── Pipeline ─────────────────────────────────────────────────────

    def pipeline(self, *args: Any, **kwargs: Any) -> _TimeoutPipeline:
        """Return a timeout-guarded pipeline."""
        return _TimeoutPipeline(
            self._client.pipeline(*args, **kwargs),
            self._timeout,
        )

    # ── Transparent forwarding ───────────────────────────────────────

    def __getattr__(self, name: str) -> Any:
        # Check the method cache first — avoids closure allocation on
        # repeated calls to the same method (e.g. hget in a loop).
        cached = self._method_cache.get(name)
        if cached is not None:
            return cached

        attr = getattr(self._client, name)

        # Non-callable attributes pass through (e.g. connection_pool).
        if not callable(attr):
            return attr

        # Sync methods pass through unwrapped.
        if not asyncio.iscoroutinefunction(attr):
            return attr

        # Build a cached, reusable async wrapper.
        timeout = self._timeout

        @functools.wraps(attr)
        async def timed_call(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.wait_for(
                attr(*args, **kwargs),
                timeout=timeout,
            )

        self._method_cache[name] = timed_call
        return timed_call

    def __repr__(self) -> str:
        return (
            f"TimeoutRedis(client={self._client!r}, "
            f"timeout={self._timeout}s, "
            f"cached_methods={len(self._method_cache)})"
        )
