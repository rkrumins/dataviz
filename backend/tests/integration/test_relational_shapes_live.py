"""LIVE FalkorDB: the Cypher shapes relationship predicates are built on.

A relationship predicate ("parent is a domain", "feeds a dashboard within 3
hops through confident edges", "every column described") tests the
entities related to each candidate, so it compiles to a pattern
comprehension evaluated per candidate. FalkorDB 4.18 accepts a
comprehension only in some places, and gives wrong rows — not errors — in
others. Each test here pins one behaviour the compiler relies on (or
avoids), on a small graph whose right answers are known, so an engine
upgrade that changes one turns this file red. Findings are written up in
docs/search-engine/S0_FINDINGS.md §15.

What the compiler does because of them:

* A comprehension never sits in a clause's WHERE (MATCH or WITH): it is
  projected on a WITH — ``WITH n, <stage> AS _xt0 WHERE _xt0`` — then
  filtered.
* A comprehension is built for every row that reaches its projection, a
  false conjunct beside it notwithstanding. So cheap conditions filter in
  the clause WHERE first (the head), each top-level relationship is its own
  stage, and a related entity's simple tests sit in the comprehension's
  WHERE. AND / OR inside ``ANY(… WHERE …)`` do short-circuit the tests
  themselves.
* The related entity is tested in the comprehension's projection, not in
  its WHERE: ``[(n)<-[:C]-(_xr) WHERE <structural> | <test of _xr>]``. A
  nested relationship is anchored on the pattern variable there. Anchored
  on the outer list's element variable, it silently matches wrong rows.
* The comprehension's own WHERE holds only ID comparisons and the
  ``ALL(… IN relationships(p) …)`` edge filter. A pattern predicate or a
  nested comprehension there fails to compile.
* Every comprehension binds names no other one in the statement uses: a
  reused name makes the second list come back empty.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_relational_shapes_live.py -q
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

from backend.app.providers.falkordb_typed_ops import compile_comparison
from backend.common.search_semantics import resolve_comparison


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live shape tests.",
)

C = "CONTAINS"
L = "FLOWS_TO|TRANSFORMS"

# id, label, displayName, properties
NODES = [
    (1, "domain", "Country", {}),
    (2, "region", "United Kingdom", {"region": "EMEA"}),
    (3, "city", "London", {}),
    (4, "city", "Manchester", {}),
    (5, "region", "Canada", {"region": "AMER"}),
    (6, "city", "London", {}),
    (7, "domain", "Product", {}),
    (8, "region", "United Kingdom", {}),
    (9, "workspace", "Finance", {"owner": "cfo"}),
    (10, "folder", "Reports", {}),
    (11, "dashboard", "Revenue", {}),
    (12, "dashboard", "Costs", {}),
    (13, "domain", "Sales", {}),
    (14, "dataset", "orders", {"owner": "alice"}),
    (15, "column", "id", {"description": "pk"}),
    (16, "column", "amount", {"description": ""}),
    (17, "column", "customer", {"description": "who"}),
    (18, "dataset", "customers", {}),
    (19, "column", "cid", {"description": "x"}),
    (20, "column", "email", {"description": "y"}),
    (21, "dataset", "shared", {}),
    (22, "topic", "events", {}),
    (23, "dataset", "a", {}), (24, "dataset", "b", {}), (25, "dataset", "c", {}),
    (26, "dataset", "d1", {}), (27, "dataset", "d2", {}), (28, "dataset", "d3", {}),
    (29, "dataset", "d4", {}),
    (30, "job", "x", {}), (31, "job", "y", {}), (32, "job", "z", {}),
]
# parent -> child. "shared" (21) has two parents; two regions are named
# "United Kingdom" and two cities "London".
CONTAINMENT = [
    (1, 2), (2, 3), (2, 4), (1, 5), (5, 6), (7, 8), (9, 10), (10, 11), (10, 12),
    (13, 14), (14, 15), (14, 16), (14, 17), (13, 18), (18, 19), (18, 20),
    (13, 21), (9, 21), (13, 22), (13, 23), (13, 24), (13, 25),
    (13, 26), (13, 27), (13, 28), (13, 29),
]
# source, target, type, confidence (None: unset), user properties (JSON text)
LINEAGE = [
    (22, 14, "TRANSFORMS", 0.9, {"mode": "stream", "job": "j1"}),
    (14, 11, "FLOWS_TO", 0.95, {"transform": "join", "n": 1}),
    (18, 14, "FLOWS_TO", 0.5, {"transform": "copy"}),
    (14, 12, "FLOWS_TO", 0.8, {"nested": {"transform": "join"}}),
    (23, 24, "FLOWS_TO", 0.9, {}), (24, 25, "FLOWS_TO", 0.9, {}),
    (25, 23, "FLOWS_TO", 0.9, {}),                       # a cycle
    (26, 27, "FLOWS_TO", 0.9, {}), (26, 28, "FLOWS_TO", 0.9, {}),
    (27, 29, "FLOWS_TO", 0.9, {}), (28, 29, "FLOWS_TO", 0.9, {}),   # a diamond
    (13, 9, "AGGREGATED", None, None),                   # a rollup, no properties
    (30, 31, "FLOWS_TO", 0.9, {}), (31, 30, "FLOWS_TO", 0.9, {}),
    (30, 32, "FLOWS_TO", 0.9, {}),                       # x ⇄ y, x → z
]
LABELS = sorted({label for _, label, _, _ in NODES})


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                  port=int(os.getenv("FALKORDB_PORT", "6379")))
    g = db.select_graph(f"relshapes_{uuid.uuid4().hex[:8]}")
    for nid, label, name, props in NODES:
        g.query(f"CREATE (n:`{label}` {{id: $id, urn: $urn, displayName: $name}}) SET n += $p",
                {"id": nid, "urn": f"urn:{nid}", "name": name, "p": props})
    for s, t in CONTAINMENT:
        g.query(f"MATCH (a {{id: $s}}), (b {{id: $t}}) CREATE (a)-[:{C}]->(b)", {"s": s, "t": t})
    for s, t, kind, conf, props in LINEAGE:
        sets = ["r.id = $eid"]
        params = {"s": s, "t": t, "eid": f"e{s}_{t}"}
        if conf is not None:
            sets.append("r.confidence = $c")
            params["c"] = conf
        if props is not None:
            sets.append("r.properties = $p")
            params["p"] = json.dumps(props)
        g.query(f"MATCH (a {{id: $s}}), (b {{id: $t}}) CREATE (a)-[r:{kind}]->(b) "
                f"SET {', '.join(sets)}", params)
    try:
        yield g
    finally:
        g.delete()


def _tail(graph, expr, params=None, head="MATCH (n)"):
    """Ids matching ``expr`` projected on a WITH and filtered, wrapped so its
    tests short-circuit."""
    cypher = (f"{head} WITH n, ANY(_xt IN [0] WHERE {expr}) AS _xt0 WHERE _xt0 "
              "WITH n RETURN n.id")
    return sorted(r[0] for r in graph.query(cypher, params or {}).result_set)


def _stages(graph, stages, params=None, head="MATCH (n)"):
    """Ids matching every one of ``stages``, placed as the compiler places
    them (``tail_clauses``)."""
    from backend.app.providers.falkordb_deep_search import tail_clauses
    cypher = f"{head} {tail_clauses(list(stages))} RETURN n.id"
    return sorted(r[0] for r in graph.query(cypher, params or {}).result_set)


class _Binder:
    def __init__(self):
        self.params = {}

    def __call__(self, value):
        name = f"p{len(self.params)}"
        self.params[name] = value
        return f"${name}"


# ---------------------------------------------------------------------------
# Where a comprehension may sit
# ---------------------------------------------------------------------------

PARENT_IS_COUNTRY = (f"ANY(_xb1 IN [(n)<-[:{C}]-(_xr1) WHERE ID(_xr1) <> ID(n) "
                     "| _xr1.displayName = 'Country'] WHERE _xb1)")


@pytest.mark.xfail(strict=True, reason="Unable to resolve filtered alias")
def test_a_comprehension_in_a_match_where_fails(graph):
    graph.query(f"MATCH (n) WHERE {PARENT_IS_COUNTRY} RETURN n.id")


@pytest.mark.xfail(strict=True, reason="_AR_EXP_UpdateEntityIdx: unable to locate a value")
def test_a_comprehension_in_a_with_where_fails(graph):
    graph.query(f"MATCH (n) WITH n WHERE {PARENT_IS_COUNTRY} RETURN n.id")


def test_a_projected_comprehension_filters_correctly(graph):
    assert _tail(graph, PARENT_IS_COUNTRY) == [2, 5]


def test_the_tail_follows_a_range_unit_and_a_clamp(graph):
    country = graph.query("MATCH (n {id: 1}) RETURN ID(n)").result_set[0][0]
    head = (f"MATCH (n:`city`) WHERE ID(n) >= 0 AND n.urn IS NOT NULL "
            f"WITH n MATCH (n)<-[:{C}*0..12]-(_r0) WHERE ID(_r0) IN $roots WITH DISTINCT n")
    uk_parent = PARENT_IS_COUNTRY.replace("'Country'", "'United Kingdom'")
    assert _tail(graph, uk_parent, {"roots": [country]}, head=head) == [3, 4]


def test_the_tail_follows_a_walk_unit(graph):
    roots = [r[0] for r in graph.query(
        "MATCH (n) WHERE n.id IN [1, 13] RETURN ID(n)").result_set]
    head = ("UNWIND $w AS _wi MATCH (_w) WHERE ID(_w) = _wi "
            f"MATCH (_w)-[:{C}*0..12]->(n) WITH DISTINCT n WHERE n.urn IS NOT NULL")
    assert _tail(graph, PARENT_IS_COUNTRY, {"w": roots}, head=head) == [2, 5]


def test_bare_stages_follow_every_unit_shape(graph):
    """What the compiler emits: each relationship its own stage, projected
    bare — wrapping it would only short-circuit its cheap tests (its lists
    are built anyway) and costs a nesting level to plan."""
    country = graph.query("MATCH (n {id: 1}) RETURN ID(n)").result_set[0][0]
    clamp = (f"MATCH (n:`city`) WHERE ID(n) >= 0 AND n.urn IS NOT NULL "
             f"WITH n MATCH (n)<-[:{C}*0..12]-(_r0) WHERE ID(_r0) IN $roots WITH DISTINCT n")
    uk_parent = PARENT_IS_COUNTRY.replace("'Country'", "'United Kingdom'")
    assert _stages(graph, [uk_parent], {"roots": [country]}, head=clamp) == [3, 4]
    roots = [r[0] for r in graph.query(
        "MATCH (n) WHERE n.id IN [1, 13] RETURN ID(n)").result_set]
    walk = ("UNWIND $w AS _wi MATCH (_w) WHERE ID(_w) = _wi "
            f"MATCH (_w)-[:{C}*0..12]->(n) WITH DISTINCT n WHERE n.urn IS NOT NULL")
    assert _stages(graph, [PARENT_IS_COUNTRY], {"w": roots}, head=walk) == [2, 5]
    hops = ("MATCH (n) WITH n MATCH _whP0 = (anchor)-[:FLOWS_TO*1..2]->(n) "
            "WHERE anchor.urn = 'urn:18' AND ID(anchor) <> ID(n) WITH DISTINCT n")
    has_parent = (f"ANY(_xb2 IN [(n)<-[:{C}]-(_xr2) WHERE ID(_xr2) <> ID(n) | true] "
                  "WHERE _xb2)")
    assert _stages(graph, [has_parent], head=hops) == [11, 12, 14]
    # Two stages, the second run only on what the first kept; NOT over one.
    assert _stages(graph, [PARENT_IS_COUNTRY, f"NOT {has_parent.replace('2', '3')}"]) == []


def test_a_null_projection_drops_its_element(graph):
    """FalkorDB leaves out of a comprehension's list each element whose
    projection is null — a comparison with a property the entity lacks.
    Every relative's test is coalesced, or "every child owned by alice"
    would hold for Sales, whose other children have no owner at all."""
    owned = "_xr1.owner = 'alice'"
    listed = "MATCH (n {id: 13}) RETURN [(n)-[:CONTAINS]->(_xr1) | %s]"
    assert graph.query(listed % owned).result_set[0][0] == [True]
    assert sorted(graph.query(listed % f"coalesce({owned}, false)").result_set[0][0]) == (
        [False] * 10 + [True])

    def every(test):
        return (f"coalesce(reduce(_xa1 = null, _xb1 IN [(n)-[:{C}]->(_xr1) | {test}] | "
                "CASE WHEN _xa1 IS NULL THEN _xb1 ELSE _xa1 AND _xb1 END), false)")

    assert 13 in _stages(graph, [every(owned)])
    assert 13 not in _stages(graph, [every(f"coalesce({owned}, false)")])


def test_every_one_folds_to_null_when_there_is_none(graph):
    """``coalesce(reduce(…), false)``: null for no relatives, else whether
    every one meets it — a list function fewer than ALL over a bound list."""
    b = _Binder()
    described = compile_comparison("_xr1.`description`",
                                   resolve_comparison("isNotEmpty", None), b)
    every = (f"coalesce(reduce(_xa1 = null, _xb1 IN [(n)-[:{C}]->(_xr1) WHERE ID(_xr1) <> ID(n) "
             f"| coalesce({described}, false)] | CASE WHEN _xa1 IS NULL THEN _xb1 "
             "ELSE _xa1 AND _xb1 END), false)")
    assert _stages(graph, [every], b.params) == [18]


def test_a_route_never_goes_on_from_an_entity_it_passed(graph):
    """x ⇄ y, x → z. Listing routes, FalkorDB goes no further from an entity
    already on one, yet lets a route end on one — so which it finds depends
    on the end it starts from: from x nothing is three hops away, while from
    z back to x, x → y → x → z is found. Past one hop the compiler requires
    routes that pass no entity twice, which both ends agree on."""
    def listed(hops):
        return sorted(graph.query(f"MATCH (n {{id: 30}}) RETURN [(n)-[:FLOWS_TO*{hops}]->(m) "
                                  "| m.id]").result_set[0][0])

    assert listed("2..2") == [30]                  # back to x: it may end on one
    assert listed("3..3") == []
    from_z = ("MATCH (n {{id: 32}}) WITH n MATCH _whP0 = (anchor)-[:FLOWS_TO*3..3]->(n) "
              "WHERE anchor.id = 30 {} RETURN DISTINCT n.id")
    assert [r[0] for r in graph.query(from_z.format("")).result_set] == [32]
    distinct = ("AND size(nodes(_whP0)) = size(reduce(_xs = [], _xm IN nodes(_whP0) | "
                "CASE WHEN _xm IN _xs THEN _xs ELSE _xs + [_xm] END))")
    assert graph.query(from_z.format(distinct)).result_set == []


def test_an_unnamed_range_in_a_match_reads_walks(graph):
    """Without a path variable, a MATCH's variable-length step finds the
    ends of walks — x → y → x → y and x → y → x → z — not of routes, as the
    same step named, or in a comprehension, does. The compiler names every
    such path whose range starts past one hop (scope clamps and walks start
    at none)."""
    def ids(cypher):
        return sorted(r[0] for r in graph.query(cypher).result_set)

    assert ids("MATCH (n {id: 30})-[:FLOWS_TO*3..3]->(m) RETURN m.id") == [31, 32]
    assert ids("MATCH p = (n {id: 30})-[:FLOWS_TO*3..3]->(m) RETURN m.id") == []


def test_rules_project_relationships_side_by_side(graph):
    """Membership: one boolean column per rule, names unique across rules."""
    other = ("ANY(_xb2 IN [(n)-[:CONTAINS]->(_xr2) WHERE ID(_xr2) <> ID(n) "
             "| _xr2.displayName = 'London'] WHERE _xb2)")
    rows = graph.query(
        f"MATCH (n) RETURN n.id, ANY(_mz IN [0] WHERE {PARENT_IS_COUNTRY}) AS m0, "
        f"ANY(_mz IN [0] WHERE {other}) AS m1").result_set
    assert sorted(r[0] for r in rows if r[1]) == [2, 5]
    assert sorted(r[0] for r in rows if r[2]) == [2, 5]


def test_reused_comprehension_names_lose_the_second_list(graph):
    """Why every comprehension gets its own names."""
    reused = (f"ANY(_xb1 IN [(n)<-[:{C}]-(_xr1) | true] WHERE _xb1) AND "
              f"ANY(_xb1 IN [(n)-[:{C}]->(_xr1) | true] WHERE _xb1)")
    unique = (f"ANY(_xb1 IN [(n)<-[:{C}]-(_xr1) | true] WHERE _xb1) AND "
              f"ANY(_xb2 IN [(n)-[:{C}]->(_xr2) | true] WHERE _xb2)")
    assert _tail(graph, unique) == [2, 5, 10, 14, 18]
    assert _tail(graph, reused) == []


# ---------------------------------------------------------------------------
# Short-circuit
# ---------------------------------------------------------------------------

# ``_xr.id STARTS WITH`` raises on an integer id, so whether it runs shows
# whether a traversal was spared.
RAISES = f"ANY(_xb9 IN [(n)<-[:{C}]-(_xr9) | _xr9.id STARTS WITH 'x'] WHERE _xb9)"


def test_a_comprehension_is_built_for_every_row_that_reaches_it(graph):
    """A false conjunct beside it does not spare it: why cheap conditions
    filter in the head, before the projection."""
    with pytest.raises(Exception):
        _tail(graph, f"n.displayName = 'nobody' AND {RAISES}")


def test_a_false_head_spares_the_tail(graph):
    assert _tail(graph, RAISES, head="MATCH (n) WHERE n.displayName = 'nobody'") == []


def test_each_stage_spares_the_next(graph):
    """Top-level relationships run as successive stages, so one that fails
    a row spares every traversal after it."""
    rows = graph.query(
        "MATCH (n) WITH n, ANY(_xt IN [0] WHERE n.displayName = 'nobody') AS _xt0 WHERE _xt0 "
        f"WITH n, ANY(_xt IN [0] WHERE {RAISES}) AS _xt1 WHERE _xt1 WITH n RETURN n.id").result_set
    assert rows == []


def test_simple_tests_filter_inside_the_comprehension(graph):
    """A related entity's simple tests (typed, text, label, urn, key names)
    sit in the comprehension's WHERE, which spares its projection."""
    b = _Binder()
    pk = compile_comparison("_xr1.`description`", resolve_comparison("eq", "pk"), b)
    assert _tail(graph, (f"ANY(_xb1 IN [(n)-[:{C}]->(_xr1) WHERE ID(_xr1) <> ID(n) AND {pk} "
                         "| true] WHERE _xb1)"), b.params) == [14]
    assert _tail(graph, (f"ANY(_xb1 IN [(n)<-[:{L}]-(_xr1) WHERE ID(_xr1) <> ID(n) AND "
                         "ANY(_k IN keys(_xr1) WHERE toLower(_k) STARTS WITH 'own') AND "
                         "toLower(labels(_xr1)[0]) IN ['dataset'] | true] WHERE _xb1)")) == [11, 12]
    assert _tail(graph, (f"ANY(_xb1 IN [(n)<-[:{C}]-(_xr1) WHERE _xr1.displayName = 'nobody' "
                         "| _xr1.id STARTS WITH 'x'] WHERE _xb1)")) == []


def test_a_bare_projection_does_not_short_circuit(graph):
    with pytest.raises(Exception):
        graph.query(f"MATCH (n) WITH n, (n.displayName = 'nobody' AND ANY(_xb1 IN "
                    f"[(n)<-[:{C}]-(_xr1) | _xr1.id STARTS WITH 'x'] WHERE _xb1)) AS m "
                    "WHERE m RETURN n.id")


def test_a_wrapped_element_test_short_circuits(graph):
    """The related entity's test is wrapped too, so its own AND stops early."""
    assert _tail(graph, (f"ANY(_xb1 IN [(n)<-[:{C}]-(_xr1) | ANY(_xz1 IN [0] WHERE "
                         "_xr1.displayName = 'nobody' AND _xr1.id STARTS WITH 'x')] "
                         "WHERE _xb1)")) == []


# ---------------------------------------------------------------------------
# Axes
# ---------------------------------------------------------------------------

def test_ancestor_within_a_depth_range(graph):
    expr = (f"ANY(_xb1 IN [(n)<-[:{C}*1..12]-(_xr1) WHERE ID(_xr1) <> ID(n) "
            "| _xr1.displayName = 'Country'] WHERE _xb1)")
    assert _tail(graph, expr) == [2, 3, 4, 5, 6]
    two_up = expr.replace("*1..12", "*2..2")
    assert _tail(graph, two_up) == [3, 4, 6]


def test_root_is_an_ancestor_without_a_parent(graph):
    expr = (f"ANY(_xb1 IN [(n)<-[:{C}*1..12]-(_xr1) WHERE ID(_xr1) <> ID(n) "
            f"| size([(_xr1)<-[:{C}]-(_xz1) | 1]) = 0 AND _xr1.displayName = '{{name}}'] "
            "WHERE _xb1)")
    assert _tail(graph, expr.format(name="Country")) == [2, 3, 4, 5, 6]
    # The multi-parent "shared" has two roots; either one matches.
    assert 21 in _tail(graph, expr.format(name="Finance"))
    assert 21 in _tail(graph, expr.format(name="Sales"))
    # A top-level entity has no root.
    assert 1 not in _tail(graph, expr.format(name="Country"))


def test_child_and_descendant(graph):
    child = (f"ANY(_xb1 IN [(n)-[:{C}]->(_xr1) WHERE ID(_xr1) <> ID(n) "
             "| labels(_xr1)[0] = 'column'] WHERE _xb1)")
    assert _tail(graph, child) == [14, 18]
    descendant = child.replace(f"[:{C}]", f"[:{C}*1..3]")
    assert _tail(graph, descendant) == [13, 14, 18]


def test_upstream_downstream_and_either_direction(graph):
    down = (f"ANY(_xb1 IN [(n)-[:{L}*1..3]->(_xr1) WHERE ID(_xr1) <> ID(n) "
            "| labels(_xr1)[0] = 'dashboard'] WHERE _xb1)")
    assert _tail(graph, down) == [14, 18, 22]
    up = (f"ANY(_xb1 IN [(n)<-[:{L}]-(_xr1) WHERE ID(_xr1) <> ID(n) "
          "| labels(_xr1)[0] = 'topic'] WHERE _xb1)")
    assert _tail(graph, up) == [14]
    either = (f"ANY(_xb1 IN [(n)-[:{L}]-(_xr1) WHERE ID(_xr1) <> ID(n) "
              "| _xr1.displayName = 'orders'] WHERE _xb1)")
    assert _tail(graph, either) == [11, 12, 18, 22]


def test_a_cycle_never_relates_an_entity_to_itself(graph):
    expr = (f"ANY(_xb1 IN [(n)-[:{L}*1..3]->(_xr1) WHERE ID(_xr1) <> ID(n) "
            "| _xr1.displayName = 'a'] WHERE _xb1)")
    assert _tail(graph, expr) == [24, 25]


def test_rollup_edges_stay_out_unless_named(graph):
    expr = (f"ANY(_xb1 IN [(n)-[:{L}]->(_xr1) WHERE ID(_xr1) <> ID(n) "
            "| labels(_xr1)[0] = 'workspace'] WHERE _xb1)")
    assert _tail(graph, expr) == []
    assert _tail(graph, expr.replace(L, "AGGREGATED")) == [13]


# ---------------------------------------------------------------------------
# Quantifiers and counts
# ---------------------------------------------------------------------------

def test_none_all_and_count(graph):
    b = _Binder()
    described = compile_comparison("_xr1.`description`",
                                   resolve_comparison("isNotEmpty", None), b)
    pattern = f"(n)-[:{C}]->(_xr1) WHERE ID(_xr1) <> ID(n)"
    every = (f"[_xl1 IN [[{pattern} | ANY(_xz1 IN [0] WHERE {described})]] "
             "| size(_xl1) > 0 AND ALL(_xb1 IN _xl1 WHERE _xb1)][0]")
    assert _tail(graph, every, b.params) == [18]
    none = f"NOT ANY(_xb1 IN [{pattern} | ANY(_xz1 IN [0] WHERE {described})] WHERE _xb1)"
    # Everything but the two datasets with a described column: childless
    # entities, and parents whose children carry no description at all.
    assert set(_tail(graph, none, b.params)) == {i for i, *_ in NODES} - {14, 18}
    count = (f"size(reduce(_xa1 = [], _xi1 IN [{pattern} | CASE WHEN ANY(_xz1 IN [0] "
             f"WHERE {described}) THEN ID(_xr1) END] | CASE WHEN _xi1 IS NULL OR _xi1 IN _xa1 "
             "THEN _xa1 ELSE _xa1 + [_xi1] END)) >= 2")
    assert _tail(graph, count, b.params) == [14, 18]


def test_counts_are_of_distinct_entities(graph):
    """The diamond reaches d4 by two routes; it counts once."""
    expr = (f"size(reduce(_xa1 = [], _xi1 IN [(n)-[:{L}*1..2]->(_xr1) WHERE ID(_xr1) <> ID(n) "
            "| ID(_xr1)] | CASE WHEN _xi1 IS NULL OR _xi1 IN _xa1 THEN _xa1 "
            "ELSE _xa1 + [_xi1] END)) = 3")
    assert _tail(graph, expr) == [18, 22, 26]


def test_a_top_level_count_as_an_aggregation(graph):
    rows = graph.query(
        f"MATCH (n:dataset) OPTIONAL MATCH (n)-[:{L}]->(_xr) WITH n, count(DISTINCT _xr) AS _xc "
        "WHERE _xc = 0 RETURN n.id").result_set
    assert sorted(r[0] for r in rows) == [21, 29]


# ---------------------------------------------------------------------------
# Nesting
# ---------------------------------------------------------------------------

def test_nesting_anchors_on_the_pattern_variable(graph):
    """Feeds something whose parent's parent is Finance — three levels."""
    expr = (f"ANY(_xb1 IN [(n)-[:{L}]->(_xr1) WHERE ID(_xr1) <> ID(n) | "
            f"ANY(_xz1 IN [0] WHERE ANY(_xb2 IN [(_xr1)<-[:{C}]-(_xr2) WHERE ID(_xr2) <> ID(_xr1) | "
            f"ANY(_xz2 IN [0] WHERE ANY(_xb3 IN [(_xr2)<-[:{C}]-(_xr3) WHERE ID(_xr3) <> ID(_xr2) | "
            "_xr3.displayName = 'Finance'] WHERE _xb3))] WHERE _xb2))] WHERE _xb1)")
    assert _tail(graph, expr) == [14]


def test_nested_quantifier(graph):
    """Fed by something every one of whose children is described."""
    b = _Binder()
    described = compile_comparison("_xr2.`description`",
                                   resolve_comparison("isNotEmpty", None), b)
    expr = (f"ANY(_xb1 IN [(n)<-[:{L}]-(_xr1) WHERE ID(_xr1) <> ID(n) | "
            f"[_xl2 IN [[(_xr1)-[:{C}]->(_xr2) WHERE ID(_xr2) <> ID(_xr1) | "
            f"ANY(_xz2 IN [0] WHERE {described})]] | size(_xl2) > 0 AND "
            "ALL(_xb2 IN _xl2 WHERE _xb2)][0]] WHERE _xb1)")
    assert _tail(graph, expr, b.params) == [14]


def test_degree_inside_a_relationship_is_a_comprehension(graph):
    """Fed by something nothing feeds."""
    expr = (f"ANY(_xb1 IN [(n)<-[:{L}]-(_xr1) WHERE ID(_xr1) <> ID(n) "
            f"| size([(_xr1)<-[:{L}]-(_xd1) | 1]) = 0] WHERE _xb1)")
    assert _tail(graph, expr) == [14, 27, 28]


@pytest.mark.xfail(strict=True, reason="unscoped variable: the nested pattern ignores _xq1")
def test_nesting_on_the_element_variable_matches_wrong_rows(graph):
    expr = (f"ANY(_xq1 IN [(n)-[:{L}]->(_xr1) WHERE ID(_xr1) <> ID(n) | _xr1] WHERE "
            f"ANY(_xq2 IN [(_xq1)<-[:{C}]-(_xr2) | _xr2] WHERE _xq2.displayName = 'Reports'))")
    assert _tail(graph, expr) == [14]


@pytest.mark.xfail(strict=True, reason="Unable to resolve filtered alias")
def test_a_nested_comprehension_in_a_comprehension_where_fails(graph):
    _tail(graph, (f"ANY(_xb1 IN [(n)<-[:{C}*1..12]-(_xr1) WHERE ID(_xr1) <> ID(n) AND "
                  f"size([(_xr1)<-[:{C}]-(_xz1) | 1]) = 0 | _xr1.displayName = 'Country'] "
                  "WHERE _xb1)"))


@pytest.mark.xfail(strict=True, reason="type mismatch: a pattern predicate in a projection")
def test_a_pattern_predicate_in_a_projection_fails(graph):
    graph.query(f"MATCH (n) RETURN n.id, ANY(_mz IN [0] WHERE (n)<-[:{C}]-())")


@pytest.mark.xfail(strict=True, reason="size(pattern) on a comprehension variable reads the wrong node")
def test_size_of_a_pattern_on_a_pattern_variable_is_wrong(graph):
    expr = (f"ANY(_xb1 IN [(n)<-[:{C}*1..12]-(_xr1) WHERE ID(_xr1) <> ID(n) "
            f"| size((_xr1)<-[:{C}]-()) = 0 AND _xr1.displayName = 'Country'] WHERE _xb1)")
    assert _tail(graph, expr) == [2, 3, 4, 5, 6]


# ---------------------------------------------------------------------------
# Edges walked
# ---------------------------------------------------------------------------

def test_typed_edge_and_entity_comparisons_together(graph):
    b = _Binder()
    edge = compile_comparison("_xe1.`confidence`",
                              resolve_comparison("gte", 0.8, value_type="number"), b)
    owner = compile_comparison("_xr1.`owner`", resolve_comparison("eq", "ALICE"), b)
    expr = (f"ANY(_xb1 IN [_xp1 = (n)-[:{L}*1..2]->(_xr1) WHERE ID(_xr1) <> ID(n) AND "
            f"ALL(_xe1 IN relationships(_xp1) WHERE {edge}) | ANY(_xz1 IN [0] WHERE {owner})] "
            "WHERE _xb1)")
    assert _tail(graph, expr, b.params) == [22]


def test_edge_keys_held_in_json_text(graph):
    """Key presence and scalar equality against ``json.dumps`` text."""

    def edge(test):
        return _tail(graph, (f"ANY(_xb1 IN [_xp1 = (n)-[:{L}|AGGREGATED]->(_xr1) WHERE "
                             f"ALL(_xe1 IN relationships(_xp1) WHERE {test}) | true] WHERE _xb1)"))

    raw = "coalesce(_xe1.properties, '')"
    assert edge(f"{raw} CONTAINS '\"job\": '") == [22]
    assert edge(f"({raw} CONTAINS '\"transform\": \"join\",' OR "
                f"{raw} ENDS WITH '\"transform\": \"join\"}}')") == [14]
    # Ignoring case lowers the stored text and the needle alike.
    assert edge(f"(toLower({raw}) CONTAINS '\"mode\": \"stream\",' OR "
                f"toLower({raw}) ENDS WITH '\"mode\": \"stream\"}}')") == [22]
