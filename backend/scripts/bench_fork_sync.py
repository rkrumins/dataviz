"""Benchmark: a fork's Update from parent, and a fork's review merged as a job.

Builds, against Postgres (graphver):

  root    ``--nodes`` nodes (a tenth tables, the rest columns) and ``--edges`` edges (half
          containment, half flows between columns), as bench_fork_overlay's, committed 10,000 ops
          at a time
  update  a fork of the root that renames ``--both`` columns; the root then makes ``--advance``
          changes: a note on each of those columns (both changed them, different fields: they merge
          clean, and the update writes them), renames of six tenths of the other changes' columns,
          and edits of containment edges
  merge   a fork of the root as it is then (up to date with it) that makes ``--review`` changes of
          its own — half renames, a quarter new columns in tables (node and containment edge), the
          rest edits of flows — and its review, opened with no reviewers

then measures each in a process of its own, as peak RSS is per process:

  update  ``fork_update_size`` (how the route sizes an update) and ``update_fork_from_parent``:
          seconds, rows written, the process's resident memory before and its high-water mark
          (``VmHWM``: a child's ``ru_maxrss`` starts at its parent's)
  merge   the review's merge as a ``fork_merge`` job: queued as the routes queue one
          (``create_fork_merge_job``), claimed and run on its lease by the transfer lane's runner,
          through a hook that merges as the API's does (the containment types given here; no cache
          or view touches): seconds, rows written, resident memory — at the default
          ``GRAPHVER_SQUASH_PAGED_ABOVE``, or with ``--paged`` a page at a time (that threshold
          set to half the review)

Usage, from the repository root, with the backend's environment (once as is, once ``--paged``)::

  python -m backend.scripts.bench_fork_sync run --nodes 100000 --edges 100000 --advance 100000 \\
      --both 1000 --review 100000
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
import uuid
from typing import Any, Dict, List

from backend.scripts.bench_fork_overlay import CONT, _commit, _peak_mb, _Shape
from backend.scripts.bench_versioning import _rss_mb, run_claimed

WORKSPACE = "ws_bench"


def _patch(eid: str, kind: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """An update that changes only ``payload``'s fields (a PATCH on the stored value)."""
    return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}


def _advance_ops(both: int, n: int) -> List[Dict[str, Any]]:
    """``n`` root changes: a note on each of the first ``both`` columns, renames of columns after
    them (six tenths of the rest), edits of containment edges (the rest)."""
    rest = n - both
    renames = rest * 6 // 10
    return ([_patch(f"c{j}", "node", {"properties": {"note": f"root {j}"}}) for j in range(both)]
            + [_patch(f"c{j}", "node", {"displayName": f"C {j} root"})
               for j in range(both, both + renames)]
            + [_patch(f"k{j}", "edge", {"properties": {"w": 1}}) for j in range(rest - renames)])


async def _analyze() -> None:
    """Fresh statistics on what the seed filled, as autovacuum would give them in time."""
    from sqlalchemy import text

    from backend.app.services.versioning import config, db
    async with db.graphver_session() as s:
        for table in ("node_versions", "edge_versions", "entity_heads", "commits", "fork_bases"):
            await s.execute(text(f'ANALYZE "{config.graphver_schema()}"."{table}"'))


async def _seed(args) -> Dict[str, Any]:
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc, shape = GraphVersioningService(), _Shape(args.nodes, args.edges)
    started = time.perf_counter()
    root = (await svc.create_graph(data_source_id="ds_bench_" + uuid.uuid4().hex[:8],
                                   workspace_id=WORKSPACE, actor="bench"))["graph_id"]
    await _commit(svc, root, shape.node_ops(), "nodes")
    await _commit(svc, root, shape.edge_ops(), "edges")
    update = await svc.fork_graph(parent_graph_id=root, workspace_id=WORKSPACE, actor="bench")
    await _commit(svc, update["graph_id"],
                  [_patch(f"c{j}", "node", {"displayName": f"C {j} fork"}) for j in range(args.both)],
                  "own")
    await _commit(svc, root, _advance_ops(args.both, args.advance), "advance")
    review = await svc.fork_graph(parent_graph_id=root, workspace_id=WORKSPACE, actor="bench")
    await _commit(svc, review["graph_id"], shape.fork_ops("x", args.review), "own")
    pr = await svc.open_pr(source_graph_id=review["graph_id"], actor="bench")
    await _analyze()
    await db.dispose_engine()
    return {"root": root, "update": update["graph_id"], "review": review["graph_id"], "pr": pr,
            "paged": args.paged, "seedSecs": round(time.perf_counter() - started),
            "nodes": args.nodes, "edges": args.edges, "advance": args.advance, "both": args.both,
            "reviewChanges": args.review}


async def _rows(gid: str, seq: int) -> int:
    from sqlalchemy import func, select

    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import EdgeVersionORM, NodeVersionORM
    async with db.graphver_session() as s:
        return sum([int(await s.scalar(select(func.count()).select_from(m).where(
            m.graph_id == gid, m.commit_seq == seq)) or 0) for m in (NodeVersionORM, EdgeVersionORM)])


async def _measure_update(state: Dict[str, Any]) -> Dict[str, Any]:
    from backend.app.services.versioning import db
    from backend.app.services.versioning.service import GraphVersioningService

    svc, fork = GraphVersioningService(), state["update"]
    await svc.get_graph(fork)                                   # connections up, before the rss
    rss_before = _rss_mb()
    started = time.perf_counter()
    size = await svc.fork_update_size(fork_graph_id=fork)
    sized = time.perf_counter() - started
    started = time.perf_counter()
    out = await svc.update_fork_from_parent(fork_graph_id=fork, actor="bench")
    took = time.perf_counter() - started
    rows = await _rows(fork, (await svc.get_graph(fork))["main_head_commit_seq"])
    await db.dispose_engine()
    return {"measure": "update", "parentChanges": state["advance"], "both": state["both"],
            "sizedChanges": size["changes"], "sizeSecs": round(sized, 2),
            "updateSecs": round(took, 2), "wrote": out["wrote"], "rows": rows,
            "rssBeforeMb": round(rss_before), "peakMb": round(_peak_mb())}


async def _measure_merge(state: Dict[str, Any]) -> Dict[str, Any]:
    from backend.app.services.versioning import config, db, job_lease
    from backend.app.services.versioning.import_export.runner import TransferRunner
    from backend.app.services.versioning.import_export.service import ImportExportService
    from backend.app.services.versioning.service import GraphVersioningService

    if state["paged"]:
        config.SQUASH_PAGED_ABOVE = max(1, state["reviewChanges"] // 2)
    svc = GraphVersioningService()

    async def merge(job: Dict[str, Any]) -> Dict[str, Any]:
        return {"commitId": await svc.merge_pr(
            pr_id=job["prId"], actor=job["actor"], message=job["message"],
            pinned_seq=job["pinnedSeq"], queued=True, containment_edge_types=CONT)}

    ie = ImportExportService(versioning=svc, fork_hook=merge)
    await svc.get_graph(state["root"])                          # connections up, before the rss
    rss_before = _rss_mb()
    started = time.perf_counter()
    created = await ie.create_fork_merge_job(workspace_id=WORKSPACE, pr_id=state["pr"],
                                             actor="bench", message="bench merge")
    await ie.start_fork_job(created["job_id"])
    queued = time.perf_counter() - started
    started = time.perf_counter()
    await run_claimed(TransferRunner(lambda: ie), created["job_id"], job_lease.TRANSFER_TYPES,
                      job_lease.TRANSFER_READY)
    took = time.perf_counter() - started
    job = await ie.get_job(created["job_id"])
    rows = await _rows(state["root"], (await svc.get_graph(state["root"]))["main_head_commit_seq"])
    await db.dispose_engine()
    return {"measure": "merge (paged)" if state["paged"] else "merge",
            "reviewChanges": state["reviewChanges"], "pagedAbove": config.SQUASH_PAGED_ABOVE,
            "page": config.SQUASH_PAGE, "status": job["status"], "error": job.get("errorMessage"),
            "queueSecs": round(queued, 2), "mergeSecs": round(took, 2), "rows": rows,
            "rssBeforeMb": round(rss_before), "peakMb": round(_peak_mb())}


async def _run(args) -> int:
    state = await _seed(args)
    print(json.dumps(state), flush=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(state, f)
    for which in ("update", "merge"):
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.scripts.bench_fork_sync", "measure", "--state", f.name,
            "--which", which, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy())
        out, err = await proc.communicate()
        if proc.returncode:
            sys.stderr.write(err.decode())
            return proc.returncode
        print(out.decode().strip().splitlines()[-1], flush=True)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="seed a root and its forks, then measure each")
    run.add_argument("--nodes", type=int, default=100_000)
    run.add_argument("--edges", type=int, default=100_000)
    run.add_argument("--advance", type=int, default=100_000)
    run.add_argument("--both", type=int, default=1_000)
    run.add_argument("--review", type=int, default=100_000)
    run.add_argument("--paged", action="store_true", help="merge the review a page at a time")
    measure = sub.add_parser("measure", help="measure one of a seeded state (run spawns it)")
    measure.add_argument("--state", required=True)
    measure.add_argument("--which", choices=("update", "merge"), required=True)
    args = parser.parse_args(argv)

    if args.cmd == "measure":
        with open(args.state) as f:
            state = json.load(f)
        measured = _measure_update(state) if args.which == "update" else _measure_merge(state)
        print(json.dumps(asyncio.run(measured)))
        return 0
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
