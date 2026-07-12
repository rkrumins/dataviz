"""Cross-process provider invalidation.

An admin edit (`PUT /providers/{id}`) runs in ONE web pod. Everything a provider
edit must invalidate is per-process state:

  * ``ProviderManager._providers``          — cached read instances (per pod)
  * ``falkor_graph_registry._RESOLVED``     — memoized provider → FalkorDBConnConfig
  * ``falkordb_connection._GRAPH_CLIENTS``  — the topology-aware client cache

…and the aggregation worker, the versioning worker and every other web replica hold
their OWN copies. Nothing in the local eviction path reaches them, and no self-heal
covers it either: the warmup recovery eviction fires only on a false→true transition,
and after a repoint the OLD host is usually still reachable — so no transition ever
happens and the other processes keep reading and WRITING the old instance, with the
old credentials, until they are restarted.

This publishes the edit on the job-bus Redis (the same bus and pattern as the
aggregation cancel bridge) so every process drops its caches within a second. It is
best-effort by design: the bus being down must never fail an admin edit, and a missed
message costs staleness, not correctness — the next restart or provider edit re-syncs.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

PROVIDER_CONTROL_CHANNEL = "provider.control"


async def publish_provider_invalidation(provider_id: str, redis_client: Any = None) -> None:
    """Tell every process to drop its caches for ``provider_id``. Never raises."""
    try:
        if redis_client is None:
            from backend.app.services.aggregation.redis_client import get_redis

            redis_client = get_redis()
        await redis_client.publish(
            PROVIDER_CONTROL_CHANNEL,
            json.dumps({"action": "invalidate", "provider_id": provider_id}),
        )
        logger.info(
            "Published provider invalidation for %s on %s",
            provider_id, PROVIDER_CONTROL_CHANNEL,
        )
    except Exception as exc:                         # pragma: no cover - infra
        logger.warning(
            "Failed to publish provider invalidation for %s (local eviction still "
            "applied; other processes stay stale until restart): %s",
            provider_id, exc,
        )


async def apply_local_invalidation(provider_id: str, provider_manager: Any = None) -> None:
    """Drop this process's caches for ``provider_id``: the read instances, the
    registry's memoized config, and every graph client built from it."""
    from backend.app.providers.falkor_graph_registry import invalidate_provider

    if provider_manager is not None:
        try:
            # Local-only: evict_provider would re-publish and we'd loop forever.
            await provider_manager.evict_provider(provider_id, _broadcast=False)
        except Exception as exc:                     # pragma: no cover - best effort
            logger.warning("Local provider eviction failed for %s: %s", provider_id, exc)
    await invalidate_provider(provider_id)


class ProviderInvalidationListener:
    """Subscribes to the provider control channel and applies invalidations locally.

    Started by every process that caches providers: the web tier, the aggregation
    worker and the versioning worker. Self-healing: reconnects with backoff, so a
    Redis blip can't leave it permanently deaf.
    """

    def __init__(self, redis_client: Any = None, provider_manager: Any = None,
                 redis_factory: Optional[Any] = None):
        self._redis = redis_client
        self._redis_factory = redis_factory
        self._provider_manager = provider_manager
        self._pubsub = None
        self._task: Optional[asyncio.Task] = None
        self._shutdown = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(
            self._run_loop(), name="provider-invalidation-listener",
        )
        logger.info(
            "Provider invalidation listener started on channel %s",
            PROVIDER_CONTROL_CHANNEL,
        )

    async def stop(self) -> None:
        self._shutdown.set()
        if self._pubsub is not None:
            try:
                await self._pubsub.unsubscribe(PROVIDER_CONTROL_CHANNEL)
                await self._pubsub.aclose()
            except Exception:                        # pragma: no cover - best effort
                pass
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    async def _run_loop(self) -> None:
        backoff = 1.0
        while not self._shutdown.is_set():
            try:
                if self._redis is None:
                    if self._redis_factory is not None:
                        self._redis = self._redis_factory()
                    else:
                        from backend.app.services.aggregation.redis_client import get_redis

                        self._redis = get_redis()
                self._pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
                await self._pubsub.subscribe(PROVIDER_CONTROL_CHANNEL)
                backoff = 1.0
                async for message in self._pubsub.listen():
                    if self._shutdown.is_set():
                        break
                    if not message or message.get("type") != "message":
                        continue
                    try:
                        payload = json.loads(message["data"])
                        provider_id = payload.get("provider_id")
                        if payload.get("action") == "invalidate" and provider_id:
                            await apply_local_invalidation(
                                provider_id, self._provider_manager,
                            )
                            logger.info(
                                "Applied cross-process invalidation for provider %s",
                                provider_id,
                            )
                    except Exception as exc:         # pragma: no cover - defensive
                        logger.warning("Bad provider control message: %s", exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:                 # pragma: no cover - infra
                if self._shutdown.is_set():
                    return
                logger.warning(
                    "Provider invalidation listener error: %s — reconnecting in %.0fs",
                    exc, backoff,
                )
                self._redis = None
                try:
                    await asyncio.wait_for(self._shutdown.wait(), timeout=backoff)
                    return
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)
