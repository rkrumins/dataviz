"""The uncapped search engine (``providers/falkordb_search``), without a graph.

What each unit of work reads, the order it ranks in, how a session carries a
search across requests, and what a request answers with — against fakes.
That the Cypher means what these assume is the live suite's job
(``tests/integration/test_search_engine_live.py``).
"""
from __future__ import annotations

import asyncio
import dataclasses
import re
import time
from types import SimpleNamespace

import fakeredis.aioredis
import pytest

from backend.app.providers.falkordb_search import engine as engine_mod
from backend.app.providers.falkordb_search import plan as plan_mod
from backend.app.providers.falkordb_search.keys import SortSpec, SortKey, build_sort_spec
from backend.app.providers.falkordb_search.plan import (
    Context,
    Plan,
    Unit,
    _range_units,
    after_statement,
    make_plan,
    page_statements,
    tally_statement,
)
from backend.app.providers.falkordb_search.relevance import score_expr
from backend.app.providers.falkordb_search.session import (
    MemorySessionStore,
    RedisSessionStore,
    Session,
)
from backend.app.services.deep_search import CompileError, SearchFailed, SearchRunContext
from backend.common.adapters.circuit import ProviderBusy
from backend.common.models.graph import GraphNode
from backend.common.models.search import SearchQuery


def _query(predicate=None, **options) -> SearchQuery:
    return SearchQuery.model_validate({
        "predicate": predicate or {"kind": "property", "key": "owner", "op": "eq", "value": "x"},
        "scope": {"viewId": "v", "scopeMode": "data_source"},
        "options": {"results": "hits", **options},
    })


# ---------------------------------------------------------------------------
# Sort keys
# ---------------------------------------------------------------------------

class TestSortKeys:
    def test_every_order_ends_on_the_urn_ascending(self):
        for options in ({"sort": "relevance"}, {"sort": "displayName", "sortDir": "desc"},
                        {"sort": "qualifiedName"}, {"sort": "depth"},
                        {"sortProperty": "rowCount", "sortDir": "desc"}):
            spec = build_sort_spec(_query(**options))
            assert spec.keys[-1] == SortKey("n.urn"), options

    def test_a_name_sort_follows_the_direction_and_ties_stay_ascending(self):
        spec = build_sort_spec(_query(sort="displayName", sortDir="desc"))
        assert [k.descending for k in spec.keys] == [True, False]
        assert spec.order_by() == "_k0 DESC, _k1"

    def test_relevance_without_text_is_the_name_then_the_urn(self):
        spec = build_sort_spec(_query(sort="relevance"), relevance=None)
        assert len(spec.keys) == 2 and not spec.keys[0].descending

    def test_relevance_leads_descending_and_carries_its_parameters(self):
        spec = build_sort_spec(_query(sort="relevance"), relevance=("score", {"_rel0": "x"}))
        assert spec.keys[0] == SortKey("score", descending=True)
        assert spec.params == {"_rel0": "x"}

    def test_a_property_sorts_by_kind_then_sign_then_value(self):
        spec = build_sort_spec(_query(sortProperty="gvHash", sortDir="asc"))
        kind, sign, number, text, urn = spec.keys
        assert "IN ['Integer', 'Float', 'Boolean']" in kind.expr
        # The sign comes before the value: FalkorDB's integer ordering wraps
        # at the int64 extremes, but never between two values of one sign.
        assert "< 0 THEN 0 ELSE 1" in sign.expr
        assert "THEN n.`gvHash`" in number.expr
        assert "toLower(" in text.expr and urn == SortKey("n.urn")

    def test_after_compares_a_later_key_only_where_the_earlier_are_equal(self):
        spec = SortSpec((SortKey("a", True), SortKey("b"), SortKey("n.urn")))
        cond, params = spec.after([3, "x", "u"])
        assert cond == ("(_k0 < $_a0 OR (_k0 = $_a0 AND (_k1 > $_a1 OR "
                        "(_k1 = $_a1 AND _k2 > $_a2))))")
        assert params == {"_a0": 3, "_a1": "x", "_a2": "u"}

    def test_python_orders_rows_as_the_keys_say(self):
        spec = SortSpec((SortKey("s", True), SortKey("name"), SortKey("n.urn")))
        rows = [[10.0, "b", "u3"], [60.0, "z", "u1"], [10.0, "a", "u9"], [10.0, "a", "u2"]]
        assert spec.merge(rows, limit=10) == [
            [60.0, "z", "u1"], [10.0, "a", "u2"], [10.0, "a", "u9"], [10.0, "b", "u3"]]

    def test_merge_keeps_the_first_rows_of_all_lists(self):
        spec = SortSpec((SortKey("n.urn"),))
        assert spec.merge([["a"], ["c"]], [["b"], ["d"]], limit=3) == [["a"], ["b"], ["c"]]

    def test_python_orders_strings_by_code_point_as_falkordb_does(self):
        spec = SortSpec((SortKey("n.urn"),))
        words = ["é", "Z", "a", "_", "日本", "ß", " x"]
        assert [r[0] for r in spec.merge([[w] for w in words], limit=10)] == sorted(words)


# ---------------------------------------------------------------------------
# Relevance
# ---------------------------------------------------------------------------

class TestRelevance:
    def test_nothing_textual_scores_nothing(self):
        assert score_expr(_query({"kind": "property", "key": "n", "op": "gt", "value": 1})) is None

    def test_a_text_leaf_scores_its_fields_with_their_weights(self):
        expr, params = score_expr(_query({"kind": "text", "value": "Orders", "target": "name"}))
        assert params == {"_rel0": "orders"}           # folded, bound once
        # displayName (1.0) and qualifiedName (0.5) at every tier.
        for value in ("100.0", "60.0", "40.0", "20.0", "50.0", "30.0", "10.0"):
            assert f"THEN {value}" in expr, value

    def test_a_case_sensitive_leaf_keeps_its_needle_and_its_text(self):
        expr, params = score_expr(_query({"kind": "text", "value": "Orders", "target": "name",
                                          "caseSensitive": True}))
        assert params == {"_rel0": "Orders"}
        assert "toLower(coalesce(" not in expr

    def test_an_any_leaf_caps_the_blob_fields_and_keeps_the_floor(self):
        expr, _ = score_expr(_query({"kind": "text", "value": "x", "target": "any"}))
        # description (0.4) and tags (0.6) are capped at the word tier.
        assert "THEN 16.0" in expr and "THEN 24.0" in expr
        assert "THEN 40.0" in expr                      # displayName, uncapped
        assert "ELSE 10.0 END" in expr                  # unattributed floor

    def test_a_property_leaf_scores_each_list_element(self):
        expr, params = score_expr(_query({"kind": "property", "key": "labels", "op": "contains",
                                          "value": "GOLD"}))
        assert params == {"_rel0": "gold"}
        assert "typeOf(n.`labels`) = 'List'" in expr

    def test_an_exact_leaf_every_match_satisfies_is_a_constant(self):
        # owner = x on its own: every match scores 50 — no key at all.
        assert score_expr(_query({"kind": "property", "key": "owner", "op": "in",
                                  "value": ["a", "b"]})) is None
        # Beside a leaf that varies, it is folded into the maximum.
        expr, params = score_expr(_query({"kind": "group", "op": "and", "children": [
            {"kind": "property", "key": "owner", "op": "eq", "value": "a"},
            {"kind": "text", "value": "orders", "target": "name"}]}))
        assert ", 50.0] | CASE WHEN" in expr
        assert list(params.values()) == ["orders"]

    def test_an_exact_leaf_that_not_every_match_satisfies_is_scored(self):
        expr, params = score_expr(_query({"kind": "group", "op": "or", "children": [
            {"kind": "property", "key": "owner", "op": "eq", "value": "a"},
            {"kind": "property", "key": "tier", "op": "eq", "value": "b"}]}))
        assert params == {"_rel0": "a", "_rel1": "b"}

    def test_every_variable_is_private_and_brackets_balance(self):
        expr, _ = score_expr(_query({"kind": "group", "op": "or", "children": [
            {"kind": "text", "value": "a", "target": "any"},
            {"kind": "property", "key": "k", "op": "startsWith", "value": "b"},
        ]}))
        for var in re.findall(r"(?:\[|ANY\(|reduce\()\s*(\w+)(?: = 0\.0,)? IN ", expr):
            assert var.startswith("_"), var
        stripped = re.sub(r"'[^']*'", "", expr)
        for open_, close in ("()", "[]"):
            assert stripped.count(open_) == stripped.count(close)
        # Unscoped comprehension variables must never repeat in one expression.
        declared = re.findall(r"(?:\[|ANY\()(_[a-z]+\d+) IN ", expr)
        assert len(declared) == len(set(declared))


# ---------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------

class TestRanges:
    def test_a_small_label_is_one_unbounded_unit(self):
        units = _range_units(["A"], {"A": (10, 5)}, width=100)
        assert units == [Unit("range", "A", None, None, exclude=(), size=10, span=10)]

    def test_a_large_label_is_cut_into_bands_open_at_both_ends(self):
        units = _range_units(["A"], {"A": (250, 1000)}, width=100)
        assert len(units) == 3
        assert units[0].lo is None and units[-1].hi is None
        assert units[0].hi == units[1].lo and units[1].hi == units[2].lo
        assert units[1].lo >= 1000

    def test_later_labels_skip_nodes_an_earlier_one_read(self):
        units = _range_units(["A", "B"], {"A": (5, 0), "B": (5, 10)}, width=100)
        assert units[1].exclude == ("A",)

    def test_an_empty_label_has_no_unit(self):
        assert _range_units(["A", "B"], {"A": (0, 0), "B": (3, 0)}, width=100)[0].label == "B"

    def test_a_unit_splits_into_halves_until_it_cannot(self):
        halves = Unit("range", "A", 0, 10, size=8).split()
        assert [(h.lo, h.hi, h.size) for h in halves] == [(0, 5, 4), (5, 10, 4)]
        assert Unit("range", "A", 3, 4).split() is None
        # An open-ended band is cut at its likely end and stays open above.
        tail = Unit("range", "A", 100, None, size=10, span=50).split()
        assert [(h.lo, h.hi, h.span) for h in tail] == [(100, 125, 0), (125, None, 25)]
        assert Unit("range", "A", 3, None).split() is None
        walk = Unit("walk", roots=[1, 2, 3], size=6).split()
        assert [w.roots for w in walk] == [[1], [2, 3]]
        assert Unit("walk", roots=[1]).split() is None


class _PlanDb:
    """Answers the planner's statements: label stats, URN lookups, walks."""

    def __init__(self, *, labels, counts, ids=None, walk=0, parents=None):
        self.labels, self.counts = labels, counts
        self.ids = ids or {}
        self.walk = walk
        self.parents = parents or {}
        self.statements = []

    async def run(self, cypher, params):
        self.statements.append(cypher)
        rows = []
        if cypher.startswith("CALL db.labels()"):
            rows = [[lbl] for lbl in self.labels]
        elif cypher.startswith("CALL db.meta.stats()"):
            rows = [[self.counts]]
        elif "RETURN ID(r) AS id" in cypher:
            rows = [[self.ids[u]] for u in params["_urns"] if u in self.ids]
        elif "WITH n LIMIT 1" in cypher:
            rows = [[lbl, 0] for lbl in self.labels]
        elif "LIMIT $_lim" in cypher:
            rows = [[min(self.walk, params["_lim"])]]
        elif "collect(ID(_a))" in cypher:
            rows = [[i, self.parents.get(i, [])] for i in params["_ids"]]
        return SimpleNamespace(result_set=rows)

    async def ro_query(self, cypher, params=None, timeout=None):
        return await self.run(cypher, params or {})


def _provider(db, *, containment=("CONTAINS",), levels=None):
    return SimpleNamespace(
        _ro_query=db.ro_query,
        _get_containment_edge_types=lambda: list(containment),
        _entity_type_levels=levels or {},
    )


def _compiled(query):
    from backend.app.providers.falkordb_deep_search import _Compiler
    compiler = _Compiler(lineage_edge_types=set(), containment_edge_types={"CONTAINS"})
    compiler.compile(query.predicate)
    return compiler


async def _plan(db, query, **kw):
    provider = kw.pop("provider", None) or _provider(db)
    return await make_plan(provider, query, _compiled(query), run=db.run,
                           width=kw.pop("width", 100), walk_max=kw.pop("walk_max", 1000),
                           timeout_s=1.0)


class TestPlanning:
    async def test_no_roots_reads_the_views_types_case_insensitively(self):
        db = _PlanDb(labels=["Dataset", "Column", "_GVRollupMeta"],
                     counts={"Dataset": 5, "Column": 50})
        q = SearchQuery.model_validate({
            "predicate": {"kind": "text", "value": "x"},
            "scope": {"viewId": "v", "scopeMode": "data_source", "entityTypes": ["dataset"]},
            "options": {"results": "hits"}})
        plan = await _plan(db, q)
        assert [u.label for u in plan.units] == ["Dataset"]

    async def test_no_types_falls_back_to_the_ontology_then_every_label(self):
        db = _PlanDb(labels=["A", "B"], counts={"A": 1, "B": 1})
        plan = await _plan(db, _query(), provider=_provider(db, levels={"b": 0}))
        assert [u.label for u in plan.units] == ["B"]
        plan = await _plan(db, _query())
        assert [u.label for u in plan.units] == ["A", "B"]

    async def test_visible_urns_are_looked_up_per_label(self):
        db = _PlanDb(labels=["A", "B"], counts={"A": 1, "B": 2})
        q = SearchQuery.model_validate({
            "predicate": {"kind": "text", "value": "x"},
            "scope": {"viewId": "v", "scopeMode": "visible", "visibleUrns": ["u1", "u2"]},
            "options": {"results": "hits"}})
        plan = await _plan(db, q)
        assert [(u.kind, u.label, u.exclude) for u in plan.units] == [
            ("visible", "A", ()), ("visible", "B", ("A",))]

    def _rooted(self, roots):
        return SearchQuery.model_validate({
            "predicate": {"kind": "text", "value": "x"},
            "scope": {"viewId": "v", "scopeMode": "view", "rootUrns": roots},
            "options": {"results": "hits"}})

    async def test_a_small_subtree_is_walked_from_its_roots_ids(self):
        db = _PlanDb(labels=["A"], counts={"A": 10_000}, ids={"r1": 7, "r2": 9}, walk=40)
        plan = await _plan(db, self._rooted(["r1", "r2"]))
        assert [(u.kind, u.roots, u.size) for u in plan.units] == [("walk", [7, 9], 40)]
        assert plan.clamps == []
        # Roots are found through the per-label urn index, never an
        # unlabelled ``root.urn IN`` scan.
        assert any("MATCH (r:`A`) WHERE r.urn IN $_urns" in s for s in db.statements)

    async def test_a_large_subtree_under_few_roots_is_clamped_ranges(self):
        db = _PlanDb(labels=["A"], counts={"A": 10_000}, ids={"r1": 7}, walk=10**9)
        plan = await _plan(db, self._rooted(["r1"]), walk_max=100)
        assert all(u.kind == "range" for u in plan.units)
        assert plan.clamps == [[7]]

    async def test_a_large_subtree_under_many_roots_is_walked_in_buckets(self):
        roots = [f"r{i}" for i in range(plan_mod.CLAMP_MAX_ROOTS + 10)]
        ids = {u: i for i, u in enumerate(roots)}
        # r1 sits inside r0: walking both would count its subtree twice.
        db = _PlanDb(labels=["A"], counts={"A": 10_000}, ids=ids, walk=10**9, parents={1: [0]})
        plan = await _plan(db, self._rooted(roots), walk_max=100)
        walked = [r for u in plan.units for r in u.roots]
        assert all(u.kind == "walk" for u in plan.units)
        assert 1 not in walked and sorted(walked) == [i for i in range(len(roots)) if i != 1]
        assert max(len(u.roots) for u in plan.units) <= plan_mod.WALK_BUCKET_ROOTS

    async def test_roots_that_do_not_exist_contain_nothing(self):
        db = _PlanDb(labels=["A"], counts={"A": 10})
        plan = await _plan(db, self._rooted(["gone"]))
        assert plan.units == [] and plan.notes

    async def test_without_containment_edges_the_roots_cannot_bound_it(self):
        db = _PlanDb(labels=["A"], counts={"A": 10}, ids={"r1": 1})
        plan = await _plan(db, self._rooted(["r1"]), provider=_provider(db, containment=()))
        assert [u.kind for u in plan.units] == ["range"] and plan.notes


class TestStatements:
    def _ctx(self, **kw):
        spec = SortSpec((SortKey("toLower(n.displayName)"), SortKey("n.urn")))
        return Context(where="n.x = $p0", params={"p0": 1}, sort=spec,
                       containment=("CONTAINS",), max_depth=12, **kw)

    def test_a_range_unit_counts_and_ranks_in_one_statement(self):
        unit = Unit("range", "A", 10, 20, exclude=("B",))
        [(cypher, params, yields)] = page_statements(unit, self._ctx(), [], 50)
        assert yields == "both"
        assert cypher.startswith("MATCH (n:`A`) WHERE ID(n) >= $_lo AND ID(n) < $_hi "
                                 "AND NOT (n:`B`) AND n.urn IS NOT NULL AND (n.x = $p0)")
        assert "ORDER BY _k0, _k1 WITH count(*) AS _c, collect([_k0, _k1]) AS _rows" in cypher
        assert params == {"p0": 1, "_lo": 10, "_hi": 20, "_k": 50}

    def test_a_clamp_checks_ancestors_after_the_predicate(self):
        [(cypher, params, _)] = page_statements(Unit("range", "A"), self._ctx(), [[3, 4]], 5)
        assert ("WHERE n.urn IS NOT NULL AND (n.x = $p0) WITH n MATCH "
                "(n)<-[:CONTAINS*0..12]-(_r0) WHERE ID(_r0) IN $_roots0 WITH DISTINCT n") in cypher
        assert params["_roots0"] == [3, 4]

    def test_a_walk_counts_and_ranks_in_bounded_statements(self):
        statements = page_statements(Unit("walk", roots=[1, 2]), self._ctx(), [], 5)
        assert [y for _, _, y in statements] == ["count", "rows"]
        count, rows = statements[0][0], statements[1][0]
        assert count.startswith("UNWIND $_walk AS _wi MATCH (_w) WHERE ID(_w) = _wi "
                                "MATCH (_w)-[:CONTAINS*0..12]->(n) WITH DISTINCT n")
        assert count.endswith("RETURN count(n)")
        assert "LIMIT $_k RETURN _k0, _k1" in rows and "collect(" not in rows

    def test_a_units_ancestors_are_tallied_by_entity_type(self):
        cypher, params = tally_statement(Unit("range", "A", 10, 20), self._ctx(), [[3]])
        assert cypher.startswith("MATCH (n:`A`) WHERE ID(n) >= $_lo AND ID(n) < $_hi")
        # After the scope clamp: only in-scope matches are tallied.
        assert cypher.index("ID(_r0) IN $_roots0") < cypher.index("(_c)")
        assert cypher.endswith(
            "WITH n MATCH (_c)-[:CONTAINS*1..12]->(n) "
            "WITH _c, labels(n)[0] AS _et, count(DISTINCT n) AS _k "
            "RETURN _c.urn, _c.displayName, labels(_c)[0], _et, _k")
        assert params == {"p0": 1, "_lo": 10, "_hi": 20, "_roots0": [3]}

    def test_a_later_page_filters_before_it_orders(self):
        cypher, params = after_statement(Unit("visible", "A"), self._ctx(visible=["u"]),
                                         [], 5, ["m", "u9"])
        assert "n.urn IN $_visible" in cypher and params["_visible"] == ["u"]
        # A WITH's WHERE applies after its ORDER BY and LIMIT — the keyset
        # has to filter in a WITH of its own.
        assert ("WITH n, toLower(n.displayName) AS _k0, n.urn AS _k1 WHERE "
                "(_k0 > $_a0 OR (_k0 = $_a0 AND _k1 > $_a1)) WITH _k0, _k1 "
                "ORDER BY _k0, _k1 LIMIT $_k") in cypher
        assert params["_a0"] == "m" and params["_a1"] == "u9"


# ---------------------------------------------------------------------------
# Stores
# ---------------------------------------------------------------------------

def _session(sid="s1", **kw) -> Session:
    return Session.start(sid, kw.pop("query_id", "q"), kw.pop("data_version", "1"),
                         kw.pop("after", None), kw.pop("k", 10),
                         Plan([Unit("range", "A", size=5)]))


@pytest.fixture(params=["memory", "redis"])
def store(request):
    if request.param == "memory":
        return MemorySessionStore()
    return RedisSessionStore(fakeredis.aioredis.FakeRedis(), "ns")


class TestStores:
    async def test_a_session_round_trips(self, store):
        s = _session()
        s.rows, s.count, s.scanned = [[1, "u"]], 7, 5
        assert await store.save(s, None, 60)
        back = await store.load("s1")
        assert (back.rows, back.count, back.scanned, back.pending) == (
            [[1, "u"]], 7, 5, [Unit("range", "A", size=5)])

    async def test_one_request_holds_the_lease(self, store):
        token = await store.lease("s1", 10_000)
        assert token and await store.lease("s1", 10_000) is None
        await store.release("s1", "someone-else")
        assert await store.lease("s1", 10_000) is None
        await store.release("s1", token)
        assert await store.lease("s1", 10_000)

    async def test_a_holder_that_lost_its_lease_cannot_overwrite(self, store):
        token = await store.lease("s1", 10_000)
        await store.release("s1", token)
        other = await store.lease("s1", 10_000)
        assert not await store.save(_session(), token, 60)
        assert await store.save(_session(), other, 60)

    async def test_facets_are_claimed_once(self, store):
        assert await store.claim_facets("s1", 30)
        assert not await store.claim_facets("s1", 30)
        await store.save_facets("s1", [[{"a": 1}]], 60)
        assert await store.load_facets("s1") == [[{"a": 1}]]

    async def test_an_unreadable_session_is_a_miss(self):
        assert Session.from_json('{"sid": "x"}') is None

    async def test_tallies_add_up_across_commits_and_rank_fullest_first(self, store):
        token = await store.lease("s1", 10_000)
        assert await store.save(_session(), token, 60, tallies={
            "urn:db": [3, "db", "Container", {"Dataset": 3}],
            "urn:x": [1, "x", "Container", {"Dataset": 1}],
        })
        assert await store.save(_session(), token, 60, tallies={
            "urn:db": [4, "db", "Container", {"Field": 4}],
            "urn:y": [1, "y", "Container", {"Field": 1}],
        })
        assert await store.top_tallies("s1", 10) == [
            ("urn:db", [7, "db", "Container", {"Dataset": 3, "Field": 4}]),
            # A tie ranks in descending urn order — the same on both stores.
            ("urn:y", [1, "y", "Container", {"Field": 1}]),
            ("urn:x", [1, "x", "Container", {"Dataset": 1}]),
        ]
        assert [urn for urn, _ in await store.top_tallies("s1", 1)] == ["urn:db"]
        assert await store.read_tallies("s1", ["urn:x", "urn:none"]) == {
            "urn:x": [1, "x", "Container", {"Dataset": 1}]}

    async def test_a_holder_that_lost_its_lease_commits_no_tally(self, store):
        token = await store.lease("s1", 10_000)
        await store.release("s1", token)
        other = await store.lease("s1", 10_000)
        tally = {"urn:db": [2, "db", "Container", {"Dataset": 2}]}
        assert not await store.save(_session(), token, 60, tallies=tally)
        assert await store.top_tallies("s1", 10) == []
        assert await store.save(_session(), other, 60, tallies=tally)
        assert await store.read_tallies("s1", ["urn:db"]) == {"urn:db": tally["urn:db"]}

    async def test_an_expired_session_takes_its_tally_with_it(self, monkeypatch):
        from backend.app.providers.falkordb_search import session as session_mod
        store = MemorySessionStore()
        await store.save(_session(), None, 60, tallies={"urn:db": [1, "", "", {"": 1}]})
        now = session_mod.time.monotonic()
        monkeypatch.setattr(session_mod.time, "monotonic", lambda: now + 61)
        assert await store.load("s1") is None
        assert "s1" not in store._tallies

    async def test_deleting_a_session_drops_its_tally(self, store):
        await store.save(_session(), None, 60, tallies={"urn:db": [1, "", "", {"": 1}]})
        await store.delete("s1")
        assert await store.top_tallies("s1", 10) == []
        assert await store.read_tallies("s1", ["urn:db"]) == {}


# ---------------------------------------------------------------------------
# Sessions, end to end against a fake scan
# ---------------------------------------------------------------------------

class _Provider:
    """What the engine reads from a provider, around a scripted scan."""

    _name_property = None

    def __init__(self):
        self._redis = None
        self._cache_ns = None
        self.fetched = []

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        return []

    async def get_nodes_batch(self, urns):
        self.fetched.append(list(urns))
        return [GraphNode(urn=u, entityType="t", displayName=u) for u in urns]

    async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
        # The one statement the engine runs itself (the scan is scripted):
        # whether the graph keeps any property raw. This one keeps none.
        assert "propertiesRaw" in cypher
        return type("Result", (), {"result_set": []})()


class _Scan:
    """Stands in for ``make_plan`` and ``_run_unit``: each unit is a label
    whose rows are ``[name, urn]``, already in order — and, for a search
    that tallies, whose ``tallies`` are its ancestor rows."""

    def __init__(self, units, *, delay=0.0, fail=None, pressure=None, tallies=None):
        self.units = units
        self.delay = delay
        self.fail = fail or set()
        self.pressure = pressure or set()
        self.tallies = tallies or {}
        self.runs = []

    async def plan(self, provider, query, compiler, **kw):
        return Plan([Unit("range", label, size=len(rows)) for label, rows in self.units.items()])

    async def run(self, unit, session, ctx, run, timeout_s):
        self.runs.append((unit.label, unit.lo, unit.hi))
        await asyncio.sleep(self.delay)
        if unit.label in self.fail:
            raise ProviderBusy(provider_name="p", reason="full", retry_after_seconds=1) \
                if self.fail == {"busy"} else RuntimeError("boom")
        if unit.label in self.pressure:
            lo = unit.lo or 0
            width = (unit.hi if unit.hi is not None else lo + unit.span) - lo
            if width > 4:           # too much to read in one chunk
                raise RuntimeError("Query timed out")
        rows = [r for r in self.units[unit.label] if session.after is None or r > session.after]
        tallied = (self.tallies.get(unit.label, [])
                   if ctx.tally and session.after is None and session.k else [])
        return (0 if session.after is not None else len(self.units[unit.label]),
                rows[:session.k], tallied)


@pytest.fixture
def scan(monkeypatch):
    def install(units, **kw):
        s = _Scan(units, **kw)
        monkeypatch.setattr(engine_mod, "make_plan", s.plan)
        monkeypatch.setattr(engine_mod, "_run_unit", s.run)
        monkeypatch.setattr(engine_mod, "_is_pressure",
                            lambda exc: isinstance(exc, TimeoutError) or "timed out" in str(exc))
        return s
    return install


@pytest.fixture(autouse=True)
def fresh_memory_store(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    store = MemorySessionStore()
    monkeypatch.setattr(session_mod, "_MEMORY", store)
    return store


def _rows(prefix, n):
    return [[f"{prefix}{i:03d}", f"urn:{prefix}{i:03d}"] for i in range(n)]


async def _search(provider, *, cursor=None, session_id=None, page_size=5, wait_ms=None,
                  data_version="1", **extra):
    options = {"results": "hits", "pageSize": page_size, "sort": "displayName",
               "sortDir": "asc", **extra}
    if cursor:
        options["cursor"] = cursor
    if session_id:
        options["sessionId"] = session_id
    if wait_ms is not None:
        options["waitMs"] = wait_ms
    return await engine_mod.execute_session_search(
        provider, _query(**options),
        context=SearchRunContext(data_version=data_version, scope_hash="h"),
    )


class TestSessions:
    async def test_every_match_is_counted_and_the_page_is_the_global_first(self, scan):
        scan({"A": _rows("b", 3), "B": _rows("a", 4)})
        page = await _search(_Provider())
        assert page.status == "complete" and page.count_status == "exact"
        assert page.total_count == 7 and page.candidate_count == 7
        assert [h.node.urn for h in page.hits] == [
            "urn:a000", "urn:a001", "urn:a002", "urn:a003", "urn:b000"]
        assert page.progress.scanned == page.progress.total == 7
        assert not page.truncated and not page.deadline_exceeded

    async def test_a_complete_page_is_complete_even_when_its_paths_run_late(self, scan,
                                                                           monkeypatch):
        """Where each hit sits decorates the page; running out of time for it
        leaves the paths out and says so — never "partial results" on an
        answer whose every match was counted and listed."""
        monkeypatch.setattr(engine_mod, "_PATHS_FLOOR_S", 0.05)
        scan({"A": _rows("a", 3)})
        provider = _Provider()

        async def slow_chains(urns):
            await asyncio.sleep(0.5)
            return {u: ["urn:parent"] for u in urns}

        provider.get_ancestor_chains = slow_chains
        page = await _search(provider, wait_ms=0, includeAncestorPath=True)
        assert page.status == "complete" and page.total_count == 3
        assert not page.deadline_exceeded and not page.truncated
        assert all(h.ancestor_path == [] for h in page.hits)
        assert any("could not be read in time" in n for n in page.scope_diagnostics.notes)

    async def test_a_page_learns_where_its_hits_sit(self, scan):
        scan({"A": _rows("a", 2)})
        provider = _Provider()

        async def chains(urns):
            return {u: ["urn:parent"] for u in urns}

        provider.get_ancestor_chains = chains
        page = await _search(provider, wait_ms=0, includeAncestorPath=True)
        assert [[a.urn for a in h.ancestor_path] for h in page.hits] == [["urn:parent"]] * 2
        assert not page.deadline_exceeded and page.scope_diagnostics is None

    async def test_pages_follow_the_order_to_the_end(self, scan):
        scan({"A": _rows("a", 12), "B": _rows("b", 9)})
        provider, seen, cursor = _Provider(), [], None
        for _ in range(10):
            page = await _search(provider, cursor=cursor)
            seen += [h.node.urn for h in page.hits]
            cursor = page.cursor
            if not cursor:
                break
        assert seen == [r[1] for r in _rows("a", 12) + _rows("b", 9)]

    async def test_pages_past_the_rows_held_continue_after_the_last_key(self, scan, monkeypatch):
        s = scan({"A": _rows("a", 120)})
        monkeypatch.setenv("DEEP_SEARCH_SESSION_ROWS", "50")
        from backend.app.services.deep_search import get_deep_search_settings
        get_deep_search_settings.cache_clear()
        try:
            provider, seen, cursor = _Provider(), [], None
            while True:
                page = await _search(provider, cursor=cursor, page_size=10)
                seen += [h.node.urn for h in page.hits]
                cursor = page.cursor
                if not cursor:
                    break
            assert seen == [r[1] for r in _rows("a", 120)]
            assert page.total_count == 120, "a later page still knows the total"
        finally:
            get_deep_search_settings.cache_clear()
        # Fifty rows held per scan: three scans for 120 rows, the pages
        # between them slices of what the last scan held.
        assert len(s.runs) == 3

    async def test_a_cursor_for_another_query_is_refused(self, scan):
        scan({"A": _rows("a", 12)})
        page = await _search(_Provider())
        with pytest.raises(CompileError):
            await _search(_Provider(), cursor=page.cursor, sort="qualifiedName")

    async def test_a_progressive_request_answers_before_the_scan_ends(self, scan):
        s = scan({f"L{i}": _rows(f"n{i}_", 2) for i in range(8)}, delay=0.05)
        provider = _Provider()
        first = await _search(provider, wait_ms=60)
        assert first.status == "running" and first.total_count is None
        assert first.count_status == "lowerBound"
        assert first.progress.scanned < first.progress.total
        assert not first.truncated and not first.deadline_exceeded
        assert first.cursor is None
        page = first
        for _ in range(20):
            page = await _search(provider, wait_ms=60, session_id=first.session_id)
            if page.status == "complete":
                break
        assert page.total_count == 16 and page.session_id == first.session_id
        assert len(s.runs) == 8, "each unit ran once across the requests"

    async def test_a_request_with_no_wait_still_moves_the_scan_on(self, scan):
        scan({f"L{i}": _rows(f"n{i}_", 1) for i in range(5)})
        provider, page, rounds = _Provider(), None, 0
        page = await _search(provider, wait_ms=0)
        while page.status == "running" and rounds < 10:
            rounds += 1
            page = await _search(provider, wait_ms=0, session_id=page.session_id)
        assert page.status == "complete" and page.total_count == 5
        assert rounds == 2      # two units per request: 2 + 2 + 1

    async def test_a_classic_request_that_runs_out_says_so(self, scan):
        scan({f"L{i}": _rows(f"n{i}_", 1) for i in range(6)}, delay=0.15)
        page = await _search(_Provider(), softDeadlineMs=200)
        assert page.status == "running"
        assert page.truncated and page.deadline_exceeded and page.total_count is None

    async def test_a_unit_that_runs_out_of_time_is_split_and_retried(self, scan, monkeypatch):
        s = scan({"A": [["a", "urn:a"]]}, pressure={"A"})

        async def plan(provider, query, compiler, **kw):
            # A bounded band and an open-ended one, each too wide to read.
            return Plan([Unit("range", "A", None, 16, size=2),
                         Unit("range", "A", 16, None, size=2, span=16)])

        monkeypatch.setattr(engine_mod, "make_plan", plan)
        page = await _search(_Provider())
        assert page.status == "complete"
        widths = {(lo or 0, hi) for _, lo, hi in s.runs}
        assert (0, 16) in widths and (16, None) in widths      # tried whole first
        assert (28, None) in widths                            # the tail, cut down

    async def test_a_full_fleet_with_nothing_done_is_a_429(self, scan):
        scan({"busy": _rows("a", 2)}, fail={"busy"})
        with pytest.raises(ProviderBusy):
            await _search(_Provider())

    async def test_a_failed_unit_fails_the_search_and_is_not_kept(self, scan, fresh_memory_store):
        scan({"A": _rows("a", 2)}, fail={"A"})
        with pytest.raises(RuntimeError, match="search failed: boom"):
            await _search(_Provider())
        assert fresh_memory_store._sessions == {}

    async def test_identical_searches_share_one_session(self, scan):
        s = scan({"A": _rows("a", 3)})
        provider = _Provider()
        one = await _search(provider)
        two = await _search(provider)
        assert one.session_id == two.session_id
        assert len(s.runs) == 1

    async def test_new_data_starts_a_new_session_but_a_continued_one_says_stale(self, scan):
        s = scan({f"L{i}": _rows(f"n{i}_", 1) for i in range(4)}, delay=0.05)
        provider = _Provider()
        first = await _search(provider, wait_ms=40)
        fresh = await _search(provider, data_version="2")
        assert fresh.session_id != first.session_id and not fresh.stale
        continued = await _search(provider, session_id=first.session_id, data_version="2")
        assert continued.session_id == first.session_id and continued.stale
        assert s.runs  # both ran

    async def test_a_session_id_for_another_query_is_ignored(self, scan):
        scan({"A": _rows("a", 3)})
        provider = _Provider()
        other = await _search(provider, sort="qualifiedName")
        page = await _search(provider, session_id=other.session_id)
        assert page.session_id != other.session_id


class TestFacets:
    async def test_facets_are_computed_once_and_the_page_waits_for_them(self, scan, monkeypatch):
        scan({"A": _rows("a", 3)})
        calls = []

        async def facets(provider, query, specs, sid, store, run, budget_s, settings):
            calls.append(sid)
            await asyncio.sleep(0.05)
            await store.save_facets(sid, [[]], 60)

        monkeypatch.setattr(engine_mod, "_compute_facets", facets)
        provider = _Provider()
        agg = [{"by": "entityType"}]
        page = await _search(provider, results="both", aggregations=agg)
        assert page.status == "complete" and page.aggregates == [[]]
        again = await _search(provider, results="both", aggregations=agg)
        assert again.aggregates == [[]] and len(calls) == 1

    async def test_facets_that_fail_say_why_and_do_not_cost_the_hits(self, scan, monkeypatch):
        scan({"A": _rows("a", 3)})

        async def facets(provider, query, specs, sid, store, run, budget_s, settings):
            await store.save_facets(sid, {"error": "too slow"}, 60)

        monkeypatch.setattr(engine_mod, "_compute_facets", facets)
        page = await _search(_Provider(), results="both", aggregations=[{"by": "entityType"}])
        # The failed facet keeps its place (empty), so the others stay aligned.
        assert page.aggregates == [[]] and len(page.hits) == 3
        notes = page.scope_diagnostics.notes
        assert any("facets could not be computed" in n for n in notes)
        # What the graph said stays in the server's log.
        assert not any("too slow" in n for n in notes)


class TestLeaseHandover:
    async def test_the_holder_carries_on_from_the_latest_commit(self, fresh_memory_store):
        """A request reads a session, then takes its lease — and another
        request may have committed and released in between. The holder must
        run what is pending NOW, not what was pending when it read: running
        a unit twice counts its matches twice."""
        from backend.app.services.deep_search import get_deep_search_settings
        store = fresh_memory_store
        units = [Unit("range", label, size=1) for label in "ABCD"]
        session = Session("s1", "q", "1", None, 0, list(units), [], 4)
        await store.save(session, None, 60)
        stale = await store.load("s1")

        # Another request runs A and B and commits, while ``stale`` waits.
        done = await store.load("s1")
        done.pending, done.scanned, done.count = done.pending[2:], 2, 20
        await store.save(done, None, 60)

        class _Work:
            ran: list = []

            async def begin(self, store):
                pass

            async def unit(self, unit, timeout_s):
                self.ran.append(unit.label)
                return 5

            def fold(self, unit, result):
                stale.count += result

            def commit(self):
                return {}

        work = _Work()
        after = await engine_mod._advance(stale, False, store, work,
                                          asyncio.get_running_loop().time() + 5,
                                          get_deep_search_settings())
        assert work.ran == ["C", "D"]
        assert (after.status, after.count, after.scanned) == ("complete", 30, 4)


class TestUnitBudget:
    """A client follows a search with short waits (the canvas asks for 0.8 s).
    A unit that takes longer must still finish: given up when the request's
    wait ends, it would be put back whole and started again by the next
    request, and the next — never counted, never split, the search running
    forever. So a unit a request starts runs until it is done or its own
    budget is spent, and over budget it is split as a timed-out unit is."""

    @pytest.fixture
    def budget(self, monkeypatch):
        """Settings whose unit budget is ``ms``, and little grace, so that a
        unit given up for the request's sake shows at once."""
        from backend.app.services.deep_search import get_deep_search_settings

        def install(ms=15_000):
            settings = dataclasses.replace(get_deep_search_settings(), chunk_timeout_ms=ms)
            monkeypatch.setattr(engine_mod, "get_deep_search_settings", lambda: settings)
            monkeypatch.setattr(engine_mod, "_GRACE_S", 0.05)
            return settings
        return install

    async def test_a_unit_slower_than_the_wait_finishes_in_the_request_that_started_it(
            self, scan, budget):
        budget()
        s = scan({"A": _rows("a", 2), "B": _rows("b", 3)}, delay=0.3)
        page = await _search(_Provider(), wait_ms=0)
        assert page.status == "complete" and page.total_count == 5
        assert len(s.runs) == 2, "each unit ran once"

    async def test_a_unit_over_its_budget_is_split_and_every_match_counted_once(
            self, scan, budget, monkeypatch, fresh_memory_store):
        budget(ms=200)
        scan({})
        nodes = [[f"n{i:02d}", f"urn:n{i:02d}"] for i in range(16)]
        runs = []

        async def plan(provider, query, compiler, **kw):
            return Plan([Unit("range", "A", 0, 16, size=16)])

        async def run(unit, session, ctx, run_, timeout_s):
            runs.append((unit.lo, unit.hi))
            if unit.hi - unit.lo > 4:
                await asyncio.sleep(5)          # too wide: runs past its budget
            mine = nodes[unit.lo:unit.hi]
            return len(mine), mine[:session.k], []

        monkeypatch.setattr(engine_mod, "make_plan", plan)
        monkeypatch.setattr(engine_mod, "_run_unit", run)
        provider = _Provider()
        page = await _search(provider, wait_ms=0)
        for _ in range(10):
            if page.status == "complete":
                break
            page = await _search(provider, wait_ms=0, session_id=page.session_id)
        assert page.status == "complete" and page.total_count == 16
        assert [h.node.urn for h in page.hits] == [n[1] for n in nodes[:5]]
        assert sorted(r for r in runs if r[1] - r[0] <= 4) == [(0, 4), (4, 8), (8, 12), (12, 16)]
        # Every request committed inside its lease: the session kept is the answer.
        kept = await fresh_memory_store.load(page.session_id)
        assert (kept.status, kept.count) == ("complete", 16)

    async def test_a_unit_over_its_budget_that_cannot_be_cut_fails_the_search(
            self, scan, budget, monkeypatch):
        """A subtree under one root can't be split: over its budget it fails
        the search, rather than being started by every request forever."""
        budget(ms=200)
        scan({})

        async def plan(provider, query, compiler, **kw):
            return Plan([Unit("walk", roots=[7], size=3)])

        async def run(unit, session, ctx, run_, timeout_s):
            await asyncio.sleep(5)

        monkeypatch.setattr(engine_mod, "make_plan", plan)
        monkeypatch.setattr(engine_mod, "_run_unit", run)
        with pytest.raises(SearchFailed):
            await _search(_Provider(), wait_ms=0)

    async def test_a_long_wait_is_cut_to_leave_room_for_the_last_units_budget(
            self, scan, budget, monkeypatch):
        """However long a request asks to wait, it stops starting units in
        time for the last one's budget to end inside the request timeout."""
        budget(ms=200)
        monkeypatch.setattr(engine_mod, "_REQUEST_S", 0.6, raising=False)
        scan({f"L{i:02d}": _rows(f"n{i:02d}_", 1) for i in range(20)}, delay=0.1)
        started = time.monotonic()
        page = await _search(_Provider(), softDeadlineMs=120_000)
        assert time.monotonic() - started < 0.6
        assert page.status == "running" and page.deadline_exceeded

    async def test_the_lease_outlasts_the_last_units_budget(self, fresh_memory_store, budget):
        """A request holds its session until the last unit it started has
        spent its budget: past that, another request could take the unit on
        and this one's commit would be refused, its work lost."""
        settings = budget()
        store, leases = fresh_memory_store, []
        take = store.lease

        async def lease(sid, ttl_ms):
            leases.append(ttl_ms)
            return await take(sid, ttl_ms)

        store.lease = lease
        session = Session("s1", "q", "1", None, 0, [Unit("range", "A", size=1)], [], 1)
        await store.save(session, None, 60)

        class _Work:
            async def begin(self, store):
                pass

            async def unit(self, unit, timeout_s):
                return 1

            def fold(self, unit, result):
                pass

            def commit(self):
                return {}

        await engine_mod._advance(session, False, store, _Work(), time.monotonic() + 2,
                                  settings, unit_s=30)
        assert leases and leases[0] >= (2 + 30) * 1000


class TestAncestorTally:
    """The ``ancestor`` facet — the canvas's "N matches inside" badges — is
    tallied by the scan, a unit at a time, instead of one statement over
    every match."""

    UNITS = {"A": _rows("a", 3), "B": _rows("b", 4)}
    TALLIES = {
        "A": [["urn:root", "Root", "Domain", "Dataset", 3],
              ["urn:db1", "db1", "Container", "Dataset", 3]],
        "B": [["urn:root", "Root", "Domain", "SchemaField", 4],
              ["urn:db2", "db2", "Container", "SchemaField", 4]],
    }

    @staticmethod
    def _no_capped_facets(monkeypatch):
        async def facets(*a, **kw):
            raise AssertionError("the ancestor facet needs no capped statement")
        monkeypatch.setattr(engine_mod, "_compute_facets", facets)

    async def test_the_facet_is_the_scans_tally_fullest_first(self, scan, monkeypatch):
        scan(self.UNITS, tallies=self.TALLIES)
        self._no_capped_facets(monkeypatch)
        page = await _search(_Provider(), results="both",
                             aggregations=[{"by": "ancestor", "maxBuckets": 2}])
        assert page.status == "complete" and page.total_count == 7
        [facet] = page.aggregates
        assert [(b.ancestor_urn, b.match_count) for b in facet] == [("urn:root", 7), ("urn:db2", 4)]
        root = facet[0]
        assert (root.ancestor_display_name, root.ancestor_entity_type) == ("Root", "Domain")
        assert root.type_counts == {"Dataset": 3, "SchemaField": 4}

    async def test_the_facet_waits_for_the_whole_scan(self, scan, monkeypatch):
        # More units than one wave (two), so the first answer is partial.
        scan({**self.UNITS, "C": _rows("c", 1), "D": _rows("d", 1)},
             tallies=self.TALLIES, delay=0.05)
        self._no_capped_facets(monkeypatch)
        provider = _Provider()
        agg = [{"by": "ancestor"}]
        first = await _search(provider, results="both", aggregations=agg, wait_ms=0)
        assert first.status == "running" and first.aggregates is None
        page = first
        while page.status == "running":
            page = await _search(provider, results="both", aggregations=agg, wait_ms=200,
                                 session_id=first.session_id)
        assert {b.ancestor_urn: b.match_count for b in page.aggregates[0]} == {
            "urn:root": 7, "urn:db1": 3, "urn:db2": 4}

    async def test_facets_keep_the_order_they_were_asked_in(self, scan, monkeypatch):
        scan(self.UNITS, tallies=self.TALLIES)

        async def facets(provider, query, specs, sid, store, run, budget_s, settings):
            assert [a.by for a in specs] == ["entityType"]
            await store.save_facets(sid, [[{"ancestorUrn": "t", "ancestorDisplayName": "t",
                                            "ancestorEntityType": "t",
                                            "ancestorDepthFromScopeRoot": 0,
                                            "matchCount": 7}]], 60)

        monkeypatch.setattr(engine_mod, "_compute_facets", facets)
        page = await _search(_Provider(), results="both",
                             aggregations=[{"by": "entityType"}, {"by": "ancestor"}])
        assert [b.ancestor_urn for b in page.aggregates[0]] == ["t"]
        assert page.aggregates[1][0].ancestor_urn == "urn:root"

    async def test_any_containers_count_is_read_from_the_session(self, scan, monkeypatch):
        scan(self.UNITS, tallies=self.TALLIES)
        self._no_capped_facets(monkeypatch)
        provider = _Provider()
        page = await _search(provider, results="both", aggregations=[{"by": "ancestor"}])
        read = engine_mod.read_ancestor_counts
        out = await read(provider, page.session_id, ["urn:db1", "urn:elsewhere"], scope_hash="h")
        assert out == {"status": "complete", "counts": {
            "urn:db1": {"count": 3, "typeCounts": {"Dataset": 3},
                        "displayName": "db1", "entityType": "Container"},
            "urn:elsewhere": {"count": 0, "typeCounts": {},
                              "displayName": "", "entityType": ""}}}
        # Another scope's session, or none: run the search again.
        assert (await read(provider, page.session_id, ["urn:db1"], scope_hash="other")
                )["status"] == "expired"
        assert (await read(provider, "gone", ["urn:db1"], scope_hash="h"))["status"] == "expired"

    async def test_a_search_without_the_facet_tallies_nothing(self, scan):
        s = scan(self.UNITS, tallies=self.TALLIES)
        provider = _Provider()
        page = await _search(provider, results="both", aggregations=[{"by": "entityType"}])
        out = await engine_mod.read_ancestor_counts(provider, page.session_id, ["urn:root"],
                                                    scope_hash="h")
        assert out["counts"]["urn:root"]["count"] == 0 and s.runs


# ---------------------------------------------------------------------------
# Which searches the service sends to the engine
# ---------------------------------------------------------------------------

class TestServiceRouting:
    def _svc(self, provider):
        from backend.app.services.advanced_search_service import AdvancedSearchService
        return AdvancedSearchService(SimpleNamespace(provider=provider),
                                     session=None, workspace_id="ws")

    def _scope(self):
        from backend.app.services.view_scope import EffectiveViewScope
        return EffectiveViewScope(
            view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
            root_urns=(), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
            max_depth=12, scope_hash="scope-1")

    class _Both:
        supports_search_sessions = True

        def __init__(self):
            self.calls = []

        async def deep_search_session(self, query, *, context):
            self.calls.append(("session", context))
            return "session-page"

        async def deep_search(self, query, *, deadline_ms=None):
            self.calls.append(("legacy", deadline_ms))
            return "legacy-page"

    async def test_hits_run_on_the_engine_with_the_scope_hash(self):
        p = self._Both()
        ctx = SearchRunContext(data_version="7")
        assert await self._svc(p)._run(_query(), self._scope(), None, ctx) == "session-page"
        assert p.calls[0][1] == SearchRunContext(data_version="7", scope_hash="scope-1")

    @pytest.mark.parametrize("predicate,results", [
        ({"kind": "text", "value": "x"}, "aggregates"),
        ({"kind": "group", "op": "and", "children": [
            {"kind": "path", "sourceUrns": ["a"], "targetUrns": ["b"]}]}, "paths"),
    ])
    async def test_facets_alone_and_paths_stay_on_the_capped_engine(self, predicate, results):
        p = self._Both()
        q = SearchQuery.model_validate({"predicate": predicate, "scope": {"viewId": "v"},
                                        "options": {"results": results}})
        assert await self._svc(p)._run(q, self._scope(), None, SearchRunContext()) == "legacy-page"

    async def test_without_a_context_or_the_capability_it_is_the_capped_engine(self):
        p = self._Both()
        assert await self._svc(p)._run(_query(), self._scope(), 5, None) == "legacy-page"
        p.supports_search_sessions = False
        assert await self._svc(p)._run(_query(), self._scope(), 5, SearchRunContext()) \
            == "legacy-page"

    async def test_the_capped_engine_runs_inside_one_admission(self):
        import contextlib
        p, held = self._Both(), []
        p.supports_search_sessions = False

        @contextlib.asynccontextmanager
        async def admit():
            held.append("in")
            yield
            held.append("out")

        async def legacy(query, *, deadline_ms=None):
            held.append("search")
            return "legacy-page"

        p.deep_search = legacy
        await self._svc(p)._run(_query(), self._scope(), None, SearchRunContext(admit=admit))
        assert held == ["in", "search", "out"]
