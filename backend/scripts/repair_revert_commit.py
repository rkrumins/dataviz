#!/usr/bin/env python3
"""Repair a graph corrupted by the partial-update truncation bug: revert the offending merge commit
on ``main``, then rebuild the FalkorDB projection.

Background: ``update`` ops used to be applied as a WHOLESALE REPLACE, so a partial edit (the canvas
sends only the edited fields) dropped every unspecified field — ``displayName``/``urn``/``properties``.
A publish/merge then wrote that stripped entity onto ``main``, surfacing as nodes that render their raw
URN instead of a name, with mangled properties. The code fix (``materialize``/``_apply_ops_once`` now
patch field-by-field) stops it recurring, but already-corrupted nodes keep the truncated payload as
their latest committed version.

This script restores them by reverting the bad commit — ``revert_commit`` rewrites every entity that
commit touched back to its PRE-commit state (a new ``revert`` commit) — then re-projects FalkorDB so
the canvas reflects the restored ``main``. No data loss: the pre-commit payloads live in version
history; FalkorDB is a rebuildable cache.

Usage:
  # 0) Diagnose "a merge to main doesn't persist / the canvas shows the old state" (read-only):
  python backend/scripts/repair_revert_commit.py --graph-id <gid> --diagnose

  # 1) Find the offending commit (read-only):
  python backend/scripts/repair_revert_commit.py --data-source-id <ds> --list 20
  python backend/scripts/repair_revert_commit.py --graph-id <gid> --list 20

  # 2) Preview what a revert would restore (read-only):
  python backend/scripts/repair_revert_commit.py --graph-id <gid> --commit-id <cid> --dry-run

  # 3) Revert + re-project:
  python backend/scripts/repair_revert_commit.py --graph-id <gid> --commit-id <cid> --actor you
  python backend/scripts/repair_revert_commit.py --graph-id <gid> --revert-head --actor you
"""
import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.services.versioning.service import GraphVersioningService, MergeConflict


def _fmt_commit(c: dict) -> str:
    st = c.get("stats") or {}
    counts = " ".join(f"{k}={v}" for k, v in st.items()) if isinstance(st, dict) else str(st)
    src = ""
    if c.get("source_commit_count"):
        src = f" (squashed {c['source_commit_count']} commits)"
    return (f"  seq={c['commit_seq']:<5} {c['kind']:<14} {c['commit_id']}\n"
            f"      {c.get('message') or ''!r} by {c.get('actor')} at {c.get('created_at')}{src}\n"
            f"      {counts}")


async def _resolve_graph_id(svc: GraphVersioningService, args) -> str:
    if args.graph_id:
        meta = await svc.get_graph(args.graph_id)
        if meta is None:
            sys.exit(f"error: no graph {args.graph_id}")
        return args.graph_id
    meta = await svc.get_graph_by_data_source(args.data_source_id)
    if meta is None:
        sys.exit(f"error: no versioned graph for data source {args.data_source_id}")
    return str(meta["graph_id"])


async def _find_commit(svc: GraphVersioningService, gid: str, commit_id: str) -> dict | None:
    """Locate a commit's metadata on main (paginating the newest-first log)."""
    offset = 0
    while offset < 5000:
        page = await svc.commit_log(graph_id=gid, limit=200, offset=offset)
        if not page:
            return None
        for c in page:
            if c["commit_id"] == commit_id:
                return c
        offset += 200
    return None


async def _reproject(svc: GraphVersioningService, gid: str) -> None:
    """Bring FalkorDB up to the (now reverted) committed head — the production path."""
    try:
        from backend.app.api.v1.endpoints.versioning import project_now
        await project_now(gid)
    except Exception as exc:                                  # never fatal — the commit already landed
        print(f"  re-projection could not run in-process ({exc}); the async worker will catch up.")
    wm = await svc.projection_watermark(gid)
    state = "fresh" if wm.get("fresh") else "catching up (async worker / Postgres read-fallback covers it)"
    print(f"  projection: committed={wm.get('committed')} projected={wm.get('projected')} → {state}")


async def _falkor_counts(factory, name: str):
    """(nodes, edges) live in FalkorDB graph ``name``, or a reason string when absent/unreadable."""
    try:
        client = factory(name)
        nodes = (await client.query("MATCH (n) RETURN count(n)")).result_set[0][0]
        edges = (await client.query("MATCH ()-[r]->() RETURN count(r)")).result_set[0][0]
        return (int(nodes), int(edges))
    except Exception as exc:
        msg = str(exc)
        if "empty key" in msg.lower():
            return "(absent — never projected into this graph)"
        return f"(unreadable: {msg[:80]})"


async def _diagnose(svc: GraphVersioningService, gid: str) -> None:
    """Read-only: why a merge to main isn't showing on the canvas. Compares the graph the PROJECTION
    writes (``projection_state.falkor_graph_name``) against the graph the CANVAS reads (the data
    source's ``graph_name``), reports the watermark, and dumps live FalkorDB counts per candidate
    graph — so a target mismatch or a lagging/failed projection is obvious."""
    from backend.app.services.versioning import db as vdb
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    print(f"=== projection diagnosis for graph {gid} ===\n")
    async with vdb.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        graph = await s.get(GraphORM, gid)

    print("committed main head seq :", graph.main_head_commit_seq if graph else None)
    if ps is None:
        print("projection_state        : (none) — this graph has never been projected.")
    else:
        print("projection_state:")
        print(f"  falkor_graph_name     : {ps.falkor_graph_name!r}   <- projection WRITES here")
        print(f"  projected_commit_seq  : {ps.projected_commit_seq}")
        print(f"  target_commit_seq     : {ps.target_commit_seq}")
        print(f"  status                : {ps.status}")
        print(f"  last_projected_at     : {ps.last_projected_at}")
        print(f"  last_error            : {ps.last_error!r}")

    wm = await svc.projection_watermark(gid)
    fresh = wm.get("fresh")
    print(f"\nwatermark: committed={wm.get('committed')} projected={wm.get('projected')} fresh={fresh}"
          f"  ({'live FalkorDB is served' if fresh else 'Postgres read-fallback is served'})")

    # The canvas reads the data source's real graph_name (separate management DB).
    ds_name, ds_id = None, None
    meta = await svc.get_graph(gid)
    ds_id = meta.get("data_source_id") if meta else None
    if ds_id:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories import data_source_repo
        try:
            async with get_async_session() as s:
                ds_row = await data_source_repo.get_data_source_orm(s, str(ds_id))
            ds_name = ds_row.graph_name if ds_row else None
        except Exception as exc:
            print(f"\n(could not read data source {ds_id}: {type(exc).__name__}: "
                  f"{str(exc).splitlines()[0][:160]})")
    print(f"\ndata source             : {ds_id}")
    print(f"canvas READS graph      : {ds_name!r}")

    proj_name = (ps.falkor_graph_name if ps else None) or f"gv_{gid}"
    if ds_name and proj_name != ds_name:
        print(f"\n*** TARGET MISMATCH — projection writes {proj_name!r} but the canvas reads {ds_name!r}; "
              f"merged main never surfaces. The worker now self-heals (target_resolver); to fix now, run "
              f"any publish/merge (project_now re-points it) or `--revert-head` to re-project. ***")
    elif ds_name:
        print(f"\ntarget OK — projection writes {proj_name!r}, the same graph the canvas reads.")
    if ps and ps.projected_commit_seq < ps.target_commit_seq:
        print("*** PROJECTION LAGGING — projected < target; the worker hasn't caught up (check last_error). ***")

    try:
        from backend.app.services.versioning.projection import make_falkor_graph_factory
        factory = make_falkor_graph_factory()
    except Exception as exc:
        print(f"\n(FalkorDB unconfigured — skipping live counts: {exc})")
        return
    seen, candidates = set(), []
    for nm in (ds_name, f"{ds_name}_proj" if ds_name else None, f"gv_{gid}", proj_name):
        if nm and nm not in seen:
            seen.add(nm)
            candidates.append(nm)
    print("\nlive FalkorDB graph contents (nodes, edges):")
    for nm in candidates:
        tag = "  <- canvas reads" if nm == ds_name else ("  <- projection writes" if nm == proj_name else "")
        print(f"  {nm:<42} {await _falkor_counts(factory, nm)}{tag}")
    print()


async def main() -> None:
    p = argparse.ArgumentParser(description="Revert a corrupted merge commit on main and re-project.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--graph-id", help="versioned graph id")
    g.add_argument("--data-source-id", help="data source id (resolved to its graph)")
    p.add_argument("--list", nargs="?", const=20, type=int, metavar="N",
                   help="list the N newest main commits (default action; read-only)")
    p.add_argument("--diagnose", action="store_true",
                   help="diagnose 'merge doesn't persist / canvas shows old state': dump the projection "
                        "target vs the graph the canvas reads, the watermark, and live FalkorDB counts "
                        "(read-only)")
    p.add_argument("--commit-id", help="commit to revert")
    p.add_argument("--revert-head", action="store_true",
                   help="revert the current head commit (conflict-free; rerun to peel several)")
    p.add_argument("--dry-run", action="store_true", help="preview what a revert would restore; write nothing")
    p.add_argument("--no-project", action="store_true", help="skip the FalkorDB re-projection step")
    p.add_argument("--actor", default="repair-script", help="actor recorded on the revert commit")
    args = p.parse_args()

    svc = GraphVersioningService()
    gid = await _resolve_graph_id(svc, args)

    if args.diagnose:
        await _diagnose(svc, gid)
        return

    main_id = await svc.main_branch_id(gid)

    # Default / explicit list: read-only.
    if args.commit_id is None and not args.revert_head:
        n = args.list if args.list is not None else 20
        print(f"main commits for graph {gid} (newest first):\n")
        for c in await svc.commit_log(graph_id=gid, limit=n):
            print(_fmt_commit(c))
        print("\nPick the offending commit, then re-run with --commit-id <id> [--dry-run].")
        return

    # Resolve the target commit's metadata.
    if args.revert_head:
        head = await svc.commit_log(graph_id=gid, limit=1)
        if not head:
            sys.exit("error: no commits on main")
        target = head[0]
    else:
        target = await _find_commit(svc, gid, args.commit_id)
        if target is None:
            sys.exit(f"error: commit {args.commit_id} not found on main of {gid}")
    seq = int(target["commit_seq"])
    print(f"target commit:\n{_fmt_commit(target)}\n")

    # Preview: the diff this commit introduced is exactly what the revert undoes.
    diff = await svc.diff_commits(graph_id=gid, branch_id=main_id, from_seq=seq - 1, to_seq=seq)
    added, removed, modified = diff.get("added", []), diff.get("removed", []), diff.get("modified", {})
    print(f"reverting restores {len(added)} added (→ removed), {len(removed)} removed (→ restored), "
          f"{len(modified)} modified (→ prior value) entities.")
    sample = [e.get("entityId") or e.get("urn") for e in (added[:5] + removed[:5])]
    if sample:
        print("  e.g. " + ", ".join(str(x) for x in sample if x))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    try:
        revert_id = await svc.revert_commit(
            graph_id=gid, commit_id=target["commit_id"], actor=args.actor,
            message=f"repair: revert {target['commit_id']} (partial-update truncation)")
    except MergeConflict as exc:
        ids = [c.get("entity_id") for c in (getattr(exc, "conflicts", None) or [])]
        print("\nMergeConflict: a LATER commit also changed some of these entities, so this commit "
              "can't be reverted cleanly:")
        print("  " + (", ".join(str(i) for i in ids) if ids else str(exc)))
        print("Revert the later commit(s) first (or use --revert-head and peel back one commit at a "
              "time until past the corruption).")
        sys.exit(2)

    if not revert_id:
        print("\nNothing to undo (the commit's effect was already reverted).")
        return
    print(f"\n✓ reverted as commit {revert_id} on main.")

    if not args.no_project:
        await _reproject(svc, gid)
    print("\nDone. Re-open the graph; nodes should show their names again.")


if __name__ == "__main__":
    asyncio.run(main())
