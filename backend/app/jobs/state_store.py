"""``LiveStateStore`` Protocol — the live-snapshot KV cache.

The job platform separates two concerns:

* **Event log** (``JobBroker``) — append-only, swappable across
  Redis / Kafka / Pub/Sub / NATS.
* **Live snapshot** (``LiveStateStore``) — last-write-wins KV cache.
  Per the user's clarification, this **is not** in the swappability
  scope: it's a cache, not transport. Redis is the natural fit.

We define the interface anyway so:

* Tests can use a fake without spinning Redis.
* Future Memcached / managed cache adopters have a target.
* The boundary stays clean — `JobEmitter` writes through this
  interface, never through ``redis.hset`` directly.
"""
from __future__ import annotations

from typing import Mapping, Optional, Protocol


__all__ = ["LiveStateStore"]


class LiveStateStore(Protocol):
    """Last-write-wins per-job snapshot for the live UI overlay.

    The contract is intentionally minimal: set, get, delete, with a
    TTL on set so abandoned entries decay. No atomic compare-and-set,
    no pub-sub semantics — those belong to the broker.
    """

    async def set(
        self,
        job_id: str,
        fields: Mapping[str, str | int | float],
        ttl_secs: int,
    ) -> None:
        """Replace the snapshot for ``job_id`` with ``fields``.

        Implementations should set or refresh a TTL of ``ttl_secs``.
        Field values are coerced to strings for transport (Redis HSET
        semantics); typed deserialization is the caller's
        responsibility.

        Idempotent under concurrent writes — last writer wins. The
        platform's monotonic ``sequence`` discipline means this
        rarely matters in practice.
        """
        ...

    async def get(self, job_id: str) -> Optional[dict[str, str]]:
        """Read the current snapshot. Returns ``None`` when no
        snapshot exists (job never started, or already TTL'd out)."""
        ...

    async def delete(self, job_id: str) -> None:
        """Drop the snapshot. Called on terminal events to free the
        cache key immediately rather than waiting for TTL. Idempotent
        — deleting an absent key is a no-op."""
        ...
