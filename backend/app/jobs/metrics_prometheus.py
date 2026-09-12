"""A real metrics backend, in the shape ``metrics.py`` always described.

The façade beside this file has been no-op since it was written: nothing
ever called ``set_backend``, so every ``metrics_increment`` in the codebase
went to a DEBUG log and nowhere else. That is survivable for event counters
and not survivable for the graph store, where the whole point of the write
governor, the admission slots and the pacing model is that they hold a node
inside an envelope — and an operator could see each of them ONLY per run,
after the fact, one job at a time in Job History. There was no way to ask
"are we trending toward the incident", which is the only question worth
asking before one.

**No new dependency.** ``prometheus_client`` is not in requirements and this
does not add it: the text exposition format is a few lines, every scraper
reads it, and a metrics backend is a bad place to take on supply-chain risk
in a codebase that already gates on dependency review. If a richer client is
wanted later, that is still the one-file swap the façade promised — this file.

**Cardinality is bounded, deliberately.** The classic way a metrics layer
takes a service down is an unbounded label: one series per job id, per data
source, per URN, and the registry grows until the process dies. Given what
this file exists to protect, shipping that would be its own punchline. So
every metric is capped at ``_MAX_SERIES_PER_METRIC`` distinct label sets;
past the cap a series is dropped and the fact is counted, once, under
``metrics_series_dropped_total``. Labels used by call sites are all bounded
by construction (a slot kind, a hold reason, a node endpoint); the cap is
there for the one somebody adds later without thinking.

**Per process, like every Prometheus target.** Each gunicorn worker and each
aggregation worker counts its own. Scrape them all; sum in the query.
"""
from __future__ import annotations

import logging
import threading
from typing import Dict, Mapping, Tuple

logger = logging.getLogger(__name__)

_MAX_SERIES_PER_METRIC = 500
"""Distinct label sets kept per metric name. See the cardinality note above."""

#: name → {labels → value}
_Series = Dict[Tuple[Tuple[str, str], ...], float]


def _key(labels: Mapping[str, str]) -> Tuple[Tuple[str, str], ...]:
    """A hashable, order-independent label key. Sorted so ``{a,b}`` and
    ``{b,a}`` are one series rather than two."""
    return tuple(sorted((str(k), str(v)) for k, v in labels.items()))


def _escape(value: str) -> str:
    """Label VALUE escaping, per the exposition format: backslash, double
    quote and newline. A node endpoint or a hold reason will never contain
    them, which is exactly why it would go unnoticed when one finally does."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


class PrometheusBackend:
    """In-process counters, gauges and sums, rendered on demand.

    Never raises. A metrics layer that can fail a write path is worse than
    no metrics layer, and every call site here sits inside the governor, the
    admission gates or a job's terminal block.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Dict[str, _Series] = {}
        self._gauges: Dict[str, _Series] = {}
        # ``observe`` keeps count and sum — enough for a rate and a mean,
        # which is what these signals are read for. Deliberately not
        # buckets: quantiles here would be a second design decision made
        # on no evidence, and the per-run record already carries detail.
        self._obs_count: Dict[str, _Series] = {}
        self._obs_sum: Dict[str, _Series] = {}
        self._dropped: Dict[str, float] = {}

    # -- writes ---------------------------------------------------------

    def _bump(
        self, store: Dict[str, _Series], name: str,
        labels: Mapping[str, str], value: float, *, absolute: bool = False,
    ) -> None:
        try:
            key = _key(labels)
            with self._lock:
                series = store.setdefault(name, {})
                if key not in series and len(series) >= _MAX_SERIES_PER_METRIC:
                    if name not in self._dropped:
                        logger.warning(
                            "metrics: %s hit %d label sets — further series are "
                            "dropped. A label here is unbounded; bound it at the "
                            "call site rather than raising the cap.",
                            name, _MAX_SERIES_PER_METRIC,
                        )
                    self._dropped[name] = self._dropped.get(name, 0.0) + 1.0
                    return
                series[key] = float(value) if absolute else series.get(key, 0.0) + float(value)
        except Exception:  # noqa: BLE001 — a metric must never fail a caller
            logger.debug("metrics: dropped a sample for %s", name, exc_info=True)

    def increment(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        self._bump(self._counters, name, labels, value)

    def observe(self, name: str, labels: Mapping[str, str], value: float) -> None:
        self._bump(self._obs_count, name, labels, 1.0)
        self._bump(self._obs_sum, name, labels, value)

    def gauge_set(self, name: str, labels: Mapping[str, str], value: float) -> None:
        self._bump(self._gauges, name, labels, value, absolute=True)

    def gauge_inc(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        self._bump(self._gauges, name, labels, value)

    def gauge_dec(self, name: str, labels: Mapping[str, str], value: float = 1.0) -> None:
        self._bump(self._gauges, name, labels, -value)

    # -- read -----------------------------------------------------------

    def render(self) -> str:
        """The whole registry in Prometheus text exposition format."""
        with self._lock:
            counters = {n: dict(s) for n, s in self._counters.items()}
            gauges = {n: dict(s) for n, s in self._gauges.items()}
            counts = {n: dict(s) for n, s in self._obs_count.items()}
            sums = {n: dict(s) for n, s in self._obs_sum.items()}
            dropped = dict(self._dropped)

        lines: list[str] = []

        def _emit(name: str, series: _Series, kind: str) -> None:
            if not series:
                return
            lines.append(f"# TYPE {name} {kind}")
            for key, value in sorted(series.items()):
                labels = ",".join(f'{k}="{_escape(v)}"' for k, v in key)
                lines.append(f"{name}{{{labels}}} {value:g}" if labels
                             else f"{name} {value:g}")

        for name, series in sorted(counters.items()):
            _emit(name, series, "counter")
        for name, series in sorted(gauges.items()):
            _emit(name, series, "gauge")
        for name, series in sorted(counts.items()):
            _emit(f"{name}_count", series, "counter")
            _emit(f"{name}_sum", sums.get(name, {}), "counter")
        if dropped:
            _emit(
                "metrics_series_dropped_total",
                {(("metric", n),): v for n, v in sorted(dropped.items())},
                "counter",
            )
        return "\n".join(lines) + "\n"


#: The process's backend, once installed. ``None`` until ``install()`` runs,
#: which is what the endpoint checks before offering to render anything.
_INSTALLED: "PrometheusBackend | None" = None


def install() -> PrometheusBackend:
    """Register this backend with the façade. Idempotent — a process that
    calls it twice (web tier lifespan plus a test) keeps one registry."""
    global _INSTALLED
    if _INSTALLED is None:
        from . import metrics

        _INSTALLED = PrometheusBackend()
        metrics.set_backend(_INSTALLED)
        logger.info("metrics: in-process Prometheus backend installed")
    return _INSTALLED


def installed() -> "PrometheusBackend | None":
    return _INSTALLED
