"""Precompute the Analytics documents so no reader ever builds one.

WHY THIS EXISTS
The cache was read-through: whoever arrived first after a TTL expiry paid the
full aggregation — ~25 grouped queries plus a pass over the event window — and
single-flight made everyone else wait for them. That is fine for a handful of
admins and wrong for a platform with hundreds of concurrent readers, where the
arithmetic is simply that someone eats a multi-second stall every TTL, forever,
and the busier the platform the more people are queued behind them.

So the work moves off the read path entirely. One replica recomputes the
standard windows on an interval and writes them to Redis with a TTL several
passes long; every reader gets a hit. The read-through path stays exactly as it
was and is now the FALLBACK: a cold key, a custom date range, a per-workspace
drill-in, or a deployment with no scheduler role still works, just slower.
Nothing here can break the dashboard by failing — it can only stop making it
fast.

WHAT MAKES THIS POSSIBLE
The cached document is unredacted and identical for every reader (see
`_serve` in the analytics endpoint). A per-reader document could not be
precomputed at all: there is no finite set of readers to precompute for.

EVENTUAL CONSISTENCY IS THE POINT
Numbers are up to one refresh interval old. Growth metrics are read in minutes
and acted on in weeks, so this is invisible to a human reading a 90-day trend —
and the document carries ``generatedAt``, which the UI shows, so the staleness
is stated rather than hidden.

Runs on the CONTROLPLANE/DEV role only — the same ``runs_scheduler`` gate the
outbox relay, the refresh-token sweeper and the product-event GC use. Three web
replicas each warming the same keys would be three times the work for one
result.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import analytics_repo
from backend.app.services import analytics_cache

logger = logging.getLogger(__name__)

#: The windows the range picker offers. A preset added to the picker and not
#: here is not a bug — it simply falls back to read-through, which is why this
#: list is allowed to be a plain constant rather than a shared contract.
WARM_WINDOWS: tuple[int, ...] = (7, 14, 30, 90, 180, 365)

#: The two reader-independent surfaces. The per-workspace drill-in is
#: deliberately absent: it is one document per workspace per window, which is
#: unbounded in the dimension that matters, and it is opened by one person at a
#: time rather than by everyone at once.
_SURFACES = ("summary", "workspaces")

#: How often to recompute. Long enough that the aggregation cost is negligible
#: (12 documents per pass on one replica), short enough that "as of 4 minutes
#: ago" is not a number anyone argues with.
_DEFAULT_INTERVAL_SECONDS = 300.0

#: How many epochs an entry outlives. It was three, so a warmed document
#: survived a missed pass and a stalled warmer degraded to staler numbers
#: rather than to a stampede. The epoch in the cache key ended that: at the
#: next slot the key changes and last slot's entry is unreachable however long
#: it lives, so two is slack for a write that lands late in its own slot, and
#: anything beyond that is dead keys squatting in Redis.
_TTL_MULTIPLE = 2


def interval_seconds() -> float:
    """Refresh interval, overridable per deployment."""
    raw = os.getenv("ANALYTICS_WARM_INTERVAL_SECONDS")
    if not raw:
        return _DEFAULT_INTERVAL_SECONDS
    try:
        parsed = float(raw)
    except ValueError:
        logger.warning(
            "ANALYTICS_WARM_INTERVAL_SECONDS=%r is not a number; using %.0f",
            raw, _DEFAULT_INTERVAL_SECONDS,
        )
        return _DEFAULT_INTERVAL_SECONDS
    # A very short interval turns the warmer into the load it was meant to
    # remove: each pass is ~25 grouped queries per window.
    if parsed < 30:
        logger.warning(
            "ANALYTICS_WARM_INTERVAL_SECONDS=%.0f is too aggressive; "
            "clamping to 30s.", parsed,
        )
        return 30.0
    return parsed


async def warm_once(session: AsyncSession, *, ttl: float | None = None) -> int:
    """Recompute and store every warm window. Returns how many landed.

    One surface failing does not abandon the pass. A window that raises leaves
    its previous entry in place — still servable, just older — which is
    strictly better than dropping it and sending readers back to read-through.
    """
    ttl = ttl if ttl is not None else interval_seconds() * _TTL_MULTIPLE
    stored = 0
    # ONE instant for the whole pass. Each window used to end wherever the wall
    # clock happened to be when its own aggregation finished, so the six
    # documents this writes did not agree with each other — and a 14-day figure
    # could come out smaller than the 7-day figure inside it. The epoch is in
    # the key too, so readers cannot mix a window from this pass with one from
    # the last.
    epoch = analytics_cache.epoch_start()
    for days in WARM_WINDOWS:
        args = {"days": days}
        for surface in _SURFACES:
            try:
                if surface == "summary":
                    doc = await analytics_repo.platform_summary(
                        session, scope=None, now=epoch, **args)
                else:
                    doc = await analytics_repo.workspace_rows(
                        session, scope=None, now=epoch, **args)
            except Exception as exc:  # noqa: BLE001 — one window, not the pass
                logger.warning(
                    "Analytics warm failed for %s/%dd: %s", surface, days, exc,
                    exc_info=True,
                )
                continue
            if await analytics_cache.put(
                analytics_cache.document_key(surface, args, epoch=epoch),
                doc, ttl=ttl,
            ):
                stored += 1
    return stored


def _seconds_to_boundary(grid: float) -> float:
    """How long until the next slot starts.

    The loop used to sleep a fixed interval from wherever the last pass
    finished, so its passes drifted against the absolute epoch grid: start the
    process 290 seconds into a five-minute slot and every pass thereafter warms
    a slot with ten seconds left on it, which is work nobody gets to use.

    Sleeping to the boundary phase-locks the pass to the epoch it is warming,
    so each one lands at the start of its slot with the whole slot ahead of it.
    """
    remaining = grid - (time.time() % grid)
    # Landing exactly on a boundary would otherwise spin.
    return remaining if remaining > 1.0 else remaining + grid


async def run_warmer(
    session_factory,
    shutdown: asyncio.Event,
    *,
    interval: float | None = None,
) -> None:
    """Background loop: warm until ``shutdown`` is set."""
    interval = interval if interval is not None else interval_seconds()
    ttl = interval * _TTL_MULTIPLE
    logger.info(
        "Analytics warmer started (interval=%.0fs, ttl=%.0fs, windows=%s)",
        interval, ttl, ",".join(f"{d}d" for d in WARM_WINDOWS),
    )
    # The first pass runs immediately rather than waiting for a boundary: a
    # cache that is warm now beats one that is perfectly phased in five
    # minutes. Every pass after this one is aligned.
    warned_no_redis = False
    while not shutdown.is_set():
        started = time.monotonic()
        try:
            async with session_factory() as session:
                stored = await warm_once(session, ttl=ttl)
            elapsed = time.monotonic() - started
            if stored:
                logger.info(
                    "Analytics warm pass stored %d document(s) in %.1fs",
                    stored, elapsed,
                )
            elif not warned_no_redis:
                # Nothing reached Redis. The dashboard still works — readers
                # fall back to read-through — but replicas no longer share a
                # warm copy, and an operator should know that once.
                warned_no_redis = True
                logger.warning(
                    "Analytics warm pass stored nothing; Redis is unreachable, "
                    "so readers will rebuild documents on demand.",
                )
            if stored:
                warned_no_redis = False
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop must survive blips
            logger.warning("Analytics warm pass failed: %s", exc, exc_info=True)

        try:
            await asyncio.wait_for(
                shutdown.wait(), timeout=_seconds_to_boundary(interval))
        except asyncio.TimeoutError:
            pass

    logger.info("Analytics warmer stopped")
