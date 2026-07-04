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
from typing import Any, AsyncIterator, Dict, List

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


class ExportWorker:
    def __init__(self, versioning, store) -> None:
        self._svc = versioning
        self._store = store

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
        eid_to_qname = {eid: p.get("qualifiedName") for eid, p in nodes.items()}

        node_records = [
            {"kind": "node", **denormalize_node(eid, content_hash(p), p)}
            for eid, p in nodes.items()
        ]
        edge_records = [
            {"kind": "edge", **denormalize_edge(
                eid, content_hash(p), p,
                source_qname=eid_to_qname.get(p.get("sourceEntityId")),
                target_qname=eid_to_qname.get(p.get("targetEntityId")))}
            for eid, p in edges.items()
        ]
        records = node_records + edge_records
        columns = self._columns(records)

        adapter = get_adapter(fmt)

        async def _iter() -> AsyncIterator[Dict[str, Any]]:
            for rec in records:
                yield rec

        stat = await self._store.put_stream(result_uri, adapter.write(_iter(), columns=columns))

        summary = {"nodes": len(node_records), "edges": len(edge_records), "bytes": stat.size}
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            row.status = "completed"
            row.completed_at = _now()
            row.updated_at = _now()
            row.summary = summary
        return summary

    @staticmethod
    def _columns(records: List[Dict[str, Any]]) -> List[str]:
        """Deterministic column order: kind + core (node then edge) + sorted prop.* +
        properties_json + _op — the union across all records (for csv/tsv/xlsx; ndjson ignores)."""
        base = ["kind"] + _NODE_COL_ORDER + [c for c in _EDGE_COL_ORDER if c not in _NODE_COL_ORDER]
        seen = set(base)
        props = sorted({k for r in records for k in r if k.startswith("prop.")})
        tail = [c for c in ("properties_json", "_op") if any(c in r for r in records)]
        cols = [c for c in base if any(c in r for r in records)]
        return cols + props + tail
