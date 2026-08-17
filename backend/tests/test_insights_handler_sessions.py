"""Phase-2/3/4 tests for the insights handlers.

Core invariants:
* No Postgres session is held across outbound provider IO (the rule
  documented in ``backend/app/db/engine.py``) — each handler opens a
  short session, closes it, runs the provider fetch, then opens a
  second session for the upsert.
* Deep facet: one ``get_schema_stats`` pass per poll — counts derive
  from it, ``get_graph_schema`` receives it pre-fetched, ``get_stats``
  never runs.
* Counts facet: one bypass-cache ``get_stats``, partial upsert only —
  no schema scans, no ontology-dependent work.
* The worker resolves its per-job timeout from a cached single-row
  lookup, not a per-job full-table query, and the discovery outer
  timeout always exceeds the handler's inner live-call budget.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.config import resilience
from backend.insights_service import collector, worker as worker_mod
from backend.insights_service.config import StatsServiceConfig
from backend.insights_service.schemas import (
    DiscoveryJobEnvelope,
    StatsDeepJobEnvelope,
    StatsJobEnvelope,
)


def _config() -> StatsServiceConfig:
    return StatsServiceConfig(
        scheduler_tick_secs=30,
        default_interval_secs=900,
        min_interval_secs=60,
        worker_concurrency=4,
        sweep_concurrency=2,
        heavy_concurrency=1,
        purge_concurrency=1,
        probe_concurrency=4,
        max_per_graph=1,
        max_delivery_attempts=3,
        drain_timeout_secs=60,
        poll_timeout_default_secs=30.0,
        poll_timeout_large_secs=600.0,
        poll_large_threshold=100_000,
        dedup_ttl_secs=1200,
        health_port=8092,
    )


class _JsonModel:
    def model_dump_json(self, **_kw) -> str:
        return "{}"


def _wire_collector(monkeypatch, events: list[str], *, stored_row=None):
    """Shared fakes for the collector handlers. Returns
    (primes, upserts_full, upserts_counts, warms, schema_stats).
    ``stored_row`` is what the deep facet's stored-counts read finds."""

    class _FakeResult:
        def scalar_one_or_none(self):
            return stored_row

    class _FakeSession:
        async def get(self, _orm, _key):
            return SimpleNamespace(
                provider_id="prov1",
                last_polled_at=None, last_status=None, last_error=None,
                # The handler skips jobs for tombstoned data sources — the
                # fake row must carry the column or every job reads as an
                # AttributeError instead of "live source".
                deleted_at=None,
            )

        async def execute(self, _stmt):
            return _FakeResult()

    @asynccontextmanager
    async def fake_jobs_session():
        events.append("session_open")
        yield _FakeSession()
        events.append("session_close")

    schema_stats = SimpleNamespace(
        total_nodes=5,
        total_edges=3,
        entity_type_stats=[SimpleNamespace(id="dataset", count=5)],
        edge_type_stats=[SimpleNamespace(id="CONTAINS", count=3)],
        model_dump_json=lambda **_kw: "{}",
    )

    async def fake_get_schema_stats():
        events.append("io:get_schema_stats")
        return schema_stats

    async def fake_get_stats(bypass_cache=False):
        events.append(f"io:get_stats(bypass={bypass_cache})")
        return {
            "nodeCount": 5, "edgeCount": 3,
            "entityTypeCounts": {"dataset": 5},
            "edgeTypeCounts": {"CONTAINS": 3},
        }

    primes: list[dict] = []

    async def fake_prime(payload):
        primes.append(payload)

    provider = SimpleNamespace(
        get_schema_stats=fake_get_schema_stats,
        get_stats=fake_get_stats,
        prime_stats_cache=fake_prime,
    )

    async def fake_graph_schema(stats=None, ontology=None):
        events.append("io:get_graph_schema")
        # Must receive the pre-fetched objects — never re-fetch.
        assert stats is schema_stats
        assert ontology is not None
        return _JsonModel()

    engine = SimpleNamespace(
        provider=provider,
        get_ontology_metadata=AsyncMock(return_value=_JsonModel()),
        get_graph_schema=fake_graph_schema,
    )

    monkeypatch.setattr(collector, "get_jobs_session", fake_jobs_session)
    monkeypatch.setattr(
        collector.ContextEngine, "for_workspace", AsyncMock(return_value=engine),
    )

    @asynccontextmanager
    async def noop_gate(*_a, **_kw):
        yield

    monkeypatch.setattr(collector.admission, "gate", noop_gate)

    upserts_full: list[dict] = []
    upserts_counts: list[dict] = []

    async def fake_upsert(**kw):
        events.append("upsert")
        upserts_full.append(kw)

    async def fake_upsert_counts(**kw):
        events.append("upsert")
        upserts_counts.append(kw)

    monkeypatch.setattr(collector, "upsert_data_source_stats", fake_upsert)
    monkeypatch.setattr(
        collector, "upsert_data_source_stats_counts", fake_upsert_counts,
    )

    warms: list[dict] = []
    from backend.insights_service import cache_warmer
    monkeypatch.setattr(
        cache_warmer, "schedule_warm",
        lambda **kw: warms.append(kw) or None,
    )
    return primes, upserts_full, upserts_counts, warms, schema_stats


def _envelope() -> StatsJobEnvelope:
    return StatsJobEnvelope(
        data_source_id="ds1", workspace_id="ws1",
        enqueued_at=datetime.now(timezone.utc),
    )


def _assert_session_discipline(events: list[str], expected_opens: int = 2) -> None:
    """Every session fully closed before ANY provider IO; upsert inside
    a session opened after the IO finished."""
    first_io = min(i for i, e in enumerate(events) if e.startswith("io:"))
    last_io = max(i for i, e in enumerate(events) if e.startswith("io:"))
    closes_before_io = [i for i, e in enumerate(events) if e == "session_close" and i < first_io]
    assert closes_before_io, events
    assert events.index("upsert") > last_io, events
    assert events.count("session_open") == expected_opens


@pytest.mark.asyncio
async def test_deep_facet_one_fetch_and_session_discipline(monkeypatch) -> None:
    events: list[str] = []
    primes, upserts_full, upserts_counts, warms, _ = _wire_collector(monkeypatch, events)

    await collector.collect_deep(_envelope())

    # One-fetch: exactly one schema-stats scan set, zero get_stats calls
    # (no stored row → no change-detection probe either).
    assert events.count("io:get_schema_stats") == 1
    assert not any(e.startswith("io:get_stats") for e in events)
    # Deep opens 3 short sessions: context, stored-counts read, upsert.
    _assert_session_discipline(events, expected_opens=3)

    # Derived counts flow to the provider-cache prime and the full upsert.
    expected_payload = {
        "nodeCount": 5,
        "edgeCount": 3,
        "entityTypeCounts": {"dataset": 5},
        "edgeTypeCounts": {"CONTAINS": 3},
    }
    assert primes == [expected_payload]
    assert upserts_counts == []
    assert len(upserts_full) == 1
    assert upserts_full[0]["node_count"] == 5
    assert json.loads(upserts_full[0]["entity_type_counts"]) == {"dataset": 5}
    assert json.loads(upserts_full[0]["edge_type_counts"]) == {"CONTAINS": 3}
    assert warms == [{"ws_id": "ws1", "ds_id": "ds1", "node_count": 5}]


@pytest.mark.asyncio
async def test_deep_facet_skips_scans_when_counts_unchanged(monkeypatch) -> None:
    """The 'never re-profile an unchanged graph' invariant: when the
    cheap counts probe matches the stored row, the deep facet must skip
    the samples/tags scans + schema rebuild and only advance freshness."""
    events: list[str] = []
    stored = SimpleNamespace(
        node_count=5, edge_count=3,
        entity_type_counts='{"dataset": 5}',
        edge_type_counts='{"CONTAINS": 3}',
        schema_stats='{"totalNodes": 5}',
        # The unchanged-counts short-circuit also requires a non-empty cached
        # graph_schema (an ontology change clears it to force a rebuild).
        graph_schema='{"nodes": []}',
    )
    primes, upserts_full, upserts_counts, warms, _ = _wire_collector(
        monkeypatch, events, stored_row=stored,
    )
    touched: list[str] = []

    async def fake_touch(session, ds_id):
        touched.append(ds_id)

    monkeypatch.setattr(collector, "touch_schema_freshness", fake_touch)

    await collector.collect_deep(_envelope())

    assert events.count("io:get_stats(bypass=True)") == 1  # the probe
    assert "io:get_schema_stats" not in events  # heavy scans skipped
    assert "io:get_graph_schema" not in events
    assert upserts_full == [] and upserts_counts == [] and primes == []
    assert touched == ["ds1"]  # freshness advanced without a rewrite


@pytest.mark.asyncio
async def test_counts_facet_bypasses_cache_and_partial_upserts(monkeypatch) -> None:
    events: list[str] = []
    primes, upserts_full, upserts_counts, warms, _ = _wire_collector(monkeypatch, events)

    await collector.collect_counts(_envelope())

    # Counts facet: one bypass-cache get_stats, NO schema scans, NO
    # ontology-dependent work, partial upsert only.
    assert events.count("io:get_stats(bypass=True)") == 1
    assert "io:get_schema_stats" not in events
    assert "io:get_graph_schema" not in events
    _assert_session_discipline(events)

    assert upserts_full == []
    assert len(upserts_counts) == 1
    assert upserts_counts[0]["node_count"] == 5
    assert "schema_stats" not in upserts_counts[0]
    # get_stats write-through primes the provider cache itself; the
    # counts handler must not prime again.
    assert primes == []
    assert warms == [{"ws_id": "ws1", "ds_id": "ds1", "node_count": 5}]


@pytest.mark.asyncio
async def test_worker_ds_meta_is_cached_across_dispatches(monkeypatch) -> None:
    """One outer-joined single-row query serves scope key AND timeout
    node count for N dispatches of the same data source — the old code
    full-table-scanned data_source_stats on every job."""
    calls: list[str] = []

    class _Result:
        def first(self):
            return ("prov1", "graph1", 250_000)

    class _FakeSession:
        async def execute(self, _stmt):
            calls.append("db_query")
            return _Result()

    @asynccontextmanager
    async def fake_readonly_session():
        yield _FakeSession()

    monkeypatch.setattr(worker_mod, "get_readonly_session", fake_readonly_session)
    monkeypatch.setattr(worker_mod, "get_redis", lambda: SimpleNamespace())

    consumer = worker_mod.InsightsJobConsumer(_config())
    consumer._scope_key_cache.clear()

    envelope = _envelope()
    for _ in range(5):
        scope_key = await consumer._resolve_scope_lock_key(envelope)
        timeout, bucket = await consumer._resolve_timeout_and_bucket(envelope)
        assert scope_key == "prov1:graph1"
        assert bucket == "large"
        assert timeout == 600.0  # node_count 250k >= large threshold 100k

    assert calls == ["db_query"], f"expected exactly one DB lookup, got {calls}"
    consumer._scope_key_cache.clear()


@pytest.mark.asyncio
async def test_worker_discovery_outer_timeout_exceeds_inner_budget(monkeypatch) -> None:
    """Regression for the 10s-outer-kills-35s-inner default mismatch:
    the worker's discovery job timeout must always sit above the
    handler's inner live-call budget (both derive from resilience.py)."""
    monkeypatch.setattr(worker_mod, "get_redis", lambda: SimpleNamespace())
    consumer = worker_mod.InsightsJobConsumer(_config())

    envelope = DiscoveryJobEnvelope(
        provider_id="p1", asset_name="g1",
        enqueued_at=datetime.now(timezone.utc),
    )
    timeout, bucket = await consumer._resolve_timeout_and_bucket(envelope)
    assert bucket == "n/a"
    assert timeout > resilience.DISCOVERY_LIVE_TIMEOUT_SECS


# ── Phase 4: lanes ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_lane_accounting_spawn_and_reap(monkeypatch) -> None:
    """Spawn increments the stream's lane counter; reap decrements it.
    A leaked lane slot silently halves throughput, so this is the
    invariant the health payload's `lanes` gauge watches."""
    import asyncio

    from backend.insights_service.redis_streams import (
        PURGE_STREAM, STATS_DEEP_STREAM, STATS_STREAM,
    )

    monkeypatch.setattr(worker_mod, "get_redis", lambda: SimpleNamespace())
    consumer = worker_mod.InsightsJobConsumer(_config())
    consumer._scope_key_cache.clear()

    fields = _envelope().to_stream_fields()
    deep_fields = StatsDeepJobEnvelope(
        data_source_id="ds2", workspace_id="ws1",
        enqueued_at=datetime.now(timezone.utc),
    ).to_stream_fields()

    consumer._spawn(STATS_STREAM, "1-1", fields)
    consumer._spawn(STATS_DEEP_STREAM, "1-2", deep_fields)
    assert consumer.lane_active_snapshot() == {"fast": 1, "heavy": 1}
    assert consumer._lane_free_slots() == {
        "fast": 3, "sweep": 2, "heavy": 0, "purge": 1, "probe": 4,
    }
    assert PURGE_STREAM.lane == "purge"

    # Cancel the spawned tasks and reap — counters must return to zero.
    for task in consumer._active_tasks.values():
        task.cancel()
    await asyncio.gather(
        *consumer._active_tasks.values(), return_exceptions=True,
    )
    consumer._reap_done_tasks()

    assert consumer.lane_active_snapshot() == {"fast": 0, "heavy": 0}
    assert consumer._lane_free_slots() == {
        "fast": 4, "sweep": 2, "heavy": 1, "purge": 1, "probe": 4,
    }
    consumer._scope_key_cache.clear()


# ── Phase 4: event-driven freshness ─────────────────────────────────

@pytest.mark.asyncio
async def test_mark_stats_changed_cooldown_and_redis_tolerance(monkeypatch) -> None:
    from backend.insights_service import enqueue as enqueue_mod

    enqueued: list[tuple] = []

    async def fake_safe(ds_id, ws_id, **_kw):
        enqueued.append((ds_id, ws_id))
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_stats_job_safe", fake_safe)

    cooldown_state = {"held": False}

    class _FakeRedis:
        async def set(self, key, _val, nx=False, ex=None):
            # The top-level dirty flag is set unconditionally on every
            # write; only the cooldown key drives the coalescing gate.
            if not str(key).startswith("insights:stats:cooldown:"):
                return True
            if cooldown_state["held"]:
                return None
            cooldown_state["held"] = True
            return True

    monkeypatch.setattr(enqueue_mod, "get_redis", lambda: _FakeRedis())

    # First write wins the cooldown and enqueues; burst writes coalesce.
    await enqueue_mod.mark_stats_changed("ds1", "ws1")
    await enqueue_mod.mark_stats_changed("ds1", "ws1")
    await enqueue_mod.mark_stats_changed("ds1", "ws1")
    assert enqueued == [("ds1", "ws1")]

    # Redis down — must swallow, not raise, and not enqueue.
    class _DeadRedis:
        async def set(self, *_a, **_kw):
            raise ConnectionError("redis down")

    monkeypatch.setattr(enqueue_mod, "get_redis", lambda: _DeadRedis())
    await enqueue_mod.mark_stats_changed("ds2", "ws1")  # must not raise
    assert enqueued == [("ds1", "ws1")]


def test_deep_envelope_wire_format_roundtrip() -> None:
    from backend.insights_service.schemas import parse_envelope

    env = StatsDeepJobEnvelope(
        data_source_id="ds1", workspace_id="ws1",
        enqueued_at=datetime.now(timezone.utc),
    )
    fields = env.to_stream_fields()
    assert fields["kind"] == "stats_deep"
    parsed = parse_envelope(fields)
    assert isinstance(parsed, StatsDeepJobEnvelope)
    assert parsed.scope_key == "ds1"
    # A pre-split stats_poll message still parses (wire compat).
    legacy = parse_envelope(_envelope().to_stream_fields())
    assert isinstance(legacy, StatsJobEnvelope)


def test_claim_ttl_scales_with_node_count() -> None:
    from backend.insights_service.scheduler import _claim_ttl

    cfg = _config()
    # Small graph: 2×30s clamped up to the 180s floor.
    assert _claim_ttl(cfg, 500) == 180
    # Large graph: 2×600s clamped down to the 1200s ceiling.
    assert _claim_ttl(cfg, 500_000) == 1200
    # Unknown size (no stats row yet) behaves like small.
    assert _claim_ttl(cfg, None) == 180


@pytest.mark.asyncio
async def test_probe_gets_a_short_fixed_timeout_not_the_large_graph_budget():
    """A probe is constant-time work, so it must never inherit the
    size-adaptive poll budget.

    ``ProbeJobEnvelope`` subclasses ``StatsJobEnvelope``, so without an explicit
    branch it falls through to the large-graph pivot and a probe on a big (or
    not-yet-measured) graph is allowed to hang for ten minutes — holding a slot
    in a lane sized for millisecond work.
    """
    from backend.insights_service.schemas import ProbeJobEnvelope

    consumer = worker_mod.InsightsJobConsumer(_config())
    envelope = ProbeJobEnvelope(
        data_source_id="ds-1", workspace_id="ws-1",
        enqueued_at=datetime.now(timezone.utc),
    )
    timeout, bucket = await consumer._resolve_timeout_and_bucket(envelope)

    assert timeout <= 60, f"probe budget should be seconds, got {timeout}"
    assert timeout != _config().poll_timeout_large_secs
    assert bucket == "probe"
