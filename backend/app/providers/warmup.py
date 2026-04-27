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
from typing import Any, Awaitable, Callable, Dict, MutableMapping, Optional

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

# Maximum concurrent probes per cycle (P1.5). With N=100 providers, a
# concurrency of 4 means a sick host blocks 1/4 of capacity, not the whole
# loop. Keep modest — too high and we burn the management DB pool with
# parallel credential fetches; too low and full-cycle latency suffers.
WARMUP_CONCURRENCY: int = int(os.getenv("PROVIDER_WARMUP_CONCURRENCY", "4"))

# Initial fast-pass concurrency at lifespan start (P1.5). Higher than
# steady-state because the cold-start window is short and we want the
# cache populated before the first user request arrives. Hard wall-clock
# cap of INITIAL_FAST_PASS_DEADLINE_S regardless of N.
INITIAL_FAST_PASS_CONCURRENCY: int = int(
    os.getenv("PROVIDER_WARMUP_INITIAL_CONCURRENCY", "8")
)
INITIAL_FAST_PASS_DEADLINE_S: float = _env_float(
    "PROVIDER_WARMUP_INITIAL_DEADLINE_S", 10.0,
)


def _adaptive_interval(provider_count: int) -> float:
    """Compute the inter-probe interval such that one full cycle is at
    least MIN_FULL_CYCLE_S seconds — but no faster.

    With N=1 provider:    interval = MIN_FULL_CYCLE_S (30s)
    With N=10 providers:  interval = 3s (cycle = 30s)
    With N=100 providers: interval = 0.3s (cycle = 30s)
    With N=1000:          floor at 0.05s (cycle = 50s)

    Bounded to [0.05, INTER_PROBE_INTERVAL_S] so very small deployments
    don't probe every second (uses configured INTER_PROBE_INTERVAL_S as
    the upper bound when slower than the natural rate would be).
    """
    if provider_count <= 0:
        return INTER_PROBE_INTERVAL_S
    natural = MIN_FULL_CYCLE_S / max(1, provider_count)
    # Clamp: never faster than 50ms (avoid driver hammer), never slower
    # than the operator-configured INTER_PROBE_INTERVAL_S.
    return max(0.05, min(natural, INTER_PROBE_INTERVAL_S))


# ── Type alias ───────────────────────────────────────────────────────

ProviderConfig = Dict[str, Any]   # {id, provider_type, host, port, tls, creds}


async def run_provider_warmup_loop(
    *,
    cache: MutableMapping[str, dict],
    shutdown_event: asyncio.Event,
    list_providers: Callable[[], Awaitable[list[ProviderConfig]]],
    build_instance: Callable[[ProviderConfig], Any],
    on_recovery: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    on_failure: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    on_cycle_complete: Optional[Callable[[], Awaitable[None]]] = None,
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
    on_recovery:
        Optional async callback fired on every observed ``false → true``
        transition (P1.3). Called as ``await on_recovery(provider_id,
        cache_entry)``. Used by the manager to reset breakers and evict
        the cached provider so the next user request rebuilds the pool.
    on_failure:
        Optional async callback fired on every observed failure (whether
        false→false or true→false). Called as ``await on_failure(
        provider_id, cache_entry)``. Used by the manager to maintain its
        consecutive-failures counter and pre-trip the breaker after N.
    on_cycle_complete:
        Optional async callback fired at the end of each cycle (P1.4).
        Used to update ``provider_manager.warmup_last_cycle_at`` for the
        ``/health/deps`` heartbeat surface.
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

        # 2. Probe each provider with bounded parallelism (P1.5).
        # WARMUP_CONCURRENCY workers pull from a shared queue. A sick host
        # blocks one worker, not the whole loop — so 50 dead providers no
        # longer serialise full-cycle latency. Adaptive interval ensures
        # one full cycle is always ≥ MIN_FULL_CYCLE_S (~30s) regardless of
        # N, so we never re-poll the same host more often than that.
        observed_ids: set[str] = set()
        # Filter to entries with valid ids, dedupe, preserve order.
        valid_providers = [c for c in providers if c.get("id")]
        for cfg in valid_providers:
            observed_ids.add(cfg["id"])

        interval = _adaptive_interval(len(valid_providers))
        sem = asyncio.Semaphore(max(1, WARMUP_CONCURRENCY))

        async def _probe_with_dispatch(cfg: ProviderConfig) -> None:
            if shutdown_event.is_set():
                return
            prov_id = cfg.get("id")
            if not prov_id:
                return
            async with sem:
                if shutdown_event.is_set():
                    return

                prev_entry = cache.get(prov_id)
                prev_ok = bool(prev_entry.get("ok")) if prev_entry else None

                entry = await _probe_one(cfg, build_instance)
                cache[prov_id] = entry

                # P1.3 — dispatch transition callback for the manager
                # state machine. CRITICAL that we await these in-band so
                # the manager's breaker mutations land before the loop
                # moves on to the next provider; out-of-order updates
                # would let a later success race with an earlier failure.
                new_ok = bool(entry.get("ok"))
                if not new_ok and on_failure is not None:
                    try:
                        await on_failure(prov_id, entry)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        logger.warning(
                            "Provider warmup: on_failure(%s) raised: %s",
                            prov_id, exc,
                        )
                elif new_ok and prev_ok is False and on_recovery is not None:
                    try:
                        await on_recovery(prov_id, entry)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        logger.warning(
                            "Provider warmup: on_recovery(%s) raised: %s",
                            prov_id, exc,
                        )

                # Pace each worker so the cluster of WARMUP_CONCURRENCY
                # workers doesn't burst the management DB / network. With
                # adaptive interval, this naturally throttles to fit the
                # MIN_FULL_CYCLE_S floor.
                if await _interruptible_sleep(shutdown_event, interval):
                    return

        # Launch one task per provider; the semaphore caps concurrency.
        # Using gather (not TaskGroup) so a single misbehaving probe
        # cannot cancel siblings. Each task swallows its own exceptions.
        await asyncio.gather(
            *[_probe_with_dispatch(cfg) for cfg in valid_providers],
            return_exceptions=True,
        )

        if shutdown_event.is_set():
            return

        # 3. Evict cache entries for providers that no longer exist
        #    (deleted, renamed, etc.). Prevents unbounded cache growth.
        stale = set(cache.keys()) - observed_ids
        for stale_id in stale:
            cache.pop(stale_id, None)

        # 4. Cycle heartbeat — let the manager record warmup_last_cycle_at
        #    so /health/deps can surface the loop's liveness (P1.4).
        if on_cycle_complete is not None:
            try:
                await on_cycle_complete()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "Provider warmup: on_cycle_complete raised: %s", exc,
                )

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


async def initial_fast_pass(
    *,
    cache: MutableMapping[str, dict],
    list_providers: Callable[[], Awaitable[list[ProviderConfig]]],
    build_instance: Callable[[ProviderConfig], Any],
    on_recovery: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    on_failure: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    deadline_s: float = INITIAL_FAST_PASS_DEADLINE_S,
    concurrency: int = INITIAL_FAST_PASS_CONCURRENCY,
) -> None:
    """One-shot, high-concurrency, hard-deadline-bounded warmup pass at
    lifespan start (P1.5).

    Eliminates the cold-start "Computing…" window for typical
    deployments. Runs concurrently with first request handling — does
    NOT block lifespan completion. Whatever finishes inside ``deadline_s``
    populates the cache; whatever doesn't waits for the regular cadence.

    No supervision, no respawn — single best-effort pass. The supervisor
    + steady-state loop pick up where this leaves off.
    """
    t0 = time.monotonic()
    try:
        async with asyncio.timeout(deadline_s):
            try:
                providers = await list_providers()
            except Exception as exc:
                logger.warning(
                    "initial_fast_pass: list_providers failed: %s — skipping",
                    exc,
                )
                return

            if not providers:
                return

            sem = asyncio.Semaphore(max(1, concurrency))

            async def _one(cfg: ProviderConfig) -> None:
                prov_id = cfg.get("id")
                if not prov_id:
                    return
                async with sem:
                    prev_entry = cache.get(prov_id)
                    prev_ok = bool(prev_entry.get("ok")) if prev_entry else None
                    entry = await _probe_one(cfg, build_instance)
                    cache[prov_id] = entry
                    new_ok = bool(entry.get("ok"))
                    if not new_ok and on_failure is not None:
                        try:
                            await on_failure(prov_id, entry)
                        except Exception:
                            pass
                    elif new_ok and prev_ok is False and on_recovery is not None:
                        try:
                            await on_recovery(prov_id, entry)
                        except Exception:
                            pass

            await asyncio.gather(
                *[_one(cfg) for cfg in providers],
                return_exceptions=True,
            )
    except (asyncio.TimeoutError, TimeoutError):
        # Hard wall-clock cap reached; whatever finished is in the cache.
        # The steady-state loop will fill in the rest.
        elapsed = time.monotonic() - t0
        logger.info(
            "initial_fast_pass deadline reached at %.1fs — partial fill is OK",
            elapsed,
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("initial_fast_pass crashed: %s", exc)


async def supervised_warmup_loop(
    *,
    cache: MutableMapping[str, dict],
    shutdown_event: asyncio.Event,
    list_providers: Callable[[], Awaitable[list[ProviderConfig]]],
    build_instance: Callable[[ProviderConfig], Any],
    on_recovery: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    on_failure: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    on_cycle_complete: Optional[Callable[[], Awaitable[None]]] = None,
) -> None:
    """Wrap ``run_provider_warmup_loop`` with a self-supervisor (P1.4).

    Without supervision, a single uncaught exception (e.g. a malformed
    provider config raising KeyError, a third-party driver bug, a
    transient asyncio internal error) would unwind the loop and the
    cache would freeze silently — every status endpoint would lie
    indefinitely with no visible signal until users complained.

    The supervisor:
    - Catches every non-CancelledError and respawns the inner loop.
    - Backs off exponentially (1s → 2s → … → 60s cap) so a persistent
      crash doesn't busy-loop.
    - Logs every respawn at ERROR level so operators see the signal.
    - Exits cleanly on shutdown (CancelledError or shutdown_event set).

    The inner loop is responsible for its own per-cycle resilience
    (DB outages, build errors, preflight timeouts) — the supervisor
    only catches what the inner loop fails to. CancelledError always
    propagates so the lifespan can shut down cleanly.
    """
    backoff_s = 1.0
    BACKOFF_CAP_S = 60.0
    while not shutdown_event.is_set():
        try:
            await run_provider_warmup_loop(
                cache=cache,
                shutdown_event=shutdown_event,
                list_providers=list_providers,
                build_instance=build_instance,
                on_recovery=on_recovery,
                on_failure=on_failure,
                on_cycle_complete=on_cycle_complete,
            )
            # Inner loop returned normally — shutdown was set.
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(
                "Provider warmup loop crashed: %s — respawning in %.1fs",
                exc, backoff_s, exc_info=True,
            )
            if await _interruptible_sleep(shutdown_event, backoff_s):
                return
            backoff_s = min(backoff_s * 2.0, BACKOFF_CAP_S)
            # Reset backoff on next clean run via the inner loop's first
            # cycle; the supervisor only backs off on consecutive crashes.
            # If you want stricter backoff-on-success-too, move this reset
            # inside the inner loop's success path.
    logger.info("Provider warmup supervisor stopped (shutdown signalled)")
