"""Metrics, and the properties that make them trustworthy.

Instrumentation is easy to ship broken because nothing downstream
complains: a label that never resolves, a counter that misses the
failure path, a scrape that counts itself. Each of those produces
numbers that look fine and mean something other than what the reader
assumes — which is worse than no numbers, because decisions get made on
them.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI
from starlette.responses import PlainTextResponse

from backend.app.observability.metrics import http_requests_total
from backend.app.observability.request_metrics import RequestMetricsMiddleware


def _count(method: str, route: str, status: str) -> float:
    """Current value of one counter series, 0.0 if it has never been set."""
    value = http_requests_total.labels(
        method=method, route=route, status=status,
    )._value.get()
    return value or 0.0


def _app() -> FastAPI:
    """FastAPI, not bare Starlette, and the difference is the point.

    The route-template label reads ``scope["route"]``, which **FastAPI**
    populates during routing; plain Starlette sets ``scope["endpoint"]``
    and no ``route``. A test built on bare Starlette would report
    ``<unmatched>`` for every request and "prove" the labelling broken
    while production worked fine.
    """
    app = FastAPI()
    app.add_middleware(RequestMetricsMiddleware)
    return app


async def _get(app: FastAPI, path: str):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://t",
    ) as client:
        return await client.get(path)


async def test_counts_by_route_template_not_by_path():
    """A label whose cardinality grows with customer data is how a
    metrics backend gets taken down by its own instrumentation."""
    app = _app()

    @app.get("/ws/{ws_id}/things")
    async def things(ws_id: str):
        return {"ok": True}

    before = _count("GET", "/ws/{ws_id}/things", "200")

    await _get(app, "/ws/ws_alpha/things")
    await _get(app, "/ws/ws_beta/things")
    await _get(app, "/ws/ws_gamma/things")

    assert _count("GET", "/ws/{ws_id}/things", "200") == before + 3
    # Three workspaces must not have minted three series.
    assert _count("GET", "/ws/ws_alpha/things", "200") == 0.0


async def test_unmatched_paths_collapse_to_one_series():
    """404 paths are crawler-controlled — one bucket, not one each."""
    app = _app()

    @app.get("/known")
    async def known():
        return {"ok": True}

    before = _count("GET", "<unmatched>", "404")

    await _get(app, "/nope-1")
    await _get(app, "/nope-2")

    assert _count("GET", "<unmatched>", "404") == before + 2


async def test_a_failing_handler_is_still_counted():
    """A request that only counts when it succeeds makes an unhealthy
    fleet look quiet — the opposite of what the metric is for."""

    app = _app()

    @app.get("/boom")
    async def boom():
        raise RuntimeError("handler exploded")

    before = _count("GET", "/boom", "0")

    with pytest.raises(RuntimeError):
        await _get(app, "/boom")

    # Status 0, not an invented 500: the response never started, and
    # guessing would conflate a crash with a client hang-up.
    assert _count("GET", "/boom", "0") == before + 1


async def test_the_scrape_does_not_count_itself():
    """At 15s intervals a scrape is a real share of an idle fleet's
    request rate — precisely the quantity being measured."""
    app = _app()

    @app.get("/internal/metrics")
    async def scrape():
        return PlainTextResponse("ok")

    before = _count("GET", "/internal/metrics", "200")

    await _get(app, "/internal/metrics")

    assert _count("GET", "/internal/metrics", "200") == before


# ── The endpoint ──────────────────────────────────────────────────────


@pytest.fixture
def metrics_app(monkeypatch):
    monkeypatch.setenv("INTERNAL_METRICS_ENABLED", "true")
    from backend.app.observability.endpoint import router

    api = FastAPI()
    api.include_router(router)
    return api


async def test_endpoint_serves_prometheus_exposition(metrics_app):
    async with AsyncClient(
        transport=ASGITransport(app=metrics_app), base_url="http://t",
    ) as client:
        resp = await client.get("/internal/metrics")

    assert resp.status_code == 200
    assert "text/plain" in resp.headers["content-type"]
    # The exposition format's own preamble — proves this is machine
    # format rather than the JSON endpoint next door.
    assert "# HELP" in resp.text
    assert "# TYPE" in resp.text


async def test_endpoint_declares_what_the_reading_covers(metrics_app):
    """Without this a number is ambiguous between 'the fleet' and
    'whichever worker answered', and those differ by the worker count."""
    async with AsyncClient(
        transport=ASGITransport(app=metrics_app), base_url="http://t",
    ) as client:
        resp = await client.get("/internal/metrics")

    assert resp.headers["X-Metrics-Scope"] in ("fleet", "single-process")


async def test_endpoint_is_off_unless_explicitly_enabled(monkeypatch):
    monkeypatch.delenv("INTERNAL_METRICS_ENABLED", raising=False)
    from fastapi import FastAPI

    from backend.app.observability.endpoint import router

    api = FastAPI()
    api.include_router(router)

    async with AsyncClient(
        transport=ASGITransport(app=api), base_url="http://t",
    ) as client:
        resp = await client.get("/internal/metrics")

    assert resp.status_code == 404


# ── Readiness ─────────────────────────────────────────────────────────


def test_metrics_answer_while_the_app_is_still_starting():
    """A degraded start is the moment you most want pool and request
    numbers; gating them behind readiness makes that window invisible."""
    from backend.app.main import _TimeoutMiddleware

    assert _TimeoutMiddleware._is_live_gate_exempt("/internal/metrics")
    assert _TimeoutMiddleware._is_live_gate_exempt("/internal/metrics/db")
    # Still gated, as a control — the exemption is specific, not broad.
    assert not _TimeoutMiddleware._is_live_gate_exempt("/api/v1/views")


def test_the_counter_is_the_outermost_middleware():
    """Only the outermost layer sees the requests the others refuse.

    A CSRF rejection and a 503 from the readiness gate are requests, and
    they are the ones most worth counting — a fleet failing every
    request would otherwise be indistinguishable from a fleet nobody is
    using. ``add_middleware`` inserts at position 0, so registration
    order is the reverse of entry order and index 0 is outermost; a
    future ``add_middleware`` call placed after this one would quietly
    take the position and blind the counter to that layer's rejections.
    """
    from backend.app.main import app

    assert app.user_middleware[0].cls is RequestMetricsMiddleware


# ── DB query counter ──────────────────────────────────────────────────


async def test_db_queries_are_counted():
    """Queries-per-request is what makes the per-request taxes visible.

    Two of them — the identity lookup on every authenticated request and
    the context-engine resolution before every graph request — cost
    nothing in request count and several queries each, so request
    metrics alone would show a change that removes them as having done
    nothing at all.

    Tested against a throwaway engine rather than the ``db_session``
    fixture, because that fixture builds its own engine directly
    (``conftest.py:131``) instead of going through
    ``db/engine._get_engine`` — so the production listener is never
    attached to it, and a test written against it would assert nothing.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    from backend.app.db.engine import _count_queries_on
    from backend.app.observability.metrics import db_queries_total

    def counted() -> float:
        value = db_queries_total.labels(role="test-role")._value.get()
        return value or 0.0

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        _count_queries_on(engine, "test-role")
        before = counted()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            await conn.execute(text("SELECT 1"))
        assert counted() == before + 2
    finally:
        await engine.dispose()


# ── Multiple workers ──────────────────────────────────────────────────
#
# Production runs gunicorn with several workers, and workers are not
# permanent — reloads, --max-requests recycling, timeout kills. In
# multiprocess mode each worker's metrics live in files named after its
# pid, and nothing in that scheme notices a death, so a fleet-wide
# reading keeps counting workers that no longer exist. These tests cover
# the two places that goes wrong: the gauge mode, and the master hook.


class _FakeLog:
    def info(self, *a, **k): ...
    def warning(self, *a, **k): ...


class _FakeServer:
    log = _FakeLog()


class _FakeWorker:
    def __init__(self, pid: int):
        self.pid = pid


def _load_hooks():
    """Load ``gunicorn_conf.py`` from disk, the way gunicorn does.

    Not imported as ``backend.app.observability.something``, because the
    config file is read by the *master* before the application is
    loaded — and deliberately imports nothing from the app package, so
    that a config-load failure can never be caused by application code.
    Testing it by path is testing the artefact that actually runs.
    """
    import importlib.util
    from pathlib import Path

    config = Path(__file__).resolve().parents[1] / "gunicorn_conf.py"
    spec = importlib.util.spec_from_file_location("_gunicorn_conf_probe", config)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_gauge_reports_the_living(monkeypatch):
    """A gauge is a *current* value, so it must exclude dead workers.

    ``max`` and ``sum`` aggregate every file in the directory, dead pids
    included. A pool that once peaked at 0.95 before its worker was
    recycled would pin ``db_pool_utilisation`` at 0.95 for the life of
    the directory — the gauge silently stops answering "how saturated is
    it now" and starts answering "how saturated has it ever been", which
    reads identically and is never right. ``mark_process_dead`` only
    cleans up the ``live*`` modes, so this is also what makes the
    ``child_exit`` hook below effective.
    """
    from prometheus_client import Gauge

    from backend.app.observability import metrics

    gauges = [
        (name, obj)
        for name, obj in vars(metrics).items()
        if isinstance(obj, Gauge)
    ]
    assert gauges, "no gauges found — this test would pass vacuously"

    for name, gauge in gauges:
        mode = gauge._multiprocess_mode
        assert mode.startswith("live"), (
            f"{name} uses multiprocess_mode={mode!r}, which keeps counting "
            f"workers that have exited"
        )


def _write_metrics_as_worker(pid: int, directory: str, subscribers: float) -> None:
    """Produce the on-disk metric files a worker with this pid would.

    ``values.ValueClass`` is read when a metric is constructed, so
    pinning it to a fixed identifier is how a single test process
    fabricates two workers' files.
    """
    from prometheus_client import CollectorRegistry, Counter, Gauge, values

    original = values.ValueClass
    values.ValueClass = values.MultiProcessValue(lambda: pid)
    try:
        registry = CollectorRegistry()
        gauge = Gauge(
            "test_worker_subscribers",
            "held connections",
            registry=registry,
            multiprocess_mode="livesum",
        )
        gauge.set(subscribers)
        counter = Counter(
            "test_worker_requests",
            "requests served",
            registry=registry,
        )
        counter.inc(10)
    finally:
        values.ValueClass = original


def _collect(directory: str) -> dict:
    from prometheus_client import CollectorRegistry, multiprocess

    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry, path=directory)
    return {
        sample.name: sample.value
        for metric in registry.collect()
        for sample in metric.samples
    }


def test_child_exit_stops_a_dead_worker_inflating_the_fleet_total(tmp_path, monkeypatch):
    """The failure this hook prevents is a number that only ever climbs.

    ``change_feed_subscribers`` is a ``livesum``: a worker holding 40
    stream connections when it is killed leaves those 40 in the fleet
    total permanently. After a week of rolling restarts the metric added
    to count held connections is counting every connection ever held,
    and it looks plausible the whole time.
    """
    hooks = _load_hooks()
    directory = str(tmp_path)
    monkeypatch.setenv("PROMETHEUS_MULTIPROC_DIR", directory)

    _write_metrics_as_worker(pid=90001, directory=directory, subscribers=40)
    _write_metrics_as_worker(pid=90002, directory=directory, subscribers=2)

    assert _collect(directory)["test_worker_subscribers"] == 42

    hooks.child_exit(_FakeServer(), _FakeWorker(90001))

    collected = _collect(directory)
    assert collected["test_worker_subscribers"] == 2
    # Requests the dead worker really did serve stay counted. Retiring
    # them would make a counter go backwards, which a counter must never
    # do — Prometheus reads that as a reset and imputes a whole new run.
    assert collected["test_worker_requests_total"] == 20


def test_on_starting_clears_a_previous_runs_files(tmp_path, monkeypatch):
    """Pids get reused. A fresh worker drawing a dead one's pid from the
    last container would adopt its counter values, and the scrape would
    show a jump no request caused."""
    hooks = _load_hooks()
    directory = str(tmp_path)
    monkeypatch.setenv("PROMETHEUS_MULTIPROC_DIR", directory)

    _write_metrics_as_worker(pid=90003, directory=directory, subscribers=7)
    assert list(tmp_path.glob("*.db"))

    hooks.on_starting(_FakeServer())

    assert not list(tmp_path.glob("*.db"))


def test_hooks_do_nothing_when_multiprocess_is_off(tmp_path, monkeypatch):
    """Single-process runs — local dev, tests, the upgrade job — never
    set the variable, and the hooks load in every one of them."""
    hooks = _load_hooks()
    monkeypatch.delenv("PROMETHEUS_MULTIPROC_DIR", raising=False)
    stray = tmp_path / "counter_1.db"
    stray.write_bytes(b"")

    hooks.on_starting(_FakeServer())
    hooks.child_exit(_FakeServer(), _FakeWorker(90004))

    assert stray.exists()


def test_the_gunicorn_config_exposes_the_hooks():
    """Gunicorn discovers hooks by name at module scope in the config
    file. A rename inside the implementation module is invisible to it —
    the config keeps loading, the hooks just never run again."""
    import importlib.util
    from pathlib import Path

    config = Path(__file__).resolve().parents[1] / "gunicorn_conf.py"
    assert config.exists(), f"{config} is referenced by Dockerfile.viz --config"

    spec = importlib.util.spec_from_file_location("_gunicorn_conf_probe", config)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert callable(getattr(module, "on_starting", None))
    assert callable(getattr(module, "child_exit", None))


# ── Nested routers ────────────────────────────────────────────────────


async def test_label_is_the_full_path_under_nested_routers():
    """The shape production actually uses, and the one that was broken.

    FastAPI 0.141 / Starlette 1.6 stopped flattening ``include_router``
    and nest a ``_IncludedRouter`` per prefix instead. The innermost
    router writes ``scope["route"]``, so what lands there is the route's
    path *relative to its own router* — and ``root_path`` stays empty,
    so there is nothing else in the scope that obviously carries the
    prefix.

    The original test for this used a route declared straight on the app
    with its full path inline. That is the one arrangement where the
    relative template and the full path are the same string, so it
    passed against the bug — while every real endpoint, all of which
    arrive through ``app.include_router(api_router, prefix="/api/v1")``,
    was labelled by its last segment alone.

    The failure that causes is not extra series, it is **merged** ones:
    two different routers' ``/config`` endpoints summing into one line
    that reads like a single endpoint.
    """
    from fastapi import APIRouter

    inner = APIRouter()

    @inner.get("/config")
    async def config():
        return {"ok": True}

    @inner.get("/items/{item_id}")
    async def item(item_id: str):
        return {"ok": True}

    api = APIRouter()
    api.include_router(inner, prefix="/announcements")

    app = _app()
    app.include_router(api, prefix="/api/v1")

    before_cfg = _count("GET", "/api/v1/announcements/config", "200")
    before_item = _count("GET", "/api/v1/announcements/items/{item_id}", "200")

    await _get(app, "/api/v1/announcements/config")
    await _get(app, "/api/v1/announcements/items/abc")
    await _get(app, "/api/v1/announcements/items/xyz")

    assert _count("GET", "/api/v1/announcements/config", "200") == before_cfg + 1
    assert _count("GET", "/api/v1/announcements/items/{item_id}", "200") == before_item + 2

    # The bug's signature: the bare last segment must never be a series,
    # because that is what two unrelated routers would collide on.
    assert _count("GET", "/config", "200") == 0.0
    # And the concrete ids must not have minted series of their own.
    assert _count("GET", "/api/v1/announcements/items/abc", "200") == 0.0
