"""Turning text into vectors, robustly.

* **Batched** — ``AI_EMBED_BATCH_SIZE`` inputs per call.
* **Retried** — a rate limit, timeout or 5xx is retried with backoff, up to
  three times per batch.
* **Breaker** — after three failures in a row the embedder stops trying for a
  minute; meanwhile queries rank lexically and syncs wait, rather than every
  question paying a timeout.
* **Cached** — query embeddings, per model, in a small in-process LRU: the same
  question asked twice is embedded once.
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Optional

from ..llm.types import LlmError

_BREAKER_FAILURES = 3
_BREAKER_SECONDS = 60.0
_CACHE_SIZE = 512


class EmbedderUnavailable(Exception):
    pass


class Embedder:
    def __init__(self, provider, *, model: str, dimensions: Optional[int], batch_size: int = 64,
                 sleep=asyncio.sleep, clock=time.monotonic) -> None:
        self._provider = provider
        self.model = model
        self.dimensions = dimensions
        self._batch = max(1, batch_size)
        self._sleep = sleep
        self._clock = clock
        self._failures = 0
        self._open_until = 0.0
        self._cache: OrderedDict[str, list[float]] = OrderedDict()

    @property
    def available(self) -> bool:
        return self._clock() >= self._open_until

    async def _call(self, texts: list[str]) -> list[list[float]]:
        if not self.available:
            raise EmbedderUnavailable("The embedding model is failing; retrying shortly.")
        delay = 1.0
        for attempt in range(3):
            try:
                vectors = await self._provider.embed(texts, dimensions=self.dimensions)
            except LlmError as exc:
                if exc.retryable and attempt < 2:
                    await self._sleep(exc.retry_after or delay)
                    delay *= 2
                    continue
                self._failures += 1
                if self._failures >= _BREAKER_FAILURES:
                    self._open_until = self._clock() + _BREAKER_SECONDS
                raise EmbedderUnavailable(str(exc)) from exc
            self._failures = 0
            if self.dimensions is None and vectors:
                self.dimensions = len(vectors[0])
            return vectors
        raise EmbedderUnavailable("The embedding model did not answer.")

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self._batch):
            out.extend(await self._call(texts[i:i + self._batch]))
        return out

    async def embed_query(self, text: str) -> list[float]:
        key = f"{self.model}\x1f{text.strip().lower()}"
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        vector = (await self._call([text]))[0]
        self._cache[key] = vector
        if len(self._cache) > _CACHE_SIZE:
            self._cache.popitem(last=False)
        return vector
