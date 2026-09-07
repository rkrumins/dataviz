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
    def __init__(self, info, *, raise_exc=None, delay=0.0):
        self._info, self._raise, self._delay = info, raise_exc, delay
        self.connection_pool = types.SimpleNamespace(
            connection_kwargs={"host": "falkor", "port": 6379},
        )

    async def info(self, section=None):
        assert section == "memory"
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise:
            raise self._raise
        return self._info


class _Node:
    host, port = "10.0.0.7", 6379


class _Cluster:
    def __init__(self, info):
        self._info = info
        self.initialized = False
        self.targets = []
        self.nodes_manager = types.SimpleNamespace(get_node_from_slot=lambda slot: _Node())

    async def initialize(self):
        self.initialized = True

    def keyslot(self, key):
        return 42

    async def execute_command(self, *args, target_nodes=None):
        assert args == ("INFO", "memory")
        self.targets.append(target_nodes)
        return self._info


def _db(conn):
    return types.SimpleNamespace(connection=conn)


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
