"""ExportWorker — stream a graph (or as-of snapshot) to a downloadable, re-importable artifact.

Reads the versioned store (source of truth), denormalizes each node/edge to the shared template
columns (locked entity_id/urn/baseVersion + core + prop.* + properties_json), and writes them to
the object store via the chosen format adapter. A whole-graph export doubles as a **backup**: the
identity columns let a re-import restore/clone faithfully (round-trips to a zero diff when
unchanged). ``as_of_seq`` gives point-in-time exports (E5).

v1 materializes the state then streams the write; a keyset-streaming read (for 5M+) is a follow-up
that swaps ``materialize_state`` for ``reconcile._stream_pg_nodes`` without changing the rest.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from sqlalchemy import select

from .. import db
from ..merkle import content_hash
from ..models import BranchORM, JobORM
from .formats import get_adapter
from .rowmodel import denormalize_edge, denormalize_node

_NODE_COL_ORDER = ["entity_id", "urn", "entityType", "displayName", "qualifiedName",
                   "description", "sourceSystem", "layerAssignment", "tags", "baseVersion"]
_EDGE_COL_ORDER = ["entity_id", "edgeType", "sourceQualifiedName", "targetQualifiedName",
                   "source_entity_id", "target_entity_id", "confidence", "baseVersion"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def records_from_state(nodes: Dict[str, dict], edges: Dict[str, dict]) -> List[Dict[str, Any]]:
    """Denormalize a materialized ``{nodes, edges}`` state into template-shaped export records."""
    eid_to_qname = {eid: p.get("qualifiedName") for eid, p in nodes.items()}
    node_records = [
        {"kind": "node", **denormalize_node(eid, content_hash(p), p)} for eid, p in nodes.items()
    ]
    edge_records = [
        {"kind": "edge", **denormalize_edge(
            eid, content_hash(p), p,
            source_qname=eid_to_qname.get(p.get("sourceEntityId")),
            target_qname=eid_to_qname.get(p.get("targetEntityId")))}
        for eid, p in edges.items()
    ]
    return node_records + edge_records


def column_order(records: List[Dict[str, Any]], schema_props: Optional[Dict[str, List[str]]] = None) -> List[str]:
    """Deterministic, EDIT-READY column order (csv/tsv/xlsx; ndjson ignores).

    Property management is TABULAR — **every property is its own ``prop.<name>`` column**, like a
    spreadsheet/Airtable grid, so 10–50 properties are 10–50 columns you edit in place (never a
    bulky JSON blob). The property columns are the union of: what entities actually have + what the
    ontology defines for the types present (``schema_props`` = ``{"node": [...], "edge": [...]}``),
    so a defined-but-empty property is still a column to fill. ``properties_json`` is demoted to a
    pure OVERFLOW column for genuinely nested/complex values — emitted only when a record needs it.
    The full editable node core (description/tags/layer/…) is always present; edge columns only when
    the export has edges."""
    has_edge = any(r.get("kind") == "edge" for r in records)
    schema_props = schema_props or {}
    cols: List[str] = ["kind"] + list(_NODE_COL_ORDER)
    if has_edge:
        cols += [c for c in _EDGE_COL_ORDER if c not in cols]
    prop_cols = {k for r in records for k in r if k.startswith("prop.")}
    prop_cols |= {f"prop.{n}" for n in (schema_props.get("node") or [])}
    if has_edge:
        prop_cols |= {f"prop.{n}" for n in (schema_props.get("edge") or [])}
    cols += sorted(prop_cols)
    if any("properties_json" in r for r in records):    # overflow only — nested values, when present
        cols.append("properties_json")
    cols.append("_op")
    seen, out = set(), []                                # dedup, preserve order
    for c in cols:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def example_template_records() -> List[Dict[str, Any]]:
    """Worked example rows for an empty graph's starter template (edit or delete them)."""
    return [
        {"kind": "node", "entity_id": "", "urn": "", "entityType": "Table",
         "displayName": "Example table", "qualifiedName": "analytics.example_table",
         "description": "An example row — edit or delete me", "prop.owner": "data-team", "_op": ""},
        {"kind": "node", "entity_id": "", "urn": "", "entityType": "Column",
         "displayName": "id", "qualifiedName": "analytics.example_table.id",
         "prop.dataType": "bigint", "_op": ""},
        {"kind": "edge", "entity_id": "", "edgeType": "CONTAINS",
         "sourceQualifiedName": "analytics.example_table",
         "targetQualifiedName": "analytics.example_table.id", "_op": ""},
    ]


def _containment_children(edges: Dict[str, dict], cont: set) -> Dict[str, List[str]]:
    """Parent-entity-id -> child-entity-ids over the graph's containment edges."""
    children: Dict[str, List[str]] = {}
    for e in edges.values():
        if str(e.get("edgeType") or "").upper() in cont:
            children.setdefault(e.get("sourceEntityId"), []).append(e.get("targetEntityId"))
    return children


def _keep_from_assignments(nodes, edges, assigned_urns: set, inherit_urns: set, cont: set) -> set:
    """The view's entities: each explicitly layer-assigned URN, plus (when the assignment inherits
    children — the default for a Context View placing a subtree into a layer) all its containment
    descendants. This is the AUTHORITATIVE 'what the view contains', taken straight from the view's
    ``instance_assignments`` rather than a heuristic."""
    urn_to_eid = {p.get("urn"): eid for eid, p in nodes.items() if p.get("urn")}
    children = _containment_children(edges, cont)
    keep, seen = set(), set()
    stack = [(urn_to_eid[u], u in inherit_urns) for u in assigned_urns if u in urn_to_eid]
    while stack:
        eid, descend = stack.pop()
        if eid in seen:
            continue
        seen.add(eid)
        keep.add(eid)
        if descend:
            for child in children.get(eid, []):
                stack.append((child, True))
    return keep


def _keep_from_filters(nodes, scope: Dict[str, Any]) -> set:
    """Fallback scope for views defined by entity-type / layer allow-lists (empty = unrestricted)."""
    types = {str(t).upper() for t in (scope.get("entity_types") or [])}
    layers = set(scope.get("layers") or [])
    if not types and not layers:
        return set(nodes.keys())
    keep = set()
    for eid, p in nodes.items():
        if types and str(p.get("entityType") or "").upper() not in types:
            continue
        if layers and p.get("layerAssignment") not in layers:
            continue
        keep.add(eid)
    return keep


def filter_to_scope(nodes: Dict[str, dict], edges: Dict[str, dict], scope: Dict[str, Any]):
    """Restrict a materialized ``{nodes, edges}`` to a view's entity set (plan Phase 4).

    Primary source: the view's explicit layer assignments (``context_model.instance_assignments``) —
    the assigned URNs plus their containment descendants. Fallback: entity-type/layer allow-lists.
    Edges are kept only when BOTH endpoints are in-scope."""
    cont = {str(t).upper() for t in (scope.get("containment_types") or [])}
    assigned = set(scope.get("assigned_urns") or [])
    if assigned:
        keep = _keep_from_assignments(nodes, edges, assigned, set(scope.get("inherit_urns") or []), cont)
    else:
        keep = _keep_from_filters(nodes, scope)
    fnodes = {eid: p for eid, p in nodes.items() if eid in keep}
    fedges = {eid: p for eid, p in edges.items()
              if p.get("sourceEntityId") in keep and p.get("targetEntityId") in keep}
    return fnodes, fedges


class ExportWorker:
    def __init__(self, versioning, store, scope: Optional[Dict[str, Any]] = None,
                 extra_props: Optional[List[str]] = None) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope
        # Property names the user wants as (initially empty) columns to fill — "add a new property".
        self._extra_props = [p for p in (extra_props or []) if str(p).strip()]

    async def run(self, job_id: str) -> Dict[str, int]:
        async with db.graphver_session() as s:
            job = await s.get(JobORM, job_id)
            job.status = "running"
            job.started_at = _now()
            graph_id, fmt = job.graph_id, job.import_format or "ndjson"
            as_of_seq, result_uri = job.as_of_seq, job.result_uri
            main_id = (await s.execute(
                select(BranchORM.id).where(
                    BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()

        state = await self._svc.materialize_state(
            graph_id=graph_id, branch_id=main_id, as_of_seq=as_of_seq)
        nodes, edges = state["nodes"], state["edges"]
        if self._scope:                                   # view-scoped export (Phase 4)
            nodes, edges = filter_to_scope(nodes, edges, self._scope)
        records = records_from_state(nodes, edges)
        # Every property is its own column: existing ones (unioned in column_order) + any the user
        # asked to add, so a brand-new property is an empty column ready to fill.
        schema_props = {"node": self._extra_props, "edge": self._extra_props} if self._extra_props else None
        columns = column_order(records, schema_props)

        adapter = get_adapter(fmt)

        async def _iter() -> AsyncIterator[Dict[str, Any]]:
            for rec in records:
                yield rec

        stat = await self._store.put_stream(result_uri, adapter.write(_iter(), columns=columns))

        summary = {"nodes": len(nodes), "edges": len(edges), "bytes": stat.size}
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            row.status = "completed"
            row.completed_at = _now()
            row.updated_at = _now()
            row.summary = summary
        return summary
