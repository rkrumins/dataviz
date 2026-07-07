"""Provider reachability — the single backend decision for "is this provider up?".

The ``/admin/providers/status`` endpoint and the blank-model provisioning gate must
agree on a provider's health, or the UI shows a provider online while the server
refuses to build on it (or vice-versa). Both now resolve status through
:func:`resolve_provider_status`, reading the same two in-memory signals:

  1. the per-instance circuit-breaker state (authoritative — reflects real traffic);
  2. the background warmup-loop cache (fallback for un-visited providers).

The decision is pure and does NO I/O — a DNS-unresolvable or hung provider can never
slow the caller. A genuinely-fresh reachability probe (opening a socket) is a
separate, explicit concern handled by the ``/test`` endpoint's connectivity probe.
"""
from __future__ import annotations

from typing import Mapping, Optional, Tuple

# Provider status values, matching the frontend `ProviderStatusResponse.status`
# and `providerStatus` store. Kept as bare strings (no enum) so the shape is
# identical across the wire and both call sites.
STATUS_READY = "ready"
STATUS_UNAVAILABLE = "unavailable"
STATUS_UNKNOWN = "unknown"


def resolve_provider_status(
    *,
    is_active: bool,
    provider_id: str,
    breaker_states: Mapping[str, str],
    warmup_cache: Mapping[str, dict],
) -> Tuple[str, Optional[str]]:
    """Resolve a provider's readiness from in-memory signals only.

    Returns ``(status, error)`` where ``status`` is one of ``ready`` /
    ``unavailable`` / ``unknown`` and ``error`` is a short human reason when
    unavailable. Precedence: circuit-breaker (real-traffic truth) → warmup cache
    → unknown. An inactive provider is ``unknown`` (disabled, not observed).
    """
    if not is_active:
        return STATUS_UNKNOWN, None

    # 1. Authoritative breaker state — highest fidelity (reflects real traffic).
    #    Breaker keys are namespaced ``{provider_id}:{graph_name}``; match on the
    #    provider prefix.
    breaker_key = next(
        (k for k in breaker_states if k.startswith(f"{provider_id}:")),
        None,
    )
    breaker = breaker_states.get(breaker_key) if breaker_key else None
    if breaker == "healthy":
        return STATUS_READY, None
    if breaker in ("unavailable", "instantiation_failed"):
        return STATUS_UNAVAILABLE, f"Provider circuit: {breaker}"
    if breaker == "degraded":
        return STATUS_UNAVAILABLE, "Provider in degraded state (half-open)"

    # 2. Warmup cache — populated by the background loop, so even un-visited
    #    providers carry a status.
    warmup = warmup_cache.get(provider_id)
    if warmup is not None:
        if warmup.get("ok"):
            return STATUS_READY, None
        return STATUS_UNAVAILABLE, warmup.get("reason")

    # 3. Truly unknown — registered but never probed.
    return STATUS_UNKNOWN, None
