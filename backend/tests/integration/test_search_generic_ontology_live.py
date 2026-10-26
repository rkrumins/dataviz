"""LIVE FalkorDB: a generic ontology — Category HAS Entity HAS Entity, N
levels deep, and one lineage edge that links any entity to any other.

Many data sources model nothing more specific than that: a single
containment edge (``HAS``) nesting entities as deep as they go, and a
generic lineage edge (``LINEAGE``, ``FLOWS_TO``) between any two of them,
at any level. Which edge types are containment and which lineage comes
from the data source's ontology, so every relationship applies as it does
on a richer one: here, a 5-level and an 8-level chain under two categories,
leaves at every depth, lineage from leaves and from containers, into the
same layer and into another — the view placing each category, and what it
holds, in a layer of its own.

The questions such a graph is asked — every leaf; what sits exactly N
levels down; the leaves with a direct ``LINEAGE`` edge into another layer;
the categories one of whose leaves feeds the other layer — must match, in
the uncapped engine (search and count), the capped one and a rule's
membership, exactly what the reference semantics answer, and the key ones
what they plainly should.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_generic_ontology_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import SearchQuery, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live generic-ontology test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

HAS = "HAS"
LINEAGE_TYPES = ["LINEAGE", "FLOWS_TO"]


def _chain(prefix: str, depth: int) -> list[tuple[str, str]]:
    """``prefix``1, ``prefix``1.1, … ``depth`` levels down: (child, parent)."""
    out, parent, name = [], prefix, prefix
    for _ in range(depth):
        name = f"{name}.1" if name != prefix else f"{prefix}1"
        out.append((name, parent))
        parent = name
    return out


# Category "F" holds a chain 5 deep, with a leaf branching off at levels 2
# and 3; category "S" a chain 8 deep, with a leaf at level 2. "loose" is an
# entity no category holds, with no edges at all.
NESTING = [
    *_chain("F", 5), ("F1.2", "F1"), ("F1.1.2", "F1.1"),
    *_chain("S", 8), ("S1.2", "S1"),
]
CATEGORIES = ["F", "S"]
ENTITIES = [child for child, _ in NESTING] + ["loose"]
F5 = "F1.1.1.1.1"
S5 = "S1.1.1.1.1"
S8 = "S1.1.1.1.1.1.1.1"

# Lineage between entities at any level, into the same layer and the other.
EDGES = [
    (F5, "S1.2", "LINEAGE"),          # a leaf, straight into the other layer
    ("F1.2", "F1.1.2", "LINEAGE"),    # a leaf into a leaf of its own layer…
    ("F1.1.2", "S1.1", "FLOWS_TO"),   # …which flows on into the other one
    (S8, "F1", "LINEAGE"),            # the deepest leaf, back into a container
    ("F1.1", "S1.1.1", "LINEAGE"),    # a container, into the other layer
    ("S1.2", S5, "LINEAGE"),          # within one layer
]


def U(name: str) -> str:
    return f"urn:generic:{name}"


def rel(axis, where=None, **kw):
    p = {"kind": "related", "axis": axis, **kw}
    if where is not None:
        p["where"] = where
    return p


def AND(*c):
    return {"kind": "group", "op": "and", "children": list(c)}


def NOT(c):
    return {"kind": "group", "op": "not", "children": [c]}


def TYPE(*t):
    return {"kind": "entityType", "values": list(t)}


def NAMED(name):
    return {"kind": "text", "target": "name", "value": name, "match": "exact"}


def LAYER(value):
    return {"kind": "layer", "layerAssignment": value}


LEAF = rel("child", quantifier="none")
LEAF_SHAPE = {"kind": "isLeaf", "edgeClass": "containment"}

#: Each category, and all it holds, in a layer of its own.
VIEW = {"content": {"entityScope": "all"}, "layout": {"referenceLayout": {"layers": [
    {"id": "fin", "name": "Finance", "order": 0},
    {"id": "sales", "name": "Sales", "order": 1},
    {"id": "rest", "name": "Everything else", "order": 2, "showUnassigned": True},
], "assignments": {U("F"): {"layerId": "fin", "inheritsChildren": True},
                   U("S"): {"layerId": "sales", "inheritsChildren": True}}}}}

#: (question, predicate, what it plainly answers — or None, the reference's word alone)
CASES = [
    ("every leaf", LEAF, ["F1.2", "F1.1.2", F5, "S1.2", S8, "loose"]),
    ("every leaf, as a graph shape", LEAF_SHAPE, ["F1.2", "F1.1.2", F5, "S1.2", S8, "loose"]),
    ("exactly 5 levels below a category", rel("ancestor", TYPE("Category"), minHops=5, maxHops=5),
     [F5, S5]),
    ("8 levels down, past the default reach of anything shallower",
     rel("ancestor", TYPE("Category"), minHops=8, maxHops=8), [S8]),
    ("held by F, at any depth", rel("ancestor", NAMED("F")),
     ["F1", "F1.1", "F1.1.1", "F1.1.1.1", F5, "F1.2", "F1.1.2"]),
    ("its top-level category is S", rel("root", NAMED("S")),
     [n for n in ENTITIES if n.startswith("S")]),
    # S1.2, a Sales leaf, feeds S1.1.1.1.1 — into the Sales layer too.
    ("leaves with a direct LINEAGE edge into the Sales layer",
     AND(LEAF, rel("downstream", LAYER("Sales"), edgeTypes=["LINEAGE"], maxHops=1)), [F5, "S1.2"]),
    ("Finance leaves with a direct LINEAGE edge into the Sales layer",
     AND(LAYER("Finance"), LEAF, rel("downstream", LAYER("Sales"), edgeTypes=["LINEAGE"], maxHops=1)),
     [F5]),
    ("leaves with any direct lineage into the Sales layer",
     AND(LEAF, rel("downstream", LAYER("Sales"), maxHops=1)), [F5, "F1.1.2", "S1.2"]),
    ("Finance leaves with direct lineage into another layer",
     AND(LAYER("Finance"), LEAF, rel("downstream", NOT(LAYER("Finance")), maxHops=1)),
     [F5, "F1.1.2"]),
    ("leaves feeding a leaf of the other layer directly",
     AND(LEAF, rel("ancestor", NAMED("F")), rel("downstream", AND(LEAF, LAYER("Sales")), maxHops=1)),
     [F5]),
    ("categories one of whose leaves feeds the Sales layer directly",
     AND(TYPE("Category"), rel("descendant", AND(LEAF, rel("downstream", LAYER("Sales"), maxHops=1)))),
     ["F", "S"]),
    ("Sales categories one of whose leaves feeds out of Sales directly",
     AND(LAYER("Sales"), TYPE("Category"),
         rel("descendant", AND(LEAF, rel("downstream", NOT(LAYER("Sales")), maxHops=1)))),
     ["S"]),
    ("what Finance leaves feed, two hops out", rel("upstream", AND(LEAF, LAYER("Finance")), maxHops=2),
     None),
    ("containers fed straight from another layer",
     AND(rel("child"), rel("upstream", NOT(LAYER("Finance")), maxHops=1), LAYER("Finance")), ["F1"]),
    ("categories holding more than 5 entities", AND(TYPE("Category"), rel("descendant", count={"op": "gt", "value": 5})),
     ["F", "S"]),
    ("entities neither held nor linked", AND(NOT(rel("parent")), {"kind": "isOrphan", "edgeClass": "links"},
                                             TYPE("Entity")), ["loose"]),
    ("a leaf whose container is fed from elsewhere", AND(LEAF, rel("ancestor", rel("upstream"))), None),
]

SCOPES = {
    "data_source": SearchScope(view_id="v", scope_mode="data_source"),
    "view": SearchScope(view_id="v", scope_mode="view", root_urns=[U("F"), U("S")]),
}


def _query(predicate, scope):
    """The query as the service hands it to an engine, its layers read
    against the view's placement (``_with_resolved_layers``)."""
    from backend.app.services.advanced_search_service import _with_resolved_layers
    from backend.app.services.view_scope import EffectiveViewScope, _placement_inputs

    placement, layers, digest = _placement_inputs(VIEW)
    eff = EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="reference",
        root_urns=(), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
        max_depth=12, scope_hash="h", placement=placement, layers=layers,
        placement_digest=digest)
    query = SearchQuery.model_validate({
        "predicate": predicate, "scope": scope.model_dump(by_alias=True),
        "options": {"results": "hits", "pageSize": 200}})
    return query.model_copy(update={"predicate": _with_resolved_layers(query.predicate, eff, [])})


ALL_URNS = [U(n) for n in CATEGORIES + ENTITIES]


def _stub() -> StubDeepSearchProvider:
    return StubDeepSearchProvider(
        nodes=([{"urn": U(n), "entityType": "Category", "displayName": n, "qualifiedName": n}
                for n in CATEGORIES]
               + [{"urn": U(n), "entityType": "Entity", "displayName": n, "qualifiedName": n}
                  for n in ENTITIES]),
        edges=([{"source": U(parent), "target": U(child), "type": HAS} for child, parent in NESTING]
               + [{"source": U(a), "target": U(b), "type": t} for a, b, t in EDGES]),
        containment_edge_types=[HAS],
        lineage_edge_types=LINEAGE_TYPES)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"generic_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    # As the data source's ontology declares them.
    p.set_containment_edge_types([HAS], from_ontology=True)
    p.set_resolved_edge_metadata({t: {"isLineage": True} for t in LINEAGE_TYPES}, LINEAGE_TYPES)
    await p._ensure_connected()
    for label in ("Category", "Entity"):
        await p._graph.query(f"CREATE INDEX FOR (n:`{label}`) ON (n.urn)")
    for label, names in (("Category", CATEGORIES), ("Entity", ENTITIES)):
        for name in names:
            await p._graph.query(
                f"CREATE (:`{label}` {{urn: $urn, displayName: $name, qualifiedName: $name}})",
                {"urn": U(name), "name": name})
    for child, parent in NESTING:
        await p._graph.query(f"MATCH (a {{urn: $p}}), (b {{urn: $c}}) CREATE (a)-[:{HAS}]->(b)",
                             {"p": U(parent), "c": U(child)})
    for a, b, kind in EDGES:
        await p._graph.query(f"MATCH (a {{urn: $a}}), (b {{urn: $b}}) CREATE (a)-[:{kind}]->(b)",
                             {"a": U(a), "b": U(b)})
    try:
        yield p
    finally:
        await p._graph.delete()


async def _reference(scope, predicate) -> list[str]:
    answer = await _stub().deep_search_membership(scope, [("q", _query(predicate, scope).predicate)], ALL_URNS)
    assert not answer["errors"], answer["errors"]
    return sorted(answer["matches"]["q"])


async def test_the_questions_answer_what_they_plainly_should():
    """The reference semantics themselves, on this graph: the expected
    answers are the ones a person reading the graph would give."""
    scope = SCOPES["data_source"]
    wrong = []
    for question, predicate, plainly in CASES:
        if plainly is None:
            continue
        got = await _reference(scope, predicate)
        if got != sorted(U(n) for n in plainly):
            wrong.append((question, got, sorted(U(n) for n in plainly)))
    assert not wrong, "\n".join(f"{q}\n   got  {g}\n   want {w}" for q, g, w in wrong)


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_every_engine_answers_as_the_reference(provider, scope_name):
    scope = SCOPES[scope_name]
    context = SearchRunContext(data_version="generic-v1", scope_hash=f"h-generic-{scope_name}")
    wrong = []
    for question, predicate, _ in CASES:
        query = _query(predicate, scope)
        want = await _reference(scope, predicate)
        page = await provider.deep_search_session(query, context=context)
        count = await provider.deep_search_count(query, context=context)
        capped = await provider.deep_search(query)
        member = await provider.deep_search_membership(
            scope, [("q", query.predicate)], ALL_URNS, context=SearchRunContext())
        got = (sorted(h.node.urn for h in page.hits), count["count"],
               sorted(h.node.urn for h in capped.hits), sorted(member["matches"].get("q", [])))
        if got != (want, len(want), want, want) or member["errors"]:
            wrong.append((question, got, member["errors"], want))
    assert not wrong, "\n".join(
        f"{q}\n   got (uncapped, count, capped, membership) {g} {e}\n   want {w}" for q, g, e, w in wrong)
