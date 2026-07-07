"""ImportWorker — parse an uploaded file, resolve it, and build it onto a draft branch.

Independent of the aggregation/ingestion worker: it copies that stateless-worker *pattern* but
imports none of it, and drives the **versioning service** (drafts), so an import is exactly the
manual create/edit flow at scale — repeated imports stack on one draft like successive manual edits.

Phases (all params on the ``JobORM`` row):
  parse    stream ``source_uri`` from the object store -> the format adapter -> :func:`normalize`
           -> ``import_rows`` (cursor-ordered, never buffering the whole file);
  resolve  match rows to the draft's composed state and build versioned ops (:func:`resolve_rows`);
  build    apply ops in ``IMPORT_COMMIT_WINDOW`` windows via ``apply_ops(branch_id=draft)``.

Invalid rows are quarantined (partial acceptance), not fatal; the tally lands on ``job.summary``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from sqlalchemy import select, update

from .. import config, db
from ..ids import prefixed_id
from ..models import BranchORM, ImportRowORM, JobORM
from .formats import get_adapter
from .resolve import resolve_rows
from .rowmodel import normalize

_PARSE_BATCH = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _chunks(seq: List[Any], size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _view_scope_eids(indexes, scope):
    """The view's in-scope entity ids from its layer assignments — the SAME rule as export's
    ``filter_to_scope``: each assigned urn + its containment descendants (when the assignment
    inherits children); an edge is in-scope when both endpoints are. Computed from entity_indexes'
    ``urn_to_eid`` + ``edge_to_eid`` (endpoint-triple keys), so no payloads are needed."""
    assigned = set(scope.get("assigned_urns") or [])
    inherit = set(scope.get("inherit_urns") or [])
    cont = {str(t).upper() for t in (scope.get("containment_types") or [])}
    urn_to_eid = indexes.get("urn_to_eid") or {}
    edge_to_eid = indexes.get("edge_to_eid") or {}
    children: Dict[str, List[str]] = {}
    for (src, _tgt, etype) in edge_to_eid:
        if str(etype).upper() in cont:
            children.setdefault(src, []).append(_tgt)
    keep, seen = set(), set()
    stack = [(urn_to_eid[u], u in inherit) for u in assigned if u in urn_to_eid]
    while stack:
        eid, descend = stack.pop()
        if eid in seen:
            continue
        seen.add(eid)
        keep.add(eid)
        if descend:
            for child in children.get(eid, []):
                stack.append((child, True))
    scope_edges = {eid for (src, tgt, _), eid in edge_to_eid.items() if src in keep and tgt in keep}
    return keep, scope_edges


def _append_replace_deletes(ops, resolutions, indexes, scope_nodes=None, scope_edges=None):
    """Replace mode = the file is the authoritative snapshot for its scope: every EXISTING entity in
    scope that no file row matched is deleted (reviewed on the draft before publish; ``apply_ops``
    cascades containment / incident edges). Upsert never deletes on absence — this is the deliberate
    override. ``scope_nodes``/``scope_edges`` (view-scoped replace) restrict the universe so only
    the view's own entities can be deleted, never the rest of the data source; ``None`` = whole
    graph. Returns ``(ops, delete_count)``. Derived deletes aren't file rows, so they're counted
    here, not staged into ``import_rows``."""
    matched_nodes = {r["matched_entity_id"] for r in resolutions
                     if r.get("matched_entity_id") and r.get("kind") == "node"}
    matched_edges = {r["matched_entity_id"] for r in resolutions
                     if r.get("matched_entity_id") and r.get("kind") == "edge"}
    universe_nodes = scope_nodes if scope_nodes is not None else set(indexes.get("node_eids") or ())
    universe_edges = scope_edges if scope_edges is not None else set(indexes.get("edge_eids") or ())
    absent_edges = universe_edges - matched_edges
    absent_nodes = universe_nodes - matched_nodes
    for eid in absent_edges:      # edges first, then nodes (apply_ops also cascades either way)
        ops.append({"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None})
    for eid in absent_nodes:
        ops.append({"op": "delete", "entity_kind": "node", "entity_id": eid, "payload": None})
    return ops, len(absent_edges) + len(absent_nodes)


def _first_layer_id(layers: List[dict]) -> str:
    """The view's first layer (order 0). Stable sort keeps list order on ties / missing order."""
    return sorted(
        layers, key=lambda l: l.get("order") if isinstance(l.get("order"), (int, float)) else 0
    )[0]["id"]


def _match_layer_signal(signal, layers: List[dict], fallback_id: str) -> str:
    """Resolve a row's ``layerAssignment`` signal to a layer id: an exact layer-id match wins, then
    a case-insensitive layer-NAME match; otherwise the ``fallback_id`` (the view's first layer)."""
    if signal:
        s = str(signal).strip()
        for layer in layers:
            if layer.get("id") == s:
                return layer["id"]
        sl = s.lower()
        for layer in layers:
            if str(layer.get("name") or "").strip().lower() == sl:
                return layer["id"]
    return fallback_id


def compute_import_root_assignments(
    created_nodes: List[Dict[str, Any]],
    batch_edges: List[tuple],
    containment_types,
    layers: List[dict],
    existing_assignments: Dict[str, Any],
    *,
    now: str = None,
) -> Dict[str, dict]:
    """The NEW canonical assignment entries (``key -> LayerAssignmentEntry``) to add for a view-scoped
    import's newly-created **top-level** entities — so a curated view renders them immediately.

    ``created_nodes`` are ``{eid, urn, layer_signal}`` for the batch's create-node ops; ``batch_edges``
    are ``(src_eid, tgt_eid, edge_type)`` for its create-edge ops. TOP-LEVEL = a created node that is
    NOT the child (containment-edge target) of any edge in the batch. A created node's containment
    parent edge is ALWAYS itself new (the edge references the new node's fresh eid), so the batch's own
    edges fully determine parentage — this subsumes the "descendant of an already-in-scope root" case
    (any such descendant has a batch parent edge). Descendants therefore get NO entry: containment
    inheritance places them under their root at read time.

    Never overwrites an ``existing_assignments`` key. The key is the node's projection key — its
    ``urn``, or ``gv:<eid>`` when it has none (mirrors the projector's node key). Target layer is the
    row's ``layerAssignment`` signal when it names a layer id / name in ``layers``, else the first
    layer. ``assignedBy`` is ``'import'``, ``inheritsChildren`` true. Returns ``{}`` when there are no
    layers to place into or no new roots.
    """
    valid_layers = [l for l in (layers or []) if isinstance(l, dict) and l.get("id")]
    if not valid_layers:
        return {}
    cont = {str(t).strip().upper() for t in (containment_types or [])}
    child_eids = {tgt for (_src, tgt, etype) in batch_edges
                  if tgt is not None and str(etype).strip().upper() in cont}
    fallback_id = _first_layer_id(valid_layers)
    stamp = now or _now()
    new_entries: Dict[str, dict] = {}
    for node in created_nodes:
        eid = node.get("eid")
        if eid in child_eids:                        # has a containment parent in the batch → inherits
            continue
        key = node.get("urn") or f"gv:{eid}"
        if key in existing_assignments or key in new_entries:
            continue                                 # never overwrite an existing / already-added entry
        new_entries[key] = {
            "layerId": _match_layer_signal(node.get("layer_signal"), valid_layers, fallback_id),
            "inheritsChildren": True,
            "assignedBy": "import",
            "assignedAt": stamp,
        }
    return new_entries


class ImportWorker:
    def __init__(self, versioning, store, scope=None, ontology=None) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope          # view scope for scoped replace ({assigned_urns, ...}) | None
        self._ontology = ontology    # {node_types, edge_types} for the per-row gate | None
        # Raw batch facts for the post-commit layout write-back (view-scoped imports): the created
        # NODE entities ({eid, urn, layer_signal}) and the batch's create-edge triples. Collected in
        # _resolve_and_build; the ImportExportService hands them to the injected layout writer.
        self.created_node_facts: List[Dict[str, Any]] = []
        self.batch_edge_facts: List[tuple] = []

    async def run(self, job_id: str) -> Dict[str, int]:
        job = await self._load_running(job_id)
        graph_id, branch_id = job["graph_id"], job["branch_id"]
        actor = await self._branch_owner(graph_id, branch_id)

        await self._parse(job_id, job["source_uri"], job["import_format"])
        summary = await self._resolve_and_build(
            job_id, graph_id, branch_id, actor, job.get("reconcile_mode") or "upsert")

        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            row.status = "completed"
            row.completed_at = _now()
            row.updated_at = _now()
            row.summary = summary
            row.processed = sum(summary.values())
        return summary

    # ------------------------------------------------------------------ #
    async def _load_running(self, job_id: str) -> Dict[str, Any]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                raise ValueError(f"unknown import job {job_id}")
            row.status = "running"
            row.started_at = _now()
            row.updated_at = _now()
            return {"graph_id": row.graph_id, "branch_id": row.branch_id,
                    "source_uri": row.source_uri, "import_format": row.import_format,
                    "reconcile_mode": row.reconcile_mode}

    async def _branch_owner(self, graph_id: str, branch_id: str) -> str:
        async with db.graphver_session() as s:
            branch = await s.get(BranchORM, branch_id)
            return (branch.owner if branch else None) or "system"

    async def _reject_binary(self, source_uri: str) -> None:
        """Fail fast with a clear message on a binary (non-text) file — uploading an Excel
        workbook (.xlsx/.xls) instead of CSV is a common mistake that would otherwise parse into
        meaningless rows. Raised in the normal flow (not inside a generator) so the message
        surfaces on the job."""
        async for chunk in self._store.open_stream(source_uri):
            if chunk[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
                raise ValueError(
                    "This looks like an Excel workbook (.xlsx). Please open it and 'Save As' "
                    "CSV (UTF-8), then import that file — spreadsheet workbooks aren't supported yet.")
            if chunk[:4] == b"\xd0\xcf\x11\xe0":
                raise ValueError(
                    "This looks like a legacy Excel file (.xls). Please save it as CSV and import that.")
            return  # only the first chunk is needed to sniff the file type

    async def _parse(self, job_id: str, source_uri: str, fmt: str) -> int:
        if (fmt or "").lower() != "xlsx":
            await self._reject_binary(source_uri)   # xlsx IS a zip (PK); its adapter reads it natively
        adapter = get_adapter(fmt)
        batch: List[ImportRowORM] = []
        idx = 0
        async for raw in adapter.parse(self._store.open_stream(source_uri)):
            kind = raw.get("kind")
            if kind not in ("node", "edge"):
                continue  # tallied as skipped; a malformed record never aborts the parse
            batch.append(ImportRowORM(job_id=job_id, row_index=idx, kind=kind,
                                      raw=normalize(raw, kind)))
            idx += 1
            if len(batch) >= _PARSE_BATCH:
                await self._flush(batch)
                batch = []
        if batch:
            await self._flush(batch)
        return idx

    async def _flush(self, batch: List[ImportRowORM]) -> None:
        async with db.graphver_session() as s:
            s.add_all(batch)

    async def _resolve_and_build(self, job_id, graph_id, branch_id, actor,
                                 reconcile_mode: str = "upsert") -> Dict[str, int]:
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM).where(ImportRowORM.job_id == job_id)
                .order_by(ImportRowORM.row_index))).scalars().all()
            norm_rows = [{**r.raw, "_row_index": r.row_index} for r in rows]

        indexes = await self._svc.entity_indexes(graph_id=graph_id, branch_id=branch_id)
        ops, resolutions = resolve_rows(norm_rows, indexes,
                                        mint_id=lambda: prefixed_id("ent"), ontology=self._ontology)

        deleted_extra = 0
        if reconcile_mode == "replace":
            scope_nodes, scope_edges = (None, None)
            if self._scope:                        # view-scoped replace: only the view's own entities
                scope_nodes, scope_edges = _view_scope_eids(indexes, self._scope)
            ops, deleted_extra = _append_replace_deletes(
                ops, resolutions, indexes, scope_nodes, scope_edges)

        # Raw facts for the post-commit view layout write-back (created top-level entities). The eids
        # are the stable minted ids resolve_rows assigned; the layout writer maps each to its
        # projection key (urn or gv:<eid>) and reasons about parentage from the batch's own edges.
        self.created_node_facts = [
            {"eid": op["entity_id"], "urn": (op.get("payload") or {}).get("urn"),
             "layer_signal": (op.get("payload") or {}).get("layerAssignment")}
            for op in ops if op.get("op") == "create" and op.get("entity_kind") == "node"
        ]
        self.batch_edge_facts = [
            ((op.get("payload") or {}).get("sourceEntityId"),
             (op.get("payload") or {}).get("targetEntityId"),
             (op.get("payload") or {}).get("edgeType"))
            for op in ops if op.get("op") == "create" and op.get("entity_kind") == "edge"
        ]

        await self._persist_resolutions(job_id, resolutions)

        # Apply accepted ops in windows onto the draft (never main).
        for window in _chunks(ops, config.IMPORT_COMMIT_WINDOW):
            await self._svc.apply_ops(graph_id=graph_id, ops=window, actor=actor,
                                      branch_id=branch_id, message="import")

        summary: Dict[str, int] = {"new": 0, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}
        for res in resolutions:
            summary[res["status"]] = summary.get(res["status"], 0) + 1
        summary["deleted"] += deleted_extra    # replace-mode delete-on-absence (not file rows)
        return summary

    async def _persist_resolutions(self, job_id: str, resolutions) -> None:
        async with db.graphver_session() as s:
            for res in resolutions:
                await s.execute(
                    update(ImportRowORM)
                    .where(ImportRowORM.job_id == job_id,
                           ImportRowORM.row_index == res["_row_index"])
                    .values(matched_entity_id=res["matched_entity_id"],
                            resolved_op=res["resolved_op"], status=res["status"],
                            reasons=res["reasons"] or None))
