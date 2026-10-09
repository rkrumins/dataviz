#!/usr/bin/env python3
"""Time the search engine's building blocks on a real FalkorDB — the S0 spike.

Runs against a graph from ``seed_search_bench`` and prints a Markdown report
(``docs/search-engine/S0_FINDINGS.md`` quotes one). Every predicate is
compiled by the REAL compiler (``falkordb_deep_search._Compiler``), so what is
timed is the typed Cypher production runs, not a hand-written stand-in.

Measured per predicate:

* ``capped``   — today's candidate scan, ``MATCH (n) WHERE … WITH n LIMIT
                 10000`` — fast only because it stops;
* ``exact``    — one statement counting every match, all labels;
* ``chunked``  — the no-cap engine's unit of work: ``SchemaField`` scanned in
                 ``ID(n)`` ranges, each chunk returning its exact count AND its
                 ordered top-50, sequentially and 4-way concurrent; the chunk
                 counts must add up to the exact count.

Then the other planned statements: rule membership for on-screen URNs (plain
boolean projections, and each wrapped in ``ANY(… WHERE …)``, where FalkorDB
short-circuits), ten rule counts (one ``WHERE`` count per rule, and all ten
summed in one scan), value suggestions, and upward containment ancestry.

Run::

    python -m backend.scripts.bench_search_engine --host localhost \\
        --port 6379 --graph search_bench
"""
from __future__ import annotations

import argparse
import asyncio
import random
import statistics
import time
from typing import Any, Callable, Dict, List, Tuple

from falkordb import FalkorDB
from falkordb.asyncio import FalkorDB as AsyncFalkorDB
from redis.asyncio import BlockingConnectionPool

from backend.app.providers.falkordb_deep_search import _Compiler, suggest_property_values
from backend.common.models.search import (
    HasPropertyPredicate,
    PropertyPredicate,
    TextPredicate,
)


LABEL = "SchemaField"
TOP_K = 50
TIMEOUT_MS = 120_000


def compile_where(pred) -> Tuple[str, Dict[str, Any]]:
    c = _Compiler(lineage_edge_types={"TRANSFORMS"}, containment_edge_types={"CONTAINS"})
    return c.compile(pred), c.params


def timed(fn: Callable[[], Any]) -> Tuple[float, Any]:
    t0 = time.perf_counter()
    out = fn()
    return (time.perf_counter() - t0) * 1000, out


def predicates(g) -> List[Tuple[str, Any]]:
    sample = g.query(f"MATCH (n:{LABEL}) WHERE ID(n) % 997 = 1 "
                     "RETURN n.gvHash, n.owner LIMIT 1").result_set[0]
    return [
        ("name contains (text)", TextPredicate(value="field_12", target="name")),
        ("gvHash = exact int64", PropertyPredicate(
            key="gvHash", op="eq", value=str(sample[0]), value_type="number")),
        ("gvHash = int64 (auto, as text)", PropertyPredicate(
            key="gvHash", op="eq", value=str(sample[0]))),
        ("gvHash contains '74'", PropertyPredicate(key="gvHash", op="contains", value="74")),
        ("sourceId > 50000 (numeric text)", PropertyPredicate(
            key="sourceId", op="gt", value=50000, value_type="number")),
        ("score between 0.2 and 0.3", PropertyPredicate(
            key="score", op="between", value=[0.2, 0.3], value_type="number")),
        ("updated within last 30 days", PropertyPredicate(
            key="updated", op="withinLast", value="P30D")),
        ("labels has all (pii, gold)", PropertyPredicate(
            key="labels", op="containsAll", value=["pii", "gold"])),
        ("owner is one of 3", PropertyPredicate(
            key="owner", op="in", value=[sample[1], "data-ml-1", "ops-core-2"])),
        ("tier is empty", PropertyPredicate(key="tier", op="isEmpty")),
        ("isPii is true (mixed kinds)", PropertyPredicate(
            key="isPii", op="eq", value=True, value_type="boolean")),
        ("has a property named *own*", HasPropertyPredicate(key="own", key_match="contains")),
    ]


def raw_baselines() -> List[Tuple[str, str, Dict[str, Any]]]:
    return [
        ("RAW n.tier = 'gold'", "n.tier = $v", {"v": "gold"}),
        ("RAW n.score > 0.5", "n.score > $v", {"v": 0.5}),
    ]


async def chunked(pool_graph, where: str, params: Dict[str, Any], max_id: int,
                  width: int, concurrency: int) -> Tuple[float, int, List[float]]:
    sem = asyncio.Semaphore(concurrency)
    latencies: List[float] = []
    total = 0
    q = (f"MATCH (n:{LABEL}) WHERE ID(n) >= $lo AND ID(n) < $hi AND {where} "
         "WITH n ORDER BY n.displayName, n.urn "
         "WITH count(n) AS c, collect([n.urn, n.displayName]) AS rows "
         f"RETURN c, rows[..{TOP_K}]")

    async def one(lo: int) -> None:
        nonlocal total
        async with sem:
            t0 = time.perf_counter()
            res = await pool_graph.ro_query(q, {**params, "lo": lo, "hi": lo + width},
                                            timeout=TIMEOUT_MS)
            latencies.append((time.perf_counter() - t0) * 1000)
            total += res.result_set[0][0]

    t0 = time.perf_counter()
    await asyncio.gather(*(one(lo) for lo in range(0, max_id + 1, width)))
    return (time.perf_counter() - t0) * 1000, total, latencies


def fmt(ms: float) -> str:
    return f"{ms / 1000:.2f} s" if ms >= 1000 else f"{ms:.0f} ms"


async def main_async(a) -> None:
    db = FalkorDB(host=a.host, port=a.port)
    g = db.select_graph(a.graph)
    pool = BlockingConnectionPool(host=a.host, port=a.port, max_connections=8, timeout=None)
    ag = AsyncFalkorDB(connection_pool=pool).select_graph(a.graph)

    counts = dict(g.query("MATCH (n) RETURN labels(n)[0], count(n)").result_set)
    ms_max, rs = timed(lambda: g.query("MATCH (n) RETURN max(ID(n))").result_set)
    max_id = rs[0][0]
    print(f"# Search engine building blocks — `{a.graph}`\n")
    print(f"Nodes: {sum(counts.values()):,} ({', '.join(f'{k} {v:,}' for k, v in sorted(counts.items()))}); "
          f"max node ID {max_id:,} (read in {fmt(ms_max)}).\n")

    print("## Predicates\n")
    print("| predicate | matches | capped (10k) | exact, one statement | "
          f"{LABEL} chunks {a.width // 1000}k × 1 | × 4 concurrent | chunk p95 | sums agree |")
    print("|---|---:|---:|---:|---:|---:|---:|:---:|")
    cases: List[Tuple[str, str, Dict[str, Any]]] = []
    for name, pred in predicates(g):
        where, params = compile_where(pred)
        cases.append((name, where, params))
    cases.extend(raw_baselines())
    for name, where, params in cases:
        ms_cap, _ = timed(lambda: g.ro_query(
            f"MATCH (n) WHERE {where} WITH n LIMIT 10000 RETURN count(n)", params,
            timeout=TIMEOUT_MS))
        ms_exact, res = timed(lambda: g.ro_query(
            f"MATCH (n) WHERE {where} RETURN count(n)", params, timeout=TIMEOUT_MS))
        exact_all = res.result_set[0][0]
        label_exact = g.ro_query(f"MATCH (n:{LABEL}) WHERE {where} RETURN count(n)",
                                 params, timeout=TIMEOUT_MS).result_set[0][0]
        ms_seq, total_seq, lat_seq = await chunked(ag, where, params, max_id, a.width, 1)
        ms_par, total_par, lat_par = await chunked(ag, where, params, max_id, a.width, 4)
        p95 = statistics.quantiles(lat_par + lat_seq, n=20)[-1] if len(lat_par) > 1 else lat_par[0]
        agree = "yes" if total_seq == total_par == label_exact else f"NO ({total_seq}/{total_par}/{label_exact})"
        print(f"| {name} | {exact_all:,} | {fmt(ms_cap)} | {fmt(ms_exact)} | {fmt(ms_seq)} "
              f"| {fmt(ms_par)} | {fmt(p95)} | {agree} |", flush=True)

    rng = random.Random(1)
    field_count = counts.get(LABEL, 0)
    urns = [f"urn:bench:schemafield:{rng.randrange(field_count)}" for _ in range(1000)]
    rules = [compile_where(p)[0:2] for _, p in predicates(g)[:10]]
    # One parameter namespace for all ten rules.
    projections, params = [], {"urns": urns}
    for i, (where, p) in enumerate(rules):
        renamed = where
        for k in sorted(p, key=len, reverse=True):
            renamed = renamed.replace(f"${k}", f"$r{i}_{k}")
            params[f"r{i}_{k}"] = p[k]
        projections.append((i, renamed))
    print("\n## Other statements\n")
    print("| statement | time |")
    print("|---|---:|")
    for name, wrap in (("plain projections", "({w})"),
                       ("each wrapped in ANY(… WHERE …)", "ANY(_z IN [0] WHERE {w})")):
        # Best of three: the first run also warms the URN index pages.
        ms = min(timed(lambda: g.ro_query(
            f"MATCH (n:{LABEL}) WHERE n.urn IN $urns RETURN n.urn, "
            + ", ".join(wrap.format(w=w) + f" AS m{i}" for i, w in projections),
            params, timeout=TIMEOUT_MS))[0] for _ in range(3))
        print(f"| membership: 1,000 on-screen URNs × 10 rules, {name} | {fmt(ms)} |")

    async def rule_counts() -> None:
        sem = asyncio.Semaphore(4)

        async def one(where: str) -> None:
            async with sem:
                await ag.ro_query(f"MATCH (n:{LABEL}) WHERE {where} RETURN count(n)",
                                  params, timeout=TIMEOUT_MS)
        await asyncio.gather(*(one(w) for _, w in projections))

    t0 = time.perf_counter()
    await rule_counts()
    print(f"| 10 rule counts over {LABEL}, one WHERE count per rule, 4 concurrent "
          f"| {fmt((time.perf_counter() - t0) * 1000)} |")
    sums = ", ".join(f"sum(CASE WHEN {w} THEN 1 ELSE 0 END) AS c{i}" for i, w in projections)
    ms, _ = timed(lambda: g.ro_query(f"MATCH (n:{LABEL}) RETURN {sums}", params, timeout=TIMEOUT_MS))
    print(f"| 10 rule counts in one {LABEL} scan, summed in projections | {fmt(ms)} |")

    class _Provider:
        async def _ro_query(self, cypher, params=None, timeout=None):
            return await ag.ro_query(cypher, params or {}, timeout=TIMEOUT_MS)

    for key, q in (("owner", ""), ("owner", "ml"), ("labels", ""), ("sourceId", "12")):
        t0 = time.perf_counter()
        out = await suggest_property_values(_Provider(), key=key, q=q, limit=25, budget_s=60)
        print(f"| value suggestions `{key}` q={q!r} (top 25, complete={out['complete']}) "
              f"| {fmt((time.perf_counter() - t0) * 1000)} |")
    ms, _ = timed(lambda: g.ro_query(
        f"MATCH (n:{LABEL}) WHERE n.urn IN $urns OPTIONAL MATCH (n)<-[:CONTAINS*1..12]-(a) "
        "RETURN n.urn, collect(a.urn)", {"urns": urns[:1000]}, timeout=TIMEOUT_MS))
    print(f"| upward ancestry for 1,000 URNs | {fmt(ms)} |")
    await pool.aclose()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--graph", default="search_bench")
    ap.add_argument("--width", type=int, default=200_000,
                    help="ID-range width per chunk.")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
