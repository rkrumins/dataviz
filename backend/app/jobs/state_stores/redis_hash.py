"""Redis-HSET-backed live snapshot store.

Default :class:`backend.app.jobs.state_store.LiveStateStore`
implementation. Pairs naturally with
:class:`backend.app.jobs.brokers.redis_streams.RedisStreamsJobBroker`
since both live in the same Redis instance — but the two are
deliberately separate concerns (the user's clarification: swap
brokers freely; state cache stays Redis).

Wire shape:

* ``HSET job:state:{id} field1 value1 field2 value2 ...``
* ``EXPIRE job:state:{id} TTL`` (refreshed on every set)
* On terminal: ``DEL job:state:{id}``
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from ..redis_keys import state_key

logger = logging.getLogger(__name__)


class RedisHashLiveStateStore:
    """Redis HSET implementation of :class:`LiveStateStore`."""

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def set(
        self,
        job_id: str,
        fields: Mapping[str, str | int | float],
        ttl_secs: int,
    ) -> None:
        if not fields:
            return
        key = state_key(job_id)
        # Coerce all values to str — HSET accepts str/bytes; numeric
        # values round-trip cleanly on read because the consumer
        # parses fields by name (typed deserialization on the client
        # side).
        flat: list[str] = []
        for k, v in fields.items():
            flat.append(k)
            flat.append(str(v))
        pipe = self._redis.pipeline(transaction=False)
        pipe.execute_command("HSET", key, *flat)
        pipe.execute_command("EXPIRE", key, str(ttl_secs))
        await pipe.execute()

    async def get(self, job_id: str) -> Optional[dict[str, str]]:
        key = state_key(job_id)
        raw = await self._redis.hgetall(key)
        if not raw:
            return None
        # Redis returns bytes by default; normalise.
        return {
            (k.decode() if isinstance(k, (bytes, bytearray)) else k):
            (v.decode() if isinstance(v, (bytes, bytearray)) else v)
            for k, v in raw.items()
        }

    async def delete(self, job_id: str) -> None:
        await self._redis.delete(state_key(job_id))
