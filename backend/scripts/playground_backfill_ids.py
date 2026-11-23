#!/usr/bin/env python3
"""Give each Playground graph made before graphs there were identified by ``id`` that identifier.

A Playground graph made now identifies its things by ``id`` (its data source's identity property,
``playground_policy.IDENTITY_PROPERTY``), which every write keeps equal to the thing's urn
(``node_identity.bind_node_write``). One made before identifies them by ``urn`` alone, and its
things have no ``id``. For each such graph this makes, in this order:

1. ONE commit on main writing ``id = urn`` onto every thing that has no ``id`` — appended like any
   edit (history is never rewritten in place), and projected by the projection worker as usual;
2. then the data source's identity property set to ``id``, and the caches that would serve the
   old mapping dropped (``node_identity.invalidate_node_identity``).

In that order, so nothing reads a thing keyed on an ``id`` it doesn't have yet. Idempotent: a
data source that already identifies its things by ``id`` is left alone, and a graph whose things
all have one gets no commit. Things only in an open draft get theirs on their next save there.

Usage:
  # Dry run (the default): what each graph would get.
  python backend/scripts/playground_backfill_ids.py
  python backend/scripts/playground_backfill_ids.py --data-source-id <ds>

  # Apply:
  python backend/scripts/playground_backfill_ids.py --apply --actor you
"""
import argparse
import asyncio
import os
import sys
from typing import Any, Dict, List, Mapping, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from sqlalchemy import select

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.node_identity import invalidate_node_identity
from backend.app.services.playground_policy import IDENTITY_PROPERTY, get_playground

MESSAGE = f"Give every thing its identifier ({IDENTITY_PROPERTY} = its urn)"


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def plan_id_backfill(nodes: Mapping[str, Optional[Mapping[str, Any]]]) -> List[dict]:
    """``apply_ops`` update ops writing ``id = urn`` onto each node of ``nodes`` (entity id ->
    payload, as ``materialize_state`` gives them) that has no ``id``. Pure."""
    ops = []
    for eid, payload in sorted(nodes.items()):
        if not payload or not _blank((payload.get("properties") or {}).get(IDENTITY_PROPERTY)):
            continue
        ops.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                    "payload": {"properties": {IDENTITY_PROPERTY: payload.get("urn") or eid}}})
    return ops


async def backfill(session, svc, *, apply: bool, actor: str,
                   data_source_id: Optional[str] = None, log=print) -> Dict[str, int]:
    """Backfill the Playground's live data sources not identified by ``id`` (or the one
    ``data_source_id`` names). Returns how many were done, would be, were already done, or had
    no versioned graph."""
    totals: Dict[str, int] = {}

    def count(what: str, n: int = 1) -> None:
        totals[what] = totals.get(what, 0) + n

    playground = await get_playground(session)
    if playground is None:
        log("There is no Playground: nothing to do.")
        return totals
    query = select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.workspace_id == playground.id, WorkspaceDataSourceORM.deleted_at.is_(None))
    if data_source_id:
        query = query.where(WorkspaceDataSourceORM.id == data_source_id)
    sources = list((await session.execute(query)).scalars())
    log(f"mode: {'APPLY' if apply else 'DRY-RUN'}   Playground data sources: {len(sources)}")
    for ds in sources:
        ds_id, ws_id, label = ds.id, ds.workspace_id, ds.label
        if (ds.identity_property or "").strip() == IDENTITY_PROPERTY:
            log(f"  {ds_id} ({label}): already identified by {IDENTITY_PROPERTY}")
            count("already")
            continue
        graph = await svc.get_graph_by_data_source(ds_id)
        if graph is None:
            log(f"  {ds_id} ({label}): no versioned graph — skipped")
            count("skipped")
            continue
        gid = graph["graph_id"]
        state = await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid))
        ops = plan_id_backfill(state["nodes"])
        log(f"  {ds_id} ({label}): graph {gid}, {len(state['nodes'])} things, {len(ops)} without an {IDENTITY_PROPERTY}")
        if not apply:
            count("would_backfill")
            continue
        if ops:
            commit_id = await svc.apply_ops(graph_id=gid, ops=ops, actor=actor, message=MESSAGE)
            log(f"    commit {commit_id}")
        # Only now: every thing on main has the id it will be identified by.
        row = await session.get(WorkspaceDataSourceORM, ds_id)
        row.identity_property = IDENTITY_PROPERTY
        await session.commit()
        await invalidate_node_identity(session, [(ws_id, ds_id)], reason="playground-backfill-ids")
        count("backfilled")
    return totals


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-source-id", help="only this Playground data source")
    p.add_argument("--apply", action="store_true", help="write the commits and set the identity (default: dry run)")
    p.add_argument("--actor", default="playground-backfill", help="the commits' actor")
    args = p.parse_args()

    from backend.app.db.engine import get_async_session
    from backend.app.services.versioning.service import GraphVersioningService

    async with get_async_session() as session:
        totals = await backfill(session, GraphVersioningService(), apply=args.apply, actor=args.actor,
                                data_source_id=args.data_source_id)
    print("\n=== summary ===")
    for what in ("backfilled", "would_backfill", "already", "skipped"):
        if what in totals:
            print(f"  {what}: {totals[what]}")


if __name__ == "__main__":
    asyncio.run(main())
