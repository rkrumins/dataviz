"""The capacity view: the write budget's own reading and arithmetic,
assembled for people.

Pure helpers first (limits precedence, a shard row, the pre-flight verdicts),
then the assembly over a graph store topology snapshot.

What that change fixed, and what these tests hold in place: the view used to
resolve a PROVIDER per source and ask it who owned the graph, so a node only
appeared if some source's provider could be built and dialled inside the
deadline — and the same page, refreshed twice, showed different rows with
"cannot be measured" appearing and disappearing. Placement is now arithmetic
over one snapshot: every master is a row whether or not anything sits on it,
a node that could not be read is a row with the reason, and the order never
moves.
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
    assert (limits.max_cube_edges_source, limits.estimate_margin_pct_source) == ("default", "default")


def test_the_cube_ceiling_and_the_estimate_margin_are_fleet_knobs_over_the_env():
    limits = cap.effective_limits({"max_cube_edges": 2_000_000, "estimate_margin_pct": 10})
    assert (limits.max_cube_edges, limits.max_cube_edges_source) == (2_000_000, "global")
    assert (limits.estimate_margin_pct, limits.estimate_margin_pct_source) == (10, "global")
    # Clamped to the pipeline's bounds; garbage falls back to the environment.
    limits = cap.effective_limits({"max_cube_edges": 1, "estimate_margin_pct": "x"})
    assert (limits.max_cube_edges, limits.max_cube_edges_source) == (10_000, "global")
    assert (limits.estimate_margin_pct, limits.estimate_margin_pct_source) == (25, "default")


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


def _node(endpoint, *, used=10 * GB, maxmemory=40 * GB, role="master", status="up",
          error=None, cap=None, timeout_max=None, default=None, threads=None):
    from backend.app.services.graph_store.schemas import (
        GraphStoreNode, NodeLimits, NodeMemory,
    )

    return GraphStoreNode(
        endpoint=endpoint, role=role, status=status, error=error,
        memory=NodeMemory(used=used, maxmemory=maxmemory, policy="noeviction"),
        limits=NodeLimits(
            queryMemCapacity=cap, timeoutMaxMs=timeout_max,
            timeoutDefaultMs=default, threadCount=threads,
        ),
    )


def _snapshot(*instances, stale=False, last_error=None):
    from backend.app.services.graph_store.schemas import GraphStoreTopologyResponse

    return GraphStoreTopologyResponse(
        instances=list(instances), measuredAt="2026-09-09T00:00:00Z",
        stale=stale, lastError=last_error,
    )


def _instance(iid, *, providers=("p1",), mode="cluster", shards=(), reachable=True, error=None):
    from backend.app.services.graph_store.schemas import GraphStoreInstance, ProviderRef

    return GraphStoreInstance(
        id=iid, mode=mode, reachable=reachable, error=error,
        providers=[ProviderRef(id=pid, name=f"Falkor {pid}") for pid in providers],
        shards=list(shards),
    )


def _shard(index, master, *, slots=(0, 16383), replicas=()):
    from backend.app.services.graph_store.schemas import GraphStoreShard

    return GraphStoreShard(
        index=index, slotRanges=[[slots[0], slots[1]]],
        slotCount=slots[1] - slots[0] + 1, master=master, replicas=list(replicas),
    )


def _three_shards(instance_id="i1", providers=("p1",), **node_kw):
    """A 3-master cluster whose slot ranges are the real ones, so placement
    by keyslot means something."""
    ranges = [(0, 5460), (5461, 10922), (10923, 16383)]
    return _instance(instance_id, providers=providers, shards=[
        _shard(i, _node(f"10.0.0.{i + 1}:6379", **node_kw), slots=r)
        for i, r in enumerate(ranges)
    ])


def _wire(monkeypatch, *, sources, snapshot, states=None, stats=None, failures=None,
          stored=None, reservations=None):
    """Everything the assembly reads, faked: the SQL maps, the stored
    defaults, the ledger, and the one snapshot it places against."""
    builds = []

    async def list_sources(session, *, ds_id=None):
        rows = [(s, "Falkor") for s in sources if ds_id is None or s.id == ds_id]
        return rows, len(rows), False

    async def get_snapshot(*, fresh=False):
        builds.append(fresh)
        return snapshot

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

    import backend.app.services.graph_store.topology as topo

    monkeypatch.setattr(topo, "get_topology_snapshot", get_snapshot)
    monkeypatch.setattr(cap, "reserved_on", reserved)
    monkeypatch.setattr(cap, "_list_sources", list_sources)
    monkeypatch.setattr(cap, "latest_completed_stats_map", stats_map)
    monkeypatch.setattr(cap, "_stored_tuning", stored_tuning)
    import backend.app.services.aggregation.service as svc_mod
    monkeypatch.setattr(svc_mod, "_state_map", state_map)
    monkeypatch.setattr(svc_mod, "_latest_failure_map", failure_map)
    cap._cache = None
    return builds


def test_every_master_is_a_row_even_the_ones_with_nothing_on_them(monkeypatch):
    """The old sweep only ever read the nodes that owned a rollup graph, so
    six of nine nodes — and any master without an aggregated source — were
    simply absent from a page titled "every shard"."""
    sources = [_ds("a", graph="g1", edges=10), _ds("b", graph="g1", edges=30)]
    _wire(monkeypatch, sources=sources, snapshot=_snapshot(_three_shards()),
          states={"b": {"aggregation_edge_count": 30, "observed_bytes_per_edge": 1000}})

    res = _run(cap.assemble_fleet_capacity(object()))

    assert [s.endpoint for s in res.shards] == [
        "10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379",
    ]
    assert all(s.state == "measured" for s in res.shards)
    with_sources = [s for s in res.shards if s.sources]
    assert len(with_sources) == 1                       # g1 hashes to exactly one
    assert [s.data_source_id for s in with_sources[0].sources] == ["b", "a"]
    assert with_sources[0].sources[0].footprint_bytes == 30 * 1000
    assert res.unresolved == [] and res.sources_total == 2
    assert res.measured_at and res.cache_age_ms >= 0


def test_the_rows_keep_the_snapshots_order_however_full_they_get(monkeypatch):
    """Sorting by utilisation is why an operator's eye lost its place: the
    rows re-ordered under the cursor every refresh as usage moved."""
    instance = _three_shards()
    instance.shards[2].master.memory.used = 39 * GB          # nearly full, still last
    _wire(monkeypatch, sources=[], snapshot=_snapshot(instance))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert [s.endpoint for s in res.shards] == [
        "10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379",
    ]
    assert res.shards[2].used_pct == 97.5


def test_a_node_that_could_not_be_read_is_a_row_with_its_reason(monkeypatch):
    instance = _instance("i1", shards=[
        _shard(0, _node("10.0.0.1:6379"), slots=(0, 8191)),
        _shard(1, _node("10.0.0.2:6379", used=None, maxmemory=None,
                        status="unreachable", error="Connection refused"), slots=(8192, 16383)),
    ])
    _wire(monkeypatch, sources=[], snapshot=_snapshot(instance))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert [(s.endpoint, s.state) for s in res.shards] == [
        ("10.0.0.1:6379", "measured"), ("10.0.0.2:6379", "unreachable"),
    ]
    assert res.shards[1].why_not == (
        "the shard's memory could not be measured (Connection refused)"
    )
    assert res.shards[1].allowed_growth_edges is None


def test_a_node_without_maxmemory_is_ungoverned_not_unreachable(monkeypatch):
    instance = _instance("i1", shards=[_shard(0, _node("n1", maxmemory=0))])
    _wire(monkeypatch, sources=[], snapshot=_snapshot(instance))
    row = _run(cap.assemble_fleet_capacity(object())).shards[0]
    assert row.state == "ungoverned" and not row.measurable
    assert row.used == 10 * GB and row.governed_by == "static"


def test_a_projection_graph_can_land_on_a_different_shard_than_its_source(monkeypatch):
    """Dedicated mode writes the rollups to ``<graph>_proj``, which hashes on
    its own — the capacity that matters is the shard THAT lands on."""
    sources = [_ds("a", graph="g1", mode="dedicated")]
    _wire(monkeypatch, sources=sources, snapshot=_snapshot(_three_shards()))
    res = _run(cap.assemble_fleet_capacity(object()))
    placed = [s for s in res.shards if s.sources]
    assert len(placed) == 1 and placed[0].sources[0].graph_key == "g1_proj"
    from backend.app.services.graph_store.topology import key_slot
    lo, hi = next(
        (r[0], r[1]) for r in
        [[0, 5460], [5461, 10922], [10923, 16383]]
        if r[0] <= key_slot("g1_proj") <= r[1]
    )
    assert lo <= key_slot("g1_proj") <= hi


def test_a_source_whose_provider_has_no_instance_is_reported_never_dropped(monkeypatch):
    sources = [_ds("a", provider="p9", graph="g1")]
    _wire(monkeypatch, sources=sources, snapshot=_snapshot(_three_shards()))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert [u.data_source_id for u in res.unresolved] == ["a"]
    assert "no graph store instance" in res.unresolved[0].why_not
    assert len(res.shards) == 3                        # the nodes are still shown


def test_a_store_that_could_not_be_reached_at_all_explains_itself(monkeypatch):
    instance = _instance("i1", reachable=False, error="no seed answered", shards=[])
    _wire(monkeypatch, sources=[_ds("a", graph="g1")], snapshot=_snapshot(instance))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert res.shards == []
    assert res.unresolved[0].why_not == "no seed answered"


def test_a_slot_no_shard_owns_says_so(monkeypatch):
    """Partial slot coverage is a real cluster state (a shard down, no
    replica promoted) and it is not the same as "unmeasurable"."""
    instance = _instance("i1", shards=[_shard(0, _node("n1"), slots=(0, 100))])
    _wire(monkeypatch, sources=[_ds("a", graph="g1")], snapshot=_snapshot(instance))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert "no shard of this graph store holds slot" in res.unresolved[0].why_not


def test_the_view_keeps_serving_the_last_good_reading_and_says_so(monkeypatch):
    """The refresh behind these figures failed. Blanking the card was the
    old behaviour, and it is why the page flickered."""
    _wire(monkeypatch, sources=[],
          snapshot=_snapshot(_three_shards(), stale=True, last_error="no seed answered"))
    res = _run(cap.assemble_fleet_capacity(object()))
    assert res.stale is True and res.last_error == "no seed answered"
    assert len(res.shards) == 3                        # rows stay


def test_the_fleet_snapshot_is_cached_briefly_and_fresh_rebuilds_the_topology(monkeypatch):
    builds = _wire(monkeypatch, sources=[], snapshot=_snapshot(_three_shards()))
    _run(cap.assemble_fleet_capacity(object()))
    _run(cap.assemble_fleet_capacity(object()))
    assert builds == [False]
    _run(cap.assemble_fleet_capacity(object(), fresh=True))
    assert builds == [False, True]                     # fresh reaches the store


def test_source_capacity_answers_with_the_preflight_and_none_for_an_unknown_source(monkeypatch):
    sources = [_ds("a", graph="g1", edges=100)]
    _wire(monkeypatch, sources=sources, snapshot=_snapshot(_three_shards(used=39 * GB)),
          stats={"a": {"cube_estimate": 10_000_000, "regime": "cube"}},
          stored={"shard_reserve_pct": 0})

    doc = _run(cap.assemble_source_capacity(object(), "a"))
    assert doc is not None and doc.source.last_regime == "cube"
    assert doc.shard.endpoint.startswith("10.0.0.")
    assert doc.full_detail.verdict == "short" and doc.full_detail.estimate_source == "lastRun"
    assert doc.auto.never_refused and doc.auto.would_store_cube is False
    assert _run(cap.assemble_source_capacity(object(), "nope")) is None


def test_source_capacity_explains_an_unplaceable_source_instead_of_failing(monkeypatch):
    _wire(monkeypatch, sources=[_ds("a", provider="p9", graph="g1")],
          snapshot=_snapshot(_three_shards()))
    doc = _run(cap.assemble_source_capacity(object(), "a"))
    assert doc is not None and not doc.shard.measurable
    assert "no graph store instance" in doc.shard.why_not
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


class _NotingProvider:
    """A provider already built in this process, which the view may TELL
    what its node allows — but must never build one to do it."""

    def __init__(self):
        self.noted = []

    def note_server_limits(self, endpoint, **limits):
        self.noted.append((endpoint, limits))


def test_the_view_tells_the_providers_already_built_what_their_nodes_allow(monkeypatch):
    """A provider's per-query clamp follows the node's real cap only if
    something tells it. This is the one place every node is read — but a
    page refresh must never DIAL a store to hand it a limit, so only the
    proxies this process already holds are told."""
    built = _NotingProvider()
    instance = _instance("i1", providers=("p1",), shards=[
        _shard(0, _node("n1", cap=2 ** 30, timeout_max=300_000, default=30_000, threads=6)),
    ])
    _wire(monkeypatch, sources=[], snapshot=_snapshot(instance))

    from backend.app.providers.manager import provider_manager

    asked = []
    monkeypatch.setattr(
        provider_manager, "instantiated",
        lambda pid: asked.append(pid) or ([built] if pid == "p1" else []),
    )
    parts = _run(cap._assemble(object()))

    assert asked == ["p1"]
    assert built.noted == [("n1", {
        "timeout_max_ms": 300_000, "query_mem_capacity": 2 ** 30,
        "thread_count": 6, "timeout_default_ms": 30_000,
    })]
    assert [(s.endpoint, s.timeout_max_ms, s.thread_count) for s in parts["shards"]] == [
        ("n1", 300_000, 6),
    ]


def test_invalidating_the_fleet_cache_also_drops_the_topology_under_it(monkeypatch):
    """A limits change that left the topology cached showed the OLD ceiling
    for a TTL — on the very page the change was made from."""
    builds = _wire(monkeypatch, sources=[], snapshot=_snapshot(_three_shards()))
    dropped = []
    import backend.app.services.graph_store.topology as topo
    monkeypatch.setattr(topo, "invalidate_topology_cache", lambda: dropped.append(1))

    _run(cap.assemble_fleet_capacity(object()))
    cap.invalidate_fleet_cache()
    _run(cap.assemble_fleet_capacity(object()))
    assert len(builds) == 2 and dropped == [1]


def test_each_nodes_ledger_is_read_once_and_the_rows_take_it_off_the_free_memory(monkeypatch):
    instance = _instance("i1", shards=[
        _shard(0, _node("n1"), slots=(0, 8191)),
        _shard(1, _node("n2"), slots=(8192, 16383)),
    ])
    sources = [_ds("a", graph="g1", edges=100)]
    _wire(monkeypatch, sources=sources, snapshot=_snapshot(instance),
          stats={"a": {"cube_estimate": 55_000_000}})
    asks = []

    async def ledger(endpoint):
        asks.append(endpoint)
        return {"n1": (2 * GB, 1), "n2": (2 * GB, 1)}.get(endpoint, (0, 0))

    monkeypatch.setattr(cap, "reserved_on", ledger)

    res = _run(cap.assemble_fleet_capacity(object(), fresh=True))

    assert asks == ["n1", "n2"]                          # once per node, not per source
    assert [(s.reserved_bytes, s.reserved_by_jobs, s.available_bytes) for s in res.shards] == [
        (2 * GB, 1, 20 * GB), (2 * GB, 1, 20 * GB),
    ]
    # The per-source view and its pre-flight take the same figure: 55M new
    # cells at 512 B need 26.2 GB — inside 22 GB with the 25% margin, not inside 20.
    doc = _run(cap.assemble_source_capacity(object(), "a"))
    assert (doc.shard.reserved_by_jobs, doc.shard.available_bytes) == (1, 20 * GB)
    assert doc.full_detail.verdict == "short" and doc.full_detail.blocked_by == "shard"


def test_an_unreadable_ledger_shows_no_reservations_and_is_asked_only_once(monkeypatch):
    instance = _instance("i1", shards=[
        _shard(0, _node("n1"), slots=(0, 8191)),
        _shard(1, _node("n2"), slots=(8192, 16383)),
    ])
    _wire(monkeypatch, sources=[], snapshot=_snapshot(instance))
    asks = []

    async def down(endpoint):
        asks.append(endpoint)
        raise ConnectionError("bus down")

    monkeypatch.setattr(cap, "reserved_on", down)
    res = _run(cap.assemble_fleet_capacity(object(), fresh=True))
    assert asks == ["n1"]                                # one connect timeout, not one per shard
    assert [(s.endpoint, s.reserved_by_jobs, s.available_bytes) for s in res.shards] == [
        ("n1", 0, 22 * GB), ("n2", 0, 22 * GB),
    ]
