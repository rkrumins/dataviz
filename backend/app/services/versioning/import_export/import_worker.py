"""ImportWorker — parse an uploaded file, resolve it, and build it onto a draft branch.

Independent of the aggregation/ingestion worker: it copies that stateless-worker *pattern* but
imports none of it, and drives the **versioning service** (drafts), so an import is exactly the
manual create/edit flow at scale — repeated imports stack on one draft like successive manual edits.

Phases (all params on the ``JobORM`` row):
  parse    stream ``source_uri`` from the object store -> the format adapter -> :func:`normalize`
           -> ``import_rows`` (cursor-ordered, never buffering the whole file);
  resolve  a window of ``IMPORT_COMMIT_WINDOW`` rows at a time (nodes, then edges): look up just the
           entities the window names in the draft's composed state and build versioned ops
           (:func:`resolve_rows`);
  build    apply each window's ops via ``apply_ops(branch_id=draft)`` before the next is resolved.

Invalid rows are quarantined (partial acceptance), not fatal; the tally lands on ``job.summary``.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from sqlalchemy import BigInteger, Text, bindparam, delete, exists, insert, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY

from .. import config, db
from ..ids import prefixed_id
from ..models import BranchORM, ImportRowORM, JobORM
from .formats import get_adapter
from .resolve import resolve_rows
from .rowmodel import normalize
from .snapshot import open_snapshot
from .stream import view_entities
from .uploads import WHOLE_FILE_FORMATS, open_source, source_size, too_large

logger = logging.getLogger(__name__)

_PARSE_BATCH = 2000
_PERSIST_BATCH = 5000
# Record a batch of resolutions: each column one array parameter, so the statement never changes.
_RESOLVE_ROWS = text(
    f"UPDATE {ImportRowORM.__table__.fullname} AS r SET matched_entity_id = v.eid, resolved_op = v.op, "
    "status = v.status, reasons = v.reasons::jsonb "
    "FROM unnest(:idx, :eids, :ops, :statuses, :reasons) AS v(row_index, eid, op, status, reasons) "
    "WHERE r.job_id = :job_id AND r.row_index = v.row_index",
).bindparams(bindparam("idx", type_=ARRAY(BigInteger)),
             *(bindparam(name, type_=ARRAY(Text)) for name in ("eids", "ops", "statuses", "reasons")))
# How often a running import or export touches its job's ``updated_at``. ``get_job`` reports a job
# silent for JOB_STALE_AFTER_SECS as failed, and a long parse or apply window says nothing on its own.
_HEARTBEAT_SECS = 15


async def heartbeat(job_id: str) -> None:
    """Say "still running" on a timer rather than per batch, until cancelled: resolving or applying
    one window, or writing a long export, can take minutes without a batch boundary."""
    while True:
        await asyncio.sleep(_HEARTBEAT_SECS)
        try:
            async with db.graphver_session() as s:
                await s.execute(update(JobORM).where(JobORM.id == job_id).values(updated_at=_now()))
        except Exception:  # noqa: BLE001 — the next beat tries again
            logger.debug("job %s: heartbeat skipped", job_id, exc_info=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sniff_format(declared: str, head: bytes) -> str | None:
    """The format an upload's first bytes say it is, when that overrides the declared one. Only a
    declared ``ndjson``/``json`` is checked — clients (the UI's own detection included) mix the two
    up: the first non-whitespace byte after an optional UTF-8 BOM decides, ``[`` for a JSON array,
    ``{`` for json-lines. ``None`` keeps the declared format; csv/tsv/xlsx are never overridden."""
    declared = (declared or "").lower()
    if declared not in ("ndjson", "json"):
        return None
    first = head.removeprefix(b"\xef\xbb\xbf").lstrip()[:1]
    sniffed = {b"[": "json", b"{": "ndjson"}.get(first, declared)
    return sniffed if sniffed != declared else None


def _chunks(seq: List[Any], size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


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
    def __init__(self, versioning, store, scope=None, ontology=None, facts: bool = True) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope          # view scope for scoped replace ({assigned_urns, ...}) | None
        self._ontology = ontology    # {node_types, edge_types} for the per-row gate | None
        # Raw batch facts for the post-commit layout write-back (view-scoped imports): the created
        # NODE entities ({eid, urn, layer_signal}) and the batch's create-edge triples. Collected in
        # _resolve_and_build; the ImportExportService hands them to the injected layout writer.
        # ``facts=False`` (no view to write them to) collects none: one per created entity.
        self._facts = facts
        self.created_node_facts: List[Dict[str, Any]] = []
        self.batch_edge_facts: List[tuple] = []

    async def run(self, job_id: str) -> Dict[str, int]:
        job = await self._load_running(job_id)
        beat = asyncio.create_task(heartbeat(job_id))
        try:
            graph_id, branch_id = job["graph_id"], job["branch_id"]
            actor = await self._branch_owner(graph_id, branch_id)

            await self._parse(job_id, job["source_uri"], job["import_format"])
            summary = await self._resolve_and_build(
                job_id, graph_id, branch_id, actor, job.get("reconcile_mode") or "upsert")
        finally:
            beat.cancel()

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

    async def _reject_binary(self, source_uri: str) -> bytes:
        """Fail fast with a clear message on a binary (non-text) file — uploading an Excel
        workbook (.xlsx/.xls) instead of CSV is a common mistake that would otherwise parse into
        meaningless rows. Raised in the normal flow (not inside a generator) so the message
        surfaces on the job. Returns the first chunk for the format sniff."""
        async for chunk in open_source(self._store, source_uri):
            if chunk[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
                raise ValueError(
                    "This looks like an Excel workbook (.xlsx). Please open it and 'Save As' "
                    "CSV (UTF-8), then import that file — spreadsheet workbooks aren't supported yet.")
            if chunk[:4] == b"\xd0\xcf\x11\xe0":
                raise ValueError(
                    "This looks like a legacy Excel file (.xls). Please save it as CSV and import that.")
            return chunk  # only the first chunk is needed to sniff the file type
        return b""

    async def _parse(self, job_id: str, source_uri: str, fmt: str) -> int:
        if (fmt or "").lower() != "xlsx":
            head = await self._reject_binary(source_uri)   # xlsx IS a zip (PK); its adapter reads it natively
            sniffed = _sniff_format(fmt, head)
            if sniffed:
                logger.info("import job %s: declared format %r overridden to %r by the content sniff",
                            job_id, fmt, sniffed)
                fmt = sniffed
        if (fmt or "").lower() in WHOLE_FILE_FORMATS:     # read whole: refuse one too large to hold
            reason = too_large(await source_size(self._store, source_uri), fmt)
            if reason:
                raise ValueError(reason)
        adapter = get_adapter(fmt)
        batch: List[Dict[str, Any]] = []
        idx = 0
        async for raw in adapter.parse(open_source(self._store, source_uri)):
            kind = raw.get("kind")
            if kind not in ("node", "edge"):
                continue  # tallied as skipped; a malformed record never aborts the parse
            batch.append({"job_id": job_id, "row_index": idx, "kind": kind, "raw": normalize(raw, kind)})
            idx += 1
            if len(batch) >= _PARSE_BATCH:
                await self._flush(batch)
                batch = []
        if batch:
            await self._flush(batch)
        return idx

    async def _flush(self, batch: List[Dict[str, Any]]) -> None:
        """Stage a batch of parsed rows: batched multi-row INSERTs, no ORM object per row."""
        async with db.graphver_session() as s:
            await s.execute(insert(ImportRowORM.__table__), batch)

    async def _resolve_and_build(self, job_id, graph_id, branch_id, actor,
                                 reconcile_mode: str = "upsert") -> Dict[str, int]:
        """Resolve the staged rows against the draft and build them onto it, a window at a time:
        every node window first, then every edge window, so an edge finds a node any row of the file
        creates. A window looks up only the entities its own rows name (by id, urn, qualifiedName,
        endpoints) in the draft's composed state, where the windows before it are already applied,
        so memory stays flat whatever the size of the file or of the graph."""
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        summary: Dict[str, int] = {"new": 0, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}
        for kind in ("node", "edge"):
            after = -1
            while True:
                rows = await self._window(job_id, kind, after)
                if not rows:
                    break
                after = rows[-1]["_row_index"]
                lookups = await (self._node_lookups if kind == "node" else self._edge_lookups)(snap, rows)
                ops, resolutions = resolve_rows(rows, lookups, mint_id=lambda: prefixed_id("ent"),
                                                ontology=self._ontology)
                self._collect_facts(ops)
                await self._persist_resolutions(job_id, resolutions)
                if ops:
                    await self._svc.apply_ops(graph_id=graph_id, ops=ops, actor=actor,
                                              branch_id=branch_id, message="import")
                for res in resolutions:
                    summary[res["status"]] = summary.get(res["status"], 0) + 1
        if reconcile_mode == "replace":        # delete-on-absence (not file rows, so counted here)
            summary["deleted"] += await self._delete_absent(job_id, snap, graph_id, branch_id, actor)
        return summary

    async def _window(self, job_id: str, kind: str, after: int) -> List[Dict[str, Any]]:
        """The next ``IMPORT_COMMIT_WINDOW`` staged rows of ``kind`` after ``after``, in file order."""
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM.row_index, ImportRowORM.raw)
                .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == kind,
                       ImportRowORM.row_index > after)
                .order_by(ImportRowORM.row_index).limit(config.IMPORT_COMMIT_WINDOW))).all()
        return [{**raw, "_row_index": idx} for idx, raw in rows]

    async def _node_lookups(self, snap, rows) -> Dict[str, Any]:
        """What ``resolve_rows`` needs to match these node rows: the live nodes they name by
        entity_id, urn or qualifiedName, and each one's current payload."""
        by_id = await snap.lookup_live("node", {r["entity_id"] for r in rows if r.get("entity_id")})
        urn_to_eid = await snap.nodes_by_urn(r.get("urn") for r in rows)
        qname_to_eid = await snap.nodes_by_qname(r.get("qualifiedName") for r in rows)
        named = set(by_id) | set(urn_to_eid.values()) | set(qname_to_eid.values())
        return {"urn_to_eid": urn_to_eid, "qname_to_eid": qname_to_eid, "node_eids": named,
                "current": await _payloads(snap, "node", named)}

    async def _edge_lookups(self, snap, rows) -> Dict[str, Any]:
        """What ``resolve_rows`` needs for these edge rows: the live nodes their endpoints name,
        the live edges between those nodes, and each such edge's current payload."""
        ends = {}
        for end in ("source", "target"):
            by_id = await snap.lookup_live("node", {r[f"{end}_entity_id"] for r in rows
                                                    if r.get(f"{end}_entity_id")})
            by_qname = await snap.nodes_by_qname(r.get(f"{end}QualifiedName") for r in rows)
            by_urn = await snap.nodes_by_urn(r.get(f"{end}Urn") for r in rows)
            ends[end] = (by_id, by_qname, by_urn)
        (src_ids, src_qnames, src_urns), (tgt_ids, tgt_qnames, tgt_urns) = ends["source"], ends["target"]
        edge_to_eid = await snap.edges_between(
            set(src_ids) | set(src_qnames.values()) | set(src_urns.values()),
            set(tgt_ids) | set(tgt_qnames.values()) | set(tgt_urns.values()))
        return {"urn_to_eid": {**src_urns, **tgt_urns}, "qname_to_eid": {**src_qnames, **tgt_qnames},
                "node_eids": set(src_ids) | set(tgt_ids), "edge_to_eid": edge_to_eid,
                "current": await _payloads(snap, "edge", edge_to_eid.values())}

    def _collect_facts(self, ops) -> None:
        """Raw facts for the post-commit view layout write-back (created top-level entities). The
        eids are the stable minted ids resolve_rows assigned; the layout writer maps each to its
        projection key (urn or gv:<eid>) and reasons about parentage from the created edges."""
        if not self._facts:
            return
        for op in ops:
            if op.get("op") != "create":
                continue
            payload = op.get("payload") or {}
            if op.get("entity_kind") == "node":
                self.created_node_facts.append({"eid": op["entity_id"], "urn": payload.get("urn"),
                                                "layer_signal": payload.get("layerAssignment")})
            elif op.get("entity_kind") == "edge":
                self.batch_edge_facts.append((payload.get("sourceEntityId"),
                                              payload.get("targetEntityId"), payload.get("edgeType")))

    async def _delete_absent(self, job_id, snap, graph_id, branch_id, actor) -> int:
        """Replace mode: the file is the authoritative snapshot for its scope, so every entity in
        scope that no row matched is deleted (reviewed on the draft before publish; ``apply_ops``
        cascades containment and incident edges). Edges first, then nodes, a page at a time. A
        view-scoped replace can delete only the view's own entities (its placements and their
        containment descendants, and the edges between them), never the rest of the data source.
        Returns how many were deleted."""
        deleted = 0
        keep = (await view_entities(snap, self._scope))["keep"] if self._scope else None
        for kind in ("edge", "node"):
            async for page in _in_scope(snap, kind, keep):
                absent = await self._unmatched(job_id, page)
                if absent:
                    await self._svc.apply_ops(
                        graph_id=graph_id, actor=actor, branch_id=branch_id, message="import",
                        ops=[{"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}
                             for eid in absent])
                    deleted += len(absent)
        return deleted

    async def _unmatched(self, job_id: str, eids: List[str]) -> List[str]:
        """Those of ``eids`` no row of this import matched."""
        async with db.graphver_session() as s:
            matched = set((await s.execute(
                select(ImportRowORM.matched_entity_id).where(
                    ImportRowORM.job_id == job_id, ImportRowORM.matched_entity_id.in_(eids))
            )).scalars())
        return [eid for eid in eids if eid not in matched]

    async def _persist_resolutions(self, job_id: str, resolutions) -> None:
        """Record each row's resolution: one UPDATE per few thousand rows, each column as one array
        (unnest), rather than a round trip per row (which took over a third of an import)."""
        async with db.graphver_session() as s:
            for chunk in _chunks(resolutions, _PERSIST_BATCH):
                await s.execute(_RESOLVE_ROWS, {
                    "job_id": job_id, "idx": [r["_row_index"] for r in chunk],
                    "eids": [r["matched_entity_id"] for r in chunk],
                    "ops": [r["resolved_op"] for r in chunk], "statuses": [r["status"] for r in chunk],
                    "reasons": [json.dumps(r["reasons"]) if r["reasons"] else None for r in chunk]})


async def sweep_staged_rows(*, older_than_days: float, batch: int = 50_000) -> int:
    """Delete the staged rows of import jobs that finished more than ``older_than_days`` ago, a
    batch per transaction (a large import stages millions). Their preview sample goes with them;
    the draft's changes, the review surface, stay. Returns how many rows went."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    async with db.graphver_session() as s:
        jobs = (await s.execute(select(JobORM.id).where(
            JobORM.job_type == "ingest", JobORM.status.in_(("completed", "failed", "cancelled")),
            JobORM.completed_at < cutoff,
            exists().where(ImportRowORM.job_id == JobORM.id)))).scalars().all()
    removed = 0
    for job_id in jobs:
        while True:
            async with db.graphver_session() as s:
                first = select(ImportRowORM.row_index).where(ImportRowORM.job_id == job_id).limit(batch)
                gone = (await s.execute(delete(ImportRowORM).where(
                    ImportRowORM.job_id == job_id, ImportRowORM.row_index.in_(first)))).rowcount
            removed += gone
            if gone < batch:
                break
    return removed


async def _payloads(snap, kind: str, eids) -> Dict[str, dict]:
    """The current payload of each live entity among ``eids``."""
    live = await snap.lookup_live(kind, set(eids), payload=True)
    return {eid: json.loads(w.payload) for eid, w in live.items() if w.payload is not None}


async def _in_scope(snap, kind: str, keep):
    """The live entities of ``kind`` a replace may delete, a page of ids at a time: the whole graph,
    or with ``keep`` (a view's nodes) those nodes and the edges between them."""
    if keep is None:
        async for page in snap.iter_live(kind):
            yield [w.entity_id for w in page]
        return
    ids = (list((await snap.lookup_live("node", keep)).keys()) if kind == "node"
           else list((await snap.edges_between(keep, keep)).values()))
    for i in range(0, len(ids), snap.page_size):
        yield ids[i:i + snap.page_size]
