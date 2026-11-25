"""LIVE FalkorDB: the relationship catalog is every relationship property,
exactly — what reading each relationship in scope, one by one, would give.

A relationship keeps a user's properties natively within the property-name
budget and the rest in its JSON bag (every one, on a relationship written
before that). The catalog counts the native part in the graph and the bag a
page at a time in Python, both as every reader takes a relationship (the bag
wins a name both hold), across bands of source entities. Here, on a seeded
graph — native keys, bags, a name in both, a confidence that isn't a number,
int64 extremes, rollups that must never count — its answer, followed across
requests, must equal one uncapped read of every relationship in the scope.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_relationship_catalog_live.py -q
"""
from __future__ import annotations

import json
import os
import random
import uuid
from collections import Counter

import pytest
import pytest_asyncio

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

SCHEDULES = ["daily", "hourly", "weekly", None]
JOBS = ["nightly", "stream", "backfill"]
BIG = [2 ** 63 - 1, -(2 ** 63), 17]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    """Two domains, 8 containers, 400 datasets; FEEDS between datasets (native, bag, both),
    OWNS from containers, and rollups beside them."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"relcat_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    # The ontology resolved, as the engine resolves it before any search: FEEDS is lineage,
    # OWNS a link of no class.
    p.set_resolved_edge_metadata({"FEEDS": {"isLineage": True}, "OWNS": {"isLineage": False}},
                                 ["FEEDS"])
    rng = random.Random(11)
    await p._ensure_connected()
    for label in ("Domain", "Container", "Dataset"):
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await p._graph.query("UNWIND ['urn:d:0', 'urn:d:1'] AS u CREATE (:Domain {urn: u, displayName: u})")
    containers = [{"urn": f"urn:c:{i}", "parent": f"urn:d:{i % 2}"} for i in range(8)]
    await p._graph.query(
        "UNWIND $rows AS r MATCH (d:Domain {urn: r.parent}) "
        "CREATE (d)-[:CONTAINS]->(:Container {urn: r.urn, displayName: r.urn})", {"rows": containers})
    datasets = [{"urn": f"urn:t:{i}", "parent": f"urn:c:{i % 8}"} for i in range(400)]
    await p._graph.query(
        "UNWIND $rows AS r MATCH (c:Container {urn: r.parent}) "
        "CREATE (c)-[:CONTAINS]->(:Dataset {urn: r.urn, displayName: r.urn})", {"rows": datasets})

    feeds = []
    for i in range(1200):
        a, b = rng.randrange(400), rng.randrange(400)
        native = {"id": f"f{i}", "gvHash": rng.randint(-5, 5)}
        shape = rng.random()
        if shape < 0.4:                                   # all native, an empty bag
            native.update(properties="{}", schedule=rng.choice(SCHEDULES[:3]),
                          lag=rng.randint(-50, 50), confidence=rng.random())
            if rng.random() < 0.3:
                native["big"] = rng.choice(BIG)
        elif shape < 0.7:                                 # written before: all in the bag
            native["properties"] = json.dumps({"schedule": rng.choice(SCHEDULES),
                                               "job": rng.choice(JOBS),
                                               "lag": rng.randint(-50, 50)})
        elif shape < 0.85:                                # a name in both: the bag's wins
            native.update(schedule="stale", lag=999,
                          properties=json.dumps({"schedule": rng.choice(SCHEDULES[:3]),
                                                 "job": rng.choice(JOBS)}))
        else:                                             # a confidence that isn't a number
            native.update(properties="{}", confidence=rng.choice(["high", "low"]),
                          tags=["a", "b"] if rng.random() < 0.5 else ["c"])
        feeds.append({"a": f"urn:t:{a}", "b": f"urn:t:{b}", "p": native})
    await p._graph.query(
        "UNWIND $rows AS r MATCH (a:Dataset {urn: r.a}) MATCH (b:Dataset {urn: r.b}) "
        "CREATE (a)-[e:FEEDS]->(b) SET e = r.p", {"rows": feeds})
    owns = [{"a": f"urn:c:{i % 8}", "b": f"urn:t:{i}", "p": {"id": f"o{i}", "properties": "{}",
                                                            "since": 2000 + i % 25}}
            for i in range(0, 400, 3)]
    await p._graph.query(
        "UNWIND $rows AS r MATCH (a:Container {urn: r.a}) MATCH (b:Dataset {urn: r.b}) "
        "CREATE (a)-[e:OWNS]->(b) SET e = r.p", {"rows": owns})
    # Rollups: the platform's own, summarising other edges — never counted.
    await p._graph.query(
        "MATCH (a:Container), (b:Container) WHERE a.urn < b.urn "
        "CREATE (a)-[:AGGREGATED {weight: 3, aggKey: a.urn + b.urn, properties: '{\"x\": 1}'}]->(b)")
    try:
        yield p
    finally:
        await p._graph.delete()


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch):
    """Bands of a thousand edges' worth: the scan crosses several units and requests."""
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_CHUNK_WIDTH", "1000")
    get_deep_search_settings.cache_clear()
    yield
    get_deep_search_settings.cache_clear()


def _scope(name):
    from backend.common.models.search import SearchScope
    if name == "domain":
        return SearchScope.model_validate({"viewId": "v", "scopeMode": "view",
                                           "rootUrns": ["urn:d:0"], "maxDepth": 12})
    return SearchScope.model_validate({"viewId": "v", "scopeMode": "data_source"})


@pytest.mark.parametrize("scope_name", ["data-source", "domain"])
async def test_the_relationship_catalog_is_every_property_exactly(provider, scope_name,
                                                                  monkeypatch):
    from backend.app.providers.falkordb_provider import edge_user_properties
    from backend.app.providers.falkordb_search import catalog as catalog_mod
    from backend.app.services.deep_search import SearchRunContext

    # A page of the bags smaller than a unit holds: every unit reads them in more than one.
    monkeypatch.setattr(catalog_mod, "PAGE", 50)
    scope = _scope(scope_name)
    context = SearchRunContext(data_version="1", scope_hash=f"relcat-{scope_name}")
    out, sid, requests = None, None, 0
    for _ in range(400):
        out = await catalog_mod.execute_catalog_session(
            provider, scope, context=context, wait_ms=0, session_id=sid, subject="relationships")
        sid, requests = out["sessionId"], requests + 1
        if out["status"] == "complete":
            break
    assert out["status"] == "complete" and out["subject"] == "relationships"

    if scope.root_urns:
        inside = {r[0] for r in (await provider._ro_query(
            "MATCH (r:Domain {urn: 'urn:d:0'})-[:CONTAINS*0..12]->(n) RETURN DISTINCT n.urn",
            timeout=60)).result_set}
    else:
        inside = {r[0] for r in (await provider._ro_query(
            "MATCH (n) WHERE n.urn IS NOT NULL RETURN n.urn", timeout=60)).result_set}
    rows = (await provider._ro_query(
        "MATCH (a)-[e]->(b) RETURN a.urn, b.urn, type(e), properties(e)", timeout=60)).result_set
    rows = [(t, props) for a, b, t, props in rows
            if a in inside and b in inside and t != "AGGREGATED"]

    types = Counter(t for t, _ in rows)
    assert out["entities"] == len(rows)
    assert {e["type"]: e["count"] for e in out["entityTypes"]} == dict(types)
    assert "AGGREGATED" not in types

    want: dict = {}
    for t, native in rows:
        props, bag = edge_user_properties(t, dict(native))
        for key, value in props.items():
            kind = catalog_mod._kind_of(value)
            if kind is None:
                continue
            w = want.setdefault(key, {"types": Counter(), "kinds": Counter(), "values": Counter(),
                                      "numbers": [], "residual": 0})
            w["types"][t] += 1
            w["kinds"][kind] += 1
            w["residual"] += key in bag
            if kind in ("Integer", "Float"):
                w["numbers"].append(value)
            for element in {catalog_mod._slot(catalog_mod._kind_of(e), e)
                            for e in (value if kind == "List" else [value])}:
                w["values"][element] += 1
    got = {p["key"]: p for p in out["properties"]}
    assert set(got) == set(want)
    assert {"schedule", "lag", "job", "since", "confidence", "tags"} <= set(got)
    assert not {"id", "gvHash", "properties", "weight", "aggKey", "x"} & set(got)
    for key, w in want.items():
        p = got[key]
        assert p["count"] == sum(w["types"].values()), key
        assert p["byEntityType"] == dict(w["types"]), key
        assert p["kinds"] == dict(w["kinds"]), key
        assert p["residual"] == w["residual"], key
        if w["numbers"]:
            assert (p["min"], p["max"]) == (min(w["numbers"]), max(w["numbers"])), key
        distinct = len(w["values"])
        assert p["distinctExact"] and p["distinct"] == distinct, key
        listed = {catalog_mod._slot(v["kind"], v["value"]): v["count"] for v in p["values"]}
        assert all(w["values"][slot] == n for slot, n in listed.items()), key
        assert len(listed) == min(distinct, catalog_mod.VALUES_SHOWN), key
    # The bag's value won every name both held.
    assert not any(v["value"] == "stale" for v in got["schedule"]["values"])
    if scope_name == "data-source":
        assert (got["big"]["min"], got["big"]["max"]) == (-(2 ** 63), 2 ** 63 - 1)
