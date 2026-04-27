"""
Unified per-provider state — single source of truth for the manager.

P1.1 of the Manager-Anchored Resilience plan. Before this module, provider
state lived in four separate stores:

  - ``ProviderManager._providers``           (cached breaker-wrapped instance)
  - ``ProviderManager._instantiation_breakers`` (negative cache for slow init)
  - ``CircuitBreakerProxy._breaker``          (per-instance proxy breaker)
  - ``ProviderManager.warmup_cache``          (background warmup observations)

…and they didn't synchronise. The warmup loop could observe recovery while
the breaker stayed OPEN; status endpoints could report unhealthy from a
stale breaker while warmup said healthy. That's the structural defect
behind the "auto-recovery is broken" finding (G1) and the "stale negative"
finding (G7).

This module collapses the observation+breaker state into a single
``ProviderState`` per ``(provider_id, graph_name)``. The manager owns the
state machine; the warmup loop and the breaker proxy are writers; status
endpoints are pure readers.

Read-only DTOs only — no I/O, no locks, no coupling to async machinery.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal, Optional, Tuple

# Source of an observation. Helps callers reason about freshness:
#   ``warmup``  — background loop, runs every ~30s, periodic.
#   ``traffic`` — real user request, may be hours apart, but authoritative.
ObservationSource = Literal["warmup", "traffic"]


@dataclass(frozen=True)
class ProbeOutcome:
    """One observed reachability result.

    Frozen so callers can't accidentally mutate a snapshot. Build a fresh
    one each time state changes.
    """
    ok: bool
    reason: str                          # short reason code: "ok", "dns_unresolvable", "tcp_refused", …
    elapsed_ms: int
    source: ObservationSource
    observed_at: float                   # monotonic — only comparable to other monotonic values

    @classmethod
    def from_warmup(cls, ok: bool, reason: str, elapsed_ms: int) -> "ProbeOutcome":
        return cls(
            ok=ok, reason=reason, elapsed_ms=elapsed_ms,
            source="warmup", observed_at=time.monotonic(),
        )

    @classmethod
    def from_traffic(cls, ok: bool, reason: str = "ok", elapsed_ms: int = 0) -> "ProbeOutcome":
        return cls(
            ok=ok, reason=reason, elapsed_ms=elapsed_ms,
            source="traffic", observed_at=time.monotonic(),
        )


@dataclass
class ProviderState:
    """Single source of truth for one ``(provider_id, graph_name)`` pair.

    Mutable inside the manager (the manager holds a single instance per
    cache_key and updates it in place under a lock). Snapshots returned to
    readers are deep-copies (or frozen views) to prevent action-at-a-
    distance.
    """
    cache_key: Tuple[str, str]

    # The most recent observation, regardless of source. Used by:
    #   - the manager's fast-fail gate (P1.2): if this is recent + unhealthy,
    #     short-circuit get_provider before lock acquisition.
    #   - status endpoints: prefer this over breaker state when more recent
    #     than breaker_opened_at (fixes G7 — stale negatives on recovery).
    last_observation: Optional[ProbeOutcome] = None

    # Counter for consecutive observed failures. Used by warmup to decide
    # when to PRE-TRIP the instantiation breaker (after N transitions, not
    # 1, to avoid breaker thrash on a flaky network). Reset on any success.
    consecutive_failures: int = 0

    # Mirrors of the breaker state, kept in sync by the manager so readers
    # don't have to consult `_AsyncCircuitBreaker` internals. Updated atomically
    # alongside ``last_observation`` inside ``record_probe_*`` methods.
    breaker_state: Literal["closed", "half-open", "open"] = "closed"
    breaker_opened_at: Optional[float] = None     # monotonic

    # Bookkeeping for tests / observability — when did warmup last write here?
    last_warmup_at: Optional[float] = None        # monotonic

    def is_recent_unhealthy(self, *, max_age_s: float = 60.0) -> bool:
        """The fast-fail predicate used by the manager gate.

        True when:
        - we have an observation
        - it says ``ok=False``
        - it's recent (within ``max_age_s``)

        Returns False for stale unhealthy (let real traffic re-probe), for
        stale healthy + recent unhealthy combined (latest wins), or for any
        ``ok=True`` observation.
        """
        obs = self.last_observation
        if obs is None or obs.ok:
            return False
        return (time.monotonic() - obs.observed_at) <= max_age_s

    def is_recent_healthy(self, *, max_age_s: float = 60.0) -> bool:
        """Symmetric predicate — used to decide whether warmup state should
        override a stale OPEN breaker (G7 fix)."""
        obs = self.last_observation
        if obs is None or not obs.ok:
            return False
        return (time.monotonic() - obs.observed_at) <= max_age_s

    def warmup_overrides_breaker(self) -> bool:
        """G7 / status-endpoint tie-break: trust warmup's verdict over a
        stale breaker.

        Returns True when:
        - we have a warmup observation
        - the breaker is OPEN
        - the warmup observation is newer than the breaker's open transition

        The breaker state is still authoritative for the request path
        (manager.get_provider consults the breaker, not just this); but for
        STATUS DISPLAY, a freshly-observed recovery should show as healthy.
        """
        obs = self.last_observation
        if obs is None or self.breaker_opened_at is None:
            return False
        if self.breaker_state != "open":
            return False
        return obs.ok and obs.observed_at > self.breaker_opened_at


@dataclass(frozen=True)
class ProviderStateSnapshot:
    """Read-only snapshot for callers — never returns the live mutable
    object. Manager copies into one of these inside its lock and hands it
    out."""
    cache_key: Tuple[str, str]
    last_observation: Optional[ProbeOutcome]
    consecutive_failures: int
    breaker_state: str
    breaker_opened_at: Optional[float]
    last_warmup_at: Optional[float]

    def warmup_overrides_breaker(self) -> bool:
        """Mirror of ``ProviderState.warmup_overrides_breaker`` — see that
        docstring. Duplicated here because callers on the read path receive
        the snapshot, not the live state. (This duplication is exactly the
        over-engineering I called out: snapshot vs live having to keep
        their predicates in sync. Fold these into one class on the next
        simplification pass.)
        """
        obs = self.last_observation
        if obs is None or self.breaker_opened_at is None:
            return False
        if self.breaker_state != "open":
            return False
        return obs.ok and obs.observed_at > self.breaker_opened_at

    @classmethod
    def from_state(cls, state: ProviderState) -> "ProviderStateSnapshot":
        return cls(
            cache_key=state.cache_key,
            last_observation=state.last_observation,
            consecutive_failures=state.consecutive_failures,
            breaker_state=state.breaker_state,
            breaker_opened_at=state.breaker_opened_at,
            last_warmup_at=state.last_warmup_at,
        )
