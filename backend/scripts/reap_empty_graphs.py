"""Report — and optionally delete — 0-node / 0-edge FalkorDB graphs.

WHY: until the resurrection guard shipped, every scheduled observability pass
recreated a graph an operator had deleted. FalkorDB creates a missing graph key
for ``GRAPH.QUERY`` (``should_command_create_graph``: true for QUERY/PROFILE,
false for RO_QUERY/EXPLAIN), and the connect-time index reconcile issues
``CREATE INDEX`` — a ``GRAPH.QUERY``. So a deleted graph came back empty within
one discovery sweep, every sweep, forever. The code no longer does that; this
script clears the empties already sitting on the instances.

WHAT IT DOES, per active FalkorDB provider:
  1. ``GRAPH.LIST`` (topology-aware — unions every primary on a cluster, so a
     single-node listing cannot under-report and hide a graph from the reap).
  2. Counts each graph with ``GRAPH.RO_QUERY``, never ``GRAPH.QUERY`` — this
     script must not create the very thing it is here to remove.
  3. Marks each graph CLAIMED or ORPHAN by cross-referencing the management DB:
     active catalog items, active (non-deleted) workspace data sources and
     their dedicated projection companions.

DELETION IS OPT-IN AND NARROW BY DEFAULT:
  * ``--apply``            delete empty ORPHAN graphs (nothing registered
                           points at them).
  * ``--include-claimed``  also delete empty graphs a registered source still
                           claims. This is the "I deleted it in the UI and it
                           kept coming back" case: the row is legitimate, the
                           graph is the artifact. Re-run ingestion, or
                           unregister the source, afterwards.
  * ``--only a,b``         restrict to these graph names.
  * ``--provider p``       restrict to one provider id.

A NON-empty graph is never deleted, under any flag.

USAGE:
    python backend/scripts/reap_empty_graphs.py                     # report
    python backend/scripts/reap_empty_graphs.py --apply             # orphans
    python backend/scripts/reap_empty_graphs.py --apply --include-claimed

Requires the same env the services use (management DB + FalkorDB reachable).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from typing import Optional, Set

from sqlalchemy import select


@dataclass(frozen=True)
class GraphReport:
    provider_id: str
    name: str
    nodes: Optional[int]      # None = could not be counted
    edges: Optional[int]
    claimed_by: Optional[str]  # None = orphan

    @property
    def empty(self) -> bool:
        return self.nodes == 0 and self.edges == 0

    @property
    def countable(self) -> bool:
        return self.nodes is not None and self.edges is not None


async def _registered_names(provider_id: str) -> dict:
    """``graph name -> what claims it`` for one provider.

    Covers all three ways a name becomes legitimate: a catalog item's
    ``source_identifier``, a live data source's ``graph_name``, and the
    ``dedicated_graph_name`` companion a "dedicated" projection writes to.
    Soft-deleted sources are deliberately NOT claims — their graphs are exactly
    what an orphan sweep should find.
    """
    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    claims: dict = {}
    factory = get_session_factory(PoolRole.READONLY)
    async with factory() as session:
        rows = await session.execute(
            select(CatalogItemORM.source_identifier, CatalogItemORM.name).where(
                CatalogItemORM.provider_id == provider_id,
                CatalogItemORM.status == "active",
                CatalogItemORM.source_identifier.is_not(None),
            )
        )
        for ident, name in rows.all():
            claims[ident] = f"catalog item {name!r}"

        ds_rows = await session.execute(
            select(
                WorkspaceDataSourceORM.id,
                WorkspaceDataSourceORM.graph_name,
                WorkspaceDataSourceORM.dedicated_graph_name,
            ).where(
                WorkspaceDataSourceORM.provider_id == provider_id,
                WorkspaceDataSourceORM.is_active.is_(True),
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )
        for ds_id, graph_name, dedicated in ds_rows.all():
            if graph_name:
                claims.setdefault(graph_name, f"data source {ds_id}")
            if dedicated:
                claims.setdefault(dedicated, f"data source {ds_id} (projection)")
    return claims


async def _count(graph) -> tuple:
    """``(nodes, edges)`` via RO_QUERY, or ``(None, None)`` when unanswerable.

    A missing key answers "Invalid graph operation on empty key" — which for
    this script means the graph vanished between the listing and the count, not
    that it is empty. Reported as uncountable rather than reaped.
    """
    try:
        n = await graph.ro_query("MATCH (n) RETURN count(n)")
        e = await graph.ro_query("MATCH ()-[r]->() RETURN count(r)")
    except Exception as exc:
        print(f"    ! count failed: {exc}", file=sys.stderr)
        return None, None
    return int(n.result_set[0][0]), int(e.result_set[0][0])


async def _scan(provider_id: str, only: Optional[Set[str]]) -> list:
    from backend.app.providers.falkor_graph_registry import (
        list_graph_keys, resolve_provider_conn_config,
    )
    from backend.app.providers.falkordb_connection import graph_clients

    keys = await list_graph_keys(provider_id)
    if keys is None:
        print(f"  provider {provider_id}: GRAPH.LIST unavailable — skipped",
              file=sys.stderr)
        return []

    claims = await _registered_names(provider_id)
    cfg = await resolve_provider_conn_config(provider_id)

    out = []
    for name in sorted(keys):
        if only and name not in only:
            continue
        graph = await graph_clients().get_graph(cfg, name)
        nodes, edges = await _count(graph)
        out.append(GraphReport(
            provider_id=provider_id, name=name, nodes=nodes, edges=edges,
            claimed_by=claims.get(name),
        ))
    return out


async def _delete(provider_id: str, name: str) -> bool:
    from backend.app.providers.falkor_graph_registry import resolve_provider_conn_config
    from backend.app.providers.falkordb_connection import graph_clients

    cfg = await resolve_provider_conn_config(provider_id)
    graph = await graph_clients().get_graph(cfg, name)
    try:
        await graph.delete()
    except Exception as exc:
        print(f"    ! delete failed for {name}: {exc}", file=sys.stderr)
        return False
    await graph_clients().invalidate(cfg, name)
    return True


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="delete empty ORPHAN graphs (default: report only)")
    ap.add_argument("--include-claimed", action="store_true",
                    help="with --apply, also delete empty graphs a registered "
                         "source still claims")
    ap.add_argument("--provider", help="restrict to one provider id")
    ap.add_argument("--only", help="comma-separated graph names to consider")
    args = ap.parse_args()

    if args.include_claimed and not args.apply:
        ap.error("--include-claimed only means anything with --apply")

    from backend.app.db.engine import PoolRole, get_session_factory
    from backend.app.db.models import ProviderORM

    only = {s.strip() for s in args.only.split(",") if s.strip()} if args.only else None

    factory = get_session_factory(PoolRole.READONLY)
    async with factory() as session:
        rows = await session.execute(
            select(ProviderORM.id).where(
                ProviderORM.is_active.is_(True),
                ProviderORM.provider_type == "falkordb",
            )
        )
        provider_ids = [r[0] for r in rows.all()]
    if args.provider:
        provider_ids = [p for p in provider_ids if p == args.provider]
    if not provider_ids:
        print("No active FalkorDB providers to scan.")
        return 0

    reports = []
    for provider_id in provider_ids:
        print(f"provider {provider_id}")
        try:
            found = await _scan(provider_id, only)
        except Exception as exc:
            print(f"  ! scan failed: {exc}", file=sys.stderr)
            continue
        for r in found:
            state = (
                "UNCOUNTABLE" if not r.countable
                else "EMPTY" if r.empty
                else "populated"
            )
            claim = r.claimed_by or "ORPHAN"
            print(f"  {r.name:<40} {state:<12} {r.nodes}/{r.edges} nodes/edges  [{claim}]")
        reports.extend(found)

    empties = [r for r in reports if r.countable and r.empty]
    orphans = [r for r in empties if r.claimed_by is None]
    claimed = [r for r in empties if r.claimed_by is not None]

    print(
        f"\n{len(reports)} graph(s) scanned · {len(empties)} empty "
        f"({len(orphans)} orphan, {len(claimed)} claimed)"
    )

    if not args.apply:
        if empties:
            print("Dry run — nothing deleted. Re-run with --apply"
                  + (" --include-claimed" if claimed else "") + " to remove them.")
        return 0

    targets = orphans + (claimed if args.include_claimed else [])
    if claimed and not args.include_claimed:
        print(f"Leaving {len(claimed)} empty claimed graph(s) alone "
              "(pass --include-claimed to delete those too).")
    deleted = 0
    for r in targets:
        print(f"deleting {r.name} on {r.provider_id} …")
        if await _delete(r.provider_id, r.name):
            deleted += 1
    print(f"Deleted {deleted}/{len(targets)}.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
