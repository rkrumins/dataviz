"""The shard capacity model: measured, overridable, explained.

The write budget used to be a static edge count that never read the
instance, so an operator who added memory to every shard still saw
"writing this would risk exhausting the FalkorDB instance's memory". These
tests pin the replacement: the owning shard's real headroom governs when it
can be read, the operator's three limits layer over it, growth (not size)
is what a shard pays for, and a refusal carries every number a person
needs — in words that land in the right resolution bucket.
"""
from __future__ import annotations

import asyncio
import types

import pytest

from backend.app.providers import shard_capacity as sc

GB = 1024 ** 3


def _shard(used, maxmemory, *, source="measured", policy="noeviction", endpoint="10.0.0.1:6379"):
    return sc.ShardMemory(endpoint, used, maxmemory, policy, 0.0, source)


def _budget(shard, *, reserve=20, bpe=512, ceiling=None, static=25_000_000, source="default"):
    return sc.compute_write_budget(
        shard, reserve_pct=reserve, bytes_per_edge=bpe, bpe_source=source,
        explicit_ceiling=ceiling, static_cap=static,
    )


# ── the allowance ────────────────────────────────────────────────────


def test_a_measured_shard_governs_and_the_reserve_comes_off_the_top():
    b = _budget(_shard(10 * GB, 40 * GB))
    assert b.governed_by == "shard"
    assert b.reserve_bytes == 8 * GB
    assert b.available_bytes == 22 * GB
    assert b.allowed_growth_edges == 22 * GB // 512


def test_the_operators_case_a_result_above_the_old_cap_fits_a_shard_with_room():
    """30M edges is over the 25M static cap that used to be the whole
    decision. The shard has 22GB after the reserve; at 512 B/edge that is
    ~46M edges. It passes — adding memory finally changes the answer."""
    b = _budget(_shard(10 * GB, 40 * GB))
    v = b.verdict(projected=30_000_000, growth_edges=30_000_000)
    assert v.ok and v.blocked_by is None
    assert v.needed_bytes == 30_000_000 * 512


def test_growth_not_size_is_what_the_shard_pays_for():
    """Re-materialising cells the graph already holds does not grow the
    shard. A 10M-edge result of which 1M is new needs 1M edges' worth."""
    b = _budget(_shard(39 * GB, 40 * GB), reserve=0)      # 1 GB free
    assert b.allowed_growth_edges == GB // 512
    assert b.verdict(projected=10_000_000, growth_edges=1_000_000).ok
    v = b.verdict(projected=10_000_000, growth_edges=3_000_000)
    assert not v.ok and v.blocked_by == "shard"
    assert v.needed_bytes == 3_000_000 * 512
    assert v.available_bytes == GB
    assert v.shortfall_bytes == 3_000_000 * 512 - GB
    assert v.shortfall_edges == -(-v.shortfall_bytes // 512)


def test_what_other_rebuilds_hold_comes_off_the_free_memory_and_is_named():
    """Two rebuilds racing onto one shard: the second budgets against what
    the first holds in the node's ledger as if it were used memory, and its
    refusal says so — in words that stay in the write-budget bucket."""
    shard = _shard(30 * GB, 40 * GB)                       # 2 GB free after the 20% reserve
    plain = _budget(shard, reserve=20)
    assert plain.available_bytes == 2 * GB and (plain.reserved_bytes, plain.reserved_by_jobs) == (0, 0)
    b = sc.compute_write_budget(
        shard, reserve_pct=20, bytes_per_edge=512, bpe_source="default",
        explicit_ceiling=None, static_cap=25_000_000,
        reserved_bytes=3 * GB // 2, reserved_count=1,
    )
    assert b.available_bytes == GB // 2 and b.allowed_growth_edges == (GB // 2) // 512
    assert (b.reserved_bytes, b.reserved_by_jobs) == (3 * GB // 2, 1)
    assert (b.as_stats()["reserved_bytes"], b.as_stats()["reserved_by_jobs"]) == (3 * GB // 2, 1)
    v = b.verdict(projected=2_000_000, growth_edges=2_000_000)     # needs ~1 GB
    assert not v.ok and v.blocked_by == "shard"
    msg = sc.format_refusal(b, v, graph="g", composition="x")
    assert "512.0 MB free of 40.0 GB" in msg
    assert "30.0 GB used, 1.5 GB held by 1 other rebuild still writing" in msg
    for word in _FORBIDDEN:
        assert word not in msg, word
    from backend.app.services.aggregation.service import classify_failure
    assert classify_failure(msg) == "write_budget"
    # Without a ledger the message is what it always was.
    assert "held by" not in sc.format_refusal(plain, plain.verdict(projected=10_000_000, growth_edges=10_000_000), graph="g", composition="x")


def test_an_unmeasurable_shard_falls_back_to_the_static_count_rule():
    for shard in (
        _shard(10 * GB, 0),                                 # maxmemory 0 = unlimited/unknown
        _shard(None, None, source="unavailable"),
    ):
        b = _budget(shard)
        assert b.governed_by == "static"
        assert b.available_bytes is None and b.allowed_growth_edges is None
        assert b.verdict(projected=20_000_000, growth_edges=20_000_000).ok
        v = b.verdict(projected=30_000_000, growth_edges=1)
        assert not v.ok and v.blocked_by == "static" and v.shortfall_edges == 5_000_000


def test_an_explicit_ceiling_caps_the_total_even_when_the_shard_has_room():
    b = _budget(_shard(10 * GB, 40 * GB), ceiling=5_000_000)
    v = b.verdict(projected=6_000_000, growth_edges=10)
    assert not v.ok and v.blocked_by == "ceiling" and v.shortfall_edges == 1_000_000
    assert b.verdict(projected=5_000_000, growth_edges=5_000_000).ok


def test_the_margin_widens_the_allowance_but_never_a_ceiling():
    b = _budget(_shard(39 * GB, 40 * GB), reserve=0)      # 1 GB free
    over = (GB // 512) * 6 // 5                            # 20% over the allowance
    assert not b.verdict(projected=over, growth_edges=over).ok
    assert b.verdict(projected=over, growth_edges=over, margin_pct=25).ok
    # The static rule is an allowance too: an upper-bound estimate 20% over
    # the cap is let through to the exact check.
    s = _budget(_shard(None, None, source="unavailable"), static=1_000)
    assert not s.verdict(projected=1_200, growth_edges=1).ok
    assert s.verdict(projected=1_200, growth_edges=1, margin_pct=25).ok
    # A ceiling is exact: the margin never stretches it.
    capped = _budget(_shard(39 * GB, 40 * GB), reserve=0, ceiling=100)
    assert not capped.verdict(projected=101, growth_edges=1, margin_pct=100).ok


def test_operator_limits_are_clamped_never_trusted():
    b = _budget(_shard(0, 40 * GB), reserve=200, bpe=1)
    assert b.reserve_pct == 90 and b.bytes_per_edge == 64
    b = _budget(_shard(0, 40 * GB), reserve=-5, bpe=10 ** 9)
    assert b.reserve_pct == 0 and b.bytes_per_edge == 16_384


def test_absent_limits_resolve_to_the_env_defaults(monkeypatch):
    monkeypatch.setenv("AGGREGATION_SHARD_RESERVE_PCT", "35")
    monkeypatch.setenv("AGGREGATION_BYTES_PER_EDGE", "1024")
    b = _budget(_shard(0, 40 * GB), reserve=None, bpe=None)
    assert (b.reserve_pct, b.bytes_per_edge) == (35, 1024)
    monkeypatch.setenv("AGGREGATION_SHARD_RESERVE_PCT", "junk")
    monkeypatch.setenv("AGGREGATION_ESTIMATE_MARGIN_PCT", "500")
    assert sc.shard_reserve_pct_default() == sc.RESERVE_PCT_DEFAULT
    assert sc.estimate_margin_pct_default() == sc.ESTIMATE_MARGIN_PCT_HI


# ── calibration ─────────────────────────────────────────────────────


def test_calibration_needs_material_growth_and_a_positive_delta():
    cal = sc.calibrate_bytes_per_edge
    assert cal(used_before=0, used_after=100 * 2 ** 20, edges_before=0, edges_after=200_000) == 524
    # Below the growth gate a neighbour's activity dominates the delta.
    assert cal(used_before=0, used_after=100 * 2 ** 20, edges_before=0, edges_after=50_000) is None
    # A neighbour shrank while we wrote.
    assert cal(used_before=10, used_after=5, edges_before=0, edges_after=1_000_000) is None
    # No reading on one side, no calibration.
    assert cal(used_before=None, used_after=5, edges_before=0, edges_after=1_000_000) is None
    # One odd run cannot poison the next budget in either direction.
    assert cal(used_before=0, used_after=10 ** 12, edges_before=0, edges_after=200_000) == 16_384
    assert cal(used_before=0, used_after=200_000, edges_before=0, edges_after=200_000) == 64


# ── the refusal ─────────────────────────────────────────────────────

# What classify_failure's earlier buckets match on; none may appear.
_FORBIDDEN = ("OOM", "used memory > 'maxmemory'", "mem consumption exceeded",
              "timeout", "TimeoutError", "ontology", "conflict", "unavailable",
              "unreachable", "connection")


def _refusals():
    shard = _shard(30 * GB, 40 * GB)
    b = _budget(shard, reserve=20)                              # 2 GB free
    v = b.verdict(projected=10_000_000, growth_edges=10_000_000)  # needs ~4.9 GB
    yield "shard", b, v
    c = _budget(shard, reserve=0, ceiling=1_000_000)
    yield "ceiling", c, c.verdict(projected=2_000_000, growth_edges=1)
    s = _budget(_shard(None, None, source="unavailable"))
    yield "static", s, s.verdict(projected=30_000_000, growth_edges=1)
    n = _budget(_shard(5 * GB, 0))
    yield "static-no-maxmemory", n, n.verdict(projected=30_000_000, growth_edges=1)


@pytest.mark.parametrize("kind,budget,verdict", list(_refusals()), ids=lambda x: x if isinstance(x, str) else "")
def test_every_refusal_starts_with_the_marker_and_routes_to_its_own_bucket(kind, budget, verdict):
    msg = sc.format_refusal(budget, verdict, graph="g", composition="d1→d1: 9")
    assert msg.startswith(sc.REFUSAL_MARKER)
    for word in _FORBIDDEN:
        assert word not in msg, (kind, word)
    assert "not retried" in msg and "Auto" in msg


def test_a_shard_refusal_carries_every_number_a_person_needs():
    _, b, v = next(_refusals())
    msg = sc.format_refusal(b, v, graph="g", composition="d1→d1: 9")
    assert "10,000,000" in msg and "10.0.0.1:6379" in msg
    assert "2.0 GB free of 40.0 GB" in msg and "20% reserve" in msg
    assert "short by" in msg and "512 B/edge (default)" in msg
    assert "shardReservePct" in msg and "bytesPerEdge" in msg


def test_an_estimate_refusal_says_it_is_an_upper_bound():
    _, b, v = next(_refusals())
    msg = sc.format_refusal(b, v, graph="g", composition="x", from_estimate=True, margin_pct=25)
    assert "upper-bound estimate" in msg and "25% margin" in msg


def test_the_static_refusal_still_names_the_cap_and_why_the_shard_could_not_govern():
    for kind, b, v in _refusals():
        if not kind.startswith("static"):
            continue
        msg = sc.format_refusal(b, v, graph="g", composition="x")
        assert "max_materialized_edges=25,000,000" in msg
        assert "set maxmemory" in msg
        if kind == "static-no-maxmemory":
            assert "reports no maxmemory" in msg
        else:
            assert "could not be measured" in msg


def test_a_ceiling_refusal_points_at_the_ceiling_not_the_shard():
    for kind, b, v in _refusals():
        if kind == "ceiling":
            msg = sc.format_refusal(b, v, graph="g", composition="x")
            assert "maxMaterializedEdges=1,000,000" in msg and "clear the ceiling" in msg


# ── the reading ─────────────────────────────────────────────────────


def _run(coro):
    return asyncio.run(coro)


class _Standalone:
    def __init__(self, info, *, raise_exc=None, delay=0.0, config=None, config_exc=None):
        self._info, self._raise, self._delay = info, raise_exc, delay
        self._config, self._config_exc = config, config_exc
        self.commands = []
        self.connection_pool = types.SimpleNamespace(
            connection_kwargs={"host": "falkor", "port": 6379},
        )

    #: What the node's own config says about when it DROPS a replica. The
    #: reading asks for both; a fake that wants to refuse them overrides.
    NODE_CONFIG = {
        "repl-backlog-size": "1073741824",
        "client-output-buffer-limit": (
            "normal 0 0 0 slave 2147483648 1073741824 300 pubsub 33554432 8388608 60"
        ),
    }

    async def info(self, *sections):
        # The reading asks for memory, server, persistence AND replication in
        # one round trip: how full the node is, whether it is the same process
        # it was a minute ago, whether it is forked, and how its replicas keep up.
        assert sections == ("memory", "server", "persistence", "replication"), sections
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise:
            raise self._raise
        return self._info

    async def config_get(self, name):
        self.commands.append(("CONFIG", "GET", name))
        return {name: self.NODE_CONFIG[name]}

    async def execute_command(self, *args, **kw):
        self.commands.append(args)
        assert args == ("GRAPH.CONFIG", "GET", "QUERY_MEM_CAPACITY")
        if self._config_exc:
            raise self._config_exc
        return self._config


class _Node:
    host, port = "10.0.0.7", 6379


class _Cluster:
    def __init__(self, info, config=None):
        self._info, self._config = info, config
        self.initialized = False
        self.targets = []
        self.config_targets = []
        self.nodes_manager = types.SimpleNamespace(get_node_from_slot=lambda slot: _Node())

    async def initialize(self):
        self.initialized = True

    def keyslot(self, key):
        return 42

    async def execute_command(self, *args, target_nodes=None):
        if args == ("GRAPH.CONFIG", "GET", "QUERY_MEM_CAPACITY"):
            self.config_targets.append(target_nodes)
            return self._config
        if args[:2] == ("CONFIG", "GET"):
            self.config_targets.append(target_nodes)
            return {args[2]: _Standalone.NODE_CONFIG[args[2]]}
        assert args == ("INFO", "memory", "server", "persistence", "replication"), args
        self.targets.append(target_nodes)
        return self._info


def _db(conn):
    return types.SimpleNamespace(connection=conn)


def test_the_reading_carries_the_per_query_ceiling_beside_the_memory():
    """QUERY_MEM_CAPACITY is what the pressure ladder narrows against; the
    reading names it so run_stats and the capacity view can. Read on the
    OWNING node in cluster mode, through the same client."""
    conn = _Standalone({"used_memory": "100", "maxmemory": "1000"},
                       config=[b"QUERY_MEM_CAPACITY", 536870912])
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.measurable and m.query_mem_capacity == 536870912
    assert m.as_stats()["query_mem_capacity"] == 536870912

    cluster = _Cluster({"used_memory": "100", "maxmemory": "1000"},
                       config={"10.0.0.7:6379": ["QUERY_MEM_CAPACITY", "1024"]})
    m = _run(sc.read_shard_memory(_db(cluster), mode="cluster", graph_key="g", timeout=1))
    assert m.query_mem_capacity == 1024
    # Every config round trip — the module ceiling and the node's own drop
    # limits — goes to the owner, not to whichever node the client picks.
    assert cluster.config_targets and all(isinstance(t, _Node) for t in cluster.config_targets)


@pytest.mark.parametrize("config", [
    ["QUERY_MEM_CAPACITY", 0],          # 0 = unlimited
    ["QUERY_MEM_CAPACITY", "nope"],
    None,
    [],
])
def test_an_unlimited_or_unreadable_ceiling_reads_as_none(config):
    conn = _Standalone({"used_memory": "100", "maxmemory": "1000"}, config=config)
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.measurable and m.query_mem_capacity is None
    assert "query_mem_capacity" not in m.as_stats()


def test_a_failing_ceiling_read_never_costs_the_memory_reading():
    conn = _Standalone({"used_memory": "100", "maxmemory": "1000"},
                       config_exc=RuntimeError("unknown command GRAPH.CONFIG"))
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.measurable and m.used == 100 and m.query_mem_capacity is None
    assert _run(sc.read_query_mem_capacity(_db(conn), mode="standalone", graph_key="g", timeout=1)) is None


def test_parse_config_reply_accepts_every_client_shape():
    parse = sc._parse_config_reply
    assert parse([b"QUERY_MEM_CAPACITY", b"2048"], "QUERY_MEM_CAPACITY") == 2048
    assert parse({"QUERY_MEM_CAPACITY": 4096}, "QUERY_MEM_CAPACITY") == 4096
    assert parse({"node": [b"QUERY_MEM_CAPACITY", 8192]}, "QUERY_MEM_CAPACITY") == 8192
    assert parse([["QUERY_MEM_CAPACITY", 16]], "QUERY_MEM_CAPACITY") == 16
    assert parse(["OTHER", 16], "QUERY_MEM_CAPACITY") is None
    assert parse(0, "QUERY_MEM_CAPACITY") is None


def test_owner_endpoint_names_the_node_without_reading_it():
    """A fleet view groups graphs by node and reads each node once, so it
    needs the owner WITHOUT an INFO."""
    conn = _Cluster({"used_memory": "1"})
    assert _run(sc.owner_endpoint(_db(conn), mode="cluster", graph_key="g", timeout=1)) == "10.0.0.7:6379"
    assert conn.initialized and conn.targets == []       # slot map yes, INFO no
    single = _Standalone({"used_memory": "1"})
    assert _run(sc.owner_endpoint(_db(single), mode="standalone", graph_key="g", timeout=1)) == "falkor:6379"


def test_owner_endpoint_uses_the_client_map_it_has_and_the_reading_refreshes_it():
    """A fleet sweep asks for hundreds of owners; each must not cost a
    CLUSTER SLOTS round trip once the client holds a map. The reading the
    pipeline takes before it writes still refreshes, to follow a failover."""
    conn = _Cluster({"used_memory": "1", "maxmemory": "4"})
    conn.nodes_manager.slots_cache = {42: [_Node()]}         # a map already in hand
    assert _run(sc.owner_endpoint(_db(conn), mode="cluster", graph_key="g", timeout=1)) == "10.0.0.7:6379"
    assert conn.initialized is False
    _run(sc.read_shard_memory(_db(conn), mode="cluster", graph_key="g", timeout=1))
    assert conn.initialized is True


def test_owner_endpoint_is_unknown_when_the_client_cannot_say():
    class _Broken:
        nodes_manager = None

        async def initialize(self):
            raise RuntimeError("cluster down")

    assert _run(sc.owner_endpoint(_db(_Broken()), mode="cluster", graph_key="g", timeout=1)) == "unknown"
    assert _run(sc.owner_endpoint(types.SimpleNamespace(), mode="cluster", graph_key="g", timeout=1)) == "unknown"


def test_a_standalone_reading_is_measured_with_its_endpoint():
    conn = _Standalone({"used_memory": "1000", "maxmemory": 4000, "maxmemory_policy": "noeviction"})
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "measured" and m.measurable
    assert (m.used, m.maxmemory, m.policy, m.endpoint) == (1000, 4000, "noeviction", "falkor:6379")


def test_a_cluster_reading_goes_to_the_node_that_owns_the_graph():
    conn = _Cluster({"used_memory": 1, "maxmemory": 2})
    m = _run(sc.read_shard_memory(_db(conn), mode="cluster", graph_key="g", timeout=1))
    assert conn.initialized and isinstance(conn.targets[0], _Node)
    assert m.endpoint == "10.0.0.7:6379" and m.measurable


def test_a_cluster_reply_keyed_by_node_is_unwrapped():
    conn = _Cluster({"10.0.0.7:6379": {"used_memory": 5, "maxmemory": 9}})
    m = _run(sc.read_shard_memory(_db(conn), mode="cluster", graph_key="g", timeout=1))
    assert (m.used, m.maxmemory) == (5, 9)


def test_raw_info_text_is_parsed_too():
    conn = _Standalone("# Memory\r\nused_memory:77\r\nmaxmemory:99\r\nmaxmemory_policy:noeviction\r\n")
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert (m.used, m.maxmemory, m.policy) == (77, 99, "noeviction")


def test_no_maxmemory_is_measured_but_cannot_govern():
    conn = _Standalone({"used_memory": 10, "maxmemory": 0})
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "measured" and not m.measurable
    assert m.why_not == "the shard reports no maxmemory"


def test_a_failing_or_slow_client_never_raises():
    boom = _Standalone({}, raise_exc=ConnectionError("connection refused"))
    m = _run(sc.read_shard_memory(_db(boom), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "unavailable" and m.note == "ConnectionError"
    slow = _Standalone({"used_memory": 1, "maxmemory": 2}, delay=0.5)
    m = _run(sc.read_shard_memory(_db(slow), mode="standalone", graph_key="g", timeout=0.01))
    assert m.source == "unavailable"
    m = _run(sc.read_shard_memory(types.SimpleNamespace(), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "unavailable" and m.note == "no client"
    # The coarse reason never echoes the client's words into the message.
    assert "connection" not in m.why_not


# ── the node's own limits ───────────────────────────────────────────


class _Wildcard(_Standalone):
    """A node that answers ``GRAPH.CONFIG GET *`` — the one round trip the
    reading prefers — takes SETs, and refuses per-name GETs to prove the
    wildcard is what was used."""

    def __init__(self, info, config_all):
        super().__init__(info)
        self._all = config_all

    async def execute_command(self, *args, **kw):
        self.commands.append(args)
        if args == ("GRAPH.CONFIG", "GET", "*"):
            return self._all
        if args[:2] == ("GRAPH.CONFIG", "SET"):
            return "OK"
        raise AssertionError(f"per-name read not expected: {args}")


class _ClusterSet(_Cluster):
    def __init__(self):
        super().__init__({"used_memory": "1"})
        self.sets = []

    async def execute_command(self, *args, target_nodes=None):
        if args[:2] == ("GRAPH.CONFIG", "SET"):
            self.sets.append((args, target_nodes))
            return "OK"
        return await super().execute_command(*args, target_nodes=target_nodes)


_CONFIG_ALL = [
    [b"TIMEOUT", 0], [b"TIMEOUT_MAX", 180000], [b"TIMEOUT_DEFAULT", 30000],
    [b"THREAD_COUNT", 4], [b"QUERY_MEM_CAPACITY", 536870912], [b"CACHE_SIZE", 50],
    [b"RESULTSET_SIZE", -1],
]


def test_the_reading_carries_the_nodes_limits_from_one_wildcard_read():
    """TIMEOUT_MAX is what every timeout knob is clamped to and THREAD_COUNT
    what the container formula multiplies the ceiling by: one GET * beside
    the INFO, and the stats name them only when known."""
    conn = _Wildcard({"used_memory": "100", "maxmemory": "1000"}, _CONFIG_ALL)
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.measurable
    assert (m.query_mem_capacity, m.timeout_max_ms, m.timeout_default_ms, m.thread_count) == (
        536870912, 180000, 30000, 4,
    )
    # One wildcard read for the module's limits; the node's own drop limits
    # (repl-backlog-size, client-output-buffer-limit) are the other two.
    assert [c for c in conn.commands if c[0] == "GRAPH.CONFIG"] == [("GRAPH.CONFIG", "GET", "*")]
    assert [c[2] for c in conn.commands if c[0] == "CONFIG"] == [
        "repl-backlog-size", "client-output-buffer-limit",
    ]
    stats = m.as_stats()
    assert (stats["timeout_max_ms"], stats["thread_count"]) == (180000, 4)
    assert "timeout_default_ms" not in stats


def test_the_reading_falls_back_to_per_name_reads_when_the_wildcard_is_refused():
    """A server or client that cannot answer ``*``: every limit read per
    name lands, the rest read as unknown, and the memory reading stands."""
    conn = _Standalone({"used_memory": "100", "maxmemory": "1000"},
                       config=[b"QUERY_MEM_CAPACITY", 536870912])
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.measurable and m.query_mem_capacity == 536870912
    assert m.timeout_max_ms is None and m.thread_count is None
    assert conn.commands[0] == ("GRAPH.CONFIG", "GET", "*")
    assert ("GRAPH.CONFIG", "GET", "TIMEOUT_MAX") in conn.commands
    assert "timeout_max_ms" not in m.as_stats()


def test_parse_config_all_accepts_every_client_shape():
    parse = sc._parse_config_all
    assert parse(_CONFIG_ALL)["TIMEOUT_MAX"] == 180000
    assert parse(["TIMEOUT_MAX", "1000", b"THREAD_COUNT", 2]) == {"TIMEOUT_MAX": "1000", "THREAD_COUNT": 2}
    assert parse({"timeout_max": 5}) == {"TIMEOUT_MAX": 5}
    assert parse({"10.0.0.7:6379": _CONFIG_ALL})["THREAD_COUNT"] == 4
    assert parse(None) == {} and parse([]) == {} and parse("junk") == {}


def test_zero_reads_as_no_limit_for_every_name():
    conn = _Wildcard({"used_memory": "1", "maxmemory": "2"}, [
        [b"TIMEOUT_MAX", 0], [b"TIMEOUT_DEFAULT", 0], [b"QUERY_MEM_CAPACITY", 0], [b"THREAD_COUNT", "x"],
    ])
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert (m.timeout_max_ms, m.timeout_default_ms, m.query_mem_capacity, m.thread_count) == (None, None, None, None)


def test_set_graph_config_sets_each_pair_in_order_on_the_owning_node():
    conn = _Wildcard({"used_memory": "1"}, _CONFIG_ALL)
    _run(sc.set_graph_config(conn, None, [("TIMEOUT_MAX", 300000), ("QUERY_MEM_CAPACITY", 2 ** 30)]))
    assert conn.commands == [
        ("GRAPH.CONFIG", "SET", "TIMEOUT_MAX", 300000),
        ("GRAPH.CONFIG", "SET", "QUERY_MEM_CAPACITY", 2 ** 30),
    ]
    cluster, node = _ClusterSet(), _Node()
    _run(sc.set_graph_config(cluster, node, [("TIMEOUT_MAX", 1)]))
    assert cluster.sets == [(("GRAPH.CONFIG", "SET", "TIMEOUT_MAX", 1), node)]

    class _Refusing(_Wildcard):
        async def execute_command(self, *args, **kw):
            raise RuntimeError("ERR read-only replica")

    with pytest.raises(RuntimeError, match="read-only"):
        _run(sc.set_graph_config(_Refusing({}, []), None, [("TIMEOUT_MAX", 1)]))


def test_container_memory_needed_is_the_deployment_guides_rule():
    """The guide's worked example: 1.25 × 6 GiB + 2 × 1.3 × 512 MiB + 256 MiB ≈ 9.1 GiB."""
    MB = 2 ** 20
    needed = sc.container_memory_needed(6 * GB, 2, 512 * MB)
    assert needed == int(1.25 * 6 * GB) + 2 * int(1.3 * 512 * MB) + 256 * MB
    assert 9.0 < needed / GB < 9.2
    # The overhead steps up to 1 GiB from 32 GiB; concurrency is never below 1.
    assert sc.container_memory_needed(32 * GB, 0, 1) == int(1.25 * 32 * GB) + int(1.3 * 1) + GB
    assert sc.container_memory_needed(2 * GB, 4, GB) == int(1.25 * 2 * GB) + 4 * int(1.3 * GB) + 256 * MB


# ── the whole node: fork state, replicas, buffers, the container ─────────
#
# The reading used to say how full the node was. It now says everything the
# write governor holds on: what the process actually holds (RSS), whether it
# is forked or about to be, how its replicas are keeping up, and the two
# limits its own config drops a replica at. And the budget gains a second
# ceiling: the container the pod is killed at, which ``maxmemory`` never
# guarded — under ``noeviction`` reaching ``maxmemory`` refuses a write, while
# reaching the container limit through a fork's copy-on-write kills the node.

_NODE = {
    "used_memory": str(13 * GB), "used_memory_rss": str(15 * GB),
    "used_memory_peak": str(15 * GB), "maxmemory": str(32 * GB),
    "maxmemory_policy": "noeviction", "mem_fragmentation_ratio": "1.08",
    "mem_total_replication_buffers": str(256 * 1024 ** 2),
    "run_id": "r1", "uptime_in_seconds": "1200", "loading": "0",
    "rdb_bgsave_in_progress": "0", "aof_rewrite_in_progress": "0",
    "aof_rewrite_scheduled": "0",
    "role": "master", "connected_slaves": "2", "master_repl_offset": "1000",
    "slave0": {"ip": "10.0.0.4", "port": "6379", "state": "online", "offset": "1000", "lag": "0"},
    "slave1": {"ip": "10.0.0.5", "port": "6379", "state": "online", "offset": "400", "lag": "1"},
}


def _node_info(**over):
    info = dict(_NODE)
    info.update(over)
    return info


def test_the_reading_carries_the_whole_node():
    conn = _Standalone(_node_info())
    m = _run(sc.read_shard_memory(_db(conn), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "measured" and m.used == 13 * GB
    assert m.rss == 15 * GB and m.fragmentation_ratio == 1.08
    assert m.fork_in_progress is None
    assert m.connected_replicas == 2 and m.replicas_syncing == 0
    assert m.replica_max_lag_bytes == 600                 # 1000 - 400
    assert m.mem_repl_buffers == 256 * 1024 ** 2
    assert m.repl_backlog_bytes == GB and m.replica_outbuf_hard_bytes == 2 * GB
    stats = m.as_stats()
    assert stats["rss"] == 15 * GB and stats["replica_outbuf_hard_bytes"] == 2 * GB
    assert "fork_in_progress" not in stats


def test_a_replica_mid_full_sync_reads_as_a_fork():
    """The master forks to stream a full resync, and the child lives for the
    whole transfer — the most dangerous fork of the three, because a rebuild
    is what dropped the replica in the first place."""
    info = _node_info(slave1={"ip": "10.0.0.5", "port": "6379", "state": "wait_bgsave",
                              "offset": "0", "lag": "0"})
    m = _run(sc.read_shard_memory(_db(_Standalone(info)), mode="standalone", graph_key="g", timeout=1))
    assert m.replicas_syncing == 1
    assert m.fork_in_progress == "replica_sync"
    assert m.as_stats()["fork_in_progress"] == "replica_sync"


@pytest.mark.parametrize("flag,name", [
    ("rdb_bgsave_in_progress", "bgsave"),
    ("aof_rewrite_in_progress", "aof_rewrite"),
    ("aof_rewrite_scheduled", "aof_rewrite_scheduled"),
])
def test_a_fork_in_flight_or_scheduled_is_read(flag, name):
    m = _run(sc.read_shard_memory(
        _db(_Standalone(_node_info(**{flag: "1"}))), mode="standalone", graph_key="g", timeout=1,
    ))
    assert m.fork_in_progress == name


def test_the_per_batch_reading_skips_the_config_round_trips():
    """The drop limits do not change during a run; a per-batch reading passes
    ``include_config=False`` and reuses what the run read at its start."""
    conn = _Standalone(_node_info())
    m = _run(sc.read_shard_memory(
        _db(conn), mode="standalone", graph_key="g", timeout=1, include_config=False,
    ))
    assert m.source == "measured" and m.rss == 15 * GB
    assert m.repl_backlog_bytes is None and m.replica_outbuf_hard_bytes is None
    assert not any(c[:2] == ("CONFIG", "GET") for c in conn.commands)


def test_a_node_that_refuses_config_still_measures():
    """A managed instance, or an ACL without CONFIG: the reading is still
    real, the drop limits are unknown, and the hold threshold falls back."""
    class _NoConfig(_Standalone):
        async def config_get(self, name):
            raise RuntimeError("NOPERM this user has no permissions to run the 'config' command")

    m = _run(sc.read_shard_memory(_db(_NoConfig(_node_info())), mode="standalone", graph_key="g", timeout=1))
    assert m.source == "measured"
    assert m.repl_backlog_bytes is None and m.replica_outbuf_hard_bytes is None
    assert sc.replica_lag_hold_bytes(m) == sc.REPLICA_LAG_HOLD_BYTES_DEFAULT


def test_the_cluster_reading_asks_the_owner_for_info_and_config():
    cluster = _Cluster(_node_info())
    m = _run(sc.read_shard_memory(_db(cluster), mode="cluster", graph_key="g", timeout=1))
    assert m.source == "measured" and m.rss == 15 * GB
    assert m.repl_backlog_bytes == GB
    assert all(isinstance(t, _Node) for t in cluster.targets)
    assert cluster.config_targets and all(isinstance(t, _Node) for t in cluster.config_targets)


# ── the envelope ──────────────────────────────────────────────────────────


def _node(**over):
    base = dict(
        endpoint="10.0.0.1:6379", used=13 * GB, maxmemory=32 * GB, policy="noeviction",
        observed_at=0.0, source="measured", query_mem_capacity=GB, thread_count=6,
        rss=15 * GB, connected_replicas=2, replicas_syncing=0, replica_max_lag_bytes=0,
        repl_backlog_bytes=GB, replica_outbuf_hard_bytes=2 * GB,
    )
    base.update(over)
    return sc.ShardMemory(**base)


def test_an_unmeasured_node_never_holds():
    """Ignorance is not a reason to wait: the store not answering is the
    outage path's business."""
    assert sc.hold_reason(_node(source="unavailable", bgsave_in_progress=True),
                          expected_replicas=2) is None


def test_a_loading_node_holds():
    kind, detail = sc.hold_reason(_node(loading=True), expected_replicas=2)
    assert kind == "loading" and "10.0.0.1:6379" in detail


@pytest.mark.parametrize("over,word", [
    ({"bgsave_in_progress": True}, "background save"),
    ({"aof_rewrite_in_progress": True}, "AOF rewrite"),
    ({"aof_rewrite_scheduled": True}, "about to start"),
    ({"replicas_syncing": 1}, "full resync"),
])
def test_a_fork_is_a_hold_and_says_which(over, word):
    kind, detail = sc.hold_reason(_node(**over), expected_replicas=2)
    assert kind == "fork" and word in detail


def test_a_replica_that_left_is_a_hold():
    """The inversion at the centre of the incident: the old gate stopped
    waiting the moment the replicas were gone. A replica that vanishes during
    a rebuild almost always vanished BECAUSE of it, and writing on is what
    turns its return into a full-sync fork under full write load."""
    kind, detail = sc.hold_reason(_node(connected_replicas=1), expected_replicas=2)
    assert kind == "replica_lost" and "1 of 2" in detail
    kind, _ = sc.hold_reason(_node(connected_replicas=0), expected_replicas=2)
    assert kind == "replica_lost"
    # A run that started with none expects none; an unknown count is no verdict.
    assert sc.hold_reason(_node(connected_replicas=0), expected_replicas=0) is None
    assert sc.hold_reason(_node(connected_replicas=None), expected_replicas=2) is None


def test_a_replica_that_owes_more_than_the_threshold_is_a_hold():
    """Held at a quarter of the buffer the master DROPS a replica at, so the
    drop — and the full-sync fork it forces — stays out of a rebuild's reach."""
    hold = sc.replica_lag_hold_bytes(_node())
    assert hold == 512 * 1024 ** 2                          # min(2 GiB / 4, 1 GiB / 2)
    kind, detail = sc.hold_reason(_node(replica_max_lag_bytes=hold), expected_replicas=2)
    assert kind == "replica_lag" and "behind" in detail
    assert sc.hold_reason(_node(replica_max_lag_bytes=hold - 1), expected_replicas=2) is None


def test_the_lag_threshold_comes_from_the_nodes_own_drop_limits(monkeypatch):
    assert sc.replica_lag_hold_bytes(_node(replica_outbuf_hard_bytes=2 * GB, repl_backlog_bytes=None)) == 512 * 1024 ** 2
    assert sc.replica_lag_hold_bytes(_node(replica_outbuf_hard_bytes=None, repl_backlog_bytes=GB)) == 512 * 1024 ** 2
    assert sc.replica_lag_hold_bytes(_node(replica_outbuf_hard_bytes=256 * 1024 ** 2, repl_backlog_bytes=GB)) == 64 * 1024 ** 2
    assert sc.replica_lag_hold_bytes(_node(replica_outbuf_hard_bytes=None, repl_backlog_bytes=None)) == sc.REPLICA_LAG_HOLD_BYTES_DEFAULT
    monkeypatch.setenv("AGGREGATION_REPLICA_LAG_HOLD_BYTES", str(7 * 1024 ** 2))
    assert sc.replica_lag_hold_bytes(_node()) == 7 * 1024 ** 2


def test_the_node_is_held_for_memory_once_past_the_fork_line():
    """RSS already past what the container could survive a fork at: nothing
    more may land until something drains — a fork's child exiting, usually."""
    node = _node(container_limit_bytes=40 * GB, rss=30 * GB)
    headroom = sc.container_headroom_bytes(node, fork_factor=1.25)
    # 40 − 1.25×30 − 6×1.3×1 − (1 + 2×2) − 1 = −11.3 GiB
    assert headroom < 0
    kind, detail = sc.hold_reason(node, expected_replicas=2, fork_factor=1.25)
    assert kind == "memory" and "past what a fork could be survived at" in detail
    # Order: a fork is the more specific reason, reported first.
    kind, _ = sc.hold_reason(_node(container_limit_bytes=40 * GB, rss=30 * GB, bgsave_in_progress=True),
                             expected_replicas=2, fork_factor=1.25)
    assert kind == "fork"


def test_the_sizing_rule_counts_replication_when_told():
    """The deployment guide's rule for the cluster overlay, at THREAD_COUNT 6:
    1.25 × 32 + 6 × 1.3 × 1 + 1 + 2 × 2 + 1 = 53.8 GiB. The three-argument form
    is unchanged, so an unreplicated node and every older caller see the same."""
    full = sc.container_memory_needed(
        32 * GB, 6, GB, repl_backlog_bytes=GB, replicas=2, replica_outbuf_hard_bytes=2 * GB,
    )
    assert full == int(1.25 * 32 * GB) + 6 * int(1.3 * GB) + GB + 2 * (2 * GB) + GB
    assert 53.7 < full / GB < 53.9
    assert full - sc.container_memory_needed(32 * GB, 6, GB) == GB + 4 * GB


def test_the_container_limit_comes_from_the_deployment_else_the_rule():
    node = _node()
    assert sc.container_limit_bytes(node, env_bytes=56 * GB) == 56 * GB
    # No statement from the deployment: the rule at the node's own settings,
    # the smallest limit a correctly sized container can have.
    assert sc.container_limit_bytes(node, env_bytes=None) == sc.container_memory_needed(
        32 * GB, 6, GB, repl_backlog_bytes=GB, replicas=2, replica_outbuf_hard_bytes=2 * GB,
    )
    # An unreporting thread count plans for the largest we ship.
    assert sc.container_limit_bytes(_node(thread_count=None), env_bytes=None) == sc.container_memory_needed(
        32 * GB, sc.THREAD_COUNT_ASSUMED, GB, repl_backlog_bytes=GB, replicas=2,
        replica_outbuf_hard_bytes=2 * GB,
    )
    # Nothing to evaluate the rule with: no limit, and the budget keeps to maxmemory.
    assert sc.container_limit_bytes(_node(query_mem_capacity=None), env_bytes=None) is None


def test_a_container_sized_below_the_rule_governs_before_maxmemory_does():
    """The incident's arithmetic on an under-sized container. maxmemory says
    12.6 GiB of growth (32 − 6.4 reserve − 13 used); a 40 GiB container holding
    15 GiB resident, forked at 1.25×, with 7.8 GiB of query memory and 5 GiB of
    replication buffers beside it, has less — and it is the container, not
    maxmemory, that the kernel enforces."""
    node = _node(container_limit_bytes=40 * GB)
    b = sc.compute_write_budget(
        node, reserve_pct=20, bytes_per_edge=512, bpe_source="default",
        explicit_ceiling=None, static_cap=25_000_000, fork_factor=1.25,
    )
    headroom = 40 * GB - int(1.25 * 15 * GB) - 6 * int(1.3 * GB) - (GB + 2 * 2 * GB) - GB
    assert b.container_headroom == headroom
    assert b.allowed_growth_by_container == int(headroom / 1.25)
    assert b.governed_by == "container"
    assert b.available_bytes == b.allowed_growth_by_container < 12.6 * GB
    assert b.as_stats()["container_limit"] == 40 * GB

    v = b.verdict(projected=30_000_000, growth_edges=b.available_bytes // 512 + 1)
    assert not v.ok and v.blocked_by == "container"
    text = sc.format_refusal(b, v, graph="g", composition="x")
    assert text.startswith(sc.REFUSAL_MARKER)
    assert "fork" in text and "container" in text and "replica full-sync" in text


def test_a_correctly_sized_container_leaves_maxmemory_governing():
    """The design point. A container sized by the rule has room for 1.25 ×
    maxmemory, so while RSS stays inside maxmemory the container is never
    the tighter ceiling — which is why the FORK HOLD, not this rule, is what
    protects a right-sized node: a fork under full write load copies far
    more than the quarter the rule allows for."""
    node = _node(container_limit_bytes=56 * GB)
    b = sc.compute_write_budget(
        node, reserve_pct=20, bytes_per_edge=512, bpe_source="default",
        explicit_ceiling=None, static_cap=25_000_000, fork_factor=1.25,
    )
    assert b.governed_by == "shard"
    assert b.available_bytes == 32 * GB - 32 * GB * 20 // 100 - 13 * GB
    assert b.allowed_growth_by_container > b.available_bytes


def test_without_a_container_limit_the_budget_is_what_it_was():
    node = _node(container_limit_bytes=None)
    b = sc.compute_write_budget(
        node, reserve_pct=20, bytes_per_edge=512, bpe_source="default",
        explicit_ceiling=None, static_cap=25_000_000,
    )
    assert b.governed_by == "shard" and b.container_headroom is None
    assert "container_limit" not in b.as_stats()
