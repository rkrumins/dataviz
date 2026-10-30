"""Benchmark: what reading a fork through its root's store costs (``branch_overlay_delta`` in fork
mode, ``DraftOverlayProvider(fork=True)``).

Builds, against Postgres (graphver) and the env FalkorDB instance (``FALKORDB_HOST``/``FALKORDB_PORT``):

  root    ``--nodes`` nodes (a tenth tables, the rest columns) and ``--edges`` edges (half
          containment, half flows between columns), committed 10,000 ops at a time and projected
          into a ``gvt_bench_fork_*`` key of its own (deleted after, unless ``--keep``)
  forks   two forks of the root at that head: ``big`` makes ``--own`` changes of its own, ``small``
          ``--small``; half renames, a quarter new columns in tables (node and containment edge),
          a quarter property edits of flows
  root    then advances ``--advance`` changes — a tenth of them renames of columns both forks
          renamed too — and is projected again

then measures each fork in a process of its own, as peak RSS is per process:

  build     ``branch_overlay_delta`` on the fork's ``main``: seconds, and the entries it holds
  rss       the process's resident MB before the build and after it, and its high-water mark
            (``VmHWM``: a child's ``ru_maxrss`` starts at its parent's)
  canvas    what a canvas reads through the overlay over the root's key: the top-level page of
            500 with child counts, the edges touching its first 500 nodes, a table's children —
            ``first`` building the delta as a cold reader does, ``cached`` as the next request
            (a provider of its own, the delta cached), ``base`` the same reads on the root's key
  listing   an unfiltered ``get_nodes`` of 500 through the overlay, the delta cached: it serves
            every node the fork created, each loaded for the request
  ceiling   ``fork_reads_from`` (each engine a request builds for a fork asks it) and
            ``overlay_version`` (each read asks it)

Usage, from the repository root, with the backend's environment::

  python -m backend.scripts.bench_fork_overlay run --nodes 100000 --edges 100000 --own 100000 \\
      --small 1000 --advance 50000
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import gc
import json
import sys
import tempfile
import time
import uuid
from typing import Any, Dict, List

from backend.scripts.bench_versioning import _maxrss_mb, _noop, _rss_mb, falkor_factory

CONT = ["CONTAINS"]
WINDOW = 10_000


def _node(eid: str, typ: str, name: str, op: str = "create") -> Dict[str, Any]:
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": typ, "displayName": name,
                        "properties": {"note": name.lower()}}}


def _edge(eid: str, src: str, tgt: str, typ: str, w: int = 0, op: str = "create") -> Dict[str, Any]:
    return {"op": op, "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": typ, "sourceEntityId": src, "targetEntityId": tgt,
                        "properties": {"w": w}}}


class _Shape:
    """Ids of the root's entities: tables ``t<i>``, columns ``c<j>``, containment ``k<j>`` (table
    ``j % tables`` holds column ``j``) and flows ``f<j>`` (column ``j`` to ``j + 1``)."""

    def __init__(self, nodes: int, edges: int):
        self.tables = max(1, nodes // 10)
        self.columns = nodes - self.tables
        self.contains = min(edges // 2, self.columns)
        self.flows = min(edges - self.contains, self.columns - 1)

    def node_ops(self) -> List[Dict[str, Any]]:
        return ([_node(f"t{i}", "Table", f"T {i}") for i in range(self.tables)]
                + [_node(f"c{j}", "Column", f"C {j}") for j in range(self.columns)])

    def contains_op(self, j: int, w: int = 0, op: str = "create") -> Dict[str, Any]:
        return _edge(f"k{j}", f"t{j % self.tables}", f"c{j}", "CONTAINS", w, op)

    def flow_op(self, j: int, w: int = 0, op: str = "create") -> Dict[str, Any]:
        return _edge(f"f{j}", f"c{j}", f"c{j + 1}", "FLOWS", w, op)

    def edge_ops(self) -> List[Dict[str, Any]]:
        return ([self.contains_op(j) for j in range(self.contains)]
                + [self.flow_op(j) for j in range(self.flows)])

    def fork_ops(self, tag: str, n: int) -> List[Dict[str, Any]]:
        """``n`` changes a fork makes: renames of the first columns, new columns each in a table
        (two changes: the node and its containment edge), flow edits."""
        renames, new = n // 2, n // 8
        return ([_node(f"c{j}", "Column", f"C {j} {tag}", op="update") for j in range(renames)]
                + [_node(f"{tag}{i}", "Column", f"{tag} {i}") for i in range(new)]
                + [_edge(f"{tag}k{i}", f"t{i % self.tables}", f"{tag}{i}", "CONTAINS")
                   for i in range(new)]
                + [self.flow_op(j, w=1, op="update") for j in range(n - renames - 2 * new)])

    def advance_ops(self, n: int) -> List[Dict[str, Any]]:
        """``n`` changes on the root: a tenth renames of the columns the forks renamed first, six
        tenths renames from the far end, the rest edits of containment edges."""
        shared, far = n // 10, n * 6 // 10
        return ([_node(f"c{j}", "Column", f"C {j} root", op="update") for j in range(shared)]
                + [_node(f"c{j}", "Column", f"C {j} root", op="update")
                   for j in range(self.columns - far, self.columns)]
                + [self.contains_op(j, w=1, op="update") for j in range(n - shared - far)])


async def _commit(svc, gid: str, ops: List[Dict[str, Any]], message: str) -> None:
    for i in range(0, len(ops), WINDOW):
        await svc.apply_ops(graph_id=gid, actor="bench", message=message, ops=ops[i:i + WINDOW],
                            containment_edge_types=CONT)


async def _seed(args) -> Dict[str, Any]:
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.projection import FalkorProjector
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc, shape = GraphVersioningService(), _Shape(args.nodes, args.edges)
    key = "gvt_bench_fork_" + uuid.uuid4().hex[:8]
    projector = FalkorProjector(falkor_factory(), on_rollups_stale=_noop)
    started = time.perf_counter()
    root = (await svc.create_graph(data_source_id="ds_bench_" + uuid.uuid4().hex[:8],
                                   workspace_id="ws_bench", actor="bench", falkor_graph_name=key,
                                   owns_falkor_graph=True))["graph_id"]
    await _commit(svc, root, shape.node_ops(), "nodes")
    await _commit(svc, root, shape.edge_ops(), "edges")
    out = await projector.project_graph(root)
    assert not out.get("verify_error"), out
    forks = {}
    for which, n in (("big", args.own), ("small", args.small)):
        fork = await svc.fork_graph(parent_graph_id=root, workspace_id="ws_bench", actor="bench")
        await _commit(svc, fork["graph_id"], shape.fork_ops(f"x{which}", n), "own")
        forks[which] = {"graph_id": fork["graph_id"], "main": fork["main_branch_id"], "own": n}
    await _commit(svc, root, shape.advance_ops(args.advance), "advance")
    out = await projector.project_graph(root)
    assert not out.get("verify_error"), out
    await db.dispose_engine()
    return {"key": key, "root": root, "forks": forks, "seed_secs": time.perf_counter() - started,
            "nodes": args.nodes, "edges": args.edges, "advance": args.advance}


def _peak_mb() -> float:
    """This process's resident high-water mark (``VmHWM``), else ``ru_maxrss``."""
    with contextlib.suppress(OSError):
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) / 1024
    return _maxrss_mb()


async def _canvas(provider) -> float:
    from backend.common.models.graph import EdgeQuery

    started = time.perf_counter()
    top = await provider.get_top_level_or_orphan_nodes(limit=500)
    await provider.get_edges(EdgeQuery(any_urns=[n.urn for n in top.nodes][:500], limit=5_000))
    await provider.get_children_with_edges("t0", edge_types=CONT, limit=100)
    return time.perf_counter() - started


async def _listing(provider) -> float:
    from backend.common.models.graph import NodeQuery

    started = time.perf_counter()
    await provider.get_nodes(NodeQuery(limit=500))
    return time.perf_counter() - started


async def _measure(state: Dict[str, Any], which: str) -> Dict[str, Any]:
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    from backend.app.providers.falkordb_connection import env_conn_config
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.versioning import db
    from backend.app.services.versioning.service import GraphVersioningService

    fork = state["forks"][which]
    gid, main = fork["graph_id"], fork["main"]
    svc = GraphVersioningService()
    await svc.overlay_version(graph_id=gid, branch_id=main)      # connections up, before the rss
    rss_before = _rss_mb()
    started = time.perf_counter()
    delta = await svc.branch_overlay_delta(graph_id=gid, branch_id=main)
    build = time.perf_counter() - started
    entries = {k: len(delta.get(k) or ()) for k in (
        "nodesUpsert", "nodesModified", "nodesRemove", "edgesUpsert", "edgesRemove")}
    rss_built, peak_built = _rss_mb(), _peak_mb()
    del delta
    gc.collect()

    started = time.perf_counter()
    reads_from = await svc.fork_reads_from(gid)
    ceiling = time.perf_counter() - started
    started = time.perf_counter()
    await svc.overlay_version(graph_id=gid, branch_id=main)
    version = time.perf_counter() - started

    cfg = env_conn_config()
    base = FalkorDBProvider(host=cfg.host, port=cfg.port, graph_name=state["key"])
    base.set_containment_edge_types(CONT)
    base.set_resolved_edge_metadata({}, ["FLOWS"])

    def overlay():                    # a request's own, as ContextEngine makes one per request
        o = DraftOverlayProvider(base, svc=svc, graph_id=gid, branch_id=main, fork=True)
        o.set_containment_edge_types(CONT)
        return o

    first, cached = await _canvas(overlay()), await _canvas(overlay())
    plain = await _canvas(base)
    listing = await _listing(overlay())
    with contextlib.suppress(Exception):
        await base.close()
    await db.dispose_engine()
    return {"fork": which, "own": fork["own"], "readsFrom": reads_from, "entries": entries,
            "buildSecs": round(build, 2), "rssBeforeMb": round(rss_before), "rssBuiltMb": round(rss_built),
            "peakBuildMb": round(peak_built), "firstReadSecs": round(first, 2),
            "cachedReadSecs": round(cached, 3), "baseReadSecs": round(plain, 3),
            "listingSecs": round(listing, 2), "peakMb": round(_peak_mb()),
            "readsFromSecs": round(ceiling, 3), "overlayVersionSecs": round(version, 3)}


async def _drop(key: str) -> None:
    from backend.scripts.bench_versioning import _client
    try:
        await (await _client(falkor_factory(), key)).delete()
    except Exception as exc:                    # say so: the key holds the whole root graph
        print(f"could not drop {key}: {exc!r}; GRAPH.DELETE it by hand", file=sys.stderr)


async def _run(args) -> int:
    """Seed, measure each fork in a process of its own, drop the root's key — on one event loop,
    as the env FalkorDB client the seed made is cached for it."""
    state = await _seed(args)
    print(json.dumps(state), flush=True)
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(state, f)
        for which in ("big", "small"):
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "backend.scripts.bench_fork_overlay", "measure",
                "--state", f.name, "--fork", which,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await proc.communicate()
            if proc.returncode:
                sys.stderr.write(err.decode())
                return proc.returncode
            print(out.decode().strip().splitlines()[-1], flush=True)
    finally:
        if not args.keep:
            await _drop(state["key"])
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="seed a root and two forks, then measure each fork")
    run.add_argument("--nodes", type=int, default=100_000)
    run.add_argument("--edges", type=int, default=100_000)
    run.add_argument("--own", type=int, default=100_000)
    run.add_argument("--small", type=int, default=1_000)
    run.add_argument("--advance", type=int, default=50_000)
    run.add_argument("--keep", action="store_true", help="keep the root's FalkorDB key")
    measure = sub.add_parser("measure", help="measure one fork of a seeded state (run spawns it)")
    measure.add_argument("--state", required=True)
    measure.add_argument("--fork", choices=("big", "small"), required=True)
    args = parser.parse_args(argv)

    if args.cmd == "measure":
        with open(args.state) as f:
            print(json.dumps(asyncio.run(_measure(json.load(f), args.fork))))
        return 0
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
