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
# source, target, type, confidence (None: unset)
LINEAGE = [
    (22, 14, "TRANSFORMS", 0.9), (14, 11, "FLOWS_TO", 0.95), (18, 14, "FLOWS_TO", 0.5),
    (14, 12, "FLOWS_TO", 0.8),
    (23, 24, "FLOWS_TO", 0.9), (24, 25, "FLOWS_TO", 0.9), (25, 23, "FLOWS_TO", 0.9),
    (26, 27, "FLOWS_TO", 0.9), (26, 28, "FLOWS_TO", 0.7),
    (27, 29, "FLOWS_TO", 0.9), (28, 29, "FLOWS_TO", 0.9),
    (13, 9, "AGGREGATED", None),
    (18, 21, "TRANSFORMS", 0.6), (21, 18, "FLOWS_TO", 0.6),    # both ways at once
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
    for s, t, kind, conf in LINEAGE:
        await p._graph.query(
            f"MATCH (a {{urn: $s}}), (b {{urn: $t}}) CREATE (a)-[r:{kind}]->(b) "
            "SET r.confidence = $c", {"s": U(s), "t": U(t), "c": conf})
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
                   **({"confidence": c} if c is not None else {})}
                  for a, b, t, c in LINEAGE]),
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
