"""Benchmark spike for the aggregation pipeline's FalkorDB assumptions.

Validates, against a LIVE FalkorDB, the two benchmark-gated assumptions of
``backend/app/providers/falkordb_materialize.py`` plus the server-side
write-kill behavior:

  (a) **ID-range edge scans** (``WHERE ID(r) >= lo AND ID(r) < hi``, no
      ORDER BY/LIMIT) vs the legacy sorted-page scan
      (``WHERE ID(r) > rid ORDER BY ID(r) LIMIT n``) — the legacy form is
      O(E²) across a full scan; the range form should be near-linear.
  (b) **label+urn MERGE** (the pipeline's hard rule) vs ID-seek MERGE
      (``UNWIND … MATCH (a) WHERE ID(a) = item.aid``) — the ID-seek arm
      demonstrates the BANNED pattern's cost: FalkorDB does not drive
      ``WHERE ID(a) = x`` from a NodeByIdSeek under UNWIND, so it scans
      all nodes per row. "ID-seek slower" is the expected outcome.
  (c) **Write-query kill**: a deliberately pathological write issued with
      a per-query timeout must be killed server-side. This only works when
      the server is started with ``TIMEOUT_MAX`` configured (see
      FALKORDB_ARGS in docker-compose / the statefulset) — run against a
      server without it to see the difference.

Usage (defaults target the docker-compose FalkorDB):

    python -m backend.scripts.benchmark_aggregation_scan \
        --host localhost --port 6379 --graph bench_agg \
        --nodes 200000 --edges 1000000

Scale the node/edge counts up (e.g. 2M/5M) for a full-scale soak run.
The graph is created if missing and left in place for re-runs; pass
--drop to delete it first.
"""
import argparse
import asyncio
import statistics
import sys
import time

from falkordb.asyncio import FalkorDB


async def _seed(g, nodes: int, edges: int, batch: int = 5000) -> None:
    res = await g.query("MATCH (n) RETURN count(n)")
    existing = res.result_set[0][0] if res.result_set else 0
    if existing >= nodes:
        print(f"seed: graph already has {existing} nodes — skipping seed")
        return
    print(f"seed: creating {nodes} nodes …")
    t0 = time.monotonic()
    for start in range(0, nodes, batch):
        chunk = [
            {"i": i, "urn": f"urn:bench:{i}"}
            for i in range(start, min(start + batch, nodes))
        ]
        await g.query(
            "UNWIND $batch AS item CREATE (:bench {urn: item.urn, idx: item.i})",
            params={"batch": chunk},
        )
    await g.query("CREATE INDEX FOR (n:bench) ON (n.urn)")
    print(f"seed: nodes done in {time.monotonic() - t0:.1f}s; creating {edges} edges …")
    t0 = time.monotonic()
    import random
    rng = random.Random(42)
    for start in range(0, edges, batch):
        chunk = [
            {"s": rng.randrange(nodes), "t": rng.randrange(nodes)}
            for _ in range(min(batch, edges - start))
        ]
        await g.query(
            "UNWIND $batch AS item "
            "MATCH (a:bench {urn: 'urn:bench:' + toString(item.s)}) "
            "MATCH (b:bench {urn: 'urn:bench:' + toString(item.t)}) "
            "CREATE (a)-[:FLOWS]->(b)",
            params={"batch": chunk},
        )
        if (start // batch) % 20 == 0:
            print(f"  edges {start}/{edges} ({time.monotonic() - t0:.0f}s)")
    print(f"seed: edges done in {time.monotonic() - t0:.1f}s")


async def bench_scan(g, *, range_width: int, pages: int) -> None:
    print("\n=== (a) edge scan: ID-range vs ORDER BY page ===")
    res = await g.ro_query("MATCH ()-[r:FLOWS]->() RETURN max(ID(r))")
    max_id = res.result_set[0][0] or 0

    # ID-range scan over the first `pages` ranges
    range_times = []
    rows_total = 0
    for k in range(pages):
        lo, hi = k * range_width, (k + 1) * range_width
        if lo > max_id:
            break
        t0 = time.monotonic()
        res = await g.ro_query(
            "MATCH (s)-[r:FLOWS]->(t) WHERE ID(r) >= $lo AND ID(r) < $hi "
            "RETURN ID(s), ID(t)",
            params={"lo": lo, "hi": hi},
        )
        range_times.append(time.monotonic() - t0)
        rows_total += len(res.result_set or [])
    print(
        f"ID-range: {len(range_times)} ranges x {range_width} width, "
        f"{rows_total} rows | per-range avg {statistics.mean(range_times)*1000:.0f}ms "
        f"p95 {sorted(range_times)[int(len(range_times)*0.95)-1]*1000:.0f}ms"
    )

    # Legacy sorted page scan (same row budget) — expect per-page cost to
    # GROW with the cursor position (each page re-scans + sorts all edges).
    legacy_times = []
    rid = -1
    fetched = 0
    page_size = 1000
    while fetched < rows_total and len(legacy_times) < 50:
        t0 = time.monotonic()
        res = await g.ro_query(
            "MATCH (s)-[r:FLOWS]->(t) WHERE ID(r) > $rid "
            "RETURN ID(r), ID(s), ID(t) ORDER BY ID(r) LIMIT $limit",
            params={"rid": rid, "limit": page_size},
        )
        legacy_times.append(time.monotonic() - t0)
        rows = res.result_set or []
        if not rows:
            break
        rid = rows[-1][0]
        fetched += len(rows)
    print(
        f"legacy page: {len(legacy_times)} pages x {page_size} | "
        f"first {legacy_times[0]*1000:.0f}ms, last {legacy_times[-1]*1000:.0f}ms, "
        f"avg {statistics.mean(legacy_times)*1000:.0f}ms  "
        f"(extrapolate: full scan needs E/{page_size} pages at ~avg cost)"
    )


async def bench_merge(g, *, items: int = 5000) -> None:
    print("\n=== (b) MERGE: ID-seek vs label+urn ===")
    res = await g.ro_query(
        "MATCH (n:bench) RETURN ID(n), n.urn LIMIT $n", params={"n": items * 2},
    )
    rows = res.result_set or []
    pairs = [
        {"aid": rows[i][0], "bid": rows[i + 1][0],
         "s": rows[i][1], "t": rows[i + 1][1],
         "k": f"{rows[i][1]}|{rows[i+1][1]}", "w": 1}
        for i in range(0, len(rows) - 1, 2)
    ]
    await g.query("CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.aggKey)")

    t0 = time.monotonic()
    await g.query(
        "UNWIND $batch AS item "
        "MATCH (a) WHERE ID(a) = item.aid MATCH (b) WHERE ID(b) = item.bid "
        "MERGE (a)-[r:AGGREGATED {aggKey: item.k}]->(b) SET r.weight = item.w",
        params={"batch": pairs},
    )
    id_seek = time.monotonic() - t0

    t0 = time.monotonic()
    await g.query(
        "UNWIND $batch AS item "
        "MATCH (a:bench {urn: item.s}) MATCH (b:bench {urn: item.t}) "
        "MERGE (a)-[r:AGGREGATED {aggKey: item.k}]->(b) SET r.weight = item.w",
        params={"batch": pairs},
    )
    urn_seek = time.monotonic() - t0
    print(f"ID-seek MERGE   : {len(pairs)} pairs in {id_seek*1000:.0f}ms")
    print(f"label+urn MERGE : {len(pairs)} pairs in {urn_seek*1000:.0f}ms")
    if id_seek > urn_seek * 1.5:
        print("OK — ID-seek slower, as expected: FalkorDB scans all nodes "
              "per UNWIND row for ID equality. label+urn (the pipeline's "
              "write form, falkordb_materialize._write_items) is correct.")
    else:
        print("?? ID-seek kept pace with label+urn on this build — the "
              "pipeline still uses label+urn (index seeks scale with the "
              "graph); re-measure at higher --nodes before drawing "
              "conclusions.")


async def bench_write_kill(g) -> None:
    print("\n=== (c) server-side write kill (requires TIMEOUT_MAX) ===")
    t0 = time.monotonic()
    try:
        # Pathological cartesian write with a 2s per-query timeout.
        await g.query(
            "MATCH (a:bench), (b:bench) WITH a, b LIMIT 50000000 "
            "MERGE (a)-[:BENCH_KILL]->(b)",
            timeout=2000,
        )
        print("!! query completed — either the graph is tiny or the timeout "
              "was ignored")
    except Exception as exc:
        elapsed = time.monotonic() - t0
        killed = "timed out" in str(exc).lower() or "timeout" in str(exc).lower()
        print(
            f"query terminated after {elapsed:.1f}s with: {exc!r}\n"
            + ("OK — killed server-side near the 2s budget."
               if killed and elapsed < 10 else
               "!! NOT killed by the server near the budget. Check that "
               "FALKORDB_ARGS includes TIMEOUT_MAX (write-query timeouts "
               "are ignored without it).")
        )


async def bench_query_mem(db, g, *, range_width: int) -> None:
    """Pin the premise the scan shrink ladder rests on: that NARROWING an
    ID range actually reduces a query's accounted memory.

    It holds because FalkorDB materializes a query's entire result set
    inside the tracked per-query budget rather than streaming it, and these
    scans are plain projections with no sort or aggregation buffer — so the
    tracked bytes track the rows returned. If this ever prints a FLAT
    result on a newer engine, the ladder cannot help and the fix has to move
    to narrowing the PROJECTION instead of the range.

    Squeezes QUERY_MEM_CAPACITY down, sweeps the width, and restores the
    original ceiling. Uses the node-directory projection (id + urn +
    labels), the widest shape this script's seed can produce.
    """
    print("\n=== (d) per-query memory ceiling vs range width ===")
    try:
        prev = int(await db.config_get("QUERY_MEM_CAPACITY"))
    except Exception as exc:
        print(f"!! cannot read QUERY_MEM_CAPACITY ({exc!r}) — skipping.")
        return
    # 32 MiB: low enough that the widest sweep step refuses on a seeded
    # graph, high enough that the narrow steps still pass.
    squeezed = 32 * 1024 * 1024
    cypher = (
        "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
        "RETURN ID(n), n.urn, labels(n)"
    )
    widths = [range_width, range_width // 2, range_width // 4, range_width // 8]
    try:
        await db.config_set("QUERY_MEM_CAPACITY", squeezed)
    except Exception as exc:
        print(f"!! cannot set QUERY_MEM_CAPACITY ({exc!r}) — skipping. Start "
              f"the server with a small QUERY_MEM_CAPACITY to run this arm.")
        return
    try:
        outcomes = []
        for w in widths:
            if w < 1:
                continue
            try:
                res = await g.ro_query(cypher, params={"lo": 0, "hi": w})
                outcomes.append((w, True, len(res.result_set or [])))
                print(f"width {w:>9,}: OK ({len(res.result_set or []):,} rows)")
            except Exception as exc:
                refused = "mem consumption exceeded" in str(exc).lower()
                outcomes.append((w, False, 0))
                print(f"width {w:>9,}: {'REFUSED' if refused else repr(exc)}")
    finally:
        try:
            await db.config_set("QUERY_MEM_CAPACITY", prev)
        except Exception as exc:      # pragma: no cover - diagnostics only
            print(f"!! FAILED TO RESTORE QUERY_MEM_CAPACITY to {prev}: {exc!r}")

    refused = [w for w, ok, _ in outcomes if not ok]
    passed = [w for w, ok, _ in outcomes if ok]
    if refused and passed and min(refused) > max(passed):
        print(f"OK — halving recovered a refused scan "
              f"(refused at {min(refused):,}, passed at {max(passed):,}). "
              f"The shrink ladder's premise holds on this engine.")
    elif not refused:
        print("!! nothing was refused — raise --nodes or lower the squeezed "
              "ceiling so the widest step actually trips it.")
    else:
        print("!! EVERY width was refused. Narrowing the range does NOT "
              "reduce accounted query memory on this engine — the ladder "
              "cannot help and the projection must shrink instead.")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--graph", default="bench_agg")
    ap.add_argument("--nodes", type=int, default=200_000)
    ap.add_argument("--edges", type=int, default=1_000_000)
    ap.add_argument("--range-width", type=int, default=250_000)
    ap.add_argument("--pages", type=int, default=8)
    ap.add_argument("--drop", action="store_true")
    args = ap.parse_args()

    # Speaks PLAIN standalone Redis: against a Cluster this reaches only the slots
    # of one node and against Sentinel it can land on a demoted replica — a wipe or
    # GRAPH.DELETE would half-apply and a reindex would silently skip shards.
    from backend.app.providers.falkordb_connection import assert_standalone_env
    assert_standalone_env("benchmark_aggregation_scan.py")
    db = FalkorDB(host=args.host, port=args.port)
    g = db.select_graph(args.graph)
    if args.drop:
        try:
            await g.delete()
        except Exception:
            pass
        g = db.select_graph(args.graph)

    await _seed(g, args.nodes, args.edges)
    await bench_scan(g, range_width=args.range_width, pages=args.pages)
    await bench_merge(g)
    await bench_write_kill(g)
    await bench_query_mem(db, g, range_width=args.range_width)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
