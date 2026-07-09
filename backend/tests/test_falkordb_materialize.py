"""Unit tests for the :AGGREGATED materialization pipeline
(EXTRACT → COMPUTE → RECONCILE → APPLY).

These do NOT need a live FalkorDB — they construct a FalkorDBProvider and
monkeypatch its query primitives with an in-memory graph that simulates
the ID-range scans, ID-seek MERGE writes and latestUpdate-guarded deletes,
so we can assert the high-value correctness properties:

* full ancestor-chain cross-product semantics (ontology hierarchy),
  leaf↔leaf mirror pairs excluded by default;
* exact weights, including under overflow flushes and crash-resume;
* diff apply: an idempotent re-run performs zero writes and deletes;
* precise reconcile deletes with the run-start guard (a failed or resumed
  run can never wipe good edges — the v2 failure mode);
* deterministic v3 cursor round-trip and resume behavior.
"""
import asyncio
import re
import time

import pytest

from backend.app.providers import falkordb_materialize as mat
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.aggregation.cancel import JobCancelled


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


class _FakeFalkor:
    """In-memory graph answering exactly the Cypher shapes the pipeline
    issues (in_source projection mode)."""

    def __init__(self):
        self.nodes = {}        # node_id -> (urn, label)
        self.typed_edges = {}  # TYPE -> [(rid, sid, tid), ...]
        self.agg = {}          # (aid, bid) -> {rid, aggKey, weight, digest, latest, ...}
        self._next_agg_rid = 0
        self.write_queries = 0
        self.deleted_pairs = []

    # -- seeding helpers --

    def add_node(self, nid, urn, label):
        self.nodes[nid] = (urn, label)

    def add_edge(self, etype, rid, sid, tid):
        self.typed_edges.setdefault(etype, []).append((rid, sid, tid))

    def seed_aggregated(self, aid, bid, *, weight, digest="", latest=1000):
        s_urn = self.nodes[aid][0]
        t_urn = self.nodes[bid][0]
        self.agg[(aid, bid)] = {
            "rid": self._alloc_rid(),
            "aggKey": f"{s_urn}|{t_urn}",
            "weight": weight,
            "digest": digest,
            "latest": latest,
            "types": [],
            "sl": None,
            "tl": None,
        }

    def _alloc_rid(self):
        rid = self._next_agg_rid
        self._next_agg_rid += 1
        return rid

    # -- query handlers --

    _TYPE_RE = re.compile(r"\[r:`([^`]+)`\]")

    def _urn_to_id(self, urn):
        for nid, (u, _label) in self.nodes.items():
            if u == urn:
                return nid
        raise AssertionError(f"unknown urn in write: {urn}")

    async def ro_query(self, cypher, params=None, **kw):
        params = params or {}
        if "r:AGGREGATED" in cypher:
            return await self._agg_read(cypher, params)
        if "MATCH (n)" in cypher and "max(ID(n))" in cypher:
            return _Result([[max(self.nodes, default=None)]])
        if "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi" in cypher:
            lo, hi = params["lo"], params["hi"]
            return _Result([
                [nid, urn, [label]]
                for nid, (urn, label) in self.nodes.items()
                if lo <= nid < hi
            ])
        m = self._TYPE_RE.search(cypher)
        etype = m.group(1) if m else None
        edges = self.typed_edges.get(etype, [])
        if "max(ID(r))" in cypher:
            return _Result([[max((r for r, _, _ in edges), default=None)]])
        if "count(r)" in cypher:
            return _Result([[len(edges)]])
        if "WHERE ID(r) >= $lo AND ID(r) < $hi" in cypher:
            lo, hi = params["lo"], params["hi"]
            return _Result([[s, t] for (r, s, t) in edges if lo <= r < hi])
        raise AssertionError(f"unhandled ro_query: {cypher}")

    async def _agg_read(self, cypher, params):
        if "max(ID(r))" in cypher:
            rids = [v["rid"] for v in self.agg.values()]
            return _Result([[max(rids, default=None)]])
        if "WHERE ID(r) >= $lo AND ID(r) < $hi" in cypher:
            lo, hi = params["lo"], params["hi"]
            rows = []
            for (aid, bid), v in self.agg.items():
                if lo <= v["rid"] < hi:
                    rows.append([
                        aid, bid, v["aggKey"], v["weight"], v["digest"],
                        v["latest"],
                    ])
            return _Result(rows)
        raise AssertionError(f"unhandled agg read: {cypher}")

    async def proj_query(self, cypher, params=None, **kw):
        params = params or {}
        if "CREATE INDEX" in cypher:
            return _Result()
        self.write_queries += 1
        now_ms = int(time.time() * 1000)
        if "MERGE (s)-[r:AGGREGATED {aggKey: item.k}]->(t)" in cypher:
            # Label+urn node match (index seek) — the only supported write
            # form; ID-seek-under-UNWIND is banned (scans per row).
            add_mode = "coalesce(r.weight, 0) + item.w" in cypher
            for item in params["batch"]:
                key = (self._urn_to_id(item["s"]), self._urn_to_id(item["t"]))
                edge = self.agg.get(key)
                if edge is None:
                    edge = {"rid": self._alloc_rid(), "weight": 0}
                    self.agg[key] = edge
                edge["aggKey"] = item["k"]
                edge["weight"] = (
                    edge.get("weight", 0) + item["w"] if add_mode else item["w"]
                )
                edge["types"] = item["et"]
                edge["sl"] = item["sl"]
                edge["tl"] = item["tl"]
                edge["digest"] = params["digest"]
                edge["latest"] = now_ms
            return _Result()
        if "DELETE r" in cypher:
            run_start = params["runStart"]
            for agg_key in params["keys"]:
                match = [
                    key for key, edge in self.agg.items()
                    if edge.get("aggKey") == agg_key
                    and edge.get("latest", 0) < run_start
                ]
                for key in match:
                    self.deleted_pairs.append(key)
                    del self.agg[key]
            return _Result()
        raise AssertionError(f"unhandled proj_query: {cypher}")


def _make_provider(fake, entity_levels=None):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = entity_levels or {}
    p._level_digest = "digest-1"
    p._bulk_create_batch_size = 1000
    p._bulk_create_timeout_s = 60.0
    p._redis = None
    p._ro_query = fake.ro_query
    p._proj_ro_query = fake.ro_query
    p._proj_query = fake.proj_query
    return p


def _run(coro):
    # asyncio.run gives each test a fresh loop — immune to other test
    # modules closing or replacing the default loop.
    return asyncio.run(coro)


async def _materialize(p, *, last_cursor=None, progress=None, should_cancel=None):
    return await mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        last_cursor=last_cursor,
        progress_callback=progress,
        intra_batch_callback=None,
        should_cancel=should_cancel,
    )


def _seed_two_chain_graph(fake):
    """Domain ⊃ Table ⊃ Column, two chains ABC and DEF.

    Nodes: 1=domain_abc 2=table_a 3=col_a / 11=domain_def 12=table_b 13=col_b
    Containment (parent→child), lineage col_a -> col_b (×2 parallel edges).
    """
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_node(1, "urn:domain_abc", "domain")
    fake.add_node(2, "urn:table_a", "table")
    fake.add_node(3, "urn:col_a", "column")
    fake.add_node(11, "urn:domain_def", "domain")
    fake.add_node(12, "urn:table_b", "table")
    fake.add_node(13, "urn:col_b", "column")
    fake.add_edge("CONTAINS", 0, 1, 2)   # domain_abc > table_a
    fake.add_edge("CONTAINS", 1, 2, 3)   # table_a > col_a
    fake.add_edge("CONTAINS", 2, 11, 12)
    fake.add_edge("CONTAINS", 3, 12, 13)
    fake.add_edge("FLOWS", 10, 3, 13)
    fake.add_edge("FLOWS", 11, 3, 13)    # parallel edge → weight 2
    return levels


# Full ancestor cross-product of ([col_a, table_a, domain_abc] ×
# [col_b, table_b, domain_def]) minus the leaf↔leaf mirror (col_a, col_b).
_EXPECTED_PAIRS = {
    (3, 12), (3, 11),
    (2, 13), (2, 12), (2, 11),
    (1, 13), (1, 12), (1, 11),
}


# ── cursor ──────────────────────────────────────────────────────────────


def test_cursor_roundtrip():
    c = mat.make_cursor(1234, "reconcile", 500000)
    assert c == "v3:1234:reconcile:500000"
    assert mat.parse_cursor(c) == (1234, "reconcile", 500000)


def test_cursor_rejects_legacy_and_garbage():
    assert mat.parse_cursor(None) is None
    assert mat.parse_cursor("") is None
    assert mat.parse_cursor("v2:123:0:99") is None          # legacy streaming
    assert mat.parse_cursor("urn:a|urn:b") is None          # legacy composite
    assert mat.parse_cursor("v3:12:badphase:0") is None
    assert mat.parse_cursor("v3:x:apply:0") is None


# ── semantics ────────────────────────────────────────────────────────────


def test_cross_product_semantics_drop_leaf_pairs():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    # Every pair carries the weight of BOTH parallel leaf edges.
    for key, edge in fake.agg.items():
        assert edge["weight"] == 2, key
        assert edge["types"] == ["FLOWS"]
        assert edge["digest"] == "digest-1"
    # Level stamps come from the ontology's entity-type levels.
    assert fake.agg[(1, 11)]["sl"] == 0 and fake.agg[(1, 11)]["tl"] == 0
    assert fake.agg[(2, 13)]["sl"] == 1 and fake.agg[(2, 13)]["tl"] == 2
    assert result["aggregated_edges_affected"] == len(_EXPECTED_PAIRS)
    assert result["processed"] == 2
    assert result["errors"] == 0


def test_leaf_pairs_env_flag_restores_mirrors(monkeypatch):
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "true")
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS | {(3, 13)}
    assert fake.agg[(3, 13)]["weight"] == 2


def test_equal_endpoint_pairs_excluded_but_rollups_kept():
    """Lineage between siblings under one table: the (table, table)
    self-pair is excluded, but its parents' cross pairs must exist."""
    fake = _FakeFalkor()
    levels = {"table": 0, "column": 1}
    fake.add_node(1, "urn:t", "table")
    fake.add_node(2, "urn:c1", "column")
    fake.add_node(3, "urn:c2", "column")
    fake.add_edge("CONTAINS", 0, 1, 2)
    fake.add_edge("CONTAINS", 1, 1, 3)
    fake.add_edge("FLOWS", 10, 2, 3)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    # (c1,c2) leaf mirror dropped; (t,t) equal pair dropped; the mixed
    # pairs (c1→t) and (t→c2) remain.
    assert set(fake.agg.keys()) == {(2, 1), (1, 3)}


def test_multi_parent_longest_chain():
    """A node with two parents follows the parent with the LONGEST chain
    (legacy ``ORDER BY length(path) DESC`` parity)."""
    fake = _FakeFalkor()
    levels = {"root": 0, "mid": 1, "leaf": 2}
    fake.add_node(1, "urn:deep_root", "root")
    fake.add_node(2, "urn:mid", "mid")
    fake.add_node(3, "urn:shallow", "root")
    fake.add_node(4, "urn:leaf", "leaf")
    fake.add_node(5, "urn:other", "leaf")
    fake.add_edge("CONTAINS", 0, 1, 2)   # deep_root > mid
    fake.add_edge("CONTAINS", 1, 2, 4)   # mid > leaf  (depth-2 chain)
    fake.add_edge("CONTAINS", 2, 3, 4)   # shallow > leaf (depth-1 chain)
    fake.add_edge("FLOWS", 10, 4, 5)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    # leaf's chain resolves through mid → deep_root, not shallow.
    assert (2, 5) in fake.agg
    assert (1, 5) in fake.agg
    assert (3, 5) not in fake.agg


# ── diff apply / reconcile ──────────────────────────────────────────────


def test_second_run_is_a_noop():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)
    _run(_materialize(p))

    writes_before = fake.write_queries
    state_before = {k: dict(v) for k, v in fake.agg.items()}
    result = _run(_materialize(p))

    # Reconcile matched every pair with identical weight+digest → the
    # second run issued ZERO write queries and deleted nothing.
    assert fake.write_queries == writes_before
    assert fake.deleted_pairs == []
    assert {k: {**v} for k, v in fake.agg.items()} == state_before
    assert result["aggregated_edges_affected"] == len(_EXPECTED_PAIRS)


def test_stale_edges_deleted_and_changed_weights_updated():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    # Pre-existing state from an older generation: one stale pair that the
    # new run does not produce, one desired pair with a wrong weight.
    fake.add_node(99, "urn:ghost", "table")
    fake.seed_aggregated(99, 12, weight=7, latest=1000)      # stale → delete
    fake.seed_aggregated(1, 11, weight=42, latest=1000)      # wrong → update
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert (99, 12) not in fake.agg
    assert (99, 12) in fake.deleted_pairs
    assert fake.agg[(1, 11)]["weight"] == 2
    assert set(fake.agg.keys()) == _EXPECTED_PAIRS


def test_concurrent_writes_survive_reconcile():
    """An AGGREGATED edge written during the run (latestUpdate >= run
    start, e.g. by on_lineage_edge_written) must NOT be deleted even
    though the pipeline's aggregate does not contain it."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    fake.add_node(99, "urn:live", "table")
    fake.seed_aggregated(
        99, 12, weight=1, latest=int(time.time() * 1000) + 60_000,
    )
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert (99, 12) in fake.agg  # protected by the run-start guard


def test_legacy_v2_cursor_starts_fresh_without_wiping():
    """A v2/garbage cursor must trigger a clean fresh run that UPDATES
    the existing edges in place — never the old wipe-and-restart."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    fake.seed_aggregated(1, 11, weight=42, latest=1000)
    p = _make_provider(fake, levels)

    _run(_materialize(p, last_cursor="v2:1718000000:1:5000"))

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    assert fake.agg[(1, 11)]["weight"] == 2
    # The desired pair was updated in place, not deleted+recreated.
    assert (1, 11) not in fake.deleted_pairs


# ── overflow / exactness ────────────────────────────────────────────────


def test_overflow_flush_keeps_exact_weights(monkeypatch):
    """Force the accumulator over its cap mid-compute; weights must come
    out exactly as in the unconstrained run."""
    monkeypatch.setattr(mat, "_max_pending_pairs", lambda: 3)
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    for key, edge in fake.agg.items():
        assert edge["weight"] == 2, key
    assert result["aggregated_edges_affected"] == len(_EXPECTED_PAIRS)


# ── resume ──────────────────────────────────────────────────────────────


def test_first_checkpoint_persists_parseable_cursor():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)
    cursors = []

    async def progress(processed, total, cursor, created, phase, *, progress_pct=None):
        cursors.append((cursor, phase, progress_pct))

    _run(_materialize(p, progress=progress))

    assert cursors, "no checkpoints fired"
    first_cursor, first_phase, _ = cursors[0]
    assert mat.parse_cursor(first_cursor) is not None
    assert first_phase == "extracting"
    # progress_pct is monotonic 0-100 across phases
    pcts = [pct for (_, _, pct) in cursors if pct is not None]
    assert pcts == sorted(pcts)
    assert pcts[-1] == 100
    # every phase label surfaced to the UI is one of the new set
    assert {ph for (_, ph, _) in cursors} <= {
        "extracting", "computing", "reconciling", "applying",
    }


def test_cancel_then_resume_completes_exactly():
    """Cancel mid-run (after some writes have landed), then resume from the
    persisted cursor: the final state must be exact, and no desired edge
    may ever be deleted along the way."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    # Small cap → writes happen during compute, so cancellation interrupts
    # a run that has already flushed partial state.
    p = _make_provider(fake, levels)
    cursors = []

    async def progress(processed, total, cursor, created, phase, *, progress_pct=None):
        cursors.append(cursor)

    cancel_after_writes = {"armed": False}

    def should_cancel():
        return cancel_after_writes["armed"] and fake.write_queries > 0

    import backend.app.providers.falkordb_materialize as m
    orig_cap = m._max_pending_pairs
    m._max_pending_pairs = lambda: 3
    try:
        cancel_after_writes["armed"] = True
        with pytest.raises(JobCancelled):
            _run(_materialize(p, progress=progress, should_cancel=should_cancel))

        edges_after_cancel = len(fake.agg)
        assert cursors, "no checkpoint before cancellation"
        resume_cursor = cursors[-1]
        assert mat.parse_cursor(resume_cursor) is not None

        # Resume: same cursor, no cancellation.
        _run(_materialize(p, last_cursor=resume_cursor))
    finally:
        m._max_pending_pairs = orig_cap

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    for key, edge in fake.agg.items():
        assert edge["weight"] == 2, key
    # No desired edge was ever deleted (count never dropped below the
    # partially-materialized state at cancellation).
    assert not (set(fake.deleted_pairs) & _EXPECTED_PAIRS)
    assert len(fake.agg) >= min(edges_after_cancel, len(_EXPECTED_PAIRS))


# ── guards ──────────────────────────────────────────────────────────────


def test_no_lineage_types_returns_zero_result():
    fake = _FakeFalkor()
    p = _make_provider(fake)
    result = _run(mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["AGGREGATED"],  # filtered out
        last_cursor=None,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
    ))
    assert result["aggregated_edges_affected"] == 0
    assert result["processed"] == 0


def test_containment_cycle_is_broken():
    fake = _FakeFalkor()
    levels = {"a": 0, "b": 1}
    fake.add_node(1, "urn:x", "a")
    fake.add_node(2, "urn:y", "b")
    fake.add_node(3, "urn:z", "b")
    fake.add_edge("CONTAINS", 0, 1, 2)
    fake.add_edge("CONTAINS", 1, 2, 1)   # cycle x <-> y
    fake.add_edge("FLOWS", 10, 2, 3)
    p = _make_provider(fake, levels)

    # Must terminate and produce the acyclic part of the rollup.
    _run(_materialize(p))
    assert (1, 3) in fake.agg
