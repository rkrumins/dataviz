"""LIVE FalkorDB: an export holds every match of a search once, each value
exactly as the graph keeps it.

An export reads a search's matches unit by unit — label ID bands, walks from
a view's roots read a page at a time, the canvas's URNs — writes each unit's
rows to a part and serves the parts its session committed. Every piece of that
can lose or repeat rows in a way a small graph hides: a band that misses
nodes, a walk page that skips the node at its edge, a request that commits a
part twice. And every value can come back other than it is kept: a 64-bit
integer rounded, a list flattened, a property kept raw (``propertiesRaw``)
left empty.

So here, on a real graph cut into many units and followed a unit a request,
the download — CSV and NDJSON, parsed back — must hold exactly the reference
rows: the matches worked out in Python from the seeded data (each node's
value wherever it is kept, through ``search_semantics.evaluate``), under every
scope shape, each row's values exactly as seeded.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_export_live.py -q
"""
from __future__ import annotations

import csv
import io
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

OWNERS = ["finance", "data-core", "risk", "Finance Ops"]
NAMES = ["orders", "Orders, archived", 'the "gold" table', "línea\nnueva", "customers"]
LEVELS = [("Domain", 3), ("Container", 12), ("Dataset", 90), ("Column", 700)]
#: Properties added to each row after the base columns.
COLUMNS = ["description", "tags", "owner", "big", "score", "flag", "aliases", "legacy_ref"]
#: Each seeded node: urn, label, parent, its base values, native and raw properties.
NODES: dict = {}


def _seed_rows():
    rng = random.Random(41)
    parents = {None: [None]}
    previous = None
    for label, count in LEVELS:
        for i in range(count):
            urn = f"urn:{label.lower()}:{i}"
            native, raw = {}, {}
            owner = rng.choice(OWNERS)
            where = rng.random()
            if where < 0.4:
                native["owner"] = owner
            elif where < 0.7:
                raw["owner"] = owner                              # a name past the budget
            elif where < 0.8:
                raw["owner"] = {"team": owner, "since": 2020}     # a nested value
            native["big"] = rng.choice([2 ** 63 - 1, -(2 ** 63),
                                        rng.randint(-(2 ** 63), 2 ** 63 - 1), rng.randint(-9, 9)])
            if rng.random() < 0.8:
                native["score"] = round(rng.uniform(-1000, 1000), 3)
            native["flag"] = rng.random() < 0.5
            if rng.random() < 0.5:
                native["aliases"] = rng.sample(["a", "b, c", 'd"e', "f"], rng.randint(1, 3))
            if rng.random() < 0.2:
                raw["legacy_ref"] = f"L-{label}-{i}"              # a key kept raw only
            name = f"{rng.choice(NAMES)} {i}"
            NODES[urn] = {
                "urn": urn, "label": label, "parent": rng.choice(parents[previous]),
                "base": {"displayName": name, "qualifiedName": f"{label}.{i}",
                         "description": rng.choice([None, "", "holds, \"quoted\"\nfacts"]),
                         "tags": rng.choice([[], ["pii"], ["gold", "pii"]])},
                "native": native, "raw": raw,
            }
        parents[label] = [u for u, n in NODES.items() if n["label"] == label]
        previous = label


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"export_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    NODES.clear()
    _seed_rows()
    for label, _count in LEVELS:
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        rows = [{"parent": n["parent"], "props": {
                    "urn": n["urn"], **{k: v for k, v in n["base"].items() if v is not None},
                    # As the provider writes them: a JSON string.
                    "tags": json.dumps(n["base"]["tags"]),
                    "propertiesRaw": json.dumps(n["raw"]), **n["native"]}}
                for n in NODES.values() if n["label"] == label]
        if label == "Domain":
            await p._graph.query(f"UNWIND $rows AS r CREATE (n:{label}) SET n += r.props",
                                 {"rows": rows})
        else:
            parent = LEVELS[[lv for lv, _ in LEVELS].index(label) - 1][0]
            await p._graph.query(
                f"UNWIND $rows AS r MATCH (a:{parent} {{urn: r.parent}}) "
                f"CREATE (a)-[:CONTAINS]->(n:{label}) SET n += r.props", {"rows": rows})
    try:
        yield p
    finally:
        await p._graph.delete()


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch):
    """100-node chunks: the columns span several bands, each a unit."""
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_CHUNK_WIDTH", "100")
    get_deep_search_settings.cache_clear()
    yield
    get_deep_search_settings.cache_clear()


@pytest.fixture
def objects(tmp_path):
    from backend.app.services.storage.object_store import LocalFsObjectStore
    return LocalFsObjectStore(tmp_path)


def _prop(**leaf):
    return {"kind": "property", **leaf}


PREDICATES = {
    "all": {"kind": "all"},
    "owner-finance": _prop(key="owner", op="contains", value="finance"),
    "big-positive": _prop(key="big", op="gt", value="0", valueType="number"),
    "or-not": {"kind": "group", "op": "or", "children": [
        _prop(key="flag", op="eq", value="true", valueType="boolean"),
        {"kind": "group", "op": "not", "children": [
            {"kind": "hasProperty", "key": "legacy_ref"}]}]},
}


def _validated(predicate):
    from pydantic import TypeAdapter

    from backend.common.models.search import Predicate
    return TypeAdapter(Predicate).validate_python(predicate)


def _holds(p, node) -> bool:
    from backend.app.providers.falkordb_search.raw_properties import _comparable
    from backend.common.search_semantics import evaluate, resolve_predicate

    if p.kind == "all":
        return True
    if p.kind == "group":
        answers = [_holds(c, node) for c in p.children]
        return {"and": all, "or": any}[p.op](answers) if p.op != "not" else not answers[0]
    if p.kind == "hasProperty":
        return (p.key in node["native"] or p.key in node["raw"]) != p.negate
    if p.key in node["native"]:
        value = node["native"][p.key]
    elif p.key in node["raw"]:
        value = _comparable(node["raw"][p.key])
    else:
        value = None
    return evaluate(value, resolve_predicate(p))


def _subtree(roots) -> set:
    inside, frontier = set(roots), set(roots)
    while frontier:
        frontier = {u for u, n in NODES.items() if n["parent"] in frontier} - inside
        inside |= frontier
    return inside


def _record(node) -> dict:
    """The row the export must hold for a node: every value as seeded."""
    record = {"urn": node["urn"], "displayName": node["base"]["displayName"],
              "entityType": node["label"], "qualifiedName": node["base"]["qualifiedName"],
              "description": node["base"]["description"], "tags": node["base"]["tags"]}
    for key in COLUMNS[2:]:
        record[key] = node["native"].get(key, node["raw"].get(key))
    return record


def _expected(predicate, urns=None) -> dict:
    model = _validated(predicate)
    return {u: _record(n) for u, n in NODES.items()
            if (urns is None or u in urns) and _holds(model, n)}


def _cell(value) -> str:
    """How CSV writes a value: an integer's digits, JSON for a list or an
    object, nothing for a missing one."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


async def _export(provider, objects, predicate, scope, fmt, tag):
    """Follow an export a request at a time to the end, then download it."""
    from backend.app.providers.falkordb_search.export import (
        execute_export_session,
        open_export,
    )
    from backend.app.services.deep_search import SearchRunContext
    from backend.common.models.search import SearchQuery

    query = SearchQuery.model_validate({"predicate": predicate,
                                        "scope": {"viewId": "v", **scope}})
    context = SearchRunContext(data_version=f"export-{tag}", scope_hash=tag)
    sid, requests, out = None, 0, None
    while requests < 400:
        out = await execute_export_session(provider, query, context=context, fmt=fmt,
                                           columns=COLUMNS, wait_ms=0, session_id=sid,
                                           objects=objects)
        sid, requests = out["sessionId"], requests + 1
        if out["status"] == "complete":
            break
    assert out["status"] == "complete"
    opened = await open_export(provider, sid, scope_hash=tag, objects=objects)
    assert opened is not None
    answer, body = opened
    text = b"".join([chunk async for chunk in body]).decode("utf-8")
    return answer, text, requests


def _rows_by_urn(rows) -> dict:
    by_urn = {}
    for row in rows:
        assert row["urn"] not in by_urn, f"{row['urn']} exported twice"
        by_urn[row["urn"]] = row
    return by_urn


def _check(answer, text, fmt, want):
    base = ["urn", "displayName", "entityType", "qualifiedName"]
    assert answer["rows"] == len(want) and answer["columns"] == base + COLUMNS
    if fmt == "ndjson":
        rows = [json.loads(line) for line in text.splitlines()]
        assert all(list(row) == base + COLUMNS for row in rows)
        got = _rows_by_urn(rows)
        assert set(got) == set(want)
        for urn, record in want.items():
            assert got[urn] == record, urn
    else:
        reader = csv.DictReader(io.StringIO(text, newline=""))
        assert reader.fieldnames == base + COLUMNS
        got = _rows_by_urn(list(reader))
        assert set(got) == set(want)
        for urn, record in want.items():
            assert got[urn] == {k: _cell(v) for k, v in record.items()}, urn


@pytest.mark.parametrize("fmt", ["csv", "ndjson"])
@pytest.mark.parametrize("name", sorted(PREDICATES))
async def test_an_export_holds_every_match_once_exactly(provider, objects, name, fmt):
    answer, text, requests = await _export(provider, objects, PREDICATES[name],
                                           {"scopeMode": "data_source"}, fmt, f"{name}-{fmt}")
    assert requests > 1
    _check(answer, text, fmt, _expected(PREDICATES[name]))


@pytest.mark.parametrize("walk_max", ["300000", "0"])
async def test_a_views_roots_bound_the_export_walked_or_clamped(provider, objects, monkeypatch,
                                                                walk_max):
    """``300000``: the subtrees are walked, read 37 rows a page. ``0``:
    never walk — the bands are read, each clamped to the roots."""
    from backend.app.providers.falkordb_search import export as export_mod
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_WALK_MAX", walk_max)
    monkeypatch.setattr(export_mod, "_WALK_PAGE", 37)
    get_deep_search_settings.cache_clear()
    statements = []
    ro_query = provider._ro_query

    async def spy(cypher, params=None, timeout=None):
        statements.append(cypher)
        return await ro_query(cypher, params=params, timeout=timeout)

    monkeypatch.setattr(provider, "_ro_query", spy)
    roots = ["urn:domain:0", "urn:container:5", "urn:dataset:7"]
    predicate = PREDICATES["owner-finance"]
    answer, text, _ = await _export(provider, objects, predicate,
                                    {"scopeMode": "view", "rootUrns": roots}, "ndjson",
                                    f"roots-{walk_max}")
    want = _expected(predicate, _subtree(roots))
    assert len(want) > 37
    _check(answer, text, "ndjson", want)
    pages = [c for c in statements if "$_after" in c]
    if walk_max == "0":
        assert not pages
    else:
        assert len(pages) > 2


async def test_the_canvas_urns_bound_a_visible_export(provider, objects):
    visible = [u for i, u in enumerate(NODES) if i % 5 == 0] + ["urn:column:missing"]
    predicate = PREDICATES["big-positive"]
    answer, text, _ = await _export(provider, objects, predicate,
                                    {"scopeMode": "visible", "visibleUrns": visible}, "csv",
                                    "visible")
    _check(answer, text, "csv", _expected(predicate, set(visible)))


async def test_a_path_search_is_not_exported(provider, objects):
    from backend.app.services.deep_search import CompileError

    path = {"kind": "path", "sourceUrns": ["urn:domain:0"], "targetUrns": ["urn:column:1"]}
    with pytest.raises(CompileError):
        await _export(provider, objects, path, {"scopeMode": "data_source"}, "csv", "path")
