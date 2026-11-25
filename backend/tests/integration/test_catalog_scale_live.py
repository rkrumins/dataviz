"""LIVE FalkorDB, at scale: the relationship catalog completes over about a
million relationships across several types — one entity a hub with half a
million of them — exactly, and costs per statement what the entity catalog
of the same graph does.

Seeded: ``SCALE_DATASETS`` datasets (default 50,000); from one hub,
``SCALE_HUB_TYPES`` relationship types (default 10) to every dataset; from
each dataset ``SCALE_FANOUT`` (default 10) relationships to others, across
five types. Half the relationships keep their properties natively, half in
the JSON bag, as one written before that does.

Records, as one JSON line (``CATALOG_SCALE_REPORT {...}``, read it with
``-s``) and in ``$CATALOG_SCALE_REPORT_PATH`` when set, for each catalog:
its seconds, requests and units, and its statements' milliseconds (count,
median, p95, max) by kind.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_catalog_scale_live.py -q -s
"""
from __future__ import annotations

import json
import os
import statistics
import time
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

DATASETS = int(os.getenv("SCALE_DATASETS", "50000"))
HUB_TYPES = int(os.getenv("SCALE_HUB_TYPES", "10"))
FANOUT = int(os.getenv("SCALE_FANOUT", "10"))
SCHEDULES = ["daily", "hourly", "weekly"]

#: What each statement a catalog sends is, by what it says.
KINDS = [("properties(e)", "bag page"), ("propertiesRaw", "raw page"), ("UNWIND keys", "keys"),
         ("LIMIT $_probe", "probe"), ("IN ['Integer', 'Float']", "bounds"),
         ("collect([_t", "values"), ("count(e)", "count"), ("count(n)", "count"),
         ("n.tags AS _t", "tags")]


def _kind(cypher: str) -> str:
    return next((k for marker, k in KINDS if marker in cypher), "plan")


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"catscale_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    # The ontology resolved, as the engine resolves it before any search.
    lineage = [f"HUB_{t}" for t in range(HUB_TYPES)] + ["FEEDS"]
    p.set_resolved_edge_metadata({t: {"isLineage": True} for t in lineage}, lineage)
    await p._ensure_connected()
    q = p._graph.query
    for label in ("Hub", "Dataset"):
        await q(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await q("CREATE (:Hub {urn: 'urn:hub', displayName: 'hub'})")
    step = 10_000
    for start in range(0, DATASETS, step):
        await q("UNWIND range($a, $b) AS i CREATE (:Dataset {urn: 'urn:t:' + toString(i), "
                "displayName: 'dataset ' + toString(i), owner: ['ann', 'bob', 'kim'][i % 3]})",
                {"a": start, "b": min(DATASETS, start + step) - 1})
    # The hub: every dataset, once per type — native properties on even ones, a bag on odd.
    for t in range(HUB_TYPES):
        for start in range(0, DATASETS, 50_000):
            await q(f"MATCH (h:Hub {{urn: 'urn:hub'}}) MATCH (d:Dataset) "
                    f"WHERE ID(d) >= $a AND ID(d) < $b "
                    f"CREATE (h)-[e:HUB_{t}]->(d) "
                    "SET e.id = 'h' + toString(ID(d)), e.gvHash = ID(d) % 7, "
                    "e.properties = CASE WHEN ID(d) % 2 = 0 THEN '{}' "
                    "ELSE '{\"schedule\": \"daily\", \"lag\": ' + toString(ID(d) % 100) + '}' END, "
                    "e.schedule = CASE WHEN ID(d) % 2 = 0 THEN 'hourly' ELSE null END, "
                    "e.lag = CASE WHEN ID(d) % 2 = 0 THEN ID(d) % 100 ELSE null END",
                    {"a": start, "b": start + 50_000})
    # Each dataset to FANOUT others, across five types.
    for start in range(0, DATASETS, step):
        await q("UNWIND range($a, $b) AS i UNWIND range(1, $f) AS k "
                "MATCH (a:Dataset {urn: 'urn:t:' + toString(i)}) "
                "MATCH (b:Dataset {urn: 'urn:t:' + toString((i * 7 + k * 13) % $n)}) "
                "WHERE a <> b "
                "CREATE (a)-[e:FEEDS]->(b) SET e.kind = k % 5, e.id = toString(i) + ':' + toString(k), "
                "e.properties = CASE WHEN k % 2 = 0 THEN '{}' ELSE '{\"job\": \"j' + "
                "toString(k) + '\"}' END, e.schedule = CASE WHEN k % 2 = 0 THEN "
                "$s[k % 3] ELSE null END",
                {"a": start, "b": min(DATASETS, start + step) - 1, "f": FANOUT, "n": DATASETS,
                 "s": SCHEDULES})
    try:
        yield p
    finally:
        await p._graph.delete()


async def _timed_catalog(provider, subject):
    """A catalog followed to the end, each statement it sends timed."""
    from backend.app.providers.falkordb_search import catalog as catalog_mod
    from backend.app.services.deep_search import SearchRunContext
    from backend.common.models.search import SearchScope

    timings: dict = {}
    read = provider._ro_query

    async def timed(cypher, params=None, timeout=None, **kw):
        started = time.monotonic()
        try:
            return await read(cypher, params=params, timeout=timeout, **kw)
        finally:
            timings.setdefault(_kind(cypher), []).append((time.monotonic() - started) * 1000)

    provider._ro_query = timed
    scope = SearchScope.model_validate({"viewId": "v", "scopeMode": "data_source"})
    context = SearchRunContext(data_version="1", scope_hash=f"scale-{subject}")
    started, sid, out, requests = time.monotonic(), None, None, 0
    try:
        for _ in range(2_000):
            out = await catalog_mod.execute_catalog_session(
                provider, scope, context=context, wait_ms=5_000, session_id=sid, subject=subject)
            sid, requests = out["sessionId"], requests + 1
            if out["status"] == "complete":
                break
    finally:
        provider._ro_query = read
    assert out["status"] == "complete", out.get("notes")

    def summary(ms):
        ms = sorted(ms)
        return {"n": len(ms), "median": round(statistics.median(ms), 1),
                "p95": round(ms[int(0.95 * (len(ms) - 1))], 1), "max": round(ms[-1], 1)}

    return out, {"seconds": round(time.monotonic() - started, 1), "requests": requests,
                 "statements": {k: summary(v) for k, v in sorted(timings.items())}}


async def test_the_relationship_catalog_completes_exactly_at_scale(provider):
    rels, rel_report = await _timed_catalog(provider, "relationships")
    ents, ent_report = await _timed_catalog(provider, "entities")

    stats = (await provider._ro_query(
        "CALL db.meta.stats() YIELD relTypes RETURN relTypes", timeout=60)).result_set[0][0]
    # Every type the graph holds a relationship of (its schema may list a rollup type with none).
    want_types = {str(t): int(n) for t, n in stats.items() if n and str(t) != "AGGREGATED"}
    assert {e["type"]: e["count"] for e in rels["entityTypes"]} == want_types
    assert rels["entities"] == sum(want_types.values())
    hub = sum(n for t, n in want_types.items() if t.startswith("HUB_"))
    hub_bag = (await provider._ro_query(
        "MATCH (:Hub)-[e]->() WHERE e.properties <> '{}' RETURN count(e)",
        timeout=60)).result_set[0][0]
    feeds = want_types["FEEDS"]
    feeds_native = (await provider._ro_query(
        "MATCH ()-[e:FEEDS]->() WHERE e.properties = '{}' RETURN count(e)",
        timeout=60)).result_set[0][0]
    props = {p["key"]: p for p in rels["properties"]}
    # Native on some, in the bag on the rest — every one counted, and where it is held.
    assert props["schedule"]["count"] == hub + feeds_native
    assert props["schedule"]["residual"] == hub_bag
    assert props["lag"]["count"] == hub and props["lag"]["residual"] == hub_bag
    assert props["job"]["count"] == props["job"]["residual"] == feeds - feeds_native
    assert props["kind"]["count"] == feeds and props["kind"]["residual"] == 0
    assert (props["lag"]["min"], props["lag"]["max"]) == (0, 99)
    assert not {"id", "gvHash", "properties"} & set(props)
    assert ents["entities"] == DATASETS + 1

    report = {"datasets": DATASETS, "relationships": rels["entities"], "hub": hub,
              "relationshipCatalog": rel_report, "entityCatalog": ent_report}
    line = json.dumps(report, separators=(",", ":"))
    print(f"CATALOG_SCALE_REPORT {line}")
    path = os.getenv("CATALOG_SCALE_REPORT_PATH")
    if path:
        with open(path, "w") as f:
            f.write(line)
