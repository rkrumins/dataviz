"""Which data sources are mastered by the versioning store.

Lives at the app layer — NOT inside the versioning package, and NOT inside
``services/aggregation`` — for the same reason :mod:`projection_target` does: it
bridges two stores that deliberately do not know about each other. The graphver
store keeps no foreign keys into ``public`` and the aggregation domain never
touches ``graphver``; this module is the one place that reads across.

Why anything needs to ask. A versioned graph inverts the assumption the
aggregation reconciliation sweep is built on. Postgres is the source of truth
and FalkorDB is a *rebuildable read cache* of committed ``main``, so when the
projection is not fresh — LRU eviction under a RAM budget, a repoint, an
unfaithful-seed hold — the stats scan runs against Postgres, which carries no
``:AGGREGATED`` rows by construction. Every overlay-integrity signal reads as a
wiped overlay for a perfectly healthy source. The sweep guards those sources out
(``reconcile._guard`` → ``platform_mastered``) and needs this to know which
they are.

``workspace_data_sources.source_mode`` cannot answer it: ``'managed'`` is
written only by the blank-model wizard and a one-off script, never by the
bootstrap path that versions an existing source, so most versioned sources have
it NULL. A live ``graphver.graphs`` row is the definitive signal.

The read follows the shape ``insights_service.discovery`` already established
for this store — lazy imports, its own engine, never joined into a
management-pool query. ``graphs`` is a control-plane table (low cardinality, not
partitioned) with a unique index on ``data_source_id``, so fetching the whole
set costs one indexed scan and removes any dependence on the caller's candidate
list. A source becomes versioned once and stays versioned, so the result is
cached generously.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import FrozenSet, Optional

logger = logging.getLogger(__name__)

# A source becomes versioned at bootstrap and stays versioned. Ten minutes of
# staleness costs at most one sweep evaluating a brand-new versioned source as
# if it were externally mastered.
CACHE_TTL_SECS = 600

_cache: Optional[FrozenSet[str]] = None
_cache_at: float = 0.0


class VersionedLookupUnavailable(RuntimeError):
    """The graphver store could not be read and nothing is cached.

    Raised rather than swallowed because both fail-open answers are wrong:
    treating everything as externally mastered loses the guard, and treating
    everything as versioned silently stops reconciling the fleet. The caller
    defers instead.
    """


async def versioned_data_source_ids(
    *, ttl_secs: int = CACHE_TTL_SECS,
) -> FrozenSet[str]:
    """Every data source with a live versioned graph.

    Serves the cache while it is fresh, and keeps serving it if a refresh
    fails — a blip must not flip the fleet's classification. Raises
    :class:`VersionedLookupUnavailable` only on a cold failure, i.e. when there
    is no previous answer to stand on.
    """
    global _cache, _cache_at

    now = time.monotonic()
    if _cache is not None and (now - _cache_at) < ttl_secs:
        return _cache

    try:
        from sqlalchemy import select

        from backend.app.services.versioning.db import get_session_factory
        from backend.app.services.versioning.models import GraphORM

        async with get_session_factory()() as session:
            rows = await session.execute(
                select(GraphORM.data_source_id).where(
                    GraphORM.deleted_at.is_(None)
                )
            )
        found = frozenset(r[0] for r in rows.all() if r[0])
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if _cache is not None:
            # Serve the previous answer. The set changes only when a source is
            # versioned or unversioned, so a stale read is very nearly always
            # still correct.
            logger.warning(
                "versioned data-source lookup failed, reusing the cached set "
                "(%d entries): %s", len(_cache), exc,
            )
            return _cache
        raise VersionedLookupUnavailable(str(exc)) from exc

    _cache, _cache_at = found, now
    return found


def reset_cache() -> None:
    """Drop the cached set — used by tests, and after a deliberate
    bootstrap/unversion when the TTL is too long to wait out."""
    global _cache, _cache_at
    _cache, _cache_at = None, 0.0
