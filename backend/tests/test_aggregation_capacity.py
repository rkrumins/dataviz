"""The capacity view: the write budget's own reading and arithmetic,
assembled for people.

Pure helpers first (limits precedence, a shard row, the pre-flight verdicts),
then the sweep with fakes for the four collaborators — sources, providers,
owning-node lookup, the reading — so the tests pin what the sweep promises:
one INFO per node, a coarse reason for everything it could not place, a
deadline that leaves the rest unresolved, never an exception.
"""
from __future__ import annotations

import asyncio
import types

import pytest

from backend.app.providers.shard_capacity import ShardMemory
from backend.app.services.aggregation import capacity as cap


def _run(coro):
    return asyncio.run(coro)


GB = 2 ** 30


def _reading(endpoint="10.0.0.1:6379", used=10 * GB, maxmemory=40 * GB, source="measured", note=None):
    return ShardMemory(endpoint, used, maxmemory, "noeviction", 0.0, source, note)


# ── limits ──────────────────────────────────────────────────────────────


def test_limits_prefer_the_stored_defaults_and_label_where_each_came_from(monkeypatch):
    monkeypatch.delenv("AGGREGATION_SHARD_RESERVE_PCT", raising=False)
    limits = cap.effective_limits({"shard_reserve_pct": 10, "materialize_fine_pairs": True})
    assert (limits.shard_reserve_pct.value, limits.shard_reserve_pct.source) == (10, "global")
    assert (limits.bytes_per_edge.value, limits.bytes_per_edge.source) == (512, "default")
    assert (limits.max_materialized_edges.value, limits.max_materialized_edges.source) == (None, "default")
    assert (limits.rollup_storage.value, limits.rollup_storage.source) == ("true", "global")
    assert limits.static_cap == 25_000_000          # env default: no ceiling set
    assert limits.max_cube_edges == 8_000_000 and limits.budget_recheck_edges == 1_000_000


def test_an_explicit_ceiling_is_the_static_cap_too():
    limits = cap.effective_limits({"max_materialized_edges": 2_000_000, "materialize_fine_pairs": "auto"})
    assert limits.max_materialized_edges.value == 2_000_000
    assert limits.static_cap == 2_000_000
    assert limits.rollup_storage.value == "auto"


# ── one shard, one source ───────────────────────────────────────────────


def test_a_measured_shard_row_carries_the_pipeline_arithmetic():
    limits = cap.effective_limits({"shard_reserve_pct": 20})
    row = cap.shard_row(_reading(), limits)
    assert row.measurable and row.governed_by == "shard" and row.why_not is None
    assert row.reserve_bytes == 8 * GB and row.available_bytes == 22 * GB
    assert row.allowed_growth_edges == 22 * GB // 512
    assert row.used_pct == 25.0


def test_a_shard_row_and_the_preflight_take_what_running_rebuilds_hold_off_the_free_memory():
    limits = cap.effective_limits({"shard_reserve_pct": 20})
    row = cap.shard_row(_reading(), limits, reserved=(2 * GB, 1))
    assert (row.available_bytes, row.allowed_growth_edges) == (20 * GB, 20 * GB // 512)
    assert (row.reserved_bytes, row.reserved_by_jobs) == (2 * GB, 1)
    assert (cap.shard_row(_reading(), limits).reserved_bytes, cap.shard_row(_reading(), limits).reserved_by_jobs) == (0, 0)
    # 4 GB free; 8M new cells at 512 B fit with the margin — not once 2 GB is held.
    no_reserve = cap.effective_limits({"shard_reserve_pct": 0})
    plain = cap.full_detail_preflight(_reading(used=36 * GB), no_reserve, edge_count=0, estimate=8_000_000, bytes_per_edge=512)
    held = cap.full_detail_preflight(_reading(used=36 * GB), no_reserve, edge_count=0, estimate=8_000_000, bytes_per_edge=512, reserved=(2 * GB, 1))
    assert plain.verdict == "fits" and held.verdict == "short" and held.blocked_by == "shard"


def test_an_unmeasurable_shard_row_says_why_and_falls_to_the_static_rule():
    limits = cap.effective_limits({})
    row = cap.shard_row(_reading(maxmemory=0), limits)
    assert not row.measurable and row.governed_by == "static"
    assert row.why_not == "the shard reports no maxmemory"
    assert row.allowed_growth_edges is None and row.static_cap == 25_000_000


def test_a_source_row_uses_the_calibrated_figure_when_the_last_run_measured_one():
    limits = cap.effective_limits({})
    ds = types.SimpleNamespace(id="ds-1", label="Snowflake", workspace_id="ws", provider_id="p",
                               projection_mode=None, aggregation_status="ready",
                               aggregation_edge_count=5)
    row = cap.source_row(
        ds, provider_name="Falkor", graph_key="g",
        state={"aggregation_edge_count": 1_000_000, "observed_bytes_per_edge": 900},
        stats={"cube_estimate": 3_000_000, "regime": "boundary"},
        failure={"category": "write_budget"}, limits=limits,
    )
    assert (row.bytes_per_edge, row.bytes_per_edge_source) == (900, "calibrated")
    assert row.footprint_bytes == 900_000_000 and row.edge_count == 1_000_000
    assert (row.last_cube_estimate, row.last_regime, row.last_failure_category) == (3_000_000, "boundary", "write_budget")
    plain = cap.source_row(ds, provider_name=None, graph_key="g", state={}, stats={}, failure={}, limits=limits)
    assert (plain.bytes_per_edge, plain.bytes_per_edge_source, plain.edge_count) == (512, "default", 5)


# ── pre-flight ──────────────────────────────────────────────────────────


def test_full_detail_preflight_is_unknown_without_a_prior_run():
    limits = cap.effective_limits({})
    pf = cap.full_detail_preflight(_reading(), limits, edge_count=0, estimate=None, bytes_per_edge=512)
    assert pf.verdict == "unknown" and pf.estimate_edges is None
    auto = cap.auto_preflight(limits, pf)
    assert auto.never_refused and auto.would_store_cube is None and auto.fallback == "diagonal"


def test_full_detail_preflight_charges_growth_over_what_the_graph_holds():
    limits = cap.effective_limits({"shard_reserve_pct": 0})
    # 4 GiB free; the estimate is 10M cells of which 2M already exist → 8M
    # new at 512 B ≈ 3.8 GiB, which fits (and the 25% margin has slack).
    pf = cap.full_detail_preflight(
        _reading(used=36 * GB), limits, edge_count=2_000_000, estimate=10_000_000, bytes_per_edge=512,
    )
    assert pf.verdict == "fits" and pf.growth_edges == 8_000_000
    assert pf.needed_bytes == 8_000_000 * 512
    assert cap.auto_preflight(limits, pf).would_store_cube is False   # over Auto's 8M ceiling


def test_full_detail_preflight_names_the_shortfall():
    limits = cap.effective_limits({"shard_reserve_pct": 0})
    pf = cap.full_detail_preflight(
        _reading(used=40 * GB - 1024), limits, edge_count=0, estimate=1_000, bytes_per_edge=512,
    )
    assert pf.verdict == "short" and pf.blocked_by == "shard"
    assert pf.shortfall_bytes == 1_000 * 512 - 1024 and pf.shortfall_edges > 0


# ── the sweep ───────────────────────────────────────────────────────────


def _ds(id, *, provider="p1", graph="g", ws="ws", mode=None, status="ready", edges=0):
    return types.SimpleNamespace(
        id=id, label=id.upper(), workspace_id=ws, provider_id=provider, graph_name=graph,
        projection_mode=mode, dedicated_graph_name=None, aggregation_status=status,
        aggregation_edge_count=edges,
    )


class _Provider:
    def __init__(self, graph, *, mode="cluster", fail=None):
        self._graph_name = graph
        self._projection_mode = "in_source"
        self._db = object()
        self._proj_db = None
        self._conn_cfg = types.SimpleNamespace(mode=mode)
        self._fail = fail
        self.connects = 0

    async def _ensure_connected(self):
        self.connects += 1
        if self._fail:
            raise self._fail


class _Registry:
    def __init__(self, providers):
        self._providers = providers
        self.calls = []

    async def get_provider_for_workspace(self, ws, session, data_source_id=None):
        self.calls.append(data_source_id)
        return self._providers[data_source_id.split(":")[0]]


def _wire(monkeypatch, *, sources, owners, readings, states=None, stats=None, failures=None, stored=None,
          reservations=None):
    """Stub the collaborators around the sweep (the ledger holds nothing
    unless ``reservations`` says otherwise)."""
    reads = []

    async def list_sources(session, *, ds_id=None):
        rows = [(s, "Falkor") for s in sources if ds_id is None or s.id == ds_id]
        return rows, len(rows), False

    async def owner(db, *, mode, graph_key, timeout):
        return owners.get(graph_key, "unknown")

    async def read(db, *, mode, graph_key, timeout):
        reads.append(graph_key)
        return readings[owners[graph_key]]

    async def state_map(session, ids):
        return states or {}

    async def failure_map(session, ids):
        return failures or {}

    async def stats_map(session, ids):
        return stats or {}

    async def stored_tuning(session):
        return stored or {}

    async def reserved(endpoint):
        return (reservations or {}).get(endpoint, (0, 0))

    monkeypatch.setattr(cap, "reserved_on", reserved)
    monkeypatch.setattr(cap, "_list_sources", list_sources)
    monkeypatch.setattr(cap, "owner_endpoint", owner)
    monkeypatch.setattr(cap, "read_shard_memory", read)
    monkeypatch.setattr(cap, "latest_completed_stats_map", stats_map)
    monkeypatch.setattr(cap, "_stored_tuning", stored_tuning)
    import backend.app.services.aggregation.service as svc_mod
    monkeypatch.setattr(svc_mod, "_state_map", state_map)
    monkeypatch.setattr(svc_mod, "_latest_failure_map", failure_map)
    cap._cache = None
    return reads


def test_the_fleet_reads_each_node_once_and_groups_the_sources_on_it(monkeypatch):
    p1, p2 = _Provider("g1"), _Provider("g2")
    sources = [_ds("p1:a", graph="g1", edges=10), _ds("p1:b", graph="g1", edges=30), _ds("p2:c", provider="p2", graph="g2", mode="dedicated")]
    owners = {"g1": "10.0.0.1:6379", "g2_proj": "10.0.0.2:6379"}
    readings = {"10.0.0.1:6379": _reading("10.0.0.1:6379", used=30 * GB), "10.0.0.2:6379": _reading("10.0.0.2:6379", used=4 * GB)}
    reads = _wire(monkeypatch, sources=sources, owners=owners, readings=readings,
                  states={"p1:b": {"aggregation_edge_count": 30, "observed_bytes_per_edge": 1000}})
    registry = _Registry({"p1": p1, "p2": p2})

    res = _run(cap.assemble_fleet_capacity(object(), registry))

    assert len(reads) == 2                                  # one INFO per node, not per graph
    assert registry.calls == ["p1:a", "p2:c"]               # one resolution per provider/graph
    assert [s.endpoint for s in res.shards] == ["10.0.0.1:6379", "10.0.0.2:6379"]   # fullest first
    busy = res.shards[0]
    assert [s.data_source_id for s in busy.sources] == ["p1:b", "p1:a"]             # biggest footprint first
    assert busy.sources[0].footprint_bytes == 30 * 1000 and busy.sources[0].bytes_per_edge_source == "calibrated"
    assert res.shards[1].sources[0].graph_key == "g2_proj"    # dedicated mode lands on the projection graph
    assert res.unresolved == [] and res.sources_total == 3 and not res.truncated
    assert res.measured_at and res.cache_age_ms >= 0


def test_a_provider_that_cannot_be_resolved_is_reported_never_raised(monkeypatch):
    broken = _Provider("g1", fail=ConnectionError("refused"))
    sources = [_ds("p1:a", graph="g1"), _ds("p1:b", graph="g1")]
    _wire(monkeypatch, sources=sources, owners={"g1": "10.0.0.1:6379"}, readings={"10.0.0.1:6379": _reading()})
    registry = _Registry({"p1": broken})

    res = _run(cap.assemble_fleet_capacity(object(), registry, fresh=True))

    assert res.shards == []
    assert [u.data_source_id for u in res.unresolved] == ["p1:a", "p1:b"]
    assert all(u.why_not == "provider unavailable (ConnectionError)" for u in res.unresolved)
    assert broken.connects == 1                             # the failure is remembered per group


def test_an_unknown_owner_is_reported_with_a_reason(monkeypatch):
    sources = [_ds("p1:a", graph="g1")]
    _wire(monkeypatch, sources=sources, owners={}, readings={})
    res = _run(cap.assemble_fleet_capacity(object(), _Registry({"p1": _Provider("g1")}), fresh=True))
    assert res.unresolved[0].why_not == "the shard owning this graph could not be determined"


def test_the_deadline_leaves_the_rest_unresolved(monkeypatch):
    sources = [_ds("p1:a", graph="g1"), _ds("p2:b", provider="p2", graph="g2")]
    _wire(monkeypatch, sources=sources, owners={"g1": "n1", "g2": "n2"},
          readings={"n1": _reading("n1"), "n2": _reading("n2")})

    async def slow_owner(db, *, mode, graph_key, timeout):
        if graph_key == "g2":
            await asyncio.sleep(0.5)
        return {"g1": "n1", "g2": "n2"}[graph_key]

    monkeypatch.setattr(cap, "owner_endpoint", slow_owner)
    monkeypatch.setenv("AGGREGATION_CAPACITY_DEADLINE_S", "0.1")
    registry = _Registry({"p1": _Provider("g1"), "p2": _Provider("g2")})
    res = _run(cap.assemble_fleet_capacity(object(), registry, fresh=True))
    assert [s.endpoint for s in res.shards] == ["n1"]
    assert [(u.data_source_id, u.why_not) for u in res.unresolved] == [("p2:b", "not measured before the deadline")]


def test_the_fleet_snapshot_is_cached_briefly_and_fresh_bypasses_it(monkeypatch):
    sources = [_ds("p1:a", graph="g1")]
    reads = _wire(monkeypatch, sources=sources, owners={"g1": "n1"}, readings={"n1": _reading("n1")})
    registry = _Registry({"p1": _Provider("g1")})
    _run(cap.assemble_fleet_capacity(object(), registry))
    _run(cap.assemble_fleet_capacity(object(), registry))
    assert len(reads) == 1
    _run(cap.assemble_fleet_capacity(object(), registry, fresh=True))
    assert len(reads) == 2


def test_source_capacity_answers_with_the_preflight_and_none_for_an_unknown_source(monkeypatch):
    sources = [_ds("p1:a", graph="g1", edges=100)]
    _wire(monkeypatch, sources=sources, owners={"g1": "n1"}, readings={"n1": _reading("n1", used=39 * GB)},
          stats={"p1:a": {"cube_estimate": 10_000_000, "regime": "cube"}}, stored={"shard_reserve_pct": 0})
    registry = _Registry({"p1": _Provider("g1")})

    doc = _run(cap.assemble_source_capacity(object(), registry, "p1:a"))
    assert doc is not None and doc.shard.endpoint == "n1" and doc.source.last_regime == "cube"
    assert doc.full_detail.verdict == "short" and doc.full_detail.estimate_source == "lastRun"
    assert doc.auto.never_refused and doc.auto.would_store_cube is False
    assert _run(cap.assemble_source_capacity(object(), registry, "nope")) is None


def test_source_capacity_explains_an_unplaceable_source_instead_of_failing(monkeypatch):
    sources = [_ds("p1:a", graph="g1")]
    _wire(monkeypatch, sources=sources, owners={}, readings={})
    doc = _run(cap.assemble_source_capacity(object(), _Registry({"p1": _Provider("g1")}), "p1:a"))
    assert doc is not None and not doc.shard.measurable
    assert doc.shard.why_not == "the shard owning this graph could not be determined"
    assert doc.full_detail.verdict == "unknown"


# ── the node's own limits ───────────────────────────────────────────────


def _limited(endpoint="n1", *, cap=512 * 2 ** 20, timeout_max=180_000, default=30_000, threads=4):
    return ShardMemory(endpoint, 10 * GB, 40 * GB, "noeviction", 0.0, "measured", None,
                       cap, timeout_max, default, threads)


def test_a_shard_row_carries_the_nodes_own_limits():
    limits = cap.effective_limits({})
    row = cap.shard_row(_limited(), limits)
    assert (row.query_mem_capacity, row.timeout_max_ms, row.timeout_default_ms, row.thread_count) == (
        512 * 2 ** 20, 180_000, 30_000, 4,
    )
    plain = cap.shard_row(_reading(), limits)
    assert plain.timeout_max_ms is None and plain.thread_count is None


def test_the_limits_carry_the_container_figure_only_when_the_deployment_states_it(monkeypatch):
    monkeypatch.delenv("FALKORDB_CONTAINER_MEMORY_BYTES", raising=False)
    assert cap.effective_limits({}).container_memory_bytes is None
    monkeypatch.setenv("FALKORDB_CONTAINER_MEMORY_BYTES", str(10 * GB))
    assert cap.effective_limits({}).container_memory_bytes == 10 * GB
    monkeypatch.setenv("FALKORDB_CONTAINER_MEMORY_BYTES", "10Gi")
    assert cap.effective_limits({}).container_memory_bytes is None


class _NotingProvider(_Provider):
    def __init__(self, graph, **kw):
        super().__init__(graph, **kw)
        self.noted = []

    def note_server_limits(self, endpoint, **limits):
        self.noted.append((endpoint, limits))


def test_the_sweep_tells_each_provider_what_its_node_allows_and_remembers_who_lives_where(monkeypatch):
    """The sweep is the one place every node gets read, so it is where a
    provider learns the cap its clamp must follow — once per node, however
    many sources share the provider — and a limits change later finds the
    providers on a node through the same record."""
    p1, p2 = _NotingProvider("g1"), _Provider("g2")
    sources = [_ds("p1:a", graph="g1"), _ds("p1:b", graph="g1"), _ds("p2:c", provider="p2", graph="g2")]
    _wire(monkeypatch, sources=sources, owners={"g1": "n1", "g2": "n2"},
          readings={"n1": _limited("n1", cap=2 ** 30, timeout_max=300_000, threads=6), "n2": _reading("n2")})
    parts = _run(cap._assemble(object(), _Registry({"p1": p1, "p2": p2})))
    assert p1.noted == [("n1", {
        "timeout_max_ms": 300_000, "query_mem_capacity": 2 ** 30, "thread_count": 6, "timeout_default_ms": 30_000,
    })]
    assert parts["providers_by_endpoint"]["n1"] == [(p1, "g1")]
    assert parts["providers_by_endpoint"]["n2"] == [(p2, "g2")]
    assert [(s.endpoint, s.timeout_max_ms, s.thread_count) for s in parts["shards"]] == [("n1", 300_000, 6), ("n2", None, None)]


def test_invalidating_the_fleet_cache_forces_the_next_view_to_sweep(monkeypatch):
    sources = [_ds("p1:a", graph="g1")]
    reads = _wire(monkeypatch, sources=sources, owners={"g1": "n1"}, readings={"n1": _reading("n1")})
    registry = _Registry({"p1": _Provider("g1")})
    _run(cap.assemble_fleet_capacity(object(), registry))
    cap.invalidate_fleet_cache()
    _run(cap.assemble_fleet_capacity(object(), registry))
    assert len(reads) == 2


def test_the_sweep_reads_each_nodes_ledger_once_and_the_rows_take_it_off_the_free_memory(monkeypatch):
    p1, p2 = _Provider("g1"), _Provider("g2")
    sources = [_ds("p1:a", graph="g1"), _ds("p1:b", graph="g1"), _ds("p2:c", provider="p2", graph="g2")]
    _wire(monkeypatch, sources=sources, owners={"g1": "n1", "g2": "n2"},
          readings={"n1": _reading("n1"), "n2": _reading("n2")},
          stats={"p1:a": {"cube_estimate": 55_000_000}})
    asks = []

    async def ledger(endpoint):
        asks.append(endpoint)
        return {"n1": (2 * GB, 1)}.get(endpoint, (0, 0))

    monkeypatch.setattr(cap, "reserved_on", ledger)
    registry = _Registry({"p1": p1, "p2": p2})

    res = _run(cap.assemble_fleet_capacity(object(), registry, fresh=True))

    assert asks == ["n1", "n2"]                                   # once per node, not per source
    n1, n2 = res.shards
    assert (n1.endpoint, n1.reserved_bytes, n1.reserved_by_jobs, n1.available_bytes) == ("n1", 2 * GB, 1, 20 * GB)
    assert (n2.endpoint, n2.reserved_bytes, n2.reserved_by_jobs, n2.available_bytes) == ("n2", 0, 0, 22 * GB)
    # The per-source view and its pre-flight take the same figure: 55M new
    # cells at 512 B need 26.2 GB — inside 22 GB with the 25% margin, not inside 20.
    doc = _run(cap.assemble_source_capacity(object(), registry, "p1:a"))
    assert (doc.shard.reserved_by_jobs, doc.shard.available_bytes) == (1, 20 * GB)
    assert doc.full_detail.verdict == "short" and doc.full_detail.blocked_by == "shard"


def test_an_unreadable_ledger_shows_no_reservations_and_is_asked_only_once(monkeypatch):
    sources = [_ds("p1:a", graph="g1"), _ds("p2:b", provider="p2", graph="g2")]
    _wire(monkeypatch, sources=sources, owners={"g1": "n1", "g2": "n2"},
          readings={"n1": _reading("n1"), "n2": _reading("n2")})
    asks = []

    async def down(endpoint):
        asks.append(endpoint)
        raise ConnectionError("bus down")

    monkeypatch.setattr(cap, "reserved_on", down)
    registry = _Registry({"p1": _Provider("g1"), "p2": _Provider("g2")})
    res = _run(cap.assemble_fleet_capacity(object(), registry, fresh=True))
    assert asks == ["n1"]
    assert [(s.endpoint, s.reserved_by_jobs, s.available_bytes) for s in res.shards] == [("n1", 0, 22 * GB), ("n2", 0, 22 * GB)]
