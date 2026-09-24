"""LIVE FalkorDB parity for typed property comparisons — needs a real
FalkorDB (no Postgres).

``search_semantics.evaluate`` claims to be FalkorDB's semantics written in
Python, and ``falkordb_typed_ops.compile_comparison`` claims to compile
exactly those semantics into Cypher. This holds both claims against the
real engine: one node per awkward stored value (int64 ids, numeric and
non-numeric text, NaN text, floats that print differently, booleans,
ISO dates with offsets, Unicode that case-folds unusually, lists, nested
lists, empty values, a missing key), and for every comparison in the
matrix the ids FalkorDB returns must be exactly the ids the evaluator
picks. It also proves no stored kind can abort a comparison — a type
error would fail the query, not return a wrong row.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_semantics_live.py -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from backend.app.providers.falkordb_typed_ops import compile_comparison
from backend.common.search_semantics import evaluate, resolve_comparison


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live parity test.",
)

NOW = datetime(2024, 5, 20, 12, 0, 0, tzinfo=timezone.utc)

STORED = [
    None, "", "  ", "\t",
    "Alpha", "alpha beta", "ALPHA", "École", "ΑΣ", "İstanbul", 'say "hi" \\ ok',
    "15", "007", "1.5", "-3746471915534727923", "1e3", " 12", "12 ", "0x1A",
    "nan", "inf", "99999999999999999999", "+5", "-0", "1e-400",
    # Decimal text — FalkorDB's toFloat would read these at 32-bit
    # precision (0.100000001490116); they must compare exactly.
    "0.1", "123456789.5", "-.5", "5.", "1.2.3", "١٢", "1_000", "0.30000000000000004",
    15, 0, -1, 1.5, 15.0, 1e20, -3746471915534727923, 9007199254740993,
    2 ** 63 - 1, 0.1, -0.0,
    True, False, "true", "FALSE", "yes",
    "2024-05-01", "2024-05-01T10:00:00Z", "2024-05-01 23:59:59",
    "2024-05-01T10:00", "2024-05-02T00:00:00.123+02:00", "2023-12-31",
    "2024-5-1", "x024-05-01", "2024-05-19", "2024-05-20T11:00:00",
    [], ["a", "B"], [1, 2, 3], ["15", 20], [True, "x"],
    ["2024-05-01", "n/a"], [1.5, "École"], ["", "alpha"],
]

# Nested lists are not something the provider writes, but nothing stops
# another writer — they must not abort a comparison either.
NESTED = {"id": len(STORED), "cypher": "[[1, 'a'], 'alpha', 15]",
          "python": [[1, "a"], "alpha", 15]}

COMPARISONS = [
    # op, value, value_type, case_sensitive, include_missing
    *[(op, v, "auto", cs, False)
      for op in ("contains", "startsWith", "endsWith", "notContains")
      for v in ("a", "ALPHA", "5", "1.5", "é", "74", "-3746", "1", "true", "σ")
      for cs in (False, True)],
    ("notContains", "a", "auto", False, True),
    *[(op, v, "string", cs, False)
      for op in ("eq", "neq", "gt", "lte")
      for v in ("alpha", "ALPHA", "15", "true", "1.5", "", "2024-05-01",
                "-3746471915534727923", "école", "ασ", "istanbul")
      for cs in (False, True)],
    ("in", ["alpha", "15", "b"], "string", False, False),
    ("notIn", ["alpha", "15", "b"], "string", False, False),
    ("notIn", ["alpha"], "string", False, True),
    ("containsAll", ["a", "b"], "string", False, False),
    ("between", ["a", "b"], "string", False, False),
    ("between", ["Z", "A"], "string", True, False),
    *[(op, v, "number", False, False)
      for op in ("eq", "neq", "gt", "gte", "lt", "lte")
      for v in (15, "15", 7, 0, 1.5, -1, 1000, 12, 5, 1e20,
                "-3746471915534727923", -3746471915534727923,
                9007199254740993, 9007199254740992, 2 ** 63 - 1,
                0.1, "0.1", 123456789.5, -0.5, 0.30000000000000004, -(2 ** 63))],
    ("between", [1, 20], "number", False, False),
    ("between", [20, 1], "number", False, False),
    ("between", ["-1e30", "1e30"], "number", False, False),
    ("in", [15, 1.5, 7], "number", False, False),
    ("notIn", [15], "number", False, False),
    ("notIn", [15], "number", False, True),
    ("containsAll", [1, 2], "number", False, False),
    ("containsAll", [15, 20], "number", False, False),
    *[(op, v, "boolean", False, False)
      for op in ("eq", "neq") for v in (True, False, "true")],
    ("in", [True], "boolean", False, False),
    *[(op, v, "date", False, False)
      for op in ("eq", "neq", "gt", "gte", "lt", "lte")
      for v in ("2024-05-01", "2024-05-01T10:00:00", "2024-05-01T10:00:00+02:00",
                "2023-12-31", "2024-05-02")],
    ("between", ["2024-05-01", "2024-05-01T12:00:00"], "date", False, False),
    ("between", ["2024-05-02", "2024-04-01"], "date", False, False),
    ("withinLast", "P30D", "auto", False, False),
    ("withinLast", "P1D", "auto", False, False),
    ("withinLast", "PT2H", "auto", False, False),
    ("withinLast", "P1Y", "auto", False, False),
    *[(op, None, "auto", False, False)
      for op in ("isSet", "isNotSet", "isEmpty", "isNotEmpty")],
    # auto — the value decides the type
    ("eq", "15", "auto", False, False),
    ("eq", 15, "auto", False, False),
    ("eq", True, "auto", False, False),
    ("gt", "10", "auto", False, False),
    ("gt", "2024-04-30", "auto", False, False),
    ("gt", "m", "auto", False, False),
    ("in", ["alpha", 15], "auto", False, False),
    ("in", [15, 1.5], "auto", False, False),
    ("between", ["1", "16"], "auto", False, False),
]


@pytest.fixture(scope="module")
def graph():
    from falkordb import FalkorDB

    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                  port=int(os.getenv("FALKORDB_PORT", "6379")))
    g = db.select_graph(f"semantics_{uuid.uuid4().hex[:8]}")
    rows = [{"id": i, "p": v} for i, v in enumerate(STORED)]
    # SET n.p = null leaves the key missing, which is what None means.
    g.query("UNWIND $rows AS r CREATE (n:T {id: r.id}) SET n.p = r.p",
            {"rows": rows})
    g.query(f"CREATE (:T {{id: {NESTED['id']}, p: {NESTED['cypher']}}})")
    try:
        yield g
    finally:
        g.delete()


def _stored_values():
    return [*STORED, NESTED["python"]]


def test_values_round_trip(graph):
    """The evaluator reads exactly what FalkorDB stored — otherwise every
    parity check below would compare two different graphs."""
    got = dict(graph.query("MATCH (n:T) RETURN n.id, n.p").result_set)
    for i, v in enumerate(_stored_values()):
        if isinstance(v, float) and v != v:  # pragma: no cover - no NaN seeded
            continue
        assert got[i] == v, (i, v, got[i])


@pytest.mark.parametrize(
    "op,value,value_type,case_sensitive,include_missing", COMPARISONS,
    ids=[f"{c[0]}-{c[2]}-{c[1]!r}-cs{int(c[3])}-im{int(c[4])}" for c in COMPARISONS],
)
def test_compiled_cypher_matches_the_evaluator(
    graph, op, value, value_type, case_sensitive, include_missing,
):
    cmp = resolve_comparison(
        op, value, value_type=value_type, case_sensitive=case_sensitive,
        include_missing=include_missing, now=NOW,
    )
    params = {}

    def bind(v):
        name = f"p{len(params)}"
        params[name] = v
        return f"${name}"

    where = compile_comparison("n.p", cmp, bind)
    got = sorted(r[0] for r in graph.query(
        f"MATCH (n:T) WHERE {where} RETURN n.id", params).result_set)
    want = sorted(i for i, v in enumerate(_stored_values()) if evaluate(v, cmp))
    assert got == want, {
        "cypher_only": [(_stored_values()[i]) for i in set(got) - set(want)],
        "python_only": [(_stored_values()[i]) for i in set(want) - set(got)],
        "where": where,
    }


@pytest.mark.parametrize(
    "op,value,value_type,case_sensitive,include_missing", COMPARISONS,
    ids=[f"{c[0]}-{c[2]}-{c[1]!r}-cs{int(c[3])}-im{int(c[4])}" for c in COMPARISONS],
)
def test_a_projection_evaluates_every_branch_safely(
    graph, op, value, value_type, case_sensitive, include_missing,
):
    """In a WHERE, FalkorDB short-circuits AND / OR — the fast path relies on
    it for speed. In a RETURN it evaluates every branch, which is how rule
    membership and rule counts use these fragments; nothing in any branch may
    raise on any stored kind, and the answer must be the WHERE's."""
    cmp = resolve_comparison(
        op, value, value_type=value_type, case_sensitive=case_sensitive,
        include_missing=include_missing, now=NOW,
    )
    params = {}

    def bind(v):
        name = f"p{len(params)}"
        params[name] = v
        return f"${name}"

    fragment = compile_comparison("n.p", cmp, bind)
    projected = {r[0] for r in graph.query(
        f"MATCH (n:T) RETURN n.id, ({fragment}) AS m", params).result_set if r[1] is True}
    filtered = {r[0] for r in graph.query(
        f"MATCH (n:T) WHERE {fragment} RETURN n.id", params).result_set}
    assert projected == filtered


def test_negation_under_not_is_the_complement(graph):
    """Comparisons are two-valued, so NOT (...) is exactly the other ids —
    a missing key included."""
    cmp = resolve_comparison("eq", "alpha")
    params = {}

    def bind(v):
        params[f"p{len(params)}"] = v
        return f"$p{len(params) - 1}"

    where = compile_comparison("n.p", cmp, bind)
    inside = {r[0] for r in graph.query(
        f"MATCH (n:T) WHERE {where} RETURN n.id", params).result_set}
    outside = {r[0] for r in graph.query(
        f"MATCH (n:T) WHERE NOT ({where}) RETURN n.id", params).result_set}
    assert inside and outside
    assert inside | outside == set(range(len(_stored_values())))
    assert not inside & outside


def test_edge_comparison_runs_inside_a_path_query(graph):
    """An edge comparison is embedded in ``ALL(rel IN relationships(p) …)``
    next to the path query's own ``p``, ``s`` and ``t``. FalkorDB does not
    scope comprehension variables, so a comparison that bound any of those
    names would resolve to the path's (``size(p)`` fails on a Path)."""
    from backend.app.providers.falkordb_deep_search import (
        _build_path_cypher,
        _Compiler,
    )
    from backend.common.models.search import PathPredicate

    graph.query(
        "CREATE (:P {urn: 'a'})-[:R {w: '1.5'}]->(:P {urn: 'b'})"
        "-[:R {w: [1, 2]}]->(:P {urn: 'c'})-[:R {w: 'heavy'}]->(:P {urn: 'd'})")
    c = _Compiler(lineage_edge_types={"R"}, containment_edge_types=set())
    c.compile(PathPredicate.model_validate({
        "sourceUrns": ["a"], "targetUrns": ["b", "c", "d"],
        "edgePredicate": {"kind": "edgeProperty", "key": "w", "op": "between",
                          "value": [1, 2], "valueType": "number"},
    }))
    cypher = _build_path_cypher(direction="outgoing", max_hops=3,
                                edge_where=c.hoisted_path["edge_where"])
    rows = graph.query(cypher, {
        **c.params, "_pathEdgeTypes": ["R"], "_pathSrc": ["a"],
        "_pathTgt": ["b", "c", "d"], "_pathMaxPaths": 10,
    }).result_set
    # a→b (1.5) and a→b→c ([1, 2]) pass; the hop over "heavy" does not.
    assert sorted(r[2] for r in rows) == [1, 2]


def test_property_name_search(graph):
    """``hasProperty`` by NAME runs on the engine: ``keys(n)`` minus the
    platform's fields, case-insensitive."""
    from backend.app.providers.falkordb_deep_search import _Compiler
    from backend.common.models.search import HasPropertyPredicate

    def ids(pred):
        c = _Compiler()
        where = c.compile(pred)
        return {r[0] for r in graph.query(
            f"MATCH (n:T) WHERE {where} RETURN n.id", c.params).result_set}

    with_p = {i for i, v in enumerate(_stored_values()) if v is not None}
    assert ids(HasPropertyPredicate(key="P", key_match="prefix")) == with_p
    assert ids(HasPropertyPredicate(key="p", key_match="contains", negate=True)) == (
        set(range(len(_stored_values()))) - with_p)


def test_the_reported_searches_end_to_end():
    """The searches from the report, through the provider's real
    ``deep_search`` — candidate query, scope and hit shaping included — on
    nodes written the way the app writes them: ``gvHash``-like 19-digit
    ids, numeric text beside numbers, native lists and ISO timestamps."""
    import asyncio

    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.common.models.graph import GraphNode
    from backend.common.models.search import SearchQuery

    async def scenario() -> None:
        p = FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            graph_name=f"semantics_e2e_{uuid.uuid4().hex[:8]}",
            auth_enabled=False,
        )
        p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
        nodes = [
            GraphNode(urn="urn:t:1", entityType="dataset", displayName="Orders", properties={
                "sourceHash": -3746471915534727923, "rows": 1500,
                "labels": ["pii", "gold"], "updated": "2024-05-10T08:00:00Z"}),
            GraphNode(urn="urn:t:2", entityType="dataset", displayName="Customers", properties={
                "sourceHash": -4274918641463862057, "rows": "20",
                "labels": ["bronze"], "updated": "2023-01-01"}),
            GraphNode(urn="urn:t:3", entityType="dataset", displayName="Events", properties={
                "rows": 7.5, "owner": ""}),
        ]

        async def urns(pred) -> list:
            q = SearchQuery.model_validate({
                "predicate": pred, "scope": {"viewId": "v"},
                "options": {"results": "hits", "pageSize": 50}})
            return sorted(h.node.urn for h in (await p.deep_search(q)).hits)

        try:
            assert await p.save_custom_graph(nodes, [])
            prop = lambda **kw: {"kind": "property", **kw}  # noqa: E731
            # gvHash equals <exact id> — typed, and as plain text.
            assert await urns(prop(key="sourceHash", op="eq",
                                   value="-3746471915534727923", valueType="number")) == ["urn:t:1"]
            assert await urns(prop(key="sourceHash", op="eq",
                                   value="-3746471915534727923")) == ["urn:t:1"]
            # gvHash contains 74 — both ids have "74" in their digits.
            assert await urns(prop(key="sourceHash", op="contains", value="74")) == [
                "urn:t:1", "urn:t:2"]
            assert await urns(prop(key="rows", op="gt", value=10)) == ["urn:t:1", "urn:t:2"]
            assert await urns(prop(key="rows", op="between", value=[5, 100],
                                   valueType="number")) == ["urn:t:2", "urn:t:3"]
            assert await urns(prop(key="labels", op="containsAll",
                                   value=["gold", "PII"])) == ["urn:t:1"]
            assert await urns(prop(key="labels", op="notIn", value=["pii"],
                                   includeMissing=True)) == ["urn:t:2", "urn:t:3"]
            assert await urns(prop(key="updated", op="gte", value="2024-01-01",
                                   valueType="date")) == ["urn:t:1"]
            assert await urns(prop(key="owner", op="isEmpty")) == ["urn:t:1", "urn:t:2", "urn:t:3"]
            assert await urns(prop(key="owner", op="isSet")) == ["urn:t:3"]
            assert await urns({"kind": "hasProperty", "key": "HASH",
                               "keyMatch": "contains"}) == ["urn:t:1", "urn:t:2"]
            assert await urns({"kind": "group", "op": "not", "children": [
                prop(key="rows", op="eq", value=1500)]}) == ["urn:t:2", "urn:t:3"]
        finally:
            await p._graph.delete()

    asyncio.run(scenario())


@pytest.mark.parametrize("q", ["alpha", "15", "é", "2024"])
def test_value_suggestions_count_every_stored_value(graph, q):
    """``/search/values`` on the engine: each distinct value (a list one
    element at a time, kinds kept apart — 15 is not "15") whose text
    contains ``q``, with the exact number of times it is stored."""
    import asyncio
    from collections import Counter

    from backend.app.providers.falkordb_deep_search import suggest_property_values
    from backend.common.search_semantics import element_texts, fold_case

    class _Provider:
        async def _ro_query(self, cypher, params=None, timeout=None):
            return graph.query(cypher, params or {})

    from backend.common.search_semantics import value_slot

    out = asyncio.run(suggest_property_values(
        _Provider(), key="p", entity_types=["T"], q=q, limit=50))
    got = Counter({value_slot(v["value"]): v["count"] for v in out["values"]})

    want: Counter = Counter()
    for stored in _stored_values():
        for e in stored if isinstance(stored, list) else [stored]:
            if isinstance(e, (str, int, float, bool)) and fold_case(q) in fold_case(element_texts(e)[0]):
                want[value_slot(e)] += 1
    assert got == want
    assert out["complete"] is True
