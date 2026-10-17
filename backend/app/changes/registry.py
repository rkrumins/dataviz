"""Version counters for the change feed.

One integer per topic. ``bump`` advances it; ``snapshot`` reads a batch
of them in a single round trip. That is the entire data model, and its
smallness is the point: the expensive question ("what is this resource
now?") is still answered by the endpoint that already answers it, and
this only replaces the part clients were re-asking on a timer — "has it
moved?", to which the answer is almost always no.

**Counters are advisory, and clients must be written to tolerate that.**
A bump is fire-and-forget: if Redis is unreachable the mutation still
succeeds and the notification is simply lost, because the alternative —
failing a write because a cache-invalidation hint could not be sent — is
worse than a client being briefly stale. The REST endpoints remain the
source of truth and clients keep a slow reconciliation poll, so a lost
bump costs latency, never correctness.

Two consequences worth stating, because both have bitten this pattern
elsewhere:

* **Compare versions with ``!=``, not ``>``.** A counter can go
  backwards. Keys carry a TTL (so they are evictable under the
  ``volatile-lru`` policy this deployment runs) and a missing key reads
  as 0, so a client holding 4000 must treat 0 as "changed" and refetch.
  With ``>`` it would wait forever.

* **Bump after the transaction commits, never inside it.** Several write
  paths only ``flush()`` and leave the commit to their caller. A bump
  that races the commit tells the client to refetch, the client reads
  the pre-commit state, records the new version, and then never refetches
  again — a permanently stale client with no error anywhere.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable, Optional, Protocol

logger = logging.getLogger(__name__)

__all__ = ["ChangeRegistry", "get_registry", "reset_for_testing", "version_key"]


_KEY_PREFIX = os.getenv("CHANGES_REDIS_KEY_PREFIX", "changes")

TTL_SECONDS: int = int(os.getenv("CHANGES_VERSION_TTL_SECONDS", str(30 * 24 * 3600)))
"""How long a counter lives without being bumped. 30 days.

A TTL is not housekeeping here, it is a requirement: this deployment
runs Redis with ``--maxmemory-policy volatile-lru``, which can only
evict keys that have one. Counters without a TTL would be un-evictable
and, under pressure, would push Redis into refusing writes rather than
shedding the most disposable thing it holds. Expiry is harmless — a
missing counter reads as 0 and costs one reconciling refetch.
"""


STREAM_MAXLEN: int = int(os.getenv("CHANGES_STREAM_MAXLEN", "1000"))
"""Cap on the fan-out stream. Truncation is safe here in a way it is not
for an event log: a consumer that falls behind far enough to lose entries
re-reads the manifest, which is the authoritative state anyway. The
stream is a wake-up, not a record."""


def version_key(topic: str) -> str:
    """Redis key holding ``topic``'s counter."""
    return f"{_KEY_PREFIX}:v:{topic}"


def stream_key() -> str:
    """The single fan-out stream every process tails.

    One stream, not one per topic. Subscribers filter by topic in-process
    after reading, because the alternative — a stream per topic, or per
    user — would mean one Redis read operation per topic per process, and
    the whole point of the hub is that Redis work is O(processes) rather
    than O(clients x topics). Total volume here is a handful of entries a
    minute across the fleet.
    """
    return f"{_KEY_PREFIX}:stream"


class ChangeRegistry(Protocol):
    """The swappable seam. Redis in production, in-memory in tests."""

    async def bump(self, topic: str) -> Optional[int]:
        """Advance ``topic``'s version. Returns the new value, or None if
        the backend could not be reached — callers ignore the result."""
        ...

    async def snapshot(self, topics: Iterable[str]) -> dict[str, int]:
        """Read many counters in one round trip. Unknown topics read 0."""
        ...


class RedisChangeRegistry:
    """Redis implementation: ``INCR`` plus a TTL refresh, ``MGET`` to read."""

    def __init__(self, redis_client) -> None:
        self._redis = redis_client

    async def bump(self, topic: str) -> Optional[int]:
        key = version_key(topic)
        try:
            # INCR, refresh the TTL, and announce on the fan-out stream —
            # one round trip. The stream carries the new version so a
            # subscriber can act on the entry alone, without a follow-up
            # read to find out what it now is.
            pipe = self._redis.pipeline(transaction=False)
            pipe.incr(key)
            pipe.expire(key, TTL_SECONDS)
            result = await pipe.execute()
            version = int(result[0])
            await self._redis.execute_command(
                "XADD", stream_key(),
                "MAXLEN", "~", str(STREAM_MAXLEN),
                "*", "topic", topic, "version", str(version),
            )
            return version
        except Exception as exc:
            # Deliberately swallowed. The caller has already committed a
            # real state change; refusing to return from a write because
            # a notification hint failed would turn a Redis blip into an
            # outage. Clients reconcile on their own cadence.
            logger.warning("change bump failed for topic %r: %s", topic, exc)
            return None

    async def snapshot(self, topics: Iterable[str]) -> dict[str, int]:
        names = list(topics)
        if not names:
            return {}
        try:
            values = await self._redis.mget([version_key(t) for t in names])
        except Exception as exc:
            # Answering "everything is at 0" would be a lie that clients
            # would act on — every topic would look changed, and the
            # refetch storm would land exactly when Redis is already
            # unwell. Let the caller decide (the endpoint answers 503).
            logger.warning("change snapshot failed: %s", exc)
            raise
        return {
            topic: int(raw) if raw is not None else 0
            for topic, raw in zip(names, values)
        }


class InMemoryChangeRegistry:
    """Process-local implementation for tests.

    Correct only within one process, which is exactly why it is not a
    production option: prod runs 8 web processes and a bump in one would
    be invisible to clients attached to the other 7.
    """

    def __init__(self) -> None:
        self._versions: dict[str, int] = {}

    async def bump(self, topic: str) -> Optional[int]:
        self._versions[topic] = self._versions.get(topic, 0) + 1
        return self._versions[topic]

    async def snapshot(self, topics: Iterable[str]) -> dict[str, int]:
        return {topic: self._versions.get(topic, 0) for topic in topics}


_registry: Optional[ChangeRegistry] = None


def _build_registry() -> ChangeRegistry:
    backend = os.getenv("CHANGE_REGISTRY_BACKEND", "redis").strip().lower()
    if backend == "redis":
        from backend.app.services.aggregation.redis_client import get_redis

        return RedisChangeRegistry(get_redis())
    if backend == "in_memory":
        return InMemoryChangeRegistry()
    raise ValueError(
        f"Unknown CHANGE_REGISTRY_BACKEND={backend!r}. "
        f"Supported: redis, in_memory."
    )


def get_registry() -> ChangeRegistry:
    """Return the process-wide registry singleton."""
    global _registry
    if _registry is None:
        _registry = _build_registry()
        logger.info(
            "Change registry initialised: backend=%s",
            os.getenv("CHANGE_REGISTRY_BACKEND", "redis"),
        )
    return _registry


def reset_for_testing() -> None:
    """Drop the singleton so the next call re-reads the env. Tests only."""
    global _registry
    _registry = None
