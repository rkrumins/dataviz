"""Prometheus metrics.

This exists because every performance claim about this application is
currently arithmetic rather than measurement — including the ones in the
plan that motivated this module. ``middleware/db_metrics.py`` already
collects per-role pool saturation and serves it as JSON, but that is one
subsystem in a format nothing scrapes, so nobody can answer "did that
change help" except by reasoning about it.

What is instrumented is only what something here actually writes to —
a metric with no writer reads as "measured, and zero", which is a worse
lie than an absent metric. Adding a counter belongs with the change it
measures, not ahead of it.

* **``synodic_db_queries_total``** — the one that matters most. Two
  known per-request taxes (the identity lookup on every authenticated
  request, and the context-engine resolution before every graph
  request) are invisible in request counts and obvious in query counts.
  Divided by the request counter below, it gives queries-per-request,
  which is the number to watch: it is how a change that removes work
  without removing requests proves it did anything.
* **``synodic_http_requests_total``** — by route template, so removing a
  poller shows up as a named line going quiet.
* **``synodic_change_feed_subscribers``** and
  **``synodic_db_pool_utilisation``** — the two live gauges: held stream
  connections (the thing that replaces the polls) and how close each
  pool is to its ceiling.

## Multiple workers

Production runs gunicorn with several worker processes behind one port,
so a scrape reaches one worker at random. Counters kept in process
memory would therefore under-report by the worker count, and worse,
would jump around between scrapes as different workers answered.

``prometheus_client`` solves this with multiprocess mode: workers write
to memory-mapped files in a shared directory and the exposition endpoint
aggregates across all of them. Set ``PROMETHEUS_MULTIPROC_DIR`` to a
writable path and it engages automatically. Without it — dev, tests, any
single-process runner — the ordinary in-process registry is used and the
numbers are still correct, just for one process. The endpoint reports
which mode is active so a reading is never ambiguous about what it
covers.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

__all__ = [
    "MULTIPROC_ENV",
    "http_requests_total",
    "db_queries_total",
    "db_pool_utilisation",
    "change_feed_subscribers",
    "build_registry",
    "multiprocess_dir",
    "metrics_enabled",
]


MULTIPROC_ENV = "PROMETHEUS_MULTIPROC_DIR"


def multiprocess_dir() -> Optional[str]:
    """The multiprocess directory, or None when running single-process."""
    value = os.getenv(MULTIPROC_ENV, "").strip()
    return value or None


def metrics_enabled() -> bool:
    """Same switch the existing JSON pool endpoint uses.

    Off by default. ``/internal/`` should additionally be restricted at
    the ingress so a scrape target is never reachable from outside the
    metrics network.
    """
    return os.getenv("INTERNAL_METRICS_ENABLED", "false").strip().lower() == "true"


# ── Metric definitions ────────────────────────────────────────────────
#
# Defined at import against the default registry. In multiprocess mode
# prometheus_client routes these to the shared directory instead, so the
# same definitions work either way and nothing here needs to branch.

from prometheus_client import Counter, Gauge  # noqa: E402


http_requests_total = Counter(
    "synodic_http_requests_total",
    "HTTP requests served, by route template and outcome.",
    ["method", "route", "status"],
)

db_queries_total = Counter(
    "synodic_db_queries_total",
    "Statements executed against the management database, by pool role.",
    ["role"],
)

change_feed_subscribers = Gauge(
    "synodic_change_feed_subscribers",
    "Change-feed stream connections currently attached to this process.",
    # Summed across workers rather than reported per worker: the useful
    # question is how many connections the fleet is holding, and a
    # scrape that returned one worker's share would understate it by the
    # worker count.
    multiprocess_mode="livesum",
)

db_pool_utilisation = Gauge(
    "synodic_db_pool_utilisation",
    "Fraction of a connection pool's capacity currently checked out.",
    ["role"],
    # The worst *live* worker, not the average: one saturating pool is an
    # incident even when the others are idle, and averaging hides it.
    #
    # "livemax" rather than "max" because this gauge describes a current
    # value. Plain "max" aggregates dead workers' files too, so a worker
    # that once peaked at 0.95 before being recycled would pin the
    # reading at 0.95 for the life of the directory — the gauge would
    # stop being "how saturated are the pools now" and quietly become
    # "how saturated has any pool ever been".
    multiprocess_mode="livemax",
)


def build_registry():
    """The registry to serve a scrape from.

    In multiprocess mode this is a fresh registry with a collector that
    reads every worker's files — deliberately built per request, because
    the set of live workers changes as gunicorn recycles them.
    """
    from prometheus_client import CollectorRegistry, REGISTRY

    directory = multiprocess_dir()
    if directory is None:
        return REGISTRY

    from prometheus_client import multiprocess

    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry, path=directory)
    return registry
