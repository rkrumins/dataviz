#!/usr/bin/env python3
"""Heal: remove node properties that a removal left behind in FalkorDB.

Background: a property removed from an entity was removed from its projected FalkorDB node only
when its name was not one the platform uses ANYWHERE — so a user property called ``id``,
``weight``, ``confidence``, ``seq``… stayed on the node after it was deleted (still in the
Properties panel, still matching search filters), and a pass that could not resolve the
platform's names removed none at all. The projector no longer does either
(``FalkorProjector._mark_removed_properties``); this script removes what earlier passes left.

What is removed, per node of a projected graph — and nothing else:

* a NATIVE property of a node the projector wrote (it carries ``n.entityId``) whose entity is
  live on ``main``,
* that is not a reserved node key (``_RESERVED_NODE_KEYS``) nor the node's own identity property
  (the source property its ``urnSource`` / ``nameSource`` stamp names),
* and that the entity's committed ``main`` payload does not hold among its ``properties``.

A node ``main`` does not hold is never touched. Postgres is the system of record, so this only
ever makes FalkorDB agree with it. Idempotent: a second run finds nothing.

Usage:
  # Dry-run every projected graph (read-only; prints per-graph counts and the commonest keys):
  python backend/scripts/heal_native_leftovers.py

  # One graph / data source:
  python backend/scripts/heal_native_leftovers.py --graph-id <gid>
  python backend/scripts/heal_native_leftovers.py --data-source-id <ds>

  # Remove:
  python backend/scripts/heal_native_leftovers.py --apply
"""
import argparse
import asyncio
import os
import sys
from collections import Counter
from typing import Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Set

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.services.versioning.projection import (  # noqa: E402
    _READ_TIMEOUT_MS,
    _projector_owned_property_names,
    _q,
    _sanitize_label,
)
from backend.common.derived_artifacts import is_derived_label  # noqa: E402

#: Internal-id window per scan query, and nodes per removal write.
ID_PAGE = 20_000
WRITE_BATCH = 500


def stale_native_keys(held: Iterable[str], identity: Iterable[Optional[str]],
                      payload: Optional[Mapping]) -> Set[str]:
    """The native keys a node holds that its committed payload no longer has (see module doc).

    Nothing for a node ``main`` does not hold (``payload`` is None)."""
    if payload is None:
        return set()
    keep = _projector_owned_property_names() | {k for k in identity if isinstance(k, str) and k}
    props = payload.get("properties") or {}
    return {k for k in held if k not in keep and k not in props}


async def heal_graph(
    client,
    lookup: Callable[[List[str]], Awaitable[Mapping[str, Optional[dict]]]],
    *,
    apply: bool,
    id_page: int = ID_PAGE,
) -> Dict[str, object]:
    """Scan one FalkorDB graph by internal-id windows; remove (``apply``) or count the stale keys.

    ``lookup(entity_ids)`` answers each id's committed ``main`` payload (absent / None = not live).
    Bounded: one window of nodes and their payloads in memory at a time."""
    res = await _q(client, "MATCH (n) RETURN max(id(n))", timeout_ms=_READ_TIMEOUT_MS, read_only=True)
    rows = getattr(res, "result_set", None) or []
    top = rows[0][0] if rows and rows[0] and rows[0][0] is not None else -1
    nodes = healed = 0
    keys: Counter = Counter()
    for lo in range(0, int(top) + 1, id_page):
        res = await _q(client,
                       "MATCH (n) WHERE id(n) >= $lo AND id(n) < $hi AND n.entityId IS NOT NULL "
                       "RETURN labels(n), n.urn, n.entityId, keys(n), n.urnSource, n.nameSource",
                       params={"lo": lo, "hi": lo + id_page},
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        page = [r for r in (getattr(res, "result_set", None) or [])
                if r[1] and not any(is_derived_label(str(x)) for x in (r[0] or []))]
        if not page:
            continue
        nodes += len(page)
        values = await lookup([str(r[2]) for r in page])
        by_label: Dict[str, list] = {}
        for labels, urn, eid, held, urn_source, name_source in page:
            gone = stale_native_keys(held or [], (urn_source, name_source), values.get(str(eid)))
            if not gone:
                continue
            healed += 1
            keys.update(gone)
            label = _sanitize_label(str((labels or ["Entity"])[0]))
            by_label.setdefault(label, []).append({"urn": urn, "gone": {k: None for k in gone}})
        if apply:
            for label, items in by_label.items():
                for i in range(0, len(items), WRITE_BATCH):
                    await _q(client, f"UNWIND $batch AS item MATCH (n:{label} {{urn: item.urn}}) "
                                     f"SET n += item.gone",
                             params={"batch": items[i:i + WRITE_BATCH]})
    return {"nodes": nodes, "healed": healed, "keys": keys}


async def _projected_graphs(graph_id: Optional[str], data_source_id: Optional[str]) -> List[dict]:
    from sqlalchemy import select

    from backend.app.services.versioning import db as gv_db
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    async with gv_db.graphver_session() as s:
        q = (select(GraphORM.graph_id, GraphORM.data_source_id, ProjectionStateORM.falkor_graph_name,
                    ProjectionStateORM.falkor_provider)
             .join(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.graph_id)
             .where(ProjectionStateORM.falkor_graph_name.isnot(None))
             .where(ProjectionStateORM.status != "evicted"))
        if graph_id:
            q = q.where(GraphORM.graph_id == graph_id)
        if data_source_id:
            q = q.where(GraphORM.data_source_id == data_source_id)
        return [dict(r._mapping) for r in (await s.execute(q)).all()]


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--graph-id", help="heal a single graph")
    p.add_argument("--data-source-id", help="heal the graph backing this data source")
    p.add_argument("--apply", action="store_true", help="remove the stale properties (default: dry-run)")
    args = p.parse_args()

    from backend.app.providers.falkor_graph_registry import make_registry_graph_factory
    from backend.app.services.versioning import db as gv_db
    from backend.app.services.versioning.projection import FalkorProjector
    from backend.app.services.versioning.service import GraphVersioningService

    svc = GraphVersioningService()
    projector = FalkorProjector(make_registry_graph_factory())
    graphs = await _projected_graphs(args.graph_id, args.data_source_id)
    print(f"mode: {'APPLY' if args.apply else 'DRY-RUN'}   projected graphs: {len(graphs)}")
    totals: Counter = Counter()
    for g in graphs:
        gid = g["graph_id"]
        print(f"\n=== graph {gid}  (data_source={g['data_source_id']}, falkor={g['falkor_graph_name']}) ===")
        try:
            main_id = await svc.main_branch_id(gid)

            async def lookup(ids, gid=gid, main_id=main_id):
                async with gv_db.graphver_session() as s:
                    return await svc._current_values(s, gid, main_id, ids)

            client = await projector._graph_client(g["falkor_graph_name"], g["falkor_provider"])
            res = await heal_graph(client, lookup, apply=args.apply)
        except Exception as exc:                   # noqa: BLE001 — one bad graph must not abort the sweep
            print(f"    ! error: {exc}")
            totals["errored"] += 1
            continue
        verb = "healed" if args.apply else "would heal"
        print(f"    scanned {res['nodes']} projected node(s); {verb} {res['healed']}")
        for key, n in res["keys"].most_common(10):
            print(f"      {n:>7} x {key}")
        totals["healed" if args.apply else "would_heal"] += res["healed"]
    print("\n=== summary ===")
    for k, v in totals.items():
        print(f"  {k}: {v}")
    await gv_db.dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
