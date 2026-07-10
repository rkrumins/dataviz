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
        self._urn_ids = {}
        self.write_queries = 0
        self.deleted_pairs = []

    # -- seeding helpers --

    def add_node(self, nid, urn, label):
        self.nodes[nid] = (urn, label)
        self._urn_ids[urn] = nid

    def add_edge(self, etype, rid, sid, tid):
        self.typed_edges.setdefault(etype, []).append((rid, sid, tid))

    def seed_aggregated(
        self, aid, bid, *, weight, digest="", latest=1000,
        types=("FLOWS",), sl=None, tl=None, agg_key=...,
    ):
        s_urn = self.nodes[aid][0]
        t_urn = self.nodes[bid][0]
        self.agg[(aid, bid)] = {
            "rid": self._alloc_rid(),
            "aggKey": f"{s_urn}|{t_urn}" if agg_key is ... else agg_key,
            "weight": weight,
            "digest": digest,
            "latest": latest,
            "types": list(types),
            "sl": sl,
            "tl": tl,
        }

    def _alloc_rid(self):
        rid = self._next_agg_rid
        self._next_agg_rid += 1
        return rid

    # -- query handlers --

    _TYPE_RE = re.compile(r"\[r:`([^`]+)`\]")

    def _urn_to_id(self, urn):
        nid = self._urn_ids.get(urn)
        if nid is None:
            raise AssertionError(f"unknown urn in write: {urn}")
        return nid

    _LABEL_SCAN_RE = re.compile(r"MATCH \(n:`([^`]+)`\) WHERE ID\(n\)")

    async def ro_query(self, cypher, params=None, **kw):
        params = params or {}
        if "r:AGGREGATED" in cypher:
            return await self._agg_read(cypher, params)
        if "MATCH (n)" in cypher and "max(ID(n))" in cypher:
            return _Result([[max(self.nodes, default=None)]])
        lbl_match = self._LABEL_SCAN_RE.search(cypher)
        if lbl_match:
            lbl = lbl_match.group(1)
            lo, hi = params["lo"], params["hi"]
            rows = [
                ([nid, urn] if "n.urn" in cypher else [nid])
                for nid, (urn, label) in self.nodes.items()
                if label == lbl and lo <= nid < hi
            ]
            return _Result(rows)
        if "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi" in cypher:
            lo, hi = params["lo"], params["hi"]
            return _Result([
                [nid, urn, [label]]
                for nid, (urn, label) in self.nodes.items()
                if lo <= nid < hi
            ])
        if cypher.strip() == "RETURN timestamp()":
            return _Result([[int(time.time() * 1000)]])
        if cypher.strip() == "MATCH (n) RETURN 1 LIMIT 1":
            return _Result([[1]] if self.nodes else [])
        if "r.aggKey IS NULL" in cypher and "RETURN 1 LIMIT 1" in cypher:
            # Legacy-generation probe: fake edges always carry aggKey
            # unless a test explicitly clears it.
            legacy = [e for e in self.agg.values() if not e.get("aggKey")]
            return _Result([[1]] if legacy else [])
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
                        v["latest"], v.get("types") or [], v.get("sl"),
                        v.get("tl"),
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
        if "r.aggKey IS NULL" in cypher and "DELETE r" in cypher:
            # Chunked legacy-generation healing pass.
            run_start = params["runStart"]
            victims = [
                k for k, e in self.agg.items()
                if not e.get("aggKey") and e.get("latest", 0) < run_start
            ]
            for k in victims:
                self.deleted_pairs.append(k)
                del self.agg[k]
            res = _Result()
            res.relationships_deleted = len(victims)
            return res
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


# Default (level-based boundary): only the SAME-LEVEL diagonal is
# materialized — table→table (2,12) and domain→domain (1,11). One pair
# per level per raw edge, shrinking monotonically up the hierarchy.
# Leaf-involving pairs (column→table, column→domain, …) AND mixed-level
# pairs (table→domain (2,11), domain→table (1,12)) are served on demand
# by the read path.
_EXPECTED_PAIRS = {
    (2, 12), (1, 11),
}

# Legacy full-cube mode (materialize_fine_pairs=true): the full ancestor
# cross-product minus the leaf↔leaf mirror (col_a, col_b).
_EXPECTED_FINE_PAIRS = _EXPECTED_PAIRS | {
    (2, 11), (1, 12),
    (3, 12), (3, 11),
    (2, 13), (1, 13),
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
    assert fake.agg[(2, 12)]["sl"] == 1 and fake.agg[(2, 12)]["tl"] == 1
    assert result["aggregated_edges_affected"] == len(_EXPECTED_PAIRS)
    assert result["processed"] == 2
    assert result["errors"] == 0


def test_fine_pairs_env_flag_restores_full_cube(monkeypatch):
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_FINE_PAIRS
    for key in _EXPECTED_FINE_PAIRS:
        assert fake.agg[key]["weight"] == 2, key


def test_leaf_pairs_env_flag_restores_mirrors(monkeypatch):
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "true")
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_FINE_PAIRS | {(3, 13)}
    assert fake.agg[(3, 13)]["weight"] == 2


def test_equal_endpoint_pairs_excluded_but_rollups_kept(monkeypatch):
    """Lineage between siblings under one table: the (table, table)
    self-pair is excluded, but its parents' cross pairs must exist.
    (Fine mode: the mixed pairs asserted here are on-demand by default.)"""
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
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


def test_multi_parent_longest_chain(monkeypatch):
    """A node with two parents follows the parent with the LONGEST chain
    (legacy ``ORDER BY length(path) DESC`` parity)."""
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
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
    """Force the overflow flush to ACTUALLY FIRE mid-rollup (the previous
    version of this test never flushed — the knob clamp floors the cap at
    50k — so the property it claimed to protect was unverified, and a
    stale accumulator binding after the flush silently discarded every
    later merge). 4097 column pairs under 4097 table pairs under one
    domain pair, cap 4097: the flush fires at the n=4096 checkpoint and
    the remaining merges MUST land in the fresh accumulator."""
    n_pairs = 4097
    monkeypatch.setattr(
        mat.AggregationPipeline, "_pair_cap", lambda self: n_pairs,
    )
    fake = _FakeFalkor()
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_node(1, "urn:dom_a", "domain")
    fake.add_node(2, "urn:dom_b", "domain")
    nid = 10
    rid = 0
    for i in range(n_pairs):
        ta, ca, tb, cb = nid, nid + 1, nid + 2, nid + 3
        nid += 4
        fake.add_node(ta, f"urn:ta{i}", "table")
        fake.add_node(ca, f"urn:ca{i}", "column")
        fake.add_node(tb, f"urn:tb{i}", "table")
        fake.add_node(cb, f"urn:cb{i}", "column")
        fake.add_edge("CONTAINS", rid, 1, ta); rid += 1
        fake.add_edge("CONTAINS", rid, ta, ca); rid += 1
        fake.add_edge("CONTAINS", rid, 2, tb); rid += 1
        fake.add_edge("CONTAINS", rid, tb, cb); rid += 1
        fake.add_edge("FLOWS", rid, ca, cb); rid += 1
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    # Every table pair present with weight 1 — including the ones merged
    # AFTER the mid-rollup flush — and the shared domain pair carries the
    # full raw-edge count.
    assert len(fake.agg) == n_pairs + 1
    dom_key = (1, 2)
    assert fake.agg[dom_key]["weight"] == n_pairs
    for key, edge in fake.agg.items():
        if key != dom_key:
            assert edge["weight"] == 1, key
    assert result["aggregated_edges_affected"] == n_pairs + 1


def test_write_budget_counts_flushed_and_pending_as_union(monkeypatch):
    """A key flushed earlier AND re-touched since sits in both the
    flushed set and the accumulator — the budget must count it once.
    Budget == true result size exactly: summing would overshoot and
    terminally fail a legitimately under-budget job."""
    n_pairs = 4097
    monkeypatch.setattr(
        mat.AggregationPipeline, "_pair_cap", lambda self: n_pairs,
    )
    # True result size is n_pairs + 1; the domain pair is flushed at the
    # mid-rollup flush AND re-touched afterwards (every later raw edge
    # rolls into it), so the naive sum reads n_pairs + 2 and raises.
    monkeypatch.setattr(mat, "_max_materialized_edges", lambda: n_pairs + 1)
    fake = _FakeFalkor()
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_node(1, "urn:dom_a", "domain")
    fake.add_node(2, "urn:dom_b", "domain")
    nid, rid = 10, 0
    for i in range(n_pairs):
        ta, ca, tb, cb = nid, nid + 1, nid + 2, nid + 3
        nid += 4
        fake.add_node(ta, f"urn:ta{i}", "table")
        fake.add_node(ca, f"urn:ca{i}", "column")
        fake.add_node(tb, f"urn:tb{i}", "table")
        fake.add_node(cb, f"urn:cb{i}", "column")
        fake.add_edge("CONTAINS", rid, 1, ta); rid += 1
        fake.add_edge("CONTAINS", rid, ta, ca); rid += 1
        fake.add_edge("CONTAINS", rid, 2, tb); rid += 1
        fake.add_edge("CONTAINS", rid, tb, cb); rid += 1
        fake.add_edge("FLOWS", rid, ca, cb); rid += 1
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))
    assert result["aggregated_edges_affected"] == n_pairs + 1


def test_empty_boundary_map_fails_loud_instead_of_wiping():
    """A multi-level ontology whose labels match NOTHING in a non-empty
    graph must fail the run — continuing would materialize nothing and
    reconcile would delete every existing :AGGREGATED edge as stale.
    Terminal (MaterializationPreconditionFailed): deterministic, so the
    worker must not burn its retry budget re-running EXTRACT."""
    fake = _FakeFalkor()
    levels = {"domain": 0, "column": 1}
    fake.add_node(3, "urn:col_a", "weird_label")
    fake.add_node(13, "urn:col_b", "weird_label")
    fake.add_edge("FLOWS", 10, 3, 13)
    fake.seed_aggregated(3, 13, weight=7, latest=1000)
    p = _make_provider(fake, levels)

    with pytest.raises(
        mat.MaterializationPreconditionFailed, match="boundary is EMPTY"
    ):
        _run(_materialize(p))
    # The pre-existing edge survives untouched.
    assert fake.agg[(3, 13)]["weight"] == 7
    assert fake.deleted_pairs == []


def test_single_level_ontology_run_succeeds_not_fails():
    """A single-level level map has no container boundary — the run must
    fall back to the legacy lattice (original behavior) instead of
    failing on an empty boundary map. Flat graphs succeed as a no-op
    (exact leaf pairs are served on demand by the read path); a
    SELF-NESTING single-label graph (Folder⊃Folder) still materializes
    the rolled-up ancestor pairs the original cube stored."""
    fake = _FakeFalkor()
    levels = {"column": 0}
    fake.add_node(3, "urn:col_a", "column")
    fake.add_node(13, "urn:col_b", "column")
    fake.add_edge("FLOWS", 10, 3, 13)
    p = _make_provider(fake, levels)
    result = _run(_materialize(p))
    assert result["errors"] == 0

    fake2 = _FakeFalkor()
    fake2.add_node(1, "urn:folder_a", "folder")
    fake2.add_node(2, "urn:folder_b", "folder")
    fake2.add_node(3, "urn:folder_c", "folder")
    fake2.add_node(4, "urn:folder_d", "folder")
    fake2.add_edge("CONTAINS", 0, 1, 3)   # a ⊃ c
    fake2.add_edge("CONTAINS", 1, 2, 4)   # b ⊃ d
    fake2.add_edge("FLOWS", 10, 3, 4)     # c → d
    p2 = _make_provider(fake2, {"folder": 0})
    _run(_materialize(p2))
    assert set(fake2.agg.keys()) == {(3, 2), (1, 4), (1, 2)}


def test_empty_graph_is_a_clean_noop():
    """Aggregation triggered before ingest (onboarding) must complete as
    a no-op, not surface as a FAILED job after burning retries."""
    fake = _FakeFalkor()
    levels = {"domain": 0, "column": 1}
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert result["aggregated_edges_affected"] == 0
    assert result["errors"] == 0
    assert fake.deleted_pairs == []


def test_alias_variant_nonleaf_labels_get_integer_level_stamps():
    """The node directory records the graph's OBSERVED label spellings;
    the level map is keyed by DECLARED ids. On alias-variant sources the
    stamps must still resolve — NULL sourceLevel/targetLevel blinds the
    mixed-level on-demand reader, which filters on them."""
    fake = _FakeFalkor()
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_node(1, "urn:domain_abc", "DOM_OBS")
    fake.add_node(2, "urn:table_a", "TBL_OBS")
    fake.add_node(3, "urn:col_a", "COL_OBS")
    fake.add_node(11, "urn:domain_def", "DOM_OBS")
    fake.add_node(12, "urn:table_b", "TBL_OBS")
    fake.add_node(13, "urn:col_b", "COL_OBS")
    fake.add_edge("CONTAINS", 0, 1, 2)
    fake.add_edge("CONTAINS", 1, 2, 3)
    fake.add_edge("CONTAINS", 2, 11, 12)
    fake.add_edge("CONTAINS", 3, 12, 13)
    fake.add_edge("FLOWS", 10, 3, 13)
    p = _make_provider(fake, levels)
    p._source_entity_aliases = {
        "DOMAIN": ["DOM_OBS"], "TABLE": ["TBL_OBS"], "COLUMN": ["COL_OBS"],
    }

    _run(_materialize(p))

    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    assert fake.agg[(2, 12)]["sl"] == 1 and fake.agg[(2, 12)]["tl"] == 1
    assert fake.agg[(1, 11)]["sl"] == 0 and fake.agg[(1, 11)]["tl"] == 0


def test_reconcile_heals_stale_source_edge_types_and_level_stamps():
    """Weight-preserving drift: a pair whose weight and digest match but
    whose sourceEdgeTypes were replaced type-for-type (or whose level
    stamps are NULL from a pre-alias-fix build) must be re-written —
    otherwise a type-filtered trace drops the edge forever."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    # Same weight (2) and digest as the run will compute, but wrong type
    # list and NULL level stamps.
    fake.seed_aggregated(
        1, 11, weight=2, digest="digest-1", latest=1000,
        types=("TRANSFORMS",), sl=None, tl=None,
    )
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    assert fake.agg[(1, 11)]["types"] == ["FLOWS"]
    assert fake.agg[(1, 11)]["sl"] == 0 and fake.agg[(1, 11)]["tl"] == 0


def test_legacy_null_aggkey_edges_healed_in_chunks():
    """Edges from generations that predate the aggKey contract can never
    be reconciled by the keyed delete — the healing pass must remove
    them (in bounded chunks) so they don't double-serve pairs forever."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    fake.seed_aggregated(2, 12, weight=9, latest=1000, agg_key=None)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    # The legacy edge was removed and the canonical pair re-created with
    # the exact recomputed weight.
    assert fake.agg[(2, 12)]["aggKey"] == "urn:table_a|urn:table_b"
    assert fake.agg[(2, 12)]["weight"] == 2


# ── resume ──────────────────────────────────────────────────────────────


def test_first_checkpoint_persists_parseable_cursor():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)
    cursors = []

    async def progress(
        processed, total, cursor, created, phase,
        *, progress_pct=None, stats=None,
    ):
        cursors.append((cursor, phase, progress_pct, stats))

    _run(_materialize(p, progress=progress))

    assert cursors, "no checkpoints fired"
    first_cursor, first_phase, _, _ = cursors[0]
    assert mat.parse_cursor(first_cursor) is not None
    assert first_phase == "extracting"
    # progress_pct is monotonic 0-100 across phases
    pcts = [pct for (_, _, pct, _) in cursors if pct is not None]
    assert pcts == sorted(pcts)
    assert pcts[-1] == 100
    # every phase label surfaced to the UI is one of the new set
    assert {ph for (_, ph, _, _) in cursors} <= {
        "extracting", "computing", "reconciling", "applying",
    }
    # live write/delete stats ride along on every checkpoint
    final_stats = cursors[-1][3]
    assert final_stats is not None and final_stats["writes"] == len(_EXPECTED_PAIRS)


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


def test_containment_cycle_is_broken(monkeypatch):
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
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


def test_write_budget_guard_fails_loud_instead_of_oom(monkeypatch):
    """The pipeline must refuse to materialize more edges than the
    configured budget — failing the job with guidance instead of
    OOM-killing the shared FalkorDB instance (the production incident:
    1.17M edges → 5.6M pairs → instance down)."""
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    monkeypatch.setattr(mat, "_max_materialized_edges", lambda: 4)

    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    # Fine mode computes 8+ pairs > budget of 4 — the guard fires before
    # any write reaches the graph, with the dedicated non-retryable
    # exception type.
    with pytest.raises(
        mat.MaterializationBudgetExceeded, match="max_materialized_edges"
    ):
        _run(_materialize(p))
    assert fake.agg == {}


def test_cross_level_raw_edges_keep_direct_pair(monkeypatch):
    """A raw lineage edge whose endpoints are non-leaf nodes at DIFFERENT
    levels (table→domain) keeps its direct base pair — the only exact
    record of the cross-level fact — while mixed-level ROLLUPS stay
    excluded from the default diagonal."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    fake.add_edge("FLOWS", 12, 2, 11)   # raw table_a → domain_def

    p = _make_provider(fake, levels)
    _run(_materialize(p))

    # Diagonal pairs from the leaf edges, plus: the direct cross-level
    # base pair (2,11) w=1 and its same-level rollup (1,11) — which now
    # carries the 2 leaf edges AND the cross-level edge.
    assert set(fake.agg.keys()) == {(2, 12), (1, 11), (2, 11)}
    assert fake.agg[(2, 11)]["weight"] == 1
    assert fake.agg[(1, 11)]["weight"] == 3
    assert fake.agg[(2, 12)]["weight"] == 2


def test_top_level_domain_cross_product_is_complete():
    """The user-facing contract at the very top: EVERY distinct
    domain→domain relationship implied by leaf lineage must materialize
    — the full cross product of top-level pairs, not a subset. Three
    source domains, three target domains, four leaf edges spanning
    four different domain pairs."""
    fake = _FakeFalkor()
    levels = {"domain": 0, "table": 1, "column": 2}
    nid, rid = 1, 0
    cols = {}
    for side, count in (("d", 3), ("e", 3)):
        for i in range(1, count + 1):
            dom, tab, col = nid, nid + 1, nid + 2
            nid += 3
            fake.add_node(dom, f"urn:{side}{i}", "domain")
            fake.add_node(tab, f"urn:{side}{i}_t", "table")
            fake.add_node(col, f"urn:{side}{i}_c", "column")
            fake.add_edge("CONTAINS", rid, dom, tab); rid += 1
            fake.add_edge("CONTAINS", rid, tab, col); rid += 1
            cols[f"{side}{i}"] = (dom, tab, col)
    # Leaf lineage spanning four distinct domain pairs.
    for src, tgt in (("d1", "e1"), ("d1", "e2"), ("d2", "e3"), ("d3", "e1")):
        fake.add_edge("FLOWS", rid, cols[src][2], cols[tgt][2]); rid += 1
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    dom_pairs = {
        (a, b) for (a, b) in fake.agg
        if fake.nodes[a][1] == "domain" and fake.nodes[b][1] == "domain"
    }
    assert dom_pairs == {
        (cols["d1"][0], cols["e1"][0]),
        (cols["d1"][0], cols["e2"][0]),
        (cols["d2"][0], cols["e3"][0]),
        (cols["d3"][0], cols["e1"][0]),
    }
    for pair in dom_pairs:
        assert fake.agg[pair]["weight"] == 1
    # And the diagnostics report the same picture.
    assert result["run_stats"]["pairs_by_level"]["L0->L0"] == 4
    assert result["run_stats"]["pairs_by_level"]["L1->L1"] == 4


def test_ragged_chain_materializes_canonical_bridged_pairs():
    """A column hanging DIRECTLY under a domain (no table between —
    ragged hierarchy) has no table-level ancestor. The canvas at table
    granularity shows (table_a → domain_def); a pure same-level diagonal
    would silently drop that cell. Canonical level-bridging materializes
    the deepest at-or-above representative per level instead."""
    fake = _FakeFalkor()
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_node(1, "urn:domain_abc", "domain")
    fake.add_node(2, "urn:table_a", "table")
    fake.add_node(3, "urn:col_a", "column")
    fake.add_node(11, "urn:domain_def", "domain")
    fake.add_node(13, "urn:col_b", "column")
    fake.add_edge("CONTAINS", 0, 1, 2)    # domain_abc > table_a
    fake.add_edge("CONTAINS", 1, 2, 3)    # table_a > col_a
    fake.add_edge("CONTAINS", 3, 11, 13)  # domain_def > col_b  (ragged!)
    fake.add_edge("FLOWS", 10, 3, 13)
    fake.add_edge("FLOWS", 11, 3, 13)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    # L=1 (table): source rep table_a, target rep = deepest ≤ 1 = the
    # domain itself → (2, 11). L=0: (1, 11). Both weight 2, once each.
    assert set(fake.agg.keys()) == {(2, 11), (1, 11)}
    assert fake.agg[(2, 11)]["weight"] == 2
    assert fake.agg[(1, 11)]["weight"] == 2


def test_run_stats_reports_boundary_effect():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    # An orphan lineage edge between two uncontained leaf nodes has no
    # non-leaf representative — nothing to materialize; the raw read
    # path still serves it on demand. Counted in fine_merges_skipped.
    fake.add_node(21, "urn:orphan_a", "column")
    fake.add_node(22, "urn:orphan_b", "column")
    fake.add_edge("FLOWS", 20, 21, 22)
    p = _make_provider(fake, levels)
    result = _run(_materialize(p))
    stats = result["run_stats"]
    assert stats["fine_merges_skipped"] == 1
    assert stats["pairs"] == len(_EXPECTED_PAIRS)


def test_apply_resume_never_skips_pairs_sorting_before_the_cursor():
    """F5 audit finding: the apply-phase ``after_key`` fast-forward could
    skip pairs that are NEW since the crashed attempt but sort before the
    persisted cursor position — RECONCILE re-runs fully on apply-resume
    and already filters what exists, so the bisect was a redundant
    optimization with a correctness hole. Resuming mid-apply with a
    cursor PAST every computed key must still create every missing pair.
    """
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    past_everything = mat._pack(2, 12)      # the largest computed pair key
    cursor = mat.make_cursor(int(time.time() * 1000), mat.PHASE_APPLY, past_everything)

    result = _run(_materialize(p, last_cursor=cursor))

    assert result["errors"] == 0
    assert set(fake.agg.keys()) == _EXPECTED_PAIRS
    for key, edge in fake.agg.items():
        assert edge["weight"] == 2, key


def test_await_agg_index_ready_polls_until_operational():
    """F6 audit finding: FalkorDB builds indexes in the background, and
    nothing waited for AGGREGATED(aggKey) readiness — on a first run
    against a large existing set, every keyed delete ran as a full
    relation scan until the index finished. The wait is bounded and
    NEVER fails the run (readiness is an optimization, not a gate)."""
    fake = _FakeFalkor()
    p = _make_provider(fake, _seed_two_chain_graph(fake))
    probes = {"n": 0}

    async def proj_ro(cypher, params=None, **kw):
        assert "db.indexes" in cypher
        probes["n"] += 1
        status = "UNDER CONSTRUCTION" if probes["n"] < 3 else "OPERATIONAL"
        return _Result([["AGGREGATED", ["aggKey"], {"aggKey": status}]])

    p._proj_ro_query = proj_ro
    pipeline = mat.AggregationPipeline(
        provider=p, containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"], last_cursor=None,
        progress_callback=None, intra_batch_callback=None, should_cancel=None,
    )
    _run(pipeline._await_agg_index_ready(budget_s=10, interval_s=0))
    assert probes["n"] == 3


def test_await_agg_index_ready_budget_exhaustion_proceeds():
    fake = _FakeFalkor()
    p = _make_provider(fake, _seed_two_chain_graph(fake))

    async def proj_ro(cypher, params=None, **kw):
        return _Result([["AGGREGATED", ["aggKey"], "UNDER CONSTRUCTION"]])

    p._proj_ro_query = proj_ro
    pipeline = mat.AggregationPipeline(
        provider=p, containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"], last_cursor=None,
        progress_callback=None, intra_batch_callback=None, should_cancel=None,
    )
    _run(pipeline._await_agg_index_ready(budget_s=0, interval_s=0))  # returns, never raises


def test_reconcile_probes_index_readiness():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)
    probes = {"n": 0}
    orig = fake.ro_query

    async def proj_ro(cypher, params=None, **kw):
        if "db.indexes" in cypher:
            probes["n"] += 1
            return _Result([["AGGREGATED", ["aggKey"], "OPERATIONAL"]])
        return await orig(cypher, params, **kw)

    p._proj_ro_query = proj_ro
    result = _run(_materialize(p))
    assert result["errors"] == 0
    assert probes["n"] >= 1, "reconcile must check aggKey index readiness"
