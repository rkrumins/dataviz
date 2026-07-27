"""Report which private Views stop being readable by their workspace.

Read-only. Changes nothing.

Context
-------
Read access used to pass if the caller held ``workspace:view:read`` in a
View's workspace, regardless of the View's tier — so ``private`` behaved
exactly like ``workspace`` for anyone inside it. Tightening that is the
fix, but it is also a real access removal: every private View that was
de-facto team-shared becomes invisible to teammates the moment the change
ships.

Nobody is notified by the system, because from its point of view nothing
happened to those Views. Run this before or after the upgrade to get the
list, so owners can be told rather than discovering it.

Usage
-----
    python -m backend.scripts.report_private_view_exposure            # table
    python -m backend.scripts.report_private_view_exposure --json     # machine-readable

Exit code is 0 whether or not anything is affected — this is a report,
not a check.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import defaultdict

from sqlalchemy import select

from backend.app.db.engine import get_session_factory
from backend.app.db.models import (
    ResourceGrantORM,
    RoleBindingORM,
    UserORM,
    ViewORM,
    WorkspaceORM,
)


async def _collect() -> list[dict]:
    async with get_session_factory()() as session:
        views = (await session.execute(
            select(ViewORM).where(
                ViewORM.visibility == "private",
                ViewORM.deleted_at.is_(None),
            )
        )).scalars().all()
        if not views:
            return []

        ws_ids = {v.workspace_id for v in views if v.workspace_id}
        ws_names = dict((await session.execute(
            select(WorkspaceORM.id, WorkspaceORM.name)
            .where(WorkspaceORM.id.in_(ws_ids))
        )).all())

        # Who held a binding into each workspace — the people who could
        # read these views under the old rule and cannot under the new one.
        members: dict[str, set[str]] = defaultdict(set)
        for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.scope_type == "workspace",
                RoleBindingORM.scope_id.in_(ws_ids),
            )
        )).scalars().all():
            members[b.scope_id].add(f"{b.subject_type}:{b.subject_id}")

        # Explicit shares survive the change untouched, so a view that was
        # already shared with the people who need it loses nothing.
        shared: dict[str, int] = defaultdict(int)
        for g in (await session.execute(
            select(ResourceGrantORM).where(
                ResourceGrantORM.resource_type == "view",
                ResourceGrantORM.resource_id.in_([v.id for v in views]),
            )
        )).scalars().all():
            shared[g.resource_id] += 1

        creators = {v.created_by for v in views if v.created_by}
        owner_email = dict((await session.execute(
            select(UserORM.id, UserORM.email).where(UserORM.id.in_(creators))
        )).all()) if creators else {}

        out = []
        for v in views:
            audience = members.get(v.workspace_id, set())
            # The creator kept access all along; don't count them as lost.
            lost = {m for m in audience if m != f"user:{v.created_by}"}
            if not lost:
                continue
            out.append({
                "view_id": v.id,
                "view_name": v.name,
                "workspace_id": v.workspace_id,
                "workspace_name": ws_names.get(v.workspace_id),
                "owner_id": v.created_by,
                "owner_email": owner_email.get(v.created_by or ""),
                "principals_losing_access": len(lost),
                "existing_explicit_shares": shared.get(v.id, 0),
                "updated_at": v.updated_at,
            })
        out.sort(key=lambda r: -r["principals_losing_access"])
        return out


def _print_table(rows: list[dict]) -> None:
    if not rows:
        print("No private views were reachable via workspace membership. "
              "Nothing changes for anyone.")
        return
    total = sum(r["principals_losing_access"] for r in rows)
    print(
        f"{len(rows)} private view(s) were readable through workspace "
        f"membership and will stop being so.\n"
        f"{total} principal-view pairs affected in total.\n"
    )
    print(f"{'VIEW':<40} {'WORKSPACE':<24} {'OWNER':<32} {'LOSING':>6} {'SHARED':>6}")
    print("-" * 112)
    for r in rows:
        print(
            f"{(r['view_name'] or r['view_id'])[:39]:<40} "
            f"{(r['workspace_name'] or r['workspace_id'] or '?')[:23]:<24} "
            f"{(r['owner_email'] or r['owner_id'] or '?')[:31]:<32} "
            f"{r['principals_losing_access']:>6} "
            f"{r['existing_explicit_shares']:>6}"
        )
    print(
        "\nSHARED = explicit shares already on the view; those are unaffected.\n"
        "A view with 0 explicit shares and a high LOSING count is the one to "
        "ask its owner about — it may have been relied on as a team view."
    )


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json", action="store_true", help="emit JSON instead of a table",
    )
    args = parser.parse_args()
    rows = await _collect()
    if args.json:
        json.dump(rows, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        _print_table(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
