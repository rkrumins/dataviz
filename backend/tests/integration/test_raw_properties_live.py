"""LIVE FalkorDB: a property a node keeps raw is searched as exactly as one it
keeps natively.

A node keeps a user property in ``propertiesRaw`` — JSON text Cypher can't
read — when its value is nested or its name is past the graph's native
budget. This graph holds the same keys both ways, on different nodes, plus
nested values and a key only ever kept raw. For a matrix of conditions — and
their negations and combinations — the engine's exact count, a search's
matches and display-rule membership must equal the reference: each node's
value, wherever it is kept, through ``search_semantics.evaluate``.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_raw_properties_live.py -q
"""
from __future__ import annotations

import json
import os
import random
import uuid

import pytest
import pytest_asyncio

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

OWNERS = ["finance", "data-core", "risk", "Finance Ops", "ml"]
#: Each seeded node: its urn, native properties and raw dict.
NODES: list = []


def _seed_rows():
    rng = random.Random(29)
    rows = []
    for i in range(900):
        native, raw = {}, {}
        where = rng.random()
        owner = rng.choice(OWNERS)
        if where < 0.3:
            native["owner"] = owner
        elif where < 0.6:
            raw["owner"] = owner                              # a name past the budget
        elif where < 0.7:
            raw["owner"] = {"team": owner, "since": 2020}     # a nested value
        size = rng.choice([rng.randint(-50, 500), 2 ** 63 - 1, -(2 ** 63)])
        where = rng.random()
        if where < 0.4:
            native["size"] = size
        elif where < 0.7:
            raw["size"] = size
        if rng.random() < 0.2:
            raw["legacy_ref"] = f"L-{i}"                      # a key kept raw only
        rows.append({"urn": f"urn:ds:{i}", "native": native, "raw": raw})
    return rows


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"rawprops_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    await p._graph.query("CREATE INDEX FOR (n:Dataset) ON (n.urn)")
    NODES[:] = _seed_rows()
    await p._graph.query(
        "UNWIND $rows AS r CREATE (n:Dataset) SET n += r.props",
        {"rows": [{"props": {"urn": row["urn"], "displayName": row["urn"],
                             "propertiesRaw": json.dumps(row["raw"]), **row["native"]}}
                  for row in NODES]})
    try:
        yield p
    finally:
        await p._graph.delete()


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch):
    """200-node chunks: the 900 nodes span several units, each probed."""
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_CHUNK_WIDTH", "200")
    get_deep_search_settings.cache_clear()
    yield
    get_deep_search_settings.cache_clear()


def _prop(**leaf):
    return {"kind": "property", **leaf}


FINANCE = _prop(key="owner", op="eq", value="finance", valueType="string")
PREDICATES = {
    "eq": FINANCE,
    "contains-folded": _prop(key="owner", op="contains", value="FIN"),
    "not-contains": _prop(key="owner", op="notContains", value="data"),
    "not-contains-or-missing": _prop(key="owner", op="notContains", value="data",
                                     includeMissing=True),
    "is-set": _prop(key="owner", op="isSet"),
    "is-not-set": _prop(key="owner", op="isNotSet"),
    "gt": _prop(key="size", op="gt", value="100", valueType="number"),
    "int64-max": _prop(key="size", op="eq", value=str(2 ** 63 - 1), valueType="number"),
    "has-key": {"kind": "hasProperty", "key": "legacy_ref"},
    "has-no-key": {"kind": "hasProperty", "key": "legacy_ref", "negate": True},
    "key-prefix": {"kind": "hasProperty", "key": "LEGACY", "keyMatch": "prefix"},
    "text-on-property": {"kind": "text", "target": "property", "propertyKey": "owner",
                         "value": "ops"},
    "not": {"kind": "group", "op": "not", "children": [FINANCE]},
    "or": {"kind": "group", "op": "or", "children": [
        FINANCE, _prop(key="size", op="lt", value="0", valueType="number")]},
    "and-not": {"kind": "group", "op": "and", "children": [
        _prop(key="owner", op="isSet"),
        {"kind": "group", "op": "not", "children": [
            _prop(key="owner", op="contains", value="finance")]}]},
}


def _validated(predicate):
    from pydantic import TypeAdapter

    from backend.common.models.search import Predicate
    return TypeAdapter(Predicate).validate_python(predicate)


def _expected(predicate) -> set:
    """The reference: every node's value, native or raw, through the same
    semantics the Cypher compiles."""
    from backend.app.providers.falkordb_deep_search import _text_on_property
    from backend.app.providers.falkordb_search.raw_properties import _comparable
    from backend.common.search_semantics import evaluate, fold_case, resolve_predicate

    def holds(p, node) -> bool:
        if p.kind == "group":
            answers = [holds(c, node) for c in p.children]
            return {"and": all, "or": any}[p.op](answers) if p.op != "not" else not answers[0]
        if p.kind == "hasProperty":
            keys = list(node["native"]) + list(node["raw"])
            needle = fold_case(p.key)
            found = (p.key in keys if p.key_match == "exact"
                     else any(fold_case(k).startswith(needle) for k in keys))
            return found != p.negate
        leaf = _text_on_property(p) if p.kind == "text" else p
        if leaf.key in node["native"]:
            value = node["native"][leaf.key]
        elif leaf.key in node["raw"]:
            value = _comparable(node["raw"][leaf.key])
        else:
            value = None
        return evaluate(value, resolve_predicate(leaf))

    model = _validated(predicate)
    return {node["urn"] for node in NODES if holds(model, node)}


def _context(tag):
    from backend.app.services.deep_search import SearchRunContext
    return SearchRunContext(data_version=f"raw-{tag}", scope_hash=tag)


def _scope():
    from backend.common.models.search import SearchScope
    return SearchScope(view_id="v", scope_mode="data_source")


@pytest.mark.parametrize("name", sorted(PREDICATES))
async def test_a_count_is_exact_whichever_way_values_are_kept(provider, name):
    from backend.app.providers.falkordb_search.engine import execute_count_session
    from backend.common.models.search import SearchOptions, SearchQuery

    want = _expected(PREDICATES[name])
    session, answer = None, None
    for _ in range(50):
        query = SearchQuery(predicate=_validated(PREDICATES[name]), scope=_scope(),
                            options=SearchOptions(results="hits", wait_ms=0, session_id=session))
        answer = await execute_count_session(provider, query, context=_context(f"count-{name}"))
        session = answer["sessionId"]
        if answer["status"] == "complete":
            break
    assert answer["status"] == "complete"
    assert answer["count"] == len(want), name


@pytest.mark.parametrize("name", ["eq", "contains-folded", "not", "has-key", "int64-max"])
async def test_a_search_lists_exactly_the_matches(provider, name):
    from backend.app.providers.falkordb_search.engine import execute_session_search
    from backend.common.models.search import SearchOptions, SearchQuery

    want = _expected(PREDICATES[name])
    query = SearchQuery(predicate=_validated(PREDICATES[name]), scope=_scope(),
                        options=SearchOptions(results="hits", page_size=1000, sort="displayName"))
    page = await execute_session_search(provider, query, context=_context(f"search-{name}"))
    assert page.total_count == len(want)
    assert {h.node.urn for h in page.hits} == want


async def test_display_rules_tag_exactly_the_matches(provider):
    items = [(name, _validated(p)) for name, p in PREDICATES.items()]
    urns = [node["urn"] for node in NODES[::3]] + ["urn:ds:missing"]
    out = await provider.deep_search_membership(_scope(), items, urns, context=_context("rules"))
    assert out["errors"] == {}
    for name, predicate in PREDICATES.items():
        assert set(out["matches"][name]) == _expected(predicate) & set(urns), name
