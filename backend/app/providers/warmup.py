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

# Sentinel / Cluster providers need a LARGER budget: their preflight does two
# hops — topology discovery (Sentinel discover-master or CLUSTER SLOTS, itself a
# connect + AUTH handshake) THEN a second connect + AUTH + PING to the resolved
# master/owning node. With authentication each hop adds an AUTH round-trip, and
# over a Kubernetes headless service the connects carry real DNS + cross-pod
# latency. The 1.5s standalone budget false-times-out that legitimate work,
# recording a spurious ``connect_timeout`` that then GATES every read (the
# manager's is_recent_unhealthy fast-fail) — a health probe vetoing a reachable
# provider. Give the multi-hop topologies room so the verdict is accurate.
PER_PROBE_DEADLINE_MULTIHOP_S: float = _env_float(
    "PROVIDER_WARMUP_PROBE_DEADLINE_MULTIHOP_S", 4.0,
)
PER_PROBE_WALL_CLOCK_MULTIHOP_S: float = _env_float(
    "PROVIDER_WARMUP_PROBE_WALL_CLOCK_MULTIHOP_S", 5.0,
)


def _probe_budget(cfg: "ProviderConfig") -> tuple[float, float]:
    """(deadline_s, wall_clock_s) for one provider's preflight, sized by topology.
    Sentinel/Cluster get the multi-hop budget (discovery + owner ping + auth).

    A provider may RAISE its own budget via ``falkordbConnection.probeDeadlineS``
    — a cross-cluster hop with TLS + AUTH can legitimately exceed the fleet
    default, and without a per-provider knob one slow-but-healthy provider
    needed a global env change (or kept getting falsely gated as offline).
    The per-provider value can only extend the topology default, never shrink
    it below the tested floor.
    """
    conn = (cfg.get("extra_config") or {}).get("falkordbConnection") or {}
    mode = conn.get("mode") or "standalone"
    if str(mode).strip().lower() in ("sentinel", "cluster"):
        deadline, wall = PER_PROBE_DEADLINE_MULTIHOP_S, PER_PROBE_WALL_CLOCK_MULTIHOP_S
    else:
        deadline, wall = PER_PROBE_DEADLINE_S, PER_PROBE_WALL_CLOCK_S
    try:
        per_provider = float(conn.get("probeDeadlineS") or 0)
    except (TypeError, ValueError):
        per_provider = 0.0
    if per_provider > deadline:
        deadline, wall = per_provider, per_provider + 1.0
    return deadline, wall

# Sleep between consecutive probes. Spreads load when many providers
# are registered. With 100 providers and 1s interval, full cycle ≈ 100s.
INTER_PROBE_INTERVAL_S: float = _env_float("PROVIDER_WARMUP_INTERVAL_S", 1.0)

# Floor on full-cycle duration WHEN EVERYTHING IS HEALTHY. With few providers we
# don't want to hammer them every second; never re-poll faster than this.
MIN_FULL_CYCLE_S: float = _env_float("PROVIDER_WARMUP_MIN_CYCLE_S", 30.0)

# Floor on full-cycle duration WHILE ANY PROVIDER IS UNHEALTHY (recovery mode).
# A recovered node must self-heal in seconds, not wait a full healthy cycle —
# reads stay gated until warmup observes the recovery, so the poll cadence IS the
# recovery latency. Probes are bounded and hold no DB session, so polling fast
# during an outage is cheap and is exactly when responsiveness matters. Falls
# back to MIN_FULL_CYCLE_S automatically once every provider is healthy again.
RECOVERY_POLL_S: float = _env_float("PROVIDER_WARMUP_RECOVERY_POLL_S", 5.0)

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


def _provider_is_due(
    provider_id: str,
    cache: "MutableMapping[str, dict]",
    last_probed: dict,
    now: float,
) -> bool:
    """Whether a provider is due for a re-probe under the HEALTH-AWARE
    PER-PROVIDER cadence — the thing that lets the loop scale to dozens/hundreds
    of providers:

      - never probed yet            → due now
      - last observation HEALTHY    → due every MIN_FULL_CYCLE_S
      - last observation UNHEALTHY  → due every RECOVERY_POLL_S (fast self-heal)

    So while the loop wakes at the fast cadence (because SOMETHING is down), a
    HEALTHY provider is still skipped until its own slow interval elapses — one
    down host never drags the whole fleet into the fast lane.
    """
    last = last_probed.get(provider_id)
    if last is None:
        return True
    prev = cache.get(provider_id)
    healthy = bool(prev.get("ok")) if prev else False
    target = MIN_FULL_CYCLE_S if healthy else RECOVERY_POLL_S
    return (now - last) >= target


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

    # Per-provider last-probe time (monotonic), persisted across cycles. Drives
    # the HEALTH-AWARE PER-PROVIDER cadence: a healthy provider is re-probed
    # every MIN_FULL_CYCLE_S; an unhealthy one every RECOVERY_POLL_S. This is
    # what makes the loop scale to dozens/hundreds of providers — a single down
    # provider fast-heals WITHOUT dragging every healthy provider into the fast
    # lane (which a global cadence would).
    last_probed: dict[str, float] = {}

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

        # Health-aware PER-PROVIDER cadence: probe a provider only when ITS OWN
        # interval has elapsed — MIN_FULL_CYCLE_S while healthy, RECOVERY_POLL_S
        # while unhealthy (or not yet probed). So in a fleet of dozens, a single
        # down provider fast-heals (5s) without re-probing every HEALTHY provider
        # in the fast lane. The loop still wakes at the fast tick while anything
        # is unhealthy (see the cycle-floor below) but only the due — i.e. the
        # unhealthy — providers are actually probed on those wakes.
        cycle_now = time.monotonic()
        due_providers = [
            cfg for cfg in valid_providers
            if _provider_is_due(cfg["id"], cache, last_probed, cycle_now)
        ]

        interval = _adaptive_interval(len(due_providers) or 1)
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
                last_probed[prov_id] = time.monotonic()

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

        # Launch one task per DUE provider; the semaphore caps concurrency.
        # Using gather (not TaskGroup) so a single misbehaving probe
        # cannot cancel siblings. Each task swallows its own exceptions.
        await asyncio.gather(
            *[_probe_with_dispatch(cfg) for cfg in due_providers],
            return_exceptions=True,
        )

        if shutdown_event.is_set():
            return

        # 3. Evict cache entries for providers that no longer exist
        #    (deleted, renamed, etc.). Prevents unbounded cache growth.
        stale = set(cache.keys()) - observed_ids
        for stale_id in stale:
            cache.pop(stale_id, None)
            last_probed.pop(stale_id, None)

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

        # 4. Health-aware WAKE cadence. When every provider is healthy, sleep a
        #    full MIN_FULL_CYCLE_S. While ANY provider is unhealthy, wake at the
        #    fast RECOVERY_POLL_S — but the per-provider due-filter above means
        #    only the UNHEALTHY providers are actually re-probed on those wakes;
        #    healthy providers stay on their MIN_FULL_CYCLE_S interval. So a down
        #    provider self-heals in ~RECOVERY_POLL_S regardless of fleet size,
        #    and a dozens-strong fleet is never hammered because one host is
        #    down. Relaxes back to the slow wake once all providers are healthy.
        any_unhealthy = any(
            not (cache.get(pid) or {}).get("ok", False) for pid in observed_ids
        )
        target_cycle = RECOVERY_POLL_S if any_unhealthy else MIN_FULL_CYCLE_S
        elapsed = time.monotonic() - cycle_start
        sleep_for = max(0.0, target_cycle - elapsed)
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
            deadline_s, wall_clock_s = _probe_budget(cfg)
            result = await asyncio.wait_for(
                preflight(deadline_s=deadline_s),
                timeout=wall_clock_s,
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


async def start_provider_warmup(
    provider_manager: Any,
    *,
    shutdown_event: asyncio.Event,
    initial_pass: bool = True,
) -> "list[asyncio.Task]":
    """Wire the warmup state machine to a ``ProviderManager`` and start it.

    Shared by EVERY process that owns a ProviderManager — the web tier and the
    aggregation worker each hold their own (separate pools, separate breakers, so a
    provider failure in one cannot affect the other). Both therefore need their own
    warmup loop: it is what drives ``record_probe_success`` on a false→true
    transition, which force-closes the breakers AND **evicts the cached provider**
    so its ConnectionPool is rebuilt.

    Without this, a process self-heals only via the 30s breaker cooldown while
    keeping a pool full of dead sockets pointing at the pre-rotation pod — every
    probe pays a failed round-trip before redis-py discards the socket. The worker
    ran that way; the web tier did not.

    Returns the created tasks (initial fast-pass first, then the supervisor) so the
    caller can await/cancel them on shutdown.
    """
    import time as _time

    from backend.app.db.engine import get_provider_probe_session
    from backend.app.db.repositories import provider_repo as _provider_repo

    async def _list_providers() -> list:
        import json as _json
        from sqlalchemy import select
        from backend.app.db.models import ProviderORM
        from backend.app.db.repositories.connection_repo import _decrypt

        # ONE query for the whole fleet, then decrypt in memory. This used to be
        # N+1 — a get_credentials() round-trip PER provider — which, at the fast
        # recovery cadence with dozens of providers, hammered the management DB
        # pool every few seconds. Decrypt + JSON are CPU-only, so we do them
        # after releasing the session.
        async with get_provider_probe_session() as session:
            rows = (await session.execute(select(ProviderORM))).scalars().all()

        out = []
        for row in rows:
            try:
                creds = _decrypt(row.credentials) if row.credentials else {}
            except Exception:
                creds = {}
            # extra_config carries falkordbConnection (mode + sentinel/cluster
            # nodes). WITHOUT it every provider is probed as STANDALONE against
            # its stored host:port — a Sentinel instance gets pinged at whatever
            # that row names, a Cluster at one seed — so the probe verdict would
            # describe a topology the read path never uses, corrupting recovery.
            try:
                extra = _json.loads(row.extra_config) if row.extra_config else None
            except Exception:
                extra = None
            out.append({
                "id": row.id,
                "provider_type": (
                    row.provider_type.value
                    if hasattr(row.provider_type, "value")
                    else str(row.provider_type)
                ),
                "host": row.host,
                "port": row.port,
                "tls": row.tls_enabled,
                "creds": creds,
                "extra_config": extra,
            })
        return out

    def _build_instance(cfg: ProviderConfig):
        return provider_manager._create_provider_instance(
            cfg["provider_type"],
            cfg.get("host"),
            cfg.get("port"),
            None,
            cfg.get("tls", False),
            cfg.get("creds") or {},
            cfg.get("extra_config"),
        )

    async def _on_recovery(provider_id: str, entry: dict) -> None:
        await provider_manager.record_probe_success(
            provider_id,
            source="warmup",
            elapsed_ms=int(entry.get("elapsed_ms", 0)),
        )

    async def _on_failure(provider_id: str, entry: dict) -> None:
        await provider_manager.record_probe_failure(
            provider_id,
            reason=str(entry.get("reason", "unknown"))[:200],
            source="warmup",
            elapsed_ms=int(entry.get("elapsed_ms", 0)),
        )

    async def _on_cycle_complete() -> None:
        # Heartbeat for the /health/deps liveness signal.
        provider_manager.warmup_last_cycle_at = _time.monotonic()
        # Reclaim connections held by providers nobody has used in a while. redis-py
        # pools never reap idle sockets, so without this a data source touched once
        # keeps its connections until the pod restarts — and at fleet scale the total
        # approaches FalkorDB's maxclients. Runs here so the web tier AND the
        # aggregation worker both get it (both start this loop).
        try:
            reap = getattr(provider_manager, "reap_idle_providers", None)
            if reap is not None:
                closed = await reap()
                if closed:
                    logger.info("Reaped %d idle provider instance(s)", closed)
        except Exception as exc:                     # pragma: no cover - best effort
            logger.warning("Idle-provider reap failed: %s", exc)

    tasks: list = []
    if initial_pass:
        # Hard-deadline-bounded one-shot that populates the cache for the
        # cold-start window. Scheduled BEFORE the supervisor so it can observe
        # transitions from the empty cache. Never blocks the caller.
        tasks.append(asyncio.create_task(
            initial_fast_pass(
                cache=provider_manager.warmup_cache,
                list_providers=_list_providers,
                build_instance=_build_instance,
                on_recovery=_on_recovery,
                on_failure=_on_failure,
            ),
            name="provider-warmup-initial-pass",
        ))

    tasks.append(asyncio.create_task(
        supervised_warmup_loop(
            cache=provider_manager.warmup_cache,
            shutdown_event=shutdown_event,
            list_providers=_list_providers,
            build_instance=_build_instance,
            on_recovery=_on_recovery,
            on_failure=_on_failure,
            on_cycle_complete=_on_cycle_complete,
        ),
        name="provider-warmup-supervisor",
    ))
    return tasks
