"""LIVE FalkorDB: every engine answers a relationship as the reference
semantics do.

``StubDeepSearchProvider._relation_holds`` is what a relationship means: the
relatives along an axis (one containment step, a range of them, the
top-level container, lineage trails of a range of hops through edges that
pass a filter), never the entity itself, quantified (any, none, every one,
how many distinct). FalkorDB gets there with pattern comprehensions placed
where the engine evaluates them correctly (S0_FINDINGS §15), in a tail after
each statement's head, or walked from the named entities when a relationship
names its far end. Here, on a graph with a cycle, a diamond, a multi-parent
entity, duplicate names and a rollup edge, a matrix of relationships — every
axis, quantifier and count, alone, beside other conditions, under OR and
NOT, nested three deep — must match exactly the same entities in the
uncapped engine, the capped one, a rule's count and a rule's membership.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_relations_live.py -q
"""
from __future__ import annotations

import itertools
import json
import os
import uuid

import pytest
import pytest_asyncio

from backend.app.services.advanced_search_service import ValidationError, _validate_predicate
from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import SearchQuery, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live relations test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

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
]
# parent -> child. "shared" (21) has two parents.
CONTAINMENT = [
    (1, 2), (2, 3), (2, 4), (1, 5), (5, 6), (7, 8), (9, 10), (10, 11), (10, 12),
    (13, 14), (14, 15), (14, 16), (14, 17), (13, 18), (18, 19), (18, 20),
    (13, 21), (9, 21), (13, 22), (13, 23), (13, 24), (13, 25),
    (13, 26), (13, 27), (13, 28), (13, 29),
]
# source, target, type, confidence (None: unset), a user's properties (kept
# as the edge's JSON; None: none at all)
LINEAGE = [
    (22, 14, "TRANSFORMS", 0.9, {"mode": "stream", "job": "j1"}),
    (14, 11, "FLOWS_TO", 0.95, {"transform": "join", "rows": 5}),
    (18, 14, "FLOWS_TO", 0.5, {"transform": "Copy", "rows": 5.0}),
    # Text that only looks like the key: inside a string, its quotes are
    # escaped. (A nested object's key would be found — the known false
    # positive, ``edge_properties``.)
    (14, 12, "FLOWS_TO", 0.8, {"note": '"transform": "join"'}),
    (23, 24, "FLOWS_TO", 0.9, {}), (24, 25, "FLOWS_TO", 0.9, {"mode": "batch"}),
    (25, 23, "FLOWS_TO", 0.9, {"mode": "stream"}),
    (26, 27, "FLOWS_TO", 0.9, {"mode": "batch"}), (26, 28, "FLOWS_TO", 0.7, {"mode": "STREAM"}),
    (27, 29, "FLOWS_TO", 0.9, {"rows": 7}), (28, 29, "FLOWS_TO", 0.9, {"ok": True}),
    (13, 9, "AGGREGATED", None, None),
    # Both ways at once.
    (18, 21, "TRANSFORMS", 0.6, {"job": "j2"}), (21, 18, "FLOWS_TO", 0.6, {}),
]
LINEAGE_TYPES = ["AGGREGATED", "FLOWS_TO", "TRANSFORMS"]


def U(i: int) -> str:
    return f"urn:{i}"


# --- the matrix ---------------------------------------------------------------

def rel(axis, where=None, **kw):
    p = {"kind": "related", "axis": axis, **kw}
    if where is not None:
        p["where"] = where
    return p


def AND(*c):
    return {"kind": "group", "op": "and", "children": list(c)}


def OR(*c):
    return {"kind": "group", "op": "or", "children": list(c)}


def NOT(c):
    return {"kind": "group", "op": "not", "children": [c]}


def TYPE(*t):
    return {"kind": "entityType", "values": list(t)}


def NAMED(name):
    return {"kind": "text", "target": "name", "value": name, "match": "exact"}


def IS(*ids):
    return {"kind": "is", "refs": [{"urn": U(i)} for i in ids]}


OWNER = {"kind": "hasProperty", "key": "owner"}
DESCRIBED = {"kind": "property", "key": "description", "op": "isNotEmpty"}
UNFED = {"kind": "degree", "direction": "in", "op": "eq", "value": 0, "edgeClass": "lineage"}
TOP = {"kind": "isRoot", "edgeClass": "containment"}
CONFIDENT = {"kind": "edgeProperty", "key": "confidence", "op": "gte", "value": 0.8,
             "valueType": "number"}


def EDGE(key, op="eq", value=None, **kw):
    """A condition on a user's edge property, kept in the edge's JSON."""
    return {"kind": "edgeProperty", "key": key, "op": op, "value": value, **kw}


NOT_BATCH = EDGE("mode", "neq", "batch", includeMissing=True)

AXES = [
    ("parent", {}), ("child", {}), ("ancestor", {}), ("ancestor", {"minHops": 2, "maxHops": 2}),
    ("descendant", {}), ("descendant", {"maxHops": 1}),
    ("descendant", {"minHops": 2, "maxHops": 3}), ("root", {}),
    ("upstream", {}), ("upstream", {"maxHops": 3}), ("downstream", {}),
    ("downstream", {"maxHops": 3}), ("downstream", {"minHops": 2, "maxHops": 3}),
    ("neighbor", {}), ("neighbor", {"maxHops": 2}),
    ("downstream", {"maxHops": 2, "edge": CONFIDENT}),
    ("upstream", {"edge": CONFIDENT}),
    ("downstream", {"edgeTypes": ["AGGREGATED"]}),
    ("downstream", {"maxHops": 2, "edge": NOT_BATCH}),
]
CONDITIONS = [
    None, TYPE("dataset"), TYPE("domain", "workspace"), NAMED("orders"), OWNER, DESCRIBED,
    UNFED, TOP, rel("parent", TYPE("domain")), rel("root", NAMED("Sales")),
    rel("upstream"), AND(TYPE("dataset"), rel("child", DESCRIBED)),
    OR(NAMED("Finance"), rel("child", TYPE("column"))),
]
QUANTIFIERS = [
    {}, {"quantifier": "none"}, {"quantifier": "all"},
    {"count": {"op": "gte", "value": 2}}, {"count": {"op": "eq", "value": 0}},
    {"count": {"op": "lt", "value": 2}}, {"count": {"op": "eq", "value": 3}},
]


def _matrix():
    cases = []
    # Every axis with every quantifier; the conditions rotate through them.
    rotation = itertools.cycle(CONDITIONS)
    for (axis, hops), quant in itertools.product(AXES, QUANTIFIERS):
        for _ in range(2):
            cases.append(rel(axis, next(rotation), **hops, **quant))
    # Placements: beside head conditions, under OR and NOT, nested.
    cases += [
        AND(TYPE("dataset"), rel("parent", NAMED("Sales"))),
        AND(TYPE("dataset", "column"), rel("upstream"), rel("downstream", TYPE("dashboard"))),
        AND(OWNER, rel("child", DESCRIBED, quantifier="all")),
        OR(TYPE("topic"), rel("upstream", TYPE("topic"))),
        OR(rel("parent", TYPE("region")), rel("child", TYPE("city"))),
        NOT(rel("parent")),
        NOT(rel("downstream", maxHops=3)),
        AND(NOT(rel("child")), TYPE("dataset")),
        NOT(OR(rel("root", NAMED("Sales")), TYPE("domain"))),
        rel("downstream", rel("parent", rel("parent", NAMED("Finance")))),
        rel("upstream", rel("child", DESCRIBED, quantifier="all")),
        rel("child", rel("upstream", rel("root", NAMED("Sales")), maxHops=2), count={"op": "gte", "value": 1}),
        rel("downstream", rel("upstream", IS(14))),
        rel("neighbor", rel("neighbor", TYPE("topic")), quantifier="none"),
        AND(UNFED, rel("downstream", UNFED, quantifier="none")),
        OR(UNFED, rel("upstream", quantifier="none")),
        rel("ancestor", rel("child", NAMED("London"), count={"op": "eq", "value": 1})),
        # Named far ends: walked from the named entities.
        rel("upstream", IS(22)), rel("upstream", IS(22), maxHops=3),
        rel("downstream", IS(29), minHops=2, maxHops=3), rel("neighbor", IS(23), maxHops=2),
        rel("downstream", IS(11, 12), maxHops=2, edge=CONFIDENT),
        rel("upstream", IS(23), maxHops=3), rel("downstream", IS(9), edgeTypes=["AGGREGATED"]),
        rel("parent", IS(13)), rel("ancestor", IS(1)), rel("ancestor", IS(1), minHops=2, maxHops=2),
        rel("root", IS(9)), rel("root", IS(13)), rel("root", IS(2)), rel("parent", IS(999)),
        AND(TYPE("dataset"), rel("upstream", IS(22), maxHops=2), rel("parent", IS(13))),
        AND(rel("ancestor", IS(13)), rel("downstream", TYPE("dashboard"))),
        # A container's lineage question: it, or anything inside it — walked
        # from everything inside it.
        rel("upstream", OR(IS(13), rel("ancestor", IS(13))), maxHops=3),
        rel("downstream", OR(IS(13), rel("ancestor", IS(13))), maxHops=3),
        rel("upstream", rel("ancestor", IS(13)), maxHops=2),
        rel("upstream", rel("ancestor", IS(9), maxHops=1)),
        rel("upstream", OR(IS(13), rel("ancestor", IS(13))), maxHops=2, edge=CONFIDENT),
        rel("downstream", OR(IS(14), rel("ancestor", IS(14)), IS(29)), minHops=2, maxHops=3),
        AND(TYPE("dashboard"), rel("upstream", OR(IS(13), rel("ancestor", IS(13))), maxHops=3)),
        AND(rel("upstream", IS(22)), rel("upstream", OR(IS(18), rel("ancestor", IS(18))))),
        # A user's edge properties, read from the edge's JSON.
        rel("downstream", edge={"kind": "edgeHasProperty", "key": "transform"}),
        rel("downstream", edge={"kind": "edgeHasProperty", "key": "transform", "negate": True}),
        rel("downstream", edge=EDGE("transform", value="copy")),
        rel("downstream", edge=EDGE("transform", value="copy", caseSensitive=True)),
        rel("downstream", edge=EDGE("rows", value=5, valueType="number")),
        rel("downstream", edge=EDGE("mode", "neq", "stream")),
        rel("downstream", edge=EDGE("mode", "neq", "stream", includeMissing=True)),
        rel("downstream", edge=EDGE("mode", "in", ["batch", "stream"])),
        rel("downstream", edge=EDGE("mode", "notIn", ["batch"], includeMissing=True)),
        rel("downstream", edge=EDGE("ok", value=True, valueType="boolean")),
        rel("downstream", edge={"kind": "edgeGroup", "op": "and", "children": [
            CONFIDENT, EDGE("mode", "isSet")]}),
        rel("upstream", edge=EDGE("job", "isNotSet"), quantifier="none"),
        rel("downstream", IS(29), maxHops=2, edge=EDGE("mode", "neq", "batch")),
        rel("upstream", IS(23), maxHops=3, edge=NOT_BATCH),
    ]
    return cases


CASES = _matrix()
SCOPES = {
    "data_source": SearchScope(view_id="v", scope_mode="data_source"),
    "view": SearchScope(view_id="v", scope_mode="view", root_urns=[U(13), U(9)]),
}


def _query(predicate, scope, **options):
    return SearchQuery.model_validate({
        "predicate": predicate, "scope": scope.model_dump(by_alias=True),
        "options": {"results": "hits", "pageSize": 200, **options}})


# --- the graph ----------------------------------------------------------------

@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"relations_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    p.set_resolved_edge_metadata({t: {"isLineage": True} for t in LINEAGE_TYPES}, LINEAGE_TYPES)
    await p._ensure_connected()
    for label in sorted({label for _, label, _, _ in NODES}):
        await p._graph.query(f"CREATE INDEX FOR (n:`{label}`) ON (n.urn)")
    for nid, label, name, props in NODES:
        await p._graph.query(
            f"CREATE (n:`{label}` {{urn: $urn, displayName: $name, qualifiedName: $name}}) "
            "SET n += $p", {"urn": U(nid), "name": name, "p": props})
    for s, t in CONTAINMENT:
        await p._graph.query("MATCH (a {urn: $s}), (b {urn: $t}) CREATE (a)-[:CONTAINS]->(b)",
                             {"s": U(s), "t": U(t)})
    for s, t, kind, conf, props in LINEAGE:
        await p._graph.query(
            f"MATCH (a {{urn: $s}}), (b {{urn: $t}}) CREATE (a)-[r:{kind}]->(b) "
            "SET r.confidence = $c, r.properties = $p",
            # As the writers keep a user's properties: ``json.dumps``.
            {"s": U(s), "t": U(t), "c": conf,
             "p": None if props is None else json.dumps(props)})
    try:
        yield p
    finally:
        await p._graph.delete()


def _stub() -> StubDeepSearchProvider:
    return StubDeepSearchProvider(
        nodes=[{"urn": U(i), "entityType": label, "displayName": name, "qualifiedName": name,
                **props} for i, label, name, props in NODES],
        edges=([{"source": U(a), "target": U(b), "type": "CONTAINS"} for a, b in CONTAINMENT]
               + [{"source": U(a), "target": U(b), "type": t,
                   **({"confidence": c} if c is not None else {}),
                   **({"properties": props} if props is not None else {})}
                  for a, b, t, c, props in LINEAGE]),
        lineage_edge_types=LINEAGE_TYPES)


ALL_URNS = [U(i) for i, *_ in NODES]


async def _expected(scope, predicates):
    stub = _stub()
    queries = [_query(p, scope) for p in predicates]
    answer = await stub.deep_search_membership(
        scope, [(str(i), q.predicate) for i, q in enumerate(queries)], ALL_URNS)
    assert not answer["errors"], answer["errors"]
    return [sorted(answer["matches"][str(i)]) for i in range(len(queries))]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def expected():
    return {name: await _expected(scope, CASES) for name, scope in SCOPES.items()}


async def test_the_matrix_is_broad(expected):
    """Over half the cases match some entities and miss others: an engine
    answering nothing, or everything, could not pass by accident."""
    answers = expected["data_source"]
    telling = [a for a in answers if 0 < len(a) < len(ALL_URNS)]
    assert len(CASES) >= 250 and len(RULE_CASES) >= 150
    assert len(telling) > 0.5 * len(answers)


def _rule_cases():
    """The cases a display rule may be: it follows lineage one hop."""
    out = []
    for i, predicate in enumerate(CASES):
        try:
            _validate_predicate(_query(predicate, SCOPES["view"]).predicate, rule=True)
        except ValidationError:
            continue
        out.append(i)
    return out


RULE_CASES = _rule_cases()


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_rule_membership(provider, expected, scope_name):
    """Every rule at once, a few dozen per statement: the comprehension names
    of one rule never collide with another's."""
    scope = SCOPES[scope_name]
    got = {}
    for start in range(0, len(RULE_CASES), 40):
        batch = RULE_CASES[start:start + 40]
        answer = await provider.deep_search_membership(
            scope, [(str(i), _query(CASES[i], scope).predicate) for i in batch], ALL_URNS,
            context=SearchRunContext())
        assert not answer["errors"], answer["errors"]
        got.update({i: sorted(answer["matches"][str(i)]) for i in batch})
    wrong = [(i, CASES[i], got[i], expected[scope_name][i]) for i in RULE_CASES
             if got[i] != expected[scope_name][i]]
    assert not wrong, _report(wrong)


async def test_a_named_lineage_walk_plans_the_scan(provider):
    """For a lineage relationship naming its far end, the uncapped engine's
    units come from one walk out from it — from everything inside a
    container too — not from the scope: the cases above answered through it."""
    from backend.app.providers.falkordb_deep_search import _build_compiler_for_provider
    from backend.app.providers.falkordb_search.plan import make_plan

    async def run(cypher, params):
        return await provider._ro_query(cypher, params=params, timeout=10)

    async def plan_for(predicate, scope):
        query = _query(predicate, scope)
        compiler = _build_compiler_for_provider(provider)
        compiler.compile(query.predicate)
        return await make_plan(provider, query, compiler, run=run, width=500,
                               walk_max=50_000, timeout_s=10)

    for predicate, scope in [
        (rel("upstream", OR(IS(13), rel("ancestor", IS(13))), maxHops=3), SCOPES["view"]),
        (rel("upstream", IS(22), maxHops=3), SCOPES["data_source"]),
    ]:
        plan = await plan_for(predicate, scope)
        assert plan.units and all(u.kind == "ids" and u.satisfies == 0 for u in plan.units)
    plan = await plan_for(rel("upstream", TYPE("topic")), SCOPES["data_source"])
    assert plan.units and not any(u.kind == "ids" for u in plan.units)


async def test_a_walk_larger_than_one_reply_finds_every_entity():
    """A container whose contents feed more entities than FalkorDB returns
    rows in one reply (the stock image's ``RESULTSET_SIZE`` is 10,000): the
    walk starts from everything inside it and finds every entity they feed,
    and the count is exact — not the first 10,000 of each."""
    from backend.app.providers.falkordb_deep_search import _build_compiler_for_provider
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.providers.falkordb_search.plan import make_plan

    n = 12_000
    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"reach_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    p.set_resolved_edge_metadata({"TRANSFORMS": {"isLineage": True}}, ["TRANSFORMS"])
    await p._ensure_connected()
    try:
        for label in ("container", "column", "dataset"):
            await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        await p._graph.query(
            "CREATE (c:container {urn: 'urn:c', displayName: 'c', qualifiedName: 'c'}) "
            "WITH c UNWIND range(1, $n) AS i "
            "CREATE (c)-[:CONTAINS]->(f:column {urn: 'urn:f:' + toString(i), "
            "displayName: 'f' + toString(i), qualifiedName: 'f' + toString(i)}) "
            "CREATE (f)-[:TRANSFORMS {properties: '{}'}]->(:dataset {urn: 'urn:t:' + toString(i), "
            "displayName: 't' + toString(i), qualifiedName: 't' + toString(i)})", {"n": n})
        is_c = {"kind": "is", "refs": [{"urn": "urn:c"}]}
        query = _query(rel("upstream", OR(is_c, rel("ancestor", is_c)), maxHops=3),
                       SCOPES["data_source"])

        async def run(cypher, params):
            return await p._ro_query(cypher, params=params, timeout=30)

        compiler = _build_compiler_for_provider(p)
        compiler.compile(query.predicate)
        plan = await make_plan(p, query, compiler, run=run, width=500, walk_max=50_000,
                               timeout_s=30)
        assert all(u.kind == "ids" for u in plan.units)
        assert sum(u.size for u in plan.units) == n

        context = SearchRunContext(data_version="reach-v1", scope_hash="h-reach")
        session, answer = None, None
        for _ in range(50):
            answer = await p.deep_search_count(query.model_copy(update={
                "options": query.options.model_copy(update={"wait_ms": 1000, "session_id": session})}),
                context=context)
            session = answer["sessionId"]
            if answer["status"] == "complete":
                break
        assert (answer["status"], answer["count"]) == ("complete", n)
    finally:
        await p._graph.delete()
        await p.close()


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_uncapped_search_and_count(provider, expected, scope_name):
    scope = SCOPES[scope_name]
    context = SearchRunContext(data_version="relations-v1", scope_hash=f"h-{scope_name}")
    wrong = []
    for i, predicate in enumerate(CASES):
        query = _query(predicate, scope)
        page = await provider.deep_search_session(query, context=context)
        count = await provider.deep_search_count(query, context=context)
        got = sorted(h.node.urn for h in page.hits)
        want = expected[scope_name][i]
        if got != want or page.total_count != len(want) or count["count"] != len(want):
            wrong.append((i, predicate, (got, page.total_count, count["count"]), want))
    assert not wrong, _report(wrong)


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_capped_search(provider, expected, scope_name):
    scope = SCOPES[scope_name]
    wrong = []
    for i, predicate in enumerate(CASES):
        page = await provider.deep_search(_query(predicate, scope))
        got = sorted(h.node.urn for h in page.hits)
        if got != expected[scope_name][i]:
            wrong.append((i, predicate, got, expected[scope_name][i]))
    assert not wrong, _report(wrong)


def _report(wrong) -> str:
    lines = [f"{len(wrong)} case(s) differ from the reference semantics:"]
    for i, predicate, got, want in wrong[:15]:
        lines.append(f"  #{i} {predicate}\n      got  {got}\n      want {want}")
    return "\n".join(lines)


# --- paths ----------------------------------------------------------------

PATHS = [
    {"sourceUrns": [U(22)], "targetUrns": [U(11), U(12)]},
    {"sourceUrns": [U(22)], "targetWhere": TYPE("dashboard")},
    {"sourceWhere": TYPE("dataset"), "targetUrns": [U(12)]},
    {"sourceWhere": TYPE("topic"), "targetWhere": rel("parent", NAMED("Sales"))},
    {"sourceWhere": TYPE("dataset"), "targetWhere": TYPE("dataset"), "maxHops": 2},
    {"sourceUrns": [U(11)], "direction": "incoming", "targetWhere": TYPE("topic", "dataset")},
    {"sourceUrns": [U(23)], "direction": "any", "targetWhere": {"kind": "all"}},
    {"sourceUrns": [U(18)], "targetUrns": [U(18), U(14)], "maxHops": 3},
    {"sourceUrns": [U(26)], "targetUrns": [U(29)], "edgePredicate": CONFIDENT},
    {"sourceUrns": [U(26)], "targetUrns": [U(29)], "edgePredicate": EDGE("mode", value="stream")},
    {"sourceWhere": {"kind": "all"}, "targetWhere": {"kind": "all"},
     "edgePredicate": EDGE("transform", "isSet")},
    {"sourceUrns": [U(13)], "targetWhere": {"kind": "all"}, "edgeTypes": ["AGGREGATED"]},
    {"sourceUrns": [U(1)], "targetWhere": TYPE("city"), "edgeClass": "containment"},
    {"sourceWhere": TYPE("dataset"), "targetWhere": {"kind": "all"}, "maxPaths": 3},
]


def _routes(page):
    return sorted((tuple(n.urn for n in r.nodes),
                   tuple(json.dumps(e.properties, sort_keys=True) for e in r.edges))
                  for r in page.paths or [])


# --- nesting as deep as the service allows ------------------------------------

ALICE = {"kind": "property", "key": "owner", "op": "eq", "value": "alice"}

#: As deep as ``_validate_predicate`` lets a query nest. FalkorDB's parser reads
#: an operand with no operator after it twice (``parse_cost``), and these once
#: took it up to seconds per statement just to parse — a time no timeout bounds.
DEEP = [
    NOT(NOT(NOT(NOT(NOT(ALICE))))),
    rel("downstream", rel("child", rel("upstream", ALICE))),
    NOT(rel("downstream", NOT(rel("child", NOT(ALICE))))),
    OR(rel("downstream", ALICE), NOT(AND(rel("child", DESCRIBED), NOT(rel("upstream", ALICE))))),
    rel("child", rel("downstream", ALICE, quantifier="all"), count={"op": "gte", "value": 1}),
    OR(*[AND(*[OR(*[AND(OR(ALICE, DESCRIBED), OR(OWNER, ALICE))] * 2)] * 2)] * 2),
]


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_the_deepest_nesting_parses_in_linear_time(provider, scope_name):
    """Every statement each engine sends for the deepest shapes the service
    allows is one FalkorDB parses in linear time (``parse_cost``), and each
    engine answers as the reference does."""
    from backend.app.services.native_query.parse_cost import parse_cost

    scope = SCOPES[scope_name]
    context = SearchRunContext(data_version="relations-v1", scope_hash=f"h-deep-{scope_name}")
    sent, wrong = [], []
    real = provider._graph.ro_query

    async def spy(cypher, params=None, **kw):
        sent.append(cypher)
        return await real(cypher, params, **kw)

    provider._graph.ro_query = spy
    try:
        for i, predicate in enumerate(DEEP):
            query = _query(predicate, scope)
            _validate_predicate(query.predicate)        # within the service's caps
            want = (await _expected(scope, [predicate]))[0]
            page = await provider.deep_search_session(query, context=context)
            count = await provider.deep_search_count(query, context=context)
            capped = await provider.deep_search(query)
            member = await provider.deep_search_membership(
                scope, [("q", query.predicate)], ALL_URNS, context=SearchRunContext())
            got = (sorted(h.node.urn for h in page.hits), count["count"],
                   sorted(h.node.urn for h in capped.hits),
                   sorted(member["matches"].get("q", [])))
            if got != (want, len(want), want, want) or member["errors"]:
                wrong.append((i, predicate, (got, member["errors"]), want))
    finally:
        provider._graph.ro_query = real
    assert not wrong, _report(wrong)
    assert max(parse_cost(q) for q in sent) < 200_000


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_paths(provider, scope_name):
    """Every route, its edges' properties included — or, cut at maxPaths,
    that many of them, each a route the reference finds."""
    scope = SCOPES[scope_name]
    stub = _stub()
    wrong = []
    for i, raw in enumerate(PATHS):
        query = _query(AND({"kind": "path", **raw}), scope, results="paths")
        got = await provider.deep_search(query)
        whole = query.model_copy(update={"predicate": query.predicate.model_copy(update={
            "children": [query.predicate.children[0].model_copy(update={"max_paths": 128})]})})
        want = await stub.deep_search(whole)
        if len(want.paths) > query.predicate.children[0].max_paths:
            ok = (got.truncated and len(got.paths) == query.predicate.children[0].max_paths
                  and set(_routes(got)) <= set(_routes(want)))
        else:
            ok = _routes(got) == _routes(want) and not got.truncated
        if not ok:
            wrong.append((i, raw, _routes(got), _routes(want)))
    assert not wrong, _report(wrong)


def test_the_paths_are_telling():
    """Most path cases find some routes on the data source: an engine
    finding none could not pass by accident."""
    import asyncio
    stub = _stub()
    found = [asyncio.run(stub.deep_search(_query(AND({"kind": "path", **raw}),
                                                 SCOPES["data_source"], results="paths")))
             for raw in PATHS]
    assert sum(1 for page in found if page.paths) >= len(PATHS) - 1
