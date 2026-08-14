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
        self.meta = None       # last _AggMeta stamp params

    # -- seeding helpers --

    def add_node(self, nid, urn, label):
        self.nodes[nid] = (urn, label)
        self._urn_ids[urn] = nid

    def add_edge(self, etype, rid, sid, tid):
        self.typed_edges.setdefault(etype, []).append((rid, sid, tid))

    def seed_aggregated(
        self, aid, bid, *, weight, digest="", latest=1000,
        types=("FLOWS",), sl=None, tl=None, sd=None, td=None, agg_key=...,
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
            "sd": sd,
            "td": td,
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
        if "RETURN 1 LIMIT 1" in cypher and "aggKey IS NULL" not in cypher:
            return _Result([[1]] if self.agg else [])
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
                        v.get("tl"), v.get("sd"), v.get("td"),
                    ])
            return _Result(rows)
        raise AssertionError(f"unhandled agg read: {cypher}")

    async def proj_query(self, cypher, params=None, **kw):
        params = params or {}
        if "CREATE INDEX" in cypher:
            return _Result()
        if "MERGE (m:_AggMeta" in cypher:
            # Run metadata — stamped at the end of EVERY run (not a data
            # write; the noop contract counts data writes only).
            self.meta = dict(params)
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
                edge["sd"] = item["sd"]
                edge["td"] = item["td"]
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


async def _materialize(p, *, last_cursor=None, progress=None, should_cancel=None,
                       tuning=None):
    # The suite pins the BOUNDARY (depth-diagonal) mechanics — the mode
    # every graph too big for the full cube runs in. Auto/cube behavior
    # has its own dedicated tests below.
    merged = {"materialize_fine_pairs": False}
    merged.update(tuning or {})
    return await mat.materialize_aggregated_edges(
        p,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        last_cursor=last_cursor,
        progress_callback=progress,
        intra_batch_callback=None,
        should_cancel=should_cancel,
        tuning=merged,
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


# ── node-identity resolution (URN-equivalent) ────────────────────────────

def test_node_identity_expr_default_is_plain_urn(monkeypatch):
    """Default (None / "urn") keeps the historical hardcoded n.urn — no
    coalesce, so conforming graphs are byte-for-byte unchanged."""
    monkeypatch.delenv("AGGREGATION_NODE_IDENTITY_PROPERTY", raising=False)
    assert mat._node_identity_expr(None) == "n.`urn`"
    assert mat._node_identity_expr("urn") == "n.`urn`"


def test_node_identity_expr_maps_configured_property():
    """A configured URN-equivalent falls back to it only when urn is absent."""
    assert mat._node_identity_expr("id") == "coalesce(n.`urn`, n.`id`)"
    assert mat._node_identity_expr("name") == "coalesce(n.`urn`, n.`name`)"


def test_node_identity_expr_strips_backticks_to_prevent_injection():
    """A hostile property name can't break out of the backtick-quoted ident."""
    assert mat._node_identity_expr("id`") == "coalesce(n.`urn`, n.`id`)"


def test_node_identity_expr_ignores_global_env_var(monkeypatch):
    """The old AGGREGATION_NODE_IDENTITY_PROPERTY global was a footgun (it would
    silently affect every source) and has been removed — identity is per-source
    only. Setting the env var must have NO effect; None resolves to plain urn."""
    monkeypatch.setenv("AGGREGATION_NODE_IDENTITY_PROPERTY", "id")
    assert mat._node_identity_expr(None) == "n.`urn`"


# ── identity-urn stamp (P0: make id-keyed graphs work end-to-end) ────────────

def test_stamp_identity_urns_sets_urn_from_identity_property():
    """An in-source id-keyed graph must get `urn` stamped from `id` so the
    urn-keyed AGGREGATED write/read stack attaches edges to the real nodes."""
    p = _make_provider(_FakeFalkor())
    p._node_identity_property = "id"
    p._projection_mode = "in_source"
    calls = []

    async def _noop_connect():
        return None

    async def _ro(cypher, params=None, **kw):
        return _Result([[100]]) if "max(ID(n))" in cypher else _Result([])

    async def _wq(cypher, params=None, **kw):
        calls.append(cypher)
        r = _Result()
        r.properties_set = 3
        return r

    p._ensure_connected = _noop_connect
    p._ro_query = _ro
    p._query = _wq

    stamped = _run(p.stamp_identity_urns())
    assert stamped >= 3
    assert any(
        "coalesce(n.`urn`, n.`id`)" in c and "n.`urn` IS NULL" in c and "n.`id` IS NOT NULL" in c
        for c in calls
    ), "stamp must fill urn from id only for nodes missing urn (coalesce, never overwrite)"


def test_stamp_identity_urns_noop_for_default_and_dedicated():
    """No write for a conforming (urn) source, nor for a dedicated projection
    (which is self-consistent and must not mutate a possibly read-only source)."""
    p = _make_provider(_FakeFalkor())

    async def _boom(*a, **k):
        raise AssertionError("stamp must not issue any query in the no-op cases")
    p._ensure_connected = _boom
    p._ro_query = _boom
    p._query = _boom

    p._node_identity_property = "urn"
    p._projection_mode = "in_source"
    assert _run(p.stamp_identity_urns()) == 0

    p._node_identity_property = "id"
    p._projection_mode = "dedicated"
    assert _run(p.stamp_identity_urns()) == 0


def test_stamp_display_name_from_custom_name_property():
    """A custom name_property (identity conforming) still triggers a standalone
    displayName stamp, so a non-`displayName` node name renders across the whole
    read stack — not just the node-detail serializer's fallback."""
    p = _make_provider(_FakeFalkor())
    p._node_identity_property = "urn"       # identity conforming → no urn stamp
    p._name_property = "title"              # custom name property
    p._projection_mode = "in_source"
    calls = []

    async def _noop():
        return None

    async def _ro(cypher, params=None, **kw):
        return _Result([[10]]) if "max(ID(n))" in cypher else _Result([])

    async def _wq(cypher, params=None, **kw):
        calls.append(cypher)
        r = _Result()
        r.properties_set = 2
        return r

    p._ensure_connected = _noop
    p._ro_query = _ro
    p._query = _wq

    stamped = _run(p.stamp_identity_urns())
    assert stamped >= 2
    assert any("coalesce(n.`displayName`, n.`title`)" in c for c in calls)
    assert all("n.`urn`" not in c for c in calls), "identity conforming → no urn stamp"


# ── end-to-end: an id-keyed graph aggregates once urn is stamped ─────────────

class _IdKeyedFake(_FakeFalkor):
    """A graph whose nodes carry an `id` property and NO `urn`, until
    stamp_identity_urns copies id→urn — the onboarded-third-party-graph case."""

    def __init__(self):
        super().__init__()
        self.ids = {}

    def add_id_node(self, nid, id_value, label):
        self.nodes[nid] = (None, label)   # urn absent until stamped
        self.ids[nid] = id_value

    async def write_query(self, cypher, params=None, **kw):
        # The conformance stamp fills urn (from id) for NULL-urn nodes in an ID
        # range. These fake nodes carry no `name`, so the displayName clause of
        # the combined SET is a no-op here.
        if "SET" in cypher and "n.`urn`" in cypher:
            lo, hi = params["lo"], params["hi"]
            n = 0
            for nid, (urn, label) in list(self.nodes.items()):
                if lo <= nid < hi and urn is None and self.ids.get(nid) is not None:
                    idv = self.ids[nid]
                    self.nodes[nid] = (idv, label)      # now carries urn == id
                    self._urn_ids[idv] = nid
                    n += 1
            r = _Result()
            r.properties_set = n
            return r
        raise AssertionError(f"unhandled write query: {cypher}")


def _seed_id_keyed_two_chain(fake):
    """Domain⊃Table⊃Column, two chains, lineage col_a→col_b (×2) — but nodes are
    keyed by `id` with no `urn` (mirrors _seed_two_chain_graph)."""
    levels = {"domain": 0, "table": 1, "column": 2}
    fake.add_id_node(1, "id:domain_abc", "domain")
    fake.add_id_node(2, "id:table_a", "table")
    fake.add_id_node(3, "id:col_a", "column")
    fake.add_id_node(11, "id:domain_def", "domain")
    fake.add_id_node(12, "id:table_b", "table")
    fake.add_id_node(13, "id:col_b", "column")
    fake.add_edge("CONTAINS", 0, 1, 2)
    fake.add_edge("CONTAINS", 1, 2, 3)
    fake.add_edge("CONTAINS", 2, 11, 12)
    fake.add_edge("CONTAINS", 3, 12, 13)
    fake.add_edge("FLOWS", 10, 3, 13)
    fake.add_edge("FLOWS", 11, 3, 13)
    return levels


def test_id_keyed_graph_aggregates_end_to_end_after_urn_stamp():
    """The whole point of the identity feature: a graph keyed by `id` (no `urn`)
    must aggregate into AGGREGATED edges once stamp_identity_urns runs."""
    fake = _IdKeyedFake()
    levels = _seed_id_keyed_two_chain(fake)
    p = _make_provider(fake, levels)
    p._node_identity_property = "id"
    p._projection_mode = "in_source"

    async def _noop():
        return None
    p._ensure_connected = _noop
    p._query = fake.write_query

    stamped = _run(p.stamp_identity_urns())
    assert stamped == 6, "every id-keyed node must be stamped with a urn"

    result = _run(_materialize(p))
    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(2, 12): 2, (1, 11): 2}, (
        "an id-keyed graph must roll up like any urn-keyed one once stamped"
    )
    # Edges are keyed by the id VALUES (the stamped urn), not a synthetic urn.
    key = fake.agg[(1, 11)]["aggKey"]
    assert "id:domain_abc" in key and "id:domain_def" in key


def test_id_keyed_graph_without_stamp_writes_nothing():
    """Proves the stamp is load-bearing: with no urn, the directory is empty and
    zero AGGREGATED edges are written (the silent failure the stamp fixes)."""
    fake = _IdKeyedFake()
    levels = _seed_id_keyed_two_chain(fake)
    p = _make_provider(fake, levels)
    result = _run(_materialize(p))       # no stamp
    assert result["errors"] == 0
    assert fake.agg == {}


# ── conformance advisories (Phase IV — loud, never silent) ───────────────

def _make_pipeline():
    p = _make_provider(_FakeFalkor(), {"domain": 0})
    return mat.AggregationPipeline(
        p,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        last_cursor=None,
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
    )


def test_advisory_identity_unresolved_is_error_severity():
    pipe = _make_pipeline()
    pipe._empty_directory = True
    advs = pipe._result(0)["run_stats"]["advisories"]
    hit = next(a for a in advs if a["kind"] == "identity_unresolved")
    assert hit["severity"] == "error"
    assert hit["identity_property"] == "urn"
    assert "Node Identity Property" in hit["message"]


def test_advisory_identity_unresolved_reports_configured_property():
    """When the run DID apply a custom identity property (e.g. `id`) but still
    resolved nothing, the advisory must report THAT property — the hardcoded
    'none carry urn / set the property' text hid whether the setting took
    effect, which is exactly the "I set id but it says missing" confusion."""
    pipe = _make_pipeline()
    pipe.p._node_identity_property = "id"
    pipe._empty_directory = True
    hit = next(
        a for a in pipe._result(0)["run_stats"]["advisories"]
        if a["kind"] == "identity_unresolved"
    )
    assert hit["identity_property"] == "id"
    assert "coalesce(urn, id)" in hit["message"]
    assert "case-sensitive" in hit["message"]


def test_advisory_identity_unresolved_names_resolvable_property():
    """The decisive "I set id but it says missing" case: the run keyed on `urn`,
    but the probe found nodes DO carry `id` — the advisory must name it and say
    the setting didn't reach this run, not repeat 'set the property'."""
    pipe = _make_pipeline()
    pipe._empty_directory = True
    pipe._identity_candidates = {"id": 4200, "name": 4200, "urn": 0}
    hit = next(
        a for a in pipe._result(0)["run_stats"]["advisories"]
        if a["kind"] == "identity_unresolved"
    )
    assert hit["identity_property"] == "urn"
    assert "id" in hit["resolvable_properties"]
    assert "`id` (4200)" in hit["message"]
    assert "did not reach this run" in hit["message"]


def test_advisory_dropped_endpoints_reports_count():
    pipe = _make_pipeline()
    pipe._dropped_endpoints = 5
    advs = pipe._result(3)["run_stats"]["advisories"]
    hit = next(a for a in advs if a["kind"] == "endpoints_unresolved")
    assert hit["dropped_pairs"] == 5


def test_advisory_empty_directory_supersedes_dropped_count():
    """An empty directory already means every pair was dropped — surface the
    single actionable identity advisory, not a redundant drop count."""
    pipe = _make_pipeline()
    pipe._empty_directory = True
    pipe._dropped_endpoints = 999
    kinds = {a["kind"] for a in pipe._result(0)["run_stats"]["advisories"]}
    assert "identity_unresolved" in kinds
    assert "endpoints_unresolved" not in kinds


def test_advisory_unmatched_edge_types_lists_them():
    pipe = _make_pipeline()
    pipe._unmatched_types = ["TRANSFORMS", "MOVES"]
    advs = pipe._result(0)["run_stats"]["advisories"]
    hit = next(a for a in advs if a["kind"] == "edge_types_unmatched")
    assert "TRANSFORMS" in hit["message"]
    assert hit["types"] == ["TRANSFORMS", "MOVES"]


def test_advisory_empty_containment_when_declared_but_no_dag():
    """Declared containment that matched ZERO edges (maxDepth 0) must surface a
    loud advisory instead of silently producing a flat leaf-only cube — the
    'no aggregated edges roll up' failure on a case-drifted / unclassified
    containment type. _struct_parents is the computed DAG (empty set here)."""
    pipe = _make_pipeline()
    pipe._containment = ["HAS", "Has"]   # resolved physical spellings this run
    pipe._struct_parents = set()          # DAG computed, but empty
    advs = pipe._result(0)["run_stats"]["advisories"]
    hit = next(a for a in advs if a["kind"] == "containment_empty")
    assert hit["severity"] == "warning"
    assert "HAS" in hit["message"]
    assert hit["types"] == ["HAS", "Has"]


def test_no_containment_empty_advisory_when_dag_present():
    """A real containment DAG must NOT trip the empty-containment advisory."""
    pipe = _make_pipeline()
    pipe._containment = ["HAS"]
    pipe._struct_parents = {1, 2}         # non-empty DAG
    stats = pipe._result(5)["run_stats"]
    kinds = {a["kind"] for a in stats.get("advisories", [])}
    assert "containment_empty" not in kinds


def test_pick_autoheal_identity_prefers_unique_key_over_name():
    """The self-heal must adopt a likely-UNIQUE key populated on ~all nodes and
    never `name` (non-unique → stamping urn from it would merge nodes)."""
    pipe = _make_pipeline()
    pipe._identity_sample_total = 1000
    # name is fully populated but must be ignored; id qualifies (>=90%).
    pipe._identity_candidates = {"name": 1000, "id": 980, "key": 10}
    assert pipe._pick_autoheal_identity() == "id"
    # A sparse id (below 90%) disqualifies → no auto-heal.
    pipe._identity_candidates = {"name": 1000, "id": 100}
    assert pipe._pick_autoheal_identity() is None
    # No sample → never heal.
    pipe._identity_sample_total = 0
    assert pipe._pick_autoheal_identity() is None


def test_advisory_identity_autohealed_prompts_permanent_fix():
    """After the self-heal adopts a property, a warning advisory must tell the
    operator to set it permanently (so the recovery doesn't run every time)."""
    pipe = _make_pipeline()
    pipe._autohealed_identity = "id"
    hit = next(
        a for a in pipe._result(7)["run_stats"]["advisories"]
        if a["kind"] == "identity_autohealed"
    )
    assert hit["severity"] == "warning"
    assert hit["identity_property"] == "id"
    assert "make it permanent" in hit["message"]


def test_clean_run_emits_no_advisories_key():
    """A conforming run's run_stats must be unchanged — no advisories noise."""
    pipe = _make_pipeline()
    assert "advisories" not in pipe._result(10)["run_stats"]


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

    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))

    assert set(fake.agg.keys()) == _EXPECTED_FINE_PAIRS
    for key in _EXPECTED_FINE_PAIRS:
        assert fake.agg[key]["weight"] == 2, key


def test_leaf_pairs_env_flag_restores_mirrors(monkeypatch):
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "true")
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))

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

    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))

    # (c1,c2) leaf mirror dropped; (t,t) equal pair dropped; the mixed
    # pairs (c1→t) and (t→c2) remain.
    assert set(fake.agg.keys()) == {(2, 1), (1, 3)}


def test_multi_parent_fans_out_to_every_ancestry(monkeypatch):
    """A node with two parents links BOTH ancestries — the previous
    longest-chain collapse silently dropped every rollup through the
    shorter parent (a column in a table sitting in two containers must
    aggregate into both)."""
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

    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))

    # Every ancestor of leaf pairs with the target — through mid AND
    # through shallow — each with the raw edge's weight exactly once.
    assert fake.agg[(2, 5)]["weight"] == 1
    assert fake.agg[(1, 5)]["weight"] == 1
    assert fake.agg[(3, 5)]["weight"] == 1
    # Depth stamps are structural: deep_root/shallow are roots (0), mid
    # is depth 1; the uncontained target leaf is depth 0. (The raw
    # leaf↔leaf mirror (4, 5) stays excluded by default.)
    assert fake.agg[(1, 5)]["sd"] == 0 and fake.agg[(1, 5)]["td"] == 0
    assert fake.agg[(2, 5)]["sd"] == 1 and fake.agg[(2, 5)]["td"] == 0
    assert (4, 5) not in fake.agg


def test_diamond_containment_counts_shared_grandparent_once(monkeypatch):
    """leaf under X and Y, both under G: G's rollup must receive the raw
    edge's weight ONCE (set-semantics closure), not once per path."""
    monkeypatch.setenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true")
    fake = _FakeFalkor()
    levels = {"root": 0, "mid": 1, "leaf": 2}
    fake.add_node(1, "urn:G", "root")
    fake.add_node(2, "urn:X", "mid")
    fake.add_node(3, "urn:Y", "mid")
    fake.add_node(4, "urn:leaf", "leaf")
    fake.add_node(5, "urn:other", "leaf")
    fake.add_edge("CONTAINS", 0, 1, 2)   # G > X
    fake.add_edge("CONTAINS", 1, 1, 3)   # G > Y
    fake.add_edge("CONTAINS", 2, 2, 4)   # X > leaf
    fake.add_edge("CONTAINS", 3, 3, 4)   # Y > leaf
    fake.add_edge("FLOWS", 10, 4, 5)
    p = _make_provider(fake, levels)

    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))

    assert fake.agg[(1, 5)]["weight"] == 1  # G once, not twice
    assert fake.agg[(2, 5)]["weight"] == 1
    assert fake.agg[(3, 5)]["weight"] == 1


def test_multi_parent_boundary_mode_links_both_ancestries():
    """The depth-diagonal (boundary) rule fans out too: a leaf under two
    containers at the same depth pairs BOTH with the target's rep."""
    fake = _FakeFalkor()
    levels = {"root": 0, "leaf": 1}
    fake.add_node(1, "urn:src_a", "root")
    fake.add_node(2, "urn:src_b", "root")
    fake.add_node(3, "urn:leaf_s", "leaf")
    fake.add_node(11, "urn:tgt", "root")
    fake.add_node(13, "urn:leaf_t", "leaf")
    fake.add_edge("CONTAINS", 0, 1, 3)   # src_a > leaf_s
    fake.add_edge("CONTAINS", 1, 2, 3)   # src_b > leaf_s (second parent)
    fake.add_edge("CONTAINS", 2, 11, 13)
    fake.add_edge("FLOWS", 10, 3, 13)
    p = _make_provider(fake, levels)

    _run(_materialize(p))

    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(1, 11): 1, (2, 11): 1}, agg


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


def test_zero_matched_containment_fails_loud_instead_of_wiping():
    """Declared containment types matching ZERO edges in a graph that
    already holds :AGGREGATED cells must fail the run — the legacy
    full-cube fallback would recompute a leaf-only result and reconcile
    would delete every stored container cell as stale. Terminal
    (MaterializationPreconditionFailed): deterministic, so the worker
    must not burn its retry budget re-running EXTRACT. (The structural
    boundary made the old label-match guard obsolete: labels that don't
    match the ontology now aggregate fine — see the structural tests —
    but containment EDGE types matching nothing is still a wipe hazard.)
    """
    fake = _FakeFalkor()
    levels = {"domain": 0, "column": 1}
    fake.add_node(3, "urn:col_a", "weird_label")
    fake.add_node(13, "urn:col_b", "weird_label")
    fake.add_edge("FLOWS", 10, 3, 13)
    fake.seed_aggregated(3, 13, weight=7, latest=1000)
    p = _make_provider(fake, levels)

    with pytest.raises(
        mat.MaterializationPreconditionFailed, match="containment edge types"
    ):
        _run(_materialize(p))
    # The pre-existing edge survives untouched.
    assert fake.agg[(3, 13)]["weight"] == 7
    assert fake.deleted_pairs == []


def test_single_level_ontology_run_succeeds_not_fails():
    """Single-level ontologies work STRUCTURALLY now. A flat graph (no
    containment at all) succeeds as a no-op — exact leaf pairs are
    served on demand by the read path; a
    SELF-NESTING single-label graph (Folder⊃Folder) materializes the
    canonical container diagonal; the leaf-involving combinations the
    old cube stored (c→b, a→d) are on-demand reads — same answers."""
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
    _run(_materialize(p2, tuning={"materialize_fine_pairs": "auto"}))
    # Tiny graph → auto picks the FULL CUBE: the original cross-product
    # cells (c→b, a→d, a→b) are physically stored again.
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


def test_reconcile_heals_null_depth_stamps_without_deletes():
    """Stamp upgrade: a pre-depth generation (correct weights/types/
    digest/levels, NULL sourceDepth/targetDepth) is re-stamped in place
    by the overwrite path — zero deletes, zero weight churn."""
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    for pair, (sl, tl) in {(1, 11): (0, 0), (2, 12): (1, 1)}.items():
        fake.seed_aggregated(
            pair[0], pair[1], weight=2, digest="digest-1", latest=1000,
            types=("FLOWS",), sl=sl, tl=tl, sd=None, td=None,
        )
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert result["deletes"] == 0
    assert fake.deleted_pairs == []
    assert fake.agg[(1, 11)]["sd"] == 0 and fake.agg[(1, 11)]["td"] == 0
    assert fake.agg[(2, 12)]["sd"] == 1 and fake.agg[(2, 12)]["td"] == 1
    assert fake.agg[(1, 11)]["weight"] == 2
    assert fake.agg[(2, 12)]["weight"] == 2


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
    _run(_materialize(p, tuning={"materialize_fine_pairs": True}))
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
        _run(_materialize(p, tuning={"materialize_fine_pairs": True}))
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
    # And the diagnostics report the same picture (depth buckets — the
    # dimension pair selection actually runs on).
    assert result["run_stats"]["pairs_by_level"]["d0->d0"] == 4
    assert result["run_stats"]["pairs_by_level"]["d1->d1"] == 4


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


def _seed_self_nesting_graph(fake, depth=3):
    """Roots ⊃ Node ⊃ … ⊃ Node (self-nesting type), two chains, lineage
    between the deepest leaves (×2 parallel). Ontology has only TWO type
    levels (Roots=0, Node=1) — the structure is deeper than the types.

    Chain ids: a-side 1..depth, b-side 11..10+depth.
    """
    levels = {"Roots": 0, "Node": 1}
    for base, prefix in ((0, "a"), (10, "b")):
        fake.add_node(base + 1, f"urn:{prefix}1", "Roots")
        for d in range(2, depth + 1):
            fake.add_node(base + d, f"urn:{prefix}{d}", "Node")
            fake.add_edge("CONTAINS", 100 + base + d, base + d - 1, base + d)
    leaf_a, leaf_b = depth, 10 + depth
    fake.add_edge("FLOWS", 300, leaf_a, leaf_b)
    fake.add_edge("FLOWS", 301, leaf_a, leaf_b)
    return levels


def test_self_nesting_containers_materialize_every_depth():
    """CRITICAL regression (2026-07-11, live): a type that nests under
    itself (Node ⊃ Node — folders, systems, layered-lineage Nodes) made
    every intermediate container a 'leaf' under the TYPE-level boundary,
    so only the root diagonal materialized (observed: 9 Roots→Roots
    cells on a graph with 246 Node→Node containments) and Context View
    showed no aggregated lineage below the roots. The boundary is
    STRUCTURAL: any containment parent is non-leaf, ranked by depth."""
    fake = _FakeFalkor()
    levels = _seed_self_nesting_graph(fake, depth=3)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {
        (2, 12): 2,      # Node-container diagonal (depth 1) — was missing
        (1, 11): 2,      # Roots diagonal (depth 0)
    }, agg
    # Stamps keep TYPE-level semantics for the read path's filters.
    assert fake.agg[(1, 11)]["sl"] == 0 and fake.agg[(1, 11)]["tl"] == 0
    assert fake.agg[(2, 12)]["sl"] == 1 and fake.agg[(2, 12)]["tl"] == 1


def test_self_nesting_four_deep_materializes_three_container_ranks():
    fake = _FakeFalkor()
    levels = _seed_self_nesting_graph(fake, depth=4)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {(3, 13): 2, (2, 12): 2, (1, 11): 2}, agg



# ── auto mode: full cube within budget, boundary above it ───────────────


def test_auto_mode_materializes_full_cube_within_budget():
    """The old implementation's semantics, restored with the new
    protections: on a graph whose full ancestor cross-product fits the
    write budget, EVERY combination is physically stored — leaf→container
    included — so the canvas answers at every granularity from storage
    alone (the live incident: root→root rendered, expansion showed
    nothing because mixed-granularity pairs were derive-on-read and the
    reader thinks in type levels)."""
    fake = _FakeFalkor()
    levels = _seed_self_nesting_graph(fake, depth=3)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p, tuning={"materialize_fine_pairs": "auto"}))

    assert result["errors"] == 0
    agg = {k: v["weight"] for k, v in fake.agg.items()}
    assert agg == {
        (3, 12): 2, (3, 11): 2,          # leaf → container / root
        (2, 13): 2, (2, 12): 2, (2, 11): 2,
        (1, 13): 2, (1, 12): 2, (1, 11): 2,
    }, agg
    # Run metadata stamped IN the graph: readers dispatch on the cube
    # contract deterministically instead of probing (a probed cube
    # misclassifies as 'boundary' and double-derives mixed weights).
    assert fake.meta is not None
    assert fake.meta["regime"] == "cube"
    # The storage decision is DURABLE in run_stats — an over-budget
    # fallback must never be a silent log line.
    assert result["run_stats"]["regime"] == "cube"
    assert result["run_stats"]["cube_estimate"] >= len(agg)
    # The DEFAULT budget (no tuning override here) — sized per shard.
    assert result["run_stats"]["materialize_budget"] == 25_000_000
    assert fake.meta["edgeCount"] == len(agg)
    assert fake.meta["maxDepth"] == 2
    # Depth stamps on every row, structural on the self-nesting shape.
    assert fake.agg[(3, 11)]["sd"] == 2 and fake.agg[(3, 11)]["td"] == 0
    assert fake.agg[(1, 12)]["sd"] == 0 and fake.agg[(1, 12)]["td"] == 1


def test_boundary_run_stamps_boundary_regime_meta():
    fake = _FakeFalkor()
    levels = _seed_two_chain_graph(fake)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p))  # suite default: forced boundary mode

    assert fake.meta is not None
    assert fake.meta["regime"] == "boundary"
    assert fake.meta["digest"] == "digest-1"
    assert result["run_stats"]["regime"] == "boundary"
    # Forced mode skips the counting scan — no estimate to report.
    assert "cube_estimate" not in result["run_stats"]


def test_auto_mode_falls_back_to_boundary_above_budget():
    fake = _FakeFalkor()
    levels = _seed_self_nesting_graph(fake, depth=3)
    p = _make_provider(fake, levels)

    result = _run(_materialize(p, tuning={
        "materialize_fine_pairs": "auto",
        # Cube estimate for this graph is 2 edges × 3 × 3 = 18 cells.
        "max_materialized_edges": 10_000,
    }))
    assert result["errors"] == 0
    # Default budget → cube (above). Now shrink the budget below the
    # estimate: auto must fall back to the depth-diagonal, not fail.
    fake2 = _FakeFalkor()
    levels2 = _seed_self_nesting_graph(fake2, depth=3)
    p2 = _make_provider(fake2, levels2)
    import backend.app.providers.falkordb_materialize as m
    orig = m._max_materialized_edges
    m._max_materialized_edges = lambda: 10_000
    try:
        result2 = _run(mat.materialize_aggregated_edges(
            p2,
            containment_edge_types=["CONTAINS"],
            lineage_edge_types=["FLOWS"],
            last_cursor=None, progress_callback=None,
            intra_batch_callback=None, should_cancel=None,
            tuning={"materialize_fine_pairs": "auto",
                    "max_materialized_edges": 10_000},
        ))
    finally:
        m._max_materialized_edges = orig
    assert result2["errors"] == 0


def test_auto_mode_cube_ceiling_is_independent_of_write_budget():
    """The auto cube/boundary decision keys off AGGREGATION_MAX_CUBE_EDGES,
    NOT the write budget.

    These were one constant. The write budget is a runaway backstop sized
    far above any real result, so sharing it meant raising the backstop
    silently flipped auto into full-cube for nearly every graph — turning
    "Auto" into "Always full detail", the mode that OOMs multi-million-edge
    instances. A huge write budget must still leave the cube decision alone.
    """
    import backend.app.providers.falkordb_materialize as m

    fake = _FakeFalkor()
    levels = _seed_self_nesting_graph(fake, depth=3)
    p = _make_provider(fake, levels)

    # Cube estimate for this graph is 18 cells. A 50M write budget clears
    # it by six orders of magnitude, but the cube ceiling sits below it.
    orig = m._max_cube_edges
    m._max_cube_edges = lambda: 10
    try:
        result = _run(_materialize(p, tuning={
            "materialize_fine_pairs": "auto",
            "max_materialized_edges": 50_000_000,
        }))
    finally:
        m._max_cube_edges = orig

    assert result["errors"] == 0
    # Estimate (18) exceeds the ceiling (10) → boundary, despite the
    # write budget being effectively unlimited.
    assert result["run_stats"]["regime"] == "boundary"
    assert result["run_stats"]["materialize_budget"] == 50_000_000
    assert fake.meta is not None and fake.meta["regime"] == "boundary"

    # Same graph, same 50M write budget, ceiling back above the estimate
    # → cube. Only the ceiling moved.
    fake2 = _FakeFalkor()
    levels2 = _seed_self_nesting_graph(fake2, depth=3)
    p2 = _make_provider(fake2, levels2)
    result2 = _run(_materialize(p2, tuning={
        "materialize_fine_pairs": "auto",
        "max_materialized_edges": 50_000_000,
    }))
    assert result2["run_stats"]["regime"] == "cube"
