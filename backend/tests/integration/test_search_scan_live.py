"""LIVE FalkorDB: a job's scan reads every match of a search once — exactly
the entities the search matches — and stops past its cap.

A property operation changes what a search for it finds, so its job must read
exactly those matches: none missed at a unit's edge, none read twice, none
that the search wouldn't match. Here, on a real graph cut into many units
(label ID bands, walks from a view's roots read a page at a time, the canvas's
URNs), the scan's URNs must equal the reference: the matches worked out in
Python from the seeded data through ``search_semantics.evaluate``, each node's
value wherever it is kept (natively, or in ``propertiesRaw``).

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_scan_live.py -q
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

OWNERS = ["finance", "data-core", "risk", "Finance Ops"]
LEVELS = [("Domain", 3), ("Container", 12), ("Dataset", 90), ("Column", 700)]
#: Each seeded node: its label, parent, native and raw properties.
NODES: dict = {}


def _seed_rows():
    rng = random.Random(7)
    parents = {None: [None]}
    previous = None
    for label, count in LEVELS:
        for i in range(count):
            native, raw = {}, {}
            where = rng.random()
            if where < 0.4:
                native["owner"] = rng.choice(OWNERS)
            elif where < 0.7:
                raw["owner"] = rng.choice(OWNERS)                 # a name kept raw
            native["big"] = rng.choice([2 ** 63 - 1, -(2 ** 63), rng.randint(-9, 9)])
            if rng.random() < 0.3:
                native["tier"] = rng.choice(["gold", "  ", ""])
            NODES[f"urn:{label.lower()}:{i}"] = {
                "label": label, "parent": rng.choice(parents[previous]),
                "native": native, "raw": raw}
        parents[label] = [u for u, n in NODES.items() if n["label"] == label]
        previous = label


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"scan_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    NODES.clear()
    _seed_rows()
    for label, _count in LEVELS:
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        rows = [{"parent": n["parent"], "props": {
                    "urn": urn, "displayName": urn, "propertiesRaw": json.dumps(n["raw"]),
                    **n["native"]}}
                for urn, n in NODES.items() if n["label"] == label]
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


def _prop(**leaf):
    return {"kind": "property", **leaf}


PREDICATES = {
    "all": {"kind": "all"},
    "owner-finance": _prop(key="owner", op="contains", value="finance"),
    "big-positive": _prop(key="big", op="gt", value="0", valueType="number"),
    "tier-empty": _prop(key="tier", op="isEmpty"),
    "has-owner": {"kind": "hasProperty", "key": "owner"},
}


def _holds(p, node) -> bool:
    from backend.app.providers.falkordb_search.raw_properties import _comparable
    from backend.common.search_semantics import evaluate, resolve_predicate

    if p.kind == "all":
        return True
    if p.kind == "hasProperty":
        return (p.key in node["native"] or p.key in node["raw"]) != p.negate
    if p.key in node["native"]:
        value = node["native"][p.key]
    elif p.key in node["raw"]:
        value = _comparable(node["raw"][p.key])
    else:
        value = None
    return evaluate(value, resolve_predicate(p))


def _expected(predicate, urns=None) -> set:
    from pydantic import TypeAdapter

    from backend.common.models.search import Predicate
    model = TypeAdapter(Predicate).validate_python(predicate)
    return {u for u, n in NODES.items() if (urns is None or u in urns) and _holds(model, n)}


def _subtree(roots) -> set:
    inside, frontier = set(roots), set(roots)
    while frontier:
        frontier = {u for u, n in NODES.items() if n["parent"] in frontier} - inside
        inside |= frontier
    return inside


async def _scan(provider, predicate, scope, cap=100_000):
    from backend.app.providers.falkordb_search.scan import scan_urns
    from backend.app.services.deep_search import SearchRunContext
    from backend.common.models.search import SearchQuery

    query = SearchQuery.model_validate({"predicate": predicate, "scope": {"viewId": "v", **scope}})
    return await scan_urns(provider, query, context=SearchRunContext(data_version="scan"), cap=cap)


@pytest.mark.parametrize("name", sorted(PREDICATES))
async def test_a_scan_reads_every_match_once(provider, name):
    res = await _scan(provider, PREDICATES[name], {"scopeMode": "data_source"})
    assert len(res.urns) == len(set(res.urns)), "a match read twice"
    assert set(res.urns) == _expected(PREDICATES[name]) and not res.over_cap


@pytest.mark.parametrize("walk_max", ["300000", "0"])
async def test_a_views_roots_bound_the_scan_walked_or_clamped(provider, monkeypatch, walk_max):
    from backend.app.providers.falkordb_search import export as export_mod
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_WALK_MAX", walk_max)
    monkeypatch.setattr(export_mod, "_WALK_PAGE", 37)
    get_deep_search_settings.cache_clear()
    roots = ["urn:domain:0", "urn:container:5", "urn:dataset:7"]
    res = await _scan(provider, PREDICATES["owner-finance"], {"scopeMode": "view", "rootUrns": roots})
    want = _expected(PREDICATES["owner-finance"], _subtree(roots))
    assert len(want) > 37
    assert sorted(res.urns) == sorted(want)


async def test_the_canvas_urns_bound_a_visible_scan(provider):
    visible = [u for i, u in enumerate(NODES) if i % 5 == 0] + ["urn:column:missing"]
    res = await _scan(provider, PREDICATES["big-positive"],
                      {"scopeMode": "visible", "visibleUrns": visible})
    assert sorted(res.urns) == sorted(_expected(PREDICATES["big-positive"], set(visible)))


async def test_a_scan_past_its_cap_says_so(provider):
    want = _expected(PREDICATES["all"])
    res = await _scan(provider, PREDICATES["all"], {"scopeMode": "data_source"}, cap=150)
    assert res.over_cap and 150 < len(res.urns) < len(want)
    assert set(res.urns) <= want
