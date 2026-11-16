"""Each process's copy of a domain's setting rows: read once, then only what changed.

As ``build_policy`` memoizes its policy (``_GEN_KEY``, ``_GEN_CHECK_S``, ``_MEMO``) and
``route_cache`` its routes, a process keeps the rows (:class:`Snapshot`) and trusts them while the
domain's generation in Redis (``settings:gen:<domain>``, which every save moves) is the one it read:

* the generation is asked at most every two seconds; when it has moved, the rows written since the
  last read are reloaded (``rev > :last``), never the whole domain again;
* a strict read (a setting that must never be stale) asks at once;
* with Redis out of reach, the rows are reloaded every 30 seconds, and every 30 seconds anyway, in
  case a save could not move the generation;
* with the database out of reach, the last rows keep serving (the code defaults before any were
  read), the failure is logged, and the next try waits 30 seconds. :attr:`Snapshot.readable` says
  so meanwhile, for a setting the registry marks ``unreadable="skip"``.

The clock, the generation reader and the loader are injected, for tests. :meth:`Snapshot.current`
is the sync read (no IO, as ``build_policy.current``); :meth:`Snapshot.rows` the async one.
:func:`env_reader` reads the deployment's environment as the app's config parsed it, for the
resolver.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence

from backend.app.config.settings_types import DeploymentFact, Setting

from . import store
from .resolver import EnvReader, EnvReading, Row, RowKey

logger = logging.getLogger(__name__)

#: How often a snapshot asks Redis whether a save moved the generation.
GEN_CHECK_S = 2.0
#: The longest rows are trusted without asking the database: with Redis out of reach, or after a
#: save that could not move the generation. Also the wait after the database failed a reload.
RELOAD_S = 30.0
#: The longest a generation read waits on Redis.
_GEN_WAIT_S = 0.2

#: ``(domain, rev)`` → the rows written after ``rev``; every row when ``rev`` is None.
Loader = Callable[[str, Optional[int]], Awaitable[List[Row]]]
#: ``domain`` → its generation (``""`` before any save moved it); None when Redis can't say.
GenerationReader = Callable[[str], Awaitable[Optional[str]]]


async def load_rows(domain: str, after: Optional[int]) -> List[Row]:
    """Rows from the management database, on its READONLY pool."""
    from backend.app.db.engine import get_readonly_session

    async with get_readonly_session() as session:
        if after is None:
            return await store.read_domain(session, domain)
        return await store.read_since(session, domain, after)


async def read_generation(domain: str) -> Optional[str]:
    """The domain's generation in Redis; None when Redis can't say."""
    try:
        gen = await asyncio.wait_for(store._redis().get(store.generation_key(domain)),
                                     timeout=_GEN_WAIT_S)
    except Exception:  # noqa: BLE001 — without Redis the 30-second reload bounds staleness
        return None
    if isinstance(gen, bytes):
        gen = gen.decode()
    return "" if gen is None else str(gen)


class Snapshot:
    """One domain's rows, as this process last read them."""

    def __init__(self, domain: str, *, loader: Loader = load_rows,
                 generation: GenerationReader = read_generation,
                 clock: Callable[[], float] = time.monotonic):
        self.domain = domain
        self._load, self._generation, self._clock = loader, generation, clock
        self._rows: Dict[RowKey, Row] = {}
        self._rev = 0
        self._gen: Optional[str] = None
        self._loaded = False
        self._failed = False
        self._checked_at = self._loaded_at = self._retry_at = -math.inf
        self._loop: Any = None
        self._lock: Optional[asyncio.Lock] = None

    @property
    def rev(self) -> int:
        """The highest ``rev`` read: the rows written after it are what a reload asks for."""
        return self._rev

    @property
    def readable(self) -> bool:
        """Whether the rows are the database's as last asked: False before the first read, and
        after a read failed until one succeeds, while the last rows (or the defaults) serve."""
        return self._loaded and not self._failed

    def current(self) -> Mapping[RowKey, Row]:
        """The rows as last read, by ``(key, scope, scope_id)``, without IO: for a path that can't
        wait on a read. Empty before the first read, so the defaults apply."""
        return self._rows

    async def rows(self, *, strict: bool = False) -> Mapping[RowKey, Row]:
        """The rows, after a check of the generation when one is due — at once when ``strict``."""
        await self.refresh(strict=strict)
        return self._rows

    def _due(self, now: float, strict: bool) -> bool:
        return strict or not self._loaded or now - self._checked_at >= GEN_CHECK_S

    def _lock_here(self) -> asyncio.Lock:
        """One check at a time; the lock is the running loop's (a test's next loop gets its own)."""
        loop = asyncio.get_running_loop()
        if self._loop is not loop or self._lock is None:
            self._loop, self._lock = loop, asyncio.Lock()
        return self._lock

    async def refresh(self, *, strict: bool = False) -> None:
        """Ask the generation if a check is due, and reload what changed if it moved."""
        arrived = self._clock()
        if not self._due(arrived, strict):
            return
        async with self._lock_here():
            now = self._clock()
            if self._checked_at > arrived or not self._due(now, strict):
                return                  # another caller checked while this one waited
            gen = await self._generation(self.domain)
            self._checked_at = now
            if self._loaded and now - self._loaded_at < RELOAD_S and (
                    gen == self._gen if gen is not None else not strict):
                return
            if now < self._retry_at:
                return                  # the database failed lately: the last rows keep serving
            await self._reload(gen, now)

    async def _reload(self, gen: Optional[str], now: float) -> None:
        try:
            rows = await self._load(self.domain, self._rev if self._loaded else None)
        except Exception as exc:  # noqa: BLE001 — a settings read never fails its caller
            self._retry_at, self._failed = now + RELOAD_S, True
            logger.warning("settings: %s could not be read (%s); %s for %.0f s", self.domain, exc,
                           "keeping the last rows read" if self._loaded else "using the defaults",
                           RELOAD_S)
            return
        if rows or not self._loaded:
            merged = dict(self._rows)           # a new mapping: a reader keeps the one it holds
            for row in rows:
                merged[(row.key, row.scope, row.scope_id)] = row
                self._rev = max(self._rev, row.rev)
            self._rows = merged
        self._gen, self._loaded, self._loaded_at, self._failed = gen, True, now, False


_SNAPSHOTS: Dict[str, Snapshot] = {}


def snapshot(domain: Optional[str] = None) -> Snapshot:
    """This process's snapshot of ``domain``: the versioned-graph settings' by default."""
    if domain is None:
        from . import registry

        domain = registry().DOMAIN
    if domain not in _SNAPSHOTS:
        _SNAPSHOTS[domain] = Snapshot(domain)
    return _SNAPSHOTS[domain]


def env_reader(settings: Sequence[Setting], deployment: Sequence[DeploymentFact] = ()
               ) -> EnvReader:
    """The deployment's environment variables the registry names (its settings' defaults, its
    deployment facts), each as the app's config parsed it (``versioning.config.<attr>``, read when
    asked, so a change to config shows), or as the raw text for one config doesn't read."""
    from backend.app.services.versioning import config

    attrs = {s.default.env: s.default.attr for s in settings if s.default.env}
    attrs.update({d.env: d.attr for d in deployment if d.attr})

    def read(name: str) -> Optional[EnvReading]:
        attr = attrs.get(name)
        if attr is not None and hasattr(config, attr):
            return EnvReading(name, getattr(config, attr), name in os.environ)
        if name in os.environ:
            return EnvReading(name, os.environ[name], True)
        return None

    return read
