"""Lightweight metrics façade for the job platform.

The codebase doesn't currently depend on ``prometheus_client``; rather
than pull in a new transitive runtime dependency for Phase 0, we ship
a no-op-by-default registry that the call sites use today and a real
Prometheus backend can register itself against later. One file change
(adding the prometheus implementation in ``backend/app/jobs/metrics_prometheus.py``
and calling ``set_backend(PrometheusBackend())`` at startup) replaces
this façade without touching any of the code that emits metrics.

Why this matters. Without a façade, every metric call site embeds a
direct ``prometheus_client.Counter(...)`` reference; swapping to OTel
or a hosted backend later means refactoring every emit site in the
codebase. With the façade, swapping is one file. This is the exact
same discipline as ``JobEmitter`` for events — the seam matters more
than the backend.

Counters defined here so far cover the Phase 0 + Phase 1 contract:

* ``job_events_emitted_total{kind, type}`` — every successful emit
* ``job_events_emit_errors_total`` — emit-side Redis exceptions
* ``redis_xadd_latency_ms`` — observed latency on XADD
* ``sse_subscribers_gauge`` — active SSE connections
* ``stuck_jobs_redispatched_total`` — reconciler activity
* ``cooperative_cancels_observed_total`` — worker-side cancels honored

All counters are addressable by name + label set; the no-op backend
just logs at DEBUG so emissions are visible during dev without a
metrics scrape endpoint.
"""
from __future__ import annotations

import logging
from typing import Mapping, Protocol

logger = logging.getLogger(__name__)


class MetricsBackend(Protocol):
    """Pluggable backend. The real Prometheus implementation lives
    elsewhere (or doesn't exist yet); this protocol is the contract."""

    def increment(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None: ...
    def observe(self, name: str, labels: Mapping[str, str], value: float) -> None: ...
    def gauge_set(self, name: str, labels: Mapping[str, str], value: float) -> None: ...
    def gauge_inc(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None: ...
    def gauge_dec(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None: ...


class _NoopBackend:
    """Default backend until something real is registered. Logs at
    DEBUG so emissions show up under verbose logging without needing
    a /metrics endpoint."""

    def increment(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        logger.debug("metric.increment %s %s += %s", name, dict(labels), value)

    def observe(self, name: str, labels: Mapping[str, str], value: float) -> None:
        logger.debug("metric.observe %s %s = %s", name, dict(labels), value)

    def gauge_set(self, name: str, labels: Mapping[str, str], value: float) -> None:
        logger.debug("metric.gauge_set %s %s = %s", name, dict(labels), value)

    def gauge_inc(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        logger.debug("metric.gauge_inc %s %s += %s", name, dict(labels), value)

    def gauge_dec(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        logger.debug("metric.gauge_dec %s %s -= %s", name, dict(labels), value)


_backend: MetricsBackend = _NoopBackend()


def set_backend(backend: MetricsBackend) -> None:
    """Replace the active backend. Called once at process startup by
    whichever module wires Prometheus / OTel / etc."""
    global _backend
    _backend = backend


# ── Convenience helpers (call-site API) ────────────────────────────


def increment(name: str, value: float = 1.0, **labels: str) -> None:
    _backend.increment(name, labels, value)


def observe(name: str, value: float, **labels: str) -> None:
    _backend.observe(name, labels, value)


def gauge_set(name: str, value: float, **labels: str) -> None:
    _backend.gauge_set(name, labels, value)


def gauge_inc(name: str, value: float = 1.0, **labels: str) -> None:
    _backend.gauge_inc(name, labels, value)


def gauge_dec(name: str, value: float = 1.0, **labels: str) -> None:
    _backend.gauge_dec(name, labels, value)
