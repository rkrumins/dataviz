"""ExportWorker — stream a graph (or as-of snapshot) to a downloadable, re-importable artifact.

Reads the versioned store (source of truth), denormalizes each node/edge to the shared template
columns (locked entity_id/urn/baseVersion + core + prop.* + properties_json), and writes them to
the object store via the chosen format adapter. A whole-graph export doubles as a **backup**: the
identity columns let a re-import restore/clone faithfully (round-trips to a zero diff when
unchanged). ``as_of_seq`` gives point-in-time exports (E5).

The job reads and writes a page at a time through :mod:`.stream`, as the streamed download does,
so an export of any size runs in flat memory; this module keeps the row shape both share.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .. import db
from ..merkle import content_hash
from ..models import JobORM
from . import stream
from .import_worker import heartbeat
from .rowmodel import denormalize_edge, denormalize_node

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def records_from_state(nodes: Dict[str, dict], edges: Dict[str, dict]) -> List[Dict[str, Any]]:
    """Denormalize a materialized ``{nodes, edges}`` state into template-shaped export records."""
    eid_to_qname = {eid: p.get("qualifiedName") for eid, p in nodes.items()}
    eid_to_urn = {eid: p.get("urn") for eid, p in nodes.items()}
    node_records = [
        {"kind": "node", **denormalize_node(eid, content_hash(p), p)} for eid, p in nodes.items()
    ]
    edge_records = [
        {"kind": "edge", **denormalize_edge(
            eid, content_hash(p), p,
            source_qname=eid_to_qname.get(p.get("sourceEntityId")),
            target_qname=eid_to_qname.get(p.get("targetEntityId")),
            source_urn=eid_to_urn.get(p.get("sourceEntityId")),
            target_urn=eid_to_urn.get(p.get("targetEntityId")))}
        for eid, p in edges.items()
    ]
    return node_records + edge_records


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


class ExportWorker:
    def __init__(self, versioning, store, scope: Optional[Dict[str, Any]] = None,
                 options: Optional[Dict[str, Any]] = None, after_write=None) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope
        # Optional async ``(job_id, result_uri, summary) -> {"resultUri"?, "summary"?}``, run once the
        # artifact is written and before the job completes: how a view package is built around the
        # data (view_transfer.package.finish_export). What it returns updates the job.
        self._after_write = after_write
        options = options or {}
        # Property names to emit as (empty) columns — "add a new property".
        self._extra_props = [p for p in (options.get("props") or []) if str(p).strip()]
        # Row-scoping: an explicit id/urn set and/or entity types to include.
        self._select_ids = options.get("ids") or []
        self._select_types = options.get("types") or []

    async def run(self, job_id: str) -> Dict[str, int]:
        from .snapshot import open_snapshot

        async with db.graphver_session() as s:
            job = await s.get(JobORM, job_id)
            job.status = "running"
            job.started_at = _now()
            graph_id, fmt = job.graph_id, job.import_format or "ndjson"
            as_of_seq, result_uri, branch_id = job.as_of_seq, job.result_uri, job.branch_id

        # Read a page at a time from one pinned snapshot (stream.py), never the whole state. A
        # branch_id (a working draft) composes main + committed + staged changes — so a user can
        # export their in-progress branch, edit in Excel, and re-import onto the same branch.
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id, as_of_seq=as_of_seq)
        keep = (await stream.view_entities(snap, self._scope))["keep"] if self._scope else None
        selection = stream.Selection.of(keep=keep, ids=self._select_ids, types=self._select_types)
        # A spreadsheet makes every property its own column: existing ones + any the user asked to
        # add, so a brand-new property is an empty column ready to fill.
        tally = {"node": 0, "edge": 0}
        # It takes its turn with the streamed exports; the heartbeat keeps it alive while it waits.
        body = stream.in_turn(stream.write_export(lambda: stream.record_pages(snap, selection, tally=tally),
                                                  fmt=fmt, props=self._extra_props))
        beat = asyncio.create_task(heartbeat(job_id))   # a large export writes for many minutes
        try:
            async with contextlib.aclosing(body):       # its turn goes back even if the store fails
                stat = await self._store.put_stream(result_uri, body)
        finally:
            beat.cancel()

        summary = {"nodes": tally["node"], "edges": tally["edge"], "bytes": stat.size}
        finished = (await self._after_write(job_id, result_uri, summary) or {}) if self._after_write else {}
        summary = {**summary, **(finished.get("summary") or {})}
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            row.status = "completed"
            row.completed_at = _now()
            row.updated_at = _now()
            row.summary = summary
            if finished.get("resultUri"):
                row.result_uri = finished["resultUri"]
        return summary
