#!/usr/bin/env python3
"""Measure Connections searches (``kind: edges``) on a seeded benchmark graph.

First seed the graph, then give it lineage and the properties the examples
ask about, then measure — each search's exact total checked against a direct
Cypher count::

    python -m backend.scripts.seed_search_bench --nodes 2000000 --graph edges_bench
    python -m backend.scripts.bench_search_edges --graph edges_bench --prepare
    python -m backend.scripts.bench_search_edges --graph edges_bench

``--prepare`` adds, to every ``SchemaField``, a ``dataType`` (string, int,
date by turns) and a ``first_name`` (``bob`` on one in 997), and two
``DERIVES`` edges to the fields 7 and 31 places on (JSON mode batch, stream);
to every ``Dataset`` a ``family`` (``smith`` on one in ten); and a hub — the
first dataset — with ``FEEDS`` edges to the first 100,000 fields. Edges are
created by node ID (``WITH p[0] AS s … WHERE ID(a) = s``, a seek), so it
takes about a minute for two million fields. The numbers are in
docs/search-engine/S0_FINDINGS.md §16.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import time

from falkordb import FalkorDB


def prepare(host: str, port: int, graph: str) -> None:
    g = FalkorDB(host=host, port=port).select_graph(graph)

    def q(cypher, params=None):
        return g.query(cypher, params or {}, timeout=180_000)

    fields = sorted(q("MATCH (f:SchemaField) RETURN collect(ID(f))").result_set[0][0])
    datasets = sorted(q("MATCH (d:Dataset) RETURN collect(ID(d))").result_set[0][0])
    for start in range(fields[0], fields[-1] + 1, 100_000):
        q("MATCH (f:SchemaField) WHERE ID(f) >= $lo AND ID(f) < $hi "
          "SET f.dataType = CASE ID(f) % 3 WHEN 0 THEN 'string' WHEN 1 THEN 'int' ELSE 'date' END, "
          "f.first_name = CASE WHEN ID(f) % 997 = 0 THEN 'bob' ELSE 'alice' END",
          {"lo": start, "hi": start + 100_000})
    q("MATCH (d:Dataset) SET d.family = CASE WHEN ID(d) % 10 = 0 THEN 'smith' ELSE 'jones' END")

    def link(pairs, rel, props=None):
        for i in range(0, len(pairs), 20_000):
            q("UNWIND $pairs AS p WITH p[0] AS s, p[1] AS t MATCH (a) WHERE ID(a) = s "
              f"MATCH (b) WHERE ID(b) = t CREATE (a)-[:{rel}"
              + (" {properties: $props}" if props else "") + "]->(b)",
              {"pairs": pairs[i:i + 20_000], **({"props": props} if props else {})})

    n = len(fields)
    link([[f, fields[(i + 7) % n]] for i, f in enumerate(fields)], "DERIVES", '{"mode": "batch"}')
    link([[f, fields[(i + 31) % n]] for i, f in enumerate(fields)], "DERIVES", '{"mode": "stream"}')
    link([[datasets[0], f] for f in fields[:100_000]], "FEEDS")
    print(q("CALL db.meta.stats() YIELD relTypes, relCount, nodeCount "
            "RETURN relTypes, relCount, nodeCount").result_set)


async def measure(host: str, port: int, graph: str) -> None:
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.deep_search import SearchRunContext, get_deep_search_settings
    from backend.common.models.search import SearchQuery

    p = FalkorDBProvider(host=host, port=port, graph_name=graph, auth_enabled=False)
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    lineage = ["TRANSFORMS", "DERIVES", "FEEDS"]
    p.set_resolved_edge_metadata({t: {"isLineage": True} for t in lineage}, lineage)
    await p._ensure_connected()

    def prop(key, value):
        return {"kind": "property", "key": key, "op": "eq", "value": value}

    def both(*c):
        return {"kind": "group", "op": "and", "children": list(c)}

    string, smith_parent = prop("dataType", "string"), {
        "kind": "related", "axis": "parent", "where": prop("family", "smith")}

    async def first(cypher, params=None):
        return (await p._ro_query(cypher, params=params or {}, timeout=180)).result_set[0][0]

    async def run(name, raw, cypher, scope=None, params=None):
        t = time.perf_counter()
        want = await first(cypher, params)
        direct = time.perf_counter() - t
        query = SearchQuery.model_validate({
            "predicate": {"kind": "edges", **raw}, "options": {"results": "edges"},
            "scope": scope or {"viewId": "v", "scopeMode": "data_source"}})
        context = SearchRunContext(data_version=f"bench-{name}-{time.time()}", scope_hash="h")
        t = time.perf_counter()
        options = query.options.model_copy(update={"wait_ms": 1000})
        page = await p.deep_search_session(query.model_copy(update={"options": options}),
                                           context=context)
        answered = time.perf_counter() - t
        while page.status != "complete":
            options = options.model_copy(update={"wait_ms": 110_000, "session_id": page.session_id})
            page = await p.deep_search_session(query.model_copy(update={"options": options}),
                                               context=context)
        print(f"{name:<44} {page.total_count:>9} edges  {time.perf_counter() - t:6.2f} s "
              f"(first answer {answered:.2f} s, direct Cypher {direct:.2f} s)"
              f"{'' if page.total_count == want else f'  MISMATCH: Cypher counts {want}'}",
              flush=True)

    hub_urn = await first("MATCH (d:Dataset) WITH d ORDER BY ID(d) LIMIT 1 RETURN d.urn")
    domain = await first("MATCH (d:Domain) WITH d ORDER BY ID(d) LIMIT 1 RETURN d.urn")
    await run("string field called bob -> anything",
              {"sourceWhere": both(string, prop("first_name", "bob")), "edgeTypes": ["DERIVES"]},
              "MATCH (a:SchemaField)-[e:DERIVES]->() WHERE a.dataType = 'string' "
              "AND a.first_name = 'bob' RETURN count(e)")
    await run("the hub -> a string field",
              {"sourceWhere": {"kind": "is", "refs": [{"urn": hub_urn}]}, "targetWhere": string,
               "edgeTypes": ["FEEDS"]},
              "MATCH (h:Dataset {urn: $h})-[e:FEEDS]->(b) WHERE b.dataType = 'string' "
              "RETURN count(e)", params={"h": hub_urn})
    await run("any dataset (the hub, far) -> a string field",
              {"sourceWhere": {"kind": "entityType", "values": ["Dataset"]},
               "targetWhere": both({"kind": "entityType", "values": ["SchemaField"]}, string),
               "edgeTypes": ["FEEDS"]},
              "MATCH (:Dataset)-[e:FEEDS]->(b:SchemaField) WHERE b.dataType = 'string' "
              "RETURN count(e)")
    await run("inside a domain -> a string field",
              {"sourceWhere": {"kind": "descendantOf", "urns": [domain]}, "targetWhere": string,
               "edgeTypes": ["DERIVES"]},
              "MATCH (:Domain {urn: $d})-[:CONTAINS*0..12]->(a) WITH DISTINCT a "
              "MATCH (a)-[e:DERIVES]->(b) WHERE b.dataType = 'string' RETURN count(e)",
              params={"d": domain})
    example = ("MATCH (a:SchemaField)-[e:DERIVES]->(:SchemaField)<-[:CONTAINS]-(d:Dataset) "
               "WHERE a.dataType = 'string' AND d.family = 'smith' RETURN count(e)")
    await run("a string field -> one whose parent is smith",
              {"sourceWhere": string, "targetWhere": smith_parent, "edgeTypes": ["DERIVES"]},
              example)
    for n in (100, 1000):
        roots = await first("MATCH (c:Container) WITH c ORDER BY ID(c) LIMIT $n "
                            "RETURN collect(c.urn)", {"n": n})
        await run(f"a view of {n} roots: a string field -> anything",
                  {"sourceWhere": string, "edgeTypes": ["DERIVES"]},
                  "MATCH (r:Container) WHERE r.urn IN $r MATCH (r)-[:CONTAINS*0..12]->(a) "
                  "WITH DISTINCT a WHERE a.dataType = 'string' MATCH (a)-[e:DERIVES]->(b) "
                  "MATCH (b)<-[:CONTAINS*0..12]-(r2:Container) WHERE r2.urn IN $r "
                  "RETURN count(DISTINCT e)",
                  scope={"viewId": "v", "scopeMode": "view", "rootUrns": roots},
                  params={"r": roots})
    shown = await first("MATCH (f:SchemaField) WITH f ORDER BY ID(f) LIMIT 5000 RETURN collect(f.urn)")
    await run("5,000 entities on the canvas, between them", {"edgeTypes": ["DERIVES"]},
              "MATCH (a)-[e:DERIVES]->(b) WHERE a.urn IN $v AND b.urn IN $v RETURN count(e)",
              scope={"viewId": "v", "scopeMode": "visible", "visibleUrns": shown},
              params={"v": shown})
    os.environ["DEEP_SEARCH_CHUNK_TIMEOUT_MS"] = "1000"
    get_deep_search_settings.cache_clear()
    await run("the same, a unit's budget cut to 1 s",
              {"sourceWhere": string, "targetWhere": smith_parent, "edgeTypes": ["DERIVES"]},
              example)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--graph", default="edges_bench")
    ap.add_argument("--prepare", action="store_true",
                    help="add the lineage and properties to a seeded graph, then stop")
    args = ap.parse_args()
    if args.prepare:
        prepare(args.host, args.port, args.graph)
    else:
        asyncio.run(measure(args.host, args.port, args.graph))


if __name__ == "__main__":
    main()
