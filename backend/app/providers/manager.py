"""
ProviderManager -- resilient, workspace-centric manager for GraphDataProvider instances.

Replaces the former ProviderRegistry with integrated:
* Per-(provider_id, graph_name) instance cache with CircuitBreakerProxy wrapping
* Instantiation-time circuit breaker (negative cache) so a dead downstream
  doesn't burn 10s per request on repeated instantiation attempts
* HealthState reporting for readiness probes and observability
* Async-safe double-checked locking per cache key

Design invariants:
* Every provider instance handed out is wrapped in a CircuitBreakerProxy.
* A failing downstream is detected at TWO levels:
  1. Instantiation-time: the instantiation breaker opens after N failures,
     fast-failing subsequent requests in <1ms with ProviderUnavailable.
  2. Operation-time: the per-instance CircuitBreakerProxy opens after N
     method-call failures, fast-failing with ProviderUnavailable.
* Legacy connection-based access has been removed. All access is workspace-scoped.
"""

import asyncio
import inspect
import json
import logging
import os
from enum import Enum
import time
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.adapters import (
    AsyncCircuitBreaker,
    BreakerOpenError,
    BreakerState,
    CircuitBreakerProxy,
    ProviderBusy,
    ProviderLoading,
    ProviderUnavailable,
)
from backend.common.interfaces.provider import GraphDataProvider

from .state import ProbeOutcome, ProviderState

logger = logging.getLogger(__name__)


def apply_local_dev_falkordb_override(host, port):
    """Host-dev opt-in: the provider row stores the Docker hostname
    (``falkordb``) when seeded in-container, which a process running on the
    host cannot resolve. When ``LOCAL_DEV_FALKORDB_OVERRIDE`` is set,
    ``FALKORDB_HOST`` / ``FALKORDB_PORT`` win over the stored value. Not
    injected into compose service env, so containers keep the stored host
    and production multi-host providers are unaffected.

    Shared by BOTH provider-instantiation paths (ProviderManager and the
    deprecated ProviderRegistry used by the insights stats collector) so
    they cannot drift — the missing override on the registry path was why
    the laptop stats service couldn't reach a ``falkordb``-hosted provider.
    """
    if os.getenv("LOCAL_DEV_FALKORDB_OVERRIDE", "").strip().lower() in (
        "1", "true", "yes",
    ):
        host = os.getenv("FALKORDB_HOST") or host
        _port_override = os.getenv("FALKORDB_PORT")
        if _port_override:
            port = int(_port_override)
    return host, port


from backend.app.config import resilience as _resilience

# Tuneable via env vars. See backend/app/config/resilience.py for full reference.
_BREAKER_FAIL_MAX = int(os.getenv("PROVIDER_BREAKER_FAIL_MAX", "3"))
_BREAKER_RESET_TIMEOUT = int(os.getenv("PROVIDER_BREAKER_RESET_TIMEOUT_SECS", "30"))

# P1.9 — per-provider semaphore cap. Limits concurrent in-flight outbound
# calls per (provider_id, graph_name) so 100 concurrent requests for a
# slow provider can't all queue against its connection pool. Tune via env;
# default 8 absorbs typical bursts while bounding fan-out.
_MAX_PROVIDER_CONCURRENCY = int(os.getenv("PROVIDER_MAX_CONCURRENCY", "8"))
# Acquire-budget — how long a request waits for a semaphore slot before
# fast-failing. Keep tight: if all 8 slots are busy, the provider is in
# trouble and we'd rather shed load than queue.
_SEMAPHORE_ACQUIRE_BUDGET_S = float(os.getenv("PROVIDER_SEMAPHORE_BUDGET_S", "0.25"))

# Inline reachability preflight (WS0.1). Bounds the FIRST request to a
# just-went-down provider: get_provider runs a fast, deadline-bounded
# TCP+PING probe before handing the provider to a caller, so an unreachable
# host fast-fails in ~1.5s instead of every consumer (graph read, readiness,
# vocab-alignment, stats, …) independently burning ~25s of query timeouts
# while pinning a WEB DB connection the whole time (which drains the pool and
# stalls unrelated endpoints). The probe checks REACHABILITY, not query
# speed — a healthy provider mid-trace answers PING instantly and passes, so
# legitimate long-running reads are unaffected. Warmup-confirmed-healthy
# providers skip the probe entirely (zero added latency on the hot path).
_REACHABLE_PROBE_DEADLINE_S = float(os.getenv("PROVIDER_PREFLIGHT_DEADLINE_S", "1.5"))
_REACHABLE_PROBE_CACHE_S = float(os.getenv("PROVIDER_PREFLIGHT_CACHE_S", "3"))


class HealthState(str, Enum):
    """Observable health of a provider from the manager's perspective."""
    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    DEGRADED = "degraded"  # half-open probing
    UNAVAILABLE = "unavailable"  # breaker open, fast-failing
    INSTANTIATION_FAILED = "instantiation_failed"  # never successfully created


def _wrap_in_breaker(provider: GraphDataProvider, name: str) -> GraphDataProvider:
    """Wrap a raw provider in a CircuitBreakerProxy before caching."""
    return CircuitBreakerProxy(  # type: ignore[return-value]
        target=provider,
        name=name,
        fail_max=_BREAKER_FAIL_MAX,
        reset_timeout=_BREAKER_RESET_TIMEOUT,
    )


def _assert_dedicated_cache_configured() -> None:
    """WS2.1 decoupling guard. Deployed roles MUST run the provider cache on a
    DEDICATED Redis, never the FalkorDB instance — a graph outage must not also
    disable caching, and cache traffic must not contend with graph queries on
    FalkorDB's single-threaded process. Fail fast at startup when CACHE_REDIS_URL
    is unset in a WEB / WORKER / CONTROLPLANE role. In DEV a missing URL simply
    runs cache-disabled (still decoupled — ``build_cache_client`` never
    co-locates the cache on FalkorDB)."""
    import os as _os
    from backend.app.runtime.role import current_role, SynodicRole

    if current_role() == SynodicRole.DEV:
        return
    if not _os.getenv("CACHE_REDIS_URL"):
        raise RuntimeError(
            f"CACHE_REDIS_URL is required in the {current_role().value!r} role: "
            "the application cache must run on a DEDICATED Redis, not the "
            "FalkorDB instance. Set CACHE_REDIS_URL (see common-config / "
            "app-secrets)."
        )


class ProviderManager:
    """Resilient, workspace-centric manager for GraphDataProvider instances."""

    def __init__(self) -> None:
        # WS2.1: enforce operational/graph Redis decoupling at process start.
        _assert_dedicated_cache_configured()
        # Workspace-centric cache: (provider_id, graph_name) -> breaker-wrapped provider
        self._providers: Dict[Tuple[str, str], GraphDataProvider] = {}
        self._locks: Dict[Tuple[str, str], asyncio.Lock] = {}
        # Last-use clock (monotonic) per cache key, driving the LRU cap + idle reaper.
        # Without them the cache only ever grows: each entry keeps its connection pool
        # open forever (redis-py pools never reap idle sockets), so a data source used
        # once holds its sockets until the pod restarts — and at full HPA fan-out the
        # fleet-wide total approaches FalkorDB's maxclients, which fails hard.
        self._last_used: Dict[Tuple[str, str], float] = {}

        # Instantiation-time circuit breakers -- prevent repeated 10s timeouts
        # against a dead downstream. Opens after _BREAKER_FAIL_MAX failures,
        # fast-fails for _BREAKER_RESET_TIMEOUT seconds.
        self._instantiation_breakers: Dict[Tuple[str, str], AsyncCircuitBreaker] = {}

        # Background warmup status cache (P0.7): keyed by provider_id,
        # populated by the lifespan-launched ``run_provider_warmup_loop``
        # in ``backend/app/providers/warmup.py``. Health/status endpoints
        # read this for the source of truth on un-visited providers,
        # making provider unreachability invisible to the request path.
        # Entry shape: see warmup.py module docstring.
        self.warmup_cache: Dict[str, dict] = {}

        # Unified per-(provider_id, graph_name) state machine (P1.1). The
        # manager owns this; warmup loop and breaker proxy are writers via
        # ``record_probe_success`` / ``record_probe_failure``. All status
        # endpoints are pure readers via ``snapshot_state``. Single source
        # of truth eliminates the class of bugs where the warmup cache and
        # the breaker state disagreed.
        self._provider_states: Dict[Tuple[str, str], "ProviderState"] = {}
        # Coarse lock protecting state-mutation methods. Critical sections
        # are tiny (no I/O), so contention is negligible even at high
        # concurrency. Separate from the per-cache_key locks above (which
        # serialize instantiation, a much longer operation).
        self._state_lock: asyncio.Lock = asyncio.Lock()

        # Heartbeat from the warmup loop — updated each successful cycle so
        # ``/health/deps`` can surface "warmup_age_s" without grep'ing logs
        # (P1.4). monotonic() seconds. None until the first cycle finishes.
        self.warmup_last_cycle_at: Optional[float] = None

        # Per-provider semaphore (P1.9). Caps concurrent outbound calls on
        # any single ``(provider_id, graph_name)`` so a slow but technically-
        # alive provider can't have 100 user requests pile up against its
        # connection pool. Each request acquires for ``MAX_PROVIDER_CONCURRENCY``
        # slots (default 8); on saturation, raises ProviderUnavailable
        # immediately rather than queueing.
        self._provider_semaphores: Dict[Tuple[str, str], asyncio.Semaphore] = {}

        # Short-lived inline reachability verdicts (WS0.1). See the
        # _REACHABLE_PROBE_* constants + _ensure_reachable below.
        # (provider_id, graph_name) -> (verdict, monotonic_ts) where verdict is
        # "ok" | "loading" | "down".
        self._reachable_probe: Dict[Tuple[str, str], Tuple[str, float]] = {}
        # Single-flight the inline preflight so a herd of concurrent callers on
        # a just-downed provider triggers ONE probe, not N.
        self._reachable_inflight: Dict[Tuple[str, str], "asyncio.Future[str]"] = {}

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    async def get_provider(
        self,
        workspace_id: str,
        session: AsyncSession,
        data_source_id: Optional[str] = None,
    ) -> GraphDataProvider:
        """
        Resolve workspace -> data source -> (provider_id, graph_name) -> cached provider.

        Raises ProviderUnavailable if the provider cannot be reached (both
        instantiation-time and operation-time failures are normalized).
        Raises KeyError if the workspace or data source is not found.
        """
        from ..db.repositories import data_source_repo

        if data_source_id:
            ds = await data_source_repo.get_data_source_orm(session, data_source_id)
            if ds is None:
                raise KeyError(f"Data source not found: {data_source_id}")
        else:
            ds = await data_source_repo.get_primary_data_source(session, workspace_id)
            if ds is None:
                raise KeyError(f"No data source for workspace: {workspace_id}")

        cache_key = (ds.provider_id, ds.graph_name or "")

        # Fast path: already cached and healthy.
        #
        # NOTE: a cached provider is returned WITHOUT consulting the warmup
        # gate below (which guards only the slow instantiation path). This is
        # deliberate — real traffic through the cached provider's own operation
        # breaker is ground truth, and gating the cache on a single warmup
        # observation would fast-fail a healthy provider for up to 60s on one
        # transient probe blip. A cached provider whose FalkorDB has since gone
        # down fast-fails via its operation breaker instead (which now opens
        # cleanly thanks to the _ensure_connected zombie-handle rollback), and
        # is bulkheaded by the GRAPH_READ DB pool so it can't starve the WEB
        # pool while the breaker is opening.
        if cache_key in self._providers:
            provider = self._providers[cache_key]
            self._last_used[cache_key] = time.monotonic()
            await self._ensure_reachable(cache_key, provider)
            return provider

        # P1.2 — Warmup-cache fast-fail gate.
        # Before consulting the breaker (which costs a lock acquisition) and
        # certainly before the slow `_instantiate_from_provider` path (which
        # can stall on connect probes for several seconds), check whether
        # the background warmup loop has recently observed this provider as
        # unhealthy. If so, fast-fail in <1ms with NO socket I/O, NO lock
        # acquisition, NO queueing. Concurrent users on a known-bad provider
        # all reject in parallel instead of serialising through the
        # per-key lock and each paying full slow-path latency.
        #
        # The 60s freshness window matches 2× MIN_FULL_CYCLE_S of the warmup
        # loop, so a provider's status is never older than one full warmup
        # cycle when it gates. After that, we let the slow path run — the
        # observation is too stale to trust over real traffic.
        gate_state = self._provider_states.get(cache_key)
        if gate_state is not None and gate_state.is_recent_unhealthy(max_age_s=60.0):
            obs = gate_state.last_observation
            assert obs is not None  # is_recent_unhealthy guarantees this
            raise ProviderUnavailable(
                provider_name=f"{cache_key[0]}:{cache_key[1]}",
                reason=f"warmup observed unhealthy: {obs.reason}",
                retry_after_seconds=_BREAKER_RESET_TIMEOUT,
            )

        # Check the instantiation breaker BEFORE attempting to create.
        # If the breaker is open, fail fast (<1ms, no I/O).
        breaker = self._get_instantiation_breaker(cache_key)
        try:
            await breaker._acquire_call_slot()
        except BreakerOpenError as exc:
            raise ProviderUnavailable(
                provider_name=f"{cache_key[0]}:{cache_key[1]}",
                reason="Provider instantiation circuit open — recent attempts failed",
                retry_after_seconds=exc.retry_after_seconds,
            )

        # Slow path: acquire per-key lock and instantiate
        if cache_key not in self._locks:
            self._locks[cache_key] = asyncio.Lock()

        async with self._locks[cache_key]:
            # Double-check after acquiring lock
            if cache_key in self._providers:
                await breaker._record_success()
                return self._providers[cache_key]

            logger.info(
                "Instantiating provider for workspace=%s ds=%s provider=%s graph=%s",
                workspace_id, ds.id, ds.provider_id, ds.graph_name,
            )
            ds_extra = json.loads(ds.extra_config) if getattr(ds, "extra_config", None) else None
            try:
                raw_provider = await asyncio.wait_for(
                    self._instantiate_from_provider(
                        ds.provider_id, ds.graph_name, session,
                        ds_extra_config=ds_extra,
                    ),
                    timeout=10,
                )
            except asyncio.TimeoutError:
                state_after, fails_after = await breaker._record_failure()
                logger.warning(
                    "Provider instantiation timed out for %s (breaker=%s fails=%d/%d)",
                    cache_key, state_after, fails_after, breaker.fail_max,
                )
                raise ProviderUnavailable(
                    provider_name=f"{cache_key[0]}:{cache_key[1]}",
                    reason="Provider instantiation timed out",
                )
            except Exception as exc:
                state_after, fails_after = await breaker._record_failure()
                logger.warning(
                    "Provider instantiation failed for %s: %s (breaker=%s fails=%d/%d)",
                    cache_key, exc, state_after, fails_after, breaker.fail_max,
                )
                raise ProviderUnavailable(
                    provider_name=f"{cache_key[0]}:{cache_key[1]}",
                    reason=f"Instantiation failed: {exc}",
                ) from exc

            # Success: wrap in circuit breaker and cache. Expose the
            # manager identity on the raw provider first so app-layer
            # guards (graph.py ``_bounded_compute``, the ContextEngine
            # trace semaphore) can key per-(provider, graph) concurrency
            # without re-deriving it — CircuitBreakerProxy passes plain
            # attributes through to the wrapped instance.
            raw_provider.manager_cache_key = cache_key
            breaker_name = f"{ds.provider_id}:{ds.graph_name or ''}"
            self._providers[cache_key] = _wrap_in_breaker(raw_provider, breaker_name)
            self._last_used[cache_key] = time.monotonic()
            state_after, _ = await breaker._record_success()
            logger.info(
                "Provider cached for %s (breaker=%s)",
                cache_key, state_after,
            )
            await self._enforce_cache_cap()

        provider = self._providers[cache_key]
        self._last_used[cache_key] = time.monotonic()
        await self._ensure_reachable(cache_key, provider)
        return provider

    # Alias for backward compatibility during migration. ContextEngine,
    # aggregation worker, and health-check endpoint call this name.
    async def get_provider_for_workspace(
        self,
        workspace_id: str,
        session: AsyncSession,
        data_source_id: Optional[str] = None,
    ) -> GraphDataProvider:
        return await self.get_provider(workspace_id, session, data_source_id)

    async def _ensure_reachable(
        self, cache_key: Tuple[str, str], provider: GraphDataProvider,
    ) -> None:
        """Bounded reachability gate (WS0.1) run before handing a provider to a
        caller. Fast-fails an unreachable provider in ~1.5s (then <1ms via a
        short single-flighted verdict cache) instead of letting the caller burn
        ~25s of query timeouts against a down host while pinning a DB connection
        (which drains the pool and stalls unrelated endpoints — the app freeze).

        Reconciled with the WS0.1 audit:
        - Probes REACHABILITY (a fast TCP+PING via the provider's own
          preflight), NOT query duration — a healthy provider mid-trace answers
          PING instantly and passes, so long reads run their full budget.
        - Does NOT gate on warmup's single-blip observation (that would
          blackhole a healthy provider for 60s on one transient probe). The sole
          signal is a short, self-healing preflight verdict cache.
        - Maps a FalkorDB ``LOADING`` (restart / RDB replay) to the warming
          ProviderLoading path (retry-in-5s UX), NOT a hard "unreachable" — a
          pod restart must not pre-trip the breaker for 30-60s.
        - Probes the UNWRAPPED provider so a non-raising ok=False preflight
          can't be recorded as a breaker success and reset an open breaker.
        - Single-flights the probe per (provider, graph): a herd of concurrent
          callers triggers ONE probe, not N.
        - Providers without a preflight() are never gated.
        """
        now = time.monotonic()
        cached = self._reachable_probe.get(cache_key)
        if cached is not None and (now - cached[1]) < _REACHABLE_PROBE_CACHE_S:
            self._raise_for_verdict(cache_key, cached[0])
            return
        verdict = await self._probe_reachable_singleflight(cache_key, provider)
        self._raise_for_verdict(cache_key, verdict)

    def _raise_for_verdict(self, cache_key: Tuple[str, str], verdict: str) -> None:
        if verdict == "ok":
            return
        cp = f"{cache_key[0]}:{cache_key[1]}"
        if verdict == "loading":
            # Warming, not down — surface the retryable ProviderLoading signal
            # (the breaker ignores it) so the FE shows "graph is starting up".
            raise ProviderLoading(
                provider_name=cp,
                reason="graph is starting up (loading dataset into memory)",
                retry_after_seconds=5,
            )
        raise ProviderUnavailable(
            provider_name=cp,
            reason="provider unreachable (preflight failed)",
            retry_after_seconds=_BREAKER_RESET_TIMEOUT,
        )

    async def _probe_reachable_singleflight(
        self, cache_key: Tuple[str, str], provider: GraphDataProvider,
    ) -> str:
        """One in-flight preflight per cache_key; concurrent callers share it.
        The get/create is synchronous (no await between), so it's atomic under
        asyncio — no lock needed."""
        task = self._reachable_inflight.get(cache_key)
        if task is None:
            task = asyncio.ensure_future(self._probe_reachable(cache_key, provider))
            self._reachable_inflight[cache_key] = task
            task.add_done_callback(
                lambda _t, k=cache_key: self._reachable_inflight.pop(k, None)
            )
        return await task

    async def _probe_reachable(
        self, cache_key: Tuple[str, str], provider: GraphDataProvider,
    ) -> str:
        """Run one bounded preflight against the UNWRAPPED provider and cache
        the verdict ('ok' | 'loading' | 'down'). Never raises."""
        # Unwrap the CircuitBreakerProxy so a non-raising ok=False result is not
        # recorded as a breaker success (which would reset an open breaker).
        target = getattr(provider, "target", provider)
        preflight = getattr(target, "preflight", None)
        # Only gate providers exposing a REAL async preflight; a missing or
        # non-coroutine attribute (e.g. a test double) is not gateable.
        if preflight is None or not inspect.iscoroutinefunction(preflight):
            verdict = "ok"  # no async preflight — never gate
        else:
            verdict = "down"
            try:
                pf = await asyncio.wait_for(
                    preflight(deadline_s=_REACHABLE_PROBE_DEADLINE_S),
                    timeout=_REACHABLE_PROBE_DEADLINE_S + 1.0,
                )
                if getattr(pf, "ok", False):
                    verdict = "ok"
                elif "loading" in str(getattr(pf, "reason", "")).lower():
                    verdict = "loading"
            except Exception:
                verdict = "down"
        self._reachable_probe[cache_key] = (verdict, time.monotonic())
        return verdict

    def get_health(self, provider_id: str, graph_name: str) -> HealthState:
        """Return the observable health state of a specific provider."""
        cache_key = (provider_id, graph_name or "")

        # Check instantiation breaker first
        if cache_key in self._instantiation_breakers:
            ib = self._instantiation_breakers[cache_key]
            ib_state = ib.current_state
            if ib_state == BreakerState.OPEN.value:
                return HealthState.INSTANTIATION_FAILED

        # Check cached provider's operation breaker
        if cache_key in self._providers:
            proxy = self._providers[cache_key]
            if hasattr(proxy, "_breaker"):
                ob_state = proxy._breaker.current_state
                if ob_state == BreakerState.OPEN.value:
                    return HealthState.UNAVAILABLE
                if ob_state == BreakerState.HALF_OPEN.value:
                    return HealthState.DEGRADED
                return HealthState.HEALTHY

        return HealthState.UNKNOWN

    def report_provider_states(self) -> Dict[str, str]:
        """Return health states for all known providers (cached + breaker-tracked).

        Used by the /health/ready endpoint. No I/O, no new connections.
        """
        states: Dict[str, str] = {}

        # Report cached providers
        for cache_key in self._providers:
            key_str = f"{cache_key[0]}:{cache_key[1]}"
            states[key_str] = self.get_health(cache_key[0], cache_key[1]).value

        # Report instantiation-failed providers not in cache
        for cache_key, breaker in self._instantiation_breakers.items():
            key_str = f"{cache_key[0]}:{cache_key[1]}"
            if key_str not in states and breaker.current_state == BreakerState.OPEN.value:
                states[key_str] = HealthState.INSTANTIATION_FAILED.value

        return states

    # ------------------------------------------------------------------ #
    # Unified state machine — P1.1 + P1.3                                  #
    # ------------------------------------------------------------------ #
    #
    # The ``record_probe_*`` methods are the ONLY way warmup observations
    # and real-traffic outcomes flow into provider state. They atomically:
    #   1. Update ``_provider_states[cache_key].last_observation``.
    #   2. Reset / pre-trip the matching breakers.
    #   3. Evict the cached provider instance on recovery so the next
    #      request rebuilds the connection pool against the recovered host.
    #
    # By funnelling all writes through here, status endpoints (readers) and
    # the manager's fast-fail gate (P1.2) can rely on the state being
    # internally consistent without inspecting four separate stores.

    # After this many consecutive observed failures, pre-trip the
    # instantiation breaker so user requests fast-fail with no socket I/O.
    # 2 (not 1) absorbs single-cycle network blips.
    _PRE_TRIP_AFTER_N: int = int(os.getenv("PROVIDER_PRE_TRIP_AFTER_N", "2"))

    def _resolve_state_for_provider(self, provider_id: str) -> List[Tuple[str, str]]:
        """Return all cache_keys (across graph_names) for a given provider_id.

        Used by ``record_probe_*`` because the warmup loop writes per
        provider_id, but breakers and caches are per (provider_id, graph_name).
        Multi-data-source workspaces sharing one provider get all their keys
        updated on each probe.
        """
        keys: List[Tuple[str, str]] = []
        # Inspect all known cache_keys we've ever touched for this provider.
        seen: set = set()
        for cache_key in (
            *self._providers.keys(),
            *self._instantiation_breakers.keys(),
            *self._provider_states.keys(),
        ):
            if cache_key[0] == provider_id and cache_key not in seen:
                seen.add(cache_key)
                keys.append(cache_key)
        if not keys:
            # No traffic observed yet — synthesise the default-graph key so
            # warmup can populate state for un-visited providers.
            keys.append((provider_id, ""))
        return keys

    def _ensure_state(self, cache_key: Tuple[str, str]) -> ProviderState:
        state = self._provider_states.get(cache_key)
        if state is None:
            state = ProviderState(cache_key=cache_key)
            self._provider_states[cache_key] = state
        return state

    async def record_probe_success(
        self,
        provider_id: str,
        *,
        source: str = "warmup",
        elapsed_ms: int = 0,
    ) -> None:
        """Record a successful reachability observation for ``provider_id``.

        Effects (atomic under ``_state_lock``):
          - Update last_observation on every matching cache_key.
          - Reset consecutive_failures.
          - Force-close any open instantiation breakers (P1.3 recovery).
          - Force-close cached proxy breakers.
          - On a ``false → true`` transition, schedule eviction of the cached
            provider instance so the next user request rebuilds the pool
            against the recovered host.
        """
        outcome = (
            ProbeOutcome.from_warmup(ok=True, reason="ok", elapsed_ms=elapsed_ms)
            if source == "warmup"
            else ProbeOutcome.from_traffic(ok=True, elapsed_ms=elapsed_ms)
        )
        cache_keys = self._resolve_state_for_provider(provider_id)
        was_unhealthy = False

        async with self._state_lock:
            for cache_key in cache_keys:
                state = self._ensure_state(cache_key)
                if state.last_observation is not None and not state.last_observation.ok:
                    was_unhealthy = True
                state.last_observation = outcome
                state.consecutive_failures = 0
                state.breaker_state = "closed"
                state.breaker_opened_at = None
                if source == "warmup":
                    state.last_warmup_at = outcome.observed_at

            # Force-close every matching breaker. The breaker's own lock
            # serialises its mutation; we do this OUTSIDE _state_lock to
            # avoid lock-ordering inversions, but inside this method so the
            # observable state is consistent before we yield to other
            # coroutines.
            close_targets: List[AsyncCircuitBreaker] = []
            for cache_key in cache_keys:
                ib = self._instantiation_breakers.get(cache_key)
                if ib is not None:
                    close_targets.append(ib)
                proxy = self._providers.get(cache_key)
                proxy_breaker = getattr(proxy, "_breaker", None) if proxy is not None else None
                if proxy_breaker is not None:
                    close_targets.append(proxy_breaker)

        for breaker in close_targets:
            try:
                await breaker._record_success()
            except Exception as exc:
                logger.warning(
                    "Failed to force-close breaker %r on probe success: %s",
                    getattr(breaker, "name", "?"), exc,
                )

        # On recovery transition, evict cached provider so the pool gets
        # rebuilt against the recovered host. Real user traffic will
        # re-instantiate cleanly. This is critical because the cached
        # FalkorDB ConnectionPool may still hold dead sockets pointing at
        # the previously-broken host.
        if was_unhealthy:
            for cache_key in cache_keys:
                if cache_key in self._providers:
                    try:
                        await self.evict_data_source(cache_key[0], cache_key[1])
                    except Exception as exc:
                        logger.warning(
                            "Failed to evict %r on recovery: %s", cache_key, exc,
                        )
            logger.info(
                "Provider %s recovered (source=%s) — breakers reset, cache evicted",
                provider_id, source,
            )

    async def record_probe_failure(
        self,
        provider_id: str,
        *,
        reason: str,
        source: str = "warmup",
        elapsed_ms: int = 0,
    ) -> None:
        """Record a failed reachability observation for ``provider_id``.

        Effects (atomic under ``_state_lock``):
          - Update last_observation on every matching cache_key.
          - Increment consecutive_failures.
          - After ``_PRE_TRIP_AFTER_N`` consecutive failures, pre-trip the
            instantiation breaker (P1.3) so user requests fast-fail with
            no socket I/O. Idempotent — calling .open() on an already-open
            breaker is a no-op.

        Schema/auth/config errors should NOT call this — they're caller
        bugs, not downstream failure (already filtered at the proxy layer
        via _DEFAULT_IGNORED_EXCEPTIONS in circuit.py).
        """
        outcome = (
            ProbeOutcome.from_warmup(ok=False, reason=reason, elapsed_ms=elapsed_ms)
            if source == "warmup"
            else ProbeOutcome.from_traffic(ok=False, reason=reason, elapsed_ms=elapsed_ms)
        )
        cache_keys = self._resolve_state_for_provider(provider_id)
        pre_trip_targets: List[Tuple[Tuple[str, str], AsyncCircuitBreaker]] = []

        async with self._state_lock:
            for cache_key in cache_keys:
                state = self._ensure_state(cache_key)
                state.last_observation = outcome
                state.consecutive_failures += 1
                if source == "warmup":
                    state.last_warmup_at = outcome.observed_at

                if state.consecutive_failures >= self._PRE_TRIP_AFTER_N:
                    ib = self._instantiation_breakers.get(cache_key)
                    if ib is None:
                        ib = self._get_instantiation_breaker(cache_key)
                    if ib.current_state != BreakerState.OPEN.value:
                        pre_trip_targets.append((cache_key, ib))
                    state.breaker_state = "open"
                    state.breaker_opened_at = state.breaker_opened_at or outcome.observed_at

        for cache_key, breaker in pre_trip_targets:
            try:
                breaker.open()
                logger.info(
                    "Pre-tripped instantiation breaker for %r after %d consecutive "
                    "%s-observed failures (reason=%s)",
                    cache_key, self._PRE_TRIP_AFTER_N, source, reason,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to pre-trip breaker %r: %s", cache_key, exc,
                )

    def snapshot_state(
        self, provider_id: str, graph_name: str = "",
    ) -> Optional[ProviderState]:
        """Return one provider's state, or None if we've never observed
        it. Lock-free read — the underlying dict is only mutated under
        ``_state_lock`` and reads of a single key are atomic in CPython.

        F1: returns the live ``ProviderState`` directly (no copy). Treat
        as read-only by convention. Single-attribute reads are atomic;
        the only multi-field invariants the manager relies on are written
        atomically inside ``_state_lock``.
        """
        return self._provider_states.get((provider_id, graph_name or ""))

    def snapshot_states_for(self, provider_id: str) -> List[ProviderState]:
        """All states matching one provider_id (across graph_names). Used
        by status endpoints that don't know the specific graph_name."""
        return [
            state
            for cache_key, state in self._provider_states.items()
            if cache_key[0] == provider_id
        ]

    # ------------------------------------------------------------------ #
    # Per-provider semaphore — P1.9                                        #
    # ------------------------------------------------------------------ #

    def _get_provider_semaphore(self, cache_key: Tuple[str, str]) -> asyncio.Semaphore:
        """Lazy-create a per-cache-key semaphore. Idempotent."""
        sem = self._provider_semaphores.get(cache_key)
        if sem is None:
            sem = asyncio.Semaphore(_MAX_PROVIDER_CONCURRENCY)
            self._provider_semaphores[cache_key] = sem
        return sem

    async def acquire_provider_slot(
        self, provider_id: str, graph_name: str = "",
    ) -> asyncio.Semaphore:
        """Acquire a concurrency slot for an outbound provider call.

        Caller MUST release exactly once (via ``async with`` on the
        returned Semaphore is the canonical pattern, OR ``sem.release()``
        in a try/finally).

        Raises ``ProviderUnavailable`` immediately if the slot can't be
        acquired within ``_SEMAPHORE_ACQUIRE_BUDGET_S`` — this is the
        load-shed signal: a slow provider with 8 concurrent requests in
        flight should refuse the 9th rather than queue and amplify
        latency.
        """
        cache_key = (provider_id, graph_name or "")
        sem = self._get_provider_semaphore(cache_key)
        try:
            await asyncio.wait_for(
                sem.acquire(), timeout=_SEMAPHORE_ACQUIRE_BUDGET_S,
            )
        except asyncio.TimeoutError:
            # Semaphore saturated — this is a healthy provider under load,
            # not a broken one. ProviderBusy maps to HTTP 429 with
            # Retry-After so the client backs off and retries, instead of
            # 503 which clients (rightly) treat as "provider is down".
            raise ProviderBusy(
                provider_name=f"{cache_key[0]}:{cache_key[1]}",
                reason="provider concurrency saturated; shed load",
                retry_after_seconds=1,
            )
        return sem

    # ------------------------------------------------------------------ #
    # Eviction                                                             #
    # ------------------------------------------------------------------ #

    async def evict_data_source(self, provider_id: str, graph_name: str) -> None:
        """Evict cached provider for a (provider_id, graph_name) pair.

        Removes it from the cache (so new traffic re-instantiates cleanly) but
        DEFERS ``close()`` while the provider has in-flight guarded ops — closing
        mid-job nulls the graph handle out from under a running aggregation and
        surfaces as ``'NoneType' object has no attribute 'query'``. When busy we
        background a drain-then-close so the pool isn't leaked.

        This is the SINGLE eviction chokepoint (evict_provider / evict_workspace /
        evict_all all funnel here), so it also invalidates the versioning
        registry's memoized connection config + its cached graph clients. Without
        that, an admin repointing a provider (new host, standalone→cluster, rotated
        credentials) would update the read path while the PROJECTOR kept writing to
        the old instance until a restart — and a recovered-after-rotation provider
        would keep its dead sockets in those long-lived pools.
        """
        try:
            from backend.app.providers.falkor_graph_registry import invalidate_provider

            await invalidate_provider(provider_id)
        except Exception as exc:                     # pragma: no cover - best effort
            logger.warning(
                "Failed to invalidate registry graph clients for %s: %s",
                provider_id, exc,
            )
        await self._close_and_forget((provider_id, graph_name or ""))
        logger.info("Evicted provider for key=%s", (provider_id, graph_name or ""))

    async def _close_and_forget(self, cache_key: Tuple[str, str]) -> None:
        """Drop one cached provider and release its pools.

        Shared by eviction (config change / recovery) and by capacity reaping. It
        deliberately does NOT touch the registry's connection-config caches — those
        are about config staleness, and a reap is only about reclaiming sockets from
        a cold provider; nuking them would force every projector client for that
        instance to rebuild for no reason.

        ``close()`` is DEFERRED while the provider has in-flight guarded ops: closing
        mid-job nulls the graph handle out from under a running aggregation.
        """
        provider = self._providers.pop(cache_key, None)
        self._locks.pop(cache_key, None)
        self._last_used.pop(cache_key, None)
        # Also reset the instantiation breaker so re-instantiation is attempted
        self._instantiation_breakers.pop(cache_key, None)
        if provider is None:
            return
        inflight = 0
        try:
            inflight = provider.inflight_ops()
        except Exception:
            inflight = 0
        if inflight > 0:
            logger.info(
                "Provider %s evicted from cache but has %d in-flight ops — "
                "deferring close until idle.", cache_key, inflight,
            )
            asyncio.create_task(self._close_when_idle(cache_key, provider))
        else:
            try:
                await provider.close()
            except Exception as exc:
                logger.warning("Error closing provider %s: %s", cache_key, exc)

    def _idle_keys_lru_first(self) -> list:
        """Cached keys with no in-flight ops, least-recently-used first."""
        idle = []
        for key, provider in self._providers.items():
            try:
                if provider.inflight_ops() > 0:
                    continue
            except Exception:
                pass
            idle.append(key)
        idle.sort(key=lambda k: self._last_used.get(k, 0.0))
        return idle

    async def _enforce_cache_cap(self) -> None:
        """Keep the cache under PROVIDER_CACHE_MAX by closing the least-recently-used
        IDLE providers. A busy provider is never closed — the cap is a safety net
        against unbounded socket growth, not a throttle on live traffic."""
        cap = _resilience.PROVIDER_CACHE_MAX
        if cap <= 0 or len(self._providers) <= cap:
            return
        for key in self._idle_keys_lru_first():
            if len(self._providers) <= cap:
                break
            logger.info(
                "Provider cache over capacity (%d > %d) — closing LRU idle provider %s",
                len(self._providers), cap, key,
            )
            await self._close_and_forget(key)

    async def reap_idle_providers(self) -> int:
        """Close providers unused for PROVIDER_CACHE_IDLE_TTL_SECS, reclaiming their
        sockets and memory (redis-py pools keep idle connections open forever, so a
        data source touched once holds its sockets until the process restarts).

        Called from the warmup loop's cycle callback, so the web tier and the
        aggregation worker both get it. Returns the number closed.
        """
        ttl = _resilience.PROVIDER_CACHE_IDLE_TTL_SECS
        if ttl <= 0 or not self._providers:
            return 0
        now = time.monotonic()
        stale = [
            key for key in self._idle_keys_lru_first()
            if now - self._last_used.get(key, now) > ttl
        ]
        for key in stale:
            logger.info(
                "Provider %s idle for >%.0fs — closing to reclaim its connections.",
                key, ttl,
            )
            await self._close_and_forget(key)
        return len(stale)

    async def _close_when_idle(
        self, cache_key: tuple, provider: Any, *, timeout_s: float = 600.0,
    ) -> None:
        """Wait for a deferred-evicted provider to drain its in-flight ops, then
        close it. Bounded so a stuck op can't leak the pool forever."""
        deadline = time.monotonic() + timeout_s
        try:
            while time.monotonic() < deadline:
                try:
                    if provider.inflight_ops() <= 0:
                        break
                except Exception:
                    break
                await asyncio.sleep(2.0)
        finally:
            try:
                await provider.close()
                logger.info("Closed deferred-evicted provider %s.", cache_key)
            except Exception as exc:
                logger.warning(
                    "Error closing deferred provider %s: %s", cache_key, exc,
                )

    async def evict_workspace(self, workspace_id: str, session: AsyncSession) -> None:
        """Evict all cached providers for all data sources in a workspace."""
        from ..db.repositories import data_source_repo
        sources = await data_source_repo.list_data_sources(session, workspace_id)
        for ds in sources:
            await self.evict_data_source(ds.provider_id, ds.graph_name or "")

    async def evict_provider(self, provider_id: str, *, _broadcast: bool = True) -> None:
        """Evict everything cached for a provider_id — read instances AND the
        projector/registry's connection config + graph clients — in EVERY process.

        The registry invalidation runs UNCONDITIONALLY, not inside the loop below:
        ``self._providers`` is populated only by READ traffic, while the registry's
        caches are populated by the PROJECTOR. A provider that has been projected to
        but never read from (or whose read instance was already evicted by a breaker
        cycle) has no key here at all — so gating invalidation on that loop meant an
        admin repointing the provider left the projector writing to the OLD instance
        until the process restarted.

        The broadcast covers the other processes: this runs in ONE web pod, but the
        other replicas, the aggregation worker and the versioning worker each hold
        their own caches, and no self-heal reaches them (after a repoint the OLD host
        usually still answers, so warmup never sees the false→true transition that
        drives its eviction). ``_broadcast=False`` is used by the listener applying a
        received invalidation, so a message can't echo forever.
        """
        try:
            from backend.app.providers.falkor_graph_registry import invalidate_provider

            await invalidate_provider(provider_id)
        except Exception as exc:                     # pragma: no cover - best effort
            logger.warning(
                "Failed to invalidate registry graph clients for %s: %s",
                provider_id, exc,
            )
        keys_to_evict = [k for k in self._providers if k[0] == provider_id]
        for key in keys_to_evict:
            await self.evict_data_source(key[0], key[1])

        if _broadcast:
            from backend.app.providers.invalidation_bus import (
                publish_provider_invalidation,
            )

            await publish_provider_invalidation(provider_id)

    async def evict_all(self) -> None:
        """Evict all cached providers. Called during shutdown."""
        for key in list(self._providers.keys()):
            await self.evict_data_source(key[0], key[1])

    # ------------------------------------------------------------------ #
    # Provider instantiation                                               #
    # ------------------------------------------------------------------ #

    async def _instantiate_from_provider(
        self,
        provider_id: str,
        graph_name: Optional[str],
        session: AsyncSession,
        ds_extra_config: Optional[dict] = None,
    ) -> GraphDataProvider:
        """Instantiate a GraphDataProvider from a ProviderORM row."""
        from ..db.repositories.provider_repo import get_provider_orm, get_credentials

        row = await get_provider_orm(session, provider_id)
        if row is None:
            raise KeyError(f"Provider not found: {provider_id}")

        credentials = await get_credentials(session, provider_id)
        provider_extra = json.loads(row.extra_config) if row.extra_config else None
        merged_extra = self._merge_extra_config(provider_extra, ds_extra_config)
        return self._create_provider_instance(
            row.provider_type, row.host, row.port, graph_name,
            row.tls_enabled, credentials, extra_config=merged_extra,
        )

    @staticmethod
    def _merge_extra_config(
        provider_config: Optional[dict],
        datasource_config: Optional[dict],
    ) -> Optional[dict]:
        """Merge provider-level and data-source-level extra_config.
        DataSource values win on conflict (shallow merge at top-level,
        deep merge for ``schemaMapping`` sub-key).
        """
        if not provider_config and not datasource_config:
            return None
        base = dict(provider_config or {})
        override = dict(datasource_config or {})
        if "schemaMapping" in base and "schemaMapping" in override:
            merged_mapping = dict(base["schemaMapping"])
            merged_mapping.update(
                {k: v for k, v in override["schemaMapping"].items() if v is not None}
            )
            base.update(override)
            base["schemaMapping"] = merged_mapping
        else:
            base.update(override)
        return base

    @staticmethod
    def _create_provider_instance(
        provider_type: str,
        host: Optional[str],
        port: Optional[int],
        graph_name: Optional[str],
        tls_enabled: bool,
        credentials: Optional[dict] = None,
        extra_config: Optional[dict] = None,
    ) -> GraphDataProvider:
        """Dispatch to the correct provider constructor."""
        ptype = provider_type.lower()
        creds = credentials or {}

        if ptype == "falkordb":
            from backend.app.providers.falkordb_provider import (
                FalkorDBProvider,
                resolve_falkordb_target,
            )
            host, port = resolve_falkordb_target(host, port)
            # P1.6 — credentials previously dropped here, causing NOAUTH
            # errors to be mis-classified as network failures and tripping
            # the breaker for what is actually a configuration problem.
            # Passing username/password through means the driver issues
            # AUTH on every new connection and the breaker only fires for
            # real downstream failures.
            # Connection topology (standalone / sentinel / cluster) rides
            # extra_config["falkordbConnection"]. None / absent → the
            # legacy single-host path. Previously extra_config was dropped
            # on the FalkorDB branch (only Neo4j/Spanner consumed it).
            _falkor_conn = (extra_config or {}).get("falkordbConnection")
            # Per-provider auth gate (extra_config.falkordbConnection.authEnabled,
            # default true). When false, the provider nulls the graph
            # credentials at a single chokepoint so no AUTH leaks to an
            # unauthenticated FalkorDB (a dedicated cache_redis_url keeps its
            # own embedded auth).
            _auth_enabled = (_falkor_conn or {}).get("authEnabled", True)
            return FalkorDBProvider(
                host=host or "localhost",
                port=port or 6379,
                graph_name=graph_name or "nexus_lineage",
                username=creds.get("username"),
                password=creds.get("password"),
                connection_config=_falkor_conn,
                # Per-provider dedicated cache Redis (encrypted credential).
                cache_redis_url=creds.get("cache_redis_url"),
                auth_enabled=_auth_enabled,
                # Connection-level TLS (the falkordbConnection.tls object adds
                # CA/client-cert/verify mode). Previously dropped for FalkorDB.
                tls_enabled=tls_enabled,
            )

        elif ptype == "neo4j":
            from backend.graph.adapters.neo4j_provider import Neo4jProvider
            return Neo4jProvider(
                uri=f"{'bolt+s' if tls_enabled else 'bolt'}://{host}:{port or 7687}",
                username=creds.get("username", "neo4j"),
                password=creds.get("password", ""),
                database=graph_name or "neo4j",
                extra_config=extra_config,
            )

        elif ptype == "datahub":
            from backend.graph.adapters.datahub_provider import DataHubGraphQLProvider
            return DataHubGraphQLProvider(
                base_url=host or "",
                token=creds.get("token"),
            )

        elif ptype == "spanner":
            # Spanner uses GCP project/instance/database identifiers rather
            # than host/port. They live on extra_config; credentials carry
            # the service-account JSON.
            import os as _os
            from backend.graph.adapters.spanner_provider import SpannerProvider
            cfg = dict(extra_config or {})
            use_emulator = bool(cfg.get("useEmulator", False))
            # Prevent the cloud-spanner-emulator from ever being selected
            # outside an explicitly opted-in dev environment. The FE wizard
            # already hides the toggle in production builds; this is the
            # corresponding server-side defense so a hand-crafted payload
            # cannot route a real provider at localhost:9010.
            if use_emulator and not _os.getenv("SYNODIC_ALLOW_SPANNER_EMULATOR"):
                raise ValueError(
                    "Spanner emulator mode (extra_config.useEmulator=true) is "
                    "disabled by default. Set SYNODIC_ALLOW_SPANNER_EMULATOR=1 "
                    "in the backend environment to enable it for local development."
                )
            project_id = cfg.get("projectId") or creds.get("project_id")
            instance_id = cfg.get("instanceId")
            database_id = cfg.get("databaseId") or graph_name
            if not project_id or not instance_id or not database_id:
                raise ValueError(
                    "Spanner provider requires extra_config.projectId, "
                    "extra_config.instanceId, and (extra_config.databaseId or graph_name). "
                    f"Got project={project_id!r} instance={instance_id!r} database={database_id!r}."
                )
            return SpannerProvider(
                project_id=project_id,
                instance_id=instance_id,
                database_id=database_id,
                graph_name=cfg.get("graphName") or "UniViz",
                credentials_json=creds.get("service_account_json"),
                use_emulator=use_emulator,
                extra_config=cfg,
            )

        raise ValueError(f"Unknown provider_type: {ptype!r}")

    # ------------------------------------------------------------------ #
    # Internal helpers                                                     #
    # ------------------------------------------------------------------ #

    def _get_instantiation_breaker(self, cache_key: Tuple[str, str]) -> AsyncCircuitBreaker:
        """Get or create the instantiation-time circuit breaker for a cache key."""
        if cache_key not in self._instantiation_breakers:
            self._instantiation_breakers[cache_key] = AsyncCircuitBreaker(
                name=f"init:{cache_key[0]}:{cache_key[1]}",
                fail_max=_BREAKER_FAIL_MAX,
                reset_timeout=_BREAKER_RESET_TIMEOUT,
            )
        return self._instantiation_breakers[cache_key]


# Module-level singleton -- used by FastAPI dependency and ContextEngine.
provider_manager = ProviderManager()
