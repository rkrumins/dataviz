#!/usr/bin/env python3
"""Backfill view attribution (``originating_view_id``) onto branches/commits
written before view tracking worked.

Background: the per-view "Changes & Reviews" / "Pull Requests" filters match
``originating_view_id``, but two historical gaps left it NULL: (1) the canvas's
auto-draft path never sent the view id when opening a draft, and (2) the
interactive save path (``_apply_ops_once``) didn't stamp its ``kind="edit"``
commits even on attributed drafts. Both are fixed at the source; this script
repairs the rows already written.

Two tiers, in order:

1. **Exact (always safe):** a NULL commit whose branch — or, for squash/merge
   commits, whose *source* branch — IS attributed inherits that branch's view.
   Pure derivation, correct for any number of views.
2. **Single-view heuristic (opt-in by shape):** when the data source has
   EXACTLY ONE view, attribution is unambiguous — NULL draft branches adopt
   that view, then tier 1 re-runs to cascade onto their commits. Data sources
   with several views are reported and skipped (no guessing).

Usage:
  # preview (default; writes nothing)
  python backend/scripts/backfill_view_attribution.py --data-source-id <ds>
  python backend/scripts/backfill_view_attribution.py --all

  # write
  python backend/scripts/backfill_view_attribution.py --data-source-id <ds> --apply
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from sqlalchemy import func, select, update

from backend.app.services.versioning import db as gvdb
from backend.app.services.versioning.models import BranchORM, CommitORM, GraphORM


async def _views_for(ds_id: str) -> list[tuple[str, str]]:
    """Live (id, name) views on a data source, from the management DB."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM

    async with get_async_session() as s:
        rows = (await s.execute(
            select(ViewORM.id, ViewORM.name).where(
                ViewORM.data_source_id == ds_id, ViewORM.deleted_at.is_(None))
        )).all()
    return [(r[0], r[1]) for r in rows]


def _exact_updates(gid: str):
    """Tier 1: commit ← its (source) branch's attribution. UPDATE..FROM, exact."""
    own = (update(CommitORM)
           .where(CommitORM.graph_id == gid,
                  CommitORM.originating_view_id.is_(None),
                  CommitORM.branch_id == BranchORM.id,
                  BranchORM.originating_view_id.isnot(None))
           .values(originating_view_id=BranchORM.originating_view_id)
           .execution_options(synchronize_session=False))
    squash = (update(CommitORM)
              .where(CommitORM.graph_id == gid,
                     CommitORM.originating_view_id.is_(None),
                     CommitORM.source_branch_id == BranchORM.id,
                     BranchORM.originating_view_id.isnot(None))
              .values(originating_view_id=BranchORM.originating_view_id)
              .execution_options(synchronize_session=False))
    return own, squash


async def _null_counts(s, gid: str) -> tuple[int, int]:
    """(NULL draft branches, NULL commits) for the graph — the before/after gauge."""
    b = await s.scalar(select(func.count()).select_from(BranchORM).where(
        BranchORM.graph_id == gid, BranchORM.kind == "draft",
        BranchORM.originating_view_id.is_(None)))
    c = await s.scalar(select(func.count()).select_from(CommitORM).where(
        CommitORM.graph_id == gid, CommitORM.originating_view_id.is_(None)))
    return int(b or 0), int(c or 0)


async def _backfill_graph(gid: str, ds_id: str, apply: bool) -> None:
    views = await _views_for(ds_id)

    async with gvdb.graphver_session() as s:
        b0, c0 = await _null_counts(s, gid)
        if b0 == 0 and c0 == 0:
            print(f"  {gid} (ds {ds_id}): fully attributed — nothing to do.")
            return
        print(f"  {gid} (ds {ds_id}): {b0} unattributed draft branches, {c0} unattributed commits")

        if not apply:
            # Dry-run: report what each tier WOULD fix.
            exact = await s.scalar(
                select(func.count()).select_from(CommitORM).join(
                    BranchORM, CommitORM.branch_id == BranchORM.id).where(
                    CommitORM.graph_id == gid, CommitORM.originating_view_id.is_(None),
                    BranchORM.originating_view_id.isnot(None)))
            print(f"    tier 1 (exact, from attributed branches): would fix {exact} commits")
            if len(views) == 1:
                print(f"    tier 2 (single view '{views[0][1]}' {views[0][0]}): would attribute "
                      f"{b0} draft branches + their commits")
            elif not views:
                print("    tier 2: SKIP — data source has no live views")
            else:
                names = ", ".join(f"'{n}'" for _, n in views)
                print(f"    tier 2: SKIP — {len(views)} views ({names}); attribution would be a guess")
            return

        own, squash = _exact_updates(gid)
        r1 = (await s.execute(own)).rowcount + (await s.execute(squash)).rowcount
        print(f"    tier 1: attributed {r1} commits from their branches")

        if len(views) == 1:
            vid, vname = views[0]
            rb = (await s.execute(
                update(BranchORM)
                .where(BranchORM.graph_id == gid, BranchORM.kind == "draft",
                       BranchORM.originating_view_id.is_(None))
                .values(originating_view_id=vid)
                .execution_options(synchronize_session=False))).rowcount
            own, squash = _exact_updates(gid)                     # cascade onto their commits
            rc = (await s.execute(own)).rowcount + (await s.execute(squash)).rowcount
            print(f"    tier 2: attributed {rb} draft branches + {rc} commits to view '{vname}' ({vid})")
        elif not views:
            print("    tier 2: skipped — data source has no live views")
        else:
            print(f"    tier 2: skipped — {len(views)} views; attribution would be a guess")

        b1, c1 = await _null_counts(s, gid)
        print(f"    remaining unattributed: {b1} draft branches, {c1} commits "
              f"(genesis/import/main write-throughs stay NULL by design)")


async def main() -> None:
    p = argparse.ArgumentParser(
        description="Backfill originating_view_id onto pre-view-tracking branches/commits.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--data-source-id", help="one data source (resolved to its graph)")
    g.add_argument("--all", action="store_true", help="every versioned graph")
    p.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    args = p.parse_args()

    async with gvdb.graphver_session() as s:
        rows = (await s.execute(select(GraphORM.id, GraphORM.data_source_id))).all()
    targets = [(gid, ds) for gid, ds in rows
               if args.all or ds == args.data_source_id]
    if not targets:
        sys.exit("error: no versioned graph matches"
                 + ("" if args.all else f" data source {args.data_source_id}"))

    print(("APPLYING to" if args.apply else "DRY-RUN over")
          + f" {len(targets)} graph(s):\n")
    for gid, ds in targets:
        await _backfill_graph(gid, ds, apply=args.apply)
    if not args.apply:
        print("\nNothing written. Re-run with --apply to write.")
    await gvdb.dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
