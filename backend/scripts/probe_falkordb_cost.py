"""What the aggregation pipeline actually costs THIS FalkorDB — measured, not argued.

Read-only. Issues no writes and no DDL. Safe to run against production, though
sections 3 and 4 do scan, so run it when you can afford one pass over the graph
(the script reports what each section costs before the next one starts).

    python backend/scripts/probe_falkordb_cost.py --graph <graph_name>

Connection comes from FALKORDB_HOST / FALKORDB_PORT / FALKORDB_PASSWORD, or
--host/--port/--password. --graph may be repeated; with none, every graph key
on the node is listed and you are asked to pick.

WHAT IT ANSWERS

1. Which indices exist, and what they cost in memory. `GRAPH.MEMORY USAGE`
   breaks out an index component; that number against the graph total is the
   standing price of the index set.

2. Whether the `:AGGREGATED` edge indices can be reached at all. FalkorDB uses
   an edge index only when the relationship is the plan's ENTRY POINT. Every
   `:AGGREGATED` read this product issues anchors a node first
   (`WHERE f.urn IN $frontier`, then traverse), so the level and depth indices
   may be unreachable — six index documents per aggregated edge, updated on
   every edge write, serving nothing. This section PROFILEs the real query
   shapes and prints the operators, so the question is settled by the planner
   rather than by reading code. This is the evidence needed before dropping
   anything.

3. What the drift fingerprint used to cost: the three full scans, timed.

4. What it costs now: the constant-time counter reads that replaced them.

Nothing here changes the database. Removing an index is a separate, deliberate
act — this script only tells you whether it would be safe.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    from redis import asyncio as aioredis
except ImportError:  # pragma: no cover - operator-facing script
    print("redis-py is required: pip install redis", file=sys.stderr)
    raise SystemExit(2)


# The read shapes this product actually issues against :AGGREGATED, verbatim in
# structure. Each is PROFILEd; what matters is whether any plan chooses an edge
# index as its entry point.
AGG_READ_SHAPES: List[Tuple[str, str, Dict[str, Any]]] = [
    (
        "expand_level_pair (labelled frontier)",
        # falkordb_provider.py `_build` — the most-executed trace query.
        "MATCH (f:{LABEL})-[r:AGGREGATED]->(other) "
        "WHERE f.urn IN $frontier AND r.sourceLevel = $level AND r.targetLevel = $level "
        "RETURN f.urn, other.urn, r.weight LIMIT 50",
        {"frontier": ["urn:probe:none"], "level": 0},
    ),
    (
        "expand_depth_pair (labelled frontier)",
        "MATCH (f:{LABEL})-[r:AGGREGATED]->(other) "
        "WHERE f.urn IN $frontier AND r.sourceDepth = $d AND r.targetDepth = $d "
        "RETURN f.urn, other.urn, r.weight LIMIT 50",
        {"frontier": ["urn:probe:none"], "d": 0},
    ),
    (
        "expand_depth_pair (UNLABELLED frontier bucket)",
        # The one shape where the node side offers the planner nothing, so an
        # edge index could legitimately win. This is the case that decides
        # whether the depth composite is safe to drop.
        "MATCH (f)-[r:AGGREGATED]->(other) "
        "WHERE f.urn IN $frontier AND r.sourceDepth = $d AND r.targetDepth = $d "
        "RETURN f.urn, other.urn, r.weight LIMIT 50",
        {"frontier": ["urn:probe:none"], "d": 0},
    ),
    (
        "keyed delete probe (unanchored, aggKey)",
        # `_delete_stale` — the one place an edge index is genuinely the entry
        # point. Expect an index scan here; if this one does NOT use it, the
        # reconcile phase is scanning the whole cube per key.
        "MATCH ()-[r:AGGREGATED {aggKey: $k}]->() RETURN ID(r) LIMIT 1",
        {"k": "probe:no-such-key"},
    ),
    (
        "fan-out depth compare (prop-to-prop)",
        "MATCH (x)-[r:AGGREGATED]->(t2) "
        "WHERE x.urn IN $xs AND r.targetDepth <= r.sourceDepth "
        "RETURN x.urn LIMIT 50",
        {"xs": ["urn:probe:none"]},
    ),
]

INDEX_OPERATORS = ("Index Scan", "Edge By Index Scan", "Node By Index Scan")
SCAN_OPERATORS = ("All Node Scan", "AllNodeScan", "Node By Label Scan",
                  "Relationship By Type Scan", "Conditional Traverse")


def _fmt_mb(v: Any) -> str:
    try:
        return f"{float(v):,.1f} MB"
    except (TypeError, ValueError):
        return str(v)


async def _q(client, graph: str, cypher: str, params: Optional[Dict] = None,
             *, ro: bool = True) -> Any:
    cmd = "GRAPH.RO_QUERY" if ro else "GRAPH.QUERY"
    args = [cmd, graph, cypher]
    if params:
        # FalkorDB takes params as a CYPHER prelude.
        prelude = " ".join(
            f"{k}={_literal(v)}" for k, v in params.items()
        )
        args = [cmd, graph, f"CYPHER {prelude} {cypher}"]
    return await client.execute_command(*args)


def _literal(v: Any) -> str:
    if isinstance(v, str):
        return '"' + v.replace('"', '\\"') + '"'
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_literal(x) for x in v) + "]"
    return str(v)


def _rows(reply: Any) -> List[Any]:
    """FalkorDB replies are [header, rows, stats]; PROFILE replies are a plan."""
    if isinstance(reply, list) and len(reply) >= 2 and isinstance(reply[1], list):
        return reply[1]
    return reply if isinstance(reply, list) else [reply]


def _text(v: Any) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else str(v)


async def section_indices(client, graph: str) -> None:
    print(f"\n{'='*72}\n1. INDICES ON {graph}\n{'='*72}")
    try:
        reply = await _q(client, graph, "CALL db.indexes()")
    except Exception as exc:
        print(f"  db.indexes() failed: {exc}")
        return
    rows = _rows(reply)
    if not rows:
        print("  (none)")
    agg_edge = 0
    for row in rows:
        cells = [_text(c) for c in (row or []) if c is not None]
        line = " | ".join(cells)
        print(f"  {line}")
        if "AGGREGATED" in line:
            agg_edge += 1
    print(f"\n  :AGGREGATED index entries: {agg_edge}")

    print(f"\n{'-'*72}\n   MEMORY\n{'-'*72}")
    try:
        mem = await client.execute_command("GRAPH.MEMORY", "USAGE", graph)
    except Exception as exc:
        print(f"  GRAPH.MEMORY USAGE failed ({exc}) — server may not support it")
        return
    flat = [_text(x) for x in (mem or [])]
    pairs = dict(zip(flat[::2], flat[1::2])) if len(flat) % 2 == 0 else {}
    if not pairs:
        for chunk in mem or []:
            if isinstance(chunk, list) and len(chunk) == 2:
                pairs[_text(chunk[0])] = _text(chunk[1])
    total = pairs.get("total_graph_sz_mb")
    for k, v in pairs.items():
        marker = "  <-- the index set" if "indices" in k else ""
        print(f"  {k:<28} {_fmt_mb(v)}{marker}")
    idx = pairs.get("indices_sz_mb")
    if idx and total:
        try:
            pct = float(idx) / float(total) * 100
            print(f"\n  indices are {pct:.1f}% of this graph's memory")
        except (TypeError, ValueError, ZeroDivisionError):
            pass


async def section_plans(client, graph: str, label: str) -> None:
    print(f"\n{'='*72}\n2. DO THE :AGGREGATED EDGE INDICES GET USED?\n{'='*72}")
    print("   An edge index is only reachable when the relationship is the")
    print("   plan's ENTRY POINT. Look for 'Edge By Index Scan'.\n")
    for name, shape, params in AGG_READ_SHAPES:
        cypher = shape.replace("{LABEL}", label)
        print(f"  --- {name}")
        try:
            reply = await _q(client, graph, f"PROFILE {cypher}", params)
        except Exception as exc:
            print(f"      PROFILE failed: {exc}\n")
            continue
        plan = [_text(r) for r in _rows(reply)] if not isinstance(reply, (bytes, str)) else [_text(reply)]
        if len(plan) == 1 and "\n" in plan[0]:
            plan = plan[0].split("\n")
        used_index = False
        for step in plan:
            step = step.rstrip()
            if not step:
                continue
            flag = ""
            if any(op in step for op in INDEX_OPERATORS):
                flag, used_index = "   [INDEX]", True
            elif any(op in step for op in SCAN_OPERATORS):
                flag = "   [scan]"
            print(f"      {step}{flag}")
        print(f"      => edge/node index used: {'YES' if used_index else 'NO'}\n")


async def section_scan_cost(client, graph: str) -> None:
    print(f"\n{'='*72}\n3. WHAT THE OLD DRIFT FINGERPRINT COST (three full scans)\n{'='*72}")
    scans = [
        ("labels + displayName samples",
         "MATCH (n) WITH labels(n)[0] AS lbl, n.displayName AS name "
         "WITH lbl, count(*) AS c, collect(name)[0..3] AS s RETURN lbl, c, s"),
        ("relationship types",
         "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c"),
        ("every node's tags",
         "MATCH (n) WHERE n.tags IS NOT NULL AND n.tags <> '[]' RETURN n.tags"),
    ]
    total = 0.0
    for name, cypher in scans:
        t0 = time.monotonic()
        try:
            await _q(client, graph, cypher)
            dt = time.monotonic() - t0
            total += dt
            note = ""
            if name != "relationship types":
                note = "   <-- computed, then discarded by the digest"
            print(f"  {dt*1000:9.1f} ms  {name}{note}")
        except Exception as exc:
            print(f"  {'FAILED':>9}   {name}: {exc}")
    print(f"  {total*1000:9.1f} ms  TOTAL, per source, per 60s sweep")


async def section_counter_cost(client, graph: str) -> None:
    print(f"\n{'='*72}\n4. WHAT IT COSTS NOW (constant-time counters)\n{'='*72}")
    t0 = time.monotonic()
    try:
        labels = [_text(r[0]) for r in _rows(
            await _q(client, graph, "CALL db.labels() YIELD label RETURN label")) if r]
        rels = [_text(r[0]) for r in _rows(
            await _q(client, graph,
                     "CALL db.relationshipTypes() YIELD relationshipType "
                     "RETURN relationshipType")) if r]
        await _q(client, graph, "MATCH (n) RETURN count(n)")
        await _q(client, graph, "MATCH ()-[r]->() RETURN count(r)")
        for lbl in labels:
            await _q(client, graph, f"MATCH (n:`{lbl}`) RETURN count(n)")
        for rel in rels:
            await _q(client, graph, f"MATCH ()-[r:`{rel}`]->() RETURN count(r)")
        dt = time.monotonic() - t0
        print(f"  {dt*1000:9.1f} ms  {4 + len(labels) + len(rels)} round trips "
              f"({len(labels)} labels, {len(rels)} types)")
        print("\n  Constant in the SIZE of the graph, linear in its SCHEMA — the")
        print("  inverse of the scans above. On a wide schema and a small graph")
        print("  the two converge; the win is on the graphs that hurt.")
    except Exception as exc:
        print(f"  failed: {exc}")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.getenv("FALKORDB_HOST", "localhost"))
    ap.add_argument("--port", type=int, default=int(os.getenv("FALKORDB_PORT", "6379")))
    ap.add_argument("--password", default=os.getenv("FALKORDB_PASSWORD") or None)
    ap.add_argument("--graph", action="append", default=[],
                    help="graph key; repeatable. Omit to list what is there.")
    ap.add_argument("--label", default="dataset",
                    help="a label present in the graph, for the anchored plans")
    ap.add_argument("--skip-scans", action="store_true",
                    help="skip sections 3 and 4 (the timed passes over the graph)")
    args = ap.parse_args()

    client = aioredis.Redis(host=args.host, port=args.port, password=args.password,
                            decode_responses=False, socket_timeout=120)
    try:
        await client.ping()
    except Exception as exc:
        print(f"cannot reach {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 2

    graphs = args.graph
    if not graphs:
        keys = [_text(k) for k in await client.execute_command("GRAPH.LIST")]
        print("Graphs on this node:")
        for k in keys:
            print(f"  {k}")
        print("\nRe-run with --graph <name> (repeatable).")
        await client.aclose()
        return 0

    for graph in graphs:
        print(f"\n\n{'#'*72}\n# {graph}\n{'#'*72}")
        await section_indices(client, graph)
        await section_plans(client, graph, args.label)
        if not args.skip_scans:
            await section_scan_cost(client, graph)
            await section_counter_cost(client, graph)

    print("\n\nWhat to send back: sections 1 and 2 in full. Section 2 decides")
    print("whether the six level/depth edge indices can be dropped; section 1")
    print("says what dropping them would give back.")
    await client.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
