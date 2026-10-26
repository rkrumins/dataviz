"""Advanced Search's graph questions and native queries, timed on a large graph.

Seeds a graph shaped like the seed data — platforms, databases, schemas,
datasets and their fields, joined by ``CONTAINS``, with ``TRANSFORMS``
lineage from the fields (and datasets) of one layer to the next — on a local
FalkorDB, then times what the panel runs and shows the native query bounds
fire:

* "What this feeds" (3 hops) on a field, a dataset, a schema and a database,
  through the uncapped engine the panel uses — its first page, and the exact
  count the panel finishes counting beside it;
* compiling one, and its Cypher with the values written in;
* name suggestions as the picker asks for them (a part of a name, eight
  shown, waiting at most 0.8 s), and a name path;
* native queries: a sample, a 3-hop walk, a count, the row cap, the server's
  time limit and the reply byte cap — with this process's peak memory.

Run (2M nodes and about 6M edges by default; seeding takes a few minutes)::

    python -m backend.scripts.bench_large_graph --host localhost --port 6379

``--datasets`` scales it (nine fields each, a multiple of ten); ``--keep``
leaves the graph for another run, which then skips seeding.
"""
from __future__ import annotations

import argparse
import asyncio
import resource
import statistics
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

FIELDS = 9               # per dataset
PER_SCHEMA = 250         # datasets
PER_DATABASE = 20        # schemas
PER_PLATFORM = 10        # databases
LAYERS = 10              # lineage runs from each layer of datasets to the next
BATCH = 2_000            # datasets per write
LABELS = ["dataPlatform", "container", "dataset", "schemaField"]
MIB = 1024 * 1024


def urn(kind: str, *ids: int) -> str:
    return f"urn:bench:{kind}:" + ":".join(str(i) for i in ids)


def _peak_mib() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


async def _seed(graph, datasets: int) -> None:
    schemas = -(-datasets // PER_SCHEMA)
    databases = -(-schemas // PER_DATABASE)
    platforms = -(-databases // PER_PLATFORM)
    from backend.app.providers.index_policy import INDEXED_NODE_PROPS

    for label in LABELS:
        for prop in INDEXED_NODE_PROPS:
            await graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")

    node = ("{urn: 'urn:bench:%s:' + %s, displayName: %s, qualifiedName: %s, description: '', "
            "tags: '[]', layerAssignment: '', childCount: %s, sourceSystem: 'bench', "
            "lastSyncedAt: '', propertiesRaw: '{}', searchableText: toLower(%s + ' ' + %s)}")
    contains = "CREATE (a)-[:CONTAINS {confidence: 1.0, properties: '{}'}]->(b)"

    async def each(cypher: str, total: int, step: int, **params: Any) -> None:
        for lo in range(0, total, step):
            await graph.query(cypher, {"lo": lo, "hi": min(total, lo + step) - 1, **params})

    await each("UNWIND range($lo, $hi) AS p CREATE (:dataPlatform "
               + node % ("p", "toString(p)", "'platform_' + toString(p)", "'platform_' + toString(p)",
                         str(PER_PLATFORM), "'platform_' + toString(p)", "''") + ")", platforms, BATCH)
    await each("UNWIND range($lo, $hi) AS d CREATE (:container "
               + node % ("db", "toString(d)", "'db_' + toString(d)", "'db_' + toString(d)",
                         str(PER_DATABASE), "'db_' + toString(d)", "''") + ")", databases, BATCH)
    await each("UNWIND range($lo, $hi) AS s CREATE (:container "
               + node % ("s", "toString(s)", "'schema_' + toString(s)",
                         f"'db_' + toString(s / {PER_DATABASE}) + '.schema_' + toString(s)",
                         str(PER_SCHEMA), "'schema_' + toString(s)", "''") + ")", schemas, BATCH)
    await each("UNWIND range($lo, $hi) AS i CREATE (:dataset "
               + node % ("ds", "toString(i)", "'dataset_' + toString(i)",
                         f"'schema_' + toString(i / {PER_SCHEMA}) + '.dataset_' + toString(i)",
                         str(FIELDS), "'dataset_' + toString(i)", f"'schema_' + toString(i / {PER_SCHEMA})")
               + ")", datasets, BATCH * 10)
    await each(f"UNWIND range($lo, $hi) AS i UNWIND range(0, {FIELDS - 1}) AS f CREATE (:schemaField "
               + node % ("f", "toString(i) + ':' + toString(f)", "'col_' + toString(f)",
                         "'dataset_' + toString(i) + '.col_' + toString(f)", "0",
                         "'col_' + toString(f)", "'dataset_' + toString(i)") + ")", datasets, BATCH)

    await each("UNWIND range($lo, $hi) AS d "
               f"MATCH (a:dataPlatform {{urn: 'urn:bench:p:' + toString(d / {PER_PLATFORM})}}) "
               "MATCH (b:container {urn: 'urn:bench:db:' + toString(d)}) " + contains, databases, BATCH)
    await each("UNWIND range($lo, $hi) AS s "
               f"MATCH (a:container {{urn: 'urn:bench:db:' + toString(s / {PER_DATABASE})}}) "
               "MATCH (b:container {urn: 'urn:bench:s:' + toString(s)}) " + contains, schemas, BATCH)
    await each("UNWIND range($lo, $hi) AS i "
               f"MATCH (a:container {{urn: 'urn:bench:s:' + toString(i / {PER_SCHEMA})}}) "
               "MATCH (b:dataset {urn: 'urn:bench:ds:' + toString(i)}) " + contains, datasets, BATCH)
    await each("UNWIND range($lo, $hi) AS i MATCH (a:dataset {urn: 'urn:bench:ds:' + toString(i)}) "
               f"UNWIND range(0, {FIELDS - 1}) AS f "
               "MATCH (b:schemaField {urn: 'urn:bench:f:' + toString(i) + ':' + toString(f)}) "
               + contains, datasets, BATCH)
    # Lineage: two upstream fields for every field past the first layer, and
    # four upstream datasets for every dataset — picked by a fixed hash, so
    # every run builds the same graph.
    per_layer = datasets // LAYERS
    await each(f"UNWIND range($lo, $hi) AS i WITH i WHERE i % {LAYERS} > 0 "
               f"UNWIND range(0, {FIELDS - 1}) AS f UNWIND range(0, 1) AS k "
               f"WITH i, f, ((i * 7919 + f * 104729 + k * 1299709) % {per_layer}) * {LAYERS} "
               f"+ (i % {LAYERS}) - 1 AS j, (f + k) % {FIELDS} AS g "
               "MATCH (a:schemaField {urn: 'urn:bench:f:' + toString(j) + ':' + toString(g)}) "
               "MATCH (b:schemaField {urn: 'urn:bench:f:' + toString(i) + ':' + toString(f)}) "
               "CREATE (a)-[:TRANSFORMS {confidence: 0.9, properties: '{\"logic\": \"direct\"}'}]->(b)",
               datasets, BATCH)
    await each(f"UNWIND range($lo, $hi) AS i WITH i WHERE i % {LAYERS} > 0 UNWIND range(0, 3) AS k "
               f"WITH i, ((i * 15485863 + k * 32452843) % {per_layer}) * {LAYERS} + (i % {LAYERS}) - 1 AS j "
               "MATCH (a:dataset {urn: 'urn:bench:ds:' + toString(j)}) "
               "MATCH (b:dataset {urn: 'urn:bench:ds:' + toString(i)}) "
               "CREATE (a)-[:TRANSFORMS {confidence: 0.8, properties: '{}'}]->(b)", datasets, BATCH)


async def _timed(fn: Callable[[], Awaitable[Any]], runs: int) -> Dict[str, Any]:
    """The first run (FalkorDB plans it) and the median of the rest."""
    times: List[float] = []
    result = None
    for _ in range(runs + 1):
        started = time.perf_counter()
        result = await fn()
        times.append(time.perf_counter() - started)
    return {"first": times[0], "median": statistics.median(times[1:]) if runs else times[0],
            "result": result}


async def main() -> None:
    args = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    args.add_argument("--host", default="localhost")
    args.add_argument("--port", type=int, default=6379)
    args.add_argument("--graph", default="bench_large")
    args.add_argument("--datasets", type=int, default=200_000)
    args.add_argument("--runs", type=int, default=3)
    args.add_argument("--keep", action="store_true")
    opts = args.parse_args()
    if opts.datasets % LAYERS:
        raise SystemExit(f"--datasets must be a multiple of {LAYERS}")

    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.providers.falkordb_search.engine import (
        execute_count_session,
        execute_session_search,
    )
    from backend.app.services.deep_search import SearchRunContext
    from backend.app.services.native_query.cypher_text import inline_params
    from backend.app.services.native_query.guard import FALKORDB, check
    from backend.app.services.native_query.limit import cap_rows
    from backend.common.interfaces.native_query import NativeQueryError
    from backend.common.models.search import NodeRef, SearchQuery, SearchScope

    p = FalkorDBProvider(host=opts.host, port=opts.port, graph_name=opts.graph, auth_enabled=False)
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    p.set_resolved_edge_metadata({"TRANSFORMS": {"isLineage": True}}, ["TRANSFORMS"])
    await p._ensure_connected()
    rows: List[List[str]] = []

    def say(what: str, *cells: Any) -> None:
        rows.append([what, *[f"{c:,.0f}" if isinstance(c, (int, float)) and not isinstance(c, bool)
                             else str(c) for c in cells]])
        print(" | ".join(rows[-1]), flush=True)

    existing = 0
    if opts.keep:
        try:
            existing = (await p._graph.query("MATCH (n:dataset) RETURN count(n)")).result_set[0][0]
        except Exception:                                 # noqa: BLE001 — no graph yet
            pass
    if existing != opts.datasets:
        started = time.perf_counter()
        await p._graph.query("RETURN 1")
        try:
            await p._graph.delete()
        except Exception:                                 # noqa: BLE001 — nothing to delete
            pass
        await _seed(p._graph, opts.datasets)
        say("seeded (s)", time.perf_counter() - started)
    counts = (await p._graph.query("MATCH (n) RETURN count(n)")).result_set[0][0]
    edges = (await p._graph.query("MATCH ()-[r]->() RETURN count(r)")).result_set[0][0]
    say("graph", f"{counts:,} nodes", f"{edges:,} edges")

    scope = SearchScope(view_id="bench", scope_mode="data_source")

    def feeds(target: str, container: bool) -> Dict[str, Any]:
        is_ = {"kind": "is", "refs": [{"urn": target}]}
        where = ({"kind": "group", "op": "or", "children": [
            is_, {"kind": "related", "axis": "ancestor", "where": is_}]} if container else is_)
        return {"kind": "related", "axis": "upstream", "maxHops": 3, "where": where}

    def query(predicate: Dict[str, Any], **options: Any) -> SearchQuery:
        return SearchQuery.model_validate({
            "predicate": predicate, "scope": scope.model_dump(by_alias=True),
            "options": {"results": "hits", "pageSize": 200, **options}})

    def matches(count: Optional[int], exact: bool) -> str:
        return f"{count or 0:,}{'' if exact else '+'} matches"

    async def complete(q: SearchQuery) -> str:
        """Ask again until the page is complete, as the panel does."""
        version = str(time.monotonic_ns())                # a cold session each run
        for _ in range(400):
            page = await execute_session_search(p, q, context=SearchRunContext(data_version=version))
            if page.status == "complete":
                return matches(page.total_count, page.count_status == "exact")
        raise RuntimeError("the search never completed")

    async def exact(q: SearchQuery) -> str:
        """The count the match bar finishes beside the first page."""
        version, session = str(time.monotonic_ns()), None
        for _ in range(2000):
            answer = await execute_count_session(p, q.model_copy(update={"options": q.options.model_copy(
                update={"wait_ms": 1000, "session_id": session})}),
                context=SearchRunContext(data_version=version))
            session = answer["sessionId"]
            if answer["status"] == "complete":
                return matches(answer["count"], True)
        raise RuntimeError("the count never completed")

    middle = opts.datasets // 2 + 3                       # a dataset in layer 3
    # A field in the same layer that feeds something: one of the fields the
    # seed made an upstream of field 4 of the next dataset.
    nxt = middle + 1
    feeder = ((nxt * 7919 + 4 * 104729) % (opts.datasets // LAYERS)) * LAYERS + nxt % LAYERS - 1
    schema, database = middle // PER_SCHEMA, middle // PER_SCHEMA // PER_DATABASE
    in_schema = min(PER_SCHEMA, opts.datasets - schema * PER_SCHEMA) * FIELDS
    in_database = min(PER_SCHEMA * PER_DATABASE, opts.datasets - database * PER_SCHEMA * PER_DATABASE) * FIELDS
    for what, target, container in [
        ("What this feeds: a field", urn("f", feeder, 4), False),
        (f"What this feeds: a dataset ({FIELDS} fields)", urn("ds", middle), True),
        (f"What this feeds: a schema ({in_schema:,} fields)", urn("s", schema), True),
        (f"What this feeds: a database ({in_database:,} fields)", urn("db", database), True),
    ]:
        q = query(feeds(target, container))
        t = await _timed(lambda: complete(q), opts.runs)
        say(what + ", first page", t["result"], f"first {t['first'] * 1000:,.0f} ms",
            f"median {t['median'] * 1000:,.0f} ms")
        t = await _timed(lambda: exact(q), 0)
        say(what + ", exact count", t["result"], f"{t['first'] * 1000:,.0f} ms")

    explained = await _timed(lambda: p.deep_search_explain(query(
        feeds(urn("s", middle // PER_SCHEMA), True))), opts.runs)
    inlined = inline_params(explained["result"]["cypher"], explained["result"].get("params") or {})
    say("Explain a container question", f"median {explained['median'] * 1000:,.1f} ms",
        f"{len(inlined or '')} chars written in")

    async def suggestions(word: str) -> str:
        """As the name picker asks: what it has found within 0.8 s."""
        page = await execute_session_search(p, query(
            {"kind": "text", "target": "name", "match": "substring", "value": word},
            pageSize=8, waitMs=800, includeAncestorPath=True),
            context=SearchRunContext(data_version=str(time.monotonic_ns())))
        return f"{len(page.hits or [])} shown"

    word = f"dataset_{middle // 10}"
    names = await _timed(lambda: suggestions(word), opts.runs)
    say(f"Name suggestions for {word!r}", names["result"], f"median {names['median'] * 1000:,.0f} ms")
    path = [f"platform_{middle // PER_SCHEMA // PER_DATABASE // PER_PLATFORM}",
            f"db_{middle // PER_SCHEMA // PER_DATABASE}", f"schema_{middle // PER_SCHEMA}",
            f"dataset_{middle}"]
    resolved = await _timed(lambda: p.deep_search_resolve_refs(
        scope, [NodeRef(path=path), NodeRef(path=["**", f"dataset_{middle}"])],
        context=SearchRunContext(data_version="bench")), opts.runs)
    say("Name paths (full, and ** / name)",
        "/".join(str(len(r["urns"])) for r in resolved["result"]),
        f"median {resolved['median'] * 1000:,.0f} ms")

    async def native(cypher: str, *, limit: int = 200, timeout_ms: int = 10_000,
                     max_reply_bytes: int = 16 * MIB):
        capped = cap_rows(cypher, check(cypher, engine=FALKORDB), limit=limit, engine=FALKORDB)
        try:
            result = await p.run_readonly_cypher(capped.text, row_cap=limit + 1,
                                                 timeout_ms=timeout_ms, max_reply_bytes=max_reply_bytes)
            return f"{len(result.rows):,} rows"
        except NativeQueryError as exc:
            return f"{exc.code}"

    for what, cypher, kw in [
        ("Native: a sample of datasets", "MATCH (d:dataset) RETURN d LIMIT 25", {}),
        ("Native: 3 hops downstream of a field",
         f"MATCH (s:schemaField {{urn: '{urn('f', feeder, 4)}'}})-[:TRANSFORMS*1..3]->(t) "
         "RETURN DISTINCT t.urn", {}),
        ("Native: count every field", "MATCH (f:schemaField) RETURN count(f)", {}),
        ("Native: every dataset name, 1,000 rows shown",
         "MATCH (d:dataset) RETURN d.displayName", {"limit": 1000}),
        ("Native: 8 hops from every field, 2 s allowed",
         "MATCH (a:schemaField)-[:TRANSFORMS*1..8]->(b) RETURN count(b)", {"timeout_ms": 2000}),
        ("Native: every field's text as one value, 16 MiB cap",
         "MATCH (f:schemaField) RETURN collect(f.searchableText)", {}),
    ]:
        before = _peak_mib()
        t = await _timed(lambda: native(cypher, **kw), 1)
        say(what, t["result"], f"median {t['median'] * 1000:,.0f} ms",
            f"peak memory {before:,.0f} -> {_peak_mib():,.0f} MiB")

    print("\n| What | Result | | |\n|---|---|---|---|")
    for row in rows:
        print("| " + " | ".join(row + [""] * (4 - len(row))) + " |")
    if not opts.keep:
        await p._graph.delete()
    await p.close()


if __name__ == "__main__":
    asyncio.run(main())
