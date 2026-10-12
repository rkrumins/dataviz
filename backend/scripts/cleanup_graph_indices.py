"""Remove the :AGGREGATED edge indexes this product no longer declares.

WHY THIS EXISTS

A FalkorDB edge index is reachable only when the relationship is the plan's
ENTRY POINT — an unanchored ``MATCH ()-[r:T]->() WHERE r.p = $v``. Every
:AGGREGATED read this product issues anchors a node first, so four
single-column indexes it used to create could never be entered through: no
query anywhere filters on ``sourceLevel``, ``targetLevel``, ``sourceDepth`` or
``targetDepth`` ALONE — every predicate on them is a pair.

They were added as a fallback "if the planner does not support composite edge
indexes", but no fallback was implemented: the composite and both singles were
created unconditionally, forever. And nothing in the product has ever issued
DROP INDEX, so the set on a graph only grows.

They cost a document per aggregated edge THREE times over: resident memory, an
update on every edge write, and a rebuild from scratch every time the graph is
loaded off disk — which is a large part of why restarting a node holding a
multi-gigabyte graph takes as long as it does.

The application no longer creates them. This removes the ones already there.

USAGE

    # See what is there and what would go. Changes nothing.
    python backend/scripts/cleanup_graph_indices.py

    # Same, against one cluster node, for two graphs
    python backend/scripts/cleanup_graph_indices.py --host 10.0.0.1 \
        --graph lineage_ws1 --graph lineage_ws2

    # Actually drop them
    python backend/scripts/cleanup_graph_indices.py --apply

SAFETY

* Dry run is the default. ``--apply`` is required to change anything.
* Only indexes on the exact (relationship, property) pairs this product has
  RETIRED are ever dropped. Anything else on the graph — node indexes, the
  aggKey index, the two composites, indexes somebody else made — is left
  alone, and the script says so rather than assuming.
* Cluster-aware: a graph is one key on one shard, so each graph is worked on
  the node that owns it. Run against any node; ``--all-shards`` discovers the
  rest through CLUSTER NODES.
* Dropping is not free to undo: the index would have to be rebuilt, which on a
  large graph is minutes of the node's time. That is why the composites are
  NOT in scope here — settle those with a PROFILE first.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    from redis import asyncio as aioredis
except ImportError:  # pragma: no cover - operator-facing script
    print("redis-py is required: pip install redis", file=sys.stderr)
    raise SystemExit(2)

from backend.app.providers.index_policy import (  # noqa: E402
    CONDITIONAL_EDGE_INDEXES, RETIRED_EDGE_INDEXES, declared_edge_indexes,
)


def _text(v: Any) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else str(v)


def _rows(reply: Any) -> List[Any]:
    """FalkorDB replies are [header, rows, stats]."""
    if isinstance(reply, list) and len(reply) >= 2 and isinstance(reply[1], list):
        return reply[1]
    return reply if isinstance(reply, list) else [reply]


async def _query(client, graph: str, cypher: str, *, ro: bool = True):
    return await client.execute_command(
        "GRAPH.RO_QUERY" if ro else "GRAPH.QUERY", graph, cypher
    )


# ── what is on the graph ─────────────────────────────────────────────────


async def read_index_catalogue(client, graph: str) -> List[Dict[str, Any]]:
    """Every index on the graph, as loosely-typed rows.

    ``db.indexes()`` column order varies by FalkorDB version, so this reads
    by shape rather than by position: collect every string cell of a row and
    let the matcher below look for what it needs. A version whose output we
    cannot parse yields rows we simply do not match, which means we drop
    nothing — the safe direction.
    """
    try:
        reply = await _query(client, graph, "CALL db.indexes()")
    except Exception as exc:
        raise RuntimeError(f"CALL db.indexes() failed on {graph}: {exc}") from exc

    out: List[Dict[str, Any]] = []
    for row in _rows(reply):
        cells: List[str] = []
        for cell in (row or []):
            if isinstance(cell, (list, tuple)):
                cells.extend(_text(c) for c in cell if c is not None)
            elif cell is not None:
                cells.append(_text(cell))
        out.append({"cells": cells, "text": " ".join(cells)})
    return out


def _row_is(row: Dict[str, Any], rel: str, props: Sequence[str]) -> bool:
    """Whether this catalogue row IS the index for (rel, props) — exactly.

    Exactness is the whole safety property. ``sourceDepth`` is a substring of
    nothing else here, but ``props`` must match as a SET and the row must
    carry no OTHER indexed property, or a composite (sourceDepth, targetDepth)
    would match a request to drop (sourceDepth) alone and take the composite
    with it.
    """
    cells = row["cells"]
    if rel not in cells:
        return False
    known = {"aggKey", "sourceLevel", "targetLevel", "sourceDepth", "targetDepth"}
    present = {c for c in cells if c in known}
    return present == set(props)


# ── dropping ─────────────────────────────────────────────────────────────


async def try_drop(client, graph: str, ix, *, apply: bool) -> Tuple[bool, str]:
    """Drop one index, discovering the syntax this build accepts.

    FalkorDB has carried two spellings — the RedisGraph-era
    ``DROP INDEX ON :Rel(prop)`` and the symmetric
    ``DROP INDEX FOR ()-[r:Rel]-() ON (r.prop)``. Which one a build takes is
    not something to assume, so try the modern form and fall back, and report
    plainly when neither works rather than leaving the operator guessing.
    """
    if not apply:
        return True, "would drop"
    attempts = [("modern", ix.drop_ddl()), ("legacy", ix.drop_ddl(legacy=True))]
    errors = []
    for name, ddl in attempts:
        try:
            await _query(client, graph, ddl, ro=False)
            return True, f"dropped ({name} syntax)"
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    return False, "; ".join(errors)


# ── cluster ──────────────────────────────────────────────────────────────


async def shard_masters(client) -> List[Tuple[str, int]]:
    """Every master in the cluster, or just this node when standalone."""
    try:
        raw = await client.execute_command("CLUSTER", "NODES")
    except Exception:
        return []
    out: List[Tuple[str, int]] = []
    for line in _text(raw).splitlines():
        parts = line.split()
        if len(parts) < 3 or "master" not in parts[2]:
            continue
        addr = parts[1].split("@")[0]
        host, _, port = addr.rpartition(":")
        if host and port.isdigit():
            out.append((host, int(port)))
    return out


# ── the sweep ────────────────────────────────────────────────────────────


async def sweep_node(client, where: str, graphs: Sequence[str], *,
                     apply: bool) -> Dict[str, int]:
    tally = {"graphs": 0, "found": 0, "dropped": 0, "failed": 0}
    for graph in graphs:
        try:
            catalogue = await read_index_catalogue(client, graph)
        except RuntimeError as exc:
            print(f"  {graph}: {exc}")
            continue
        tally["graphs"] += 1

        retired_here = [ix for ix in RETIRED_EDGE_INDEXES
                        if any(_row_is(r, ix.rel, ix.props) for r in catalogue)]
        declared_here = [ix for ix in declared_edge_indexes()
                         if any(_row_is(r, ix.rel, ix.props) for r in catalogue)]
        unrecognised = len(catalogue) - len(retired_here) - len(declared_here)

        print(f"\n  {where}  {graph}")
        print(f"    {len(catalogue)} index rows: {len(declared_here)} declared, "
              f"{len(retired_here)} retired, {unrecognised} not ours (left alone)")

        if not retired_here:
            print("    nothing to do")
            continue

        for ix in retired_here:
            tally["found"] += 1
            ok, detail = await try_drop(client, graph, ix, apply=apply)
            mark = "  ✓" if ok else "  ✗"
            print(f"    {mark} ({', '.join(ix.props)}) — {detail}")
            tally["dropped" if ok else "failed"] += 1
    return tally


async def graphs_on(client, wanted: Sequence[str]) -> List[str]:
    try:
        present = [_text(k) for k in await client.execute_command("GRAPH.LIST")]
    except Exception:
        present = []
    return [g for g in present if not wanted or g in wanted]


async def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.getenv("FALKORDB_HOST", "localhost"))
    ap.add_argument("--port", type=int, default=int(os.getenv("FALKORDB_PORT", "6379")))
    ap.add_argument("--password", default=os.getenv("FALKORDB_PASSWORD") or None)
    ap.add_argument("--graph", action="append", default=[],
                    help="limit to these graph keys; repeatable. Default: all.")
    ap.add_argument("--all-shards", action="store_true",
                    help="discover the cluster's other masters and sweep each. "
                         "A graph is one key on one shard, so without this only "
                         "the graphs owned by --host are reached.")
    ap.add_argument("--apply", action="store_true",
                    help="actually drop. Without it, nothing is changed.")
    args = ap.parse_args()

    def _client(host: str, port: int):
        return aioredis.Redis(host=host, port=port, password=args.password,
                              decode_responses=False, socket_timeout=120)

    head = _client(args.host, args.port)
    try:
        await head.ping()
    except Exception as exc:
        print(f"cannot reach {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 2

    print("=" * 72)
    print("RETIRED — dropped by this script:")
    for ix in RETIRED_EDGE_INDEXES:
        print(f"  ()-[r:{ix.rel}]-() ON ({', '.join(ix.props)})")
    print("\nDECLARED — left in place:")
    for ix in declared_edge_indexes():
        note = " (conditional; settle with PROFILE before touching)" \
            if ix in CONDITIONAL_EDGE_INDEXES else ""
        print(f"  ()-[r:{ix.rel}]-() ON ({', '.join(ix.props)}){note}")
    print("=" * 72)
    if not args.apply:
        print("\nDRY RUN — nothing will be changed. Re-run with --apply.\n")

    targets = [(args.host, args.port)]
    if args.all_shards:
        masters = await shard_masters(head)
        if masters:
            targets = masters
            print(f"cluster: {len(masters)} masters\n")
        else:
            print("not a cluster (or CLUSTER NODES refused) — this node only\n")

    started = time.monotonic()
    total = {"graphs": 0, "found": 0, "dropped": 0, "failed": 0}
    for host, port in targets:
        client = head if (host, port) == (args.host, args.port) else _client(host, port)
        try:
            await client.ping()
        except Exception as exc:
            print(f"  {host}:{port} unreachable ({exc}) — skipped")
            continue
        graphs = await graphs_on(client, args.graph)
        if not graphs:
            print(f"  {host}:{port}: no matching graphs")
        else:
            tally = await sweep_node(client, f"{host}:{port}", graphs, apply=args.apply)
            for k in total:
                total[k] += tally[k]
        if client is not head:
            await client.aclose()

    print(f"\n{'=' * 72}")
    verb = "dropped" if args.apply else "would drop"
    print(f"{total['graphs']} graphs · {total['found']} retired indexes found · "
          f"{total['dropped']} {verb} · {total['failed']} failed "
          f"· {time.monotonic() - started:.1f}s")
    if total["failed"]:
        print("\nFailures above show what each DROP syntax said. If BOTH spellings "
              "were rejected, this build has no DROP INDEX for edge indexes — in "
              "which case the only way to shed them is to rebuild the graph "
              "without them, and that is worth knowing before planning around it.")
    if not args.apply and total["found"]:
        print("\nRe-run with --apply to drop them.")
    await head.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
