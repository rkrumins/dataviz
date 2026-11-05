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

Invalid rows are quarantined (partial acceptance), not fatal — but a replace then deletes nothing;
the tally lands on ``job.summary``.

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
import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from sqlalchemy import (BigInteger, Text, and_, any_, bindparam, delete, exists, false, func,
                        insert, null, or_, select, text, tuple_)
from sqlalchemy.dialects.postgresql import ARRAY

from backend.app.services.view_placement import NodeFacts, suggest_placement

from .. import config, db
from ..ids import new_entity_id
from ..job_lease import QUEUED, Lease, Superseded
from ..models import (BranchORM, EdgeVersionORM, ImportResultORM, ImportRowORM, JobORM,
                      NodeVersionORM)
from ..service import OntologyViolation
from .formats import get_adapter
from .resolve import (KeyIndex, _canonical_map, key_value, pointer_id, pointer_seed, pointers,
                      resolve_rows)
from .rowmodel import PROP_DELETE, normalize
from .snapshot import open_snapshot
from .stream import view_entities
from .uploads import WHOLE_FILE_FORMATS, is_archive_source, open_source, source_size, too_large

logger = logging.getLogger(__name__)

_PARSE_BATCH = 2000
_PERSIST_BATCH = 5000
_RESULT_COLUMNS = "job_id, row_index, kind, matched_entity_id, resolved_op, reasons"
# Record a batch of outcomes: each column one array parameter, so the statement never changes.
_RECORD_RESULTS = text(
    f"INSERT INTO {ImportResultORM.__table__.fullname} ({_RESULT_COLUMNS}) "
    "SELECT :job_id, v.row_index, v.kind, v.eid, v.op, v.reasons::jsonb "
    "FROM unnest(:idx, :kinds, :eids, :ops, :reasons) AS v(row_index, kind, eid, op, reasons)",
).bindparams(bindparam("idx", type_=ARRAY(BigInteger)),
             *(bindparam(name, type_=ARRAY(Text)) for name in ("kinds", "eids", "ops", "reasons")))
# The outcomes a worker of the release before ``import_results`` recorded on a job's staged rows,
# copied across for the job it staged and this one resumes (``ImportWorker._carry_over_results``).
_CARRY_OVER_RESULTS = text(
    f"INSERT INTO {ImportResultORM.__table__.fullname} ({_RESULT_COLUMNS}) "
    f"SELECT {_RESULT_COLUMNS} FROM {ImportRowORM.__table__.fullname} "
    "WHERE job_id = :job_id AND resolved_op IS NOT NULL ON CONFLICT DO NOTHING")
# A list of ids, as one array: the statement is the same whatever the list's length.
_IDS = any_(bindparam("ids", type_=ARRAY(Text)))
# A node row's resolutions that leave it naming a node later rows may point at.
_LANDED = ("create", "update", "unchanged")
# What an import's summary tallies, per row by its resolution (``deleted`` also counts what a
# replace deleted because no row named it).
_TALLIES = ("new", "updated", "unchanged", "deleted", "invalid")
# Times a window's other rows are applied again after the write gate refused some of them
# (``ImportWorker._apply_window``).
_QUARANTINE_ROUNDS = 4


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


def _staged(res):
    """An outcome's own staged row (``res`` is ``ImportResultORM``), to join for its raw fields."""
    return and_(ImportRowORM.job_id == res.job_id, ImportRowORM.row_index == res.row_index)


def _first_layer_id(layers: List[dict]) -> str:
    """The view's first layer (order 0). Stable sort keeps list order on ties / missing order."""
    return sorted(
        layers, key=lambda l: l.get("order") if isinstance(l.get("order"), (int, float)) else 0
    )[0]["id"]


def _match_layer_signal(signal, layers: List[dict], fallback_id: Optional[str]) -> Optional[str]:
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


def contract_import_root_assignments(
    created_nodes: List[Dict[str, Any]],
    batch_edges: List[tuple],
    spec,
    containment: Dict[str, bool],
    layers: List[dict],
    existing_assignments: Dict[str, Any],
    *,
    now: str = None,
) -> Dict[str, dict]:
    """:func:`compute_import_root_assignments` under the placement contract
    (``placementContractEnabled``).

    ``spec`` is the view's ``view_placement.PlacementSpec``; ``containment`` is
    ``{EDGE_TYPE: child is source}`` from the ontology, so a root is found with the containment
    DIRECTION (a ``BELONGS_TO`` child is the edge's source, not its target). Each root goes through
    ``suggest_placement``: the row's ``layerAssignment`` signal is the chosen layer when it names a
    layer id or name, else the contract decides (a stamp or rule in an open view; in a curated one
    the first layer by order when nothing else places it). An entry is written only when the view is
    curated or the contract would not already put the root there. Keys and entries otherwise as
    :func:`compute_import_root_assignments`.
    """
    valid_layers = [l for l in (layers or []) if isinstance(l, dict) and l.get("id")]
    if not valid_layers:
        return {}
    child_eids = set()
    for src, tgt, etype in batch_edges:
        child_is_source = containment.get(str(etype).strip().upper())
        if child_is_source is not None:
            child_eids.add(src if child_is_source else tgt)
    child_eids.discard(None)
    stamp = now or _now()
    new_entries: Dict[str, dict] = {}
    for node in created_nodes:
        eid = node.get("eid")
        if eid in child_eids:                        # has a containment parent in the batch → inherits
            continue
        key = node.get("urn") or f"gv:{eid}"
        if key in existing_assignments or key in new_entries:
            continue                                 # never overwrite an existing / already-added entry
        signal = node.get("layer_signal")
        tags = node.get("tags")
        facts = NodeFacts(
            urn=key,
            entity_type=node.get("entity_type") or "",
            display_name=node.get("display_name"),
            tags=frozenset(t for t in tags if isinstance(t, str)) if isinstance(tags, list) else frozenset(),
            properties=node.get("properties") if isinstance(node.get("properties"), dict) else {},
            stamp=signal if isinstance(signal, str) and signal else None,
        )
        layer_id, pin = suggest_placement(spec, facts, _match_layer_signal(signal, valid_layers, None))
        if pin:
            new_entries[key] = {
                "layerId": layer_id,
                "inheritsChildren": True,
                "assignedBy": "import",
                "assignedAt": stamp,
            }
    return new_entries


class ImportWorker:
    def __init__(self, versioning, store, scope=None, ontology=None, facts: bool = True,
                 node_identity=None) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope          # view scope for scoped replace ({assigned_urns, ...}) | None
        self._ontology = ontology    # {node_types, edge_types} for the per-row gate | None
        # The data source's node-identity mapping (ResolvedNodeIdentity | None): each window's
        # nodes get their own name / identity properties as they are written (apply_ops binds).
        self._node_identity = node_identity
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
        # The job's identity state (``_identity_state``): the file entity ids of the nodes its
        # committed windows matched or created, by the ids the server gave them; the second names
        # (an identifier value beside a different urn) rows gave those nodes; what the graph
        # derives node ids in; the property the data source identifies nodes by; the team keys
        # of the file's values.
        self._created_from: Dict[str, str] = {}
        self._aliases: Dict[str, str] = {}
        self._id_scope: str = ""
        self._identity_prop: Optional[str] = None
        self._keys: Optional[KeyIndex] = None
        self._canon: Dict[str, str] = _canonical_map((ontology or {}).get("node_types"))
        self._identity_read = False

    async def run(self, job_id: str, *, lease: Optional[Lease] = None) -> Dict[str, int]:
        """Run the import job to the end on ``lease`` — the transfer lane's; called without one,
        the job is taken here (:func:`lease_job`) — resuming from its cursor. Returns its tallies.
        Raises :class:`Superseded` once the job is no longer this worker's."""
        self._lease = lease or await lease_job(job_id)
        job = await self._job(job_id)
        graph_id, branch_id = job["graph_id"], job["branch_id"]
        actor = await self._branch_owner(graph_id, branch_id)

        await self._lease.retry_transient(lambda: self._carry_over_results(job_id))
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

    async def _carry_over_results(self, job_id: str) -> None:
        """A job a worker of the release before ``import_results`` staged, which this one resumes,
        has its rows' outcomes on the rows themselves: copy them across, once, before any window
        reads them. One indexed probe for any other job (no staged row of its names an entity).
        Goes with ``ix_import_rows_matched`` in the release after."""
        async with db.graphver_session() as s:
            older = await s.scalar(select(ImportRowORM.row_index).where(
                ImportRowORM.job_id == job_id, ImportRowORM.matched_entity_id.is_not(None)).limit(1))
            if older is not None:
                await s.execute(_CARRY_OVER_RESULTS, {"job_id": job_id})

    async def _branch_owner(self, graph_id: str, branch_id: str) -> str:
        async with db.graphver_session() as s:
            branch = await s.get(BranchORM, branch_id)
            return (branch.owner if branch else None) or "system"

    async def _reject_binary(self, source_uri: str) -> bytes:
        """Fail fast with a clear message on a binary (non-text) file — uploading an Excel
        workbook (.xlsx/.xls) instead of CSV is a common mistake that would otherwise parse into
        meaningless rows. Raised in the normal flow (not inside a generator) so the message
        surfaces on the job. Returns the first chunk for the format sniff."""
        async with contextlib.aclosing(open_source(self._store, source_uri)) as chunks:
            async for chunk in chunks:
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
        pos = await self._position(job_id)
        cursor = pos.cursor
        if cursor is not None and not cursor.startswith("parse:"):
            return
        self._skip = int(cursor.partition(":")[2]) if cursor else 0
        staged, skipped = await self._parse(job_id, source_uri, fmt)
        # Records that are neither a node nor an edge, kept on the job (a replace refuses them).
        tally = {"summary": {**pos.summary, "skipped": skipped}} if skipped else {}
        async with db.graphver_session() as s:
            await self._lease.checkpoint(s, expect_cursor=self._cursor, last_cursor="node:-1",
                                         total=staged, current_phase="nodes", **tally)
        self._cursor = "node:-1"

    async def _parse(self, job_id: str, source_uri: str, fmt: str) -> Tuple[int, int]:
        """Stage the file's rows past those already staged. Returns how many rows the file has, and
        how many of its records are neither a node nor an edge — counted over the whole file, a
        resumed parse's already staged part too."""
        # xlsx IS a zip (PK); its adapter reads it natively. A view package's data is NDJSON read out
        # of its archive (uploads.open_source): nothing to sniff, and no second spool to sniff it.
        if (fmt or "").lower() != "xlsx" and not is_archive_source(source_uri):
            head = await self._reject_binary(source_uri)
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
        native = is_archive_source(source_uri)            # a package: its lines may be format 2
        batch: List[Dict[str, Any]] = []
        idx = skipped = 0
        # Closed however the parse ends, so a package's spool goes with it.
        async with contextlib.aclosing(open_source(self._store, source_uri)) as chunks:
            async for page in _record_pages(adapter, chunks):
                # Normalizing is per-row Python work: a page at a time, off the event loop.
                rows, page_skipped = await asyncio.to_thread(_normalize_page, page, native)
                skipped += page_skipped
                for kind, row in rows:
                    if idx >= self._skip:              # below it: staged by an earlier run of the job
                        batch.append({"job_id": job_id, "row_index": idx, "kind": kind, "raw": row})
                    idx += 1
                if len(batch) >= _PARSE_BATCH:
                    await self._flush(batch)
                    batch = []
        if batch:
            await self._flush(batch)
        return idx, skipped

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
        through a transient fault (``retry_transient``) from the cursor; returns the tallies.

        A replace deletes whatever no row matched, so it refuses to while the file has rows it
        couldn't apply, which may name what it means to keep: records that are neither a node nor
        an edge (before the first window, so nothing is written), and invalid rows (once every
        window is in, before any delete)."""
        skipped = int((await self._position(job_id)).summary.get("skipped") or 0)
        if reconcile_mode == "replace" and skipped:
            raise ValueError(
                f"Nothing was deleted: {skipped} record(s) of the file are neither a node nor an "
                "edge, and a replace deletes whatever the file leaves out — which could include "
                "what those records name. Nothing was imported either. Fix those records and "
                "import the file again.")
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        more = True
        while more:
            more = await self._lease.retry_transient(
                lambda: self._next_window(job_id, snap, graph_id, branch_id, actor))
        if reconcile_mode == "replace":        # delete-on-absence (not file rows; counted as it goes)
            invalid = int((await self._position(job_id)).summary.get("invalid") or 0)
            if invalid:
                raise ValueError(
                    f"Nothing was deleted: {invalid} row(s) of the file couldn't be applied, and a "
                    "replace deletes whatever the file leaves out — which would include what those "
                    "rows name. The file's other rows are on the draft. Fix those rows and import "
                    "the file again.")
            await self._lease.retry_transient(
                lambda: self._delete_absent(job_id, snap, graph_id, branch_id, actor))
        summary = (await self._position(job_id)).summary
        tallies = {k: int(summary.get(k) or 0) for k in _TALLIES}
        return {**tallies, "skipped": skipped} if skipped else tallies

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
            await _analyze_graph(graph_id)
            kind, rows = "edge", await self._window(job_id, "edge", -1)
        if not rows:
            return False
        if not self._identity_read:                # once a run, before its first window
            await self._identity_state(job_id, snap, graph_id, branch_id)
            self._identity_read = True
        lookups = await (self._node_lookups if kind == "node" else self._edge_lookups)(snap, rows)
        lookups.update(created_from=self._created_from, keys=self._keys,
                       earlier=await self._earlier(job_id, kind, rows[0]["_row_index"], lookups))
        scope = self._id_scope
        ops, resolutions = await asyncio.to_thread(       # a window of pure-Python matching
            resolve_rows, rows, lookups, mint_id=new_entity_id,     # a urn:uuid (UUIDv7) each
            ontology=self._ontology, identity_prop=self._identity_prop,
            mint_urn=lambda _etype: new_entity_id(),
            derive_urn=lambda seed: pointer_id(scope, seed))
        processed = pos.processed + len(rows)

        async def on_commit(s) -> None:
            # Tallied at the commit, so a row quarantined on the way counts as what it ended as.
            summary = {**dict.fromkeys(_TALLIES, 0), **pos.summary}
            for res in resolutions:
                summary[res["status"]] = int(summary.get(res["status"]) or 0) + 1
            await self._persist_resolutions(s, job_id, resolutions)
            await self._lease.checkpoint(
                s, expect_cursor=pos.cursor, last_cursor=f"{kind}:{rows[-1]['_row_index']}",
                processed=processed, summary=summary, current_phase=f"{kind}s",
                progress=min(99, processed * 100 // pos.total) if pos.total else 0)

        await self._apply_window(graph_id, branch_id, actor, ops, resolutions, on_commit)
        if kind == "node":
            self._remember_created(rows, ops, resolutions)
        return True

    async def _identity_state(self, job_id: str, snap, graph_id: str, branch_id: str) -> None:
        """What every window resolves new nodes and named ends against, read once a run (a resumed
        job reads it again): what the graph derives node ids in (its data source); the nodes
        earlier windows matched or created, by the file entity id and the second name each row
        gave its node; the data source's identifier property; and the team keys — the fields each
        type matches imports by or keeps unique — holding the values the file uses, from one pass
        over the draft's live nodes of those types (none when the file uses none)."""
        from backend.app.services.node_identity import identity_property
        self._graph_id, self._branch_id = graph_id, branch_id
        self._id_scope = await self._svc.identity_scope(graph_id)
        self._identity_prop = ident = identity_property(self._node_identity)
        self._created_from, self._aliases = {}, {}
        # Only the rows that leave a link: a file id that is not the node's own, or an identifier
        # value beside a urn — never a whole row, which a large job has millions of.
        fid, urn = ImportRowORM.raw["entity_id"].astext, ImportRowORM.raw["urn"].astext
        value = ImportRowORM.raw["properties"][ident].astext if ident else null()
        res = ImportResultORM
        links = or_(and_(fid != "", fid != res.matched_entity_id),
                    and_(urn.isnot(None), value.isnot(None)) if ident else false())
        async with db.graphver_session() as s:
            landed = (await s.execute(
                select(fid, urn, value, res.matched_entity_id)
                .join_from(res, ImportRowORM, _staged(res))
                .where(res.job_id == job_id, res.kind == "node", res.resolved_op.in_(_LANDED), links,
                       res.matched_entity_id.is_not(None)))).all()   # not a delete of nothing
        for row_fid, row_urn, row_value, eid in landed:
            self._link(row_fid, row_urn, row_value, eid)
        onto = self._ontology or {}
        keys = KeyIndex(onto.get("keys"), onto.get("unique"))
        self._keys = keys if keys else None
        if self._keys is None:
            return
        async with db.graphver_session() as s:
            result = await s.stream(select(ImportRowORM.kind, ImportRowORM.raw)
                                    .where(ImportRowORM.job_id == job_id))
            await self._read_keys(snap, result)

    async def validation_state(self, snap, graph_id: str, branch_id: str, rows) -> None:
        """The identity state a dry run (``ImportExportService.validate_import``) resolves its
        rows against: as :meth:`_identity_state`, for rows held in memory and no job."""
        from backend.app.services.node_identity import identity_property
        self._graph_id, self._branch_id = graph_id, branch_id
        self._id_scope = await self._svc.identity_scope(graph_id)
        self._identity_prop = identity_property(self._node_identity)
        onto = self._ontology or {}
        keys = KeyIndex(onto.get("keys"), onto.get("unique"))
        self._keys = keys if keys else None
        if self._keys is not None:
            async def held():
                for row in rows:
                    yield row["kind"], row
            await self._read_keys(snap, held())

    async def _read_keys(self, snap, rows) -> None:
        """Fill the team keys with their holders: the values ``rows`` (``(kind, raw)``, as staged)
        use, found in one pass over the draft's live nodes of the key types."""
        keys = self._keys
        wanted: Dict[str, set] = {}
        async for kind, raw in rows:
            if kind == "node":
                pairs = keys.values(self._canon.get(str(raw.get("entityType") or "").lower(),
                                                    raw.get("entityType")), raw.get("properties"))
            else:
                pairs = [(f, key_value(v)) for end in ("source", "target")
                         for f, v in (raw.get(f"{end}Keys") or {}).items()]
            for field, value in pairs:
                if value is not None:
                    wanted.setdefault(field, set()).add(value)
        if not wanted:
            return
        types = set(keys.match) | set(keys.unique)
        async with contextlib.aclosing(snap.iter_live("node", payload=True)) as pages:
            async for page in pages:
                for w in page:
                    if w.entity_type not in types or not w.payload:
                        continue
                    props = (json.loads(w.payload) or {}).get("properties") or {}
                    held = {f: v for f, v in keys.values(w.entity_type, props) if v in wanted.get(f, ())}
                    if held:
                        keys.add(w.entity_type, held, w.entity_id, w.urn)

    def _link(self, fid: Optional[str], urn: Optional[str], value: Any, eid: str) -> None:
        """What later windows find ``eid`` by, for a row that matched or made it: the file's own
        entity id ``fid`` (when it is not the node's id), and the identifier ``value`` the row
        gave it beside a different ``urn`` — a second name, which no stored urn or derived id
        answers to."""
        if fid and fid != eid:
            self._created_from[fid] = eid
        ident = key_value(value)
        if ident and urn and pointer_seed(ident) != pointer_seed(urn):
            for name in pointers(ident):
                self._aliases[name] = eid

    def _remember_created(self, rows, ops, resolutions) -> None:
        """A committed node window's rows, for the windows after it: the node each matched or
        created, by the file entity id and second name it came with; and a create's team key
        values. Only what landed — a row the write gate turned away named nothing any later row
        may point at."""
        by_index = {r["_row_index"]: r for r in rows}
        urn_of = {o["entity_id"]: (o.get("payload") or {}).get("urn") for o in ops
                  if o.get("op") == "create"}
        for res in resolutions:
            eid = res.get("matched_entity_id")
            if res.get("resolved_op") not in _LANDED or not eid:
                continue
            row = by_index.get(res["_row_index"]) or {}
            self._link(row.get("entity_id"), row.get("urn"),
                       (row.get("properties") or {}).get(self._identity_prop)
                       if self._identity_prop else None, eid)
            if res["resolved_op"] == "create" and self._keys is not None:
                etype = self._canon.get(str(row.get("entityType") or "").lower(), row.get("entityType"))
                self._keys.add(etype, row.get("properties"), eid, urn_of.get(eid))

    async def _apply_window(self, graph_id, branch_id, actor, ops, resolutions, on_commit) -> None:
        """Apply a window's ``ops`` with its ``on_commit`` (which commits alone when there are none).

        A row the write gate refuses (:class:`OntologyViolation` — a type a strict ontology does
        not declare, an edge a case variant duplicates) is quarantined like any other bad row:
        its resolution turns ``invalid`` with the gate's reasons (recorded by ``on_commit`` with
        the rest of the window) and the window's other ops are applied again. The gate stops at
        its first failing check, so this takes up to ``_QUARANTINE_ROUNDS`` rounds; past them, or
        when a violation names an entity no op of the window writes, the window fails as before
        (resumable from its cursor)."""
        for attempt in range(_QUARANTINE_ROUNDS + 1):
            if not ops:
                async with db.graphver_session() as s:
                    await on_commit(s)
                return
            try:
                await self._svc.apply_ops(graph_id=graph_id, ops=ops, actor=actor,
                                          branch_id=branch_id, message="import", on_commit=on_commit,
                                          node_identity=self._node_identity)
                return
            except OntologyViolation as exc:
                rest = _quarantine(ops, resolutions, exc.violations) if attempt < _QUARANTINE_ROUNDS else None
                if rest is None:
                    raise
                logger.info("import window: %d op(s) quarantined by the write gate, the other %d "
                            "applied again", len(ops) - len(rest), len(rest))
                ops = rest

    async def _earlier(self, job_id: str, kind: str, before: int, lookups) -> Dict[str, int]:
        """``{entity id: row}`` for the entities this window's rows may name that a row of this
        job before ``before`` already named (its first), so a second row for one is seen as one
        whichever window it falls in. One indexed read of the job's resolved rows per chunk."""
        eids = (lookups.get("node_eids") or set()) if kind == "node" else (
            set((lookups.get("edge_to_eid") or {}).values()) | (lookups.get("edge_eids") or set()))
        out: Dict[str, int] = {}
        res = ImportResultORM
        stmt = (select(res.matched_entity_id, func.min(res.row_index))
                .where(res.job_id == job_id, res.kind == kind, res.row_index < before,
                       res.matched_entity_id == _IDS, res.resolved_op != "invalid")
                .group_by(res.matched_entity_id))
        async with db.graphver_session() as s:
            for chunk in _chunks(sorted(e for e in eids if e), _PERSIST_BATCH):
                out.update((await s.execute(stmt, {"ids": chunk})).all())
        return out

    async def _window(self, job_id: str, kind: str, after: int) -> List[Dict[str, Any]]:
        """The next ``IMPORT_COMMIT_WINDOW`` staged rows of ``kind`` after ``after``, in file order."""
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM.row_index, ImportRowORM.raw)
                .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == kind,
                       ImportRowORM.row_index > after)
                .order_by(ImportRowORM.row_index).limit(config.IMPORT_COMMIT_WINDOW))).all()
        return [{**raw, "_row_index": idx} for idx, raw in rows]

    async def _pointer_hits(self, snap, names) -> Dict[str, str]:
        """``{name: node id}`` for the names rows point at nodes by: the live node that carries the
        name as its urn; else the live node whose id the name derives (one an import made from it);
        else the node a row of this job gave it to as a second name."""
        names = {n for n in names if n}
        hits = dict(await snap.nodes_by_urn(names))
        derived = {n: pointer_id(self._id_scope, pointer_seed(n)) for n in names - set(hits)}
        live = await snap.lookup_live("node", set(derived.values()))
        hits.update({n: d for n, d in derived.items() if d in live})
        hits.update({n: self._aliases[n] for n in names - set(hits) if n in self._aliases})
        return hits

    async def _node_lookups(self, snap, rows) -> Dict[str, Any]:
        """What ``resolve_rows`` needs to match these node rows: the live nodes they name by
        entity_id, urn (or the identifier property's value) or — a row without a urn —
        qualifiedName, each one's current payload; and, of the identities the rows that match
        nothing would take, which are taken and which a deleted node held."""
        ident = self._identity_prop
        wanted = {n for r in rows for n in pointers(
            r.get("urn"), (r.get("properties") or {}).get(ident) if ident else None)}
        by_id = await snap.lookup_live("node", {r["entity_id"] for r in rows if r.get("entity_id")})
        urn_to_eid = await self._pointer_hits(snap, wanted)
        qname_to_eid = await snap.nodes_by_qname(r.get("qualifiedName") for r in rows if not r.get("urn"))
        named = set(by_id) | set(urn_to_eid.values()) | {e for e in qname_to_eid.values() if e}
        # A node an earlier window of this job made, by the file's id for it: read with the rest,
        # so a later row for it is diffed against what it now holds.
        named |= {self._created_from[f] for r in rows if (f := r.get("entity_id")) in self._created_from}
        if self._keys is not None:          # a node a team key names, with its current value
            named |= {e for r in rows if (e := self._keys.node(
                self._canon.get(str(r.get("entityType") or "").lower(), r.get("entityType")),
                r.get("properties"))[0])}
        taken, restore = await self._svc.identities_taken(
            graph_id=self._graph_id, branch_id=self._branch_id, names=wanted - set(urn_to_eid))
        current, hash_of = await _heads(snap, "node", named)
        return {"urn_to_eid": urn_to_eid, "qname_to_eid": qname_to_eid, "node_eids": named,
                "current": current, "hash_of": hash_of,
                "bases": await _bases(snap, "node", rows, hash_of), "taken": taken, "restore": restore}

    async def _edge_lookups(self, snap, rows) -> Dict[str, Any]:
        """What ``resolve_rows`` needs for these edge rows: the live nodes their endpoints name (by
        entity_id, urn, or — an end without a urn — qualifiedName), the live edges between those
        nodes, and each such edge's current payload."""
        ends = {}
        ident = self._identity_prop
        for end in ("source", "target"):
            by_id = await snap.lookup_live("node", {r[f"{end}_entity_id"] for r in rows
                                                    if r.get(f"{end}_entity_id")})
            by_qname = await snap.nodes_by_qname(r.get(f"{end}QualifiedName") for r in rows
                                                 if not r.get(f"{end}Urn"))
            # An end pointed at by its urn, or by the identifier property's value.
            by_urn = await self._pointer_hits(snap, {n for r in rows for n in pointers(
                r.get(f"{end}Urn"), (r.get(f"{end}Keys") or {}).get(ident) if ident else None)})
            # Ends named by the file's id of a node this job created, or by a team key: the
            # edges already between them are found too (a second import updates, never doubles).
            more = {self._created_from.get(r.get(f"{end}_entity_id") or "") for r in rows}
            if self._keys is not None:
                more |= {self._keys.end(r.get(f"{end}Keys") or {})[0] for r in rows}
            ends[end] = (by_id, by_qname, by_urn, {e for e in more if e})
        (src_ids, src_qnames, src_urns, src_more), (tgt_ids, tgt_qnames, tgt_urns, tgt_more) = (
            ends["source"], ends["target"])
        edge_to_eid = await snap.edges_between(
            set(src_ids) | {e for e in src_qnames.values() if e} | set(src_urns.values()) | src_more,
            set(tgt_ids) | {e for e in tgt_qnames.values() if e} | set(tgt_urns.values()) | tgt_more)
        # And the edges rows name by their own id, as an export writes them: such a row updates
        # that edge, and one whose ends differ from it is refused rather than made a second edge.
        own = {r["entity_id"] for r in rows if r.get("entity_id")}
        current, hash_of = await _heads(snap, "edge", set(edge_to_eid.values()) | own)
        return {"urn_to_eid": {**src_urns, **tgt_urns}, "qname_to_eid": {**src_qnames, **tgt_qnames},
                "node_eids": set(src_ids) | set(tgt_ids), "edge_to_eid": edge_to_eid,
                "edge_eids": own & set(hash_of), "current": current, "hash_of": hash_of,
                "bases": await _bases(snap, "edge", rows, hash_of)}

    async def _derive_facts(self, job_id: str, graph_id: str, branch_id: str) -> None:
        """The raw facts for the post-commit view layout write-back (created top-level entities),
        from what the whole import did rather than from this run's memory, which lacks the windows
        an earlier run of a resumed job applied: the node rows it created (their minted eids, urns,
        layer signals and the type, name, tags and properties the placement contract reads, in file
        order), and the endpoints of the edges it created as the draft holds them. The layout writer
        maps each eid to its projection key (urn or gv:<eid>) and reasons about parentage from the
        created edges."""
        res = ImportResultORM
        created = (res.job_id == job_id, res.resolved_op == "create")
        async with db.graphver_session() as s:
            nodes = (await s.execute(
                select(res.matched_entity_id, ImportRowORM.raw["urn"].astext,
                       ImportRowORM.raw["layerAssignment"], ImportRowORM.raw["entityType"].astext,
                       ImportRowORM.raw["displayName"].astext, ImportRowORM.raw["tags"],
                       ImportRowORM.raw["properties"])
                .join_from(res, ImportRowORM, _staged(res))
                .where(*created, res.kind == "node").order_by(res.row_index))).all()
            # Each created node's projection key is the urn it was stored with — the file's urn
            # is only a pointer — read from the draft's versions, as the edges are below.
            stored: Dict[str, Optional[str]] = {}
            for chunk in _chunks([n[0] for n in nodes], _PERSIST_BATCH):
                stored.update((await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.urn)
                    .where(NodeVersionORM.graph_id == graph_id,
                           NodeVersionORM.branch_id == branch_id,
                           NodeVersionORM.entity_id.in_(chunk), NodeVersionORM.op == "create"))).all())
            edge_ids = (await s.execute(select(res.matched_entity_id)
                                        .where(*created, res.kind == "edge"))).scalars().all()
            edges = []
            for chunk in _chunks(edge_ids, _PERSIST_BATCH):
                edges += (await s.execute(
                    select(EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id,
                           EdgeVersionORM.edge_type)
                    .where(EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.branch_id == branch_id,
                           EdgeVersionORM.entity_id.in_(chunk), EdgeVersionORM.op == "create"))).all()
        # A create drops a PROP_DELETE marker (resolve._no_deletes): no property the entity has.
        self.created_node_facts = [
            {"eid": eid, "urn": stored.get(eid) or urn, "layer_signal": signal, "entity_type": etype,
             "display_name": name, "tags": tags,
             "properties": {k: v for k, v in (props or {}).items() if v != PROP_DELETE}}
            for eid, urn, signal, etype, name, tags, props in nodes]
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
                select(ImportResultORM.matched_entity_id).where(
                    ImportResultORM.job_id == job_id, ImportResultORM.matched_entity_id == _IDS),
                {"ids": list(eids)})).scalars())
        return [eid for eid in eids if eid not in matched]

    @staticmethod
    async def _persist_resolutions(s, job_id: str, resolutions) -> None:
        """Record each row's outcome in ``import_results``, in the window's transaction: one INSERT
        per few thousand rows, each column as one array (unnest), rather than a round trip per row
        (which took over a third of an import). The staged rows themselves are never written again."""
        for chunk in _chunks(resolutions, _PERSIST_BATCH):
            await s.execute(_RECORD_RESULTS, {
                "job_id": job_id, "idx": [r["_row_index"] for r in chunk],
                "kinds": [r["kind"] for r in chunk],
                "eids": [r["matched_entity_id"] for r in chunk],
                "ops": [r["resolved_op"] for r in chunk],
                "reasons": [json.dumps(r["reasons"]) if r["reasons"] else None for r in chunk]})


async def _analyze_graph(graph_id: str) -> None:
    """Refresh the planner's statistics of the graph's partitions once the node windows are in.

    Until autovacuum gets to them, they describe the partitions without what those windows wrote
    (100k draft heads and versions into a new graph): the first edge window's lookups of its ends'
    draft heads, planned for a handful of rows, took 88 s of a 100k import where later windows
    take 5 s. Best effort (it needs the tables' owner): without it the plans only come later."""
    try:
        async with db.graphver_session() as s:
            for table in ("entity_heads", "node_versions", "edge_versions"):
                part = await s.scalar(text(
                    f'SELECT tableoid::regclass::text FROM "{config.graphver_schema()}"."{table}" '
                    "WHERE graph_id = :g LIMIT 1"), {"g": graph_id})
                if part:
                    await s.execute(text(f"ANALYZE {part}"))
    except Exception as exc:                                     # noqa: BLE001 — best effort
        logger.warning("import into %s: could not refresh statistics: %s", graph_id, exc)


async def sweep_staged_rows(*, older_than_days: float, batch: int = 50_000) -> int:
    """Delete the staged rows of import jobs that finished more than ``older_than_days`` ago, with
    their outcomes, a batch per transaction (a large import stages millions). Their preview sample
    goes with them; the draft's changes, the review surface, stay. Returns how many rows went."""
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
                # In row order, so both statements name the same rows: the batch's outcomes, then
                # the rows. An outcome is never left behind without its row.
                first = (select(ImportRowORM.row_index).where(ImportRowORM.job_id == job_id)
                         .order_by(ImportRowORM.row_index).limit(batch))
                await s.execute(delete(ImportResultORM).where(
                    ImportResultORM.job_id == job_id, ImportResultORM.row_index.in_(first)))
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


def _quarantine(ops: List[dict], resolutions: List[dict], violations) -> Optional[List[dict]]:
    """``ops`` without the entities ``violations`` name, and the rows that wrote them turned
    ``invalid`` with the gate's reasons (in ``resolutions``, in place) — or ``None`` when a
    violation names an entity no op writes: then the window itself is not what is wrong."""
    reasons: Dict[str, List[str]] = {}
    for v in violations or []:
        reasons.setdefault(v.get("entity_id"), []).append(
            str(v.get("reason") or v.get("rule") or "refused by the write gate"))
    if not reasons or not set(reasons) <= {op["entity_id"] for op in ops}:
        return None
    for res in resolutions:
        eid = res["matched_entity_id"]
        if eid in reasons and res["resolved_op"] in ("create", "update", "delete"):
            created = res["resolved_op"] == "create"       # a minted id names nothing now
            res.update(resolved_op="invalid", status="invalid", reasons=reasons[eid],
                       matched_entity_id=None if created else eid)
    return [op for op in ops if op["entity_id"] not in reasons]


def _normalize_page(page: List[Dict[str, Any]], native: bool = False) -> Tuple[List[tuple], int]:
    """``(kind, normalized row)`` for each node or edge record (its ``kind`` in any case), and how
    many records are neither: those are skipped and counted — a malformed record never aborts the
    parse. ``native``: a view package's lines."""
    out, skipped = [], 0
    for raw in page:
        kind = str(raw.get("kind") or "").strip().lower() if isinstance(raw, dict) else ""
        if kind in ("node", "edge"):
            out.append((kind, normalize(raw, kind, native=native)))
        else:
            skipped += 1
    return out, skipped


async def _heads(snap, kind: str, eids) -> Tuple[Dict[str, dict], Dict[str, str]]:
    """The current payload of each live entity among ``eids``, and its content hash."""
    live = await snap.lookup_live(kind, set(eids), payload=True)
    return ({eid: json.loads(w.payload) for eid, w in live.items() if w.payload is not None},
            {eid: w.content_hash for eid, w in live.items() if w.payload is not None})


async def _bases(snap, kind: str, rows, hash_of: Dict[str, str]) -> Dict[tuple, dict]:
    """``{(entity id, baseVersion): payload}``: the versions stale rows were exported at — rows
    naming a live entity by its id with a ``baseVersion`` its head has since moved past — that
    this graph holds, in any of its layers. Bounded by the window; a version it doesn't hold
    (another graph's export) is left out, and its row applies as it stands."""
    wanted = sorted({(r["entity_id"], r["baseVersion"]) for r in rows
                     if r.get("baseVersion") and r.get("entity_id") in hash_of
                     and hash_of[r["entity_id"]] != r["baseVersion"]})
    if not wanted:
        return {}
    model = NodeVersionORM if kind == "node" else EdgeVersionORM
    graphs = sorted({layer.graph_id for layer in snap.layers})
    out: Dict[tuple, dict] = {}
    async with db.graphver_session() as s:
        for chunk in _chunks(wanted, _PERSIST_BATCH):
            out.update({(eid, at): payload for eid, at, payload in (await s.execute(
                select(model.entity_id, model.content_hash, model.payload)
                .where(model.graph_id.in_(graphs),
                       tuple_(model.entity_id, model.content_hash).in_(chunk),
                       model.payload.is_not(None)))).all()})
    return out


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
