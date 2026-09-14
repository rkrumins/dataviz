"""The protections had no signal, and a signal that can hurt you is worse.

Everything the write governor, the admission slots and the pacing model do
was observable only per run, after the fact, one job at a time in Job
History: the metrics façade was no-op in every process because nothing ever
called ``set_backend``, and there was no scrape endpoint at all. So the
question "are we trending toward the incident" had no answer.

These pin the two halves of fixing that. That the numbers are real — the
slot cap failing open is counted, a governor hold is counted, a budget
refusal is counted. And that the metrics layer cannot itself become the
outage: bounded cardinality, no exception ever reaching a caller, and an
endpoint that is off until an operator turns it on.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.jobs import metrics as facade
from backend.app.jobs import metrics_prometheus as mp


@pytest.fixture
def backend(monkeypatch):
    """A fresh registry per test, with the façade pointed at it and restored
    after — these are process globals."""
    fresh = mp.PrometheusBackend()
    original = facade._backend
    facade.set_backend(fresh)
    monkeypatch.setattr(mp, "_INSTALLED", fresh)
    yield fresh
    facade.set_backend(original)


# ── the registry itself ──────────────────────────────────────────────────


def test_counters_gauges_and_observations_render(backend):
    facade.increment("agg_x_total", kind="read")
    facade.increment("agg_x_total", kind="read")
    facade.increment("agg_x_total", kind="write")
    facade.gauge_set("agg_g", 4)
    facade.observe("agg_secs", 3.0, kind="fork")
    facade.observe("agg_secs", 1.0, kind="fork")

    out = backend.render()
    assert 'agg_x_total{kind="read"} 2' in out
    assert 'agg_x_total{kind="write"} 1' in out
    assert "agg_g 4" in out
    assert 'agg_secs_count{kind="fork"} 2' in out
    assert 'agg_secs_sum{kind="fork"} 4' in out
    assert "# TYPE agg_x_total counter" in out
    assert "# TYPE agg_g gauge" in out


def test_label_order_does_not_split_a_series(backend):
    facade.increment("agg_y_total", a="1", b="2")
    facade.increment("agg_y_total", b="2", a="1")
    assert 'agg_y_total{a="1",b="2"} 2' in backend.render()


def test_cardinality_is_capped_and_says_so(backend, monkeypatch):
    """The classic way a metrics layer takes a service down. Given what this
    file exists to protect, shipping an unbounded label would be its own
    punchline."""
    monkeypatch.setattr(mp, "_MAX_SERIES_PER_METRIC", 3)
    for i in range(50):
        facade.increment("agg_unbounded_total", job=f"job-{i}")

    out = backend.render()
    assert out.count("agg_unbounded_total{") == 3
    assert 'metrics_series_dropped_total{metric="agg_unbounded_total"}' in out


def test_a_label_value_with_a_quote_cannot_break_the_format(backend):
    facade.increment("agg_z_total", detail='he said "no" \\ then\nleft')
    out = backend.render()
    assert '\\"no\\"' in out and "\\\\" in out
    # One sample line, not three: the newline is escaped, not emitted.
    assert len([l for l in out.splitlines() if l.startswith("agg_z_total")]) == 1


def test_emitting_never_raises_at_the_call_site(backend, monkeypatch):
    """Every emit site sits inside the governor, an admission gate or a job's
    terminal block. A counter is never worth a job."""
    def _boom(*a, **k):
        raise RuntimeError("registry exploded")

    monkeypatch.setattr(mp, "_key", _boom)
    facade.increment("agg_w_total", kind="read")      # must not raise
    facade.observe("agg_w_secs", 1.0)
    facade.gauge_set("agg_w_g", 1)


def test_install_is_idempotent(monkeypatch):
    monkeypatch.setattr(mp, "_INSTALLED", None)
    first = mp.install()
    assert mp.install() is first


# ── the signals that were invisible ──────────────────────────────────────


def test_the_slot_cap_failing_open_is_counted(backend, monkeypatch):
    """THE signal. Past the deadline every waiter proceeds — the cap has
    stopped capping, which is the state immediately before a node is
    over-admitted. It was a rate-limited log line and nothing else."""
    from backend.app.services.aggregation import admission as adm

    class _NeverGrants:
        async def eval(self, *a, **k):
            return 0

    class _P:
        _graph_name = "g"
        _conn_cfg = type("C", (), {"host": "seed", "port": 6379})()

    monkeypatch.setattr(adm, "_SLOT_WAIT_MAX_SECS", 0.0)
    a = adm.AggregationAdmission(_NeverGrants())
    key, member = asyncio.run(a._acquire_slot(_P(), "10.0.0.1:6379", "read"))

    assert (key, member) == (None, None)              # fail-open, as designed
    out = backend.render()
    assert 'aggregation_slot_fail_open_total{kind="read",node="10.0.0.1:6379",reason="deadline"} 1' in out


def test_a_bus_outage_fail_open_is_counted_separately(backend, monkeypatch):
    """Different remedy: one means Redis is down, the other means the node is
    genuinely contended. Collapsing them would send an operator to the wrong
    place at the worst moment."""
    from backend.app.services.aggregation import admission as adm

    class _Down:
        async def eval(self, *a, **k):
            raise ConnectionError("bus down")

    class _P:
        _graph_name = "g"
        _conn_cfg = type("C", (), {"host": "seed", "port": 6379})()

    a = adm.AggregationAdmission(_Down())
    asyncio.run(a._acquire_slot(_P(), "10.0.0.1:6379", "write"))
    assert 'reason="bus_error"' in backend.render()


def test_a_governor_hold_is_counted_with_its_reason(backend):
    """Per-run a hold only ever answered "did THIS run wait". The question is
    how often, on which node, and whether it is getting worse."""
    import test_falkordb_materialize as base

    pipe = base._make_pipeline()
    pipe._record_hold("fork", 12.5, "BGSAVE in progress")
    pipe._record_hold("fork", 7.5, "BGSAVE in progress")
    pipe._record_hold("replica_lag", 3.0, "replica 2 behind")

    out = backend.render()
    assert 'aggregation_governor_holds_total{kind="fork"' in out
    assert 'aggregation_governor_hold_seconds_count{kind="fork"} 2' in out
    assert 'aggregation_governor_hold_seconds_sum{kind="fork"} 20' in out
    assert 'aggregation_governor_hold_seconds_count{kind="replica_lag"} 1' in out


# ── the endpoint is off until someone turns it on ────────────────────────
#
# This repository has been bitten by a surface that was open because nobody
# chose to close it — the compose file still carries the comment about an
# unauthenticated graph database published to the internet by default. A
# scrape endpoint is lower stakes and still a read of internal state: node
# endpoints, hold reasons, how loaded the fleet is.


def _request(headers=None):
    import types

    return types.SimpleNamespace(headers=headers or {})


def _scrape(monkeypatch, *, enabled=None, token=None, headers=None):
    from fastapi import HTTPException

    from backend.app.api.v1.endpoints import metrics as route

    for name, value in (("METRICS_ENABLED", enabled), ("METRICS_TOKEN", token)):
        monkeypatch.delenv(name, raising=False)
        if value is not None:
            monkeypatch.setenv(name, value)
    try:
        return asyncio.run(route.scrape(_request(headers))), None
    except HTTPException as exc:
        return None, exc.status_code


def test_the_endpoint_is_absent_unless_enabled(monkeypatch, backend):
    response, status = _scrape(monkeypatch)
    assert response is None and status == 404, (
        "off by default, and 404 rather than 403 — a disabled endpoint "
        "should not confirm it exists"
    )


_BEARER = {"authorization": "Bearer s3cret"}


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_the_usual_spellings_of_on_all_work(monkeypatch, backend, value):
    facade.increment("agg_probe_total")
    response, status = _scrape(monkeypatch, enabled=value, token="s3cret",
                               headers=_BEARER)
    assert status is None and "agg_probe_total" in response.body.decode()


def test_a_token_is_required_once_one_is_set(monkeypatch, backend):
    _, status = _scrape(monkeypatch, enabled="1", token="s3cret")
    assert status == 401                                  # no header
    _, status = _scrape(monkeypatch, enabled="1", token="s3cret",
                        headers={"authorization": "Bearer wrong"})
    assert status == 401
    response, status = _scrape(monkeypatch, enabled="1", token="s3cret",
                               headers=_BEARER)
    assert status is None and response is not None


def test_enabled_without_a_token_serves_nothing(monkeypatch, backend):
    """THE COMBINATION THAT WAS OPEN. Enabled + no token skipped the compare
    entirely and served every FalkorDB node's ``host:port``, the governor's
    hold counts and the fleet's load to anyone who could reach the port — and
    the aggregation worker publishes this same app on 0.0.0.0 with no other
    HTTP server in front of it. It now reads exactly like "off": 404, not an
    empty 200 and not a 401 that confirms the endpoint is there."""
    _, status = _scrape(monkeypatch, enabled="1")
    assert status == 404
    _, status = _scrape(monkeypatch, enabled="1", headers=_BEARER)
    assert status == 404, "a token the deployment never set must not open it"


def test_the_scrape_carries_prometheus_content_type(monkeypatch, backend):
    response, _ = _scrape(monkeypatch, enabled="1", token="s3cret", headers=_BEARER)
    assert "version=0.0.4" in response.media_type


def test_enabled_but_never_installed_says_so(monkeypatch):
    """A process that skipped its startup wiring. Better than serving a
    convincing empty page that reads as "nothing is happening"."""
    monkeypatch.setattr(mp, "_INSTALLED", None)
    response, status = _scrape(monkeypatch, enabled="1", token="s3cret",
                               headers=_BEARER)
    assert status is None
    assert "not installed" in response.body.decode()


def test_the_graph_store_block_on_health_deps_stands_behind_the_same_door(monkeypatch):
    """``/health/deps`` is unauthenticated by design — it is where on-call
    looks — but it grew a ``graph_store`` block naming which nodes of which
    cluster are answering. That is the same class of internal state the scrape
    endpoint is opt-in for, so it reads through the same gate."""
    from backend.app.api.v1.endpoints import metrics as route

    for name, value in (("METRICS_ENABLED", "1"), ("METRICS_TOKEN", "s3cret")):
        monkeypatch.setenv(name, value)
    assert route.metrics_authorized(_request(_BEARER))
    assert not route.metrics_authorized(_request())
    monkeypatch.delenv("METRICS_TOKEN")
    assert not route.metrics_authorized(_request(_BEARER))


def test_every_emitting_process_installs_the_backend():
    """The governor and admission counters are raised in the WORKER, not the
    web tier. A worker without this installed counts nothing at all, and the
    endpoint would serve a page that looks healthy because it is empty."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    for rel in (
        "main.py",
        "services/aggregation/__main__.py",
        "services/aggregation/controlplane.py",
    ):
        src = (root / rel).read_text()
        assert "metrics_prometheus import install" in src, (
            f"{rel} does not install the metrics backend — every counter it "
            f"emits goes nowhere"
        )


# ── the worker's own scrape server ───────────────────────────────────────
#
# The worker raises the counters that matter most — every governor hold,
# every admission slot that failed open, every write-budget refusal — and it
# is the one process with no HTTP server. Counted in a registry nobody can
# reach is the same as not counted.


def test_the_worker_starts_nothing_when_the_switch_is_off(monkeypatch):
    from backend.app.services.aggregation.__main__ import _serve_metrics

    monkeypatch.delenv("METRICS_ENABLED", raising=False)
    assert asyncio.run(_serve_metrics()) is None


def test_the_worker_still_runs_when_its_metrics_port_cannot_be_served(monkeypatch):
    """Metrics are for watching the work, never a precondition for it. A
    worker that cannot bind — port taken, uvicorn absent, anything — must
    process jobs regardless."""
    import builtins

    from backend.app.services.aggregation import __main__ as worker_main

    monkeypatch.setenv("METRICS_ENABLED", "1")
    real_import = builtins.__import__

    def _no_uvicorn(name, *a, **k):
        if name == "uvicorn":
            raise ImportError("no uvicorn here")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_uvicorn)
    assert asyncio.run(worker_main._serve_metrics()) is None   # and never raises


# ── the request path, which had no series at all ─────────────────────────
#
# Every emit site in the codebase was in the worker or the control plane, so
# a web pod rendered a registry with nothing about the thing it spends its
# life doing: serving cached views and shedding when the store is unhappy.


def test_a_cache_read_is_counted_by_endpoint_and_outcome_without_the_tenant():
    """The Redis counters beside this one are per (workspace, source) and
    answer "is THIS source cached". The fleet's hit rate — whether 300 users
    are being served from cache at all — had no series. The tenant stays out
    of it: a workspace label would put a customer list in the scrape."""
    from backend.app.jobs import metrics as facade
    from backend.app.jobs import metrics_prometheus as mp
    from backend.app.services import graph_cache as gc

    registry = mp.PrometheusBackend()
    original = facade._backend
    facade.set_backend(registry)
    try:
        scope = gc.CacheScope(workspace_id="ws1", data_source_id="ds1")
        recorder = gc._CacheStatsRecorder()
        recorder.record(None, scope, gc.ENDPOINT_AGGREGATED, "hit")
        recorder.record(None, scope, gc.ENDPOINT_AGGREGATED, "hit")
        recorder.record(None, scope, gc.ENDPOINT_AGGREGATED, "miss")
    finally:
        facade.set_backend(original)

    out = registry.render()
    assert (f'graph_cache_reads_total{{endpoint="{gc.ENDPOINT_AGGREGATED}",'
            f'outcome="hit"}} 2') in out
    assert (f'graph_cache_reads_total{{endpoint="{gc.ENDPOINT_AGGREGATED}",'
            f'outcome="miss"}} 1') in out
    assert "ws1" not in out and "ds1" not in out


def test_the_breaker_and_the_shedding_reach_the_scrape():
    """Both are plain int dicts read through /health/deps, which answers
    "how is this pod" one pod at a time. They are sampled at scrape rather
    than emitted at each site: circuit.py sits below the app layer and
    imports nothing from it."""
    from backend.app.api.v1.endpoints import metrics as metrics_ep
    from backend.app.jobs import metrics_prometheus as mp
    from backend.app.providers.manager import provider_manager
    from backend.common.adapters import circuit

    registry = mp.PrometheusBackend()
    circuit._STATS["breaker_opens"] += 1
    provider_manager.stats["slots_shed_queue_full"] += 1
    try:
        metrics_ep._sample_process_counters(registry)
        out = registry.render()
        assert 'provider_breaker_events{event="breaker_opens"}' in out
        assert 'provider_manager_events{event="slots_shed_queue_full"}' in out
        # Absolute, not accumulated: two scrapes of an unchanged counter must
        # not read as twice the value.
        before = out
        metrics_ep._sample_process_counters(registry)
        assert registry.render() == before
    finally:
        circuit._STATS["breaker_opens"] -= 1
        provider_manager.stats["slots_shed_queue_full"] -= 1


def test_sampling_never_fails_a_scrape():
    class _Broken:
        def gauge_set(self, *a, **k):
            raise RuntimeError("registry is unhappy")

    from backend.app.api.v1.endpoints import metrics as metrics_ep

    metrics_ep._sample_process_counters(_Broken())    # and never raises


def test_an_ease_is_counted_where_it_is_decided():
    """The governor's holds had a counter and its eases — the graded step
    short of a hold, and the earlier warning — had only a log line."""
    import inspect

    from backend.app.providers.falkordb_materialize import AggregationPipeline

    src = inspect.getsource(AggregationPipeline._note_easing)
    assert "aggregation_governor_eases_total" in src
