"""The worker's memory as the kernel sees it: two readers that never raise,
and a gauge that keeps a hot loop from re-reading the kernel on every poll
while remembering the peak."""
from __future__ import annotations

from backend.app.providers import process_memory as pm
from backend.app.services.aggregation import fleet as fl


def test_the_readers_never_raise():
    rss, limit = pm.read_rss_mb(), pm.read_mem_limit_mb()
    assert rss is None or rss > 0
    assert limit is None or limit > 0
    # The fleet module still exposes them as its own globals (its tests
    # substitute them there, and claim_decision resolves them at call time).
    assert fl.read_rss_mb is pm.read_rss_mb and fl.read_mem_limit_mb is pm.read_mem_limit_mb


def test_the_gauge_samples_at_most_once_per_interval_and_keeps_the_peak():
    clock = {"t": 0.0}
    rss_values = iter([1000.0, 1500.0, 1200.0])
    limits = iter([4096.0])
    reads = {"rss": 0, "limit": 0}

    def read_rss():
        reads["rss"] += 1
        return next(rss_values)

    def read_limit():
        reads["limit"] += 1
        return next(limits)

    g = pm.MemoryGauge(min_interval_s=1.0, clock=lambda: clock["t"],
                       rss_reader=read_rss, limit_reader=read_limit)
    assert g.sample() == (1000.0, 4096.0)
    clock["t"] = 0.5
    assert g.sample() == (1000.0, 4096.0)                  # inside the interval: the last reading
    clock["t"] = 1.0
    assert g.sample() == (1500.0, 4096.0)
    clock["t"] = 2.5
    assert g.sample() == (1200.0, 4096.0)
    assert (reads["rss"], reads["limit"]) == (3, 1)          # the limit is read once
    assert g.high_water_mb == 1500.0 and g.samples == 3


def test_an_unknown_reading_stays_none():
    g = pm.MemoryGauge(clock=lambda: 0.0, rss_reader=lambda: None, limit_reader=lambda: None)
    assert g.sample() == (None, None) and g.high_water_mb is None
