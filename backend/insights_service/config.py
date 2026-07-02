"""Env-sourced settings for the stats service.

All knobs are concentrated here so operators can tune the service from
one place and tests can construct a config without touching os.environ.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from backend.app.config import resilience


@dataclass(frozen=True)
class StatsServiceConfig:
    # ── Scheduler ────────────────────────────────────────────────
    scheduler_tick_secs: float
    default_interval_secs: int
    min_interval_secs: int

    # ── Worker ───────────────────────────────────────────────────
    # Per-lane concurrency budgets. ``worker_concurrency`` is the FAST
    # lane (cheap counts polls + user-initiated discovery); sweep
    # (background discovery), heavy (deep schema scans) and purge get
    # their own budgets so neither a 600s large-graph scan nor the
    # twice-hourly sweep can occupy the slots that serve user actions.
    worker_concurrency: int
    sweep_concurrency: int
    heavy_concurrency: int
    purge_concurrency: int
    max_per_graph: int
    max_delivery_attempts: int
    drain_timeout_secs: float

    # ── Poll execution (pulled from resilience.py — single source) ──
    poll_timeout_default_secs: float
    poll_timeout_large_secs: float
    poll_large_threshold: int

    # ── Redis dedup ──────────────────────────────────────────────
    dedup_ttl_secs: int

    # ── Health endpoint ──────────────────────────────────────────
    health_port: int

    @classmethod
    def from_env(cls) -> "StatsServiceConfig":
        default_dedup_ttl = int(resilience.STATS_POLL_TIMEOUT_LARGE_SECS * 2)
        return cls(
            scheduler_tick_secs=float(os.getenv("STATS_SCHEDULER_TICK_SECS", "30")),
            # 900s idle interval: counts freshness is event-driven (app
            # write paths enqueue within seconds); the interval is the
            # reconcile safety net, not the freshness mechanism.
            default_interval_secs=int(os.getenv("STATS_DEFAULT_INTERVAL_SECS", "900")),
            min_interval_secs=int(os.getenv("STATS_MIN_INTERVAL_SECS", "60")),
            worker_concurrency=int(os.getenv("STATS_WORKER_CONCURRENCY", "4")),
            sweep_concurrency=int(os.getenv("STATS_SWEEP_CONCURRENCY", "2")),
            heavy_concurrency=int(os.getenv("STATS_HEAVY_CONCURRENCY", "1")),
            purge_concurrency=int(os.getenv("STATS_PURGE_CONCURRENCY", "1")),
            max_per_graph=int(os.getenv("STATS_MAX_CONCURRENT_PER_GRAPH", "1")),
            max_delivery_attempts=int(os.getenv("STATS_MAX_DELIVERY_ATTEMPTS", "3")),
            drain_timeout_secs=float(os.getenv("STATS_DRAIN_TIMEOUT_SECS", "60")),
            poll_timeout_default_secs=resilience.STATS_POLL_TIMEOUT_SECS,
            poll_timeout_large_secs=resilience.STATS_POLL_TIMEOUT_LARGE_SECS,
            poll_large_threshold=resilience.STATS_POLL_LARGE_THRESHOLD,
            dedup_ttl_secs=int(os.getenv("STATS_DEDUP_TTL_SECS", str(default_dedup_ttl))),
            health_port=int(os.getenv("STATS_HEALTH_PORT", "8092")),
        )

    def resolve_poll_timeout(self, last_known_node_count: int) -> float:
        if last_known_node_count >= self.poll_large_threshold:
            return self.poll_timeout_large_secs
        return self.poll_timeout_default_secs
