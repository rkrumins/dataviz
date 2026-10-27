"""LIVE FalkorDB: Connections — a search whose results are edges.

Two categories, Finance (F) and Sales (S), each hold tables, which hold
columns (``HAS``). Columns carry a ``dataType`` and a ``first_name``; tables
a ``family``. ``LINEAGE``, ``FLOWS_TO`` and ``PRODUCES`` edges run between
columns and tables, within a category and across, from and to an entity no
category holds (``loose``, outside the view); a hub table feeds every
column; one pair of columns has three edges, two of them of one type. The
view places each category, and what it holds, in a layer of its own.

Every question, in the data source and in the view, must be answered by
the uncapped engine exactly as the reference semantics answer it (the
stub): its count, and every page walked to the end — in order, each edge
once. It must be the same whichever end anchors, the export must hold the
same edges, and the statement explain shows must find them too.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_edges_live.py -q
"""
from __future__ import annotations

import csv
import io
import json
import os
import uuid
from collections import Counter

import pytest
import pytest_asyncio

from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import SearchQuery, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live Connections test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

HAS = "HAS"
LINEAGE_TYPES = ["LINEAGE", "FLOWS_TO", "PRODUCES"]

TABLES = {  # table: (category, family)
    "F.orders": ("F", "smith"), "F.refunds": ("F", "jones"),
    "S.leads": ("S", "smith"), "S.deals": ("S", "jones"), "S.hub": ("S", "smith"),
}
COLUMNS = {  # column: (table, dataType, first_name)
    "F.orders.name": ("F.orders", "string", "bob"),
    "F.orders.amount": ("F.orders", "int", "bob"),
    "F.orders.id": ("F.orders", "string", "alice"),
    "F.refunds.name": ("F.refunds", "string", "bob"),
    "F.refunds.reason": ("F.refunds", "string", "carol"),
    "S.leads.name": ("S.leads", "string", "bob"),
    "S.leads.score": ("S.leads", "int", "alice"),
    "S.deals.owner": ("S.deals", "string", "bob"),
    "S.deals.value": ("S.deals", "int", "dave"),
}
LOOSE = "loose"            # string, bob; no category holds it

EDGES = [  # (source, target, type, mode) — created in this order
    ("F.orders.name", "S.leads.name", "LINEAGE", "batch"),
    ("F.orders.name", "S.leads.name", "PRODUCES", "batch"),
    ("F.orders.name", "S.leads.name", "PRODUCES", "stream"),
    ("F.orders.amount", "S.deals.value", "LINEAGE", "stream"),
    ("F.refunds.name", "S.leads.name", "LINEAGE", "batch"),
    ("S.leads.name", "F.orders.id", "LINEAGE", "stream"),
    ("F.orders.id", "F.refunds.reason", "LINEAGE", "batch"),
    ("F.orders", "S.leads", "FLOWS_TO", "batch"),
    ("S.deals.owner", "F.refunds.name", "FLOWS_TO", "stream"),
    (LOOSE, "F.orders.name", "LINEAGE", "batch"),
    ("F.orders.name", LOOSE, "LINEAGE", "stream"),
    *[("S.hub", column, "LINEAGE", "batch") for column in COLUMNS],
]


def U(name: str) -> str:
    return f"urn:conn:{name}"


def _nesting():
    return ([(U(category), U(table)) for table, (category, _) in TABLES.items()]
            + [(U(table), U(column)) for column, (table, _, _) in COLUMNS.items()])


def AND(*c):
    return {"kind": "group", "op": "and", "children": list(c)}


def NOT(c):
    return {"kind": "group", "op": "not", "children": [c]}


def PROP(key, value):
    return {"kind": "property", "key": key, "op": "eq", "value": value}


def TYPE(*t):
    return {"kind": "entityType", "values": list(t)}


def IS(*names):
    return {"kind": "is", "refs": [{"urn": U(n)} for n in names]}


def INSIDE(name, **kw):
    return {"kind": "descendantOf", "urns": [U(name)], **kw}


def LAYER(value):
    return {"kind": "layer", "layerAssignment": value}


def rel(axis, where=None, **kw):
    return {"kind": "related", "axis": axis, **({"where": where} if where is not None else {}), **kw}


STRING_BOB = AND(PROP("dataType", "string"), PROP("first_name", "bob"))
SMITH_PARENT = rel("parent", PROP("family", "smith"))
STREAM = {"kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}

VIEW = {"content": {"entityScope": "all"}, "layout": {"referenceLayout": {"layers": [
    {"id": "fin", "name": "Finance", "order": 0},
    {"id": "sales", "name": "Sales", "order": 1},
    {"id": "rest", "name": "Everything else", "order": 2, "showUnassigned": True},
], "assignments": {U("F"): {"layerId": "fin", "inheritsChildren": True},
                   U("S"): {"layerId": "sales", "inheritsChildren": True}}}}}


def C(**raw):
    return {"kind": "edges", **raw}


#: (question, predicate)
CASES = [
    ("your example: a string column called bob, to anything whose parent's family is smith",
     C(sourceWhere=STRING_BOB, targetWhere=SMITH_PARENT)),
    ("the same, either way", C(sourceWhere=STRING_BOB, targetWhere=SMITH_PARENT, direction="either")),
    ("anything into the Sales layer", C(targetWhere=LAYER("Sales"))),
    ("from the Finance layer into any other", C(sourceWhere=LAYER("Finance"),
                                               targetWhere=NOT(LAYER("Finance")))),
    ("Finance and Sales, either way", C(sourceWhere=LAYER("Finance"), targetWhere=LAYER("Sales"),
                                        direction="either")),
    ("from inside Finance to inside Sales", C(sourceWhere=INSIDE("F"), targetWhere=INSIDE("S"))),
    ("from a table or anything in it", C(sourceWhere=INSIDE("F.orders"))),
    ("from a table or its columns, one level down", C(sourceWhere=INSIDE("F.orders", maxDepth=1),
                                                     targetWhere=TYPE("Entity"))),
    ("into the parent of a column", C(targetWhere=rel("child", IS("S.leads.name")))),
    ("into a table's columns", C(targetWhere=rel("parent", IS("S.leads")))),
    ("named at both ends", C(sourceWhere=IS("F.orders.name"), targetWhere=IS("S.leads.name"))),
    ("in stream mode, from a string column", C(sourceWhere=PROP("dataType", "string"),
                                               edgePredicate=STREAM)),
    ("only PRODUCES — parallel edges, each once", C(edgeTypes=["PRODUCES"])),
    ("every lineage edge", C(edgeClass="lineage")),
    ("what a category holds, its containment", C(sourceWhere=TYPE("Category"),
                                                 edgeClass="containment")),
    ("any edge at all from Sales", C(sourceWhere=INSIDE("S"), edgeClass="any")),
    ("the hub, to string columns", C(sourceWhere=IS("S.hub"),
                                     targetWhere=PROP("dataType", "string"))),
    ("anything into a number column", C(targetWhere=PROP("dataType", "int"))),
    ("from a column found by name", C(sourceWhere={"kind": "text", "target": "name",
                                                    "value": "name"},
                                      targetWhere=TYPE("Entity"))),
    ("from a table one of whose columns is called bob", C(
        sourceWhere=AND(TYPE("Entity"), rel("child", PROP("first_name", "bob"))))),
    ("from no column at all — nothing", C(sourceWhere=IS("nowhere"))),
]

SCOPES = {
    "data_source": SearchScope(view_id="v", scope_mode="data_source"),
    "view": SearchScope(view_id="v", scope_mode="view", root_urns=[U("F"), U("S")]),
}


def _query(predicate, scope, **options):
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
        "options": {"results": "edges", "pageSize": 4, **options}})
    return query.model_copy(update={"predicate": _with_resolved_layers(query.predicate, eff, [])})


def _stub() -> StubDeepSearchProvider:
    nodes = ([{"urn": U(n), "entityType": "Category", "displayName": n} for n in ("F", "S")]
             + [{"urn": U(t), "entityType": "Entity", "displayName": t, "family": family}
                for t, (_, family) in TABLES.items()]
             + [{"urn": U(c), "entityType": "Entity", "displayName": c, "dataType": dtype,
                 "first_name": first} for c, (_, dtype, first) in COLUMNS.items()]
             + [{"urn": U(LOOSE), "entityType": "Entity", "displayName": LOOSE,
                 "dataType": "string", "first_name": "bob"}])
    return StubDeepSearchProvider(
        nodes=nodes,
        edges=([{"source": p, "target": c, "type": HAS} for p, c in _nesting()]
               + [{"source": U(a), "target": U(b), "type": t, "properties": {"mode": mode}}
                  for a, b, t, mode in EDGES]),
        containment_edge_types=[HAS], lineage_edge_types=LINEAGE_TYPES)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"conn_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types([HAS], from_ontology=True)
    p.set_resolved_edge_metadata({t: {"isLineage": True} for t in LINEAGE_TYPES}, LINEAGE_TYPES)
    await p._ensure_connected()
    for label in ("Category", "Entity"):
        await p._graph.query(f"CREATE INDEX FOR (n:`{label}`) ON (n.urn)")
    for node in _stub()._nodes:
        props = {k: v for k, v in node.items() if k != "entityType"}
        await p._graph.query(f"CREATE (n:`{node['entityType']}`) SET n = $props", {"props": props})
    for parent, child in _nesting():
        await p._graph.query(f"MATCH (a {{urn: $p}}), (b {{urn: $c}}) CREATE (a)-[:{HAS}]->(b)",
                             {"p": parent, "c": child})
    for a, b, kind, mode in EDGES:
        await p._graph.query(
            f"MATCH (a {{urn: $a}}), (b {{urn: $b}}) CREATE (a)-[:{kind} {{properties: $props}}]->(b)",
            {"a": U(a), "b": U(b), "props": json.dumps({"mode": mode})})
    try:
        yield p
    finally:
        await p._graph.delete()


def _triples(edges) -> list:
    return [(e.source.urn, e.edge_type, e.target.urn) for e in edges]


async def _walk(provider, query, context) -> tuple:
    """Every page of a search, by its cursor: the edges in order, and the
    first page."""
    page = await provider.deep_search_session(query, context=context)
    first, seen = page, list(page.edges)
    while page.cursor:
        page = await provider.deep_search_session(query.model_copy(update={
            "options": query.options.model_copy(update={"cursor": page.cursor})}), context=context)
        seen += page.edges
    return first, seen


def _want(scope, predicate) -> list:
    query = _query(predicate, scope)
    return _triples(_stub()._connections(query.predicate, scope))


async def test_the_reference_answers_what_it_plainly_should():
    """The reference itself, on this graph, for the questions a person can
    answer by reading it."""
    ds = SCOPES["data_source"]
    example = _want(ds, CASES[0][1])
    assert example == [
        (U("F.orders.name"), "LINEAGE", U("S.leads.name")),
        (U("F.orders.name"), "PRODUCES", U("S.leads.name")),
        (U("F.orders.name"), "PRODUCES", U("S.leads.name")),
        (U("F.refunds.name"), "LINEAGE", U("S.leads.name")),
        (U("loose"), "LINEAGE", U("F.orders.name")),
        (U("S.leads.name"), "LINEAGE", U("F.orders.id")),
    ]
    # Either way adds the one edge from a smith table's column into a bob
    # string column — and the three that meet both ways still count once.
    either = _want(ds, CASES[1][1])
    assert sorted(either) == sorted(example + [(U("F.orders.name"), "LINEAGE", U("loose"))])
    # In the view, loose is out of scope at either end.
    assert _want(SCOPES["view"], CASES[0][1]) == [
        t for t in example if U("loose") not in (t[0], t[2])]
    assert _want(ds, CASES[-1][1]) == []


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_every_engine_answers_as_the_reference(provider, scope_name):
    scope = SCOPES[scope_name]
    wrong = []
    for i, (question, predicate) in enumerate(CASES):
        query = _query(predicate, scope)
        want = _want(scope, predicate)
        context = SearchRunContext(data_version=f"conn-{scope_name}-{i}", scope_hash=f"h-{scope_name}")
        first, seen = await _walk(provider, query, context)
        count = await provider.deep_search_count(query, context=context)
        got = (first.total_count, _triples(seen), count["count"],
               len({e.key for e in seen}) == len(seen))
        types = dict(Counter(t for _, t, _ in want))
        if got != (len(want), want, len(want), True) or first.edge_type_counts != types:
            wrong.append((question, got, first.edge_type_counts, want))
    assert not wrong, "\n".join(f"{q}\n   got (total, edges, count, unique) {g} {t}\n   want {w}"
                                for q, g, t, w in wrong)


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_either_end_anchors_the_same_answer(provider, scope_name, monkeypatch):
    from backend.app.providers.falkordb_search import edges as edges_mod

    scope = SCOPES[scope_name]
    wrong = []
    for i, (question, predicate) in enumerate(CASES):
        query = _query(predicate, scope)
        got = {}
        for side in ("source", "target"):
            monkeypatch.setattr(edges_mod, "_anchor_side", lambda *a, side=side: side)
            context = SearchRunContext(data_version=f"swap-{scope_name}-{i}-{side}",
                                       scope_hash=f"h-{scope_name}")
            first, seen = await _walk(provider, query, context)
            got[side] = (first.total_count, [e.key for e in seen])
        if got["source"] != got["target"]:
            wrong.append((question, got))
    assert not wrong, "\n".join(f"{q}\n   {g}" for q, g in wrong)


async def test_the_export_holds_every_edge_once(provider, tmp_path):
    from backend.app.providers.falkordb_search.export import execute_export_session, open_export
    from backend.app.services.storage.object_store import LocalFsObjectStore

    objects = LocalFsObjectStore(tmp_path)
    for scope_name, scope in SCOPES.items():
        for i, (question, predicate) in enumerate(CASES[:6]):
            query = _query(predicate, scope)
            context = SearchRunContext(data_version=f"export-{scope_name}-{i}", scope_hash=f"x{i}")
            sid, out = None, None
            for _ in range(100):
                out = await execute_export_session(provider, query, context=context, fmt="csv",
                                                   columns=["mode"], wait_ms=0, session_id=sid,
                                                   objects=objects)
                sid = out["sessionId"]
                if out["status"] == "complete":
                    break
            answer, body = await open_export(provider, sid, scope_hash=f"x{i}", objects=objects)
            rows = list(csv.DictReader(io.StringIO(
                b"".join([c async for c in body]).decode("utf-8"))))
            want = _want(scope, predicate)
            assert answer["columns"][:3] == ["edgeKey", "edgeId", "edgeType"], question
            assert answer["columns"][-1] == "mode" and answer["rows"] == len(want), question
            assert sorted((r["sourceUrn"], r["edgeType"], r["targetUrn"]) for r in rows) == sorted(
                want), question
            assert len({r["edgeKey"] for r in rows}) == len(rows), question
            for r in rows:
                assert r["mode"] in ("batch", "stream") and json.loads(r["properties"])["mode"] == r["mode"]
                if r["sourceUrn"].count(".") == 2:      # a column: its table is its parent
                    assert r["sourceParentUrn"] == r["sourceUrn"].rsplit(".", 1)[0]


@pytest.mark.parametrize("scope_name", list(SCOPES))
async def test_the_explained_statement_finds_them_too(provider, scope_name):
    scope = SCOPES[scope_name]
    wrong = []
    for question, predicate in CASES:
        query = _query(predicate, scope)
        explained = await provider.deep_search_explain(query)
        rows = []
        for part in explained["cypher"].split(" UNION ALL "):
            rows += (await provider._ro_query(part, params=explained["params"], timeout=30)).result_set
        got = sorted((r[0], r[1], r[2]) for r in rows)
        if got != sorted(_want(scope, predicate)):
            wrong.append((question, got))
    assert not wrong, "\n".join(f"{q}\n   {g}" for q, g in wrong)
