#!/usr/bin/env python3
"""One-time repair: canonicalize mixed-case edge (and entity) type casing in committed
graphver data, then re-project FalkorDB.

Background (the FalkorDB wizard flat-tree bug): manual/blank graphs accumulated edge
payloads whose ``edgeType`` differs from the ontology's declared relationship type only by
case — e.g. a lowercase ``has`` where the ontology declares containment ``HAS``. FalkorDB
matches relationship types CASE-SENSITIVELY, so a lowercase ``has`` projects as ``:has`` and
misses the ``:HAS`` containment predicate the wizard's top-level / child-count queries use →
every node reads as top-level (a flat "N top-level · 0 nested" tree), while the canvas (whose
containment matching is case-insensitive) nests correctly. The code fix
(``canonicalize_payload_types`` at the commit boundary) stops it recurring; this script
repairs the data already committed.

Repair mechanism — APPEND A COMMIT, never rewrite in place:
    graphver version rows are content-addressed (``content_hash`` over the payload JSON) and
    strictly append-only; each commit's ``merkle_root`` covers ``{entity_id: content_hash}``.
    Rewriting a historical payload in place would change its content hash and silently break
    the Merkle root of every commit that referenced it — corrupting the tamper-evident
    history and violating the append-only invariant. So instead we append ONE ordinary
    ``apply_ops`` update commit per graph carrying the corrected ``edgeType``, run WITH the
    ontology rules so the commit-boundary canonicalizer confirms the casing. This flows
    through the normal projection pipeline automatically (the commit advances the projection
    target); no manual reseed of the version store is needed.

Missing ``edgeType`` edges are NEVER guessed by default — they are reported (graph, edge id,
endpoints) for a human to fix via the UI/import. The one exception, behind
``--infer-containment`` (default off): if the ontology declares EXACTLY ONE containment type
AND both endpoints' entity types form a declared containment pair, the repair may set it.

Usage:
  # Dry-run every graph that has a resolvable ontology (read-only; prints per-graph counts):
  python backend/scripts/repair_edge_type_casing.py

  # Dry-run a single graph / data source:
  python backend/scripts/repair_edge_type_casing.py --graph-id <gid>
  python backend/scripts/repair_edge_type_casing.py --data-source-id <ds>

  # Apply (append a repair commit per affected graph) + re-project FalkorDB:
  python backend/scripts/repair_edge_type_casing.py --apply --actor you

  # Also infer a single-containment type onto missing-edgeType edges:
  python backend/scripts/repair_edge_type_casing.py --apply --infer-containment --actor you
"""
import argparse
import asyncio
import os
import sys
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from sqlalchemy import select

from backend.app.ontology.rules import resolved_ontology_to_rules
from backend.app.services.versioning import db as gv_db
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.ontology import OntologyRules
from backend.app.services.versioning.service import GraphVersioningService


# --------------------------------------------------------------------------- #
# Pure decision logic (kept importable + unit-testable — no I/O).              #
# --------------------------------------------------------------------------- #
def _ci_in(name: str, allowed) -> bool:
    """Case-insensitive membership (parity with ontology._type_in)."""
    if name in allowed:
        return True
    up = str(name).upper()
    return any(str(a).upper() == up for a in allowed)


def plan_edge_repairs(
    edges: Dict[str, dict],
    nodes: Dict[str, dict],
    rules: OntologyRules,
    *,
    infer_containment: bool = False,
) -> Tuple[List[dict], List[dict], Optional[str]]:
    """Decide the repair for one graph's current ``main`` edges.

    ``edges``/``nodes`` are ``{entity_id: payload}`` (the live head state). Returns
    ``(repair_ops, missing, single_containment)``:

    * ``repair_ops`` — ``apply_ops`` update ops (edge payloads with ``edgeType`` rewritten to
      the ontology's declared casing). Only edges whose casing actually differs are included.
    * ``missing`` — one record per edge with no ``edgeType``: ``{eid, source, target,
      source_type, target_type, inferred}``. ``inferred`` is the type set when
      ``--infer-containment`` applied, else ``None`` (report-only).
    * ``single_containment`` — the sole declared containment type's declared casing, or
      ``None`` when the ontology declares zero or more than one (inference disabled).
    """
    conts = sorted(rules.containment_edge_types)
    single_cont = rules.canonical_edge_type(conts[0]) if len(conts) == 1 else None

    repair_ops: List[dict] = []
    missing: List[dict] = []
    for eid, p in edges.items():
        edt = str(p.get("edgeType") or p.get("edge_type") or "").strip()
        if edt:
            canon = rules.canonical_edge_type(edt)
            if canon and canon != edt:
                new_p = dict(p)
                new_p["edgeType"] = canon
                repair_ops.append({"op": "update", "entity_kind": "edge",
                                   "entity_id": eid, "payload": new_p})
            continue
        # Missing edgeType — report, and optionally infer a single declared containment type.
        src = p.get("sourceEntityId") or p.get("source_entity_id")
        tgt = p.get("targetEntityId") or p.get("target_entity_id")
        st = (nodes.get(src) or {}).get("entityType")
        tt = (nodes.get(tgt) or {}).get("entityType")
        rec = {"eid": eid, "source": src, "target": tgt,
               "source_type": st, "target_type": tt, "inferred": None}
        if infer_containment and single_cont and st and tt:
            canon_parent = rules.canonical_entity_type(st)
            parent_rule = rules.entity_types.get(canon_parent) if canon_parent else None
            allowed = parent_rule.can_contain if parent_rule else frozenset()
            if allowed and _ci_in(tt, allowed):
                new_p = dict(p)
                new_p["edgeType"] = single_cont
                repair_ops.append({"op": "update", "entity_kind": "edge",
                                   "entity_id": eid, "payload": new_p})
                rec["inferred"] = single_cont
        missing.append(rec)
    return repair_ops, missing, single_cont


# --------------------------------------------------------------------------- #
# I/O helpers                                                                  #
# --------------------------------------------------------------------------- #
async def _resolve_rules(workspace_id, data_source_id) -> Optional[OntologyRules]:
    """The data source's assigned ontology as rich rules (declared casing), or ``None``."""
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.service import LocalOntologyService
        async with get_async_session() as session:
            resolved = await LocalOntologyService(SQLAlchemyOntologyRepository(session)).resolve(
                workspace_id=workspace_id, data_source_id=data_source_id)
    except Exception as exc:                       # noqa: BLE001 — best-effort, report + skip
        print(f"    ! ontology resolve failed: {exc}")
        return None
    rules = resolved_ontology_to_rules(resolved)
    if not rules.edge_type_canonical and not rules.entity_types:
        return None
    return rules


async def _list_graph_ids(kinds: Optional[List[str]]) -> List[Tuple[str, str, str, str]]:
    """``(graph_id, data_source_id, workspace_id, kind)`` for every graph (optionally filtered
    to ``kinds``)."""
    async with gv_db.graphver_session() as s:
        q = select(GraphORM.id, GraphORM.data_source_id, GraphORM.workspace_id, GraphORM.kind)
        if kinds:
            q = q.where(GraphORM.kind.in_(kinds))
        rows = (await s.execute(q)).all()
    return [(r[0], r[1], r[2], r[3]) for r in rows]


async def _reproject(svc: GraphVersioningService, gid: str) -> None:
    # A casing repair changes edge RELATIONSHIP TYPES. FalkorDB can't retype a relationship in
    # place, and the INCREMENTAL projector would MERGE the new-typed edge while leaving the
    # old-typed one behind (a `has` AND a `HAS` for the same edge). So force a FULL clean reseed:
    # rewind the projection watermark to 0 → project_graph DROPs the graph and rebuilds it from
    # committed main, yielding a canonical `:HAS`-only projection.
    try:
        async with gv_db.graphver_session() as s:
            ps = await s.get(ProjectionStateORM, gid)
            if ps is not None:
                ps.projected_commit_seq = 0
                await s.commit()
    except Exception as exc:                       # noqa: BLE001
        print(f"    ! could not rewind projection watermark ({exc})")
    try:
        from backend.app.api.v1.endpoints.versioning import project_now
        await project_now(gid)
    except Exception as exc:                       # noqa: BLE001
        print(f"    re-projection could not run in-process ({exc}); the async worker will catch up.")
    try:
        wm = await svc.projection_watermark(gid)
        print(f"    projection: committed={wm.get('committed')} projected={wm.get('projected')}")
    except Exception:                              # noqa: BLE001
        pass


async def _process_graph(
    svc: GraphVersioningService, meta: dict, *, apply: bool, actor: str,
    infer_containment: bool, no_project: bool,
) -> Dict[str, int]:
    gid = meta["graph_id"]
    ds = meta.get("data_source_id")
    print(f"\n=== graph {gid}  (data_source={ds}, kind={meta.get('kind')}) ===")
    rules = await _resolve_rules(meta.get("workspace_id"), ds)
    if rules is None:
        print("    skip: no resolvable ontology / no declared types")
        return {"skipped": 1}

    main_id = await svc.main_branch_id(gid)
    state = await svc.materialize_state(graph_id=gid, branch_id=main_id)
    edges, nodes = state["edges"], state["nodes"]

    repair_ops, missing, single_cont = plan_edge_repairs(
        edges, nodes, rules, infer_containment=infer_containment)

    # Per-casing tally for the log.
    casing: Dict[str, str] = {}
    for op in repair_ops:
        # find the pre-image casing for this edge
        pre = str(edges[op["entity_id"]].get("edgeType") or "").strip()
        casing[f"{pre!r} -> {op['payload']['edgeType']!r}"] = \
            str(int(casing.get(f"{pre!r} -> {op['payload']['edgeType']!r}", "0")) + 1)
    print(f"    edges={len(edges)} nodes={len(nodes)} "
          f"needing-casing-repair={len(repair_ops)} missing-edgeType={len(missing)}")
    for k, v in sorted(casing.items()):
        print(f"      {v:>4} x {k}")
    for m in missing:
        tag = f" -> inferred {m['inferred']!r}" if m["inferred"] else " (report only — fix in UI)"
        print(f"      MISSING edgeType: {m['eid']} {m['source_type']}->{m['target_type']}{tag}")

    if not repair_ops:
        print("    nothing to repair.")
        return {"unchanged": 1}

    if not apply:
        print("    dry-run: no commit written (pass --apply to repair).")
        return {"would_repair": len(repair_ops)}

    commit_id = await svc.apply_ops(
        graph_id=gid, ops=repair_ops, actor=actor,
        message="repair: canonicalize edge-type casing to the declared ontology spelling",
        ontology_rules=rules,
    )
    print(f"    repaired: commit {commit_id} ({len(repair_ops)} edges)")
    if not no_project:
        await _reproject(svc, gid)
    return {"repaired": len(repair_ops)}


async def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--graph-id", help="repair a single graph")
    p.add_argument("--data-source-id", help="repair the graph backing this data source")
    p.add_argument("--kinds", default="blank,manual,hybrid,authoritative",
                   help="comma-separated graph kinds to sweep (default: all)")
    p.add_argument("--apply", action="store_true",
                   help="append a repair commit per affected graph (default: dry-run)")
    p.add_argument("--infer-containment", action="store_true",
                   help="set the sole declared containment type onto missing-edgeType edges "
                        "whose endpoints form a declared containment pair (default: off)")
    p.add_argument("--no-project", action="store_true", help="skip FalkorDB re-projection")
    p.add_argument("--actor", default="repair-script", help="commit actor")
    args = p.parse_args()

    svc = GraphVersioningService()

    metas: List[dict] = []
    if args.graph_id:
        m = await svc.get_graph(args.graph_id)
        if m is None:
            sys.exit(f"error: no graph {args.graph_id}")
        metas = [m]
    elif args.data_source_id:
        m = await svc.get_graph_by_data_source(args.data_source_id)
        if m is None:
            sys.exit(f"error: no graph for data source {args.data_source_id}")
        metas = [m]
    else:
        kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
        ids = await _list_graph_ids(kinds)
        metas = [{"graph_id": g, "data_source_id": ds, "workspace_id": ws, "kind": kind}
                 for (g, ds, ws, kind) in ids]

    print(f"mode: {'APPLY' if args.apply else 'DRY-RUN'}   graphs: {len(metas)}   "
          f"infer-containment: {args.infer_containment}")
    totals: Dict[str, int] = {}
    for m in metas:
        try:
            res = await _process_graph(
                svc, m, apply=args.apply, actor=args.actor,
                infer_containment=args.infer_containment, no_project=args.no_project)
        except Exception as exc:                   # noqa: BLE001 — one bad graph must not abort the sweep
            print(f"    ! error processing {m['graph_id']}: {exc}")
            res = {"errored": 1}
        for k, v in res.items():
            totals[k] = totals.get(k, 0) + v

    print("\n=== summary ===")
    for k in ("repaired", "would_repair", "unchanged", "skipped", "errored"):
        if k in totals:
            print(f"  {k}: {totals[k]}")


if __name__ == "__main__":
    asyncio.run(main())
