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

:func:`projector_health` is the sibling that answers the *other* half of
the question — not "who masters this source" but "and is that mastering
currently working". It reads the same control plane and is cached for
seconds, not minutes; see the note above it for why the two TTLs must
differ.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Dict, FrozenSet, Optional

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


# ── Projector health ─────────────────────────────────────────────────────
# The set above answers "who masters this source". It does NOT answer "and is
# that mastering currently working", and for fourteen hours on 2026-08-30 that
# gap WAS the outage: one graph's projection wedged, ``projected_commit_seq``
# sat below ``main_head_commit_seq``, ContextEngine routed every main read
# through VersionedBranchProvider — which holds no ``:AGGREGATED`` rows —
# and aggregated lineage silently vanished from the canvas while every
# surface reported ``ready`` / ``managed``.
#
# TTL. ``versioned_data_source_ids`` caches for ten minutes because a source
# becomes versioned once and stays versioned. Health is the exact opposite: it
# changes minute to minute, and a stale HEALTHY answer is the same silence we
# are removing here. Five seconds is deliberately just long enough to collapse
# the fan-out of one fleet page render (or one sweep pass) into a single read
# and no longer.
HEALTH_CACHE_TTL_SECS = 5

_health_cache: Optional["Dict[str, ProjectorHealth]"] = None
_health_cache_at: float = 0.0


class ProjectorHealthUnavailable(RuntimeError):
    """Projector health could not be read.

    Deliberately has no fallback answer. Unlike the versioned SET — where a
    ten-minute-old value is very nearly always still correct — the only value
    we could invent here is "everything is fine", which is precisely the claim
    that hid a wedged projection for fourteen hours. Callers either defer (the
    sweep) or present the health fields as unknown (the read paths); nobody
    gets to assume healthy.
    """


@dataclass(frozen=True)
class ProjectorHealth:
    """One versioned graph's projection watermark, as of ``checked_at``.

    ``main_head_commit_seq`` is what has been published; ``projected_commit_seq``
    is what the FalkorDB read cache has actually caught up to. While the second
    trails the first, reads fall back to the version log and rolled-up
    connections are missing from the product.
    """
    data_source_id: str
    graph_id: str
    # NULL when the graph has no ``projection_state`` row at all.
    projected_commit_seq: Optional[int]
    main_head_commit_seq: Optional[int]
    last_error: Optional[str]
    # A pinned graph is one this platform actually projects into. Without a
    # pin nothing is projected BY DESIGN — reads come from Postgres because
    # that is the whole plan, not because anything is wedged. Mirrors the
    # PROJECTION_STALE finding in the alignment-analysis endpoint, which must
    # not disagree with this module about the same graph.
    falkor_graph_pinned: bool
    status: Optional[str]
    checked_at: str

    @property
    def commits_behind(self) -> int:
        """How many published commits the read cache has not caught up to.
        Zero when either number is unknown — "behind" is a claim, and an
        unknown watermark does not support it."""
        if self.projected_commit_seq is None or self.main_head_commit_seq is None:
            return 0
        return max(0, self.main_head_commit_seq - self.projected_commit_seq)

    @property
    def behind(self) -> bool:
        return self.falkor_graph_pinned and self.commits_behind > 0

    @property
    def erroring(self) -> bool:
        """The projector recorded a failure. Reported even when the watermark
        has since caught up: a projector that is erroring every pass is a
        projector whose NEXT publish will not land, and the watermark alone
        goes quiet between attempts."""
        return self.falkor_graph_pinned and bool(self.last_error)

    @property
    def stalled(self) -> bool:
        return self.behind or self.erroring

    @property
    def current(self) -> bool:
        return not self.stalled


async def projector_health(
    *, ttl_secs: int = HEALTH_CACHE_TTL_SECS,
) -> "Dict[str, ProjectorHealth]":
    """Projection health for every live versioned graph, keyed by data source.

    One indexed scan over ``graphver.graphs`` LEFT JOINed to
    ``graphver.projection_state`` — both low-cardinality control-plane tables,
    the same shape and cost as :func:`versioned_data_source_ids`.

    The join is OUTER on purpose: a versioned graph with no projection row has
    never been projected at all, which is a different fact from "behind", and
    collapsing the two would report a brand-new graph as wedged.

    Raises :class:`ProjectorHealthUnavailable` on any failure. There is no
    stale-serving and no fail-open dict — see the exception's docstring.
    """
    global _health_cache, _health_cache_at

    now = time.monotonic()
    if _health_cache is not None and (now - _health_cache_at) < ttl_secs:
        return _health_cache

    try:
        from datetime import datetime, timezone

        from sqlalchemy import select

        from backend.app.services.versioning.db import get_session_factory
        from backend.app.services.versioning.models import (
            GraphORM, ProjectionStateORM,
        )

        async with get_session_factory()() as session:
            rows = (await session.execute(
                select(
                    GraphORM.data_source_id,
                    GraphORM.id,
                    GraphORM.main_head_commit_seq,
                    ProjectionStateORM.projected_commit_seq,
                    ProjectionStateORM.last_error,
                    ProjectionStateORM.falkor_graph_name,
                    ProjectionStateORM.status,
                )
                .outerjoin(
                    ProjectionStateORM,
                    ProjectionStateORM.graph_id == GraphORM.id,
                )
                .where(GraphORM.deleted_at.is_(None))
            )).all()
        checked_at = datetime.now(timezone.utc).isoformat()
        found = {
            ds_id: ProjectorHealth(
                data_source_id=ds_id,
                graph_id=graph_id,
                projected_commit_seq=(
                    None if projected is None else int(projected)
                ),
                main_head_commit_seq=None if head is None else int(head),
                last_error=last_error or None,
                falkor_graph_pinned=bool(falkor_name),
                status=status,
                checked_at=checked_at,
            )
            for (
                ds_id, graph_id, head, projected, last_error, falkor_name,
                status,
            ) in rows
            if ds_id
        }
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("projector health lookup failed: %s", exc)
        raise ProjectorHealthUnavailable(str(exc)) from exc

    _health_cache, _health_cache_at = found, now
    return found


def reset_health_cache() -> None:
    """Drop the cached health snapshot — used by tests, and wherever a caller
    needs to observe a projection change it has just caused."""
    global _health_cache, _health_cache_at
    _health_cache, _health_cache_at = None, 0.0
