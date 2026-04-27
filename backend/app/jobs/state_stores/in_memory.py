"""In-memory live state store for tests.

Mirrors the Redis HSET semantics minus TTL expiration (tests run
synchronously; TTLs would just add timing flakiness)."""
from __future__ import annotations

from typing import Mapping, Optional


class InMemoryLiveStateStore:
    """Per-process state map. Threading-naive — tests run on a single
    asyncio loop; production never uses this."""

    def __init__(self) -> None:
        self._snapshots: dict[str, dict[str, str]] = {}

    async def set(
        self,
        job_id: str,
        fields: Mapping[str, str | int | float],
        ttl_secs: int,  # noqa: ARG002 — TTLs ignored; tests don't need them
    ) -> None:
        snap = self._snapshots.setdefault(job_id, {})
        for k, v in fields.items():
            snap[k] = str(v)

    async def get(self, job_id: str) -> Optional[dict[str, str]]:
        snap = self._snapshots.get(job_id)
        return dict(snap) if snap is not None else None

    async def delete(self, job_id: str) -> None:
        self._snapshots.pop(job_id, None)
