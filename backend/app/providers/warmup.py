"""
Background provider warmup loop — the single source of provider health
observability.

Enterprise contract (1 to 100 providers, any number unreachable, zero
impact on the request path):

    1. Periodically probe each registered provider via ``preflight()``.
    2. Store the result in a process-local in-memory cache keyed by
       provider id.
    3. NEVER raise into the request path. Probe failures only update the
       cache (and the per-instance breaker, when applicable).
    4. Bounded fan-out: at most one provider probed at a time, with a
       1.5s deadline per probe and a configurable interval between
       probes. With 100 providers and 1s interval, full cycle ≈ 100s.
    5. Round-robin all registered providers, then sleep until the next
       cycle. The cache always reflects state observed within the last
       cycle.
    6. Survives DB outages — if the registered-providers list cannot be
       fetched, the loop sleeps and retries; the cache stays whatever it
       last knew.

Public contract (consumed by health endpoints):

    cache shape (app.state.provider_warmup_cache):
        {
            provider_id: {
                "ok": bool,
                "reason": str,           # short reason code, eg "ok",
                                         # "dns_unresolvable", "tcp_refused",
                                         # "connect_timeout", "tls_handshake"
                "elapsed_ms": int,
                "checked_at": float,     # time.time() epoch seconds
                "provider_type": str,    # falkordb / neo4j / datahub
                "host": str | None,      # for diagnostics only — never
                                         # returned to FE for unauth users
            }
        }

This module is intentionally framework-agnostic and does not import
``app``: callers wire in the cache target and shutdown event. That keeps
unit-testing trivial and forces the integration boundary to be explicit.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Awaitable, Callable, Dict, MutableMapping

logger = logging.getLogger(__name__)


# ── Tunables ─────────────────────────────────────────────────────────


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Per-probe deadline (seconds). Hard budget for one provider's
# preflight. Keep tight — preflight is a TCP + tiny handshake, anything
# beyond ~1s is a network problem we want to record, not wait for.
PER_PROBE_DEADLINE_S: float = _env_float("PROVIDER_WARMUP_PROBE_DEADLINE_S", 1.5)

# Wall-clock backstop on top of the deadline (just in case preflight
# misbehaves). Should be slightly larger than PER_PROBE_DEADLINE_S.
PER_PROBE_WALL_CLOCK_S: float = _env_float("PROVIDER_WARMUP_PROBE_WALL_CLOCK_S", 2.0)

# Sleep between consecutive probes. Spreads load when many providers
# are registered. With 100 providers and 1s interval, full cycle ≈ 100s.
INTER_PROBE_INTERVAL_S: float = _env_float("PROVIDER_WARMUP_INTERVAL_S", 1.0)

# Floor on full-cycle duration. With few providers we don't want to
# hammer them every second; never re-poll faster than this.
MIN_FULL_CYCLE_S: float = _env_float("PROVIDER_WARMUP_MIN_CYCLE_S", 30.0)

# After a load-providers DB error, sleep this long before retrying.
DB_ERROR_BACKOFF_S: float = _env_float("PROVIDER_WARMUP_DB_BACKOFF_S", 10.0)


# ── Type alias ───────────────────────────────────────────────────────

ProviderConfig = Dict[str, Any]   # {id, provider_type, host, port, tls, creds}


async def run_provider_warmup_loop(
    *,
    cache: MutableMapping[str, dict],
    shutdown_event: asyncio.Event,
    list_providers: Callable[[], Awaitable[list[ProviderConfig]]],
    build_instance: Callable[[ProviderConfig], Any],
) -> None:
    """Run the warmup loop until ``shutdown_event`` is set.

    Parameters
    ----------
    cache:
        Target dict for status entries. The loop owns this dict and
        mutates it in place; consumers read from it.
    shutdown_event:
        Set by lifespan on shutdown. The loop checks it between probes
        and exits cleanly.
    list_providers:
        Async callable returning the current list of provider configs.
        Called once per cycle. May raise; the loop will sleep + retry.
    build_instance:
        Sync callable that builds a non-cached provider instance from a
        config dict. Receives the dict from ``list_providers``. The
        returned instance is expected to expose ``preflight(deadline_s)``
        and ``close()``; preflight failures are returned as Result, not
        raised.
    """
    logger.info(
        "Provider warmup loop starting "
        "(probe_deadline=%.1fs, interval=%.1fs, min_cycle=%.1fs)",
        PER_PROBE_DEADLINE_S, INTER_PROBE_INTERVAL_S, MIN_FULL_CYCLE_S,
    )

    while not shutdown_event.is_set():
        cycle_start = time.monotonic()

        # 1. Snapshot the current registered providers. DB hiccups are
        #    not fatal — sleep and retry.
        try:
            providers = await list_providers()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Provider warmup: list_providers failed (%s); backing off %.0fs",
                exc, DB_ERROR_BACKOFF_S,
            )
            if await _interruptible_sleep(shutdown_event, DB_ERROR_BACKOFF_S):
                return
            continue

        if not providers:
            # No providers registered — sleep until the next cycle.
            if await _interruptible_sleep(shutdown_event, MIN_FULL_CYCLE_S):
                return
            continue

        # 2. Probe each provider in round-robin, one at a time. Bounded
        #    by per-probe deadline; cache updated immediately after each.
        observed_ids: set[str] = set()
        for cfg in providers:
            if shutdown_event.is_set():
                return
            prov_id = cfg.get("id")
            if not prov_id:
                continue
            observed_ids.add(prov_id)

            entry = await _probe_one(cfg, build_instance)
            cache[prov_id] = entry

            # Pace the loop so a 100-provider deployment doesn't burst.
            if await _interruptible_sleep(shutdown_event, INTER_PROBE_INTERVAL_S):
                return

        # 3. Evict cache entries for providers that no longer exist
        #    (deleted, renamed, etc.). Prevents unbounded cache growth.
        stale = set(cache.keys()) - observed_ids
        for stale_id in stale:
            cache.pop(stale_id, None)

        # 4. Floor on the full cycle duration. If we burned through
        #    quickly (small deployment), sleep so we never re-poll the
        #    same host more often than MIN_FULL_CYCLE_S.
        elapsed = time.monotonic() - cycle_start
        sleep_for = max(0.0, MIN_FULL_CYCLE_S - elapsed)
        if sleep_for > 0:
            if await _interruptible_sleep(shutdown_event, sleep_for):
                return

    logger.info("Provider warmup loop stopped")


async def _probe_one(
    cfg: ProviderConfig,
    build_instance: Callable[[ProviderConfig], Any],
) -> dict:
    """Run one preflight against the provider described by ``cfg``.
    Returns a cache entry dict; never raises (network errors classified)."""
    t0 = time.monotonic()
    instance = None
    try:
        instance = build_instance(cfg)
    except Exception as exc:
        logger.warning(
            "Provider warmup: build failed for %s: %s",
            cfg.get("id"), exc,
        )
        return {
            "ok": False,
            "reason": f"build_failed: {type(exc).__name__}: {exc!s}"[:200],
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
            "checked_at": time.time(),
            "provider_type": cfg.get("provider_type"),
            "host": cfg.get("host"),
        }

    preflight = getattr(instance, "preflight", None)
    try:
        if not callable(preflight):
            return {
                "ok": False,
                "reason": "preflight_not_implemented",
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "checked_at": time.time(),
                "provider_type": cfg.get("provider_type"),
                "host": cfg.get("host"),
            }

        try:
            result = await asyncio.wait_for(
                preflight(deadline_s=PER_PROBE_DEADLINE_S),
                timeout=PER_PROBE_WALL_CLOCK_S,
            )
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "reason": "warmup_wall_clock_exceeded",
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "checked_at": time.time(),
                "provider_type": cfg.get("provider_type"),
                "host": cfg.get("host"),
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return {
                "ok": False,
                "reason": f"preflight_error: {type(exc).__name__}: {exc!s}"[:200],
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "checked_at": time.time(),
                "provider_type": cfg.get("provider_type"),
                "host": cfg.get("host"),
            }

        return {
            "ok": bool(getattr(result, "ok", False)),
            "reason": getattr(result, "reason", "ok"),
            "elapsed_ms": getattr(result, "elapsed_ms", int((time.monotonic() - t0) * 1000)),
            "checked_at": time.time(),
            "provider_type": cfg.get("provider_type"),
            "host": cfg.get("host"),
        }
    finally:
        # Best-effort close so we don't leak sockets across cycles.
        if instance is not None:
            close = getattr(instance, "close", None)
            if callable(close):
                try:
                    await asyncio.wait_for(close(), timeout=0.5)
                except Exception:
                    pass


async def _interruptible_sleep(shutdown: asyncio.Event, seconds: float) -> bool:
    """Sleep ``seconds`` or until shutdown fires. Returns True if
    shutdown fired (caller should exit), False on timeout."""
    if seconds <= 0:
        return shutdown.is_set()
    try:
        await asyncio.wait_for(shutdown.wait(), timeout=seconds)
        return True
    except asyncio.TimeoutError:
        return False
