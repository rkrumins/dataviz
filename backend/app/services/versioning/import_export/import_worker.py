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

The job runs on its lease (:mod:`..job_lease`) and RESUMES: every unit of work commits together with
the job's cursor (``last_cursor``) as one fenced transaction, so a worker that dies or is stopped
loses at most the unit it was in, and the next one carries on from the cursor —

  ``parse:<n>``   n rows staged; a resumed parse streams the file again and stages from row n;
  ``node:<row>``  the node windows applied up to staged row ``row`` (``node:-1``: parsed, none yet);
  ``edge:<row>``  every node window, and the edge windows up to ``row``;
  ``replace``     every window; a replace's deletes under way (run again whole: a deleted entity is
                  no longer there to delete).

A superseded worker (its job taken over, or no longer running) finds out at its next checkpoint,
whose transaction — the window's work with it — then rolls back.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from sqlalchemy import BigInteger, Text, bindparam, delete, exists, insert, select, text
from sqlalchemy.dialects.postgresql import ARRAY

from .. import config, db
from ..ids import prefixed_id
from ..job_lease import QUEUED, Lease, Superseded
from ..models import BranchORM, EdgeVersionORM, ImportRowORM, JobORM
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
# What an import's summary tallies, per row by its resolution (``deleted`` also counts what a
# replace deleted because no row named it).
_TALLIES = ("new", "updated", "unchanged", "deleted", "invalid")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def lease_job(job_id: str) -> Lease:
    """Take ``job_id`` for a caller that runs it itself rather than on the transfer lane (a tool, a
    test): as a claim does — the next epoch, running — so it runs fenced like any other. Raises
    ``ValueError`` for an unknown job."""
    async with db.graphver_session() as s:
        row = await s.get(JobORM, job_id, with_for_update=True)
        if row is None:
            raise ValueError(f"unknown job {job_id}")
        now = _now()
        row.retry_count = (row.retry_count or 0) + 1
        row.status, row.updated_at, row.error_message = "running", now, None
        row.started_at = row.started_at or now
        if row.current_phase == QUEUED:
            row.current_phase = None
        return Lease(job_id=row.id, job_type=row.job_type, epoch=row.retry_count,
                     workspace_id=row.workspace_id, graph_id=row.graph_id)


class _Position(NamedTuple):
    """Where an import job has got, as its row says."""
    cursor: Optional[str]
    summary: Dict[str, Any]
    processed: int
    total: int


def _window_after(cursor: Optional[str]) -> Tuple[Optional[str], int]:
    """The kind and row a cursor's next window starts after: ``node:<row>``/``edge:<row>`` →
    ``(kind, row)``; ``replace`` (or anything else) → ``(None, -1)``, no window left."""
    kind, _, row = (cursor or "").partition(":")
    return (kind, int(row)) if kind in ("node", "edge") else (None, -1)


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
        # Raw facts for the post-commit layout write-back (view-scoped imports): the created NODE
        # entities ({eid, urn, layer_signal}) and the create-edge triples. Derived once the import
        # is built (_derive_facts); the ImportExportService hands them to the injected layout
        # writer. ``facts=False`` (no view to write them to) derives none.
        self._facts = facts
        self.created_node_facts: List[Dict[str, Any]] = []
        self.batch_edge_facts: List[tuple] = []
        # The job's lease (``run`` takes it), and its cursor as this worker last read it or staged
        # rows past it (what a parse batch's checkpoint expects to find).
        self._lease: Optional[Lease] = None
        self._cursor: Optional[str] = None
        # Rows of the file a previous run of the job already staged: a resumed parse skips them.
        self._skip = 0

    async def run(self, job_id: str, *, lease: Optional[Lease] = None) -> Dict[str, int]:
        """Run the import job to the end on ``lease`` — the transfer lane's; called without one,
        the job is taken here (:func:`lease_job`) — resuming from its cursor. Returns its tallies.
        Raises :class:`Superseded` once the job is no longer this worker's."""
        self._lease = lease or await lease_job(job_id)
        job = await self._job(job_id)
        graph_id, branch_id = job["graph_id"], job["branch_id"]
        actor = await self._branch_owner(graph_id, branch_id)

        await self._lease.retry_transient(
            lambda: self._stage(job_id, job["source_uri"], job["import_format"]))
        summary = await self._resolve_and_build(
            job_id, graph_id, branch_id, actor, job.get("reconcile_mode") or "upsert")
        if self._facts:
            await self._derive_facts(job_id, graph_id, branch_id)
        if not await self._lease.finish("completed", summary=summary, progress=100):
            raise Superseded(f"import job {job_id} (epoch {self._lease.epoch}) was taken over "
                             "before it could finish")
        return summary

    # ------------------------------------------------------------------ #
    async def _job(self, job_id: str) -> Dict[str, Any]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                raise ValueError(f"unknown import job {job_id}")
            return {"graph_id": row.graph_id, "branch_id": row.branch_id,
                    "source_uri": row.source_uri, "import_format": row.import_format,
                    "reconcile_mode": row.reconcile_mode}

    async def _position(self, job_id: str) -> _Position:
        """Where the job has got, read afresh by every unit of work: a unit retried after a fault
        whose commit landed after all then carries on past it instead of doing it again. Raises
        :class:`Superseded` when the row is no longer this worker's."""
        async with db.graphver_session() as s:
            row = (await s.execute(select(
                JobORM.last_cursor, JobORM.summary, JobORM.processed, JobORM.total,
                JobORM.retry_count, JobORM.status).where(JobORM.id == job_id))).one()
        if (row.retry_count, row.status) != (self._lease.epoch, "running"):
            raise Superseded(f"import job {job_id} (epoch {self._lease.epoch}) is no longer this "
                             "worker's")
        self._cursor = row.last_cursor
        return _Position(row.last_cursor, dict(row.summary) if isinstance(row.summary, dict) else {},
                         row.processed or 0, row.total or 0)

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

    async def _stage(self, job_id: str, source_uri: str, fmt: str) -> None:
        """Parse the file into ``import_rows`` from where an earlier run of the job got to, then
        point the job at its first window (``node:-1``), with how many rows it has (``total``).
        Nothing to do once the job is past parsing."""
        cursor = (await self._position(job_id)).cursor
        if cursor is not None and not cursor.startswith("parse:"):
            return
        self._skip = int(cursor.partition(":")[2]) if cursor else 0
        staged = await self._parse(job_id, source_uri, fmt)
        async with db.graphver_session() as s:
            await self._lease.checkpoint(s, expect_cursor=self._cursor, last_cursor="node:-1",
                                         total=staged, current_phase="nodes")
        self._cursor = "node:-1"

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
        async for page in _record_pages(adapter, open_source(self._store, source_uri)):
            # Normalizing is per-row Python work: a page at a time, off the event loop.
            for kind, row in await asyncio.to_thread(_normalize_page, page):
                if idx >= self._skip:              # below it: staged by an earlier run of the job
                    batch.append({"job_id": job_id, "row_index": idx, "kind": kind, "raw": row})
                idx += 1
            if len(batch) >= _PARSE_BATCH:
                await self._flush(batch)
                batch = []
        if batch:
            await self._flush(batch)
        return idx

    async def _flush(self, batch: List[Dict[str, Any]]) -> None:
        """Stage a batch of parsed rows — batched multi-row INSERTs, no ORM object per row — and
        move the job's cursor past them in the SAME transaction, fenced: each row is staged once,
        by whichever run of the job got to it, and a superseded worker's batch rolls back."""
        self._lease.check()
        cursor = f"parse:{batch[-1]['row_index'] + 1}"
        async with db.graphver_session() as s:
            await s.execute(insert(ImportRowORM.__table__), batch)
            await self._lease.checkpoint(s, expect_cursor=self._cursor, last_cursor=cursor,
                                         total=batch[-1]["row_index"] + 1, current_phase="parse")
        self._cursor = cursor

    async def _resolve_and_build(self, job_id, graph_id, branch_id, actor,
                                 reconcile_mode: str = "upsert") -> Dict[str, int]:
        """Resolve the staged rows against the draft and build them onto it, a window at a time:
        every node window first, then every edge window, so an edge finds a node any row of the file
        creates. A window looks up only the entities its own rows name (by id, urn, qualifiedName,
        endpoints) in the draft's composed state, where the windows before it are already applied,
        so memory stays flat whatever the size of the file or of the graph. Each window is retried
        through a transient fault (``retry_transient``) from the cursor; returns the tallies."""
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        more = True
        while more:
            more = await self._lease.retry_transient(
                lambda: self._next_window(job_id, snap, graph_id, branch_id, actor))
        if reconcile_mode == "replace":        # delete-on-absence (not file rows; counted as it goes)
            await self._lease.retry_transient(
                lambda: self._delete_absent(job_id, snap, graph_id, branch_id, actor))
        summary = (await self._position(job_id)).summary
        return {k: int(summary.get(k) or 0) for k in _TALLIES}

    async def _next_window(self, job_id, snap, graph_id, branch_id, actor) -> bool:
        """Resolve and build the window after the job's cursor; False once none is left.

        The window's ops, its rows' resolutions and the job's checkpoint (cursor, progress, running
        tallies) commit as ONE transaction (``apply_ops(on_commit=...)``): a window lands whole or
        not at all, so a resumed import neither repeats nor skips one, and a superseded worker's
        window rolls back at its checkpoint. A window with no ops commits the rest on its own."""
        pos = await self._position(job_id)
        kind, after = _window_after(pos.cursor)
        rows = await self._window(job_id, kind, after) if kind else []
        if not rows and kind == "node":             # the node windows are done: on to the edges
            kind, rows = "edge", await self._window(job_id, "edge", -1)
        if not rows:
            return False
        lookups = await (self._node_lookups if kind == "node" else self._edge_lookups)(snap, rows)
        ops, resolutions = await asyncio.to_thread(       # a window of pure-Python matching
            resolve_rows, rows, lookups, mint_id=lambda: prefixed_id("ent"),
            ontology=self._ontology)
        summary = {**dict.fromkeys(_TALLIES, 0), **pos.summary}
        for res in resolutions:
            summary[res["status"]] = int(summary.get(res["status"]) or 0) + 1
        processed = pos.processed + len(rows)

        async def on_commit(s) -> None:
            await self._persist_resolutions(s, job_id, resolutions)
            await self._lease.checkpoint(
                s, expect_cursor=pos.cursor, last_cursor=f"{kind}:{rows[-1]['_row_index']}",
                processed=processed, summary=summary, current_phase=f"{kind}s",
                progress=min(99, processed * 100 // pos.total) if pos.total else 0)

        if ops:
            await self._svc.apply_ops(graph_id=graph_id, ops=ops, actor=actor,
                                      branch_id=branch_id, message="import", on_commit=on_commit)
        else:
            async with db.graphver_session() as s:
                await on_commit(s)
        return True

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

    async def _derive_facts(self, job_id: str, graph_id: str, branch_id: str) -> None:
        """The raw facts for the post-commit view layout write-back (created top-level entities),
        from what the whole import did rather than from this run's memory, which lacks the windows
        an earlier run of a resumed job applied: the node rows it created (their minted eids, urns
        and layer signals, in file order), and the endpoints of the edges it created as the draft
        holds them. The layout writer maps each eid to its projection key (urn or gv:<eid>) and
        reasons about parentage from the created edges."""
        created = (ImportRowORM.job_id == job_id, ImportRowORM.resolved_op == "create")
        async with db.graphver_session() as s:
            nodes = (await s.execute(
                select(ImportRowORM.matched_entity_id, ImportRowORM.raw["urn"].astext,
                       ImportRowORM.raw["layerAssignment"])
                .where(*created, ImportRowORM.kind == "node").order_by(ImportRowORM.row_index))).all()
            edge_ids = (await s.execute(select(ImportRowORM.matched_entity_id)
                                        .where(*created, ImportRowORM.kind == "edge"))).scalars().all()
            edges = []
            for chunk in _chunks(edge_ids, _PERSIST_BATCH):
                edges += (await s.execute(
                    select(EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id,
                           EdgeVersionORM.edge_type)
                    .where(EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.branch_id == branch_id,
                           EdgeVersionORM.entity_id.in_(chunk), EdgeVersionORM.op == "create"))).all()
        self.created_node_facts = [{"eid": eid, "urn": urn, "layer_signal": signal}
                                   for eid, urn, signal in nodes]
        self.batch_edge_facts = [tuple(edge) for edge in edges]

    async def _delete_absent(self, job_id, snap, graph_id, branch_id, actor) -> int:
        """Replace mode: the file is the authoritative snapshot for its scope, so every entity in
        scope that no row matched is deleted (reviewed on the draft before publish; ``apply_ops``
        cascades containment and incident edges). Edges first, then nodes, a page at a time, each
        page's deletes committed with the job's checkpoint (cursor ``replace``) and their count. A
        view-scoped replace can delete only the view's own entities (its placements and their
        containment descendants, and the edges between them), never the rest of the data source.
        Run again after an interruption, it finds only what is left to delete. Returns how many
        this run deleted."""
        deleted = 0
        keep = (await view_entities(snap, self._scope))["keep"] if self._scope else None
        for kind in ("edge", "node"):
            async for page in _in_scope(snap, kind, keep):
                absent = await self._unmatched(job_id, page)
                if absent:
                    await self._svc.apply_ops(
                        graph_id=graph_id, actor=actor, branch_id=branch_id, message="import",
                        ops=[{"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}
                             for eid in absent],
                        on_commit=self._count_deleted(job_id, len(absent)))
                    deleted += len(absent)
        return deleted

    def _count_deleted(self, job_id: str, n: int):
        """The end of a replace page's transaction: the job's checkpoint, adding the page's ``n``
        deletes to the tally the row holds."""
        async def on_commit(s) -> None:
            summary = await s.scalar(select(JobORM.summary).where(JobORM.id == job_id))
            summary = dict(summary) if isinstance(summary, dict) else {}
            summary["deleted"] = int(summary.get("deleted") or 0) + n
            await self._lease.checkpoint(s, last_cursor="replace", current_phase="replace",
                                         summary=summary)
        return on_commit

    async def _unmatched(self, job_id: str, eids: List[str]) -> List[str]:
        """Those of ``eids`` no row of this import matched."""
        async with db.graphver_session() as s:
            matched = set((await s.execute(
                select(ImportRowORM.matched_entity_id).where(
                    ImportRowORM.job_id == job_id, ImportRowORM.matched_entity_id.in_(eids))
            )).scalars())
        return [eid for eid in eids if eid not in matched]

    @staticmethod
    async def _persist_resolutions(s, job_id: str, resolutions) -> None:
        """Record each row's resolution, in the window's transaction: one UPDATE per few thousand
        rows, each column as one array (unnest), rather than a round trip per row (which took over
        a third of an import)."""
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


async def _record_pages(adapter, chunks):
    """The adapter's records a page at a time — decoded off the event loop where the adapter can
    (``parse_pages``), else gathered from its record stream."""
    if hasattr(adapter, "parse_pages"):
        async for page in adapter.parse_pages(chunks, _PARSE_BATCH):
            yield page
        return
    page: List[Dict[str, Any]] = []
    async for raw in adapter.parse(chunks):
        page.append(raw)
        if len(page) >= _PARSE_BATCH:
            yield page
            page = []
    if page:
        yield page


def _normalize_page(page: List[Dict[str, Any]]) -> List[tuple]:
    """``(kind, normalized row)`` for each node or edge record; anything else is skipped (tallied
    as skipped — a malformed record never aborts the parse)."""
    out = []
    for raw in page:
        kind = raw.get("kind") if isinstance(raw, dict) else None
        if kind in ("node", "edge"):
            out.append((kind, normalize(raw, kind)))
    return out


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
