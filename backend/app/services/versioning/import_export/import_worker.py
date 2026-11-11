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

Reconciled in memory (the ``importInMemoryReconcile`` switch, when the draft holds nodes to be
unchanged against): the file is read twice, nodes then edges, and each batch of rows is resolved in
memory before anything is staged — exactly as its window would resolve it, the rows before it being
none that name what it names (:class:`_Seen`). A row that changes nothing is staged as a slim row,
already resolved; every other row is staged whole and resolved by its window, as above. The edges
are read once the node windows are in, so they are decided against the nodes as they then stand —

  ``mparse:<n>``  the file's node rows staged up to file row n;
  ``mnode:<row>`` the node windows applied up to staged row ``row``;
  ``eparse:<n>``  every node window, and the edge rows staged up to file row n;
  then ``edge:<row>`` and ``replace`` as above. A pass resumed by another run decides nothing more
  (what it would need to know of the rows before is gone with the run): it stages the rest whole.

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

from sqlalchemy import (BigInteger, Text, and_, bindparam, delete, exists, false, func, insert,
                        null, or_, select, text, tuple_)
from sqlalchemy.dialects.postgresql import ARRAY

from backend.app.services.view_placement import NodeFacts, suggest_placement

from .. import config, db
from ..ids import new_entity_id, uuid_urn
from ..job_lease import QUEUED, Lease, Superseded
from ..models import BranchORM, EdgeVersionORM, ImportRowORM, JobORM, NodeVersionORM
from ..service import OntologyViolation
from . import identifier as identifiers
from . import keys as matching
from .formats import get_adapter
from .resolve import (KeyIndex, _canonical_map, edge_pointer_id, key_pointer_id, key_value,
                      pointer_id, pointer_seed, pointers, resolve_rows)
from .rowmodel import PROP_DELETE, normalize
from .snapshot import open_snapshot
from .stream import view_entities
from .uploads import WHOLE_FILE_FORMATS, is_archive_source, open_source, source_size, too_large

logger = logging.getLogger(__name__)

_PARSE_BATCH = 2000
_PERSIST_BATCH = 5000
# Record a batch of resolutions: each column one array parameter, so the statement never changes.
_RESOLVE_ROWS = text(
    f"UPDATE {ImportRowORM.__table__.fullname} AS r SET matched_entity_id = v.eid, resolved_op = v.op, "
    "status = v.status, reasons = v.reasons::jsonb, code = v.code "
    "FROM unnest(:idx, :eids, :ops, :statuses, :reasons, :codes) "
    "AS v(row_index, eid, op, status, reasons, code) "
    "WHERE r.job_id = :job_id AND r.row_index = v.row_index",
).bindparams(bindparam("idx", type_=ARRAY(BigInteger)),
             *(bindparam(name, type_=ARRAY(Text))
               for name in ("eids", "ops", "statuses", "reasons", "codes")))
# A node row's resolutions that leave it naming a node later rows may point at.
_LANDED = ("create", "update", "unchanged")
# What an import's summary tallies, per row by its resolution (``deleted`` also counts what a
# replace deleted because no row named it).
_TALLIES = ("new", "updated", "unchanged", "deleted", "invalid")
# Times a window's other rows are applied again after the write gate refused some of them
# (``ImportWorker._apply_window``).
_QUARANTINE_ROUNDS = 4
#: Admin → Features: reconcile an import in memory, a batch at a time (``_stage_pass``). A row that
#: changes nothing is decided before it is staged, and recorded as a slim row (``_slim_row``)
#: instead of whole and then rewritten with its resolution: a file sent again with a few percent
#: changed writes into Postgres about what changed. Read when a job starts; the job keeps the mode it
#: started in (its cursor says so) whatever the switch says later.
IN_MEMORY_SWITCH = "importInMemoryReconcile"
#: Rows of a pass decided before it judges whether deciding pays, and the share of them that must
#: have been unchanged for it to go on: an import that mostly adds (a new subtree into a large
#: graph) stops deciding early and stages the rest whole, as before.
_DECIDE_PROBE_ROWS = 20_000
_DECIDE_MIN_UNCHANGED = 0.1


class _Seen:
    """What the rows of one pass of an in-memory import have named so far, in file order — file
    ids, urns and identifier values, qualified names, the entities they matched — as a Bloom
    filter. A row may be decided unchanged before the windows only when nothing it names was named
    before it: a second row for an entity, or a name a new node takes, changes what a later row
    resolves to, and only its window sees that. A false positive only sends a row the usual way;
    nothing named is ever missed. 12 bits a name: under 1% false positives at ``capacity``."""

    _PROBES = 4

    def __init__(self, capacity: int) -> None:
        self._size = max(1 << 16, capacity * 12)
        self._bits = bytearray((self._size + 7) // 8)

    def _positions(self, name: str):
        h = hash(name) & 0xFFFF_FFFF_FFFF_FFFF
        first, step = h & 0xFFFF_FFFF, (h >> 32) | 1
        return [(first + i * step) % self._size for i in range(self._PROBES)]

    def __contains__(self, name: str) -> bool:
        return all(self._bits[p >> 3] & (1 << (p & 7)) for p in self._positions(name))

    def add(self, name: str) -> None:
        for p in self._positions(name):
            self._bits[p >> 3] |= 1 << (p & 7)


async def _in_memory_switch() -> bool:
    """Whether new imports reconcile in memory (``IN_MEMORY_SWITCH``), as the flag cache has it.
    A switch that can't be read is off: the import runs as it always has."""
    from backend.app.services.feature_flags import feature_flags
    try:
        return await feature_flags.is_enabled_self_session(IN_MEMORY_SWITCH, default=False)
    except Exception:  # noqa: BLE001 — unread is off, the way that never surprises anyone
        logger.warning("imports: the %s switch could not be read; reconciling as before",
                       IN_MEMORY_SWITCH, exc_info=True)
        return False


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
    ``(kind, row)``; ``replace`` (or anything else) → ``(None, -1)``, no window left. An import
    reconciled in memory says so in its cursor: ``mnode:<row>`` for its node windows (its edges are
    staged once they are in), ``eparse:<n>`` while its edges are staged from file row ``n``."""
    kind, _, row = (cursor or "").partition(":")
    return (kind, int(row)) if kind in ("node", "mnode", "eparse", "edge") else (None, -1)


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


class ReplaceBlocked(Exception):
    """A replace that would delete most of its scope and make most of it again, refused before it
    deletes anything. The job's ``summary.replaceGuard`` says what it would have done, and the limits
    in force."""
    code, action = "mass_delete_blocked", "allow_mass_delete"


class IdentifierMatchedNothing(Exception):
    """A replace whose first full node window found an entity for almost none of its rows: by its
    identifier, the file very likely names its entities by another key. Stopped there."""
    code, action = "identifier_matched_nothing", "identifier"


def replace_verdict(live: int, deletes: int, creates: int, *, allowed: bool) -> Dict[str, Any]:
    """The replace guard (``IMPORT_REPLACE_GUARD``) on a scope of ``live`` entities, before the
    import, from which a replace would delete ``deletes`` and into which it made ``creates``:
    ``state`` ``off`` (the guard is off), ``passed``, ``overridden`` (past the limits, and sent with
    allowMassDelete) or ``blocked``, with the counts and the limits in force."""
    limits = {"minLive": config.IMPORT_REPLACE_GUARD_MIN_LIVE,
              "deleteFraction": config.IMPORT_REPLACE_GUARD_DELETE_FRACTION,
              "createFraction": config.IMPORT_REPLACE_GUARD_CREATE_FRACTION}
    past = (live > 0 and live >= limits["minLive"]
            and deletes >= limits["deleteFraction"] * live
            and creates >= limits["createFraction"] * live)
    state = ("off" if not config.IMPORT_REPLACE_GUARD else "passed" if not past
             else "overridden" if allowed else "blocked")
    return {"state": state, "live": live, "deletes": deletes, "creates": creates,
            "limits": limits, "source": "platform"}


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
        # What the job's rows find their entities by (identifier.py): the job's, once it is read.
        self._identifier: str = identifiers.platform_default()
        # The job's reconcile mode, and whether a replace may delete past the replace guard.
        self._reconcile_mode = "upsert"
        self._allow_mass_delete = False
        # identifier=prop.<name>: the property, and the nodes the draft holds a value of it for
        # beyond what main's index says (its own changes, and this job's windows), both ways.
        self._prop: Optional[str] = None
        self._prop_of: Dict[str, Optional[str]] = {}
        self._prop_holders: Dict[str, set] = {}
        # Reconciling in memory: the file (read again for the edges), and per pass ("node",
        # "edge") what its rows have named — only for a pass this run started — whether it is still
        # deciding, and how many rows it decided and found unchanged.
        self._source: Tuple[Optional[str], Optional[str]] = (None, None)
        self._seen: Dict[str, _Seen] = {}
        self._deciding: Dict[str, bool] = {}
        self._decided: Dict[str, List[int]] = {}

    async def run(self, job_id: str, *, lease: Optional[Lease] = None) -> Dict[str, int]:
        """Run the import job to the end on ``lease`` — the transfer lane's; called without one,
        the job is taken here (:func:`lease_job`) — resuming from its cursor. Returns its tallies.
        Raises :class:`Superseded` once the job is no longer this worker's."""
        self._lease = lease or await lease_job(job_id)
        job = await self._job(job_id)
        graph_id, branch_id = job["graph_id"], job["branch_id"]
        self._identifier = job.get("identifier") or identifiers.platform_default()
        self._reconcile_mode = job.get("reconcile_mode") or "upsert"
        self._allow_mass_delete = bool(job.get("allow_mass_delete"))
        actor = await self._branch_owner(graph_id, branch_id)
        self._source = (job["source_uri"], job["import_format"])

        await self._lease.retry_transient(
            lambda: self._stage(job_id, job["source_uri"], job["import_format"], graph_id, branch_id))
        summary = await self._resolve_and_build(
            job_id, graph_id, branch_id, actor, job.get("reconcile_mode") or "upsert")
        if self._facts:
            await self._derive_facts(job_id, graph_id, branch_id)
        # A replace keeps the replace guard's verdict beside its tallies.
        guard = ((await self._position(job_id)).summary.get("replaceGuard")
                 if self._reconcile_mode == "replace" else None)
        if not await self._lease.finish("completed", progress=100,
                                        summary={**summary, "replaceGuard": guard} if guard else summary):
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
                    "reconcile_mode": row.reconcile_mode, "identifier": row.identity_strategy,
                    "allow_mass_delete": row.allow_mass_delete}

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

    async def _stage(self, job_id: str, source_uri: str, fmt: str, graph_id: Optional[str] = None,
                     branch_id: Optional[str] = None) -> None:
        """Parse the file into ``import_rows`` from where an earlier run of the job got to, then
        point the job at its first window (``node:-1``), with how many rows it has (``total``).
        Nothing to do once the job is past parsing. A new job reconciles in memory instead
        (:meth:`_stage_pass`, cursor ``mparse``) when :meth:`_in_memory_wanted` says it should."""
        pos = await self._position(job_id)
        cursor = pos.cursor
        if cursor is None and graph_id and await self._in_memory_wanted(graph_id, branch_id):
            cursor = "mparse:0"
        if cursor is not None and cursor.startswith("mparse:"):
            snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
            await self._decide_state(graph_id, branch_id)
            await self._stage_pass(job_id, snap, "node", int(cursor.partition(":")[2]))
            return
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

    async def _reader(self, job_id: str, source_uri: str, fmt: str):
        """``(adapter, native)``: what reads the file's records, and whether they are a view
        package's lines (which may be format 2) — checked first, so a file that can't be imported
        fails before anything is staged."""
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
        return get_adapter(fmt), is_archive_source(source_uri)

    async def _parse(self, job_id: str, source_uri: str, fmt: str) -> Tuple[int, int]:
        """Stage the file's rows past those already staged. Returns how many rows the file has, and
        how many of its records are neither a node nor an edge — counted over the whole file, a
        resumed parse's already staged part too."""
        adapter, native = await self._reader(job_id, source_uri, fmt)
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

    async def _in_memory_wanted(self, graph_id: str, branch_id: str) -> bool:
        """Whether a new job reconciles in memory: the switch is on, its types match imports by no
        team key (those match across the whole file: only the windows can see that), and the draft
        holds nodes for its rows to be unchanged against — a first load into an empty graph is all
        new, so deciding would only add reads."""
        if not await _in_memory_switch():
            return False
        onto = self._ontology or {}
        if KeyIndex(onto.get("keys"), onto.get("unique")):
            return False
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        async with contextlib.aclosing(snap.iter_live("node", limit=1)) as pages:
            async for _page in pages:
                return True
        return False

    async def _decide_state(self, graph_id: str, branch_id: str) -> None:
        """What a batch is resolved against in memory before any window (as
        :meth:`validation_state`, with no team keys): what the graph derives node ids in, and the
        data source's identifier property. The links earlier windows leave come later, read by the
        first window (:meth:`_identity_state`) — slim rows' among them."""
        from backend.app.services.node_identity import identity_property
        self._graph_id, self._branch_id = graph_id, branch_id
        self._id_scope = await self._svc.identity_scope(graph_id)
        self._identity_prop = identity_property(self._node_identity)
        self._settle_identifier()
        await self._prop_state(graph_id, branch_id, build=True)

    async def _stage_pass(self, job_id: str, snap, kind: str, resume: int) -> None:
        """Stage the file's ``kind`` rows from file row ``resume``, a batch at a time, each batch
        decided in memory first (:meth:`_decide`): an unchanged row as a slim row, already
        resolved (counted on the job as it is staged); every other row whole, for its window. Then
        point the job at the pass's windows: ``mnode:-1`` with how many rows the file has (nodes),
        or ``edge:-1`` (edges). Each batch commits with the job's cursor (``mparse:<n>`` /
        ``eparse:<n>``: the file read up to row n), so a resumed pass stages from there."""
        source_uri, fmt = self._source
        adapter, native = await self._reader(job_id, source_uri, fmt)
        if resume == 0:                         # this run starts the pass: it decides
            capacity = max(1 << 16, await source_size(self._store, source_uri) // 25)
            self._seen[kind], self._deciding[kind], self._decided[kind] = _Seen(capacity), True, [0, 0]
        elif kind not in self._seen:            # resumed by another run: nothing more is decided
            self._deciding[kind] = False
        prefix, done = ("mparse", "mnode:-1") if kind == "node" else ("eparse", "edge:-1")
        pos = await self._position(job_id)
        summary, processed = dict(pos.summary), pos.processed
        pending: List[Dict[str, Any]] = []
        idx = skipped = 0
        async with contextlib.aclosing(open_source(self._store, source_uri)) as chunks:
            async for page in _record_pages(adapter, chunks):
                rows, page_skipped = await asyncio.to_thread(_normalize_page, page, native)
                skipped += page_skipped
                for row_kind, row in rows:
                    if row_kind == kind and idx >= resume:
                        pending.append({**row, "_row_index": idx})
                    idx += 1
                    if len(pending) >= config.IMPORT_COMMIT_WINDOW:     # a window's worth
                        summary, processed = await self._flush_decided(
                            job_id, snap, kind, pending, summary, processed, f"{prefix}:{idx}")
                        pending = []
        end: Dict[str, Any] = {"current_phase": f"{kind}s"}
        if kind == "node":
            end["total"] = idx
            if skipped:         # records that are neither a node nor an edge (a replace refuses them)
                summary = {**summary, "skipped": skipped}
        await self._flush_decided(job_id, snap, kind, pending, summary, processed, done, **end)
        decided, unchanged = self._decided.get(kind) or [0, 0]
        logger.info("import job %s: %d %s row(s) decided in memory, %d of them unchanged and staged "
                    "slim", job_id, decided, kind, unchanged)

    async def _flush_decided(self, job_id: str, snap, kind: str, rows: List[Dict[str, Any]],
                             summary: Dict[str, Any], processed: int, cursor: str,
                             **values) -> Tuple[Dict[str, Any], int]:
        """Decide ``rows`` and stage them — the slim and the whole together — with the job's
        checkpoint (``cursor``, the tallies and progress the slim rows add) in ONE transaction,
        fenced like :meth:`_flush`. Returns the tallies and progress as the row now holds them."""
        slim, whole = await self._decide(snap, kind, rows) if rows else ([], [])
        summary = dict(summary)
        for _row, res in slim:
            summary[res["status"]] = int(summary.get(res["status"]) or 0) + 1
        processed += len(slim)
        # Each row names only the columns it sets (an unset one stays NULL, as the parse leaves
        # it), so they go in one INSERT per shape.
        shapes: Dict[tuple, List[Dict[str, Any]]] = {}
        for row in [self._slim_row(job_id, kind, row, res) for row, res in slim] + [
                _whole_row(job_id, kind, row) for row in whole]:
            shapes.setdefault(tuple(row), []).append(row)
        self._lease.check()
        async with db.graphver_session() as s:
            for group in shapes.values():
                for chunk in _chunks(group, _PARSE_BATCH):
                    await s.execute(insert(ImportRowORM.__table__), chunk)
            await self._lease.checkpoint(s, expect_cursor=self._cursor, last_cursor=cursor,
                                         processed=processed, summary=summary, **values)
        self._cursor = cursor
        return summary, processed

    async def _decide(self, snap, kind: str, rows: List[Dict[str, Any]]):
        """``(slim, whole)``: which of a batch's rows change nothing, as ``(row, resolution)``,
        and the rest. The batch is resolved in memory against the draft as it now stands, exactly
        as its windows would resolve it (``resolve_rows``, with the same lookups); a row is taken as
        unchanged only when that is the resolution AND nothing it names was named by a row before
        it (:class:`_Seen`) — then no earlier window can have changed what it resolves to. Once a
        pass finds deciding doesn't pay (``_DECIDE_PROBE_ROWS``), it stages the rest whole."""
        seen = self._seen.get(kind)
        if seen is None or not self._deciding.get(kind):
            return [], rows
        lookups = await (self._node_lookups if kind == "node" else self._edge_lookups)(snap, rows)
        lookups.update(created_from=self._created_from, keys=self._keys, earlier={})
        _ops, resolutions = await asyncio.to_thread(self.resolve, rows, lookups)
        by_index = {res["_row_index"]: res for res in resolutions}
        slim, whole = [], []
        for row in rows:
            res = by_index[row["_row_index"]]
            names = self._names(kind, row, res)
            fresh = not any(name in seen for name in names)
            for name in names:
                seen.add(name)
            (slim.append((row, res)) if fresh and res["resolved_op"] == "unchanged" else whole.append(row))
        counts = self._decided[kind]
        counts[0] += len(rows)
        counts[1] += len(slim)
        if counts[0] >= _DECIDE_PROBE_ROWS and counts[1] < counts[0] * _DECIDE_MIN_UNCHANGED:
            self._deciding[kind] = False
            logger.info("import: %d of the first %d %s rows were unchanged; the rest are staged "
                        "whole, for their windows", counts[1], counts[0], kind)
        return slim, whole

    def _names(self, kind: str, row: Dict[str, Any], res: Dict[str, Any]) -> List[str]:
        """What a row names, for :class:`_Seen`: an entity's ids — its own file id, the entity it
        matched — and for a node the pointers its urn and identifier value make, and its qualified
        name (a node another row makes with it leaves it naming neither)."""
        names: List[str] = []
        if kind == "node":
            ident = (key_value((row.get("properties") or {}).get(self._identity_prop))
                     if self._identity_prop else None)
            names += ["p:" + n for n in pointers(row.get("urn"), ident)]
            if row.get("qualifiedName"):
                names.append("q:" + str(row["qualifiedName"]))
            if self._prop and (v := key_value((row.get("properties") or {}).get(self._prop))):
                names.append("v:" + v)
        if row.get("entity_id"):
            names.append("e:" + str(row["entity_id"]))
        if res.get("matched_entity_id"):
            names.append("e:" + str(res["matched_entity_id"]))
        return names

    def _slim_row(self, job_id: str, kind: str, row: Dict[str, Any], res: Dict[str, Any]) -> Dict[str, Any]:
        """The staged row of a row decided unchanged: already resolved, with its matched entity
        (what a replace's absence check and a later row naming it again read), and of the row only
        the links a node leaves for the rows after it (:meth:`_identity_state`) — the file's own id
        for it when that is not its id, and an identifier value beside its urn. Nothing else reads
        an unchanged row (the preview lists the rows that change something), so usually ``{}``."""
        raw: Dict[str, Any] = {}
        if kind == "node":
            fid = row.get("entity_id")
            if fid and fid != res["matched_entity_id"]:
                raw["entity_id"] = fid
            ident = self._identity_prop
            value = (row.get("properties") or {}).get(ident) if ident else None
            if value is not None and row.get("urn"):
                raw.update(urn=row["urn"], properties={ident: value})
        staged = {"job_id": job_id, "row_index": row["_row_index"], "kind": kind, "raw": raw,
                  "matched_entity_id": res["matched_entity_id"], "resolved_op": res["resolved_op"],
                  "status": res["status"]}
        if res["reasons"]:
            staged["reasons"] = res["reasons"]
        if res.get("code"):
            staged["code"] = res["code"]
        return staged

    async def _stage_edges(self, job_id: str, snap, graph_id: str, branch_id: str, resume: int) -> None:
        """An in-memory import's edge rows, staged once its node windows are in (or from file row
        ``resume``, resumed): decided against the nodes as they now stand, with the links this
        job's node rows left."""
        if not self._identity_read:
            await self._identity_state(job_id, snap, graph_id, branch_id)
            self._identity_read = True
        await self._stage_pass(job_id, snap, "edge", resume)

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
            if (await self._position(job_id)).cursor != "replace":       # not deleting yet
                await self._lease.retry_transient(
                    lambda: self._guard_replace(job_id, snap, graph_id), never=(ReplaceBlocked,))
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
        step, after = _window_after(pos.cursor)
        if step == "eparse":                        # in memory, part-way through staging its edges
            await self._stage_edges(job_id, snap, graph_id, branch_id, after)
            return True
        kind = "node" if step == "mnode" else step
        rows = await self._window(job_id, kind, after) if kind else []
        if not rows and kind == "node":             # the node windows are done: on to the edges
            await _analyze_graph(graph_id)
            if step == "mnode":                     # in memory: its edges are staged only now
                await self._stage_edges(job_id, snap, graph_id, branch_id, 0)
                return True
            step, kind, rows = "edge", "edge", await self._window(job_id, "edge", -1)
        if not rows:
            return False
        if not self._identity_read:                # once a run, before its first window
            await self._identity_state(job_id, snap, graph_id, branch_id)
            self._identity_read = True
        lookups = await (self._node_lookups if kind == "node" else self._edge_lookups)(snap, rows)
        lookups.update(created_from=self._created_from, keys=self._keys,
                       earlier=await self._earlier(job_id, kind, rows[0]["_row_index"], lookups))
        ops, resolutions = await asyncio.to_thread(self.resolve, rows, lookups)  # pure Python
        processed = pos.processed + len(rows)

        async def on_commit(s) -> None:
            # Tallied at the commit, so a row quarantined on the way counts as what it ended as.
            summary = {**dict.fromkeys(_TALLIES, 0), **pos.summary}
            for res in resolutions:
                summary[res["status"]] = int(summary.get(res["status"]) or 0) + 1
            await self._persist_resolutions(s, job_id, resolutions)
            await self._lease.checkpoint(
                s, expect_cursor=pos.cursor, last_cursor=f"{step}:{rows[-1]['_row_index']}",
                processed=processed, summary=summary, current_phase=f"{kind}s",
                progress=min(99, processed * 100 // pos.total) if pos.total else 0)

        await self._apply_window(graph_id, branch_id, actor, ops, resolutions, on_commit)
        if kind == "node":
            self._remember_created(rows, ops, resolutions)
            if pos.cursor in ("node:-1", "mnode:-1") and len(rows) == config.IMPORT_COMMIT_WINDOW:
                await self._fail_fast(job_id, graph_id)
        return True

    async def _fail_fast(self, job_id: str, graph_id: str) -> None:
        """After a replace's first full node window: stop (:class:`IdentifierMatchedNothing`) when
        fewer than ``IMPORT_REPLACE_MIN_MATCH_FRACTION`` of the rows decided so far found an
        entity, in a graph of at least ``IMPORT_REPLACE_GUARD_MIN_LIVE``, rather than read the rest
        of the file and have the replace guard refuse it at the end. A replace of a view's scope is
        left to the guard: its scope isn't the graph."""
        if (self._reconcile_mode != "replace" or self._scope is not None
                or config.IMPORT_REPLACE_MIN_MATCH_FRACTION <= 0):
            return
        tally = (await self._position(job_id)).summary
        matched = sum(int(tally.get(k) or 0) for k in ("updated", "unchanged", "deleted"))
        decided = matched + int(tally.get("new") or 0) + int(tally.get("invalid") or 0)
        if not decided or matched >= config.IMPORT_REPLACE_MIN_MATCH_FRACTION * decided:
            return
        main_id = await self._svc.main_branch_id(graph_id)
        async with db.graphver_session() as s:
            live = await self._svc._main_live_count(s, graph_id, main_id)
        if live < config.IMPORT_REPLACE_GUARD_MIN_LIVE:
            return
        raise IdentifierMatchedNothing(
            f"Stopped after the file's first {decided:,} rows: by identifier={self._identifier}, "
            f"only {matched:,} of them found an entity, in a graph of {live:,}. The rest would very "
            "likely make the graph again, and the replace delete it. Check what the file's rows name "
            "their entities by: identifier=entity_id finds a row's entity id, then its urn, its "
            "identifier value or a field its type matches imports by; identifier=urn, its entity id "
            "or its urn. Nothing was deleted; the rows read so far are on the draft.")

    async def _guard_replace(self, job_id: str, snap, graph_id: str) -> None:
        """Before a replace deletes anything: count what it would delete and what it made, record the
        verdict on the job's summary (``replaceGuard``, :func:`replace_verdict`), and refuse
        (:class:`ReplaceBlocked`) past the guard's limits unless the job allows it. Nothing is
        deleted then, and the file's rows stay on the draft for review.

        A whole graph's replace is measured against main: what main holds, and what the draft holds
        beyond it — so a file imported again into the draft an earlier import made it in is judged
        on what the draft would publish, not only on what this run added. A view's, on what this
        run made."""
        keep = (await view_entities(snap, self._scope))["keep"] if self._scope else None
        live = absent = 0
        for kind in ("edge", "node"):
            async for page in _in_scope(snap, kind, keep):
                live += len(page)
                absent += len(await self._unmatched(job_id, page))
        pos = await self._position(job_id)
        made = int(pos.summary.get("new") or 0)
        if keep is None:
            main_id = await self._svc.main_branch_id(graph_id)
            async with db.graphver_session() as s:
                before = await self._svc._main_live_count(s, graph_id, main_id)
            creates = max(live - before, made)
        else:
            before, creates = max(live - made, 0), made
        verdict = replace_verdict(before, absent, creates, allowed=self._allow_mass_delete)
        async with db.graphver_session() as s:
            await self._lease.checkpoint(s, summary={**pos.summary, "replaceGuard": verdict})
        if verdict["state"] == "overridden":
            logger.warning("import job %s deletes %d of %d entities and made %d, past the replace "
                           "guard, as allowMassDelete asked", job_id, absent, verdict["live"], creates)
        if verdict["state"] != "blocked":
            return
        limits = verdict["limits"]
        raise ReplaceBlocked(
            f"Nothing was deleted: this replace would delete {absent:,} of the {verdict['live']:,} "
            f"entities in its scope, and its draft makes {creates:,} new ones: past the replace "
            "guard, which refuses one "
            f"that deletes at least {limits['deleteFraction']:.0%} of a scope of "
            f"{limits['minLive']:,} or more and creates at least {limits['createFraction']:.0%} as "
            "many. That is what a file whose rows name their entities by another key looks like: "
            f"check the import's identifier (identifier={self._identifier}). The file's rows are on "
            "the draft for review. To delete what it leaves out all the same, import it again with "
            "allowMassDelete=true.")

    def resolve(self, rows, lookups) -> Tuple[List[dict], List[dict]]:
        """:func:`resolve_rows` as this job resolves a batch: by its identifier, through its
        ontology's gate, a new node's id derived from its key in the graph's identity scope (else a
        urn:uuid minted, v7), a new edge's from its ends and type."""
        scope = self._id_scope
        return resolve_rows(
            rows, lookups, mint_id=new_entity_id, ontology=self._ontology,
            identity_prop=self._identity_prop, mint_urn=lambda _etype: new_entity_id(),
            derive_urn=lambda seed: pointer_id(scope, seed),
            derive_edge=lambda source, target, etype: edge_pointer_id(scope, source, target, etype),
            identifier=self._identifier,
            derive_key=(lambda value: key_pointer_id(scope, self._prop, value)) if self._prop else None)

    def _settle_identifier(self) -> None:
        """Once the data source's identifier property is known: ``prop.<it>`` is the urn, which that
        property holds; any other ``prop.<name>`` is matched through the property's index."""
        if self._identity_prop and self._identifier == f"prop.{self._identity_prop}":
            self._identifier = identifiers.URN
        self._prop = (self._identifier[len("prop."):] if self._identifier.startswith("prop.")
                      else None)

    async def _prop_state(self, graph_id: str, branch_id: str, *, build: bool,
                          job_id: Optional[str] = None) -> None:
        """For ``identifier=prop.<name>``: the property's index caught up to main's head — built
        first when no import named it (``build``) — and the values the draft itself holds."""
        if not self._prop:
            return
        if build:
            await matching.ensure(graph_id, self._prop, job_id=job_id)
        else:
            await matching.ensure_ready(graph_id, self._prop)
        self._prop_of, self._prop_holders = {}, {}
        for eid, value in (await matching.draft_values(graph_id, branch_id, self._prop)).items():
            self._note_prop(eid, value)

    def _note_prop(self, eid: str, value: Optional[str]) -> None:
        """The draft holds ``value`` of the matching property for node ``eid`` (None: none, or it
        is deleted there)."""
        old = self._prop_of.get(eid)
        if old is not None:
            self._prop_holders.get(old, set()).discard(eid)
        self._prop_of[eid] = value
        if value is not None:
            self._prop_holders.setdefault(value, set()).add(eid)

    async def _prop_hits(self, snap, values) -> Tuple[Dict[str, str], Dict[str, List[str]], Dict[str, str]]:
        """``(hits, dupes, restore)`` for values of the matching property: the one live node of the
        draft holding each, the values several hold, and the values only a deleted node held (that
        node). Main's index, for the nodes the draft hasn't changed and its view holds; the draft's
        own values for the rest."""
        values = {v for v in values if v}
        main = await matching.lookup(self._graph_id, self._prop, values)
        candidates = {e for v in values for e, live in main.get(v, ())
                      if live and e not in self._prop_of}
        visible = set(await snap.lookup_live("node", candidates)) if candidates else set()
        hits: Dict[str, str] = {}
        dupes: Dict[str, List[str]] = {}
        restore: Dict[str, str] = {}
        for v in values:
            holders = {e for e, live in main.get(v, ()) if live and e in visible}
            holders |= self._prop_holders.get(v, set())
            if len(holders) == 1:
                hits[v] = next(iter(holders))
            elif holders:
                dupes[v] = sorted(holders)
            else:
                gone = {e for e, live in main.get(v, ()) if not live and e not in self._prop_of}
                if len(gone) == 1:
                    restore[v] = next(iter(gone))
        return hits, dupes, restore

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
        self._settle_identifier()
        await self._prop_state(graph_id, branch_id, build=True, job_id=job_id)
        self._created_from, self._aliases = {}, {}
        # Only the rows that leave a link: a file id that is not the node's own, or an identifier
        # value beside a urn — never a whole row, which a large job has millions of.
        fid, urn = ImportRowORM.raw["entity_id"].astext, ImportRowORM.raw["urn"].astext
        value = ImportRowORM.raw["properties"][ident].astext if ident else null()
        links = or_(and_(fid != "", fid != ImportRowORM.matched_entity_id),
                    and_(urn.isnot(None), value.isnot(None)) if ident else false())
        async with db.graphver_session() as s:
            landed = (await s.execute(
                select(fid, urn, value, ImportRowORM.matched_entity_id)
                .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == "node",
                       ImportRowORM.resolved_op.in_(_LANDED), links,
                       ImportRowORM.matched_entity_id.is_not(None)))).all()   # not a delete of nothing
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
        self._settle_identifier()
        await self._prop_state(graph_id, branch_id, build=False)
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
            if self._prop and eid and res.get("resolved_op") in ("create", "update", "delete"):
                props = (by_index.get(res["_row_index"]) or {}).get("properties") or {}
                if res["resolved_op"] == "delete":
                    self._note_prop(eid, None)
                elif self._prop in props or res["resolved_op"] == "create":
                    self._note_prop(eid, key_value(props.get(self._prop)))
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
        async with db.graphver_session() as s:
            for chunk in _chunks(sorted(e for e in eids if e), _PERSIST_BATCH):
                out.update((await s.execute(
                    select(ImportRowORM.matched_entity_id, func.min(ImportRowORM.row_index))
                    .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == kind,
                           ImportRowORM.row_index < before,
                           ImportRowORM.matched_entity_id.in_(chunk),
                           ImportRowORM.resolved_op != "invalid")
                    .group_by(ImportRowORM.matched_entity_id))).all())
        return out

    async def _window(self, job_id: str, kind: str, after: int) -> List[Dict[str, Any]]:
        """The next ``IMPORT_COMMIT_WINDOW`` staged rows of ``kind`` after ``after``, in file order:
        those not resolved yet — a row an in-memory import decided as it staged it is not read
        again (the cursor's windows commit with their rows' resolutions, so every row after it is
        unresolved otherwise)."""
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM.row_index, ImportRowORM.raw)
                .where(ImportRowORM.job_id == job_id, ImportRowORM.kind == kind,
                       ImportRowORM.row_index > after, ImportRowORM.resolved_op.is_(None))
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
        nothing would take, which are taken and which a deleted node held. By a matching
        property, the nodes they name by its value instead (:meth:`_prop_node_lookups`)."""
        if self._prop:
            return await self._prop_node_lookups(snap, rows)
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
        # And a urn:uuid entity_id no live node holds, which a create may keep as its id.
        own_ids = {u for r in rows if (u := uuid_urn(r.get("entity_id"))) and u not in by_id}
        taken, restore = await self._svc.identities_taken(
            graph_id=self._graph_id, branch_id=self._branch_id,
            names=(wanted - set(urn_to_eid)) | own_ids)
        current, hash_of = await _heads(snap, "node", named)
        return {"urn_to_eid": urn_to_eid, "qname_to_eid": qname_to_eid, "node_eids": named,
                "current": current, "hash_of": hash_of,
                "bases": await _bases(snap, "node", rows, hash_of), "taken": taken, "restore": restore}

    async def _prop_node_lookups(self, snap, rows) -> Dict[str, Any]:
        """:meth:`_node_lookups` for ``identifier=prop.<name>``: the live nodes the rows name by
        entity_id or by the property's value, with their current payloads; and of the ids the rows
        that match nothing would take (derived from their values), those a live node holds."""
        values = {v for r in rows if (v := key_value((r.get("properties") or {}).get(self._prop)))}
        by_id = await snap.lookup_live("node", {r["entity_id"] for r in rows if r.get("entity_id")})
        hits, dupes, restore = await self._prop_hits(snap, values)
        named = set(by_id) | set(hits.values())
        named |= {self._created_from[f] for r in rows if (f := r.get("entity_id")) in self._created_from}
        derived = {key_pointer_id(self._id_scope, self._prop, v)
                   for v in values - set(hits) - set(dupes) - set(restore)}
        taken = set(await snap.lookup_live("node", derived)) if derived else set()
        current, hash_of = await _heads(snap, "node", named)
        return {"urn_to_eid": hits, "dupes": dupes, "restore": restore, "taken": taken,
                "qname_to_eid": {}, "node_eids": named, "current": current, "hash_of": hash_of,
                "bases": await _bases(snap, "node", rows, hash_of)}

    async def _prop_edge_lookups(self, snap, rows) -> Dict[str, Any]:
        """:meth:`_edge_lookups` for ``identifier=prop.<name>``: ends named by entity_id (an
        entity's, or the file's own id of a node the job made) or by ``source.<name>``."""
        ends = {}
        for end in ("source", "target"):
            by_id = await snap.lookup_live("node", {r[f"{end}_entity_id"] for r in rows
                                                    if r.get(f"{end}_entity_id")})
            hits, dupes, _restore = await self._prop_hits(snap, {
                key_value((r.get(f"{end}Keys") or {}).get(self._prop)) for r in rows})
            more = {self._created_from.get(r.get(f"{end}_entity_id") or "") for r in rows}
            ends[end] = (by_id, hits, dupes, {e for e in more if e})
        (src_ids, src_hits, src_dupes, src_more), (tgt_ids, tgt_hits, tgt_dupes, tgt_more) = (
            ends["source"], ends["target"])
        edge_to_eid = await snap.edges_between(set(src_ids) | set(src_hits.values()) | src_more,
                                               set(tgt_ids) | set(tgt_hits.values()) | tgt_more)
        own = {r["entity_id"] for r in rows if r.get("entity_id")}
        current, hash_of = await _heads(snap, "edge", set(edge_to_eid.values()) | own)
        return {"urn_to_eid": {**src_hits, **tgt_hits}, "dupes": {**src_dupes, **tgt_dupes},
                "qname_to_eid": {}, "node_eids": set(src_ids) | set(tgt_ids),
                "edge_to_eid": edge_to_eid, "edge_eids": own & set(hash_of), "current": current,
                "hash_of": hash_of, "bases": await _bases(snap, "edge", rows, hash_of)}

    async def _edge_lookups(self, snap, rows) -> Dict[str, Any]:
        """What ``resolve_rows`` needs for these edge rows: the live nodes their endpoints name (by
        entity_id, urn, or — an end without a urn — qualifiedName), the live edges between those
        nodes, and each such edge's current payload."""
        if self._prop:
            return await self._prop_edge_lookups(snap, rows)
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
        created = (ImportRowORM.job_id == job_id, ImportRowORM.resolved_op == "create")
        async with db.graphver_session() as s:
            nodes = (await s.execute(
                select(ImportRowORM.matched_entity_id, ImportRowORM.raw["urn"].astext,
                       ImportRowORM.raw["layerAssignment"], ImportRowORM.raw["entityType"].astext,
                       ImportRowORM.raw["displayName"].astext, ImportRowORM.raw["tags"],
                       ImportRowORM.raw["properties"])
                .where(*created, ImportRowORM.kind == "node").order_by(ImportRowORM.row_index))).all()
            # Each created node's projection key is the urn it was stored with — the file's urn
            # is only a pointer — read from the draft's versions, as the edges are below.
            stored: Dict[str, Optional[str]] = {}
            for chunk in _chunks([n[0] for n in nodes], _PERSIST_BATCH):
                stored.update((await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.urn)
                    .where(NodeVersionORM.graph_id == graph_id,
                           NodeVersionORM.branch_id == branch_id,
                           NodeVersionORM.entity_id.in_(chunk), NodeVersionORM.op == "create"))).all())
            edge_ids = (await s.execute(select(ImportRowORM.matched_entity_id)
                                        .where(*created, ImportRowORM.kind == "edge"))).scalars().all()
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
                "reasons": [json.dumps(r["reasons"]) if r["reasons"] else None for r in chunk],
                "codes": [r.get("code") for r in chunk]})


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
                       matched_entity_id=None if created else eid, code="write_refused")
    return [op for op in ops if op["entity_id"] not in reasons]


def _whole_row(job_id: str, kind: str, row: Dict[str, Any]) -> Dict[str, Any]:
    """A row staged whole, for its window to resolve: as the parse stages every row."""
    return {"job_id": job_id, "row_index": row["_row_index"], "kind": kind,
            "raw": {k: v for k, v in row.items() if k != "_row_index"}}


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
