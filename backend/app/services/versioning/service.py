"""Graph versioning write path — Postgres-first, the durable source of truth.

Implements the core flow (plan §3, §8, §11):

  create_graph → open_draft → stage_changes → checkpoint → publish (squash to main)

plus the read/audit helpers ``materialize_state``, ``entity_history`` and
``diff_commits``.  Everything writes the ``graphver`` store first; FalkorDB
projection (plan §5) is a separate worker that consumes committed state — it is
NOT on this path, so writes are durable regardless of projection lag.

Design choices honoured here:

* Append-only version tables; "latest" tracked via the :class:`EntityHeadORM`
  pointer (no ``is_head`` churn — plan §16.5 #4).
* A checkpoint folds the durable ``working_changes`` buffer into version rows,
  squash-deduping no-op edits via :mod:`changeset`.
* A draft has its own linear ``commit_seq``; publishing squashes the whole draft
  into one ``main`` commit carrying contributor attribution (plan §8).
* Concurrent advance of ``main`` is detected (OCC) and surfaced rather than
  silently mis-merged; field-level rebase reuses :mod:`merge` (wired next).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import (Any, Awaitable, Callable, Collection, Dict, Iterable, List, Mapping, NamedTuple,
                    Optional, Sequence, Set, Tuple)

from sqlalchemy import (TIMESTAMP, Boolean, Text, TextClause, any_, bindparam, cast, insert, select, func,
                        delete, null, literal, text, update, or_, tuple_, and_, case)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import aliased

from . import config, db, keymigrate
from .changeset import Delta, fold_batch_ops, materialize, net_delta, diff_states
from backend.common.property_patch import apply_patch, compose_patches, strip_deletes
from backend.common.service_accounts import is_service_account
from .entity_serde import edge_payload_from_parts
from .change_index import (ChangeIndex, ChangeIndexBuilder, ChangeOrigin, IndexCache, compact_entries,
                           entry_dict, stat_changes)
from .errors import (AccessDenied, AmbiguousSpelling, AmbiguousUrn, BranchNotOpen, ChangeListBusy,
                     ContentionExhausted, CrossesUpdate, CurationAtRisk, DraftNotReadable, DraftPruned,
                     EdgeEndsMissing, EntityExists, StagedChangesUnsaved, UniqueViolation,
                     DraftRoleRequired, ForkLimit, ForkNotRestorable, ForkNotUpToDate,
                     ForkUpdateConflicts, GraphMoved, GraphNotWritable,
                     GroupsUnavailable, HeadMoved, IneligibleMember, JobActive, LiveForks, LockBusy,
                     MainWriteForbidden, MassDeleteBlocked, NotAFork, NotAnEdge, NotDraftOwner,
                     PersonRequired, ProjectionAlreadyAdopted, ProjectionPassInFlight,
                     ProjectionKeyInUse, ProjectionKeyInvalid, ProjectionNotAdopted,
                     ResolutionsWithoutConflict, ReviewRequired, SelfMerge, SelfReview,
                     VersionConflict)
from .ids import derived_entity_id, new_entity_id, prefixed_id, uuid_urn
from .merge import three_way_merge
from .merkle import MerkleTree, content_hash
from .merkle_store import MerkleStore
from . import main_activity, provenance
from .provenance import commit_provenance
from .ontology import (
    Ontology, OntologyRules, canonicalize_payload_types,
    validate_entities, validate_entities_rich,
)
from .models import (
    BranchORM,
    BranchMemberORM,
    CommitORM,
    EdgeVersionORM,
    EntityHeadORM,
    ForkBaseORM,
    GraphORM,
    JobORM,
    MergeRequestORM,
    NodeVersionORM,
    ProjectionStateORM,
    WorkingChangeORM,
    _now,
)
from .import_export.runner import never_runs
from .purge_worker import PURGE_JOB_TYPE, MoveBlocked
# Strip reserved keys from incoming node `properties` so they don't pollute stored payloads (and
# flood the projector with reserved-key-drop warnings). The provider owns the canonical key set.
from backend.app.providers.falkordb_provider import _sanitize_node_properties
from backend.app.services.node_identity import ResolvedNodeIdentity, bind_node_writes

logger = logging.getLogger(__name__)

# Keys read out of a payload into denormalised, queryable version columns.
_NODE_DENORM = {
    "urn": "urn",
    "entityType": "entity_type",
    "displayName": "display_name",
    "qualifiedName": "qualified_name",
}


# content_hash of the empty/absent state — exactly what a tombstone (deleted) head row stores, and
# the pre-image a "create" logically reads (the entity was absent). Used by the head CAS below.
_HASH_NONE = content_hash(None)
# ...and of an empty payload, which diffs read as absent (no urn, no type: not a live entity).
_HASH_EMPTY = content_hash({})


class _Stored(NamedTuple):
    """An entity's stored value on a branch at a seq, without its payload (:meth:`_hashes_at`)."""
    kind: str                       # "node" | "edge"
    content_hash: str
    urn: Optional[str]              # nodes only
    type: Optional[str]             # a node's entityType, an edge's edgeType
    src: Optional[str] = None       # an edge's ends, from its version row
    tgt: Optional[str] = None
    name: Optional[str] = None      # a node's displayName and qualifiedName, from its version row
    qname: Optional[str] = None


class _Head(NamedTuple):
    """An entity a branch changed, without its payload (:meth:`_head_index`)."""
    kind: str
    version_id: str
    content_hash: str
    live: bool                      # not deleted, and not an empty or null payload
    urn: Optional[str]              # a node head's urn, from its version row
    type: Optional[str]             # a live head's entityType / edgeType, from its version row
    # The rest of what a version row says without its payload: a node's displayName and
    # qualifiedName; an edge's ends. The table it is in (``node_versions``) says ``table``.
    name: Optional[str] = None
    qname: Optional[str] = None
    src: Optional[str] = None
    tgt: Optional[str] = None
    table: Optional[str] = None


def _heads_of(heads, rows: Dict[str, tuple]) -> Dict[str, _Head]:
    """:meth:`GraphVersioningService._head_index`'s index from its heads and their version rows —
    pure CPU, run in a thread. A kind and a type repeat on every row: one string each, not one per
    head (a large draft holds hundreds of thousands)."""
    out: Dict[str, _Head] = {}
    for eid, kind, vid, chash, tomb in heads:
        table, urn, typ, name, qname, src, tgt = rows.get(vid) or (None,) * 7
        out[eid] = _Head(sys.intern(kind), vid, chash,
                         not tomb and chash not in (_HASH_EMPTY, _HASH_NONE), urn,
                         sys.intern(typ) if typ else typ, name, qname, src, tgt, table)
    return out


def _ends(values: Mapping[str, Any]) -> set:
    """The entity ids the edges among ``values`` (:class:`_Head` or :class:`_Stored`) run between."""
    return {x for v in values.values() if v.kind != "node" for x in (v.src, v.tgt) if x}


def _payload_ends(values: Mapping[str, Optional[dict]]) -> set:
    """The entity ids the edge payloads among ``values`` run between."""
    return {x for v in values.values() if v and _is_edge_payload(v) for x in _edge_src_tgt(v) if x}


def _end(urns: Mapping[str, str], eid: Optional[str]) -> str:
    """An edge end as a reader names it: its node's urn (:meth:`GraphVersioningService._current_urns`)."""
    return urns.get(eid, eid) if eid else ""


def _with_refs(entries: List[dict], names: Mapping[str, str]) -> List[dict]:
    """Each entry of a refusal that names an entity by id, with the name the batch sent it by
    (``ref``), so a client finds its own change in it."""
    for e in entries:
        if e.get("entity_id") in names:
            e["ref"] = names[e["entity_id"]]
    return entries


def _key_text(v: Any) -> Optional[str]:
    """A field value as a unique field compares it: a scalar's text, trimmed (``None``: no value).
    The import's ``key_value``, which this module can't import."""
    if v is None or isinstance(v, (dict, list)):
        return None
    s = str(v).strip()
    return s or None


def _refuse_bad_creates(ops: Sequence[Mapping]) -> None:
    """An edge create naming no source or no target is refused: stored, its payload reads as a
    node's (:func:`_is_edge_payload`) and every reader takes it for one."""
    missing = [o["entity_id"] for o in ops
               if o.get("op") == "create" and o.get("entity_kind") == "edge"
               and not all(_edge_src_tgt(o.get("payload") or {}))]
    if missing:
        raise EdgeEndsMissing(missing)


def _overlay_patch(heads: Dict[str, _Head], node_ids, edge_ids, base_nodes, held,
                   urns: Mapping[str, str], held_urns: Mapping[str, str]) -> tuple:
    """The draft's own part of :meth:`GraphVersioningService.branch_overlay_delta`, from hashes and
    version-row columns: ``(nodesUpsert, nodesModified, nodesRemove, edgesUpsert, edgesRemove,
    nodesNew)`` — pure CPU, run in a thread. ``held``: each of the draft's edges as its store holds
    it, main at its head, which a removal takes out and an edit counts against (``was``). Edge ends
    are named by urn: ``urns`` as the draft holds its ends, ``held_urns`` as main's head does."""
    nodes_upsert: List[dict] = []
    nodes_modified: List[dict] = []    # {urn, entityId}: the reader loads the payload it serves
    nodes_remove: List[dict] = []
    edges_upsert: List[dict] = []
    edges_remove: List[dict] = []
    nodes_new: List[str] = []          # urns the draft CREATED (absent in main@base) vs merely modified
    # A degenerate empty payload ({}) is not a live entity (no urn/entityType/endpoints) — it reads
    # as absent (``_Head.live``, ``_hashes_at``), so as a deletion, never as a node that fails
    # GraphNode validation downstream (the reported 500) or shows as an empty diff row.
    for eid in node_ids:
        h, b = heads[eid], base_nodes.get(eid)
        if not h.live:
            if b is not None:                          # removed on the draft
                nodes_remove.append({"entityId": eid, "urn": b.urn or f"gv:{eid}"})
        elif b is None:                                # created in the draft — not present in main
            urn = h.urn or f"gv:{eid}"                 # a skeleton; loaded when a read serves it
            nodes_upsert.append({"urn": urn, "entityId": eid, "entityType": h.type or "unknown",
                                 "displayName": h.name or "", "qualifiedName": h.qname, "lazy": True})
            nodes_new.append(urn)
        else:                                          # modified → loaded when a read serves it
            nodes_modified.append({"entityId": eid, "urn": h.urn or b.urn or f"gv:{eid}"})
    for eid in edge_ids:
        h, b = heads[eid], held.get(eid)
        if not h.live and b is None:
            continue
        # A version row holds an edge's ends as entity ids; a reader matches them by urn, and an
        # imported node's id is not its urn.
        if not h.live:                                 # removed on the draft → its type and ends
            edges_remove.append({"id": eid, "sourceUrn": _end(held_urns, b.src),
                                 "targetUrn": _end(held_urns, b.tgt), "edgeType": b.type or "unknown"})
        else:                                          # added/modified → loaded when a read serves it
            edges_upsert.append({"id": eid, "sourceUrn": _end(urns, h.src),
                                 "targetUrn": _end(urns, h.tgt), "edgeType": h.type or "unknown",
                                 "lazy": True, **_was(b, held_urns)})
    return nodes_upsert, nodes_modified, nodes_remove, edges_upsert, edges_remove, nodes_new


def _was(held: Optional[_Stored], urns: Mapping[str, str]) -> dict:
    """An overlay edge's ``was``: where the base holds it (its ends, by urn, and type), so a reader
    serves the overlay's value and counts the edge where it runs — once, never on top of the base's
    count. Nothing for an edge the base does not hold."""
    if held is None:
        return {}
    return {"was": {"sourceUrn": _end(urns, held.src), "targetUrn": _end(urns, held.tgt),
                    "edgeType": held.type or "unknown"}}


#: The lists of a reader-shaped patch set (:meth:`GraphVersioningService.branch_overlay_delta`),
#: and what each entry is keyed by.
_PATCH_KEYS = (("nodesUpsert", "entityId"), ("nodesModified", "entityId"),
               ("nodesRemove", "entityId"), ("edgesUpsert", "id"), ("edgesRemove", "id"))


def _fork_patch(ids, ours: Dict[str, _Stored], theirs: Dict[str, _Stored],
                our_urns: Mapping[str, str], their_urns: Mapping[str, str]) -> Dict[str, list]:
    """A fork's ``main`` against its root's store, for ``ids``: ``ours`` the fork's live value of
    each at its head, ``theirs`` the root's at the root's head (absent: not live there) — as
    :func:`_overlay_patch` gives a draft's, from hashes and version-row columns. Only the fork has
    it: created (a skeleton); only the root: removed; both, as different values: modified; equal:
    nothing. Edge ends by urn, as each side names them. Pure CPU, run in a thread."""
    out: Dict[str, list] = {key: [] for key, _k in _PATCH_KEYS}
    out["nodesNew"] = []
    for eid in ids:
        f, r = ours.get(eid), theirs.get(eid)
        if f is None and r is None:
            continue
        if f is not None and r is not None and f.content_hash == r.content_hash:
            continue
        if (f or r).kind == "node":
            if r is None:
                urn = f.urn or f"gv:{eid}"
                out["nodesUpsert"].append({"urn": urn, "entityId": eid,
                                           "entityType": f.type or "unknown",
                                           "displayName": f.name or "", "qualifiedName": f.qname,
                                           "lazy": True})
                out["nodesNew"].append(urn)
            elif f is None:
                out["nodesRemove"].append({"entityId": eid, "urn": r.urn or f"gv:{eid}"})
            else:
                out["nodesModified"].append({"entityId": eid, "urn": f.urn or r.urn or f"gv:{eid}"})
        elif f is None:
            out["edgesRemove"].append({"id": eid, "sourceUrn": _end(their_urns, r.src),
                                       "targetUrn": _end(their_urns, r.tgt),
                                       "edgeType": r.type or "unknown"})
        else:
            out["edgesUpsert"].append({"id": eid, "sourceUrn": _end(our_urns, f.src),
                                       "targetUrn": _end(our_urns, f.tgt),
                                       "edgeType": f.type or "unknown", "lazy": True,
                                       **_was(r, their_urns)})
    return out


def _extended_patch(prev: Mapping[str, list], window: Mapping[str, list], ids: set) -> Dict[str, list]:
    """``prev``, a fork's patch set, with what it said of ``ids`` replaced by ``window``'s — the
    entities the root changed since ``prev`` was built, classified again. Pure CPU."""
    out: Dict[str, list] = {key: [x for x in prev[key] if x[k] not in ids] + window[key]
                            for key, k in _PATCH_KEYS}
    gone = {n["urn"] for n in prev["nodesUpsert"] if n["entityId"] in ids}
    out["nodesNew"] = [u for u in prev["nodesNew"] if u not in gone] + window["nodesNew"]
    return out


class _SquashRow(NamedTuple):
    """One entity's change in a narrow squash (:func:`_plan_squash`), told without its payload."""
    entity_id: str
    kind: str                           # the version table it is written to
    op: str                             # create | update | delete
    version_id: Optional[str]           # the draft's version a create/update copies
    prev_content_hash: Optional[str]
    content_hash: str
# Entity heads written per statement. Each column goes as one array parameter (unnest), so the
# statements' text never changes: compiled and prepared once, whatever the batch.
_HEAD_BATCH = 5000


def _head_arrays():
    return [bindparam(name, type_=ARRAY(Boolean if name == "tombs" else Text))
            for name in ("eids", "vids", "hashes", "tombs", "kinds")]


_INSERT_HEADS = (
    f"INSERT INTO {EntityHeadORM.__table__.fullname} (graph_id, branch_id, entity_id, entity_kind, "
    "head_version_id, content_hash, is_tombstone, updated_at) "
    "SELECT :graph_id, :branch_id, v.entity_id, v.kind, v.vid, v.hash, v.tomb, :now "
    "FROM unnest(:eids, :vids, :hashes, :tombs, :kinds) AS v(entity_id, vid, hash, tomb, kind) "
    "ON CONFLICT (graph_id, branch_id, entity_id) ")
# Point every head at its new version, whatever it was.
_UPSERT_HEADS = text(
    _INSERT_HEADS + "DO UPDATE SET head_version_id = EXCLUDED.head_version_id, "
    "content_hash = EXCLUDED.content_hash, is_tombstone = EXCLUDED.is_tombstone, "
    "entity_kind = EXCLUDED.entity_kind, updated_at = EXCLUDED.updated_at").bindparams(*_head_arrays())
# Add the heads of entities that have none on the branch yet; returns the ones added.
_ADD_HEADS = text(_INSERT_HEADS + "DO NOTHING RETURNING entity_id").bindparams(*_head_arrays())
# Advance the heads still at their pre-image (the CAS); returns the ones advanced. A head whose
# payload is {} reads as absent, so the pre-image of "absent" (:absent) matches it too.
_ADVANCE_HEADS = text(
    f"UPDATE {EntityHeadORM.__table__.fullname} AS h SET head_version_id = v.vid, "
    "content_hash = v.hash, is_tombstone = v.tomb, entity_kind = v.kind, updated_at = :now "
    "FROM unnest(:eids, :vids, :hashes, :tombs, :kinds, :pres) AS v(entity_id, vid, hash, tomb, kind, pre) "
    "WHERE h.graph_id = :graph_id AND h.branch_id = :branch_id AND h.entity_id = v.entity_id "
    "AND (h.content_hash = v.pre OR (v.pre = :absent AND h.content_hash = :empty)) "
    "RETURNING h.entity_id",
).bindparams(*_head_arrays(), bindparam("pres", type_=ARRAY(Text)))


def _live_heads_sql(model, kind: str, join: str = "") -> str:
    """``FROM … WHERE`` of a branch's live head versions of one kind: its head pointers joined to
    the version rows they name (and to ``join``), the tombstones left out."""
    return (f"FROM {EntityHeadORM.__table__.fullname} AS h JOIN {model.__table__.fullname} AS v "
            f"ON v.graph_id = :graph_id AND v.id = h.head_version_id {join}"
            f"WHERE h.graph_id = :graph_id AND h.branch_id = :branch_id AND h.entity_kind = '{kind}' "
            "AND NOT h.is_tombstone ")


# What a schema panel counts on a branch, in Postgres (:meth:`GraphVersioningService.schema_counts`).
_NODE_TYPE = "coalesce(v.entity_type, v.payload->>'entityType')"
_COUNT_NODE_TYPES = text(f"SELECT {_NODE_TYPE}, count(*) {_live_heads_sql(NodeVersionORM, 'node')}"
                         "GROUP BY 1")
_COUNT_EDGE_TYPES = text("SELECT coalesce(v.edge_type, v.payload->>'edgeType'), count(*) "
                         f"{_live_heads_sql(EdgeVersionORM, 'edge')}GROUP BY 1")
_NAMES_BY_ID = text(f"SELECT {_NODE_TYPE}, coalesce(v.display_name, v.payload->>'displayName') "
                    f"{_live_heads_sql(NodeVersionORM, 'node')}ORDER BY h.entity_id LIMIT :rows")
_TAGS_OF_V = ("CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.payload->'tags') "
              "= 'array' THEN v.payload->'tags' ELSE '[]'::jsonb END) AS t(tag) ")
_COUNT_TAGS = text(f"SELECT t.tag, count(*) {_live_heads_sql(NodeVersionORM, 'node', _TAGS_OF_V)}"
                   "AND t.tag <> '' GROUP BY 1")


def _copy_versions_sql(model, columns: str) -> "TextClause":
    """``INSERT … SELECT``: version rows of ``model`` written onto a branch as copies of the rows
    ``:src`` names in graph ``:src_graph`` — their payloads, identity ``columns`` and content hashes
    taken in Postgres, never read out — under the new ids ``:ids`` with ``:ops`` and ``:prevs`` (the
    narrow squash; a fork's merge copies from the fork). Each copy keeps its row's own ``actor`` —
    who made that change, not who published it (the commit names the publisher); ``:actor`` only
    for a row that names nobody."""
    table = model.__table__.fullname
    return text(
        f"INSERT INTO {table} (graph_id, id, entity_id, commit_id, commit_seq, branch_id, op, "
        f"content_hash, prev_content_hash, payload, actor, change_reason, created_at, {columns}) "
        "SELECT :graph_id, v.id, s.entity_id, :commit_id, :commit_seq, :branch_id, v.op, "
        f"s.content_hash, v.prev, s.payload, COALESCE(s.actor, :actor), NULL, :now, "
        f"{', '.join('s.' + c.strip() for c in columns.split(','))} "
        "FROM unnest(:src, :ids, :ops, :prevs) AS v(src, id, op, prev) "
        f"JOIN {table} AS s ON s.graph_id = :src_graph AND s.id = v.src",
    ).bindparams(*(bindparam(name, type_=ARRAY(Text)) for name in ("src", "ids", "ops", "prevs")))


_COPY_NODE_VERSIONS = _copy_versions_sql(NodeVersionORM, "urn, entity_type, display_name, qualified_name")
_COPY_EDGE_VERSIONS = _copy_versions_sql(
    EdgeVersionORM, "source_entity_id, target_entity_id, edge_type, confidence, discriminator")
# SET LOCAL lock_timeout with a bound value (set_config's third argument, is_local).
_SET_LOCK_TIMEOUT = text("SELECT set_config('lock_timeout', :ms, true)")
# SET LOCAL plan_cache_mode, the same way.
_PLAN_CACHE_MODE = text("SELECT set_config('plan_cache_mode', :mode, true)")


class _StaleHead(Exception):
    """Internal retry signal: a per-entity head compare-and-swap missed — the entity's head moved
    between this commit's state read and its write (a concurrent same-branch writer won the race, or
    a concurrent create beat us). Caught by ``_retry_seq``, which re-runs the whole commit against
    fresh state (auto-rebase; a genuine same-field clash then surfaces as ``MergeConflict``). This is
    what makes same-branch concurrent writes lose-free without a coarse per-graph lock."""


class ConcurrencyError(RuntimeError):
    """Raised when a publish would violate referential integrity (e.g. a
    surviving edge points at a node the merge tombstoned). A stale base is *not*
    an error — it is auto-rebased; only genuine conflicts block a publish."""


class MergeConflict(RuntimeError):
    """Raised when a 3-way rebase/merge has unresolved field-level conflicts.

    ``.conflicts`` is a JSON-able list of ``{entity_id, path, base, ours, theirs,
    kind}`` for the UI to resolve; resubmit ``publish(..., resolutions=...)`` with
    the chosen payloads to land the merge.
    """

    def __init__(self, conflicts, current: Optional[Mapping[str, Tuple[str, Optional[dict]]]] = None):
        super().__init__(f"{len(conflicts)} unresolved merge conflict(s)")
        self.conflicts = conflicts
        #: entity_id → (kind, the value the edit conflicts WITH) — what a client rebases onto.
        #: Filled by ``apply_ops``'s optimistic-concurrency check; empty for a merge/publish.
        self.current = dict(current or {})


@dataclass
class ApplyResult:
    """What one ``apply_ops`` batch wrote."""

    commit_id: Optional[str]
    #: entity_id → (kind, the value after this batch — ``None`` once deleted) for every entity the
    #: batch addressed or cascaded, changed or not: what a client refreshes its copies (and their
    #: optimistic-concurrency tokens) from, so the next edit of the same entity is not a conflict
    #: with its own last save.
    written: Dict[str, Tuple[str, Optional[dict]]]
    #: node entity_id → urn for every node the batch read or wrote (edge endpoints included).
    urns: Dict[str, str] = field(default_factory=dict)
    #: entity_id → the name the batch called it by, for each op a urn was resolved for
    #: (``from_client``): what the caller answers and refers to it as.
    names: Dict[str, str] = field(default_factory=dict)


class OntologyViolation(RuntimeError):
    """Raised when ops/commit entities violate a graph's ontology under ``strict``
    enforcement. ``.violations`` is a JSON-able ``[{entity_id, kind, reason}]``."""

    def __init__(self, violations):
        super().__init__(f"{len(violations)} ontology violation(s)")
        self.violations = violations


class ApprovalRequired(RuntimeError):
    """A PR's required reviewers haven't all approved yet — merge is blocked. ``stale`` are those
    of them whose approval was of an earlier version of the PR."""

    def __init__(self, pr_id: str, pending, stale=()):
        super().__init__(f"pr {pr_id} needs approval from {pending}")
        self.pr_id = pr_id
        self.pending = list(pending)
        self.stale = list(stale)


# Peak bytes of RSS `sync_ingest` costs per entity, MEASURED — not guessed. A 478,430-entity
# resync peaked at 2,095 MiB over a 65 MiB baseline: 2,030 MiB / 478,430 = 4.45 KiB/entity,
# rounded up. It is the price of holding ~6 whole-graph structures at once (the snapshot, base,
# ours, theirs, merged, plus the urn/edge match indexes). Used only to tell the operator the
# truth in the refusal message, and to size the default limit.
_SYNC_BYTES_PER_ENTITY = 4_600

# A node's fields a read of a FalkorDB graph hands back filled in when the node has none: the
# projector writes each so (`projection._node_item`), and the reader's model defaults some. Empty
# like this, a field the node's history doesn't hold is not a change (_as_history_holds).
_FILLED_IN = {"displayName": "", "qualifiedName": "", "description": "", "tags": [],
              "layerAssignment": "", "childCount": 0, "sourceSystem": "", "lastSyncedAt": "",
              "properties": {}}


def _same_type(held: Optional[str], read: Optional[str]) -> bool:
    """One type in two casings: types are matched without case (``canonicalize_payload_types``)."""
    return bool(held and read) and str(held).upper() == str(read).upper()


class GraphTooLargeToSync(RuntimeError):
    """A re-sync of this graph would not fit in memory, so we refuse it instead of dying.

    ``sync_ingest`` reconstructs the ENTIRE graph several times over to do its 3-way merge —
    the external snapshot, the state at the last sync, the state at head, the merged result,
    and the indexes used to match them. Measured on a 478,430-entity graph: **2.03 GB of RAM
    to compute 808 changes**, in one HTTP request, on the web tier. That is ~4.5 KiB per
    entity, and it scales linearly: the 7.7M-entity model would ask for roughly 30 GB and
    take the API process down with it.

    This is a real limitation, not a policy: above the threshold the operation does not work.
    Refusing with an honest number is strictly better than an OOM, because an OOM kills every
    other request in flight too, and tells nobody why.

    The fix is designed (stream the snapshot, discard by content hash, merge only the touched
    set, run it on the worker rather than the web tier) — see
    ``docs/versioning/11-resync-at-any-scale.md``. When it lands, this guard goes.
    """

    def __init__(self, entities: int, limit: int):
        gb = entities * _SYNC_BYTES_PER_ENTITY / 1_073_741_824
        super().__init__(
            f"this data source has {entities:,} items, and re-syncing currently loads the "
            f"whole graph into memory — about {gb:.1f} GB for this one, which would take the "
            f"service down. Re-sync is limited to {limit:,} items until the streaming "
            f"re-sync ships."
        )
        self.entities = entities
        self.limit = limit
        self.estimated_bytes = int(entities * _SYNC_BYTES_PER_ENTITY)


class DiffTooLarge(RuntimeError):
    """A draft changes more entities than its Changes tree lays out (``DIFF_TREE_MAX_CHANGES``):
    its summary is counts only, and the tree has no children to page through."""

    def __init__(self, changed: int, limit: int):
        super().__init__(f"this draft changes {changed} entities; the tree lists up to {limit}")
        self.changed = changed
        self.limit = limit


#: Why a draft behind ``main`` must pull before it lands (``NotUpToDate.reason``, doc 19 §3.5).
PULL_PEOPLE = "people"      # a person changed main since the draft's base
PULL_OVERLAP = "overlap"    # automation changed an entity the draft changes, or an edge's end
PULL_SIZE = "size"          # too large a draft to merge onto a moved main: pull, then publish


class NotUpToDate(RuntimeError):
    """A draft is behind ``main`` and must pull the latest changes (rebase) before it can be
    merged — the 'require up to date before merging' gate. ``.behind_by`` is how many commits it
    lags so the UI can prompt a one-click 'Pull latest'; ``.reason`` why it must
    (``PULL_PEOPLE``, ``PULL_OVERLAP`` or ``PULL_SIZE``: :meth:`GraphVersioningService._pull_needed`)."""

    def __init__(self, branch_id: str, base_seq: int, head_seq: int, *, reason: str = PULL_PEOPLE):
        why = {PULL_OVERLAP: "automation changed what it changes since",
               PULL_SIZE: "it is too large to merge onto a moved main"}.get(reason, "")
        super().__init__(
            f"draft {branch_id} is out of date (base {base_seq} < main {head_seq})"
            + (f": {why}" if why else "") + "; pull the latest changes before merging")
        self.branch_id = branch_id
        self.base_seq = base_seq
        self.head_seq = head_seq
        self.behind_by = head_seq - base_seq
        self.reason = reason


class PullRequestExists(RuntimeError):
    """A branch already has a live (non-terminal) pull request, and a branch may have at most one.

    This is not an arbitrary restriction — it falls out of what a PR *is* here. A PR points at a
    source *branch* and its diff is computed live from that branch at read time, never snapshotted.
    So commits pushed after the PR was raised are **already** part of it, and a second PR from the
    same branch would be a duplicate of the first, not a new proposal. Merging either one marks the
    branch ``merged``, at which point the sibling is unmergeable (it fails ``_require_open``) — a
    dead row the UI still renders as actionable.

    ``.pr_id`` lets the caller route the user to the review that already exists instead of dead-ending
    on an error."""

    def __init__(self, pr_id: str, branch_id: str, title: Optional[str] = None):
        super().__init__(
            f"branch {branch_id} already has an open pull request ({pr_id}); "
            f"its new commits are already included in that review")
        self.pr_id = pr_id
        self.branch_id = branch_id
        self.title = title


#: editor and maintainer may edit; only maintainer (and the owner) may manage/publish.
ROLE_RANK = {"viewer": 1, "editor": 2, "maintainer": 3}

# Terminal PR statuses — a merged or closed PR no longer "needs attention", so it is excluded
# from the active-PR scope the view indicator counts (the rest: open/mergeable/approved/conflicts).
# It is also the definition of "live" for the one-live-PR-per-branch invariant (PullRequestExists,
# uq_mr_live_source_branch): a PR is live until it is merged or closed.
_TERMINAL_PR_STATUS = ("merged", "closed")
#: A draft's own rows, table by table — its heads first, so a draft whose removal is cut off reads as
#: ``main`` from the start — each with the columns of the index that finds a branch's rows, which
#: its windows are ordered by so each window is an index scan (``purge_worker.delete_window``).
_DRAFT_ROWS: Tuple[Tuple[str, str], ...] = (
    ("entity_heads", "graph_id, branch_id, entity_id"),
    ("working_changes", "graph_id, branch_id, seq"),
    ("merkle_nodes", "graph_id, branch_id, path, commit_seq"),
    ("edge_versions", "graph_id, branch_id, commit_seq"),
    ("node_versions", "graph_id, branch_id, commit_seq"),
)

# Commit kinds a machine writes; every other kind on main is a person's work. The same split
# lifecycle.py uses. The sync curation guard reads it (see _human_commit_in_sync_base).
_MACHINE_COMMIT_KINDS = ("genesis", "import", "sync")

# How many of others' newest commits a freshness poll reads for "saved since": a client that sends an
# old head costs no more than one that keeps up (branch_freshness).
_SAVED_SINCE_SCAN = 200

# The biggest draft a freshness poll reads in full to say whether automation that moved main touched
# what it changes (branch_freshness). Past it, publishing says so (``reason: overlap``).
_FRESHNESS_OVERLAP_MAX = 10_000

# What a live fork in a fork list says of how far it is from its parent (_fork_distance).
_FORK_DISTANCE = ("ahead", "behind", "update_recommended", "reads_from", "counts_capped")

# A fork's candidate count (_fork_candidates) per version of the fork and ceiling, as each engine a
# request builds for a fork asks for it (fork_reads_from): at 145,000 candidates it costs 70 ms.
_FORK_COUNTS: "OrderedDict[tuple, int]" = OrderedDict()
_FORK_COUNTS_KEPT = 4096

# An "enable version control" job in one of these states means its graph isn't a graph yet: the
# head is parked at genesis and the import is half-written. A failed job counts — it must be
# resumed or cancelled, never written around (bootstrap_unfinished, main_heads).
_UNFINISHED_ENABLEMENT = ("pending", "running", "failed")

# The "nothing came in" answer for a pull that was already up to date (see _incoming_from_main).
# Same shape as a real one, so a client never has to special-case the no-op.
_EMPTY_INCOMING: Dict[str, object] = {
    "branch_id": None, "commit_ids": [], "commit_count": 0, "contributors": [],
    "stats": {"create": 0, "update": 0, "delete": 0}, "from_seq": 0, "to_seq": 0,
}


def serves_head(projected: int, committed: int, status: Optional[str]) -> bool:
    """Whether a projection serves reads of main at its head: it holds the head and no load of it is
    under way — a loaded key serves once its summaries are built too. Whatever the Graph residency
    switch says: only residency writes ``rehydrating``, and its load is finished either way."""
    return projected >= committed and status != "rehydrating"


def residency_state_of(status: str, projected: int, key: Optional[str],
                       graph_id: str) -> Optional[str]:
    """Whether a graph's key is in FalkorDB, as residency shows it (doc 17): ``evicted``,
    ``rehydrating`` (being loaded) or ``waiting_capacity`` as its status says; None with no key
    (unpinned); ``rehydrating`` too while its key is written from nothing (a move's, an Adopt's,
    a first seed: watermark 0); else ``resident``."""
    if status in ("evicted", "rehydrating", "waiting_capacity"):
        return status
    if key in (None, f"gv_{graph_id}"):
        return None
    return "rehydrating" if projected == 0 else "resident"


def bootstrap_unfinished(graph_id) -> tuple:
    """The ``jobs`` rows that say a graph's "enable version control" job has not COMPLETED
    (:meth:`GraphVersioningService._assert_not_bootstrapping`). ``graph_id`` is an id or a
    column, so the same test correlates into a query over many graphs."""
    return (JobORM.job_type == "bootstrap", JobORM.graph_id == graph_id,
            JobORM.status.in_(_UNFINISHED_ENABLEMENT))


async def fork_base_at(s, fork: GraphORM, seq: int) -> int:
    """The seq of its parent's ``main`` a fork's ``main`` reads at ``seq``: the ``parent_seq`` of
    the latest base it took at or before ``seq`` (``fork_bases``), or ``seq`` itself before the
    first — a fork shares its parent's history up to its fork point. A fork with no base row (one
    forked before the table, not yet given its row) reads at its fork point, as it always did."""
    latest = (select(ForkBaseORM.parent_seq)
              .where(ForkBaseORM.fork_graph_id == fork.id, ForkBaseORM.fork_seq <= seq)
              .order_by(ForkBaseORM.fork_seq.desc()).limit(1).scalar_subquery())
    based = select(ForkBaseORM.fork_seq).where(ForkBaseORM.fork_graph_id == fork.id).exists()
    parent_seq, has_base = (await s.execute(select(latest, based))).one()
    if parent_seq is not None:
        return parent_seq
    if has_base:
        return seq
    if fork.fork_base_commit_seq is None:
        logger.warning("fork %s has no fork_base_commit_seq; reading its parent at genesis (0)",
                       fork.id)
    return min(seq, fork.fork_base_commit_seq or 0)


@dataclass(frozen=True)
class Viewer:
    """Who is asking — used to scope draft/PR reads. ``can_manage`` is workspace
    ``datasource:manage``; ``can_read`` is ``datasource:read``, which opens public drafts. Managing
    opens no private draft: those are read by their owner, their members and their review's people
    only. Supplied only from the HTTP layer; when a read is called without a Viewer (internal
    callers / tests) no scoping is applied. ``groups``: the actor's teams, when the caller already
    has them; used as given. Left empty, as every route leaves it (``viewer_ctx`` reads no teams),
    the service looks them up itself (:func:`_load_actor_groups`, which leaves a deleted team out),
    only when a team's row could decide. A public draft's reads never need them, and a service
    account's lookup costs no query."""
    actor: str
    can_manage: bool = False
    groups: Tuple[str, ...] = ()
    can_read: bool = False


async def _load_actor_groups(actor: str) -> Tuple[str, ...]:
    """The live group ids *actor* belongs to, from the management DB (READONLY pool, so it never waits
    on a second WEB-pool connection while the request holds one). A deleted group keeps its member
    rows and the drafts' rows for it, so it is left out here. A failed lookup is
    :class:`GroupsUnavailable`, never "no groups": that would refuse a member. A service account
    is in no team: ``()``, with no query."""
    if is_service_account(actor):
        return ()
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import GroupMemberORM, GroupORM
    try:
        async with get_readonly_session() as ms:
            return tuple((await ms.execute(
                select(GroupMemberORM.group_id).join(GroupORM, GroupORM.id == GroupMemberORM.group_id)
                .where(GroupMemberORM.user_id == actor, GroupORM.deleted_at.is_(None))
            )).scalars().all())
    except Exception as exc:
        raise GroupsUnavailable() from exc


class GraphVersioningService:
    """Service over the ``graphver`` store.  Each public method is one
    transaction (via :func:`db.graphver_session`) unless a session is passed."""

    def __init__(self, session_factory=db.graphver_session):
        self._session = session_factory
        self._merkle = MerkleStore()

    @contextlib.asynccontextmanager
    async def _session_scope(self, session=None):
        """Run within a caller-provided session (the caller owns commit/rollback, so
        several service calls compose into ONE atomic transaction) or, when none is
        given, open a fresh self-committing one. Lets the bootstrap create the graph
        and seed it in a single all-or-nothing transaction."""
        if session is not None:
            yield session
        else:
            async with self._session() as s:
                yield s

    # ------------------------------------------------------------------ #
    # Graph + branch lifecycle                                            #
    # ------------------------------------------------------------------ #
    async def create_graph(
        self,
        *,
        data_source_id: str,
        workspace_id: str,
        kind: str = "manual",
        # True ONLY when the versioning layer itself mints the FalkorDB graph (blank models,
        # forks). False when we are PINNED to a graph that already existed — the customer's.
        # Defaults to False on purpose: see the note at the ProjectionStateORM below.
        owns_falkor_graph: bool = False,
        actor: Optional[str] = None,
        base_ontology_id: Optional[str] = None,
        tenant_id: Optional[str] = None,
        falkor_graph_name: Optional[str] = None,
        falkor_provider: Optional[str] = None,
        provider_aliases: Sequence[str] = (),
        ontology_spec: Optional[Mapping] = None,
        ontology_enforcement: Optional[str] = None,
        session=None,
    ) -> Dict[str, str]:
        """Create a blank versioned graph: graph row + ``main`` branch + empty
        genesis commit + projection state, in the residency class the policy gives a new graph
        (``residency_policy.default_class``).  Returns ids and the genesis seq.

        ``provider_aliases``: the providers on ``falkor_provider``'s server, through any of which
        another graph may already hold ``falkor_graph_name`` (:meth:`_claim_projection_key`).

        Pass ``session`` to compose with a following ingest in one transaction (the
        atomic bootstrap), so a seed failure also rolls back the graph creation."""
        async with self._session_scope(session) as s:
            if falkor_graph_name:
                await self._claim_projection_key(s, falkor_graph_name, falkor_provider,
                                                 provider_aliases=provider_aliases,
                                                 data_source_id=data_source_id)
            graph = GraphORM(
                data_source_id=data_source_id,
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                kind=kind,
                base_ontology_id=base_ontology_id,
                ontology_spec=dict(ontology_spec) if ontology_spec else None,
                created_by=actor,
                main_head_commit_seq=1,
                **({"ontology_enforcement": ontology_enforcement} if ontology_enforcement else {}),
            )
            s.add(graph)
            await s.flush()

            main = BranchORM(
                graph_id=graph.id, kind="main", name="main", visibility="public", created_by=actor
            )
            s.add(main)
            await s.flush()

            genesis = CommitORM(
                graph_id=graph.id,
                branch_id=main.id,
                commit_seq=1,
                kind="genesis",
                message="genesis",
                actor=actor, **commit_provenance(actor),
                merkle_root=MerkleTree.build({}).root,
                stats={"nodes": 0, "edges": 0},
            )
            s.add(genesis)
            await s.flush()                      # materialise genesis.id before linking
            main.head_commit_id = genesis.id
            # A key we did not mint holds data the log does not: a genesis-only graph must never
            # full-seed into it, so it starts parked and its first projection is the first
            # commit's window.
            parked = bool(falkor_graph_name) and not owns_falkor_graph
            from .residency_policy import default_class, enabled
            s.add(
                ProjectionStateORM(
                    graph_id=graph.id, projected_commit_seq=1 if parked else 0, target_commit_seq=1,
                    # The policy's class for a new graph; with residency off, no policy is read.
                    residency=await default_class() if await enabled() else "standard",
                    falkor_graph_name=falkor_graph_name,   # the data source's real graph
                    falkor_provider=falkor_provider,       # FalkorDB instance (per-provider eviction)
                    # THE GUARDRAIL, recorded at birth from a fact we actually know: we own the
                    # FalkorDB graph IFF WE GENERATED ITS NAME. A bootstrap pins us to the
                    # customer's real graph (`nexus_lineage`) — that is theirs, it predates us, it
                    # may be shared, and a purge must never touch it. Default FALSE: a graph we
                    # cannot PROVE we created is a graph we will not delete.
                    owns_falkor_graph=bool(owns_falkor_graph),
                )
            )
            return {"graph_id": graph.id, "main_branch_id": main.id, "genesis_commit_id": genesis.id}

    async def enable_versioning(
        self, *, data_source_id: str, workspace_id: str, actor: str,
        provider=None, falkor_graph_name: Optional[str] = None,
        kind: str = "manual", batch: int = 2000, ontology_rules=None,
    ) -> Dict[str, object]:
        """Turn on versioning for a data source that may ALREADY hold data in its provider
        (e.g. a FalkorDB-only graph). The supported, explicit enablement entry point.

        * **Idempotent** on the data source: if a versioned graph already exists, returns
          it untouched (``already_enabled=True``) — never re-imports.
        * **Complete + atomic**: snapshots the provider's FULL current state (paged
          OUTSIDE the transaction, since paging is slow) and writes create-graph +
          ``import`` commit in ONE transaction, so a provider-read failure leaves NO
          half-enabled graph hijacking reads. Pass ``provider`` to import its rows; omit
          it to enable an empty graph.
        * After this, the projector makes FalkorDB a derived view of committed ``main``
          (``falkor_graph_name`` pins it to the data source's real graph), so every
          editable entity has a Postgres version row and edits can't spawn phantoms."""
        existing = await self.get_graph_by_data_source(data_source_id)
        if existing is not None:
            return {"graph_id": existing["graph_id"], "already_enabled": True,
                    "imported": 0, "rows": 0}
        rows = None
        if provider is not None:
            from backend.app.providers.versioned_bootstrap import (
                canonicalize_rows, collect_provider_rows)
            rows = await collect_provider_rows(provider, batch=batch)   # slow paging — OUTSIDE the txn
            # Seed-time canonicalization (Task E): make OUR versioned copy internally
            # case-consistent when the source has an assigned ontology. Source untouched.
            canon = canonicalize_rows(rows, ontology_rules)
            if canon:
                logger.info("enable_versioning %s: canonicalized %d row type spellings",
                            data_source_id, canon)
        try:
            async with self._session() as s:
                gid = (await self.create_graph(
                    data_source_id=data_source_id, workspace_id=workspace_id, kind=kind,
                    actor=actor, falkor_graph_name=falkor_graph_name, session=s))["graph_id"]
                imported = 0
                if rows:
                    report = await self.bulk_ingest(
                        graph_id=gid, rows=rows, actor=actor,
                        idempotency_key=f"bootstrap:{gid}",
                        message="enable versioning import", session=s)
                    st = report.get("stats") or {}
                    imported = int(report.get("applied")
                                   or (st.get("nodes", 0) + st.get("edges", 0)))
            return {"graph_id": gid, "already_enabled": False,
                    "imported": imported, "rows": len(rows or [])}
        except IntegrityError:
            # Lost a concurrent enable race (uq_graphs_data_source) — return the winner.
            again = await self.get_graph_by_data_source(data_source_id)
            if again is None:
                raise
            return {"graph_id": again["graph_id"], "already_enabled": True,
                    "imported": 0, "rows": 0}

    async def _assert_not_bootstrapping(self, s, graph_id: str) -> None:
        """A graph whose "enable version control" job hasn't COMPLETED is not a graph yet:
        its head is parked at genesis, its seq-2 ``import`` commit is half-written, and its
        projection watermark is parked so nothing reseeds the source.

        Writing to it in that state is not merely racy — it is destructive. A commit would
        advance ``main_head_commit_seq`` PAST the partial import commit, un-parking the
        watermark; the projector would then see work to do, and (the graph being pinned to
        the data source's real FalkorDB graph) DROP that graph and reseed it from a main
        that holds a fraction of the entities. One stray canvas edit would destroy the
        user's source data.

        So the gate covers **failed** jobs too, not just in-flight ones: a failed enablement
        must be resumed or abandoned, never edited around. One indexed lookup
        (``ix_jobs_graph_status``)."""
        unfinished = await s.scalar(select(JobORM.status).where(
            *bootstrap_unfinished(graph_id)).limit(1))
        if unfinished == "failed":
            raise ConcurrencyError(
                "enabling version control for this data source didn't finish — resume it "
                "or cancel it before making changes")
        if unfinished:
            raise ConcurrencyError(
                "version control is still being enabled for this data source — "
                "try again once it finishes")

    async def _assert_writable(self, s, graph_id: str) -> None:
        """Refuse a content write to a graph that is not live (:class:`GraphNotWritable`):
        editing is paused (``frozen``), it is in the trash (``trashed``), or a purge of it exists
        (``purging``, the rule restore uses). An unknown graph passes, for the caller's own 404.

        The row is read FOR KEY SHARE and held to the end of the write (doc 15 §8, position 6:
        after ``_lock_graph``, before a draft's row). It waits only for a row lock taken FOR
        UPDATE — :meth:`set_frozen`, a restore, a purge being queued, a trash — so a freeze waits
        for the writes in flight, and a write after it sees it: a draft writer has taken the
        lifecycle key shared first (:meth:`_lock_lifecycle`), so it cannot overtake one. A wait
        that runs out is :class:`LockBusy`, which ``_retry_seq`` retries."""
        row = (await self._bounded_lock(s, select(GraphORM.lifecycle_state, GraphORM.deleted_at)
               .where(GraphORM.id == graph_id).with_for_update(read=True, key_share=True),
               f"graph {graph_id}")).first()
        if row is None:
            return
        if row.deleted_at is not None:
            purging = await s.scalar(select(JobORM.id).where(
                JobORM.job_type == PURGE_JOB_TYPE, JobORM.graph_id == graph_id).limit(1))
            raise GraphNotWritable("purging" if purging else "trashed")
        if row.lifecycle_state != "live":
            raise GraphNotWritable(row.lifecycle_state)

    async def _claim_projection_key(self, s, name: str, provider: Optional[str], *,
                                    provider_aliases: Sequence[str] = (),
                                    exclude_graph_id: Optional[str] = None,
                                    data_source_id: Optional[str] = None) -> None:
        """Take FalkorDB graph ``name`` on ``provider`` as one versioned graph's projection target.

        Two versioned graphs projecting into one key would each reconcile the other's entities
        away. A key is one physical graph however it is reached: ``provider_aliases`` are the
        providers on ``provider``'s server (``managed_sources.same_server_providers``, asked of
        the management database by the caller), and a holder through any of them holds this
        key. A tombstoned holder that does not own the key lets go of it (its pin is cleared, as
        the ``20261017_1500_gv_ps_keys`` migration does); any other holder refuses the claim
        (:class:`ConcurrencyError`). Claims of one name take its advisory lock, held to the end of
        ``s``'s transaction, so two racing past this check serialize: ``uq_ps_key`` compares
        provider ids, and is left unbuilt while pins conflict.

        A holder that is ``data_source_id``'s own graph is not a rival: the caller lost a
        concurrent create for that data source, and ``uq_graphs_data_source`` refuses it."""
        default = config.DEFAULT_FALKOR_PROVIDER
        await s.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"gvkey:{name}"))))
        key = [func.coalesce(ProjectionStateORM.falkor_provider, default).in_(
                   [provider or default, *provider_aliases]),
               ProjectionStateORM.falkor_graph_name == name]
        if exclude_graph_id is not None:
            key.append(ProjectionStateORM.graph_id != exclude_graph_id)
        await s.execute(update(ProjectionStateORM).where(
            *key, ProjectionStateORM.owns_falkor_graph.is_(False),
            ProjectionStateORM.graph_id.in_(
                select(GraphORM.id).where(GraphORM.deleted_at.isnot(None))),
        ).values(falkor_graph_name=None).execution_options(synchronize_session=False))
        if data_source_id is not None:
            key.append(ProjectionStateORM.graph_id.not_in(
                select(GraphORM.id).where(GraphORM.data_source_id == data_source_id)))
        if await s.scalar(select(ProjectionStateORM.graph_id).where(*key).limit(1)):
            raise ConcurrencyError(
                "another versioned data source already projects into this FalkorDB graph")

    async def open_draft(
        self,
        *,
        graph_id: str,
        owner: str,
        name: Optional[str] = None,
        originating_view_id: Optional[str] = None,
        shared: bool = False,
        visibility: str = "private",
    ) -> str:
        """Open a per-user draft based on the graph's current ``main`` head.

        ``visibility``: ``public`` (everyone who reads the data source reads it, and everyone who
        changes it writes it) or ``private`` (its owner's, its members' and its review's). Every
        app caller passes its data source's policy (``drafts_policy``); private when none does,
        which fails closed. ``shared=True`` opens a collaborative draft: other users added via
        :meth:`add_branch_member` can edit it, and checkpoints field-merge
        concurrent edits (raising on same-field clashes) instead of clobbering."""
        async with self._session() as s:
            return await self._add_draft(s, graph_id=graph_id, owner=owner, name=name,
                                         originating_view_id=originating_view_id, shared=shared,
                                         visibility=visibility)

    async def _add_draft(self, s, *, graph_id: str, owner: str, name: Optional[str] = None,
                         originating_view_id: Optional[str] = None, shared: bool = False,
                         visibility: str = "private") -> str:
        """:meth:`open_draft` in the caller's transaction ``s``; returns the new draft's id."""
        if visibility not in ("public", "private"):
            raise ValueError(f"unknown draft level {visibility!r}")
        graph = await s.get(GraphORM, graph_id)
        if graph is None:
            raise ValueError(f"unknown graph {graph_id}")
        await self._assert_not_bootstrapping(s, graph_id)
        await self._lock_lifecycle(s, graph_id, shared=True)
        await self._assert_writable(s, graph_id)
        draft = BranchORM(
            graph_id=graph_id,
            kind="draft",
            name=name,
            owner=owner,
            is_shared=shared,
            visibility=visibility,
            base_commit_seq=graph.main_head_commit_seq,
            base_ontology_version_id=graph.base_ontology_version_id,
            originating_view_id=originating_view_id,
            created_by=owner,
        )
        s.add(draft)
        await s.flush()
        return draft.id

    # ------------------------------------------------------------------ #
    # Shared-draft membership (plan §8)                                   #
    # ------------------------------------------------------------------ #
    async def add_branch_member(
        self, *, graph_id: str, branch_id: str, subject_type: str, subject_id: str,
        role: str, actor: str, actor_groups: Sequence[str] = (),
        check_eligible: Optional[Callable[[], Awaitable[None]]] = None,
        **checkpoint_kwargs,
    ) -> dict:
        """Grant a user/group a role on a draft (maintainer/owner only). Adding a
        member marks the draft shared; re-adding an existing subject updates role.
        ``check_eligible`` (raising :class:`IneligibleMember`) runs only once the actor
        is authorized, under the draft's lock. A role lowered so that someone no longer writes
        the draft has what they staged committed first (:meth:`_settled_change`)."""
        if role not in ROLE_RANK:
            raise ValueError(f"unknown role {role!r}")
        if subject_type not in ("user", "group"):
            raise ValueError(f"unknown subject_type {subject_type!r}")
        async with self._settled_change(graph_id, branch_id, actor, actor_groups, checkpoint_kwargs,
                                        role=(subject_type, subject_id, role),
                                        message=f"Saved before {subject_id}'s role changed") as (s, branch):
            if subject_type == "user" and subject_id == branch.owner:
                raise IneligibleMember(subject_id, "owner")
            if check_eligible:
                await check_eligible()
            if not branch.is_shared:                     # before the select: drop rows left behind
                await s.execute(delete(BranchMemberORM).where(BranchMemberORM.branch_id == branch.id))
                branch.is_shared = True
            row = (await s.execute(select(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id,
                BranchMemberORM.subject_type == subject_type,
                BranchMemberORM.subject_id == subject_id,
            ))).scalar_one_or_none()
            if row is None:
                s.add(BranchMemberORM(branch_id=branch_id, subject_type=subject_type,
                                      subject_id=subject_id, role=role))
            else:
                row.role = role
            return {"subjectType": subject_type, "subjectId": subject_id, "role": role}

    async def remove_branch_member(
        self, *, graph_id: str, branch_id: str, subject_type: str, subject_id: str,
        actor: str, actor_groups: Sequence[str] = (), **checkpoint_kwargs,
    ) -> None:
        """Remove a member (maintainer/owner only). Whoever no longer writes the draft without
        that row has what they staged committed first (:meth:`_settled_change`)."""
        async with self._settled_change(graph_id, branch_id, actor, actor_groups, checkpoint_kwargs,
                                        without=(subject_type, subject_id),
                                        message=f"Saved before {subject_id} was removed") as (s, branch):
            await s.execute(delete(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id,
                BranchMemberORM.subject_type == subject_type,
                BranchMemberORM.subject_id == subject_id,
            ))
            if not await s.scalar(select(BranchMemberORM.branch_id).where(
                    BranchMemberORM.branch_id == branch_id).limit(1)):
                branch.is_shared = False                 # shared means "has members"

    async def list_branch_members(self, *, graph_id: str, branch_id: str) -> List[dict]:
        """A private draft has none: rows left on it grant nothing."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            if not branch.is_shared:
                return []
            rows = (await s.execute(select(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch_id
            ).order_by(BranchMemberORM.created_at))).scalars().all()
            return [{"subjectType": r.subject_type, "subjectId": r.subject_id, "role": r.role}
                    for r in rows]

    async def set_visibility(self, *, graph_id: str, branch_id: str, visibility: str, actor: str,
                             actor_groups: Sequence[str] = (), **checkpoint_kwargs) -> dict:
        """Make a draft public or private (its owner or a maintainer). Made private, the writers it
        loses — not its owner or its editor and maintainer members — have what they staged
        committed first, each under their own name in the order they staged it; edits that clash
        with the draft leave it as it was (:class:`StagedChangesUnsaved`). Its members stay."""
        if visibility not in ("public", "private"):
            raise ValueError(f"unknown draft level {visibility!r}")
        async with self._session() as s:                 # refused before anyone's edits are saved
            branch = await self._get_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._require_open(branch)
        async with self._settled_change(graph_id, branch_id, actor, actor_groups, checkpoint_kwargs,
                                        visibility=visibility,
                                        message="Saved before the draft was made private") as (s, branch):
            self._require_open(branch)
            if branch.visibility != visibility:
                branch.visibility = visibility
                branch.updated_at = _now()
            return self._branch_meta(branch)

    async def visibility_impact(self, *, graph_id: str, branch_id: str, visibility: str, actor: str,
                                actor_groups: Sequence[str] = ()) -> dict:
        """What making the draft ``visibility`` would do, for its owner or a maintainer to see
        first: who it takes write access from has edits staged, and how many — committed under
        their names before it changes."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._require_manage(s, branch, actor, actor_groups)
            saved = [{"actor": who, "changes": n} for who, n in await self._stagers(s, graph_id, branch_id)
                     if await self._still_writes(s, branch, who)
                     and not await self._still_writes(s, branch, who, visibility=visibility)]
            return {"visibility": visibility, "saved": saved}

    async def transfer_branch(
        self, *, graph_id: str, branch_id: str, to: str, actor: str, actor_groups: Sequence[str] = (),
        keep_previous: bool = True,
        owner_left: Optional[Callable[[str], Awaitable[bool]]] = None,
        check_eligible: Optional[Callable[[], Awaitable[None]]] = None,
        **checkpoint_kwargs,
    ) -> dict:
        """Hand a draft to ``to``. Its owner does, at any time; so does whoever is given
        ``owner_left`` (the route gives it to a workspace admin), once it says the owner left. The
        previous owner stays on as a maintainer (``keep_previous``); else, if that takes their write
        access, what they staged is committed first, under their name (:meth:`_settled_change`).
        ``check_eligible`` (raising :class:`IneligibleOwner`) runs once the actor is authorized,
        under the draft's lock. Returns the draft's metadata and its ``previous_owner``: an admin
        who takes over a draft they may not read sees no more of it."""
        async with self._session() as s:                 # refused before anyone's edits are saved
            branch = await self._get_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._require_open(branch)

        async def may_hand_on(s, branch):
            if actor == branch.owner or (owner_left is not None and await owner_left(branch.owner)):
                return
            await self._unknown_unless_readable(s, branch, actor, actor_groups)
            raise NotDraftOwner(branch.id, branch.owner)

        async with self._settled_change(graph_id, branch_id, actor, actor_groups, checkpoint_kwargs,
                                        owner=None if keep_previous else to, authorize=may_hand_on,
                                        message="Saved before the draft changed hands") as (s, branch):
            self._require_open(branch)
            previous = branch.owner
            if to == previous:
                return {**self._branch_meta(branch), "previous_owner": previous}
            if check_eligible:
                await check_eligible()
            if not branch.is_shared:                     # before the selects: drop rows left behind
                await s.execute(delete(BranchMemberORM).where(BranchMemberORM.branch_id == branch.id))
            await s.execute(delete(BranchMemberORM).where(   # an owner needs no row
                BranchMemberORM.branch_id == branch.id, BranchMemberORM.subject_type == "user",
                BranchMemberORM.subject_id == to))
            if keep_previous:
                row = (await s.execute(select(BranchMemberORM).where(
                    BranchMemberORM.branch_id == branch.id, BranchMemberORM.subject_type == "user",
                    BranchMemberORM.subject_id == previous))).scalar_one_or_none()
                if row is None:
                    s.add(BranchMemberORM(branch_id=branch.id, subject_type="user", subject_id=previous,
                                          role="maintainer"))
                else:
                    row.role = "maintainer"
            await s.flush()
            branch.is_shared = bool(await s.scalar(select(BranchMemberORM.branch_id).where(
                BranchMemberORM.branch_id == branch.id).limit(1)))     # shared means "has members"
            branch.owner = to
            branch.updated_at = _now()
            return {**self._branch_meta(branch), "previous_owner": previous}

    async def draft_owners(self, *, workspace_id: str) -> List[str]:
        """Who owns an open draft of the workspace's versioned graphs."""
        async with self._session() as s:
            return list((await s.execute(
                select(BranchORM.owner).distinct()
                .join(GraphORM, GraphORM.id == BranchORM.graph_id)
                .where(GraphORM.workspace_id == workspace_id, GraphORM.deleted_at.is_(None),
                       BranchORM.kind == "draft", BranchORM.status.in_(("open", "publishing")),
                       BranchORM.owner.isnot(None))
            )).scalars().all())

    async def drafts_owned_by(self, *, workspace_id: str, owners: Sequence[str],
                              limit: int = 500) -> List[dict]:
        """The open drafts of the workspace's versioned graphs that ``owners`` own, the latest
        changed first: what a workspace admin sees of a draft they may not read — where it is, its
        name, owner, level and status — never what it holds."""
        if not owners:
            return []
        async with self._session() as s:
            rows = (await s.execute(
                select(BranchORM, GraphORM.data_source_id)
                .join(GraphORM, GraphORM.id == BranchORM.graph_id)
                .where(GraphORM.workspace_id == workspace_id, GraphORM.deleted_at.is_(None),
                       BranchORM.kind == "draft", BranchORM.status.in_(("open", "publishing")),
                       BranchORM.owner.in_(list(owners)))
                .order_by(BranchORM.updated_at.desc(), BranchORM.id)
                .limit(limit)
            )).all()
            return [{"graph_id": b.graph_id, "branch_id": b.id, "data_source_id": ds, "name": b.name,
                     "owner": b.owner, "visibility": b.visibility, "status": b.status,
                     "updated_at": b.updated_at} for b, ds in rows]

    @contextlib.asynccontextmanager
    async def _settled_change(self, graph_id: str, branch_id: str, actor: str, actor_groups,
                              checkpoint_kwargs: dict, *, message: str,
                              visibility: Optional[str] = None,
                              without: Optional[Tuple[str, str]] = None,
                              role: Optional[Tuple[str, str, str]] = None,
                              owner: Optional[str] = None,
                              authorize: Optional[Callable[[Any, BranchORM], Awaitable[None]]] = None):
        """A change to who writes a draft (its level, ``visibility``; a member row removed,
        ``without``; a member's ``role`` changed; or its ``owner``), made once nobody it takes
        write access from has anything staged. Under the draft's lock, with the actor authorized
        (``authorize(session, branch)``; else as its owner or a maintainer): those writers'
        staged edits are committed first, each under their own name in the order they staged
        (outside the lock, which a checkpoint takes), and the check repeats. Yields ``(session,
        branch)`` with the lock held and nobody left to settle. Edits that clash with the draft
        are :class:`StagedChangesUnsaved`; people staging through three rounds, :class:`LockBusy`."""
        for _round in range(3):
            async with self._session() as s:
                branch = await self._lock_branch(s, graph_id, branch_id)
                if authorize is None:
                    await self._require_manage(s, branch, actor, actor_groups)
                else:
                    await authorize(s, branch)
                losing = [who for who, _n in await self._stagers(s, graph_id, branch_id)
                          if await self._still_writes(s, branch, who)
                          and not await self._still_writes(s, branch, who, visibility=visibility,
                                                           without=without, role=role, owner=owner)]
                if not losing:
                    yield s, branch
                    return
            unsaved = await self._save_staged(graph_id=graph_id, branch_id=branch_id, actors=losing,
                                              message=message, **checkpoint_kwargs)
            if unsaved:
                raise StagedChangesUnsaved(unsaved)
        raise LockBusy("people kept saving edits to this draft; try again")

    async def _still_writes(self, s, branch: BranchORM, who: str, *, visibility: Optional[str] = None,
                            without: Optional[Tuple[str, str]] = None,
                            role: Optional[Tuple[str, str, str]] = None,
                            owner: Optional[str] = None) -> bool:
        """Whether ``who`` writes the draft at level ``visibility`` (its own when None), without the
        member row ``without`` (subject type, id), with ``role`` (subject type, id, role) on an
        existing row, or owned by ``owner`` (its own when None): its owner always; on a public
        draft anyone who changes its data source; else an editor or maintainer member, directly or
        through a team."""
        if who == (owner or branch.owner):
            return True
        if (visibility or branch.visibility) == "public":
            return True
        if not branch.is_shared:
            return False
        writers = set()
        for r in (await s.execute(select(BranchMemberORM).where(
                BranchMemberORM.branch_id == branch.id))).scalars().all():
            key = (r.subject_type, r.subject_id)
            if key == without:
                continue
            if ROLE_RANK[role[2] if role and key == role[:2] else r.role] >= ROLE_RANK["editor"]:
                writers.add(key)
        if ("user", who) in writers:
            return True
        teams = {sid for kind, sid in writers if kind == "group"}
        return bool(teams and teams & set(await _load_actor_groups(who)))

    @staticmethod
    async def _stagers(s, graph_id: str, branch_id: str) -> List[Tuple[str, int]]:
        """Who has edits staged on the draft, and how many, in the order they first staged."""
        rows = (await s.execute(
            select(WorkingChangeORM.actor, func.count(), func.min(WorkingChangeORM.seq))
            .where(WorkingChangeORM.graph_id == graph_id, WorkingChangeORM.branch_id == branch_id,
                   WorkingChangeORM.committed_into_commit_id.is_(None))
            .group_by(WorkingChangeORM.actor)
            .order_by(func.min(WorkingChangeORM.seq))
        )).all()
        return [(who, int(n)) for who, n, _first in rows]

    async def _save_staged(self, *, graph_id: str, branch_id: str, actors: Sequence[str], message: str,
                           **checkpoint_kwargs) -> List[str]:
        """Commit each of ``actors``' staged edits under their own name, in turn. Returns the ones
        whose edits clash with the draft (or break its ontology), left staged."""
        unsaved = []
        for who in actors:
            try:
                await self.checkpoint(graph_id=graph_id, branch_id=branch_id, actor=who, message=message,
                                      only_actor=who, **checkpoint_kwargs)
            except (MergeConflict, OntologyViolation):
                unsaved.append(who)
        return unsaved

    async def my_branch_role(self, *, graph_id: str, branch_id: str, actor: str) -> Optional[str]:
        """*actor*'s role on the draft: ``'owner'``, a member role, or ``None``."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            if branch.owner == actor:
                return "owner"
            return await self._branch_role(s, branch, actor)

    # ------------------------------------------------------------------ #
    # Staging + checkpoint                                                #
    # ------------------------------------------------------------------ #
    async def stage_changes(
        self,
        *,
        graph_id: str,
        branch_id: str,
        ops: Sequence[Mapping],
        actor: str,
        actor_groups: Sequence[str] = (),
        ontology_rules: Optional[OntologyRules] = None,
    ) -> Dict[str, str]:
        """Bulk-append working changes to a draft (plan decision #10).

        Each op: ``{ref?, op, entity_kind, entity_id?, payload, change_reason?}``.
        A ``create`` without an ``entity_id`` is named here: a node by its payload's urn, else a
        new ``urn:uuid:`` that becomes its urn too (one identity); an edge by a new ``urn:uuid:``.
        Returns
        ``{ref_or_entity_id: entity_id}`` so the client can reconcile.

        With injected ``ontology_rules`` (strict graphs only) staged CREATES are
        rich-validated eagerly for fast feedback. Edge endpoints that exist only
        as earlier *uncommitted* working changes can't be typed here, so those
        edges are skipped — **checkpoint is the authoritative rich gate**.
        """
        assigned: Dict[str, str] = {}
        async with self._session() as s:
            await self._lock_lifecycle(s, graph_id, shared=True)
            await self._assert_writable(s, graph_id)
            branch = await self._lock_branch(s, graph_id, branch_id)   # serializes the seq allocation
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._require_open(branch)
            await self._require_edit(s, branch, actor, actor_groups)
            graph = await s.get(GraphORM, graph_id)
            ontology = Ontology.from_spec(graph.ontology_spec) if graph else None
            entities: List[tuple] = []
            rich_entities: List[tuple] = []   # (entity_id, kind, payload, op) for the rich gate
            start = (
                await s.execute(
                    select(func.coalesce(func.max(WorkingChangeORM.seq), 0)).where(
                        WorkingChangeORM.graph_id == graph_id,
                        WorkingChangeORM.branch_id == branch_id,
                    )
                )
            ).scalar_one()
            seq = int(start)
            for op in ops:
                if op.get("op") not in ("create", "update", "delete"):
                    # Staged changes are folded op by op at checkpoint; anything else (a `move` is
                    # resolved against stored state only by apply_ops) would be misread there.
                    raise ValueError(f"unsupported staged op {op.get('op')!r}: create | update | delete")
                seq += 1
                payload = op.get("payload")
                # A new node that brings no id is named by its urn: the one it brings, else a new
                # urn:uuid for both.
                new_node = (op["op"] == "create" and op["entity_kind"] == "node"
                            and not op.get("entity_id"))
                entity_id = (op.get("entity_id") or ((payload or {}).get("urn") if new_node else None)
                             or new_entity_id())
                ref = op.get("ref", entity_id)
                assigned[ref] = entity_id
                if op["op"] == "create":
                    payload = strip_deletes(payload)     # a new entity has nothing to remove
                    if new_node and isinstance(payload, dict) and not payload.get("urn"):
                        payload = {**payload, "urn": entity_id}
                if op["entity_kind"] == "node":
                    payload = _sanitize_node_properties(payload)
                if op["op"] != "delete":
                    entities.append((entity_id, op["entity_kind"], payload))
                rich_entities.append((entity_id, op["entity_kind"], payload, op["op"]))
                base_hash = None
                if op["op"] != "create":
                    base_hash = await self._effective_head_hash(
                        s, graph_id, branch_id, entity_id
                    )
                s.add(
                    WorkingChangeORM(
                        graph_id=graph_id,
                        branch_id=branch_id,
                        seq=seq,
                        op=op["op"],
                        entity_kind=op["entity_kind"],
                        entity_id=entity_id,
                        payload=payload,
                        base_content_hash=base_hash,
                        actor=actor,
                        change_reason=op.get("change_reason"),
                    )
                )
            violations = validate_entities(entities, ontology)
            if violations and graph is not None and graph.ontology_enforcement == "strict":
                raise OntologyViolation(violations)      # rolls back — nothing staged
            if ontology_rules is not None and graph is not None \
                    and graph.ontology_enforcement == "strict":
                # Endpoint types: batch node payloads first, then committed heads.
                endpoint_types: Dict[str, str] = {
                    eid: p["entityType"] for eid, k, p, o in rich_entities
                    if k == "node" and o != "delete" and p and p.get("entityType")
                }
                unknown = {ep for _e, k, p, o in rich_entities
                           if k == "edge" and o == "create" and p
                           for ep in _edge_src_tgt(p) if ep and ep not in endpoint_types}
                if unknown:
                    cur = await self._current_values(s, graph_id, branch_id, list(unknown))
                    for ep, v in cur.items():
                        if v and v.get("entityType"):
                            endpoint_types[ep] = v["entityType"]
                rich_viol = validate_entities_rich(rich_entities, endpoint_types, ontology_rules)
                if rich_viol:
                    raise OntologyViolation(rich_viol)   # rolls back — nothing staged
            return assigned

    async def checkpoint(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: Optional[str] = None,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        actor_groups: Sequence[str] = (),
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        publishing_ok: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        only_actor: Optional[str] = None,
    ) -> Optional[str]:
        """Fold uncommitted working changes into a draft commit, retrying on a
        ``commit_seq`` collision so two collaborators checkpointing the SAME shared
        draft concurrently don't crash (one retries against the other's new head).

        ``node_identity`` (the data source's resolved mapping) keeps each node's own
        name and identity properties in step with what the checkpoint writes —
        ``node_identity.bind_node_write``; ``None`` binds nothing. ``only_actor`` folds that
        person's staged changes alone (a level or member change saving them first)."""
        return await self._retry_seq(
            f"checkpoint {branch_id}",
            lambda: self._checkpoint_once(
                graph_id=graph_id, branch_id=branch_id, actor=actor, message=message,
                resolutions=resolutions, actor_groups=actor_groups,
                containment_edge_types=containment_edge_types,
                ontology_rules=ontology_rules, publishing_ok=publishing_ok,
                node_identity=node_identity, only_actor=only_actor),
        )

    async def _checkpoint_once(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: Optional[str] = None,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        actor_groups: Sequence[str] = (),
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        publishing_ok: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        only_actor: Optional[str] = None,
    ) -> Optional[str]:
        """Fold uncommitted working changes into version rows under a new draft
        commit.  Returns the commit id, or ``None`` if nothing was staged.

        On a **shared** draft, concurrent edits from different collaborators are
        field-merged; a same-field clash raises :class:`MergeConflict` unless a
        ``resolutions`` payload (``{entity_id: payload|None}``) settles it."""
        async with self._session() as s:
            await self._lock_lifecycle(s, graph_id, shared=True)
            await self._assert_writable(s, graph_id)
            branch = await self._lock_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._require_open(branch, publishing_ok=publishing_ok)
            await self._require_edit(s, branch, actor, actor_groups)

            changes = (
                await s.execute(
                    select(WorkingChangeORM)
                    .where(
                        WorkingChangeORM.graph_id == graph_id,
                        WorkingChangeORM.branch_id == branch_id,
                        WorkingChangeORM.committed_into_commit_id.is_(None),
                        *((WorkingChangeORM.actor == only_actor,) if only_actor is not None else ()),
                    )
                    .order_by(WorkingChangeORM.seq)
                )
            ).scalars().all()
            # Staged by someone who may no longer write the draft (removed, un-shared, out of the
            # group): withdrawn, never folded into this commit, and so never published.
            barred = set()
            for who in {c.actor for c in changes} - {actor}:
                try:
                    await self._require_edit(s, branch, who, ())
                except AccessDenied:
                    barred.add(who)
            for c in changes:
                if c.actor in barred:
                    await s.delete(c)
            changes = [c for c in changes if c.actor not in barred]
            if not changes:
                return None

            kind_by_entity = {c.entity_id: c.entity_kind for c in changes}
            touched = list(kind_by_entity)

            # Base = the draft's current effective state for each touched entity,
            # fork-aware (draft over this graph's main over any fork parent), so a
            # checkpoint on a fork classifies edits to inherited entities as
            # updates (not creates) and keeps hash continuity intact. Read for the touched
            # entities alone: the whole state is every payload of the graph, on every save.
            composed = await self._current_values(s, graph_id, branch_id, touched)
            base_state = {eid: composed.get(eid) for eid in touched}
            if branch.is_shared or branch.visibility == "public":
                # Resolve the value each edit was STAGED against (per base_content_hash, first
                # occurrence per entity) so the fold's OCC ancestor is the editor's view, not the
                # live head — catching a stale single-actor checkpoint, not just within-batch clashes.
                staged_tokens: Dict[str, str] = {}
                for c in changes:
                    if c.base_content_hash and c.entity_id not in staged_tokens:
                        staged_tokens[c.entity_id] = c.base_content_hash
                base_by_entity = await self._payloads_by_content_hash(
                    s, graph_id, staged_tokens, kind_by_entity) if staged_tokens else {}
                head_state, conflicts = _fold_shared(
                    base_state, changes, frozenset(config.SET_FIELDS), resolutions or {},
                    base_by_entity,
                )
                if conflicts:
                    raise MergeConflict(conflicts)       # rolls back — nothing committed
            else:
                ops = [
                    {"entity_id": c.entity_id, "op": c.op, "payload": c.payload}
                    for c in changes
                ]
                head_state = materialize(base_state, ops)

            # Cascade containment deletes (ontology-driven): expand a deleted node to its
            # subtree + all incident edges so a checkpoint can't orphan descendants or dangle
            # edges — parity with apply_ops, via the same shared helper.
            # Nodes this checkpoint leaves deleted (a delete later undone by a re-create is not one).
            del_nodes = {eid for eid, k in kind_by_entity.items()
                         if k == "node" and head_state.get(eid) is None}
            if del_nodes:
                subtree, inc_edges = await self._cascade_deletes(
                    s, graph_id, branch_id, del_nodes, containment_edge_types, overlay=head_state)
                for e in subtree | set(inc_edges):             # touched in this checkpoint: prior known
                    if e in base_state:
                        head_state[e] = None
                        kind_by_entity[e] = "edge" if e in inc_edges else "node"
                extra = [e for e in (subtree | set(inc_edges)) if e not in base_state]
                extra_cur = await self._current_values(s, graph_id, branch_id, extra) if extra else {}
                for e in extra:
                    cur = extra_cur.get(e)
                    if cur is None:
                        continue
                    base_state[e] = cur            # so net_delta sees a delete
                    head_state[e] = None           # tombstone the descendant / incident edge
                    kind_by_entity[e] = "edge" if _is_edge_payload(cur) else "node"
            # Each node's own name / identity properties, kept in step with what the fold wrote
            # (judged against the state the staged edits apply to, after the shared-draft merge,
            # so a mirrored value never shows up as a clash of its own).
            if node_identity is not None:
                head_state.update(bind_node_writes(
                    head_state, base_state, kind_by_entity=kind_by_entity, identity=node_identity,
                    created={c.entity_id for c in changes if c.op == "create"}))
            # Canonicalize entity/edge-type casing to the ontology's declared spelling BEFORE
            # the squash, so the folded version rows (and their projection) carry canonical
            # casing regardless of what the client staged (a case variant never fails).
            if ontology_rules is not None:
                for v in head_state.values():
                    canonicalize_payload_types(v, ontology_rules)
            deltas = net_delta(base_state, head_state)

            # The gate every write path shares, on what this checkpoint WRITES: no untyped
            # creation, hierarchy integrity for new / re-pointed edges, and — strict graphs — the
            # ontology (the authoritative check for staged edits: stage_changes can't type endpoints
            # that exist only as uncommitted working changes; the composed head state can).
            if deltas:
                graph = await s.get(GraphORM, graph_id)
                await self._enforce_written(
                    s, graph_id, branch_id, {d.entity_id: d.payload for d in deltas},
                    base_state, kind_by_entity,
                    containment_edge_types=containment_edge_types or [],
                    ontology_rules=ontology_rules,
                    strict=graph is not None and graph.ontology_enforcement == "strict",
                    known=head_state,
                    edited={c.entity_id for c in changes if c.op == "update"}
                    - {c.entity_id for c in changes if c.op == "create"})

            commit_seq = await self._next_seq(s, graph_id, branch_id)
            commit = CommitORM(
                graph_id=graph_id,
                branch_id=branch_id,
                commit_seq=commit_seq,
                parent_commit_id=branch.head_commit_id,
                kind="checkpoint" if branch.head_commit_id else "edit",
                message=message or "checkpoint",
                actor=actor, **commit_provenance(actor),
                originating_view_id=branch.originating_view_id,   # attribute to the draft's view
            )
            s.add(commit)
            await s.flush()

            await self._write_deltas(
                s, graph_id, branch_id, commit, deltas, kind_by_entity, actor
            )

            commit.merkle_root = None              # a draft carries no fingerprint (_commit_merkle)
            commit.stats = _delta_stats(deltas)

            for c in changes:
                c.committed_into_commit_id = commit.id
            branch.head_commit_id = commit.id
            branch.updated_at = _now()
            return commit.id

    async def _flush_pending_changes(
        self, *, graph_id: str, branch_id: str, actor: str,
        actor_groups: Sequence[str] = (),
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        publishing_ok: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
    ) -> Optional[str]:
        """Fold any staged-but-uncommitted ``working_changes`` on a draft into a
        checkpoint commit. Publish/merge read the draft side from committed heads
        (``_branch_own_payloads`` → ``entity_heads``), so a draft that staged edits
        but never checkpointed would otherwise publish/merge an EMPTY delta and
        silently drop those edits. Returns the new commit id, or ``None`` if there
        was nothing pending."""
        async with self._session() as s:
            pending = await self._pending_count(s, graph_id, branch_id)
        if not pending:
            return None
        return await self.checkpoint(
            graph_id=graph_id, branch_id=branch_id, actor=actor,
            message="auto-checkpoint pending changes before merge",
            actor_groups=actor_groups, containment_edge_types=containment_edge_types,
            ontology_rules=ontology_rules, publishing_ok=publishing_ok,
            node_identity=node_identity,
        )

    @staticmethod
    async def _pending_count(s, graph_id: str, branch_id: str) -> int:
        """How many of the draft's staged ``working_changes`` no checkpoint has folded yet."""
        return (await s.execute(
            select(func.count()).select_from(WorkingChangeORM).where(
                WorkingChangeORM.graph_id == graph_id,
                WorkingChangeORM.branch_id == branch_id,
                WorkingChangeORM.committed_into_commit_id.is_(None),
            )
        )).scalar_one()

    # ------------------------------------------------------------------ #
    # Publish (squash draft → main)                                       #
    # ------------------------------------------------------------------ #
    async def publish(
        self,
        *,
        graph_id: str,
        branch_id: str,
        actor: str,
        message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        actor_groups: Sequence[str] = (),
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        queued: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        self_merge: bool = True,
    ) -> str:
        """Squash an UP-TO-DATE draft into a single ``main`` commit (plan §8) — the
        ungated path (admin / no review). The reviewed path is :meth:`open_draft_mr`
        + :meth:`merge_mr`, which share the squash body in :meth:`_apply_draft_squash`.
        ``self_merge`` False: its data source's policy says nobody merges their own changes, and
        a direct publish is its publisher's own merge (:class:`ReviewRequired`).

        Require-up-to-date gate: if ``main`` advanced under the draft this raises
        :class:`NotUpToDate` — the later arrival must :meth:`rebase_draft` (pull latest,
        resolving any same-field clashes there) before it can publish, so what lands is
        exactly what the user reviewed. Once up-to-date (base == current head) the squash
        reduces to the draft's own delta; a residual clash still raises
        :class:`MergeConflict`.

        ``queued``: the draft's publish job runs this, and the job set the draft ``publishing``.
        """
        if not self_merge:
            raise ReviewRequired(branch_id)

        async def _once():
            # Who may publish is settled before anything is written: the fold below commits the
            # draft's staged edits under the caller's name, which someone refused the publish must
            # never do. Asked again under the draft's lock below, where it decides.
            async with self._session() as s:
                draft = await self._get_branch(s, graph_id, branch_id)
                if draft.kind != "main":
                    self._require_open(draft, publishing_ok=queued)
                    await self._require_publish(s, draft, actor, actor_groups)
            # Fold any staged-but-uncommitted edits first, so a publish never silently
            # drops working changes that were staged but not checkpointed.
            await self._flush_pending_changes(
                graph_id=graph_id, branch_id=branch_id, actor=actor, actor_groups=actor_groups,
                ontology_rules=ontology_rules, publishing_ok=queued, node_identity=node_identity,
            )
            async with self._session() as s:
                await self._lock_graph(s, graph_id)       # serialize same-graph merges (see _lock_graph)
                graph = await s.get(GraphORM, graph_id)
                if graph is None:
                    raise ValueError("unknown graph/branch")
                await self._assert_writable(s, graph_id)
                # The draft's lock: a save in flight is published with the draft, a later one finds
                # it merged. An edit staged after the fold above is folded by the retry.
                draft = await self._lock_branch(s, graph_id, branch_id)
                self._require_open(draft, publishing_ok=queued)
                await self._require_no_import(s, branch_id)
                if await self._pending_count(s, graph_id, branch_id):
                    raise _StaleHead()
                await self._require_publish(s, draft, actor, actor_groups)
                main_id = await self._main_branch_id(s, graph_id)
                # Require-up-to-date gate (Git "update branch before merging"): a draft that is BEHIND
                # main must explicitly pull latest (rebase_draft) before it can publish, so the user
                # reviews the rebased result rather than having main silently folded in at publish time
                # — unless only automation moved main, on nothing the draft changes (_pull_needed).
                # This is the branch→main half of the concurrency model (the same-branch half is the
                # per-entity head CAS in _apply_ops_once); see docs/versioning/03 §3.13. Read under
                # _lock_graph so the head can't advance between this check and the squash below.
                await self._require_landable(s, graph_id, main_id, draft, graph.main_head_commit_seq)
                if self._narrow_squash(graph, draft, resolutions):
                    return await self._squash_up_to_date(
                        s, graph, draft, main_id, actor, message,
                        containment_edge_types=containment_edge_types, ontology_rules=ontology_rules,
                        merged_via="direct_publish")
                # Up-to-date (base == current head) → base == theirs, so the merge reduces to the draft's
                # own delta; a genuine same-field clash still raises MergeConflict (the only hard stop).
                merged_state, conflicts, theirs = await self._compute_merge_bounded(
                    s, graph_id, graph, draft, main_id, dict(resolutions or {})
                )
                if conflicts:
                    raise MergeConflict(conflicts)
                return await self._apply_draft_squash(
                    s, graph, draft, main_id, merged_state, theirs, actor, message,
                    containment_edge_types=containment_edge_types,
                    ontology_rules=ontology_rules,
                    merged_via="direct_publish",   # this path bypasses any open review on the branch
                )
        return await self._retry_seq(f"publish {branch_id}", _once)

    async def _apply_draft_squash(
        self, s, graph, draft, main_id, merged_state, theirs, actor, message,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        merged_via: str = "review",
    ) -> str:
        """Squash a draft's (already-merged, conflict-free) state onto ``main`` as a
        single ``squash_publish`` commit: cascade incident-edge deletes, assert
        referential integrity, write the net delta, advance the head + merkle, and
        mark the draft merged + projection target. Shared by :meth:`publish` and the
        reviewed :meth:`merge_mr` (so both attribute contributors and re-gate ontology
        identically).

        ``merged_via`` records HOW the branch reached main for any PR this squash resolves:
        ``review`` (merged through the PR) or ``direct_publish`` (an admin published the branch,
        bypassing its open review). Resolving PRs *here* — in the body BOTH entry points share —
        is what makes "no live PR survives a squash of its source branch" an invariant rather than
        a thing each caller must remember."""
        # merged_state/theirs may be SPARSE (bounded merge). Hydrate the live main
        # neighborhood the next two guards reason about so they behave identically to the
        # full-state path: incident edges of tombstoned nodes (to cascade) + endpoints of
        # added edges (so an edge between two unchanged nodes isn't a false dangle).
        await self._hydrate_merge_neighborhood(s, graph.id, main_id, merged_state, theirs)
        # Deleting a node cascades to its incident edges in this same commit;
        # the guard then only rejects edges to an endpoint that never existed
        # (cross-entity conflict the per-entity merge can't see — §16.5 #8).
        self._cascade_incident_edges(merged_state)
        self._assert_referential_integrity(merged_state)

        # Canonicalize type casing to the ontology's declared spelling before the squash, so
        # a draft that accumulated a case variant (Has/HAS/has) publishes canonical rows —
        # the case-sensitive FalkorDB projection then matches the containment predicate.
        if ontology_rules is not None:
            for v in merged_state.values():
                canonicalize_payload_types(v, ontology_rules)

        deltas = net_delta(theirs, merged_state)   # what publish adds to main
        if not deltas:
            return await self._merged_unchanged(s, graph, draft, actor, merged_via)

        squash = await self._squash_commit(s, graph, draft, main_id, actor, message)

        kind_by_entity = await self._kind_map_multi(
            s, [(graph.id, draft.id), (graph.id, main_id)],
            entity_ids=[d.entity_id for d in deltas],
        )
        kind_by_entity = self._resolve_delta_kinds(deltas, kind_by_entity)  # payload wins over stale head
        ontology = Ontology.from_spec(graph.ontology_spec)   # PR re-validation gate (§16.5 #6)
        if ontology is not None and graph.ontology_enforcement == "strict":
            viol = validate_entities(
                [(d.entity_id, kind_by_entity.get(d.entity_id, "node"), d.payload)
                 for d in deltas if d.op != "delete"], ontology)
            if viol:
                raise OntologyViolation(viol)
        unique = await self._unique_violations(
            s, graph.id, main_id, {d.entity_id: d.payload for d in deltas}, ontology_rules)
        if unique:
            raise UniqueViolation(unique)
        # Re-gated at merge time against CURRENT main, with rules resolved from the CURRENT
        # published ontology by the caller — the same gate as every other write path, on what the
        # publish writes: a draft opened before an ontology tightening cannot merge violating
        # entities onto main, and two drafts that are each clean in isolation cannot compose into
        # a two-parent or cyclic hierarchy. Edge ends are typed from ``merged_state`` (already
        # hydrated with added edges' endpoints by _hydrate_merge_neighborhood).
        await self._enforce_written(
            s, graph.id, main_id, {d.entity_id: d.payload for d in deltas}, theirs,
            kind_by_entity, containment_edge_types=containment_edge_types or [],
            ontology_rules=ontology_rules, strict=graph.ontology_enforcement == "strict",
            known=merged_state)
        await self._write_deltas(s, graph.id, main_id, squash, deltas, kind_by_entity, actor,
                                 editors=await self._editors(s, graph.id, draft.id, deltas))
        return await self._finish_squash(s, graph, draft, main_id, squash, deltas, actor, merged_via)

    async def _merged_unchanged(self, s, graph, draft, actor, merged_via: str) -> str:
        """A squash that changes nothing on ``main``: the draft is merged all the same."""
        draft.status = "merged"
        draft.base_commit_seq = graph.main_head_commit_seq
        # Nothing reaches main, yet the branch is merged all the same (what it holds in views
        # goes live with it), so no review raised from it may be left live either.
        await self._resolve_live_prs(s, draft.id, None, actor, merged_via)
        return draft.head_commit_id or ""

    async def _squash_commit(self, s, graph, draft, main_id, actor, message) -> "CommitORM":
        """The ``squash_publish`` commit a squash of ``draft`` writes onto ``main``, at the next seq."""
        contributors = await self._branch_contributors(s, graph.id, draft.id)
        source_commits = await self._branch_commit_ids(s, graph.id, draft.id)
        main = await s.get(BranchORM, main_id)
        squash = CommitORM(
            graph_id=graph.id,
            branch_id=main_id,
            commit_seq=graph.main_head_commit_seq + 1,
            parent_commit_id=main.head_commit_id,
            kind="squash_publish",
            message=message,
            actor=actor, **commit_provenance(actor),
            contributors=contributors,
            source_branch_id=draft.id,
            source_commit_ids=source_commits,
            source_commit_count=len(source_commits),
            originating_view_id=draft.originating_view_id,
        )
        s.add(squash)
        await s.flush()
        return squash

    async def _finish_squash(self, s, graph, draft, main_id, squash, deltas: List[Delta], actor,
                             merged_via: str) -> str:
        """What every squash does once its rows are written: ``main``'s head and Merkle root
        advance, the draft is merged, and the projection is pointed at the new head. ``deltas``
        need only their ids, ops and hashes."""
        new_seq = squash.commit_seq
        main = await s.get(BranchORM, main_id)
        main.head_commit_id = squash.id
        graph.main_head_commit_seq = new_seq       # advance head before merkle
        main_activity.note(s, graph, squash)
        squash.merkle_root = await self._commit_merkle(s, graph.id, main_id, squash, deltas)
        squash.stats = _delta_stats(deltas)
        return await self._squash_landed(s, graph, draft, squash, actor, merged_via)

    async def _squash_landed(self, s, graph, draft, squash, actor, merged_via: str) -> str:
        """What every squash does once ``main``'s head is at it: the draft is merged and the
        projection is pointed at the new head."""
        new_seq = squash.commit_seq
        graph.updated_at = _now()
        draft.status = "merged"
        draft.base_commit_seq = new_seq            # rebased onto new main

        # The branch is now merged, so every PR raised from it is settled — its changes ARE on main.
        # Leaving them live (what `publish` used to do) stranded a PR pointing at a dead branch:
        # unmergeable (`_require_open` rejects it) yet still rendered as actionable, with an empty
        # diff. Resolve them all here, in the shared body, so no squash path can skip it.
        await self._resolve_live_prs(s, draft.id, squash.id, actor, merged_via)

        ps = await s.get(ProjectionStateORM, graph.id)
        if ps is not None:
            ps.target_commit_seq = new_seq
        return squash.id

    @staticmethod
    def _narrow_squash(graph, draft, resolutions) -> bool:
        """Whether a squash of ``draft`` may take :meth:`_squash_up_to_date`: it is up to date with
        ``main``, the graph is not a fork, and no conflict is being resolved."""
        return (config.NARROW_SQUASH and not graph.fork_parent_graph_id and not resolutions
                and (draft.base_commit_seq or 0) == graph.main_head_commit_seq)

    async def _squash_up_to_date(
        self, s, graph, draft, main_id, actor, message, *,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        merged_via: str = "review",
    ) -> str:
        """:meth:`_apply_draft_squash` for the common publish (:meth:`_narrow_squash`), at any size.

        ``main`` has not moved since the draft branched, so the 3-way merge of every entity the
        draft changed is the draft's own value (``three_way_merge(base, ours, base) == ours``):
        nothing has to be merged, and what changed can be told from content hashes — the draft's
        heads against ``main``'s. The full path loads every changed payload (twice: main's and the
        draft's), merges and re-hashes each one in this process under the graph's lock, and at 200k
        changes that was over a gigabyte. Here the plan is built from hashes, the gates judge the
        version rows' identity columns (the only fields they read), and the rows are copied from
        the draft's inside Postgres, keeping their stored hashes. The one exception is a row whose
        type the ontology spells differently: its payload is canonicalized and re-hashed in Python,
        as the full path does. The outcome is the full path's: the same rows, heads, stats, Merkle
        root, cascade and violations, in one transaction under ``_lock_graph``. A draft that changed
        more than ``SQUASH_PAGED_ABOVE`` entities goes a page at a time (:meth:`_squash_paged`)."""
        gid, head_seq = graph.id, graph.main_head_commit_seq
        changed = (await s.execute(select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == draft.id))).scalar_one()
        if changed > config.SQUASH_PAGED_ABOVE:
            return await self._squash_paged(
                s, graph, draft, main_id, actor, message,
                containment_edge_types=containment_edge_types, ontology_rules=ontology_rules,
                merged_via=merged_via)
        heads = await self._head_index(s, gid, draft.id)
        main = await self._hashes_at(s, gid, main_id, list(heads), head_seq)
        live = {eid for eid, h in heads.items() if h.live and h.table}
        dead = {eid for eid in heads if eid not in live}          # the merged state's tombstones

        # A deleted node takes the edges on it — the draft's own and main's (the full path's
        # _hydrate_merge_neighborhood + _cascade_incident_edges).
        hydrated = {eid: v for eid, v in (await self._incident_live_edge_skeletons(
            s, gid, main_id, sorted(dead)) if dead else {}).items() if eid not in heads}
        gone = {eid for eid in live
                if heads[eid].src and (heads[eid].src in dead or heads[eid].tgt in dead)}
        cascaded = sorted(eid for eid, v in hydrated.items() if v.get("sourceEntityId")
                          and (v["sourceEntityId"] in dead or v.get("targetEntityId") in dead))

        # Every edge left standing needs both ends standing (_assert_referential_integrity).
        standing = [(eid, heads[eid].src or None, heads[eid].tgt or None)
                    for eid in sorted(live - gone) if heads[eid].table == "edge"]
        standing += [(eid, v.get("sourceEntityId"), v.get("targetEntityId"))
                     for eid, v in sorted(hydrated.items()) if eid not in cascaded]
        outside = sorted({e for _eid, a, b in standing for e in (a, b) if e and e not in heads})
        ends = await self._skeletons_at(s, gid, main_id, outside, head_seq) if outside else {}

        for eid, a, b in standing:
            if not (a or b):
                continue
            for e in (a, b):
                if not (e and ((e in live and e not in gone) if e in heads
                               else ends.get(e) is not None)):
                    raise ConcurrencyError(f"edge {eid} would dangle (endpoint tombstoned): {a}->{b}")

        def reread(h: _Head) -> bool:
            if h.table == "edge" and not h.type:
                return True                   # its type may be spelled in the payload alone
            if ontology_rules is None or not h.type:
                return False
            canon = (ontology_rules.canonical_entity_type(h.type) if h.table == "node"
                     else ontology_rules.canonical_edge_type(h.type))
            return bool(canon) and canon != h.type

        # Pure CPU over every entity the draft changed (200k at a large publish): off the loop.
        rows, lane = await asyncio.to_thread(_plan_squash, heads, main, gone, reread)
        # The Python lane: the payload, canonicalized and hashed as the full path does.
        deltas: List[Delta] = []
        if lane:
            payload_of = await self._payloads_by_version(
                s, [(heads[eid].table, gid, heads[eid].version_id) for eid in lane])
            for eid in lane:
                p = payload_of.get(heads[eid].version_id)
                if p:
                    canonicalize_payload_types(p, ontology_rules)
                b = main.get(eid)
                if p and b is None:
                    deltas.append(Delta(eid, "create", p, None, content_hash(p)))
                elif not p and b is not None:
                    deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
                elif p and content_hash(p) != b.content_hash:
                    deltas.append(Delta(eid, "update", p, b.content_hash, content_hash(p)))
        if cascaded:
            for eid, b in (await self._hashes_at(s, gid, main_id, cascaded, head_seq)).items():
                deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
        deltas += [Delta(r.entity_id, "delete", None, r.prev_content_hash, r.content_hash)
                   for r in rows if r.op == "delete"]
        copies = [r for r in rows if r.op != "delete"]
        if not deltas and not copies:
            return await self._merged_unchanged(s, graph, draft, actor, merged_via)

        squash = await self._squash_commit(s, graph, draft, main_id, actor, message)

        # The gates, on what the squash writes, in entity order as the full path judges it.
        kind_by_entity = {r.entity_id: r.kind for r in rows}
        kind_by_entity.update({eid: heads[eid].table for eid in lane})
        kind_by_entity.update({eid: "edge" for eid in cascaded})
        written = await asyncio.to_thread(_written_values, copies, heads, deltas)
        prior = await self._skeletons_at(s, gid, main_id, list(written), head_seq)
        strict = graph.ontology_enforcement == "strict"
        known: Optional[Dict[str, Optional[dict]]] = None
        if strict and ontology_rules is not None:     # the only gate that types the edges' ends
            # What the written edges' ends are, as the full path's merged state holds them (canonical).
            known = {eid: dict(v) if v else v for eid, v in ends.items()}
            known.update({eid: (_head_skeleton(h) if eid in live and eid not in gone else None)
                          for eid, h in heads.items()})
            for v in known.values():
                canonicalize_payload_types(v, ontology_rules)
        ontology = Ontology.from_spec(graph.ontology_spec)   # PR re-validation gate (§16.5 #6)
        if ontology is not None and strict:
            viol = validate_entities(
                [(eid, kind_by_entity.get(eid, "node"), v) for eid, v in written.items() if v is not None],
                ontology)
            if viol:
                raise OntologyViolation(viol)
        await self._enforce_written(
            s, gid, main_id, written, prior, kind_by_entity,
            containment_edge_types=containment_edge_types or [],
            ontology_rules=ontology_rules, strict=strict, known=known)
        unique = await self._unique_violations(s, gid, main_id, written, ontology_rules,
                                               source=(gid, draft.id))
        if unique:
            raise UniqueViolation(unique)
        del written, prior, known, heads, main, live, ends, standing   # per change: not into the writes

        await self._copy_versions(s, gid, main_id, squash, copies, actor)
        await self._write_deltas(s, gid, main_id, squash, deltas, kind_by_entity, actor,
                                 editors=await self._editors(s, gid, draft.id, deltas))
        deltas += [Delta(r.entity_id, r.op, None, r.prev_content_hash, r.content_hash) for r in copies]
        del rows, copies, kind_by_entity
        return await self._finish_squash(s, graph, draft, main_id, squash, deltas, actor, merged_via)

    async def _squash_paged(
        self, s, graph, draft, main_id, actor, message, *,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        merged_via: str = "review",
    ) -> str:
        """:meth:`_squash_up_to_date` for a draft that changed more than ``SQUASH_PAGED_ABOVE``
        entities: the same plan, gates and rows, ``SQUASH_PAGE`` of the draft's heads at a time,
        so the worker holds a page of the draft, never all of it. Still one commit, in one
        transaction under ``_lock_graph``: a refusal on any page writes nothing.

        Each page is written once judged, ``main``'s head already at the squash, so a page's gates
        see what the pages before it wrote, as one batch's gates see the whole batch. For that to
        judge what one batch would, nothing a page is judged by waits on a later page: the deletes
        go first (with the edges on a deleted node the draft left alone), then the nodes, then the
        edges re-pointed or changed, then the new edges. An edge's ends are typed from the draft's
        own view of them — ``main`` at its base, which is the head, where it left them alone — and
        whether a node is left outside every parent is asked last, of everything the squash wrote.
        Above ``BOOTSTRAP_MERKLE_INLINE_MAX`` changes the commit's Merkle root is left unset, as an
        enable of that size leaves its own."""
        gid, base = graph.id, graph.main_head_commit_seq
        strict = graph.ontology_enforcement == "strict"
        ontology = Ontology.from_spec(graph.ontology_spec) if strict else None
        cset = containment_edge_types or []
        stats = _delta_stats([])
        merkle: Optional[Dict[str, Optional[str]]] = {}
        squash: Optional[CommitORM] = None

        async def write(copies: List["_SquashRow"], deltas: List[Delta], kinds: Dict[str, str]):
            nonlocal squash, merkle
            if not copies and not deltas:
                return
            if squash is None:
                squash = await self._squash_commit(s, graph, draft, main_id, actor, message)
                (await s.get(BranchORM, main_id)).head_commit_id = squash.id
                graph.main_head_commit_seq = squash.commit_seq   # what later pages read
                main_activity.note(s, graph, squash)
            await self._copy_versions(s, gid, main_id, squash, copies, actor)
            await self._write_deltas(s, gid, main_id, squash, deltas, kinds, actor,
                                     editors=await self._editors(s, gid, draft.id, deltas))
            for op, eid, chash in ([(r.op, r.entity_id, r.content_hash) for r in copies]
                                   + [(d.op, d.entity_id, d.content_hash) for d in deltas]):
                stats[op] += 1
                if merkle is not None:
                    merkle[eid] = None if op == "delete" else chash
            if merkle is not None and len(merkle) > config.BOOTSTRAP_MERKLE_INLINE_MAX:
                merkle = None

        async def lane(heads: Mapping[str, "_Head"], ids: List[str], main: Mapping[str, "_Stored"]):
            """The Python lane (a type the ontology spells otherwise): payload read, canonicalized
            and hashed, as :meth:`_squash_up_to_date` does."""
            deltas: List[Delta] = []
            payload_of = await self._payloads_by_version(
                s, [(heads[eid].table, gid, heads[eid].version_id) for eid in ids])
            for eid in ids:
                p = payload_of.get(heads[eid].version_id)
                if p:
                    canonicalize_payload_types(p, ontology_rules)
                b = main.get(eid)
                if p and b is None:
                    deltas.append(Delta(eid, "create", p, None, content_hash(p)))
                elif not p and b is not None:
                    deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
                elif p and content_hash(p) != b.content_hash:
                    deltas.append(Delta(eid, "update", p, b.content_hash, content_hash(p)))
            return deltas

        def reread(h: _Head) -> bool:
            if h.table == "edge" and not h.type:
                return True
            if ontology_rules is None or not h.type:
                return False
            canon = (ontology_rules.canonical_entity_type(h.type) if h.table == "node"
                     else ontology_rules.canonical_edge_type(h.type))
            return bool(canon) and canon != h.type

        unique_seen: Dict[Tuple[str, str, str], set] = {}    # unique values the pages wrote

        async def judge(heads, copies, deltas, kinds):
            """The gates on what a page writes (:meth:`_squash_up_to_date`'s), against ``main`` as
            the pages before it left it."""
            written = await asyncio.to_thread(_written_values, copies, heads, deltas)
            if not written:
                return
            prior = await self._skeletons_at(s, gid, main_id, list(written), base)
            if ontology is not None:
                viol = validate_entities(
                    [(eid, kinds.get(eid, "node"), v) for eid, v in written.items() if v is not None],
                    ontology)
                if viol:
                    raise OntologyViolation(viol)
            await self._enforce_written(
                s, gid, main_id, written, prior, kinds, containment_edge_types=cset,
                ontology_rules=ontology_rules, strict=strict, also_writing=draft.id,
                parentless=False)
            unique = await self._unique_violations(s, gid, main_id, written, ontology_rules,
                                                   seen=unique_seen, source=(gid, draft.id))
            if unique:
                raise UniqueViolation(unique)

        # 1. What the draft deleted, and the edges on it that the draft left alone.
        async for heads in self._head_pages(s, gid, draft.id, live=False):
            main = await self._hashes_at(s, gid, main_id, list(heads), base)
            deltas = [Delta(eid, "delete", None, main[eid].content_hash, _HASH_NONE)
                      for eid in sorted(heads) if eid in main]
            kinds = {eid: heads[eid].kind for eid in heads}
            incident = await self._incident_live_edge_skeletons(s, gid, main_id, sorted(heads))
            mine = await self._heads_present(s, gid, draft.id, list(incident))
            cascaded = sorted(eid for eid, v in incident.items()
                              if eid not in mine and v.get("sourceEntityId"))
            for eid, b in (await self._hashes_at(s, gid, main_id, cascaded, base)).items():
                deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
                kinds[eid] = "edge"
            await write([], deltas, kinds)

        # 2. The nodes it created or changed (and a head whose version row is missing: a delete).
        async for heads in self._head_pages(s, gid, draft.id, live=True):
            heads = {eid: h for eid, h in heads.items() if h.table != "edge"}
            main = await self._hashes_at(s, gid, main_id, list(heads), base)
            rows, slow = await asyncio.to_thread(_plan_squash, heads, main, (), reread)
            deltas = (await lane(heads, slow, main) if slow else []) + [
                Delta(r.entity_id, "delete", None, r.prev_content_hash, r.content_hash)
                for r in rows if r.op == "delete"]
            copies = [r for r in rows if r.op != "delete"]
            kinds = {r.entity_id: r.kind for r in rows}
            kinds.update({eid: heads[eid].table for eid in slow})
            await judge(heads, copies, deltas, kinds)
            await write(copies, deltas, kinds)

        # 3 and 4. Its edges: re-pointed or changed ones (and those on a node it deleted, which go),
        # then new ones — so a new edge is judged against where the changed ones now point.
        for new in (False, True):
            async for heads in self._head_pages(s, gid, draft.id, live=True):
                heads = {eid: h for eid, h in heads.items() if h.table == "edge"}
                main = await self._hashes_at(s, gid, main_id, list(heads), base)
                heads = {eid: h for eid, h in heads.items() if (eid not in main) == new}
                if not heads:
                    continue
                # Its ends as the squash leaves them: the draft's where it changed them, else main's.
                ends = sorted({e for h in heads.values() for e in (h.src, h.tgt) if e})
                drafted = await self._heads_live(s, gid, draft.id, ends)
                outside = [e for e in ends if e not in drafted]
                stored = await self._skeletons_at(s, gid, main_id, outside, base) if outside else {}
                dead = {e for e, live in drafted.items() if not live}
                gone = {eid for eid, h in heads.items() if h.src and (h.src in dead or h.tgt in dead)}
                for eid, h in sorted(heads.items()):
                    if eid in gone or not (h.src or h.tgt):
                        continue
                    for e in (h.src, h.tgt):
                        if not (e and (drafted[e] if e in drafted else stored.get(e) is not None)):
                            raise ConcurrencyError(
                                f"edge {eid} would dangle (endpoint tombstoned): {h.src}->{h.tgt}")
                rows, slow = await asyncio.to_thread(_plan_squash, heads, main, gone, reread)
                deltas = (await lane(heads, slow, main) if slow else []) + [
                    Delta(r.entity_id, "delete", None, r.prev_content_hash, r.content_hash)
                    for r in rows if r.op == "delete"]
                copies = [r for r in rows if r.op != "delete"]
                kinds = {r.entity_id: r.kind for r in rows}
                kinds.update({eid: heads[eid].table for eid in slow})
                await judge(heads, copies, deltas, kinds)
                await write(copies, deltas, kinds)

        if squash is None:
            return await self._merged_unchanged(s, graph, draft, actor, merged_via)

        # 5. Nothing the squash created or un-nested is left outside every parent the ontology
        # requires one of — asked of what it wrote, now that all of it is there.
        if strict and ontology_rules is not None and ontology_rules.root_entity_types:
            async for ids in self._commit_entity_pages(s, gid, main_id, squash.commit_seq):
                written = await self._skeletons_at(s, gid, main_id, ids, squash.commit_seq)
                written.update({eid: None for eid in ids if eid not in written})
                prior = await self._skeletons_at(s, gid, main_id, ids, base)
                kinds = {eid: ("edge" if _is_edge_payload(v or prior.get(eid) or {}) else "node")
                         for eid, v in written.items()}
                viol = await self._parentless_violations(
                    s, gid, main_id, written, prior, kinds, ontology_rules)
                if viol:
                    raise OntologyViolation(viol)

        squash.stats = stats
        squash.merkle_root = (await self._merkle.commit_tree(
            s, gid, main_id, squash.id, squash.commit_seq, merkle) if merkle is not None else None)
        return await self._squash_landed(s, graph, draft, squash, actor, merged_via)

    async def _head_pages(self, s, graph_id: str, branch_id: str, *, live: bool):
        """A branch's heads, ``SQUASH_PAGE`` at a time in id order (a keyset on the primary key), as
        :meth:`_head_index` gives them: the live ones, or the rest (deleted, or an empty payload)."""
        conn = await s.connection()
        dead = or_(EntityHeadORM.is_tombstone.is_(True),
                   EntityHeadORM.content_hash.in_([_HASH_EMPTY, _HASH_NONE]))
        after = ""
        while True:
            page = (await conn.execute(
                select(EntityHeadORM.entity_id, EntityHeadORM.entity_kind,
                       EntityHeadORM.head_version_id, EntityHeadORM.content_hash,
                       EntityHeadORM.is_tombstone)
                .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
                       EntityHeadORM.entity_id > after, ~dead if live else dead)
                .order_by(EntityHeadORM.entity_id).limit(config.SQUASH_PAGE)
            )).all()
            if page:
                yield await self._heads_from_rows(conn, graph_id, page)
            if len(page) < config.SQUASH_PAGE:
                return
            after = page[-1][0]

    async def _commit_entity_pages(self, s, graph_id: str, branch_id: str, seq: int):
        """The ids of the entities a commit wrote, ``SQUASH_PAGE`` at a time in id order."""
        conn = await s.connection()
        for model in (NodeVersionORM, EdgeVersionORM):
            after = ""
            while True:
                ids = (await conn.execute(
                    select(model.entity_id).where(
                        model.graph_id == graph_id, model.branch_id == branch_id,
                        model.commit_seq == seq, model.entity_id > after)
                    .order_by(model.entity_id).limit(config.SQUASH_PAGE))).scalars().all()
                if ids:
                    yield list(ids)
                if len(ids) < config.SQUASH_PAGE:
                    break
                after = ids[-1]

    async def _editors(self, s, graph_id: str, branch_id: str, deltas: Sequence[Delta]) -> Dict[str, str]:
        """Who made each of ``deltas``' changes on ``branch_id`` — the actor of the entity's head
        version there — so a squash's version rows on ``main`` name the person who edited each
        entity, not whoever published the draft (the go-live review's HISTORY-1). An entity the
        draft didn't change itself (a cascade, a hydrated neighbour) names the publisher."""
        out: Dict[str, str] = {}
        ids = [d.entity_id for d in deltas]
        for model in (NodeVersionORM, EdgeVersionORM):
            for chunk in _chunks(ids, _IN_LIST_MAX):
                rows = await s.execute(
                    select(EntityHeadORM.entity_id, model.actor)
                    .join(model, and_(model.graph_id == EntityHeadORM.graph_id,
                                      model.id == EntityHeadORM.head_version_id))
                    .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
                           EntityHeadORM.entity_id.in_(chunk)))
                out.update({eid: who for eid, who in rows.all() if who})
        return out

    async def _copy_versions(self, s, graph_id, branch_id, commit, rows: Sequence["_SquashRow"],
                             actor, src_graph_id: Optional[str] = None) -> None:
        """Write ``rows`` onto ``branch_id`` as copies of the version rows they name — payload,
        identity columns and content hash taken inside Postgres (``INSERT … SELECT``), a chunk of
        ``_IN_LIST_MAX`` per statement — and point their heads at the copies. The rows are
        ``src_graph_id``'s (a fork a merge copies from), else ``graph_id``'s."""
        now = _now()
        for kind, stmt in (("node", _COPY_NODE_VERSIONS), ("edge", _COPY_EDGE_VERSIONS)):
            todo = [r for r in rows if r.kind == kind]
            for chunk in _chunks(todo, _IN_LIST_MAX):
                new_ids = [prefixed_id("nv" if kind == "node" else "ev") for _ in chunk]
                done = (await s.execute(stmt, {
                    "graph_id": graph_id, "src_graph": src_graph_id or graph_id,
                    "branch_id": branch_id, "commit_id": commit.id,
                    "commit_seq": commit.commit_seq, "actor": actor, "now": now,
                    "src": [r.version_id for r in chunk], "ids": new_ids,
                    "ops": [r.op for r in chunk], "prevs": [r.prev_content_hash for r in chunk],
                })).rowcount
                if done != len(chunk):
                    raise RuntimeError(f"squash copied {done} of {len(chunk)} {kind} versions: a "
                                       "source version row is missing")
                heads = [{"entity_id": r.entity_id, "entity_kind": kind, "head_version_id": vid,
                          "content_hash": r.content_hash, "is_tombstone": False}
                         for r, vid in zip(chunk, new_ids)]
                for i in range(0, len(heads), _HEAD_BATCH):
                    await self._upsert_heads(s, graph_id, branch_id, heads[i:i + _HEAD_BATCH], False)

    async def _squash_fork(
        self, s, parent: GraphORM, fork: GraphORM, took: int, actor: str, message: str, *,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        before_write: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> Tuple[Optional[CommitORM], List[dict]]:
        """Write a fork's review onto its parent's ``main``, the fork up to date with it (the
        caller's gate, under the parent's lock): the fork's own changes since its last merged review
        — its rows in ``(merge base, took]`` (:meth:`_fork_merge_base`) — each its value at ``took``
        against the parent's at its head, every difference a change: what :meth:`_fork_merge`
        previews. Planned from content hashes and copied from the fork's version rows inside
        Postgres, as a draft's narrow squash is (:meth:`_squash_paged`), in its order — what the
        review deletes (and the parent's edges on a node it deletes, when the review leaves them
        alone), its nodes, its edges re-pointed or changed, its new edges — each judged against what
        the steps before it wrote, by the gate every write shares and the parent's ontology (a
        strict one refuses; a permissive one's findings are returned). Past ``SQUASH_PAGED_ABOVE``
        changes, ``SQUASH_PAGE`` at a time: the worker holds a page of the review, never all of it.
        ``before_write`` runs once, before the first row is written (the review's approvals).

        One commit in the caller's transaction, a refusal anywhere writing nothing. Returns the
        squash (None: nothing differs) and the ontology findings."""
        gid, base = parent.id, parent.main_head_commit_seq
        parent_main = await self._main_branch_id(s, gid)
        fork_main = await self._main_branch_id(s, fork.id)
        since = await self._fork_merge_base(s, fork)
        n = await self._own_change_count(s, fork.id, fork_main, since, took, config.SQUASH_PAGED_ABOVE)
        page = config.SQUASH_PAGE if n > config.SQUASH_PAGED_ABOVE else None
        strict = parent.ontology_enforcement == "strict"
        ontology = Ontology.from_spec(parent.ontology_spec)
        cset = containment_edge_types or []
        stats = _delta_stats([])
        merkle: Optional[Dict[str, Optional[str]]] = None if parent.fork_parent_graph_id else {}
        findings: List[dict] = []
        squash: Optional[CommitORM] = None

        def review(ids):
            return self._review_heads(s, fork.id, fork_main, since, took, ids)

        async def merged_view(ids) -> Dict[str, Optional[dict]]:
            """Those of ``ids`` the review writes, as it writes them (an end typed, an edge judged)."""
            out: Dict[str, Optional[dict]] = {}
            for eid, h in (await review(ids)).items():
                v = _head_skeleton(h) if h.live and h.table else None
                if v:
                    canonicalize_payload_types(v, ontology_rules)
                out[eid] = v
            return out

        async def write(copies: List["_SquashRow"], deltas: List[Delta], kinds: Dict[str, str]):
            nonlocal squash, merkle
            if not copies and not deltas:
                return
            if squash is None:
                if before_write is not None:
                    await before_write()
                main = await s.get(BranchORM, parent_main)
                source = await self._branch_commit_ids(s, fork.id, fork_main)
                squash = CommitORM(
                    graph_id=gid, branch_id=parent_main, commit_seq=base + 1,
                    parent_commit_id=main.head_commit_id, kind="squash_publish", message=message,
                    actor=actor, **commit_provenance(actor), contributors=await self._branch_contributors(s, fork.id, fork_main),
                    source_branch_id=fork_main, source_commit_ids=source,
                    source_commit_count=len(source))
                s.add(squash)
                await s.flush()
                main.head_commit_id = squash.id
                parent.main_head_commit_seq = squash.commit_seq   # what later steps read
                main_activity.note(s, parent, squash)
            await self._copy_versions(s, gid, parent_main, squash, copies, actor, src_graph_id=fork.id)
            await self._write_deltas(s, gid, parent_main, squash, deltas, kinds, actor)
            for op, eid, chash in ([(r.op, r.entity_id, r.content_hash) for r in copies]
                                   + [(d.op, d.entity_id, d.content_hash) for d in deltas]):
                stats[op] += 1
                if merkle is not None:
                    merkle[eid] = None if op == "delete" else chash
            if merkle is not None and len(merkle) > config.BOOTSTRAP_MERKLE_INLINE_MAX:
                merkle = None

        async def lane(heads: Mapping[str, "_Head"], ids: List[str], held: Mapping[str, "_Stored"]):
            """The Python lane (a type the ontology spells otherwise), from the fork's payloads."""
            deltas: List[Delta] = []
            payload_of = await self._payloads_by_version(
                s, [(heads[eid].table, fork.id, heads[eid].version_id) for eid in ids])
            for eid in ids:
                p = payload_of.get(heads[eid].version_id)
                if p:
                    canonicalize_payload_types(p, ontology_rules)
                b = held.get(eid)
                if p and b is None:
                    deltas.append(Delta(eid, "create", p, None, content_hash(p)))
                elif not p and b is not None:
                    deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
                elif p and content_hash(p) != b.content_hash:
                    deltas.append(Delta(eid, "update", p, b.content_hash, content_hash(p)))
            return deltas

        def reread(h: _Head) -> bool:
            if h.table == "edge" and not h.type:
                return True
            if ontology_rules is None or not h.type:
                return False
            canon = (ontology_rules.canonical_entity_type(h.type) if h.table == "node"
                     else ontology_rules.canonical_edge_type(h.type))
            return bool(canon) and canon != h.type

        async def judge(heads, copies, deltas, kinds):
            written = await asyncio.to_thread(_written_values, copies, heads, deltas)
            if not written:
                return
            viol = validate_entities(
                [(eid, kinds.get(eid, "node"), v) for eid, v in written.items() if v is not None],
                ontology)
            if viol and strict:
                raise OntologyViolation(viol)
            findings.extend(viol)
            prior = await self._skeletons_at(s, gid, parent_main, list(written), base)
            await self._enforce_written(
                s, gid, parent_main, written, prior, kinds, containment_edge_types=cset,
                ontology_rules=ontology_rules, strict=strict, review=merged_view, parentless=False)
            unique = await self._unique_violations(s, gid, parent_main, written, ontology_rules,
                                                   source=(fork.id, fork_main))
            if unique:
                raise UniqueViolation(unique)

        async def planned(heads, held, gone=()):
            rows, slow = await asyncio.to_thread(_plan_squash, heads, held, gone, reread)
            deltas = (await lane(heads, slow, held) if slow else []) + [
                Delta(r.entity_id, "delete", None, r.prev_content_hash, r.content_hash)
                for r in rows if r.op == "delete"]
            copies = [r for r in rows if r.op != "delete"]
            kinds = {r.entity_id: r.kind for r in rows}
            kinds.update({eid: heads[eid].table for eid in slow})
            await judge(heads, copies, deltas, kinds)
            await write(copies, deltas, kinds)

        # 1. What the review deletes, and the parent's edges on it that the review leaves alone.
        async for heads in self._review_pages(s, fork.id, fork_main, since, took, page, live=False):
            held = await self._hashes_at(s, gid, parent_main, list(heads), base)
            deltas = [Delta(eid, "delete", None, held[eid].content_hash, _HASH_NONE)
                      for eid in sorted(heads) if eid in held]
            # The parent's kind, where the parent reads what it deletes: never the fork's row's.
            kinds = {eid: held[eid].kind for eid in heads if eid in held}
            incident = await self._incident_live_edge_skeletons(s, gid, parent_main, sorted(heads))
            mine = set(await review(list(incident))) if incident else set()
            cascaded = sorted(eid for eid, v in incident.items()
                              if eid not in mine and v.get("sourceEntityId"))
            for eid, b in (await self._hashes_at(s, gid, parent_main, cascaded, base)).items():
                deltas.append(Delta(eid, "delete", None, b.content_hash, _HASH_NONE))
                kinds[eid] = "edge"
            await write([], deltas, kinds)

        # 2. The nodes it creates or changes.
        async for heads in self._review_pages(s, fork.id, fork_main, since, took, page, live=True,
                                              table="node"):
            await planned(heads, await self._hashes_at(s, gid, parent_main, list(heads), base))

        # 3 and 4. Its edges: re-pointed or changed ones (and those on a node it deleted, which go),
        # then new ones — so a new edge is judged against where the changed ones now point.
        for new in (False, True):
            async for heads in self._review_pages(s, fork.id, fork_main, since, took, page,
                                                  live=True, table="edge"):
                held = await self._hashes_at(s, gid, parent_main, list(heads), base)
                heads = {eid: h for eid, h in heads.items() if (eid not in held) == new}
                if not heads:
                    continue
                # Its ends as the merge leaves them: the review's where it changes them, else the
                # parent's, which the fork reads the same (it is up to date).
                ends = sorted({e for h in heads.values() for e in (h.src, h.tgt) if e})
                changed = {eid: h.live for eid, h in (await review(ends)).items()}
                outside = [e for e in ends if e not in changed]
                stored = await self._skeletons_at(s, gid, parent_main, outside, base) if outside else {}
                dead = {e for e, live in changed.items() if not live}
                gone = {eid for eid, h in heads.items() if h.src and (h.src in dead or h.tgt in dead)}
                for eid, h in sorted(heads.items()):
                    if eid in gone or not (h.src or h.tgt):
                        continue
                    for e in (h.src, h.tgt):
                        if not (e and (changed[e] if e in changed else stored.get(e) is not None)):
                            raise ConcurrencyError(
                                f"edge {eid} would dangle (endpoint tombstoned): {h.src}->{h.tgt}")
                await planned(heads, held, gone)

        if squash is None:
            return None, findings

        # 5. Nothing the squash created or un-nested is left outside every parent the ontology
        # requires one of — asked of what it wrote, now that all of it is there.
        if strict and ontology_rules is not None and ontology_rules.root_entity_types:
            async for ids in self._commit_entity_pages(s, gid, parent_main, squash.commit_seq):
                written = await self._skeletons_at(s, gid, parent_main, ids, squash.commit_seq)
                written.update({eid: None for eid in ids if eid not in written})
                prior = await self._skeletons_at(s, gid, parent_main, ids, base)
                kinds = {eid: ("edge" if _is_edge_payload(v or prior.get(eid) or {}) else "node")
                         for eid, v in written.items()}
                viol = await self._parentless_violations(
                    s, gid, parent_main, written, prior, kinds, ontology_rules)
                if viol:
                    raise OntologyViolation(viol)

        squash.stats = stats
        squash.merkle_root = (await self._merkle.commit_tree(
            s, gid, parent_main, squash.id, squash.commit_seq, merkle) if merkle is not None else None)
        parent.updated_at = _now()
        ps = await s.get(ProjectionStateORM, gid)
        if ps is not None:
            ps.target_commit_seq = squash.commit_seq
        return squash, findings

    async def _review_pages(self, s, fork_id: str, fork_main: str, since: int, took: int,
                            page: Optional[int], *, live: bool, table: Optional[str] = None):
        """A fork's review, ``page`` entities at a time (all at once when None) in id order, a table
        after the other: what the fork changed in ``(since, took]`` as its row at ``took`` says
        (:meth:`_review_heads`) — the live ones, or the rest. ``table`` keeps to one."""
        for kind, model in (("node", NodeVersionORM), ("edge", EdgeVersionORM)):
            if table not in (None, kind):
                continue
            after = ""
            while True:
                stmt = (select(model.entity_id).where(
                    model.graph_id == fork_id, model.branch_id == fork_main,
                    model.commit_seq > since, model.commit_seq <= took, model.entity_id > after)
                    .distinct().order_by(model.entity_id))
                ids = (await s.execute(stmt.limit(page) if page else stmt)).scalars().all()
                heads = {eid: h for eid, h in (await self._review_heads(
                    s, fork_id, fork_main, since, took, ids)).items() if h.live == live}
                if heads:
                    yield heads
                if not page or len(ids) < page:
                    break
                after = ids[-1]

    async def _review_heads(self, s, fork_id: str, fork_main: str, since: int, took: int,
                            ids) -> Dict[str, "_Head"]:
        """Of ``ids``, those a fork changed in ``(since, took]``, each as its row at ``took`` says (a
        :class:`_Head`, without its payload); nothing for the rest."""
        ids = list(ids)
        if not ids:
            return {}
        conn = await s.connection()
        rows: List[tuple] = []
        for kind, model in (("node", NodeVersionORM), ("edge", EdgeVersionORM)):
            stmt = (select(model.entity_id, model.id, model.op, model.content_hash, model.commit_seq)
                    .where(model.graph_id == fork_id, model.branch_id == fork_main,
                           model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                           model.commit_seq <= took)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id))
            for chunk in _chunks(ids, _IN_LIST_MAX):
                rows += [(eid, kind, vid, chash, op == "delete") for eid, vid, op, chash, seq in
                         (await conn.execute(stmt, {"ids": list(chunk)})).all() if seq > since]
        return await self._heads_from_rows(conn, fork_id, rows)

    async def rebase_draft(
        self, *, graph_id: str, branch_id: str, actor: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        message: str = "pull latest from main",
    ) -> Dict[str, object]:
        """Pull the latest ``main`` into a draft ("update branch"): re-base the draft's edits onto
        current main with the same field-level 3-way merge as publish, but writing the result back
        into the DRAFT (the mirror of :meth:`_apply_draft_squash`). Same-field conflicts are returned
        (``{clean: False, conflicts}``) for resolution — resubmit with ``resolutions={entity_id:
        payload|None}``. On a clean rebase the draft's own edits are rewritten to the merged result
        and ``base_commit_seq`` advances to the current main head, so the draft is up-to-date and
        mergeable.

        A clean pull ALWAYS writes a ``pull`` commit on the draft, even when the draft's own edits
        needed no rewriting. It previously wrote a commit only when `deltas` was non-empty — and
        `deltas` covers only the entities the draft itself touched, so the ordinary case (upstream
        work that doesn't collide with yours) recorded *nothing*: `base_commit_seq` moved and the
        branch history showed a silent gap exactly where someone else's changes arrived. The commit
        carries the upstream commits it folded in (``source_commit_ids``/``source_commit_count``/
        ``contributors``), so history can say "pulled N changes from Published" and drill into them.

        Returns ``{clean, conflicts, changes, incoming, base_commit_seq}`` where ``changes`` is the
        rewrite to YOUR edits and ``incoming`` is what came in from main. They are different things:
        conflating them is why the UI could only ever report the former.

        ``_retry_seq``-wrapped like every other commit-writing path. It has to be, now that a pull
        ALWAYS commits: two concurrent pulls on one draft would otherwise both allocate the same
        ``commit_seq`` and one would die on ``uq_commits_branch_seq``. (It escaped that before only
        because the common case wrote no commit at all.) On retry the loser re-reads the draft, finds
        ``base_commit_seq`` already advanced, and returns ``already_up_to_date`` — one pull lands,
        the other is correctly a no-op."""
        return await self._retry_seq(
            f"rebase {branch_id}",
            lambda: self._rebase_draft_once(
                graph_id=graph_id, branch_id=branch_id, actor=actor,
                resolutions=resolutions, message=message,
            ),
        )

    async def _rebase_draft_once(
        self, *, graph_id: str, branch_id: str, actor: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        message: str = "pull latest from main",
    ) -> Dict[str, object]:
        """One attempt at :meth:`rebase_draft` — re-run wholesale by ``_retry_seq`` on a seq
        collision, so it must re-read all state from a fresh session (it does)."""
        async with self._session() as s:
            await self._lock_lifecycle(s, graph_id, shared=True)
            await self._assert_writable(s, graph_id)
            # The draft's lock first, so main's head is read after any save, checkpoint or pull of
            # this draft that held it has committed.
            draft = await self._lock_branch(s, graph_id, branch_id)
            if draft.kind == "main":
                raise MainWriteForbidden()
            self._require_open(draft)
            await self._require_edit(s, draft, actor, ())
            graph = await s.get(GraphORM, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            from_seq = draft.base_commit_seq or 0
            to_seq = graph.main_head_commit_seq
            if from_seq >= to_seq:
                return {"clean": True, "conflicts": [], "changes": _delta_stats([]),
                        "incoming": _EMPTY_INCOMING, "base_commit_seq": draft.base_commit_seq,
                        "already_up_to_date": True}

            # The draft's own edits, read once: the merge and the rewrite below use the same read.
            own = await self._branch_own_payloads(s, graph_id, draft.id)
            merged_state, conflicts, theirs = await self._compute_merge_bounded(
                s, graph_id, graph, draft, main_id, dict(resolutions or {}), own=own
            )
            if conflicts:
                # The draft's own value of each conflicting entity, to resolve from — just those.
                seeds = await self._current_values(
                    s, graph_id, branch_id, sorted({c["entity_id"] for c in conflicts}))
                return {"clean": False, "conflicts": conflicts, "seeds": seeds}

            # What arrived from main in (from_seq, to_seq] — the record of what this pull brought in.
            incoming = await self._incoming_from_main(s, graph_id, main_id, from_seq, to_seq)

            # Rewrite ONLY the draft's own edits to the merged result, then re-base onto the new main
            # head — entities the draft never touched come from the advanced base automatically.
            # The merge holds only what changed: the edges on what it deletes and the ends of the
            # edges it keeps come from main, for the cascade and integrity checks below.
            await self._hydrate_merge_neighborhood(s, graph_id, main_id, merged_state, theirs)
            self._cascade_incident_edges(merged_state)
            self._assert_referential_integrity(merged_state)
            deltas = net_delta(own, {eid: merged_state.get(eid) for eid in own})

            # ALWAYS commit. The version rows written are still only the draft's own rebased edits
            # (a draft must hold nothing but its own changed entities — `_composed_state` depends on
            # it), so with no rewrites this is a commit with no version rows. That is fine and
            # intended: genesis has none either. The COMMIT ROW is the record; the version rows are
            # the data. Without this, the pull is invisible.
            kind_by_entity = await self._kind_map_multi(
                s, [(graph_id, draft.id), (graph_id, main_id)],
                entity_ids=[d.entity_id for d in deltas],
            ) if deltas else {}
            commit = CommitORM(
                graph_id=graph_id, branch_id=draft.id,
                commit_seq=await self._next_seq(s, graph_id, draft.id),
                parent_commit_id=draft.head_commit_id, kind="pull",
                message=message, actor=actor, **commit_provenance(actor),
                originating_view_id=draft.originating_view_id,
                source_branch_id=main_id,
                source_commit_ids=incoming["commit_ids"] or None,
                source_commit_count=incoming["commit_count"],
                contributors=incoming["contributors"] or None,
            )
            s.add(commit)
            await s.flush()
            await self._write_deltas(s, graph_id, draft.id, commit, deltas, kind_by_entity, actor,
                                     occ_guard=True)
            commit.merkle_root = None              # a draft carries no fingerprint (_commit_merkle)
            # `stats` describes what CAME IN, not the rewrite to your own edits — it's what the user
            # means by "what did I just pull". The rebase of your edits is reported separately as
            # `changes`, and its version rows are the commit's actual data.
            commit.stats = dict(incoming["stats"])
            commit.stats["rebased"] = _delta_stats(deltas)
            commit.stats["from_seq"] = from_seq
            commit.stats["to_seq"] = to_seq
            draft.head_commit_id = commit.id

            draft.base_commit_seq = to_seq
            draft.updated_at = _now()
            return {"clean": True, "conflicts": [], "changes": _delta_stats(deltas),
                    "incoming": incoming, "base_commit_seq": draft.base_commit_seq}

    async def diff_window(
        self, *, graph_id: str, branch_id: str, from_seq: int, to_seq: int,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, list]:
        """Whole-payload before/after diff of a branch between two seqs — the ``DiffVsMainResponse``
        shape the Changes panel and the canvas overlay consume.

        Distinct from :meth:`diff_commits`, which answers the same question in an **id-keyed** shape
        (`added: [id]`, `modified: {id: fields}`). That's enough to *count* what changed but not to
        *show* it: with no payloads the UI can only render raw URNs instead of names. This is what
        lets "what came in when I pulled" be reviewed in the same visual language as every other diff.

        **O(changed)**, same two-phase technique as `diff_commits`: scan only the version rows in
        ``(from_seq, to_seq]``, then resolve those entities at each endpoint. A window past
        ``DIFF_TREE_MAX_CHANGES`` entities is :class:`DiffTooLarge`; its change list
        (:meth:`change_entries`) pages it instead."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            self._require_changes(branch)
            too_large = await self._window_too_large(s, graph_id, branch_id, from_seq, to_seq)
            if too_large is not None:
                raise DiffTooLarge(too_large, config.DIFF_TREE_MAX_CHANGES)
            changed = await self._changed_in_window(s, graph_id, branch_id, from_seq, to_seq)
            if not changed:
                return {"added": [], "removed": [], "modified": []}
            before = await self._values_at(s, graph_id, branch_id, changed, from_seq)
            after = await self._values_at(s, graph_id, branch_id, changed, to_seq)
            added: List[dict] = []
            removed: List[dict] = []
            modified: List[dict] = []
            for eid in changed:
                was, now = before.get(eid), after.get(eid)
                kind = "edge" if _is_edge_payload(now or was or {}) else "node"
                if was is None and now is not None:
                    added.append({"entityId": eid, "kind": kind, "after": now})
                elif was is not None and now is None:
                    removed.append({"entityId": eid, "kind": kind, "before": was})
                elif was is not None and now is not None and was != now:
                    modified.append({"entityId": eid, "kind": kind, "before": was, "after": now})
            return {"added": added, "removed": removed, "modified": modified}

    async def _incoming_from_main(
        self, s, graph_id: str, main_id: str, from_seq: int, to_seq: int,
    ) -> Dict[str, object]:
        """What arrived on ``main`` in ``(from_seq, to_seq]`` — the payload of a pull.

        Two halves, both **O(changed)**, never O(graph):
          • the commits folded in (ids, count, distinct actors) — the provenance a `pull` commit
            records, and what the "merged N commits" drill-down reads back;
          • the NET effect on state, classified create/update/delete by resolving the changed
            entities at each endpoint (the same technique as :meth:`diff_commits`). Net, not the sum
            of each commit's own stats: an entity created and then renamed upstream arrived once, and
            telling the user "2 changes" for it would be a lie.

        The full field-level diff is deliberately NOT computed here — the client fetches it from the
        existing ``diff`` endpoint on main with these same seqs, which already handles the fork-CoW
        and inherited-entity cases."""
        rows = (await s.execute(
            select(CommitORM.id, CommitORM.actor)
            .where(CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                   CommitORM.commit_seq > from_seq, CommitORM.commit_seq <= to_seq)
            .order_by(CommitORM.commit_seq)
        )).all()
        commit_ids = [r[0] for r in rows]
        contributors = list(dict.fromkeys([r[1] for r in rows if r[1]]))   # distinct, order-stable

        stats = {"create": 0, "update": 0, "delete": 0}
        changed = await self._changed_in_window(s, graph_id, main_id, from_seq, to_seq)
        if changed:
            # Told from content hashes, as the change index tells them — a pull after a large
            # publish counts what came in without loading every payload at both ends.
            before = await self._hashes_at(s, graph_id, main_id, changed, from_seq)
            after = await self._hashes_at(s, graph_id, main_id, changed, to_seq)
            for eid in changed:
                was, now = before.get(eid), after.get(eid)
                if was is None and now is not None:
                    stats["create"] += 1
                elif was is not None and now is None:
                    stats["delete"] += 1
                elif was is not None and now is not None and was.content_hash != now.content_hash:
                    stats["update"] += 1
        return {
            # The window is a range of MAIN's commit_seqs, and commit_seq is per-BRANCH — so the
            # branch it applies to has to travel with it. Without this the client has to source the
            # main branch id from somewhere else, and the one place it lives (branchStore, populated
            # by the canvas's BranchSwitcher) is empty when a reviewer pulls from the Reviews inbox,
            # where no canvas is mounted. Self-describing payload; no client state required.
            "branch_id": main_id,
            "commit_ids": commit_ids,
            "commit_count": len(commit_ids),
            "contributors": contributors,
            "stats": stats,
            "from_seq": from_seq,
            "to_seq": to_seq,
        }

    async def abandon_draft(
        self, *, graph_id: str, branch_id: str, actor: str,
        actor_groups: Sequence[str] = (),
    ) -> dict:
        """Mark an open draft ``abandoned`` (plan §17 #8): it becomes inert — no
        further stage/checkpoint/publish. Re-abandoning is idempotent; ``main`` and
        already-merged drafts cannot be abandoned. The owner abandons it, or a maintainer of
        a shared draft. Staged rows are left in place for audit (the branch is simply unreachable),
        until the retention window removes the draft's changes (:meth:`prune_closed_drafts`)."""
        async with self._session() as s:
            branch = await self._lock_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise ValueError("cannot abandon main")
            if branch.status == "abandoned":
                return self._branch_meta(branch)          # idempotent
            self._require_open(branch)                    # merged/publishing → reject
            await self._require_manage(s, branch, actor, actor_groups)
            branch.status = "abandoned"
            branch.updated_at = _now()
            return self._branch_meta(branch)

    async def update_branch(
        self, *, graph_id: str, branch_id: str, actor: str, actor_groups: Sequence[str] = (),
        name: Optional[str] = None, description: Optional[str] = None,
    ) -> dict:
        """Edit a draft's metadata — display ``name`` and optional ``description``. Its owner and
        maintainers may; who it is shared with changes through its members, and its level through
        its own route. ``main`` is immutable and a terminal (merged/abandoned) branch is read-only.
        Only the fields passed are changed (``None`` = leave as-is; pass ``""`` to clear
        name/description). Returns the updated branch meta."""
        async with self._session() as s:
            branch = await self._lock_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                raise ValueError("cannot edit the main branch")
            self._require_open(branch)
            if branch.owner != actor:
                await self._require_manage(s, branch, actor, actor_groups)   # raises AccessDenied
            if name is not None:
                branch.name = name.strip() or None
            if description is not None:
                branch.description = description.strip() or None
            branch.updated_at = _now()
            return self._branch_meta(branch)

    async def sweep_idle_drafts(
        self, *, now: Optional[datetime] = None, ttl_days: Optional[int] = None,
    ) -> List[str]:
        """Auto-abandon open drafts idle past the TTL (plan §17 #8) and return the
        ids swept. One ``UPDATE … RETURNING`` — O(stale), atomic. Only ``open``
        drafts/fork-drafts are touched; ``main`` and terminal branches are left be.
        ``updated_at`` is the idle clock (bumped by checkpoint/publish/abandon).
        An idle draft still in use is kept: one with a live PR, staged (uncheckpointed)
        work, or on a deleted graph (its purge owns it). A ``publishing`` draft is not open.
        Nor is a frozen graph's draft touched — nobody can edit it — and its clock restarts at
        the unfreeze (``lifecycle_changed_at``), so a freeze never costs a draft."""
        ttl = config.DRAFT_TTL_DAYS if ttl_days is None else ttl_days
        cutoff = ((now or datetime.now(timezone.utc)) - timedelta(days=ttl)).isoformat()
        live_pr = select(1).where(MergeRequestORM.source_branch_id == BranchORM.id,
                                  MergeRequestORM.status.not_in(_TERMINAL_PR_STATUS))
        staged = select(1).where(WorkingChangeORM.graph_id == BranchORM.graph_id,
                                 WorkingChangeORM.branch_id == BranchORM.id,
                                 WorkingChangeORM.committed_into_commit_id.is_(None))
        held = select(1).where(GraphORM.id == BranchORM.graph_id, or_(
            GraphORM.deleted_at.isnot(None), GraphORM.lifecycle_state != "live",
            GraphORM.lifecycle_changed_at >= cutoff))
        async with self._session() as s:
            swept = (await s.execute(
                update(BranchORM)
                .where(
                    BranchORM.kind.in_(("draft", "fork_draft")),
                    BranchORM.status == "open",
                    BranchORM.updated_at < cutoff,
                    ~live_pr.exists(), ~staged.exists(), ~held.exists(),
                )
                .values(status="abandoned", updated_at=_now())
                .returning(BranchORM.id)
            )).scalars().all()
            return list(swept)

    async def release_publishing(
        self, *, graph_id: Optional[str] = None, branch_id: Optional[str] = None,
    ) -> List[str]:
        """Reopen the ``publishing`` drafts whose publish job ended without landing — refused,
        failed, poisoned or timed out — and return their ids. Its lease makes a pending or running
        job the whole definition of a live one, so no clock is read here. A draft whose row is
        locked is skipped, not waited on: after the wait this statement would not see the job a
        concurrent ``create_publish_job`` just queued, and would reopen its draft. Never waiting on a
        branch, it cannot invert the branch-before-job lock order, whatever its caller holds."""
        b = aliased(BranchORM)
        live_job = select(JobORM.id).where(
            JobORM.job_type == "publish", JobORM.branch_id == b.id,
            JobORM.status.in_(("pending", "running")))
        stuck = select(b.id).where(b.status == "publishing", ~live_job.exists())
        if graph_id is not None:
            stuck = stuck.where(b.graph_id == graph_id)
        if branch_id is not None:
            stuck = stuck.where(b.id == branch_id)
        async with self._session() as s:
            return list((await s.execute(
                update(BranchORM)
                .where(BranchORM.id.in_(stuck.with_for_update(key_share=True, skip_locked=True)))
                .values(status="open", updated_at=_now())
                .returning(BranchORM.id)
                .execution_options(synchronize_session=False)
            )).scalars().all())

    async def prune_closed_drafts(
        self, *, older_than_days: int, budget_secs: Optional[float] = None,
        now: Optional[datetime] = None, graph_id: Optional[str] = None,
    ) -> List[str]:
        """Remove the changes of drafts merged or abandoned more than ``older_than_days`` ago, and
        return the ids of those whose removal finished. A merged draft's changes are in ``main`` —
        the publish copied them there, so nothing on ``main`` reads the draft's rows — and an
        abandoned one's were never published. Each keeps its record: the branch row, its members,
        its commits and its review.

        A draft is closed at ``updated_at``, which a publish or an abandon sets, and it is kept
        while something may still need its rows: a live review, a pending or running job, or a
        deleted or frozen graph (whose clock restarts at the unfreeze), as :meth:`sweep_idle_drafts`
        keeps an idle one. ``pruned_at`` is set first, so reads of its changes are refused
        (:meth:`_require_changes`) before any row goes; then its rows are deleted in windows, each
        its own transaction, until they are gone (``prune_finished_at``). Neither stamp moves
        ``updated_at``.

        Spends at most ``budget_secs`` (``DRAFT_PRUNE_PASS_SECS``): a removal cut off is carried on
        first by the next pass, wherever it runs. Two workers on one draft only repeat each
        other's deletes; it is called finished only once none of its rows is found. ``graph_id``
        keeps the pass to one graph's drafts."""
        from .purge_worker import delete_window

        deadline = time.monotonic() + (config.DRAFT_PRUNE_PASS_SECS if budget_secs is None
                                       else budget_secs)
        cutoff = ((now or datetime.now(timezone.utc)) - timedelta(days=older_than_days)).isoformat()
        # The oldest draft due, as its own aliased select so it is not correlated with the UPDATE
        # that marks it; a row another worker is marking is skipped, not waited on.
        b = aliased(BranchORM)
        live_pr = select(1).where(MergeRequestORM.source_branch_id == b.id,
                                  MergeRequestORM.status.not_in(_TERMINAL_PR_STATUS))
        live_job = select(1).where(JobORM.branch_id == b.id, JobORM.status.in_(("pending", "running")))
        held = select(1).where(GraphORM.id == b.graph_id, or_(
            GraphORM.deleted_at.isnot(None), GraphORM.lifecycle_state != "live",
            GraphORM.lifecycle_changed_at >= cutoff))
        due = (select(b.id).where(
            b.kind.in_(("draft", "fork_draft")), b.status.in_(("merged", "abandoned")),
            b.pruned_at.is_(None), b.updated_at < cutoff,
            ~live_pr.exists(), ~live_job.exists(), ~held.exists(),
        ).order_by(b.updated_at).limit(1).with_for_update(skip_locked=True))
        under_way = select(BranchORM.id, BranchORM.graph_id).where(
            BranchORM.pruned_at.isnot(None), BranchORM.prune_finished_at.is_(None),
        ).order_by(BranchORM.pruned_at).limit(1)
        if graph_id is not None:
            due, under_way = due.where(b.graph_id == graph_id), under_way.where(BranchORM.graph_id == graph_id)
        finished: List[str] = []
        while time.monotonic() < deadline:
            async with self._session() as s:
                row = (await s.execute(under_way)).first()
                if row is None:
                    row = (await s.execute(
                        update(BranchORM).where(BranchORM.id.in_(due))
                        .values(pruned_at=_now(), updated_at=BranchORM.updated_at)
                        .returning(BranchORM.id, BranchORM.graph_id)
                        .execution_options(synchronize_session=False))).first()
            if row is None:
                break                                    # nothing is due
            branch_id, gid = row
            removed, gone = 0, True
            for table, order in _DRAFT_ROWS:
                while True:
                    if time.monotonic() >= deadline:
                        gone = False
                        break
                    async with self._session() as s:
                        n = await delete_window(s, table, order, gid, where="branch_id = :b",
                                                params={"b": branch_id})
                    removed += n
                    if n == 0:
                        break
                if not gone:
                    break
            if gone:
                # A window another worker emptied at the same moment deleted nothing here: look again.
                async with self._session() as s:
                    for table, _order in _DRAFT_ROWS:
                        if (await s.execute(text(
                                f'SELECT 1 FROM "{config.graphver_schema()}"."{table}" '
                                "WHERE graph_id = :g AND branch_id = :b LIMIT 1"),
                                {"g": gid, "b": branch_id})).first() is not None:
                            gone = False
                            break
                    if gone:
                        await s.execute(
                            update(BranchORM).where(BranchORM.id == branch_id,
                                                    BranchORM.prune_finished_at.is_(None))
                            .values(prune_finished_at=_now(), updated_at=BranchORM.updated_at)
                            .execution_options(synchronize_session=False))
                        finished.append(branch_id)
            logger.info("removed %d rows of closed draft %s on graph %s%s", removed, branch_id,
                        gid, "" if gone else "; carried on next pass")
        return finished

    @staticmethod
    def _require_changes(branch: BranchORM) -> None:
        """:class:`DraftPruned` for a closed draft whose changes were removed
        (:meth:`prune_closed_drafts`): a read of them would find ``main`` alone, and say the draft
        changed nothing. Its record still reads."""
        if branch.pruned_at is not None:
            raise DraftPruned(branch.id, branch.pruned_at)

    async def set_frozen(self, *, graph_id: str, frozen: bool, expected_rev: int) -> Dict[str, object]:
        """Pause (``frozen``) or resume editing of a graph: every content write is refused while
        it is frozen (:meth:`_assert_writable`); reads, exports and projection go on.

        A compare-and-set on ``lifecycle_rev``, under the graph lock and the row FOR UPDATE (doc 15
        §7), so it waits for the writes in flight. A graph already in the asked state answers
        ``changed: False`` whatever ``expected_rev`` says, so a retried freeze is not a conflict;
        otherwise a stale ``expected_rev`` is :class:`VersionConflict`. A trashed or unknown graph
        is ``ValueError``. Not retried: a busy graph is :class:`LockBusy`, for the person to retry.
        A graph in any other state (one a later schema stores) is :class:`GraphNotWritable`, and one
        whose enablement has not finished is not frozen (:class:`ConcurrencyError`): its import
        commit still lands on main."""
        to = "frozen" if frozen else "live"
        async with self._session() as s:
            await self._lock_lifecycle(s, graph_id)
            await self._lock_graph(s, graph_id)
            g = (await self._bounded_lock(s, select(GraphORM).where(GraphORM.id == graph_id)
                 .with_for_update().execution_options(populate_existing=True),
                 f"graph {graph_id}")).scalar_one_or_none()
            if g is None or g.deleted_at is not None:
                raise ValueError(f"unknown graph {graph_id}")
            if g.lifecycle_state not in ("live", "frozen"):
                raise GraphNotWritable(g.lifecycle_state)
            if frozen:
                await self._assert_not_bootstrapping(s, graph_id)
            changed = g.lifecycle_state != to
            if changed:
                if g.lifecycle_rev != expected_rev:
                    raise VersionConflict("lifecycle", g.lifecycle_rev)
                g.lifecycle_state, g.lifecycle_rev, g.lifecycle_changed_at = to, g.lifecycle_rev + 1, _now()
            return {"graph_id": graph_id, "state": g.lifecycle_state, "rev": g.lifecycle_rev,
                    "changed": changed}

    async def preview_merge(self, *, graph_id: str, branch_id: str) -> Dict[str, object]:
        """Dry-run the publish merge: report conflicts + change counts without
        committing, so the UI can resolve before publishing."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            draft = await s.get(BranchORM, branch_id)
            if graph is None or draft is None:
                raise ValueError("unknown graph/branch")
            main_id = await self._main_branch_id(s, graph_id)
            merged_state, conflicts, theirs = await self._compute_merge_bounded(
                s, graph_id, graph, draft, main_id, {}
            )
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged_state)),
            }

    async def revert_commit(
        self, *, graph_id: str, commit_id: str, actor: str, message: Optional[str] = None,
    ) -> str:
        """Apply the inverse of a published commit as a new ``revert`` commit on
        main (plan §17): restore every entity that commit touched to its
        pre-commit state. If a later commit also changed one of those entities the
        revert can't apply cleanly and raises :class:`MergeConflict`. Deleting a
        node on revert cascades to its incident edges, same as publish. A fork's
        Update from parent is not reverted (:class:`CrossesUpdate`)."""
        return await self._retry_seq(
            f"revert {commit_id}",
            lambda: self._revert_commit_once(
                graph_id=graph_id, commit_id=commit_id, actor=actor, message=message))

    async def _revert_commit_once(
        self, *, graph_id: str, commit_id: str, actor: str, message: Optional[str],
    ) -> str:
        """One attempt at :meth:`revert_commit`, under the graph lock."""
        async with self._session() as s:
            await self._lock_graph(s, graph_id)
            await self._assert_not_bootstrapping(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            await self._assert_writable(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            target = await s.get(CommitORM, (graph_id, commit_id))
            if target is None or target.branch_id != main_id:
                raise ValueError("commit is not on this graph's main")
            if target.kind == "genesis":
                raise ValueError("cannot revert the genesis commit")
            if target.kind == "sync_parent":
                raise CrossesUpdate(graph_id, commit_id)

            k, head_seq = target.commit_seq, graph.main_head_commit_seq
            touched = await self._changed_in_window(s, graph_id, main_id, k - 1, k)
            # Bounded (O(touched)): read only the touched entities at the three points via the
            # index-backed _values_at (a fork's through its parent), not the O(history) _state_as_of.
            before = await self._values_at(s, graph_id, main_id, touched, k - 1)
            after = await self._values_at(s, graph_id, main_id, touched, k)
            cur = await self._values_at(s, graph_id, main_id, touched, head_seq)
            merged = {eid: before.get(eid) for eid in touched}   # restore (None ⇒ tombstone)
            theirs = {eid: cur.get(eid) for eid in touched}

            conflicts = [
                {"entity_id": eid, "path": [], "reason": "modified after the reverted commit"}
                for eid in sorted(touched)
                if content_hash(cur.get(eid)) != content_hash(after.get(eid))
            ]
            if conflicts:
                raise MergeConflict(conflicts)

            # Hydrate the live neighborhood for the in-dict cascade/integrity guards (sparse-safe).
            await self._hydrate_merge_neighborhood(s, graph_id, main_id, merged, theirs)
            self._cascade_incident_edges(merged)
            self._assert_referential_integrity(merged)

            deltas = net_delta(theirs, merged)
            if not deltas:
                return ""                              # nothing to undo

            new_seq = head_seq + 1
            main = await s.get(BranchORM, main_id)
            revert = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="revert",
                message=message or f"revert {commit_id}", actor=actor, **commit_provenance(actor),
            )
            s.add(revert)
            await s.flush()
            kind_by_entity = await self._kind_map_multi(s, await self._layer_pairs(
                s, graph_id, main_id, head_seq), entity_ids=[d.entity_id for d in deltas])
            kind_by_entity = self._resolve_delta_kinds(deltas, kind_by_entity)  # payload wins over stale head
            await self._write_deltas(s, graph_id, main_id, revert, deltas, kind_by_entity, actor)
            main.head_commit_id = revert.id
            graph.main_head_commit_seq = new_seq
            main_activity.note(s, graph, revert)
            revert.merkle_root = await self._commit_merkle(s, graph_id, main_id, revert, deltas)
            graph.updated_at = _now()
            revert.stats = _delta_stats(deltas)
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return revert.id

    async def _restore_delta(self, s, graph, main_id, target):
        """Shared compute for restore-to-commit (write) and its preview (read):
        the net delta that returns main to its state at ``target``.

        ``touched`` = entities changed in ``(k, head]`` — everything after the
        target commit. Each returns to its value AT ``k`` (absent at k ⇒ None ⇒
        tombstone, so entities created later are deleted and entities deleted
        later are resurrected). Bounded O(touched) via ``_values_at`` (a fork's
        through its parent). The same hydrate → cascade →
        integrity guards as publish/revert run so the delta (and therefore the
        preview counts) is exactly what a restore will write. A fork is not restored
        to before its latest Update from parent (:meth:`_assert_within_base`)."""
        graph_id = graph.id
        await self._assert_within_base(s, graph, target)
        k, head_seq = target.commit_seq, graph.main_head_commit_seq
        touched = await self._changed_in_window(s, graph_id, main_id, k, head_seq)
        before = await self._values_at(s, graph_id, main_id, touched, k)
        cur = await self._values_at(s, graph_id, main_id, touched, head_seq)
        merged = {eid: before.get(eid) for eid in touched}   # restore (None ⇒ tombstone)
        theirs = {eid: cur.get(eid) for eid in touched}

        # Hydrate the live neighborhood for the in-dict cascade/integrity guards (sparse-safe).
        await self._hydrate_merge_neighborhood(s, graph_id, main_id, merged, theirs)
        self._cascade_incident_edges(merged)
        self._assert_referential_integrity(merged)
        return net_delta(theirs, merged)

    async def restore_to_commit(
        self, *, graph_id: str, commit_id: str, actor: str, message: Optional[str] = None,
    ) -> str:
        """Reset main to its state at ``commit_id`` as ONE new ``restore``
        commit — the point-in-time rollback counterpart of :meth:`revert_commit`
        (which inverts a single commit and conflicts when later commits touched
        the same entities). A restore overrides everything after the target by
        definition, so there is NO conflict path; history is never rewritten and
        the restore itself is revertable. Restoring to the genesis commit is the
        well-defined "empty the graph". Ontology rules are deliberately not
        applied (administrative path, same as revert — must be able to restore
        pre-ontology states)."""
        return await self._retry_seq(
            f"restore to {commit_id}",
            lambda: self._restore_to_commit_once(
                graph_id=graph_id, commit_id=commit_id, actor=actor, message=message))

    async def _restore_to_commit_once(
        self, *, graph_id: str, commit_id: str, actor: str, message: Optional[str],
    ) -> str:
        """One attempt at :meth:`restore_to_commit`, under the graph lock."""
        async with self._session() as s:
            await self._lock_graph(s, graph_id)
            await self._assert_not_bootstrapping(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            await self._assert_writable(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            target = await s.get(CommitORM, (graph_id, commit_id))
            if target is None or target.branch_id != main_id:
                raise ValueError("commit is not on this graph's main")

            deltas = await self._restore_delta(s, graph, main_id, target)
            if not deltas:
                return ""                              # already at (or equal to) the target

            head_seq = graph.main_head_commit_seq
            new_seq = head_seq + 1
            main = await s.get(BranchORM, main_id)
            restore = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="restore",
                message=message or f"restore to {commit_id}", actor=actor, **commit_provenance(actor),
                source_commit_ids=[commit_id],         # provenance: the restore target
            )
            s.add(restore)
            await s.flush()
            kind_by_entity = await self._kind_map_multi(s, await self._layer_pairs(
                s, graph_id, main_id, head_seq), entity_ids=[d.entity_id for d in deltas])
            kind_by_entity = self._resolve_delta_kinds(deltas, kind_by_entity)  # payload wins over stale head
            await self._write_deltas(s, graph_id, main_id, restore, deltas, kind_by_entity, actor)
            main.head_commit_id = restore.id
            graph.main_head_commit_seq = new_seq
            main_activity.note(s, graph, restore)
            restore.merkle_root = await self._commit_merkle(s, graph_id, main_id, restore, deltas)
            graph.updated_at = _now()
            restore.stats = _delta_stats(deltas)
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return restore.id

    # A preview is a synchronous web request, so it must not be allowed to materialize an
    # arbitrarily large delta: restoring a freshly-enabled 7M-entity graph back to genesis
    # touches every entity in it. Past this many touched entities we answer with the shape
    # of the change (how many revisions roll back) and say the item counts are approximate,
    # rather than dragging millions of payloads through the web tier to render a dialog.
    _RESTORE_PREVIEW_MAX_TOUCHED = 200_000

    async def restore_preview(
        self, *, graph_id: str, commit_id: str,
    ) -> Dict[str, object]:
        """What :meth:`restore_to_commit` would do — exact per-kind create/update/
        delete counts (same compute, same cascade guards, nothing written) plus
        how many later commits the restore rolls back. Bounded O(touched), and
        short-circuits to approximate counts above ``_RESTORE_PREVIEW_MAX_TOUCHED``."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)
            target = await s.get(CommitORM, (graph_id, commit_id))
            if target is None or target.branch_id != main_id:
                raise ValueError("commit is not on this graph's main")
            await self._assert_within_base(s, graph, target)

            commits_undone = await s.scalar(
                select(func.count()).select_from(CommitORM).where(
                    CommitORM.graph_id == graph_id,
                    CommitORM.branch_id == main_id,
                    CommitORM.commit_seq > target.commit_seq,
                    CommitORM.commit_seq <= graph.main_head_commit_seq,
                )
            )
            touched_n = await self._count_changed_in_window(
                s, graph_id, main_id, target.commit_seq, graph.main_head_commit_seq)
            if touched_n > self._RESTORE_PREVIEW_MAX_TOUCHED:
                # Too big to price exactly without hurting the request. Be honest about it.
                return {"commitsUndone": int(commits_undone or 0),
                        "approximate": True, "touchedEstimate": int(touched_n),
                        "nodes": {"create": 0, "update": 0, "delete": 0},
                        "edges": {"create": 0, "update": 0, "delete": 0}}

            deltas = await self._restore_delta(s, graph, main_id, target)
            kind_by_entity = await self._kind_map_multi(s, await self._layer_pairs(
                s, graph_id, main_id, graph.main_head_commit_seq),
                entity_ids=[d.entity_id for d in deltas])
            kind_by_entity = self._resolve_delta_kinds(deltas, kind_by_entity)
            counts = {"nodes": {"create": 0, "update": 0, "delete": 0},
                      "edges": {"create": 0, "update": 0, "delete": 0}}
            for d in deltas:
                bucket = "edges" if kind_by_entity.get(d.entity_id) == "edge" else "nodes"
                counts[bucket][d.op] = counts[bucket].get(d.op, 0) + 1
            return {"commitsUndone": int(commits_undone or 0), "approximate": False,
                    "nodes": counts["nodes"], "edges": counts["edges"]}

    async def _count_changed_in_window(self, s, graph_id, branch_id, from_seq, to_seq) -> int:
        """How many entities commits in ``(from_seq, to_seq]`` touched — the size of the
        restore, WITHOUT materializing the id set (which for a restore-to-genesis on a
        freshly-enabled graph is every entity in it). A fork's ``main`` counts its parent's
        between its bases too, as :meth:`_changed_in_window` takes them."""
        total = 0
        for model in (NodeVersionORM, EdgeVersionORM):
            total += int(await s.scalar(
                select(func.count(func.distinct(model.entity_id))).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                )
            ) or 0)
        parent = await self._parent_window(s, graph_id, branch_id, from_seq, to_seq)
        if parent is not None:
            total += await self._count_changed_in_window(s, *parent)
        return total

    async def _layer_pairs(self, s, graph_id: str, branch_id: str, seq: int) -> List[Tuple[str, str]]:
        """The ``(graph, branch)`` head sets a read of ``branch_id`` at ``seq`` composes
        (:meth:`_layers`): what an entity's kind is told from — for a fork's ``main``, its parent's
        too, where an entity the fork never wrote has its only rows."""
        return [(g, b) for g, b, _at in await self._layers(s, graph_id, branch_id, seq)]

    @staticmethod
    async def _assert_within_base(s, graph: GraphORM, target: CommitORM) -> None:
        """A fork is restored only to a commit since its latest Update from parent (its latest
        ``fork_bases`` row): before it, the fork read another parent commit, which no commit of its
        own can bring back (:class:`CrossesUpdate`)."""
        if not graph.fork_parent_graph_id:
            return
        latest = await s.scalar(select(func.max(ForkBaseORM.fork_seq)).where(
            ForkBaseORM.fork_graph_id == graph.id,
            ForkBaseORM.fork_seq <= graph.main_head_commit_seq))
        if latest is not None and target.commit_seq < latest:
            raise CrossesUpdate(graph.id, target.id)

    # ------------------------------------------------------------------ #
    # Forking + pull requests (copy-on-write — plan §8, §12.5)            #
    # ------------------------------------------------------------------ #
    async def _fork_slot(self, s, parent_graph_id: str) -> Optional[GraphORM]:
        """The live parent a new fork may read, or None when it is missing or trashed. Its row
        is read FOR KEY SHARE, so a purge being queued (FOR UPDATE) finishes first and is seen,
        or waits and counts the fork. At most ``config.MAX_FORKS_PER_GRAPH`` live forks
        (:class:`ForkLimit`); the caller holds the parent's graph lock, so the count and the
        insert are one step."""
        parent = (await self._bounded_lock(s, select(GraphORM).where(
            GraphORM.id == parent_graph_id).with_for_update(read=True, key_share=True)
            .execution_options(populate_existing=True), f"graph {parent_graph_id}")
        ).scalar_one_or_none()
        if parent is None or parent.deleted_at is not None:
            return None
        live_forks = await s.scalar(select(func.count()).select_from(GraphORM).where(
            GraphORM.fork_parent_graph_id == parent_graph_id, GraphORM.deleted_at.is_(None)))
        if live_forks >= config.MAX_FORKS_PER_GRAPH:
            raise ForkLimit(config.MAX_FORKS_PER_GRAPH)
        return parent

    async def fork_preflight(self, *, parent_graph_id: str, workspace_id: str) -> None:
        """What :meth:`fork_graph` would refuse, read without its locks, so a route refuses before
        it writes anything of its own: a parent that is missing, trashed or in another workspace
        (``ValueError``), one whose editing is paused (:class:`GraphNotWritable`), or one at its
        fork cap (:class:`ForkLimit`). fork_graph checks all of it again under the parent's lock."""
        async with self._session() as s:
            parent = await s.get(GraphORM, parent_graph_id)
            if parent is None or parent.deleted_at is not None or parent.workspace_id != workspace_id:
                raise ValueError(f"unknown parent graph {parent_graph_id}")
            if parent.lifecycle_state != "live":
                raise GraphNotWritable(parent.lifecycle_state)
            live_forks = await s.scalar(select(func.count()).select_from(GraphORM).where(
                GraphORM.fork_parent_graph_id == parent_graph_id, GraphORM.deleted_at.is_(None)))
            if live_forks >= config.MAX_FORKS_PER_GRAPH:
                raise ForkLimit(config.MAX_FORKS_PER_GRAPH)

    async def fork_graph(
        self,
        *,
        parent_graph_id: str,
        workspace_id: str,
        actor: str,
        tenant_id: Optional[str] = None,
        data_source_id: Optional[str] = None,
    ) -> Dict[str, object]:
        """Copy-on-write fork: a new graph whose ``main`` inherits the parent's
        state at its current head **without copying any rows**.  Divergence accrues
        only as the fork's own commits; reads compose parent@fork_base + own (plan
        §8 cross-team flow).

        ``data_source_id`` is the fork's data source, the ``dsfork_…`` id of the row the route
        made for it; one is minted when it is left out.

        At most ``config.MAX_FORKS_PER_GRAPH`` live forks per parent (:class:`ForkLimit`), and
        none of a trashed parent (:meth:`_fork_slot`)."""
        if data_source_id is not None and not data_source_id.startswith("dsfork_"):
            raise ValueError(f"a fork's data source id starts with dsfork_, not {data_source_id!r}")
        async with self._session() as s:
            await self._lock_graph(s, parent_graph_id)
            parent = await self._fork_slot(s, parent_graph_id)
            # Read under the lock a move takes: a parent moved out of the workspace since the
            # route found it is not forked into the old one.
            if parent is None or parent.workspace_id != workspace_id:
                raise ValueError(f"unknown parent graph {parent_graph_id}")
            await self._assert_writable(s, parent_graph_id)    # only a live graph is forked
            base_seq = parent.main_head_commit_seq
            parent_main = await self._main_branch_id(s, parent_graph_id)
            fork = GraphORM(
                data_source_id=data_source_id or prefixed_id("dsfork"),
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                kind=parent.kind,
                base_ontology_id=parent.base_ontology_id,
                base_ontology_version_id=parent.base_ontology_version_id,
                fork_parent_graph_id=parent_graph_id,
                fork_base_commit_seq=base_seq,
                main_head_commit_seq=base_seq,
                created_by=actor,
            )
            s.add(fork)
            await s.flush()
            s.add(ForkBaseORM(fork_graph_id=fork.id, fork_seq=base_seq, parent_seq=base_seq,
                              created_by=actor))
            main = BranchORM(graph_id=fork.id, kind="main", name="main", visibility="public",
                             created_by=actor)
            s.add(main)
            await s.flush()
            # Fork-point commit carries the root the parent stored at its head (none when the
            # parent is a fork itself); no version rows.
            parent_head = await s.get(BranchORM, parent_main)
            stored = await s.scalar(select(CommitORM.merkle_root).where(
                CommitORM.graph_id == parent_graph_id, CommitORM.id == parent_head.head_commit_id))
            fork_point = CommitORM(
                graph_id=fork.id, branch_id=main.id, commit_seq=base_seq,
                kind="genesis", message=f"fork of {parent_graph_id}@{base_seq}",
                actor=actor, **commit_provenance(actor), source_branch_id=parent_main, merkle_root=stored, stats={},
            )
            s.add(fork_point)
            await s.flush()                      # materialise fork_point.id before linking
            main.head_commit_id = fork_point.id
            # A fork has no FalkorDB copy: it reads through its root's store, its patch set over
            # it. Its row names no key, as every graph has one (the watermark reads its root's).
            s.add(ProjectionStateORM(graph_id=fork.id, projected_commit_seq=0,
                                     target_commit_seq=base_seq, owns_falkor_graph=False))
            return {
                "graph_id": fork.id,
                "data_source_id": fork.data_source_id,
                "main_branch_id": main.id,
                "fork_base_commit_seq": base_seq,
            }

    async def open_pr(
        self, *, source_graph_id: str, actor: str, title: Optional[str] = None,
        description: Optional[str] = None, reviewers: Optional[Sequence[str]] = None,
    ) -> str:
        """Open a PR from a fork's ``main`` back to its parent's ``main``,
        recording the current mergeability/conflict set (plan §12.5).

        ``reviewers`` makes approval a merge precondition: every listed reviewer
        must :meth:`approve_pr` before the PR can merge (plan §17 #5). A service account is never
        a reviewer (:class:`PersonRequired`)."""
        if any(is_service_account(r) for r in reviewers or ()):
            raise PersonRequired("a service account cannot review a PR: name a person")
        async with self._session() as s:
            # FOR KEY SHARE (15 §8): a delete_fork holding the row sees this PR, or we see its
            # tombstone; the fork's own publishes do not wait.
            fork = (await self._bounded_lock(s, select(GraphORM).where(
                GraphORM.id == source_graph_id).with_for_update(read=True, key_share=True),
                f"graph {source_graph_id}")).scalar_one_or_none()
            if fork is None or fork.deleted_at is not None or not fork.fork_parent_graph_id:
                raise ValueError("source graph is not a fork")
            fork_main = await self._main_branch_id(s, source_graph_id)
            await self._assert_no_live_pr(s, fork_main)
            revs = list(dict.fromkeys(reviewers or []))      # dedup, keep order
            # No conflicts to record: a fork settles them with Update from parent before it merges.
            pr = MergeRequestORM(
                graph_id=source_graph_id,
                source_branch_id=fork_main,
                target_graph_id=fork.fork_parent_graph_id,
                target_branch="main",
                base_commit_seq=fork.fork_base_commit_seq,
                status="mergeable",
                title=(title or None),
                description=(description or None),
                reviewers=revs or None,
                approval_status="pending" if revs else None,
                actor=actor,
            )
            s.add(pr)
            await s.flush()
            return pr.id

    @staticmethod
    def _assert_minted_fork(g: GraphORM) -> None:
        """Only a fork :meth:`fork_graph` minted (its ``dsfork_`` id) is trashed and restored on
        its own; any other graph goes with its data source (:class:`NotAFork`)."""
        if not g.fork_parent_graph_id or not (g.data_source_id or "").startswith("dsfork_"):
            raise NotAFork(g.id)

    async def delete_fork(self, *, graph_id: str, workspace_id: str, actor: str) -> str:
        """Move a fork to the trash; returns its parent's id. Its drafts and pull requests are
        kept, and it can be restored (:meth:`restore_fork`) until a purge of it is queued: by
        the reaper once ``config.PURGE_GRACE_DAYS`` have passed, or by its parent's purge, which
        takes it along. Refused while its pull request into the parent is live
        (:class:`PullRequestExists`) or forks of its own are (:class:`LiveForks`). The row is
        held FOR UPDATE, so an open_pr or fork_graph on it (FOR KEY SHARE) is seen or sees us."""
        async with self._session() as s:
            fork = (await self._bounded_lock(s, select(GraphORM).where(
                GraphORM.id == graph_id, GraphORM.workspace_id == workspace_id)
                .with_for_update(), f"graph {graph_id}")).scalar_one_or_none()
            if fork is None or fork.deleted_at is not None:
                raise ValueError("graph not found in workspace")
            self._assert_minted_fork(fork)
            await self._assert_no_live_pr(s, await self._main_branch_id(s, graph_id))
            live = await s.scalar(select(func.count()).select_from(GraphORM).where(
                GraphORM.fork_parent_graph_id == graph_id, GraphORM.deleted_at.is_(None)))
            if live:
                raise LiveForks(graph_id, live)
            fork.deleted_at, fork.deleted_by = _now(), actor
            return fork.fork_parent_graph_id

    async def restore_fork(self, *, graph_id: str, workspace_id: str) -> Optional[str]:
        """Bring a trashed fork back; returns its parent's id, or None when it was not trashed.
        Refused once a purge of it exists (:class:`ForkNotRestorable` ``purging``), while its
        parent is missing or trashed (``parent_deleted``), and at the parent's fork cap
        (:class:`ForkLimit`), counted under the parent's graph lock as fork_graph counts."""
        async with self._session() as s:
            f = await s.get(GraphORM, graph_id)
            if f is None or f.workspace_id != workspace_id:
                raise ValueError("graph not found in workspace")
            self._assert_minted_fork(f)
            if f.deleted_at is None:
                return None
            parent_id = f.fork_parent_graph_id
            await self._lock_graph(s, parent_id)
            if await self._fork_slot(s, parent_id) is None:
                raise ForkNotRestorable(graph_id, "parent_deleted")
            f = (await self._bounded_lock(s, select(GraphORM).where(GraphORM.id == graph_id)
                 .with_for_update().execution_options(populate_existing=True),
                 f"graph {graph_id}")).scalar_one_or_none()
            if f is None or f.workspace_id != workspace_id:
                raise ValueError("graph not found in workspace")
            if f.deleted_at is None:
                return None
            if await s.scalar(select(JobORM.id).where(JobORM.job_type == PURGE_JOB_TYPE,
                                                      JobORM.graph_id == graph_id).limit(1)):
                raise ForkNotRestorable(graph_id, "purging")
            f.deleted_at = f.deleted_by = None
            return parent_id

    async def list_forks(self, *, graph_id: str, workspace_id: str, limit: int) -> List[dict]:
        """A graph's direct forks, newest first, live and trashed: when a trashed one was
        deleted and by whom, whether its purge is queued (no undo then), and when its undo
        window (``config.PURGE_GRACE_DAYS``) ends. A live one says how far it is from this graph
        (:meth:`_fork_distance`)."""
        purging = select(JobORM.id).where(JobORM.job_type == PURGE_JOB_TYPE,
                                          JobORM.graph_id == GraphORM.id).exists()
        async with self._session() as s:
            rows = (await s.execute(
                select(GraphORM, purging.label("purging")).where(
                    GraphORM.fork_parent_graph_id == graph_id,
                    GraphORM.workspace_id == workspace_id)
                .order_by(GraphORM.created_at.desc(), GraphORM.id.desc()).limit(limit))).all()
            distance = {g.id: await self._fork_distance(s, g) for g, _p in rows
                        if g.deleted_at is None}
        return [{
            **self._graph_meta(g), "deleted_at": g.deleted_at, "deleted_by": g.deleted_by,
            "purging": bool(p),
            "purge_after": (datetime.fromisoformat(g.deleted_at)
                            + timedelta(days=config.PURGE_GRACE_DAYS)).isoformat()
            if g.deleted_at else None,
            **distance.get(g.id, dict.fromkeys(_FORK_DISTANCE)),
        } for g, p in rows]

    async def _fork_distance(self, s, fork: GraphORM) -> Dict[str, object]:
        """How far a fork is from its parent: ``ahead``, the entities it changed since its last
        merged review, or its fork point (:meth:`_fork_merge_base`); ``behind``, those its parent
        changed that it has not taken in — the parent's window since the base the fork agrees with
        (:meth:`_fork_agreed_base`); ``update_recommended`` for what Update from parent can fix: when
        that reaches ``config.FORK_REWIND_WARN``, or when the fork's reads are past the ceiling,
        which ``reads_from`` says (``overlay`` | ``postgres``, as :meth:`fork_reads_from`), and
        taking the parent's changes in would bring it back under: a fork of the root whose own
        changes alone fit (an update moves its base, past its own merged reviews too). A fork of a
        fork reads its parent's own history up to its base, which taking in more of it can only
        grow. Each count stops at the ceiling, ``config.FORK_REWIND_MAX`` (``counts_capped``)."""
        cap = config.FORK_REWIND_MAX
        main_id = await self._main_branch_id(s, fork.id)
        head = fork.main_head_commit_seq
        ahead = await self._own_change_count(
            s, fork.id, main_id, await self._fork_merge_base(s, fork), head, cap)
        parent = await s.get(GraphORM, fork.fork_parent_graph_id)
        parent_main = await self._main_branch_id(s, parent.id)
        agreed, read = await self._fork_agreed_base(s, fork, head), await fork_base_at(s, fork, head)
        behind = await self._window_count(
            s, parent.id, parent_main, agreed, parent.main_head_commit_seq, cap)
        n = await self._fork_candidates(s, fork, main_id, cap)
        past = n > cap
        # Of a fork of the root, what its reads overlay beyond its own changes is its parent's window
        # since the base it reads: ``behind``, unless that is below the base it agrees with.
        overlaid = behind if read == agreed else await self._window_count(
            s, parent.id, parent_main, read, parent.main_head_commit_seq, cap)
        fixable = past and parent.fork_parent_graph_id is None and n - overlaid <= cap
        return {"ahead": min(ahead, cap), "behind": min(behind, cap),
                "update_recommended": fixable or behind >= config.FORK_REWIND_WARN,
                "reads_from": "postgres" if past else "overlay",
                "counts_capped": ahead > cap or behind > cap}

    async def _window_count(self, s, graph_id: str, branch_id: str, lo: int, hi: int,
                            cap: int) -> int:
        """:meth:`_count_changed_in_window`, each graph's count stopping past ``cap``."""
        n = await self._own_change_count(s, graph_id, branch_id, lo, hi, cap)
        parent = await self._parent_window(s, graph_id, branch_id, lo, hi)
        return n + (await self._window_count(s, *parent, cap) if parent is not None else 0)

    async def update_fork_from_parent(
        self, *, fork_graph_id: str, actor: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        parent_seq: Optional[int] = None, parent_label: Optional[str] = None,
        containment_edge_types: Sequence[str] = (), ontology_rules: Optional[OntologyRules] = None,
    ) -> Dict[str, object]:
        """Take a fork's parent's changes into it ("Update from parent"): the parent's ``main`` from
        the seq the fork agrees with at its head (``B``, :meth:`_fork_agreed_base`: the base it reads
        there, past the squashes of its own reviews that landed right after it) to its head (``P``,
        read once; ``parent_seq`` pins it, as a queued update does). Returns ``{commit_id,
        parent_seq, wrote, up_to_date}``: at ``P`` already, nothing is written, ``commit_id`` is
        None and ``parent_seq`` is ``B`` — unless the fork reads its parent from below ``B``: then
        the commit moves its base to ``B``, with no rows.

        What only the parent changed shows through once the base moves. What the fork has rows of
        and the parent changed in ``(B, P]`` goes through the 3-way merge — base the parent at
        ``B``, ours the fork at its head, theirs the parent at ``P`` — and fields both changed,
        differently, are :class:`ForkUpdateConflicts`, which ``resolutions`` (``{entity_id: payload |
        None}``) settle field by field, as a pull's are — those and nothing else: a resolution for
        an entity in no conflict is :class:`ResolutionsWithoutConflict`. A node the parent deleted
        in the window takes the fork's own edges on it with it, and an edge the parent drew or
        pointed in it at a node the fork deleted is deleted on the fork. What is written is what
        the fork would read otherwise once its base moves: merged and resolved values, and those
        deletions. It faces the gate every write does (:meth:`_enforce_written`), by the fork's
        ontology (``ontology_rules``, ``containment_edge_types``). What the update would leave the
        fork holding that breaks its hierarchy between what each side did — a duplicate, a second
        parent, a loop, a node left outside the parent its type needs (:meth:`_broken_structure`)
        — is a conflict too, of kind ``structure`` and whole-entity, on the entity the update brings
        in, and settled as the others are.

        One ``sync_parent`` commit on the fork's ``main`` — written with no rows too, so history
        shows the update — and the base the fork reads from it on, ``(that commit's seq, P)`` in
        ``fork_bases``, in one transaction; a read before the commit keeps the base before it.
        Drafts on the fork are behind then, and take it with Pull latest. ``parent_label`` names
        the parent in the commit's message (its data source's label; its graph id when None)."""
        return await self._retry_seq(
            f"update {fork_graph_id} from its parent",
            lambda: self._update_fork_once(
                fork_graph_id=fork_graph_id, actor=actor, resolutions=dict(resolutions or {}),
                parent_seq=parent_seq, parent_label=parent_label,
                containment_edge_types=containment_edge_types, ontology_rules=ontology_rules))

    async def fork_update_size(self, *, fork_graph_id: str,
                               containment_edge_types: Sequence[str] = ()) -> Dict[str, object]:
        """What :meth:`update_fork_from_parent` would take now, counted in SQL without running it:
        ``{changes, parent_seq, up_to_date}`` — the entities it would merge, the edges its
        cascades may delete and those its hierarchy check judges (each query counted no further
        than ``SYNC_PUBLISH_MAX_CHANGES + 1``), and the parent's head it would update to. What the
        route sizes an update by, to run it in the request or queue it as a job pinned to
        ``parent_seq``."""
        cap = config.SYNC_PUBLISH_MAX_CHANGES
        async with self._session() as s:
            fork, parent = await self._fork_and_parent(s, fork_graph_id)
            fork_main = await self._main_branch_id(s, fork.id)
            base = await self._fork_agreed_base(s, fork, fork.main_head_commit_seq)
            to = parent.main_head_commit_seq
            if to <= base:
                return {"changes": 0, "parent_seq": base,
                        "up_to_date": await fork_base_at(s, fork, fork.main_head_commit_seq) >= base}
            window = await self._window_chain(
                s, parent.id, await self._main_branch_id(s, parent.id), base, to)
            changes = 0
            for stmt in [*self._both_queries(fork.id, fork_main, window),
                         *self._cascade_queries(fork.id, fork_main, window),
                         *self._structure_queries(fork.id, fork_main, window,
                                                  containment_edge_types)]:
                changes += int(await s.scalar(select(func.count()).select_from(
                    stmt.distinct().limit(cap + 1).subquery())) or 0)
            return {"changes": changes, "parent_seq": to, "up_to_date": False}

    @staticmethod
    async def _fork_and_parent(s, fork_graph_id: str) -> Tuple[GraphORM, GraphORM]:
        """A live fork and its parent, for Update from parent: an unknown or trashed graph, or a
        parent gone, is ``ValueError``; a graph with no parent, :class:`NotAFork`."""
        fork = await s.get(GraphORM, fork_graph_id)
        if fork is None or fork.deleted_at is not None:
            raise ValueError(f"unknown graph {fork_graph_id}")
        if not fork.fork_parent_graph_id:
            raise NotAFork(fork_graph_id, f"graph {fork_graph_id} is not a fork: it has no parent "
                                          "to update from")
        parent = await s.get(GraphORM, fork.fork_parent_graph_id)
        if parent is None:
            raise ValueError(f"the graph fork {fork.id} was forked from is gone")
        return fork, parent

    async def _update_fork_once(
        self, *, fork_graph_id: str, actor: str, resolutions: Dict[str, Optional[dict]],
        parent_seq: Optional[int], parent_label: Optional[str],
        containment_edge_types: Sequence[str], ontology_rules: Optional[OntologyRules],
    ) -> Dict[str, object]:
        """One attempt at :meth:`update_fork_from_parent`, under the fork's graph lock."""
        async with self._session() as s:
            # The fork's lock only. What an update reads of the parent are its rows at seqs up to P,
            # and those never change once P is the parent's head: it waits on no publish of the
            # parent, and a large update holds none up. A path that holds both graphs' locks takes
            # the parent's first.
            await self._lock_graph(s, fork_graph_id)
            fork, parent = await self._fork_and_parent(s, fork_graph_id)
            await self._assert_writable(s, fork.id)
            fork_main = await self._main_branch_id(s, fork.id)
            parent_main = await self._main_branch_id(s, parent.id)
            head = fork.main_head_commit_seq
            base = await self._fork_agreed_base(s, fork, head)
            to = parent.main_head_commit_seq if parent_seq is None else parent_seq
            if to <= base:
                if await fork_base_at(s, fork, head) >= base:
                    if resolutions:
                        raise ResolutionsWithoutConflict(resolutions)
                    return {"commit_id": None, "parent_seq": base, "wrote": 0, "up_to_date": True}
                # Nothing of the parent's to take, but the fork reads it from before the squashes
                # of its own reviews, which its reads then count twice: only the base moves, to the
                # one it agrees with — a commit with no rows.
                to = base
            new_seq = head + 1
            # The base the fork reads from the update's commit on, first: a read at ``new_seq`` in
            # this transaction is then the fork as the update leaves it, before it writes a row.
            s.add(ForkBaseORM(fork_graph_id=fork.id, fork_seq=new_seq, parent_seq=to,
                              created_by=actor))
            await s.flush()
            window = await self._window_chain(s, parent.id, parent_main, base, to)
            changed = await self._ids_of(s, self._both_queries(fork.id, fork_main, window))
            was = await self._values_at(s, parent.id, parent_main, changed, base)
            ours = await self._values_at(s, fork.id, fork_main, changed, head)
            theirs = await self._values_at(s, parent.id, parent_main, changed, to)
            set_fields = frozenset(config.SET_FIELDS)
            merged: Dict[str, Optional[dict]] = {}
            conflicts: List[dict] = []
            settled: set = set()
            for eid in sorted(changed):
                out = three_way_merge(was.get(eid), ours.get(eid), theirs.get(eid), set_fields)
                if out.conflicts and eid in resolutions:
                    merged[eid] = _settle_conflicts(
                        out.merged, _normalize_resolution(resolutions[eid]), out.conflicts)
                    settled.add(eid)
                    continue
                merged[eid] = out.merged
                conflicts += [{"entity_id": eid, "path": list(c.path), "base": c.base,
                               "ours": c.ours, "theirs": c.theirs, "kind": c.kind}
                              for c in out.conflicts]
            if conflicts:
                raise ForkUpdateConflicts(conflicts, {
                    eid: ours.get(eid) for eid in sorted({c["entity_id"] for c in conflicts})})
            view = _collapse_empty_payloads(merged)
            await self._sync_neighborhood(s, fork.id, fork_main, window, view, new_seq)
            self._cascade_incident_edges(view)
            # Judged against the fork as the update leaves it: its head is the update's seq for what
            # this transaction reads from here on — its base moved, before a row is written.
            fork.main_head_commit_seq = new_seq
            after = await self._values_at(s, fork.id, fork_main, list(view), new_seq)
            # A resolution's own value is the gate's to judge, below; the rest is the update's.
            broken = [v for v in await self._broken_structure(
                s, fork, fork_main, head, window, view, after, containment_edge_types, ontology_rules)
                if v["entity_id"] not in settled]
            blamed = sorted({v["entity_id"] for v in broken})
            if set(resolutions) - settled - set(blamed):
                raise ResolutionsWithoutConflict(set(resolutions) - settled - set(blamed))
            unsettled = [eid for eid in blamed if eid not in resolutions]
            if unsettled:
                raise ForkUpdateConflicts(*await self._structure_conflicts(
                    s, broken, unsettled, (parent.id, parent_main, base), (fork.id, fork_main, head),
                    (parent.id, parent_main, to)))
            if blamed:
                view.update({eid: _normalize_resolution(resolutions[eid]) for eid in blamed})
                await self._sync_neighborhood(s, fork.id, fork_main, window, view, new_seq)
                self._cascade_incident_edges(view)
                after = await self._values_at(s, fork.id, fork_main, list(view), new_seq)
            self._assert_referential_integrity(view)
            deltas = net_delta({eid: after.get(eid) for eid in view}, view)

            kind_by_entity: Dict[str, str] = {}
            if deltas:
                kind_by_entity = self._resolve_delta_kinds(deltas, await self._kind_map_multi(
                    s, [(g, b) for g, b, _at in await self._layers(s, fork.id, fork_main, new_seq)],
                    entity_ids=[d.entity_id for d in deltas]))
                await self._enforce_written(
                    s, fork.id, fork_main, {d.entity_id: d.payload for d in deltas}, after,
                    kind_by_entity, containment_edge_types=containment_edge_types,
                    ontology_rules=ontology_rules, strict=fork.ontology_enforcement == "strict",
                    known=view)
            main = await s.get(BranchORM, fork_main)
            commit = CommitORM(
                graph_id=fork.id, branch_id=fork_main, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="sync_parent",
                message=f"Update from {parent_label or parent.id}@{to}", actor=actor, **commit_provenance(actor),
                source_branch_id=parent_main,
            )
            s.add(commit)
            await s.flush()
            if deltas:
                await self._write_deltas(s, fork.id, fork_main, commit, deltas, kind_by_entity, actor)
            main.head_commit_id = commit.id
            fork.main_head_commit_seq = new_seq
            fork.updated_at = _now()
            commit.merkle_root = await self._commit_merkle(s, fork.id, fork_main, commit, deltas)
            # ``rebased``, as a pull's: what the update rewrote of the fork's own (_approvals).
            written = _delta_stats(deltas)
            commit.stats = {**written, "rebased": dict(written), "from_seq": base, "to_seq": to}
            ps = await s.get(ProjectionStateORM, fork.id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return {"commit_id": commit.id, "parent_seq": to, "wrote": len(deltas),
                    "up_to_date": False}

    async def _fork_agreed_base(self, s, fork: GraphORM, seq: int) -> int:
        """The seq of its parent's ``main`` a fork agrees with at ``seq``: the base it reads there
        (:func:`fork_base_at`), and past it each squash of one of its own reviews (of its head at
        ``seq`` or before) that landed right after it. Such a review merged up to date, so its squash
        wrote the fork's own values: the fork has them already, and reads the parent the same at
        either seq. What Update from parent merges from — so the fork's own merged changes are not
        its parent's for it to take, nor a conflict with what it changed since — and what a merge
        is up to date against."""
        base = await fork_base_at(s, fork, seq)
        landed = (await s.execute(
            select(CommitORM.commit_seq)
            .join(MergeRequestORM, and_(MergeRequestORM.target_graph_id == CommitORM.graph_id,
                                        MergeRequestORM.resulting_commit_id == CommitORM.id))
            .where(MergeRequestORM.graph_id == fork.id,
                   MergeRequestORM.target_graph_id == fork.fork_parent_graph_id,
                   MergeRequestORM.status == "merged", MergeRequestORM.merged_source_seq <= seq,
                   CommitORM.graph_id == fork.fork_parent_graph_id, CommitORM.commit_seq > base)
            .order_by(CommitORM.commit_seq))).scalars().all()
        for at in landed:
            if at != base + 1:
                break
            base = at
        return base

    async def _window_chain(self, s, graph_id: str, branch_id: str, lo: int,
                            hi: int) -> List[Tuple[str, str, int, int]]:
        """The windows :meth:`_changed_in_window` reads, as ``(graph, branch, lo, hi)``: the branch's
        own, then up each fork above it (:meth:`_parent_window`) — for a query that joins a
        window to other rows in SQL."""
        chain = [(graph_id, branch_id, lo, hi)]
        while (up := await self._parent_window(s, *chain[-1])) is not None:
            chain.append(up)
        return chain

    @staticmethod
    def _both_queries(fork_id: str, fork_main: str, window) -> list:
        """Of the entities a fork's parent changed in ``window`` (:meth:`_window_chain`), those the
        fork has rows of (a head on its ``main``): what Update from parent merges, as a query a
        table and window, joined in SQL — never the window's ids in this process."""
        mine = select(EntityHeadORM.entity_id).where(
            EntityHeadORM.graph_id == fork_id, EntityHeadORM.branch_id == fork_main)
        return [select(model.entity_id).where(
                    model.graph_id == gid, model.branch_id == bid, model.commit_seq > lo,
                    model.commit_seq <= hi, model.entity_id.in_(mine))
                for gid, bid, lo, hi in window for model in (NodeVersionORM, EdgeVersionORM)]

    @staticmethod
    def _cascade_queries(fork_id: str, fork_main: str, window) -> list:
        """The edges Update from parent may have to delete on the fork, as queries: the fork's own
        edges on a node its parent deleted in ``window`` (:meth:`_window_chain`), and the parent's
        edges written in it — drawn, or pointed elsewhere — at a node the fork deleted. More than
        that, at times: whether one is left on a node gone is told from what the fork reads after
        the update (:meth:`_sync_neighborhood`)."""
        ev, nv = EdgeVersionORM, NodeVersionORM
        gone = select(EntityHeadORM.entity_id).where(
            EntityHeadORM.graph_id == fork_id, EntityHeadORM.branch_id == fork_main,
            EntityHeadORM.is_tombstone.is_(True))
        queries = []
        for gid, bid, lo, hi in window:
            deleted = select(nv.entity_id).where(
                nv.graph_id == gid, nv.branch_id == bid, nv.commit_seq > lo, nv.commit_seq <= hi,
                nv.op == "delete")
            for end in (ev.source_entity_id, ev.target_entity_id):
                queries.append(select(ev.entity_id).where(
                    ev.graph_id == fork_id, ev.branch_id == fork_main, end.in_(deleted)))
                queries.append(select(ev.entity_id).where(
                    ev.graph_id == gid, ev.branch_id == bid, ev.commit_seq > lo,
                    ev.commit_seq <= hi, ev.op != "delete", end.in_(gone)))
        return queries

    @staticmethod
    def _structure_queries(fork_id: str, fork_main: str, window,
                           containment_edge_types: Sequence[str]) -> list:
        """The parent's edges that may break a fork's hierarchy once Update from parent moves its
        base, as queries: those drawn, or pointed elsewhere, in ``window`` (:meth:`_window_chain`)
        that the fork has no rows of (they show through) — into a node an edge of the fork's own
        points at (a duplicate of it, or a second parent beside it), and, while the fork has a live
        containment link of its own, every containment link among them: a loop runs through one of
        the fork's links and one of the parent's new ones, however far apart. More than that, at
        times: which of them the fork reads new or re-pointed is told from what it reads
        (:meth:`_broken_structure`)."""
        ev, own = EdgeVersionORM, aliased(EdgeVersionORM)
        cset = sorted({t.upper() for t in containment_edge_types or ()})

        def contained(m):
            return or_(func.upper(m.edge_type).in_(cset), m.edge_type.is_(None))

        # An anti-join on the heads' key: a NOT IN over a large fork's heads is no hashed plan.
        mine = select(EntityHeadORM.entity_id).where(
            EntityHeadORM.graph_id == fork_id, EntityHeadORM.branch_id == fork_main,
            EntityHeadORM.entity_id == ev.entity_id).exists()
        ends = select(own.target_entity_id).where(own.graph_id == fork_id, own.branch_id == fork_main)
        linked = select(own.entity_id).where(own.graph_id == fork_id, own.branch_id == fork_main,
                                             own.op != "delete", contained(own)).exists()
        queries = []
        for gid, bid, lo, hi in window:
            drawn = select(ev.entity_id).where(
                ev.graph_id == gid, ev.branch_id == bid, ev.commit_seq > lo, ev.commit_seq <= hi,
                ev.op != "delete", ~mine)
            queries.append(drawn.where(ev.target_entity_id.in_(ends)))
            if cset:
                queries.append(drawn.where(contained(ev), linked))
        return queries

    async def _broken_structure(
        self, s, fork: GraphORM, fork_main: str, head: int, window,
        view: Dict[str, Optional[dict]], after: Mapping[str, Optional[dict]],
        containment_edge_types: Sequence[str], ontology_rules: Optional[OntologyRules],
    ) -> List[dict]:
        """What Update from parent would leave a fork holding that breaks its hierarchy where
        neither side did alone, as the gate words it: a duplicate, a second parent or a loop between
        an edge the update brings in — the parent's, new or re-pointed against what the fork read at
        ``head``, shown through (:meth:`_structure_queries`) or merged (in ``view``) — and the
        fork's own (:meth:`_validate_edge_integrity`); and under strict enforcement, a node left
        outside every parent its type needs (:meth:`_parentless_violations`, of ``view`` against
        ``after``: what the fork reads once its base moves). Judged against the fork as the update
        leaves it: the caller has made its head the update's seq in ``s``."""
        at = fork.main_head_commit_seq
        near = await self._ids_of(s, self._structure_queries(
            fork.id, fork_main, window, containment_edge_types))
        shown = near - view.keys()
        edges = shown | {eid for eid, p in view.items() if p and _is_edge_payload(p)}
        was = await self._skeletons_at(s, fork.id, fork_main, edges, head)
        now = await self._skeletons_at(s, fork.id, fork_main, shown, at)
        now.update({eid: view[eid] for eid in edges - shown})
        creates = [(eid, now[eid]) for eid in sorted(edges)
                   if now.get(eid) and _redefines(was.get(eid), now[eid], "edge")]
        viol = (await self._validate_edge_integrity(
            s, fork.id, fork_main, creates, {eid for eid, p in view.items() if p is None},
            containment_edge_types) if creates else [])
        if ontology_rules is not None and fork.ontology_enforcement == "strict":
            kinds = {eid: "edge" if _is_edge_payload(p or after.get(eid) or {}) else "node"
                     for eid, p in view.items()}
            viol += await self._parentless_violations(
                s, fork.id, fork_main, view, after, kinds, ontology_rules)
        return viol

    async def _structure_conflicts(self, s, broken: List[dict], ids: List[str], base, ours,
                                   theirs) -> Tuple[List[dict], Dict[str, Optional[dict]]]:
        """:meth:`_broken_structure`'s violations of ``ids`` as an update's conflicts, in a pull's
        shape — whole-entity (``path`` empty), ``kind`` ``structure``, and the gate's words as
        their ``reason`` — with their seeds: each entity's value at ``base``, ``ours`` and
        ``theirs``, each ``(graph, branch, seq)``."""
        values = [await self._values_at(s, g, b, ids, at) for g, b, at in (base, ours, theirs)]
        reasons: Dict[str, List[str]] = {}
        for v in broken:
            reasons.setdefault(v["entity_id"], []).append(v["reason"])
        return ([{"entity_id": eid, "path": [], "base": values[0].get(eid),
                  "ours": values[1].get(eid), "theirs": values[2].get(eid), "kind": "structure",
                  "reason": " ".join(dict.fromkeys(reasons[eid]))} for eid in ids],
                {eid: values[1].get(eid) for eid in ids})

    @staticmethod
    async def _ids_of(s, queries) -> set:
        """The entity ids ``queries`` select, together."""
        ids: set = set()
        for stmt in queries:
            ids.update((await s.execute(stmt.distinct())).scalars())
        return ids

    async def _sync_neighborhood(self, s, fork_id: str, fork_main: str, window,
                                 view: Dict[str, Optional[dict]], at: int) -> None:
        """Add to an update's SPARSE result (``view``) what its cascade and integrity guards reason
        about, each at what the fork reads at ``at`` (the update's seq, its base moved): the edges
        that may be left on a node gone — :meth:`_cascade_queries`', and every edge on a node the
        merge deletes — and the ends of every live edge in it, the deleted ones too (as None), so
        the cascade sees them gone. Each nets to nothing unless the cascade then deletes it.
        Bounded by what the window and the merge changed."""
        edges = await self._ids_of(s, self._cascade_queries(fork_id, fork_main, window))
        tomb = [eid for eid, p in view.items() if p is None]
        if tomb:
            edges |= await self._incident_edge_ids(s, fork_id, fork_main, tomb)
        edges -= view.keys()
        if edges:
            view.update({eid: p for eid, p in (
                await self._values_at(s, fork_id, fork_main, edges, at)).items() if p is not None})
        ends = {e for p in view.values() if p for e in _edge_src_tgt(p) if e} - view.keys()
        if ends:
            view.update(await self._values_at(s, fork_id, fork_main, ends, at))

    async def approve_pr(
        self, *, pr_id: str, actor: str, expected_head_commit_id: Optional[str] = None,
        self_approval: bool = True,
    ) -> dict:
        """Record ``actor``'s approval of a PR. Whoever opened it approves it too, unless its data
        source's policy says someone else does (``self_approval`` False: :class:`SelfReview`); its
        draft's owner, when someone else opened it, approves either way. Once every requested
        reviewer has approved,
        ``approval_status`` flips to ``approved`` (and an otherwise-mergeable PR to status
        ``approved``).

        The approval is of the source branch's head now, and records that commit's seq, never
        a later commit's: a content commit after it makes it stale (:meth:`_approvals`).
        ``expected_head_commit_id`` is the head the reviewer saw; :class:`HeadMoved` when the
        branch has moved on since.

        The PR row is locked for the transaction, so a second reviewer approving at the same
        moment waits and adds to this approval rather than writing over it. A service account
        never approves (:class:`PersonRequired`): its managers would approve through it."""
        if is_service_account(actor):
            raise PersonRequired("a service account cannot approve a PR: approving is a person's call")
        async with self._session() as s:
            pr = await self._lock_pr(s, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if pr.status in ("merged", "closed"):
                raise ValueError(f"pr {pr_id} is {pr.status}")
            if not self_approval and actor == pr.actor:
                raise SelfReview(pr_id)
            src = await s.get(BranchORM, pr.source_branch_id)
            head = src.head_commit_id if src else None
            if expected_head_commit_id is not None and expected_head_commit_id != head:
                raise HeadMoved(pr_id, head)
            # The head's own seq: a checkpoint committed since the head was read is after it.
            head_seq = (await s.scalar(select(CommitORM.commit_seq).where(
                CommitORM.graph_id == pr.graph_id, CommitORM.id == head))) if head else 0
            approved = list(dict.fromkeys((pr.approved_by or []) + [actor]))
            pr.approved_by = approved
            pr.approvals = {**(pr.approvals or {}), actor: {
                "headCommitId": head, "at": _now(), "headSeq": head_seq}}
            standing, _stale = await self._approvals(s, pr)
            reviewers = set(pr.reviewers or [])
            pr.approval_status = "approved" if reviewers <= set(standing) else "pending"
            if pr.approval_status == "approved" and pr.status == "mergeable":
                pr.status = "approved"
            pr.updated_at = _now()
            return await self._pr_meta(s, pr)

    async def close_pr(self, *, pr_id: str, actor: Optional[str] = None) -> dict:
        """Close a PR without merging — terminal: approve_pr and merge_pr both
        reject a closed PR. Idempotent; an already-merged PR cannot be closed, nor one a job is
        merging (:class:`JobActive`). Under the PR's row lock, which that job's queueing takes."""
        async with self._session() as s:
            pr = await self._lock_pr(s, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if pr.status == "closed":
                return await self._pr_meta(s, pr)              # idempotent
            if pr.status == "merged":
                raise ValueError(f"pr {pr_id} is merged")
            if pr.status == "merging":
                raise JobActive(await self._merging_job(s, pr_id),
                                "This review is being merged by a job; it can be closed if that "
                                "job ends without merging it.")
            pr.status = "closed"
            pr.closed_at = _now()
            pr.closed_by = actor
            pr.updated_at = _now()
            return await self._pr_meta(s, pr)

    @staticmethod
    async def _lock_pr(s, pr_id: str) -> Optional[MergeRequestORM]:
        """Take a PR's row lock for the transaction and return the row as committed (bounded wait,
        :meth:`_bounded_lock`): the read-modify-writes of its review state serialize here."""
        return (await GraphVersioningService._bounded_lock(
            s,
            select(MergeRequestORM).where(MergeRequestORM.id == pr_id)
            .with_for_update().execution_options(populate_existing=True),
            f"pr {pr_id}",
        )).scalar_one_or_none()

    async def update_pr(
        self, *, pr_id: str, title: Optional[str] = None, description: Optional[str] = None,
        reviewers: Optional[Sequence[str]] = None,
    ) -> dict:
        """Edit a PR's human title + description, and who must review it. PATCH semantics: a
        field left ``None`` is untouched, an empty string (or list) clears it. New ``reviewers``
        re-judge ``approval_status`` from the approvals that still stand (:meth:`_approvals`);
        a merged or closed PR's reviewers are settled, and a merging one's held while its job runs
        (:class:`JobActive`). A service account is never a reviewer (:class:`PersonRequired`)."""
        if any(is_service_account(r) for r in reviewers or ()):
            raise PersonRequired("a service account cannot review a PR: name a person")
        async with self._session() as s:
            pr = await self._lock_pr(s, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if title is not None:
                pr.title = title.strip() or None
            if description is not None:
                pr.description = description.strip() or None
            if reviewers is not None:
                if pr.status in ("merged", "closed"):
                    raise ValueError(f"pr {pr_id} is {pr.status}")
                if pr.status == "merging":
                    raise JobActive(await self._merging_job(s, pr_id),
                                    "This review is being merged by a job; its reviewers can change "
                                    "if that job ends without merging it.")
                pr.reviewers = list(dict.fromkeys(reviewers)) or None
                pr.approval_status = None
                if pr.reviewers:
                    standing, _stale = await self._approvals(s, pr)
                    pr.approval_status = "approved" if set(pr.reviewers) <= set(standing) else "pending"
                if pr.approval_status == "approved" and pr.status == "mergeable":
                    pr.status = "approved"
                elif pr.approval_status != "approved" and pr.status == "approved":
                    pr.status = "mergeable"
            pr.updated_at = _now()
            return await self._pr_meta(s, pr)

    async def preview_pr(self, *, pr_id: str) -> Dict[str, object]:
        """Dry-run a fork PR's merge into the parent (conflicts + change counts)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            fork = await s.get(GraphORM, pr.graph_id)
            merged, conflicts, theirs = await self._fork_merge(s, fork)
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged)),
            }

    async def merge_pr(
        self,
        *,
        pr_id: str,
        actor: str,
        message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        self_merge: bool = True,
        pinned_seq: Optional[int] = None,
        queued: bool = False,
    ) -> str:
        """Squash-merge a fork's review into its parent's ``main`` (plan §8, §12.5). Only up to date
        with the parent: the base the fork agrees with at the head it merges
        (:meth:`_fork_agreed_base`) must be the parent's head, read under its lock — else
        :class:`ForkNotUpToDate`, "Update from parent first", as a draft publishes only up to date
        with ``main``. Update from parent settles conflicts on the fork's side, so the merge is a copy
        of the fork's own changes since its last merged review (:meth:`_squash_fork`), with nothing
        to resolve: ``resolutions`` is not used. The parent's rules gate it (its ontology, the gate
        every write shares) and its reviewers' approvals, before anything is written.

        The head it merges is the fork's now, or ``pinned_seq``, the head a queued merge pinned; a
        merge records it even when it changed nothing (``merged_source_seq``): the fork's next review
        merges what it changed since (:meth:`_fork_merge_base`). ``queued``: a job's merge, of a
        review it holds ``merging``; any other merge of a review held so is :class:`JobActive`.
        ``self_merge`` as for :meth:`merge_mr`.

        It holds the parent's graph lock, then the review's row; a path that holds the fork's lock
        too takes it after the parent's."""
        async def _once():
            async with self._session() as s:
                pr = await s.get(MergeRequestORM, pr_id)
                if pr is None:
                    raise ValueError(f"unknown pr {pr_id}")
                if self._is_draft_mr(pr):                 # before anything counts how far behind
                    raise ValueError(f"pr {pr_id} is a draft's review, not a fork's")
                if pr.status in ("merged", "closed"):
                    raise ValueError(f"pr {pr_id} is {pr.status}")
                if not self_merge and actor == pr.actor:
                    raise SelfMerge(pr_id)
                fork = await s.get(GraphORM, pr.graph_id)
                parent = await s.get(GraphORM, pr.target_graph_id)
                if fork is None or parent is None or fork.deleted_at is not None:
                    raise ValueError("pr endpoints missing")
                await self._lock_graph(s, parent.id)      # serialize merges into this parent's main
                await s.refresh(parent)                   # head may have advanced before the lock
                # Read again under the lock: a merge of the same PR may have landed while we waited.
                pr = (await s.execute(select(MergeRequestORM).where(MergeRequestORM.id == pr_id)
                                      .with_for_update().execution_options(populate_existing=True))
                      ).scalar_one()
                if pr.status in ("merged", "closed"):
                    raise ValueError(f"pr {pr_id} is {pr.status}")
                if pr.status == "merging" and not queued:
                    raise JobActive(await self._merging_job(s, pr_id),
                                    "This review is being merged by a job; it can be merged again "
                                    "if that job ends without merging it.")
                await self._assert_writable(s, parent.id)   # the target; a frozen fork may propose
                took = fork.main_head_commit_seq if pinned_seq is None else pinned_seq
                await self._assert_up_to_date(s, fork, took, parent)
                # Its approvals as they stand now (_approvals): a content commit on the fork after
                # the head a job pinned makes them stale, though that head is what it merges — the
                # reviewers look again.
                squash, warnings = await self._squash_fork(
                    s, parent, fork, took, actor, message,
                    containment_edge_types=containment_edge_types, ontology_rules=ontology_rules,
                    before_write=lambda: self._require_approvals(s, pr))
                pr.checks_status = {"ontology": {"ok": True, "violations": warnings[:100],
                                                 "total": len(warnings)}}
                pr.status = "merged"
                pr.resulting_commit_id = squash.id if squash is not None else None
                pr.merged_at = pr.updated_at = _now()
                pr.merged_by = actor
                pr.merged_source_seq = took
                return squash.id if squash is not None else ""
        return await self._retry_seq(f"merge_pr {pr_id}", _once)

    async def _assert_up_to_date(self, s, fork: GraphORM, took: int, parent: GraphORM) -> None:
        """A fork's review of its head at ``took`` merges only up to date with its parent (as it is
        in ``s``): :class:`ForkNotUpToDate` otherwise, with how far behind it is."""
        base = await self._fork_agreed_base(s, fork, took)
        if base != parent.main_head_commit_seq:
            behind = await self._window_count(
                s, parent.id, await self._main_branch_id(s, parent.id), base,
                parent.main_head_commit_seq, config.FORK_REWIND_MAX)
            raise ForkNotUpToDate(fork.id, min(behind, config.FORK_REWIND_MAX))

    @staticmethod
    async def _merging_job(s, pr_id: str) -> str:
        """The job merging a review held ``merging`` (its latest ``fork_merge`` job)."""
        return await s.scalar(select(JobORM.id).where(
            JobORM.job_type == "fork_merge", JobORM.field_scope["prId"].astext == pr_id)
            .order_by(JobORM.created_at.desc()).limit(1)) or ""

    async def fork_merge_size(self, *, pr_id: str) -> int:
        """How many entities merging a fork's review writes, counted no further than
        ``SYNC_PUBLISH_MAX_CHANGES + 1``: the fork's own changes since its last merged review. What
        the merge routes size a merge by, to run it in the request or as a job. A draft's review
        is not a fork's: 0."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pr {pr_id}")
            if self._is_draft_mr(pr):
                return 0
            fork = await s.get(GraphORM, pr.graph_id)
            if fork is None or fork.deleted_at is not None:
                raise ValueError("pr endpoints missing")
            fork_main = await self._main_branch_id(s, fork.id)
            return await self._own_change_count(
                s, fork.id, fork_main, await self._fork_merge_base(s, fork),
                fork.main_head_commit_seq, config.SYNC_PUBLISH_MAX_CHANGES)

    async def release_merging(self, *, pr_id: Optional[str] = None) -> List[str]:
        """Hand back the fork reviews held ``merging`` whose merge job ended without landing them —
        refused, failed, poisoned or timed out — and return their ids: ``approved`` while their
        reviewers' approval stands as it was stored, else ``mergeable``. A pending or running job is
        the whole definition of a live one, as for :meth:`release_publishing`, and a review whose
        row is locked is skipped, not waited on: after the wait this statement would not see the
        job a concurrent queueing just made."""
        mr = aliased(MergeRequestORM)
        live_job = select(JobORM.id).where(
            JobORM.job_type == "fork_merge", JobORM.status.in_(("pending", "running")),
            JobORM.field_scope["prId"].astext == mr.id)
        stuck = select(mr.id).where(mr.status == "merging", ~live_job.exists())
        if pr_id is not None:
            stuck = stuck.where(mr.id == pr_id)
        async with self._session() as s:
            return list((await s.execute(
                update(MergeRequestORM)
                .where(MergeRequestORM.id.in_(stuck.with_for_update(skip_locked=True)))
                .values(status=case((MergeRequestORM.approval_status == "approved", "approved"),
                                    else_="mergeable"), updated_at=_now())
                .returning(MergeRequestORM.id)
                .execution_options(synchronize_session=False)
            )).scalars().all())

    # ---- the one-live-PR-per-branch invariant ----------------------------- #
    async def _resolve_live_prs(self, s, branch_id: str, commit_id: Optional[str], actor: str,
                                merged_via: str) -> None:
        """Mark every live PR raised from a branch that has just merged as merged too."""
        for pr in await self._live_prs_for_branch(s, branch_id):
            pr.status = "merged"
            pr.resulting_commit_id = commit_id
            pr.merged_at = _now()
            pr.merged_by = actor
            pr.merged_via = merged_via
            pr.updated_at = _now()

    async def claim_draft(
        self, *, graph_id: str, branch_id: str, actor: str, view_id: Optional[str] = None,
    ) -> Dict[str, object]:
        """A draft an import writes into: open, on ``graph_id``, and ``actor``'s own. With
        ``view_id``, a draft that names no view yet becomes that view's (a draft opened for a
        package's data, then given the new view that came with it), so the view opens on it.

        Raises ``ValueError`` for an unknown or closed draft and :class:`AccessDenied` for someone
        else's."""
        async with self._session() as s:
            draft = await self._lock_branch(s, graph_id, branch_id)
            if draft.kind != "draft":
                raise ValueError("not a draft")
            self._require_open(draft)
            if draft.owner != actor:
                raise AccessDenied("this draft belongs to someone else")
            if view_id and draft.originating_view_id is None:
                draft.originating_view_id = view_id
            return {"branch_id": draft.id, "name": draft.name, "originating_view_id": draft.originating_view_id}

    async def branch_statuses(self, branch_ids: Sequence[str]) -> Dict[str, str]:
        """The status (open, publishing, merged, abandoned) of each branch named that exists."""
        ids = sorted(set(branch_ids))
        out: Dict[str, str] = {}
        async with self._session() as s:
            for i in range(0, len(ids), 500):
                rows = (await s.execute(
                    select(BranchORM.id, BranchORM.status).where(BranchORM.id.in_(ids[i:i + 500]))
                )).all()
                out.update({bid: status for bid, status in rows})
        return out

    async def _live_prs_for_branch(self, s, branch_id: str) -> List[MergeRequestORM]:
        """Every non-terminal PR raised from ``branch_id``, newest first.

        Returns a list rather than one row on purpose: the partial unique index guarantees at most
        one going forward, but databases that predate it may still hold duplicates, and the squash
        path must resolve *all* of them or it would leave exactly the zombie rows this work exists
        to remove."""
        rows = await s.execute(
            select(MergeRequestORM)
            .where(MergeRequestORM.source_branch_id == branch_id,
                   MergeRequestORM.status.not_in(_TERMINAL_PR_STATUS))
            .order_by(MergeRequestORM.created_at.desc())
        )
        return list(rows.scalars())

    async def _assert_no_live_pr(self, s, branch_id: str) -> None:
        """Reject a second PR from a branch that already has a live one (:class:`PullRequestExists`).

        The partial unique index ``uq_mr_live_source_branch`` is the real enforcement — it closes the
        race two concurrent openers would otherwise win together. This check exists so the *common*
        case produces a useful error carrying the existing ``pr_id``, instead of an opaque
        IntegrityError, letting the UI offer "view the review that already exists"."""
        existing = await self._live_prs_for_branch(s, branch_id)
        if existing:
            pr = existing[0]
            raise PullRequestExists(pr.id, branch_id, pr.title)

    # ---- draft → main merge request (reviewed publish) ------------------- #
    @staticmethod
    def _is_draft_mr(pr: MergeRequestORM) -> bool:
        """A same-graph draft→main MR (vs a legacy fork PR, where source_graph_id is
        NULL or the parent)."""
        return bool(pr.source_graph_id and pr.source_graph_id == pr.target_graph_id)

    async def open_draft_mr(
        self, *, graph_id: str, branch_id: str, actor: str,
        title: Optional[str] = None, description: Optional[str] = None,
        reviewers: Optional[Sequence[str]] = None,
    ) -> str:
        """Open a merge request from a per-user ``draft`` back to its own graph's
        ``main`` — the reviewed alternative to a bare :meth:`publish`. Records the
        current mergeability/conflict set + the ``title``/``description``;
        ``reviewers`` makes approval a merge precondition (plan §17 #5). A service account is
        never a reviewer (:class:`PersonRequired`)."""
        if any(is_service_account(r) for r in reviewers or ()):
            raise PersonRequired("a service account cannot review a PR: name a person")
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            draft = await s.get(BranchORM, branch_id)
            if graph is None or draft is None or draft.graph_id != graph_id:
                raise ValueError("unknown graph/branch")
            if draft.kind == "main":
                raise ValueError("cannot open a merge request for main")
            self._require_open(draft)
            await self._require_edit(s, draft, actor, ())
            await self._assert_no_live_pr(s, branch_id)
            main_id = await self._main_branch_id(s, graph_id)
            _merged, conflicts, _theirs = await self._compute_merge_bounded(
                s, graph_id, graph, draft, main_id, {}
            )
            revs = list(dict.fromkeys(reviewers or []))      # dedup, keep order
            pr = MergeRequestORM(
                graph_id=graph_id,
                source_graph_id=graph_id,                    # source == target ⇒ draft MR
                source_branch_id=branch_id,
                target_graph_id=graph_id,
                target_branch="main",
                base_commit_seq=draft.base_commit_seq,
                status="conflicts" if conflicts else "mergeable",
                title=(title or None),
                description=(description or None),
                conflicts=conflicts or None,
                reviewers=revs or None,
                approval_status="pending" if revs else None,
                actor=actor,
            )
            s.add(pr)
            await s.flush()
            return pr.id

    async def preview_mr(self, *, mr_id: str) -> Dict[str, object]:
        """Dry-run a merge request's merge (conflicts + change counts), dispatching
        draft→main vs fork→parent."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, mr_id)
            if pr is None:
                raise ValueError(f"unknown merge request {mr_id}")
            await self._require_review_changes(s, pr)
            if self._is_draft_mr(pr):
                graph = await s.get(GraphORM, pr.target_graph_id)
                draft = await s.get(BranchORM, pr.source_branch_id)
                main_id = await self._main_branch_id(s, graph.id)
                merged, conflicts, theirs = await self._compute_merge_bounded(
                    s, graph.id, graph, draft, main_id, {}
                )
            else:
                fork = await s.get(GraphORM, pr.graph_id)
                merged, conflicts, theirs = await self._fork_merge(s, fork)
            return {
                "clean": not conflicts,
                "conflicts": conflicts,
                "changes": _delta_stats(net_delta(theirs, merged)),
            }

    async def _review_squash(self, s, pr: MergeRequestORM) -> Optional[CommitORM]:
        """The commit a merged draft review landed as on ``main``: what merging it changed, which
        its diff is read from. Merging it again against ``main`` — which already holds it — would
        change nothing, and the draft's own rows are removed after the retention window. None for
        an open or closed review, a fork's, or a merge that landed no commit of its own (its draft
        changed nothing)."""
        if pr.status != "merged" or not pr.resulting_commit_id or not self._is_draft_mr(pr):
            return None
        commit = await s.get(CommitORM, (pr.target_graph_id, pr.resulting_commit_id))
        if commit is None or commit.source_branch_id != pr.source_branch_id:
            return None
        if commit.branch_id != await self._main_branch_id(s, pr.target_graph_id):
            return None
        return commit

    async def _require_review_changes(self, s, pr: MergeRequestORM) -> None:
        """:class:`DraftPruned` for a closed draft review whose draft's changes were removed: what
        it proposed is gone. A merged one reads from its commit (:meth:`_review_squash`), and an
        open one's draft is never removed."""
        if self._is_draft_mr(pr) and pr.status != "merged":
            draft = await s.get(BranchORM, pr.source_branch_id)
            if draft is not None:
                self._require_changes(draft)

    async def _pr_merge_states(self, s, pr, containment_edge_types=None):
        """``(merged, theirs)`` for a PR — the 3-way merge result and the target side, the
        shared basis for both the flat diff and the hierarchical summary. Dispatches
        draft→main vs fork→parent (same as :meth:`diff_pr` / :meth:`preview_mr`).

        A draft's merge holds only what changed (:meth:`_compute_merge_bounded`), so the
        unchanged entities a diff shows around it are added to both sides alike, where
        ``net_delta`` nets them out: the ends of the edges it names, and with
        ``containment_edge_types`` the containers each change nests under. A fork's likewise
        (:meth:`_fork_merge`), its containers as the fork has them."""
        if self._is_draft_mr(pr):
            graph = await s.get(GraphORM, pr.target_graph_id)
            draft = await s.get(BranchORM, pr.source_branch_id)
            main_id = await self._main_branch_id(s, graph.id)
            merged, _conflicts, theirs = await self._compute_merge_bounded(
                s, graph.id, graph, draft, main_id, {}
            )
            changed = {d.entity_id for d in net_delta(theirs, merged)}
            await self._hydrate_merge_neighborhood(s, graph.id, main_id, merged, theirs)
            cset = {t.upper() for t in (containment_edge_types or [])}
            await self._augment_containment_skeleton(
                s, graph.id, draft.id, changed, merged, theirs, merged, cset)
        else:
            fork = await s.get(GraphORM, pr.graph_id)
            merged, _conflicts, theirs = await self._fork_merge(s, fork)
            changed = {d.entity_id for d in net_delta(theirs, merged)}
            cset = {t.upper() for t in (containment_edge_types or [])}
            await self._augment_containment_skeleton(
                s, fork.id, await self._main_branch_id(s, fork.id), changed, merged, theirs,
                merged, cset)
        return merged, theirs

    async def diff_pr(self, *, pr_id: str) -> Dict[str, object]:
        """Itemised **Files Changed** for a PR — the SAME 3-way computation as
        :meth:`preview_mr` (so the diff's item count equals the preview's change count),
        reshaped into the UI's ``DiffVsMainResponse`` overlay shape. Dispatches draft→main
        vs fork→parent; the diff is the merge's net effect on the target
        (``net_delta(theirs, merged)``), i.e. what merging this PR changes in the base. A merged
        draft review's is what its merge changed: its commit on ``main`` (:meth:`_review_squash`)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            squash = await self._review_squash(s, pr)
            if squash is not None:
                big = await self._commit_too_large(s, squash.graph_id, squash.id, None)
                if big is not None:
                    raise DiffTooLarge(big[2], config.DIFF_TREE_MAX_CHANGES)
                merged, theirs = await self._commit_diff_states(s, squash.graph_id, squash.id, None)
            else:
                await self._require_review_changes(s, pr)
                big = await self._pr_too_large(s, pr)
                if big is not None:
                    raise DiffTooLarge(big[1], config.DIFF_TREE_MAX_CHANGES)
                merged, theirs = await self._pr_merge_states(s, pr)
        return _deltas_to_diff_vs_main(net_delta(theirs, merged), theirs)

    async def diff_pr_summary(
        self, *, pr_id: str, containment_edge_types, limit: int = 200,
    ) -> Dict[str, object]:
        """Top level of a PR's **hierarchical** Files Changed: changed entities grouped into
        a containment tree (top-level containers + type buckets) with rolled-up counts and an
        entityType impact summary, capped at ``limit``. Same 3-way merge as :meth:`diff_pr`
        (so the global counts equal the flat diff's), reshaped lazily so a huge change set
        stays a bounded response (children load per :meth:`diff_pr_children`)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            squash = await self._review_squash(s, pr)
            if squash is None:
                await self._require_review_changes(s, pr)
                big = await self._pr_too_large(s, pr)
                if big is None:
                    merged, theirs = await self._pr_merge_states(s, pr, containment_edge_types)
        if squash is not None:
            return await self.diff_commit_summary(graph_id=squash.graph_id, commit_id=squash.id,
                                                  containment_edge_types=containment_edge_types,
                                                  limit=limit)
        if big is not None:
            # Counted from the draft's change index — what the draft changes where it branched
            # off, which is what merging it changes once it is up to date — instead of merging
            # every changed entity in the web process for a row of the review inbox.
            draft, changed = big
            index = await self._change_index(pr.target_graph_id, ChangeOrigin(branch_id=draft.id),
                                             containment_edge_types, viewer=None)
            return _counted_tree_summary(index, changed)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_pr_children(
        self, *, pr_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0,
    ) -> Dict[str, object]:
        """One container's (or bucket's) direct children in a PR's hierarchical diff — the
        lazy-load step behind :meth:`diff_pr_summary`. Sub-containers come back as expandable
        group rows; leaves carry whole-payload before/after for the diff overlay."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                raise ValueError(f"unknown pull request {pr_id}")
            squash = await self._review_squash(s, pr)
            if squash is None:
                await self._require_review_changes(s, pr)
                big = await self._pr_too_large(s, pr)
                if big is not None:
                    raise DiffTooLarge(big[1], config.DIFF_TREE_MAX_CHANGES)
                merged, theirs = await self._pr_merge_states(s, pr, containment_edge_types)
        if squash is not None:
            return await self.diff_commit_children(
                graph_id=squash.graph_id, commit_id=squash.id, container_key=container_key,
                containment_edge_types=containment_edge_types, limit=limit, offset=offset)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def _pr_too_large(self, s, pr) -> Optional[Tuple[BranchORM, int]]:
        """A draft's review too large to merge inside a request for its diff: ``(draft, at
        least how many)`` past ``DIFF_TREE_MAX_CHANGES`` — the draft's own changes, and main's
        since the draft branched off when it is behind (the merge composes both) — else None.
        Its list is the draft's change list (``/graphs/{gid}/diff/*``). A fork's review is merged
        in the request at any size, as before."""
        if not self._is_draft_mr(pr):
            return None
        draft = await s.get(BranchORM, pr.source_branch_id)
        if draft is None:
            return None
        cap = config.DIFF_TREE_MAX_CHANGES
        changed = await self._change_count(s, pr.target_graph_id, draft.id)
        if changed <= cap:
            graph = await s.get(GraphORM, pr.target_graph_id)
            base, head = draft.base_commit_seq or 0, (graph.main_head_commit_seq or 0) if graph else 0
            if head > base:
                main_id = await self._main_branch_id(s, pr.target_graph_id)
                changed += await self._own_change_count(s, pr.target_graph_id, main_id, base, head, cap)
        return (draft, changed) if changed > cap else None

    async def merge_mr(
        self, *, mr_id: str, actor: str, message: str,
        resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        queued: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        self_merge: bool = True,
    ) -> str:
        """Merge a merge request, dispatching on its kind: a fork PR delegates to
        :meth:`merge_pr`; a draft→main MR recomputes the 3-way merge at merge time
        (main may have advanced under continued editing), enforces the
        reviewer-approval gate, then squashes via the shared :meth:`_apply_draft_squash`.
        ``queued`` as for :meth:`publish`. ``self_merge`` False: its data source's policy says
        someone other than whoever opened it merges it (:class:`SelfMerge`)."""
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, mr_id)
            if pr is None:
                raise ValueError(f"unknown merge request {mr_id}")
            is_draft = self._is_draft_mr(pr)
            opener = pr.actor
            flush_gid = pr.target_graph_id
            flush_bid = pr.source_branch_id
            draft_branch = await s.get(BranchORM, pr.source_branch_id)
            flush_actor = (draft_branch.owner if draft_branch else None) or actor
        if not is_draft:
            return await self.merge_pr(
                pr_id=mr_id, actor=actor, message=message, resolutions=resolutions,
                containment_edge_types=containment_edge_types, ontology_rules=ontology_rules,
                self_merge=self_merge,
            )
        if not self_merge and actor == opener:
            raise SelfMerge(mr_id)
        async def _once():
            # Fold the draft's staged-but-uncommitted edits first (attributed to its owner),
            # so the merge never silently drops working changes that were never checkpointed.
            await self._flush_pending_changes(
                graph_id=flush_gid, branch_id=flush_bid, actor=flush_actor,
                ontology_rules=ontology_rules, publishing_ok=queued, node_identity=node_identity,
            )
            async with self._session() as s:
                await self._lock_graph(s, flush_gid)      # serialize merges into this graph's main
                pr = await s.get(MergeRequestORM, mr_id)
                if pr.status in ("merged", "closed"):
                    raise ValueError(f"merge request {mr_id} is {pr.status}")
                graph = await s.get(GraphORM, pr.target_graph_id)
                if graph is None:
                    raise ValueError("merge request endpoints missing")
                await self._assert_writable(s, graph.id)
                draft = await self._lock_branch(s, graph.id, pr.source_branch_id)   # as in publish
                self._require_open(draft, publishing_ok=queued)
                await self._require_no_import(s, pr.source_branch_id)
                if await self._pending_count(s, graph.id, pr.source_branch_id):
                    raise _StaleHead()
                # The approval gate (plan §17 #5), ahead of the merge computation: a refusal costs
                # one indexed read, never a 3-way merge of the draft.
                await self._require_approvals(s, pr)
                main_id = await self._main_branch_id(s, graph.id)
                # Require-up-to-date gate (see publish / docs 03 §3.13): a PR whose source draft is
                # behind main must pull latest (rebase_draft) before merging, so the reviewed diff is
                # the diff that actually lands. Read under _lock_graph so main can't advance between
                # here and the squash.
                await self._require_landable(s, graph.id, main_id, draft, graph.main_head_commit_seq)
                narrow = self._narrow_squash(graph, draft, resolutions)
                if not narrow:                                # the narrow squash has no conflicts
                    merged_state, conflicts, theirs = await self._compute_merge_bounded(
                        s, graph.id, graph, draft, main_id, dict(resolutions or {})
                    )
                    if conflicts:
                        raise MergeConflict(conflicts)
                if narrow:
                    commit_id = await self._squash_up_to_date(
                        s, graph, draft, main_id, actor, message,
                        containment_edge_types=containment_edge_types, ontology_rules=ontology_rules)
                else:
                    commit_id = await self._apply_draft_squash(
                        s, graph, draft, main_id, merged_state, theirs, actor, message,
                        containment_edge_types=containment_edge_types,
                        ontology_rules=ontology_rules,
                    )
                pr.status = "merged"
                pr.resulting_commit_id = commit_id
                pr.merged_at = _now()
                pr.merged_by = actor
                pr.updated_at = _now()
                return commit_id
        return await self._retry_seq(f"merge_mr {mr_id}", _once)

    async def _approvals(self, s, pr: MergeRequestORM) -> Tuple[List[str], List[str]]:
        """``(standing, stale)``: who approved ``pr``, split by whether the approval still holds
        (doc 13 'Staleness').

        An approval records the source branch's head when it was given (:meth:`approve_pr`) and
        holds until a content commit lands on the branch after it. A pull that rewrote none of
        the draft's own edits (``stats.rebased`` all zero) is not content, so it keeps approvals;
        nor is a fork's Update from parent that wrote no rows.
        An approval with no recorded head was given before approvals were bound to one: stale.
        Past 1000 later commits, an approval older than all of them counts as stale too."""
        approved = list(pr.approved_by or [])
        seqs = {a: v["headSeq"] for a, v in (pr.approvals or {}).items() if a in approved}
        last_content = 0
        if seqs:
            rows = (await s.execute(
                select(CommitORM.commit_seq, CommitORM.kind, CommitORM.stats)
                .where(CommitORM.graph_id == pr.graph_id, CommitORM.branch_id == pr.source_branch_id,
                       CommitORM.commit_seq > min(seqs.values()))
                .order_by(CommitORM.commit_seq.desc()).limit(1001))).all()
            for seq, kind, stats in rows:
                rebased = (stats or {}).get("rebased")
                if kind not in ("pull", "sync_parent") or rebased is None or any(rebased.values()):
                    last_content = seq
                    break
            else:
                if len(rows) > 1000:
                    last_content = rows[-1].commit_seq
        standing = [a for a in approved if a in seqs and seqs[a] >= last_content]
        return standing, [a for a in approved if a not in standing]

    async def _require_approvals(self, s, pr: MergeRequestORM) -> None:
        """The approval gate (plan §17 #5): every requested reviewer's approval must still hold.
        A PR with no requested reviewers needs none."""
        if not pr.reviewers:
            return
        standing, stale = await self._approvals(s, pr)
        pending = sorted(set(pr.reviewers) - set(standing))
        if pending:
            raise ApprovalRequired(pr.id, pending, stale=sorted(set(pending) & set(stale)))

    async def _fork_merge_base(self, s, fork) -> int:
        """The seq of the fork's ``main`` its next PR merges from: the fork's head its last merged
        PR took, as git merges from the last merged commit, else its fork point. A merge that
        recorded none (merged before the column existed, with no change) leaves the one before."""
        took = await s.scalar(select(func.max(MergeRequestORM.merged_source_seq)).where(
            MergeRequestORM.graph_id == fork.id,
            MergeRequestORM.target_graph_id == fork.fork_parent_graph_id,
            MergeRequestORM.status == "merged"))
        # Update from parent does not move it: an edit the fork made before an update is still its
        # own change since its last merged review, and what the update merged into one of those is
        # in the window too, its value then the fork's own and its parent's together.
        return fork.fork_base_commit_seq if took is None else took

    async def _fork_merge(self, s, fork, head: Optional[int] = None):
        """:meth:`_compute_fork_merge` with what its cascade reasons about around it
        (:meth:`_fork_merge_neighborhood`), and the cascade run: ``(merged, conflicts, theirs)`` as
        the merge writes them (:meth:`_squash_fork`), for every read that previews it. No conflict:
        a fork takes its parent's changes, and settles what both changed, with Update from parent."""
        merged, theirs, base = await self._compute_fork_merge(s, fork, head)
        await self._fork_merge_neighborhood(s, fork, merged, theirs, base)
        self._cascade_incident_edges(merged)
        return merged, [], theirs

    async def _fork_merge_neighborhood(self, s, fork, merged, theirs, base: int) -> None:
        """Add to a fork's SPARSE review (:meth:`_compute_fork_merge`) what the cascade and integrity
        guards reason about, each as the parent has it at ``base``, what the review is against: the
        parent's edges on each node the review deletes, and the ends of every live edge in it, the
        deleted ones too. Added to ``theirs`` alike, so each nets to nothing unless the cascade then
        deletes it. Bounded by the degree of the deleted nodes and the edges the fork changed."""
        parent_id = fork.fork_parent_graph_id
        parent_main = await self._main_branch_id(s, parent_id)
        tomb = [eid for eid, p in merged.items() if p is None]
        need = set(await self._incident_edge_ids(s, parent_id, parent_main, tomb)) if tomb else set()
        for _round in range(2):              # the incident edges, then the ends of every live edge
            need -= merged.keys()
            if need:
                for eid, p in (await self._values_at(s, parent_id, parent_main, need, base)).items():
                    merged[eid] = theirs[eid] = p
            need = {e for p in merged.values() if p for e in _edge_src_tgt(p) if e}

    async def _compute_fork_merge(self, s, fork, head: Optional[int] = None):
        """A fork's review as its merge writes it, O(changed): the fork's own changes since its last
        merged review (:meth:`_fork_merge_base`) — its rows in ``(merge base, head]``, never its
        parent's window — each the fork's value at ``head`` (its head now when None) against the
        parent's at the base the fork agrees with there (:meth:`_fork_agreed_base`), which the merge
        requires to be the parent's head. Every difference is a change: Update from parent settled
        what both changed on the fork's side. Returns SPARSE ``(merged, theirs, base)``;
        :meth:`_fork_merge` adds what is around them."""
        parent = await s.get(GraphORM, fork.fork_parent_graph_id)
        if parent is None:
            raise ValueError("fork parent missing")
        # A missing fork base is a corrupt fork row, not an empty genesis — merging against
        # base 0 would treat the entire parent history as the fork's addition. Fail loud.
        if fork.fork_base_commit_seq is None:
            raise ValueError(
                f"fork {fork.id} missing fork_base_commit_seq — refusing merge against empty base")
        parent_main = await self._main_branch_id(s, parent.id)
        fork_main = await self._main_branch_id(s, fork.id)
        head = fork.main_head_commit_seq if head is None else head
        base = await self._fork_agreed_base(s, fork, head)
        changed = await self._own_window(s, fork.id, fork_main, await self._fork_merge_base(s, fork),
                                         head)
        ours = await self._values_at(s, fork.id, fork_main, changed, head)
        theirs = await self._values_at(s, parent.id, parent_main, changed, base)
        return _collapse_empty_payloads({eid: ours.get(eid) for eid in changed}), theirs, base

    @staticmethod
    async def _own_window(s, graph_id: str, branch_id: str, lo: int, hi: int) -> set:
        """Entity ids a branch's own commits in ``(lo, hi]`` touched — its rows alone, where
        :meth:`_changed_in_window` adds a fork's parent's between its bases."""
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            changed.update((await s.execute(select(model.entity_id).where(
                model.graph_id == graph_id, model.branch_id == branch_id, model.commit_seq > lo,
                model.commit_seq <= hi).distinct())).scalars().all())
        return changed

    # ------------------------------------------------------------------ #
    # Reads / audit                                                       #
    # ------------------------------------------------------------------ #
    async def main_branch_id(self, graph_id: str) -> str:
        """Public accessor for a graph's ``main`` branch id."""
        async with self._session() as s:
            return await self._main_branch_id(s, graph_id)

    async def landed_revision(self, *, graph_id: str, commit_id: Optional[str]) -> Optional[int]:
        """The revision of ``main`` that holds a publish or merge which answered ``commit_id``: its
        commit's sequence number on ``main`` — what ``asOfSeq`` reads ``main`` as of. A draft that
        changed nothing lands no commit of its own (``commit_id`` is then its head, or empty): it is
        held by ``main`` as it is, so its head. ``None`` for a graph that is gone."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                return None
            if commit_id:
                seq = await s.scalar(select(CommitORM.commit_seq).where(
                    CommitORM.graph_id == graph_id, CommitORM.id == commit_id,
                    CommitORM.branch_id == await self._main_branch_id(s, graph_id)))
                if seq is not None:
                    return int(seq)
            return int(graph.main_head_commit_seq or 0)

    async def materialize_state(
        self, *, graph_id: str, branch_id: str, as_of_seq: Optional[int] = None,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, Dict[str, dict]]:
        """Node/edge payloads for a branch (fork-aware composition). ``as_of_seq``
        reconstructs the state at ``commit_seq <= as_of_seq`` (time-travel); ``None``
        is the branch's current head.

        Read straight from the version store (the source of truth); the FalkorDB
        projection is the hot read path and sits behind the same API.
        """
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            self._require_changes(branch)
            state = (
                await self._composed_state(s, graph_id, branch_id)
                if as_of_seq is None
                else await self._composed_state_as_of(s, graph_id, branch_id, as_of_seq)
            )
            nodes, edges = {}, {}
            for eid, p in state.items():
                if p is None:
                    continue
                (edges if _is_edge_payload(p) else nodes)[eid] = p
            return {"nodes": nodes, "edges": edges}

    async def schema_counts(self, *, graph_id: str, branch_id: str) -> Optional[Dict[str, object]]:
        """``main``'s live nodes and edges by type, its nodes' names by type and the tags they
        carry, counted in Postgres from its head pointers — what a schema panel shows, without
        loading every entity into this process as :meth:`materialize_state` does:
        ``{"nodes": {type: n}, "edges": {type: n}, "names": [(type, name)], "tags": {tag: n}}``.

        ``names`` holds the first three names of each type among the first
        ``_SCHEMA_SAMPLE_ROWS`` nodes by id, in id order: on a smaller graph, exactly the names the
        whole state gives first. ``None`` where the head pointers don't hold the whole state: a
        draft's fall back to ``main`` for what it didn't change, and a fork's to its parent. The
        answer is kept for the head it counted (``_schema_counts_cache``): every reader between two
        commits asks the same question."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if (graph is None or graph.fork_parent_graph_id
                    or branch_id != await self._main_branch_id(s, graph_id)):
                return None
            key = (graph_id, graph.main_head_commit_seq)
            if key in _schema_counts_cache:
                _schema_counts_cache.move_to_end(key)
                return _schema_counts_cache[key]
            conn = await s.connection()
            at = {"graph_id": graph_id, "branch_id": branch_id}
            nodes = dict((await conn.execute(_COUNT_NODE_TYPES, at)).all())
            edges = dict((await conn.execute(_COUNT_EDGE_TYPES, at)).all())
            tags = dict((await conn.execute(_COUNT_TAGS, at)).all())
            names: List[Tuple[Optional[str], str]] = []
            named: Dict[Optional[str], int] = {}
            for typ, name in (await conn.execute(
                    _NAMES_BY_ID, {**at, "rows": _SCHEMA_SAMPLE_ROWS})).all():
                if name and named.get(typ, 0) < 3:
                    named[typ] = named.get(typ, 0) + 1
                    names.append((typ, name))
        counts = {"nodes": nodes, "edges": edges, "names": names, "tags": tags}
        _schema_counts_cache[key] = counts
        while len(_schema_counts_cache) > _SCHEMA_COUNTS_KEPT:
            _schema_counts_cache.popitem(last=False)
        return counts

    async def state_at_commit(
        self, *, graph_id: str, commit_id: str, viewer: Optional[Viewer] = None,
    ) -> Dict[str, Dict[str, dict]]:
        """Full branch state as of a specific commit (time-travel by commit id)."""
        async with self._session() as s:
            c = await s.get(CommitORM, (graph_id, commit_id))
            if c is None:
                raise ValueError(f"unknown commit {commit_id}")
            branch_id, seq = c.branch_id, c.commit_seq
            await self._assert_branch_readable(s, await self._get_branch(s, graph_id, branch_id), viewer)
        return await self.materialize_state(graph_id=graph_id, branch_id=branch_id, as_of_seq=seq)

    @staticmethod
    async def _projection_quarantine(s, graph_id: str, sample: int = 20) -> Optional[Dict[str, object]]:
        """The entities a projection pass could not write on their own, held so the rest of its
        window published (``projection_quarantine``): how many, and the oldest ``sample`` with
        why. None when there are none."""
        from .models import ProjectionQuarantineORM as Q
        count = (await s.execute(select(func.count()).select_from(Q)
                                 .where(Q.graph_id == graph_id))).scalar_one()
        if not count:
            return None
        rows = (await s.execute(select(Q).where(Q.graph_id == graph_id)
                                .order_by(Q.first_at).limit(sample))).scalars().all()
        return {"count": int(count), "entities": [
            {"statement": r.statement, "entityKind": r.entity_kind, "entityKey": r.entity_key,
             "error": r.error, "attempts": r.attempts, "firstAt": r.first_at, "lastAt": r.last_at}
            for r in rows]}

    async def note_rollup_ask(self, graph_id: str, outcome: Optional[str]) -> None:
        """Record how an ask for a graph's lineage-summaries build went. ``active`` (a job was
        already running, which may have read the graph before the change that asked) and
        ``unreachable`` keep it owed, in ``projection_state.rollup_state``, for the liveness loop
        to ask again; anything else (``queued``, ``refused``, None: nothing to ask for) clears it.
        Never raises: an ask that can't be recorded is made again by the next change that hands
        the summaries over."""
        try:
            async with self._session() as s:
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is None:
                    return
                if outcome not in ("active", "unreachable"):
                    if ps.rollup_state is not None:
                        ps.rollup_state = None
                    return
                now = _now()
                ps.rollup_state = {"pending": outcome, "asked": now,
                                   "since": (ps.rollup_state or {}).get("since") or now}
        except Exception:                                # pragma: no cover - infra
            logger.warning("the rollup ask for %s (%s) was not recorded", graph_id, outcome,
                           exc_info=True)

    async def projection_watermark(self, graph_id: str) -> Dict[str, object]:
        """Read freshness for a graph's FalkorDB projection — attached to reads so
        a client knows whether it's seeing the latest committed `main`.

        A fork has no projection: it reads through its root's store (``reads_through``, the root's
        graph id), so its watermark is its root's — the root's revisions, freshness and state —
        naming no key, owning none: nothing reads a fork's key through it, and no screen shows a
        fork behind on a projection it does not have. Its route is where its reads come from
        (``reads_from``, :meth:`fork_reads_from`): past the ceiling its own layered reads in
        Postgres serve its main, whatever the root's projection holds. Residency (doc 17): the
        state is its root's, and a fork has no class of its own (``residency`` None)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            root = graph
            while root is not None and root.fork_parent_graph_id:
                parent = await s.get(GraphORM, root.fork_parent_graph_id)
                if parent is None:              # purged under it (an earlier release did)
                    raise ValueError(f"the graph fork {root.id} was forked from is gone")
                root = parent
        if root is not None and root.id != graph_id:
            wm = await self.projection_watermark(root.id)
            reads_from = await self.fork_reads_from(graph_id)
            if reads_from == "postgres":
                wm["read_route"] = {**wm["read_route"], "main": "postgres"}
            return {**wm, "reads_through": root.id, "reads_from": reads_from,
                    "falkor_graph_name": None, "falkor_provider": None,
                    "owns_falkor_graph": False, "retired_keys": [], "external_drift": None,
                    "residency": None}
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            committed = graph.main_head_commit_seq if graph else 0
            quarantine = (await self._projection_quarantine(s, graph_id)
                          if getattr(ps, "quarantine_next_at", None) else None)
            projected = ps.projected_commit_seq if ps else 0
            # The revision each side is at — the main commit with that seq (one indexed read). The
            # sync indicators show it, so "version #12" can be matched to a commit in History.
            revisions: Dict[int, CommitORM] = {}
            if graph and (committed or projected):
                main_id = await self._main_branch_id(s, graph_id)
                rows = (await s.execute(
                    select(CommitORM).where(
                        CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                        CommitORM.commit_seq.in_({committed, projected}),
                    )
                )).scalars().all()
                revisions = {int(c.commit_seq): c for c in rows}

            def _rev(seq: int) -> Optional[Dict[str, object]]:
                c = revisions.get(int(seq))
                return None if c is None else {
                    "commit_id": c.id, "created_at": c.created_at,
                    "actor": c.actor, "message": c.message,
                }
            status = ps.status if ps else "idle"
            fresh = serves_head(projected, committed, status)
            return {
                "committed_revision": _rev(committed),
                "projected_revision": _rev(projected),
                "committed": committed,
                "projected": projected,
                "target": ps.target_commit_seq if ps else 0,
                "status": status,
                "falkor_graph_name": ps.falkor_graph_name if ps else None,
                "falkor_provider": ps.falkor_provider if ps else None,
                "fresh": fresh,
                # Where reads go, by ContextEngine.for_workspace's rule: main from FalkorDB only
                # while the projection holds the head, else Postgres; a draft always overlays
                # whatever serves main.
                "read_route": {"main": "falkordb" if fresh else "postgres",
                               "drafts": "overlay"},
                # Failure reason + last success + live full-reseed progress — the Data
                # health UI needs these to converge to an honest done/failed state.
                "last_error": ps.last_error if ps else None,
                "last_projected_at": ps.last_projected_at if ps else None,
                "progress_done": ps.progress_done if ps else None,
                "progress_total": ps.progress_total if ps else None,
                # Whose key it is, the fencing epoch, and the poll's backoff — so a graph backing
                # off can be told from a wedged one. A liveness reset records its reason in
                # last_error with this prefix (FalkorProjector.check_liveness).
                "owns_falkor_graph": bool(ps.owns_falkor_graph) if ps else False,
                "epoch": ps.epoch if ps else 0,
                "failed_attempts": ps.failed_attempts if ps else 0,
                "next_retry_at": ps.next_retry_at if ps else None,
                "liveness_error": (ps.last_error if ps and (ps.last_error or "").startswith("liveness:")
                                   else None),
                # Old platform keys a move left, waiting to be dropped (move_projection).
                "retired_keys": list(ps.retired_keys or []) if ps else [],
                # What a customer's key holds that history doesn't, kept and flagged.
                "external_drift": ps.external_drift if ps else None,
                # Entities a pass could not write on their own, held so the rest published.
                "quarantine": quarantine,
                # Residency (doc 17): the class a system admin set, whether the key is in
                # FalkorDB (resident, evicted, rehydrating: being loaded, waiting_capacity: its
                # master has no room for it yet), why it was evicted, its last read and its size.
                "residency": ps.residency if ps else "standard",
                "residency_state": residency_state_of(
                    status, projected, ps.falkor_graph_name if ps else None, graph_id),
                "evicted_reason": ps.evicted_reason if ps else None,
                "last_read_at": ps.last_read_at if ps else None,
                "size_bytes": ps.size_bytes if ps else None,
                # When its load in flight started; a load has no timeout.
                "rehydrating_since": (ps.rehydrating_since if ps and status == "rehydrating"
                                      else None),
            }

    async def residency_state(self, graph_id: str) -> Optional[Dict[str, object]]:
        """What a read needs to know of a graph's residency (doc 17), in one small read: its
        projection ``status``, its class (``residency``), its measured ``size_bytes``, the head it
        is at (``committed``), and its store — ``projected``, ``fresh`` (:func:`serves_head`) and
        its pin. None for a graph with no projection row."""
        async with self._session() as s:
            row = (await s.execute(
                select(ProjectionStateORM.status, ProjectionStateORM.residency,
                       ProjectionStateORM.size_bytes, GraphORM.main_head_commit_seq,
                       ProjectionStateORM.projected_commit_seq, ProjectionStateORM.falkor_provider,
                       ProjectionStateORM.falkor_graph_name)
                .join(GraphORM, GraphORM.id == ProjectionStateORM.graph_id)
                .where(ProjectionStateORM.graph_id == graph_id))).first()
        if row is None:
            return None
        return {"status": row[0], "residency": row[1], "size_bytes": row[2], "committed": row[3],
                "projected": row[4], "fresh": serves_head(row[4], row[3], row[0]),
                "falkor_provider": row[5], "falkor_graph_name": row[6]}

    async def clear_external_changes(self, graph_id: str, seen_at: Optional[str] = None) -> None:
        """What the graph held that history didn't has been brought into it: the flag goes,
        whichever check raised it (``projection_state.external_drift``) — the flag as it was when
        the graph was read (``seen_at``, its ``at``; None: there was none). One raised since, say
        by a writer's notification that arrived during the read, stays: what it reports may not
        be in what was read."""
        at = ProjectionStateORM.external_drift["at"].astext
        async with self._session() as s:
            await s.execute(update(ProjectionStateORM)
                            .where(ProjectionStateORM.graph_id == graph_id,
                                   func.coalesce(at, "") == (seen_at or ""))
                            .values(external_drift=None)
                            .execution_options(synchronize_session=False))

    async def ensure_projection_target(
        self, *, graph_id: str, falkor_graph_name: str, provider_aliases: Sequence[str] = (),
    ) -> Optional[str]:
        """Pin an UNPINNED graph's FalkorDB projection to ``falkor_graph_name`` (the data source's
        real graph — the one the canvas reads). Self-healing: graphs auto-created before the name was
        injected have no pin, or the orphan ``gv_<id>`` that nothing reads, so merged main state never
        surfaces. A graph pinned to any other key keeps it: ``projection_state`` is authoritative and
        a pinned key changes only through :meth:`move_projection`.
        Re-pointing here and resetting ``projected_commit_seq`` to 0 makes the next projection replay
        the full committed ``main`` window ``(0, target]`` into the real graph — idempotent
        MERGE/DETACH DELETE, so it converges to exactly committed main (deletes included), once.
        Returns the OLD name when it changed (so the caller can drop the now-orphaned graph), else
        ``None``. A fork is left untouched — it has no FalkorDB graph of its own.

        Refused (:class:`ConcurrencyError`) while the graph's "enable version control" job is
        unfinished, and when another versioned graph already projects into ``falkor_graph_name``
        through the graph's provider or one of ``provider_aliases``, the providers on its server
        (:meth:`_claim_projection_key`)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None or graph.fork_parent_graph_id is not None:
                return None
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is None or ps.falkor_graph_name == falkor_graph_name:
                return None
            await self._assert_not_bootstrapping(s, graph_id)
            # projection_state is authoritative: only an unpinned graph (NULL, or the gv_<id>
            # placeholder nothing reads) is healed; a pinned key changes only through move_projection.
            if ps.falkor_graph_name not in (None, f"gv_{graph_id}"):
                return None
            await self._claim_projection_key(s, falkor_graph_name, ps.falkor_provider,
                                             provider_aliases=provider_aliases,
                                             exclude_graph_id=graph_id)
            old = ps.falkor_graph_name
            ps.falkor_graph_name = falkor_graph_name
            ps.projected_commit_seq = 0      # replay full main into the real graph on the next projection
            ps.epoch = ProjectionStateORM.epoch + 1     # a pass in flight must not write over it
            return old

    async def request_projection_rebuild(self, graph_id: str) -> bool:
        """Force the next projection pass to replay ALL of committed ``main`` from Postgres —
        the operational "rebuild the read cache from the source of truth" primitive. Resets
        ``projected_commit_seq`` to 0 and ``target_commit_seq`` to the current committed head,
        and flips ``status`` to ``rebuilding``; the next :meth:`FalkorProjector.project_graph`
        then does a clean wipe + full reseed (which re-fires the ``on_rollups_stale`` hook, so
        derived rollups rebuild too — no extra work here).

        Idempotent and race-safe: returns ``False`` WITHOUT touching state when a projection or
        rebuild is already in flight (``status in {projecting, rebuilding}`` and still behind its
        target), so a double-click or a poll-loop overlap can't rewind an in-progress apply. Takes
        the same per-graph advisory lock the main-advancing writes take, so two concurrent rebuild
        requests serialise on the watermark reset.

        Refused (:class:`ConcurrencyError`) while the graph's "enable version control" job is
        unfinished: a rebuild would wipe the data source's own FalkorDB graph and reseed it from a
        main parked at genesis. ``False`` for a fork, which has no FalkorDB copy to rebuild.

        An evicted graph (or one waiting for room) is left as it is and its load asked for instead,
        for the capacity loop to admit (``residency.request_load``) — whatever the Graph residency
        switch says: off, the loop brings such graphs back through admission too. A load in flight
        is a rebuild already running."""
        async with self._session() as s:
            await self._lock_graph(s, graph_id)
            await self._assert_not_bootstrapping(s, graph_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if ps is None or graph is None or graph.fork_parent_graph_id:
                return False
            if ps.status == "rehydrating":
                return False
            if ps.status in ("evicted", "waiting_capacity"):
                from .residency import request_load
                await request_load(graph_id)
                return True
            if ps.status in ("projecting", "rebuilding") and ps.projected_commit_seq < ps.target_commit_seq:
                return False
            ps.projected_commit_seq = 0
            ps.target_commit_seq = graph.main_head_commit_seq
            ps.status = "rebuilding"
            ps.last_error = None
            ps.epoch = ProjectionStateORM.epoch + 1     # a pass in flight must not write over it
            ps.failed_attempts = 0
            ps.next_retry_at = None
            return True

    async def move_projection(self, *, graph_id: str, provider: str, key: str, actor: str,
                              shard_map: dict) -> Dict[str, object]:
        """Move a graph's projection to FalkorDB key ``key`` on ``provider`` (doc 14 §6
        KeyMigration, phase 1: a reseed move). Swaps the pin, bumps the epoch so a pass in flight
        cannot publish over it, and lowers the watermark to 0 (``reseeding``), so the next pass
        reconciles all of committed main into the new key while reads fall back to Postgres. The
        old key is appended to ``retired_keys``, to be dropped once the new key has caught up and
        ``RETIRE_GRACE_SECS`` have passed; until then a move back onto it is allowed, and takes it
        off that list.

        Only keys the platform owns move: an unpinned graph and a graph still projecting into the
        customer's own key are refused (:class:`ProjectionNotAdopted`), and nothing is written. The
        target must be this graph's own platform key or one of its retired keys
        (:class:`ProjectionKeyInvalid`), and no other graph's pin (:class:`ProjectionKeyInUse`).
        Moving to the current pin changes nothing (``changed: False``). Refused
        (:class:`ConcurrencyError`) while the graph's "enable version control" job is unfinished.
        No FalkorDB I/O: the caller checks the key is free there and schedules the reseed. A graph
        that is not in FalkorDB — whatever the Graph residency switch says — only changes its pin,
        and its load is asked for again (``residency.request_load``) to seed the new key once
        admitted; a load in flight is fenced off and the graph is evicted again, to wait its turn."""
        default = config.DEFAULT_FALKOR_PROVIDER
        out = False                      # not in FalkorDB under residency: its load is asked for
        try:
            async with self._session() as s:
                await self._lock_graph(s, graph_id)
                graph = await s.get(GraphORM, graph_id)
                if graph is None or graph.deleted_at is not None:
                    raise ValueError(f"unknown graph {graph_id}")
                await self._assert_not_bootstrapping(s, graph_id)
                ps = (await s.execute(
                    select(ProjectionStateORM).where(ProjectionStateORM.graph_id == graph_id)
                    .with_for_update().execution_options(populate_existing=True)
                )).scalar_one_or_none()
                if ps is None:
                    raise ValueError(f"unknown graph {graph_id}")
                cur = {"providerId": ps.falkor_provider or default, "key": ps.falkor_graph_name}
                tgt = {"providerId": provider, "key": key}
                if cur == tgt:
                    return {"changed": False, "from": cur, "to": tgt, "retiring": None}
                if ps.falkor_graph_name in (None, f"gv_{graph_id}"):
                    raise ProjectionNotAdopted(
                        "unpinned", "this graph has no FalkorDB key yet; nothing to move")
                if not ps.owns_falkor_graph:
                    raise ProjectionNotAdopted(
                        "customer_key", "this graph projects into the customer's own FalkorDB "
                        "graph; only platform keys can be moved")
                retired = list(ps.retired_keys or [])
                own = [e for e in retired
                       if ((e.get("provider") or default), e["name"]) == (provider, key)]
                if not (own or keymigrate.is_owned_key(graph_id, key)):
                    raise ProjectionKeyInvalid(key)
                try:
                    await self._claim_projection_key(s, key, provider, exclude_graph_id=graph_id)
                except ConcurrencyError:
                    raise ProjectionKeyInUse(provider, key) from None
                entry = {"name": ps.falkor_graph_name, "provider": ps.falkor_provider,
                         "retireAfter": (datetime.now(timezone.utc)
                                         + timedelta(seconds=config.RETIRE_GRACE_SECS)).isoformat(),
                         "afterSeq": graph.main_head_commit_seq, "movedBy": actor}
                ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph = key, provider, True
                ps.projected_commit_seq = 0
                ps.target_commit_seq = graph.main_head_commit_seq
                out = ps.status in ("evicted", "waiting_capacity", "rehydrating")
                if not out:
                    ps.status = "reseeding"
                elif ps.status == "rehydrating":
                    ps.status, ps.rehydrating_since = "evicted", None
                ps.last_error = None
                ps.failed_attempts = 0
                ps.next_retry_at = None
                ps.progress_done = ps.progress_total = None
                ps.epoch = ProjectionStateORM.epoch + 1     # a pass in flight must not write over it
                ps.retired_keys = [e for e in retired if e not in own] + [entry]
                ps.shard_map = shard_map
        except IntegrityError:
            raise ProjectionKeyInUse(provider, key) from None     # uq_ps_key: a concurrent claim won
        if out:
            from .residency import request_load
            await request_load(graph_id)
        return {"changed": True, "from": cur, "to": tgt, "retiring": entry}

    async def adopt_projection(self, *, graph_id: str, key: str, actor: str,
                               shard_map: dict) -> Dict[str, object]:
        """Adopt (doc 17): move a graph that projects into the customer's own FalkorDB key onto
        its platform key ``key`` on the same provider — the reseed move of doc 14 §6. The pin
        swaps, the platform owns the key from then (its residency class applies), the epoch is
        bumped so a pass in flight cannot publish over it, and the watermark goes to 0
        (``reseeding``): the next pass seeds the key from Postgres, which serves the graph's reads
        until it catches up. The customer's key is left exactly as it was: never written,
        dropped, renamed, relabelled or retired. What it held that history didn't is no longer
        flagged (``external_drift``, returned as ``externalDrift``): the graph reads its own copy,
        and Bring into history no longer sees that key.

        Refused: an unpinned graph (:class:`ProjectionNotAdopted`), one already on a platform key
        (:class:`ProjectionAlreadyAdopted`), a key that is not this graph's platform key
        (:class:`ProjectionKeyInvalid`) or that another graph holds (:class:`ProjectionKeyInUse`),
        and while the graph's "enable version control" job is unfinished
        (:class:`ConcurrencyError`). No FalkorDB I/O: the caller checks the key is free there and
        schedules the reseed.

        Under the graph's projection lock, taken as a try: a pass in flight is fenced only when it
        finishes, after it has written its window and its marker into the customer's key, so
        while one holds the lock Adopt waits for it (:class:`ProjectionPassInFlight`)."""
        default = config.DEFAULT_FALKOR_PROVIDER
        lock_scope = (db.graphver_lock_session() if self._session is db.graphver_session
                      else self._session())
        lock_s = await lock_scope.__aenter__()
        lock_arg = func.hashtext(f"gvproj:{graph_id}")
        acquired = False
        try:
            acquired = bool(await lock_s.scalar(select(func.pg_try_advisory_lock(lock_arg))))
            if not acquired:
                raise ProjectionPassInFlight(graph_id)
            return await self._adopt_locked(graph_id, key, actor, shard_map, default)
        finally:
            try:
                if acquired:
                    await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
            finally:
                await lock_scope.__aexit__(None, None, None)

    async def _adopt_locked(self, graph_id: str, key: str, actor: str, shard_map: dict,
                            default: str) -> Dict[str, object]:
        try:
            async with self._session() as s:
                await self._lock_graph(s, graph_id)
                graph = await s.get(GraphORM, graph_id)
                if graph is None or graph.deleted_at is not None:
                    raise ValueError(f"unknown graph {graph_id}")
                await self._assert_not_bootstrapping(s, graph_id)
                ps = (await s.execute(
                    select(ProjectionStateORM).where(ProjectionStateORM.graph_id == graph_id)
                    .with_for_update().execution_options(populate_existing=True)
                )).scalar_one_or_none()
                if ps is None:
                    raise ValueError(f"unknown graph {graph_id}")
                if ps.falkor_graph_name in (None, f"gv_{graph_id}"):
                    raise ProjectionNotAdopted(
                        "unpinned", "this graph has no FalkorDB key yet; nothing to adopt")
                if ps.owns_falkor_graph:
                    raise ProjectionAlreadyAdopted(ps.falkor_graph_name)
                if not keymigrate.is_owned_key(graph_id, key):
                    raise ProjectionKeyInvalid(key)
                try:
                    await self._claim_projection_key(s, key, ps.falkor_provider,
                                                     exclude_graph_id=graph_id)
                except ConcurrencyError:
                    raise ProjectionKeyInUse(ps.falkor_provider or default, key) from None
                cur = {"providerId": ps.falkor_provider or default, "key": ps.falkor_graph_name}
                drift = ps.external_drift
                ps.falkor_graph_name, ps.owns_falkor_graph, ps.shard_map = key, True, shard_map
                ps.projected_commit_seq = 0
                ps.target_commit_seq = graph.main_head_commit_seq
                ps.status = "reseeding"
                ps.external_drift = None
                ps.last_error = None
                ps.failed_attempts = 0
                ps.next_retry_at = None
                ps.progress_done = ps.progress_total = None
                ps.epoch = ProjectionStateORM.epoch + 1     # a pass in flight must not write over it
        except IntegrityError:
            raise ProjectionKeyInUse(cur["providerId"], key) from None   # uq_ps_key: claimed
        return {"from": cur, "to": {"providerId": cur["providerId"], "key": key},
                "externalDrift": drift}

    async def reset_projection_watermarks(self, *, provider: str, actor: str,
                                          dry_run: bool = False) -> List[str]:
        """Disaster recovery: make the projector reseed every live graph on FalkorDB ``provider``
        (``'default'`` for the env instance) — after a restore, a shard rebuild or a region loss,
        when the keys may hold less than their watermarks say and graphs without a pass marker
        cannot tell. Lowers each projected watermark to 0, marks it ``reseeding`` (not an error:
        nothing failed) and bumps its epoch, so a pass in flight cannot publish over it; the poll
        then reseeds each key in place, writing only what differs. Graphs the poll does not
        project (unpinned, tombstoned, still being enabled for version control) are left alone,
        as are graphs parked at genesis on their data source's own key. A load in flight is not
        reseeded outside admission, whatever the Graph residency switch says: it is fenced off,
        evicted again and its load asked for again; a graph not in FalkorDB is at watermark 0,
        with nothing to reset.
        Returns the ids reset; ``dry_run`` returns the ids it would reset and changes nothing."""
        ps = ProjectionStateORM
        resettable = (
            func.coalesce(func.nullif(ps.falkor_provider, ""),
                          config.DEFAULT_FALKOR_PROVIDER) == provider,
            ps.projected_commit_seq > 0,
            # Parked at genesis on a key we did not mint: the key is the data source's own
            # graph, and a reseed from genesis would empty it (liveness's and eviction's rule).
            or_(ps.owns_falkor_graph.is_(True), ps.projected_commit_seq > 1),
            ps.falkor_graph_name.isnot(None),
            ps.falkor_graph_name != literal("gv_").concat(ps.graph_id),
            select(1).where(GraphORM.id == ps.graph_id, GraphORM.deleted_at.is_(None))
            .correlate(ps).exists(),
            ~select(1).where(*bootstrap_unfinished(ps.graph_id)).correlate(ps).exists(),
        )
        if dry_run:
            async with self._session() as s:
                return list((await s.execute(
                    select(ps.graph_id).where(*resettable).order_by(ps.graph_id)
                )).scalars().all())
        loading = ps.status == "rehydrating"
        async with self._session() as s:
            ids = (await s.execute(
                update(ps)
                .where(*resettable, ~loading)
                .values(projected_commit_seq=0, epoch=ps.epoch + 1, status="reseeding",
                        last_error=None,
                        failed_attempts=0, next_retry_at=None, updated_at=_now())
                .returning(ps.graph_id)
                .execution_options(synchronize_session=False)
            )).scalars().all()
            requeued = (await s.execute(
                update(ps)
                .where(*resettable, loading)
                .values(projected_commit_seq=0, epoch=ps.epoch + 1, status="evicted",
                        rehydrating_since=None, last_error=None,
                        failed_attempts=0, next_retry_at=None, updated_at=_now())
                .returning(ps.graph_id)
                .execution_options(synchronize_session=False)
            )).scalars().all()
        if requeued:
            from .residency import request_load
            for gid in requeued:
                await request_load(gid)
        logger.warning("%s reset the projection watermarks of %d graph(s) on FalkorDB provider %s",
                       actor, len(ids) + len(requeued), provider)
        return [*ids, *requeued]

    async def fence_projection_passes(self, *, provider: str) -> None:
        """FalkorDB ``provider`` moved to another server: bump the epoch of its graphs at
        watermark 0, so a full replay in flight — bound to the old server, and skipped by
        :meth:`reset_projection_watermarks` — cannot publish; the next pass reseeds on the new
        server. Harmless for a row at 0 with no pass: its next claim reads the new epoch."""
        ps = ProjectionStateORM
        async with self._session() as s:
            await s.execute(
                update(ps)
                .where(func.coalesce(func.nullif(ps.falkor_provider, ""),
                                     config.DEFAULT_FALKOR_PROVIDER) == provider,
                       ps.projected_commit_seq == 0)
                .values(epoch=ps.epoch + 1)
                .execution_options(synchronize_session=False))

    async def neighbors_from_state(
        self, *, graph_id: str, urn: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, depth: int = 1,
        direction: str = "both", edge_types: Optional[Sequence[str]] = None,
        limit: int = 500,
    ) -> Dict[str, List[dict]]:
        """Bounded neighborhood of a node on a branch (default `main`), served from
        Postgres — the fallback for the FalkorDB traversal when the projection
        lags/evicts, and the only path for drafts and as-of reads.

        Cost is **O(neighborhood)**, not O(graph): a hop-by-hop BFS that resolves only
        the start node and, per hop, the frontier's incident live edges via
        ix_ev_source/ix_ev_target (bounded by degree) — never composing full state.
        Reader-compatible shapes (GraphNode/GraphEdge by alias).
        """
        et = set(edge_types) if edge_types else None
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            start = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if start is None:
                return {"nodes": [], "edges": []}

            seen_nodes = {start}
            seen_edges: Dict[str, dict] = {}
            frontier = {start}
            for _ in range(max(1, depth)):
                if not frontier or len(seen_nodes) >= limit:
                    break
                inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
                nxt: set = set()
                for eid, p in inc.items():
                    if eid in seen_edges:
                        continue
                    if et is not None and (p.get("edgeType") not in et):
                        continue
                    src, tgt = _edge_src_tgt(p)
                    hit = None
                    if direction in ("out", "both") and src in frontier:
                        hit = tgt
                    elif direction in ("in", "both") and tgt in frontier:
                        hit = src
                    if hit is None:
                        continue
                    seen_edges[eid] = p
                    if hit not in seen_nodes:
                        if len(seen_nodes) >= limit:
                            continue
                        seen_nodes.add(hit)
                        nxt.add(hit)
                frontier = nxt

            payloads = await self._current_values(s, graph_id, branch_id, seen_nodes, as_of_seq)

        nodes = {eid: p for eid, p in payloads.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_edges = [
            _graphedge_dict(eid, p, urn_of) for eid, p in seen_edges.items()
            if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes
        ]
        return {"nodes": out_nodes, "edges": out_edges}

    async def _branch_read_seqs(
        self, s, graph_id: str, branch_id: str, main_id: str, as_of_seq: Optional[int],
    ) -> Tuple[int, Optional[int]]:
        """The two sequence bounds a branch read composes over: the discovery cap on the
        shared ``main`` base and the overlay cap on the branch. ``main`` itself has no
        overlay (``None``); ``as_of_seq`` caps both for time-travel."""
        if branch_id == main_id:
            g = await s.get(GraphORM, graph_id)
            head = g.main_head_commit_seq if g else 0
            return (head if as_of_seq is None else min(head, as_of_seq)), None
        b = await s.get(BranchORM, branch_id)
        base_seq = b.base_commit_seq or 0
        base = base_seq if as_of_seq is None else min(base_seq, as_of_seq)
        overlay = (1 << 62) if as_of_seq is None else as_of_seq
        return base, overlay

    async def _latest_live_ids(
        self, s, model, graph_id: str, branch_id: str, seq: int,
        *, where: Optional[Callable] = None, limit: Optional[int] = None,
        by_name: bool = False,
    ) -> List[str]:
        """Entity ids whose latest version on ``branch_id`` at ``commit_seq <= seq`` is live
        (not a tombstone), optionally narrowed by ``where`` (predicates over the denormalised
        version columns). DISTINCT ON picks the latest row per entity *before* the live/where
        filter, so a stale revision can never shadow the current one. Bounded by ``limit`` and
        ordered by entity_id for a stable window — or, ``by_name``, by (display name, entity_id)
        in BYTE order with a missing name as "": exactly the order a caller then sorts in
        Python, so a window of the first N ids holds the first N rows a page can need.

        A fork's ``main`` lists what it inherited too: each graph its reads compose
        (:meth:`_layers`), an entity decided by the nearest that has a row of it; the window is
        the first rows of each, merged."""
        layers = await self._layers(s, graph_id, branch_id, seq)
        found: List[tuple] = []
        for i, (gid, bid, at) in enumerate(layers):
            latest = (
                select(model)
                .where(model.graph_id == gid, model.branch_id == bid, model.commit_seq <= at)
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id)
                .subquery()
            )
            name = func.coalesce(latest.c.display_name, "").collate("C") if by_name else null()
            stmt = select(latest.c.entity_id, name).where(latest.c.op != "delete")
            for near_gid, near_bid, near_at in layers[:i]:      # a nearer layer's row decides
                near = aliased(model)
                stmt = stmt.where(~select(near.id).where(
                    near.graph_id == near_gid, near.branch_id == near_bid,
                    near.entity_id == latest.c.entity_id, near.commit_seq <= near_at).exists())
            if where is not None:
                preds = where(latest.c)
                if preds:
                    stmt = stmt.where(*preds)
            if by_name:
                stmt = stmt.order_by(name, latest.c.entity_id.collate("C"))
            else:
                stmt = stmt.order_by(latest.c.entity_id)
            if limit is not None:
                stmt = stmt.limit(limit)
            found.extend((await s.execute(stmt)).all())
        if len(layers) > 1:
            found.sort(key=lambda r: (r[1], r[0]) if by_name else r[0])
        return [eid for eid, _name in found[:limit]]

    async def _eids_for_urns(
        self, s, graph_id: str, branch_id: str, urns, as_of_seq: Optional[int] = None,
    ) -> set:
        """Resolve a small set of seed urns to live entity_ids on a branch (bounded)."""
        out: set = set()
        for u in urns or []:
            eid = await self._eid_for_urn(s, graph_id, branch_id, u, as_of_seq)
            if eid is not None:
                out.add(eid)
        return out

    async def ancestor_chains(
        self, *, graph_id: str, branch_id: str, urns: Sequence[str],
        containment_edge_types: Sequence[str], as_of_seq: Optional[int] = None,
    ) -> Dict[str, List[str]]:
        """Each urn's containment chain on a branch — ``{urn: [parent, …, root]}``, ``[]`` for a root —
        read from the branch's own state (a draft's moves included). An urn that is not a live node
        here is absent (UNKNOWN), never a root. Bounded by hierarchy depth; batched per level. A
        fork finds a node it inherited by its urn among its layers' rows (:meth:`_layer_graph_ids`)."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        if not urns or not cset:
            return {}
        async with self._session() as s:
            # urn → live entity id, in batches (a node's id is usually its urn; imported ones may not be).
            cand: Dict[str, set] = {}
            for u in urns:
                if u.startswith("gv:"):
                    cand.setdefault(u[3:], set()).add(u)
                cand.setdefault(u, set()).add(u)
            graphs = await self._layer_graph_ids(s, graph_id)
            for chunk in _chunks(list(urns), _IN_LIST_MAX):
                for eid, urn in (await s.execute(
                    select(NodeVersionORM.entity_id, NodeVersionORM.urn).where(
                        NodeVersionORM.graph_id.in_(graphs), NodeVersionORM.urn.in_(chunk),
                    ).distinct()
                )).all():
                    cand.setdefault(eid, set()).add(urn)
            vals = await self._current_values(s, graph_id, branch_id, list(cand), as_of_seq)
            eid_of: Dict[str, str] = {}
            for eid, asked in cand.items():
                v = vals.get(eid)
                if v is None or _is_edge_payload(v):
                    continue
                for u in asked:
                    if v.get("urn") == u or f"gv:{eid}" == u or eid == u:
                        eid_of.setdefault(u, eid)
            if not eid_of:
                return {}
            seen, edges = await self._containment_parents_climb(
                s, graph_id, branch_id, set(eid_of.values()), cset, as_of_seq)
            parent: Dict[str, str] = {}
            for p in edges.values():
                a, b = _edge_src_tgt(p)
                if a and b:
                    parent.setdefault(b, a)
            node_vals = await self._current_values(s, graph_id, branch_id, list(seen), as_of_seq)
            urn_of = {e: ((v or {}).get("urn") or f"gv:{e}") for e, v in node_vals.items()}
            out: Dict[str, List[str]] = {}
            for u, eid in eid_of.items():
                chain, at, guard = [], parent.get(eid), set()
                while at and at not in guard:
                    guard.add(at)
                    chain.append(urn_of.get(at, at))
                    at = parent.get(at)
                out[u] = chain
            return out

    async def get_node_from_state(
        self, *, graph_id: str, urn: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, containment_edge_types: Optional[Sequence[str]] = None,
    ) -> Optional[dict]:
        """A single node by urn on a branch (default ``main``), branch/as-of composed — the
        draft/as-of counterpart of the provider's ``get_node``. Reader-shaped or ``None``;
        carries ``childCount`` (parity with FalkorDB) when containment types are supplied."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            eid = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if eid is None:
                return None
            p = (await self._current_values(s, graph_id, branch_id, [eid], as_of_seq)).get(eid)
            if p is None or _is_edge_payload(p):
                return None
            nd = _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
            await self._attach_child_counts(s, graph_id, branch_id, [nd], cset, as_of_seq)
        return nd

    async def _attach_child_counts(self, s, graph_id, branch_id, node_dicts, cset, as_of_seq):
        """Attach each node's OUT-containment child count to its reader dict — the single
        count-shaping path shared by every branch/as-of node read (``get_nodes_from_state``,
        ``get_children_with_edges_from_state``, ``top_level_from_state``), so the Postgres
        reader can't drift from FalkorDB (which counts children in every read). One bounded
        ``_incident_live_edges`` scan over the page's ids; ``childCount`` is always set (0 when
        there are no containment children), matching FalkorDB's ``0 as childCount``."""
        ids = {nd["entityId"] for nd in node_dicts}
        counts: Dict[str, int] = {}
        if cset and ids:
            inc = await self._incident_live_edges(s, graph_id, branch_id, ids, as_of_seq)
            for _eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, _b = _edge_src_tgt(p)
                if a in ids:
                    counts[a] = counts.get(a, 0) + 1
        for nd in node_dicts:
            _set_child_count(nd, counts.get(nd["entityId"], 0))

    async def get_nodes_from_state(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, urns: Optional[Sequence[str]] = None,
        entity_types: Optional[Sequence[str]] = None,
        search_query: Optional[str] = None, limit: int = 100, offset: int = 0,
        containment_edge_types: Optional[Sequence[str]] = None,
        include_child_count: bool = True,
    ) -> List[dict]:
        """Branch- and as-of-aware node filter read, served from Postgres — the draft/as-of
        counterpart of the provider's ``get_nodes``, so a user working in a draft sees their
        draft's view, not ``main``'s. Bounded: discover candidate ids from the shared ``main``
        base (pushed-down denorm-column filters, capped) ∪ the draft's tiny overlay, compose
        the authoritative value via ``_current_values``, then re-apply the predicate (so an
        overlay edit that flips whether a base node matches is honoured). Never composes full
        state. Reader-shaped GraphNode dicts, sorted by display name.

        Pagination is exact for a page that fits the fetch window (the common draft case); a
        very large filtered set at a deep ``offset`` is best-effort — the hot, deeply-paged
        path is ``main`` via FalkorDB, not this fallback."""
        urn_set = set(urns) if urns else None
        type_set = set(entity_types) if entity_types else None
        q = (search_query or "").strip().lower()

        def matches(p: dict) -> bool:
            if urn_set is not None and p.get("urn") not in urn_set:
                return False
            if type_set is not None and p.get("entityType") not in type_set:
                return False
            if q:
                hay = " ".join(str(p.get(k) or "")
                               for k in ("displayName", "qualifiedName", "urn")).lower()
                if q not in hay:
                    return False
            return True

        def where(c):
            preds = []
            if type_set is not None:
                preds.append(c.entity_type.in_(list(type_set)))
            if urn_set is not None:
                preds.append(c.urn.in_(list(urn_set)))
            if q:
                like = f"%{q}%"
                preds.append(or_(func.lower(c.display_name).like(like),
                                 func.lower(c.qualified_name).like(like),
                                 func.lower(c.urn).like(like)))
            return preds

        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq, overlay_seq = await self._branch_read_seqs(
                s, graph_id, branch_id, main_id, as_of_seq)
            overlay_ids: List[str] = []
            if overlay_seq is not None:
                overlay_ids = list((await s.execute(
                    select(NodeVersionORM.entity_id).where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.branch_id == branch_id,
                        NodeVersionORM.commit_seq <= overlay_seq,
                    ).distinct()
                )).scalars().all())
            # The window must be the first rows in the order the page is cut from
            # (name, then id) — in entity_id order it was an arbitrary slice, and a
            # deep page skipped rows and repeated others.
            window = offset + limit + len(overlay_ids) + 1
            cand = set(await self._latest_live_ids(
                s, NodeVersionORM, graph_id, main_id, base_seq, where=where, limit=window,
                by_name=True))
            cand.update(overlay_ids)
            vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
            rows = [
                _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
                for eid, p in vals.items()
                if p is not None and not _is_edge_payload(p) and matches(p)
            ]
            rows.sort(key=lambda r: ((r.get("displayName") or ""), r["entityId"]))
            page = rows[offset: offset + limit]
            if include_child_count:
                cset = {t.upper() for t in (containment_edge_types or [])}
                await self._attach_child_counts(s, graph_id, branch_id, page, cset, as_of_seq)
        return page

    async def search_from_state(
        self, *, graph_id: str, query: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, limit: int = 25,
    ) -> List[dict]:
        """Name/qualified-name/urn substring search on a branch (default ``main``) — the
        draft/as-of counterpart of the provider's search. Thin wrapper over
        ``get_nodes_from_state``."""
        return await self.get_nodes_from_state(
            graph_id=graph_id, branch_id=branch_id, as_of_seq=as_of_seq,
            search_query=query, limit=limit)

    async def get_edges_from_state(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, source_urns: Optional[Sequence[str]] = None,
        target_urns: Optional[Sequence[str]] = None, any_urns: Optional[Sequence[str]] = None,
        edge_types: Optional[Sequence[str]] = None, min_confidence: Optional[float] = None,
        limit: int = 100, offset: int = 0,
    ) -> List[dict]:
        """Branch- and as-of-aware edge filter read, served from Postgres — the draft/as-of
        counterpart of the provider's ``get_edges``. With endpoint urns it walks the
        endpoints' incident live edges (bounded by degree via ix_ev_source/ix_ev_target);
        otherwise it discovers edges by type from the shared base ∪ the draft overlay.
        Endpoints are resolved to urns for reader-shaped GraphEdge dicts."""
        et = set(edge_types) if edge_types else None
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)

            src_ids = await self._eids_for_urns(s, graph_id, branch_id, source_urns, as_of_seq) if source_urns else None
            tgt_ids = await self._eids_for_urns(s, graph_id, branch_id, target_urns, as_of_seq) if target_urns else None
            any_ids = await self._eids_for_urns(s, graph_id, branch_id, any_urns, as_of_seq) if any_urns else None

            cand_edges: Dict[str, dict] = {}
            if src_ids is not None or tgt_ids is not None or any_ids is not None:
                seeds: set = set()
                for grp in (src_ids, tgt_ids, any_ids):
                    if grp:
                        seeds.update(grp)
                inc = await self._incident_live_edges(s, graph_id, branch_id, seeds, as_of_seq)
                for eid, p in inc.items():
                    a, b = _edge_src_tgt(p)
                    if src_ids is not None and a not in src_ids:
                        continue
                    if tgt_ids is not None and b not in tgt_ids:
                        continue
                    if any_ids is not None and not (a in any_ids or b in any_ids):
                        continue
                    cand_edges[eid] = p
            else:
                base_seq, overlay_seq = await self._branch_read_seqs(
                    s, graph_id, branch_id, main_id, as_of_seq)
                overlay_ids: List[str] = []
                if overlay_seq is not None:
                    overlay_ids = list((await s.execute(
                        select(EdgeVersionORM.entity_id).where(
                            EdgeVersionORM.graph_id == graph_id,
                            EdgeVersionORM.branch_id == branch_id,
                            EdgeVersionORM.commit_seq <= overlay_seq,
                        ).distinct()
                    )).scalars().all())
                window = offset + limit + len(overlay_ids) + 1
                cand = set(await self._latest_live_ids(
                    s, EdgeVersionORM, graph_id, main_id, base_seq,
                    where=(lambda c: [c.edge_type.in_(list(et))]) if et is not None else None,
                    limit=window))
                cand.update(overlay_ids)
                vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
                cand_edges = {eid: p for eid, p in vals.items()
                              if p is not None and _is_edge_payload(p)}

            sel: Dict[str, dict] = {}
            for eid, p in cand_edges.items():
                if et is not None and p.get("edgeType") not in et:
                    continue
                if min_confidence is not None and (p.get("confidence") or 0.0) < min_confidence:
                    continue
                sel[eid] = p

            endpoint_ids: set = set()
            for p in sel.values():
                a, b = _edge_src_tgt(p)
                endpoint_ids.add(a)
                endpoint_ids.add(b)
            node_vals = await self._current_values(s, graph_id, branch_id, endpoint_ids, as_of_seq)

        urn_of = {
            eid: ((p.get("urn") if (p is not None and not _is_edge_payload(p)) else None) or f"gv:{eid}")
            for eid, p in node_vals.items()
        }
        out = [_graphedge_dict(eid, p, urn_of) for eid, p in sel.items()]
        out.sort(key=lambda r: r["id"])
        return out[offset: offset + limit]

    async def get_children_with_edges_from_state(
        self, *, graph_id: str, parent_urn: str, containment_edge_types: Sequence[str],
        lineage_edge_types: Optional[Sequence[str]] = None, branch_id: Optional[str] = None,
        as_of_seq: Optional[int] = None, include_lineage_edges: bool = True,
        include_child_count: bool = True, limit: int = 100, offset: int = 0,
        lineage_scope: str = "page",
    ) -> Dict[str, object]:
        """Branch/as-of-aware children-with-edges — the draft/as-of counterpart of the
        provider's ``get_children_with_edges``. One bounded round trip: the parent's OUT
        containment edges give the children (in = ancestors), then the page children's
        cross-edges give the lineage edges within {parent} ∪ children. Bounded by the
        parent's and the page's degree (ix_ev_source/target); mirrors ChildrenWithEdgesResult.
        Edge-type classification is the graph's ontology sets, matched case-insensitively.
        ``lineage_scope="siblings"`` widens the far end from this page to EVERY child
        of the parent (the incident scan is still over the page only)."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        empty = {"children": [], "containmentEdges": [], "lineageEdges": [],
                 "totalChildren": 0, "hasMore": False, "nextCursor": None, "nextOffset": offset}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            parent = await self._eid_for_urn(s, graph_id, branch_id, parent_urn, as_of_seq)
            if parent is None:
                return empty
            # parent's live incident edges → OUT containment edges name the children
            inc = await self._incident_live_edges(s, graph_id, branch_id, {parent}, as_of_seq)
            cont_edge: Dict[str, Tuple[str, dict]] = {}   # child_eid -> (edge_id, payload)
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)
                if a == parent and b != parent:
                    cont_edge[b] = (eid, p)
            child_vals = await self._current_values(s, graph_id, branch_id, list(cont_edge), as_of_seq)
            live = [(eid, p) for eid, p in child_vals.items()
                    if p is not None and not _is_edge_payload(p)]
            live.sort(key=lambda kv: ((kv[1].get("displayName") or ""), kv[0]))
            total = len(live)
            page = live[offset: offset + limit]
            page_ids = {eid for eid, _ in page}

            lineage: List[Tuple[str, dict]] = []
            child_cc: Dict[str, int] = {}
            if page_ids and (include_lineage_edges or include_child_count):
                scope = page_ids | {parent}
                if lineage_scope == "siblings":
                    scope = scope | set(cont_edge)
                # One incident scan over the page serves both the lineage edges and each child's
                # OUT-containment count (so an expanded child shows its own chevron) — no extra query.
                for eid, p in (await self._incident_live_edges(s, graph_id, branch_id, page_ids, as_of_seq)).items():
                    et = (p.get("edgeType") or "").upper()
                    a, b = _edge_src_tgt(p)
                    if et in cset:
                        if include_child_count and a in page_ids:
                            child_cc[a] = child_cc.get(a, 0) + 1
                        continue
                    if include_lineage_edges and (lset is None or et in lset) and a in scope and b in scope:
                        lineage.append((eid, p))

            need = page_ids | {parent}
            for _, p in lineage:
                a, b = _edge_src_tgt(p)
                need.update((a, b))
            node_vals = await self._current_values(s, graph_id, branch_id, need, as_of_seq)

        urn_of = {
            eid: ((p.get("urn") if (p is not None and not _is_edge_payload(p)) else None) or f"gv:{eid}")
            for eid, p in node_vals.items()
        }
        children_out = [_graphnode_dict(eid, urn_of.get(eid, f"gv:{eid}"), p) for eid, p in page]
        if include_child_count:
            for nd in children_out:
                _set_child_count(nd, child_cc.get(nd["entityId"], 0))
        cont_out = [_graphedge_dict(cont_edge[eid][0], cont_edge[eid][1], urn_of) for eid, _ in page]
        lin_out = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage]
        has_more = offset + len(page) < total
        return {
            "children": children_out,
            "containmentEdges": cont_out,
            "lineageEdges": lin_out,
            "totalChildren": total,
            "hasMore": has_more,
            "nextCursor": (children_out[-1]["displayName"] if (children_out and has_more) else None),
            "nextOffset": offset + len(page),
        }

    async def top_level_from_state(
        self, *, graph_id: str, containment_edge_types: Sequence[str],
        root_entity_types: Optional[Sequence[str]] = None,
        branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        entity_types: Optional[Sequence[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware top-level/orphan read — the draft/as-of counterpart of the
        provider's ``get_top_level_or_orphan_nodes``. A node is "top-level" iff no live edge of
        a containment type points *at* it (root instances ∪ orphans of non-root types). Bounded:
        discover candidate ids from the shared base ∪ the draft overlay (capped), then one
        incident-edge scan over the candidates (bounded by their degree) classifies each and,
        optionally, counts its OUT containment children. Keyset-paginated by displayName; mirrors
        TopLevelNodesResult. Best-effort for very large sets — the hot path is ``main`` via FalkorDB."""
        cset = {t.upper() for t in (containment_edge_types or [])}
        rset = {str(t) for t in (root_entity_types or [])}
        type_set = set(entity_types) if entity_types else None
        q = (search_query or "").strip().lower()

        def matches(p: dict) -> bool:
            if type_set is not None and p.get("entityType") not in type_set:
                return False
            if q:
                hay = " ".join(str(p.get(k) or "")
                               for k in ("displayName", "qualifiedName", "urn")).lower()
                if q not in hay:
                    return False
            return True

        def where(c):
            preds = []
            if type_set is not None:
                preds.append(c.entity_type.in_(list(type_set)))
            if q:
                like = f"%{q}%"
                preds.append(or_(func.lower(c.display_name).like(like),
                                 func.lower(c.qualified_name).like(like),
                                 func.lower(c.urn).like(like)))
            return preds

        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq, overlay_seq = await self._branch_read_seqs(
                s, graph_id, branch_id, main_id, as_of_seq)
            overlay_ids: List[str] = []
            if overlay_seq is not None:
                overlay_ids = list((await s.execute(
                    select(NodeVersionORM.entity_id).where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.branch_id == branch_id,
                        NodeVersionORM.commit_seq <= overlay_seq,
                    ).distinct()
                )).scalars().all())
            # Discover candidates with a GROWING window until a full page of
            # top-level nodes emerges or the candidate space is exhausted.
            # The old fixed ``limit*4`` over-fetch sampled candidates in
            # arbitrary order and pruned AFTER — on graphs whose roots sit
            # late in that order (observed live: 10 Roots among 275
            # contained Nodes), the UNFILTERED browse returned ZERO rows and
            # the view wizard rendered "the graph may be empty" while the
            # type-filtered chips worked (their predicate narrows discovery
            # BEFORE the sample).
            window = (limit * 4) + len(overlay_ids) + 1
            while True:
                cand = set(await self._latest_live_ids(
                    s, NodeVersionORM, graph_id, main_id, base_seq, where=where, limit=window))
                exhausted = len(cand) < window
                cand.update(overlay_ids)
                vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
                nodes = {eid: p for eid, p in vals.items()
                         if p is not None and not _is_edge_payload(p) and matches(p)}
                inc = await self._incident_live_edges(s, graph_id, branch_id, set(nodes), as_of_seq)
                has_incoming_cont: set = set()
                child_count: Dict[str, int] = {}
                for eid, p in inc.items():
                    if (p.get("edgeType") or "").upper() not in cset:
                        continue
                    a, b = _edge_src_tgt(p)
                    if b in nodes:
                        has_incoming_cont.add(b)
                    if include_child_count and a in nodes:
                        child_count[a] = child_count.get(a, 0) + 1
                top = [(eid, p) for eid, p in nodes.items() if eid not in has_incoming_cont]
                past_cursor = (
                    [kv for kv in top if (kv[1].get("displayName") or "") > cursor]
                    if cursor else top
                )
                if exhausted or len(past_cursor) > limit:
                    break
                window *= 4

        top.sort(key=lambda kv: ((kv[1].get("displayName") or ""), kv[0]))
        total = len(top)
        after = [kv for kv in top if (kv[1].get("displayName") or "") > cursor] if cursor else top
        page = after[:limit]
        has_more = len(after) > limit
        out_nodes: List[dict] = []
        root_count = 0
        orphan_count = 0
        for eid, p in page:
            nd = _graphnode_dict(eid, p.get("urn") or f"gv:{eid}", p)
            if include_child_count:
                _set_child_count(nd, child_count.get(eid, 0))
            out_nodes.append(nd)
            if rset and p.get("entityType") in rset:
                root_count += 1
            else:
                orphan_count += 1
        return {
            "nodes": out_nodes,
            # A window that stopped early saw only part of the set: no total
            # rather than a too-low one.
            "totalCount": total if exhausted else None,
            "hasMore": has_more,
            "nextCursor": (out_nodes[-1]["displayName"] if (out_nodes and has_more) else None),
            "rootTypeCount": root_count,
            "orphanCount": orphan_count,
        }

    async def _containment_ancestors(
        self, s, graph_id: str, branch_id: str, node_ids: set,
        cset: set, as_of_seq: Optional[int], max_climb: int = 64,
    ) -> Tuple[set, Dict[str, dict]]:
        """Climb live IN containment edges from *node_ids* to their roots — bounded by the
        hierarchy depth. Returns (all node ids incl. inputs + ancestors, {edge_id: payload})."""
        seen = set(node_ids)
        edges: Dict[str, dict] = {}
        frontier = set(node_ids)
        for _ in range(max_climb):
            if not frontier:
                break
            inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
            nxt: set = set()
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)   # a = parent (source), b = child (target)
                if b in frontier and a:
                    edges[eid] = p
                    if a not in seen:
                        seen.add(a)
                        nxt.add(a)
            frontier = nxt
        return seen, edges

    async def _containment_parents_climb(
        self, s, graph_id: str, branch_id: str, node_ids: set,
        cset: set, as_of_seq: Optional[int], max_climb: int = 64, *, skeleton: bool = False,
    ) -> Tuple[set, Dict[str, dict]]:
        """:meth:`_containment_ancestors`, reading only what a climb needs: per level, the
        edges whose TARGET is on the frontier and whose type is containment
        (``ix_ev_target``), then their values as-of. The general helper reads every edge
        touching the frontier in both directions, lineage included — for a batch of
        endpoints under wide containers that is millions of rows to find a few parents.
        ``skeleton`` returns the edges as :meth:`_skeletons_at` (no payload read)."""
        seen = set(node_ids)
        edges: Dict[str, dict] = {}
        frontier = set(node_ids)
        cupper = {c.upper() for c in cset}
        read = self._current_skeletons if skeleton else self._current_values
        for _ in range(max_climb):
            if not frontier:
                break
            cand = await self._incident_edge_ids(s, graph_id, branch_id, frontier,
                                                 sides=("target",), edge_types=cupper)
            vals = await read(s, graph_id, branch_id, cand, as_of_seq)
            nxt: set = set()
            for eid, p in vals.items():
                if p is None or (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)   # a = parent (source), b = child (target)
                if b in frontier and a:
                    edges[eid] = p
                    if a not in seen:
                        seen.add(a)
                        nxt.add(a)
            frontier = nxt
        return seen, edges

    async def _containment_descendants(
        self, s, graph_id: str, branch_id: str, root_ids: set,
        cset: set, as_of_seq: Optional[int], cap: int, max_depth: int = 64,
    ) -> set:
        """Walk live OUT containment edges down from *root_ids* — the subtree, bounded by ``cap``."""
        seen = set(root_ids)
        frontier = set(root_ids)
        for _ in range(max_depth):
            if not frontier or len(seen) >= cap:
                break
            inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
            nxt: set = set()
            for eid, p in inc.items():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)   # a = parent (source), b = child (target)
                if a in frontier and b and b not in seen:
                    if len(seen) >= cap:
                        break
                    seen.add(b)
                    nxt.add(b)
            frontier = nxt
        return seen

    async def _enforce_written(
        self, s, graph_id: str, branch_id: str,
        written: Mapping[str, Optional[dict]], prior: Mapping[str, Optional[dict]],
        kind_by_entity: Mapping[str, str], *,
        containment_edge_types: Sequence[str], ontology_rules: Optional[OntologyRules],
        strict: bool, known: Optional[Mapping[str, Optional[dict]]] = None,
        edited: Collection[str] = (), also_writing: Optional[str] = None, parentless: bool = True,
        review: Optional[Callable[[List[str]], Awaitable[Dict[str, Optional[dict]]]]] = None,
    ) -> None:
        """The ONE gate every write path shares (canvas save, checkpoint, publish): it judges the
        state being WRITTEN (``written``: entity → new value, ``None`` = delete) against what it
        replaces (``prior``), never the ops that expressed it. Raises :class:`OntologyViolation`.

        * Nothing is created untyped — every enforcement mode.
        * Hierarchy integrity for every NEW or RE-POINTED edge (no duplicate, no second
          containment parent, no loop) — every enforcement mode.
        * Under strict enforcement with the graph's ontology: a node's type must be declared, an
          edge's type declared and its ends of the allowed types, a containment allowed by the
          parent's ``can_contain``. Judged as a create for anything new AND for anything whose
          type-defining fields change (a retype, a re-pointed or re-typed edge) — only an edit
          that leaves them alone is exempt, so legacy data stays editable. Retyping a node
          re-judges its existing edges against its NEW type, so a retype cannot leave the graph
          holding relationships the ontology forbids.
        ``known`` adds values the caller already holds (e.g. a merge's composed state) for typing
        edge ends; anything else is read from the branch.

        A write judged a page at a time (:meth:`_squash_paged`) names the branch whose heads its
        other pages write (``also_writing``): an edge on a retyped node that one of them rewrites is
        judged there, with its new value. A fork's review, judged a step at a time
        (:meth:`_squash_fork`), gives its own view of that instead (``review``): which of some
        entities it writes, as it writes them. ``parentless=False`` leaves the parent check to the
        caller, once every page is written."""
        live = {eid: v for eid, v in written.items() if v is not None}

        untyped = _untyped_creations(
            {eid: v for eid, v in live.items() if prior.get(eid) is None}, kind_by_entity, edited)
        if untyped:
            raise OntologyViolation(untyped)

        judged: Dict[str, str] = {
            eid: ("create" if _redefines(prior.get(eid), v, kind_by_entity.get(eid, "node"))
                  else "update")
            for eid, v in live.items()}
        edge_writes = [(eid, v) for eid, v in live.items()
                       if kind_by_entity.get(eid) == "edge" and judged[eid] == "create"]
        deleted_edges = {eid for eid, v in written.items()
                         if v is None and kind_by_entity.get(eid) == "edge"}
        if edge_writes:
            viol = await self._validate_edge_integrity(
                s, graph_id, branch_id, edge_writes, deleted_edges, containment_edge_types or [])
            if viol:
                raise OntologyViolation(viol)

        if ontology_rules is None or not strict:
            return
        rich = [(eid, kind_by_entity.get(eid, "node"), v, judged[eid]) for eid, v in live.items()]
        retyped = [eid for eid, v in live.items()
                   if kind_by_entity.get(eid, "node") == "node" and judged[eid] == "create"
                   and prior.get(eid) is not None]
        if retyped:
            incident = await self._incident_live_edges(s, graph_id, branch_id, retyped)
            if review is not None and incident:
                elsewhere = set(await review(list(incident)))
            else:
                elsewhere = (await self._heads_present(s, graph_id, also_writing, list(incident))
                             if also_writing and incident else set())
            for eid, v in incident.items():
                if eid not in written and eid not in elsewhere:   # judged with their new values
                    rich.append((eid, "edge", v, "create"))
        endpoint_types: Dict[str, str] = {}
        unknown: set = set()
        for _eid, kind, v, op in rich:
            if kind != "edge" or op != "create":
                continue
            for ep in _edge_src_tgt(v):
                if not ep or ep in endpoint_types:
                    continue
                ev = written.get(ep) if ep in written else (known or {}).get(ep) or prior.get(ep)
                if ev and ev.get("entityType"):
                    endpoint_types[ep] = ev["entityType"]
                elif ep not in written:
                    unknown.add(ep)
        if unknown:
            # A page types an end another page writes as the merged state holds it: the draft's own
            # view (``main`` where the draft left it alone), canonical as ``known`` would hold it.
            values = await self._current_skeletons(s, graph_id, also_writing or branch_id, list(unknown))
            if review is not None:
                values.update(await review(list(unknown)))
            elif also_writing:
                for ep in await self._heads_present(s, graph_id, also_writing, list(values)):
                    if values[ep]:
                        canonicalize_payload_types(values[ep], ontology_rules)
            for ep, ev in values.items():
                if ev and ev.get("entityType"):
                    endpoint_types[ep] = ev["entityType"]
        viol = validate_entities_rich(rich, endpoint_types, ontology_rules)
        if viol:
            raise OntologyViolation(viol)
        if not parentless:
            return
        viol = await self._parentless_violations(
            s, graph_id, branch_id, written, prior, kind_by_entity, ontology_rules)
        if viol:
            raise OntologyViolation(viol)

    async def _parentless_violations(
        self, s, graph_id: str, branch_id: str,
        written: Mapping[str, Optional[dict]], prior: Mapping[str, Optional[dict]],
        kind_by_entity: Mapping[str, str], rules: OntologyRules,
    ) -> List[dict]:
        """An entity whose type the ontology does not allow at the top level must sit inside a
        parent. Judged only for what this write can leave parentless — a node it creates, and the
        child of every containment link it deletes or re-points (an un-nest, a move to the top
        level) — so legacy data that predates the rule stays editable."""
        if not rules.root_entity_types:
            return []
        cset = set(rules.containment_edge_types) | {k for k, r in rules.edge_types.items() if r.is_containment}
        if not cset:
            return []

        def _cont(v: Optional[Mapping]) -> bool:
            return bool(v) and str(v.get("edgeType") or v.get("edge_type") or "").upper() in cset

        candidates: set = set()
        for eid, v in written.items():
            kind = kind_by_entity.get(eid, "node")
            if kind == "node" and v is not None and prior.get(eid) is None:
                candidates.add(eid)
            elif kind == "edge" and _cont(prior.get(eid)):
                old_child = _edge_src_tgt(prior[eid])[1]
                if v is None or _edge_src_tgt(v)[1] != old_child:
                    candidates.add(old_child)
        candidates = {c for c in candidates if c and written.get(c, True) is not None}
        if not candidates:
            return []
        unknown = [c for c in candidates if c not in written]
        values = dict(await self._current_skeletons(s, graph_id, branch_id, unknown)) if unknown else {}
        values.update({c: written[c] for c in candidates if c in written})
        stored = await self._incident_live_edge_skeletons(s, graph_id, branch_id, list(candidates),
                                                          sides=("target",))
        has_parent: set = set()
        for eid, v in stored.items():
            if eid not in written and _cont(v) and _edge_src_tgt(v)[1] in candidates:
                has_parent.add(_edge_src_tgt(v)[1])      # an untouched stored parent link
        for eid, v in written.items():
            if v is not None and kind_by_entity.get(eid) == "edge" and _cont(v):
                has_parent.add(_edge_src_tgt(v)[1])      # a parent link this write keeps / adds
        out: List[dict] = []
        for c in sorted(candidates - has_parent):
            v = values.get(c)
            if not v or _is_edge_payload(v):
                continue
            et = v.get("entityType")
            if not rules.is_root_type(et):
                out.append({"entity_id": c, "kind": "node", "rule": "parent_required",
                            "reason": f"A {et} can't be at the top level — it must sit inside a parent "
                                      f"(top-level types: {', '.join(sorted(rules.root_entity_types))})."})
        return out

    async def _validate_edge_integrity(
        self, s, graph_id: str, branch_id: str,
        edge_creates: Sequence[Tuple[str, Mapping]], deleted_edge_ids: set,
        containment_edge_types: Sequence[str],
    ) -> List[dict]:
        """Structural integrity for a batch of edge CREATES against a branch's live state —
        the batch's deletes subtracted and its other creates overlaid: no edge may (a)
        duplicate an existing one (same source+target+type), (b) give a node a SECOND
        containment parent, or (c) form a containment cycle. Shared by the write path
        (:meth:`_apply_ops_once`) and the merge/squash path (:meth:`_apply_draft_squash`),
        so an invariant no single commit can violate can't be composed onto ``main`` by
        merging two individually-clean drafts either. Returns ``[{entity_id, kind, reason}]``.

        Linear in the batch and the live edges it touches: the live edges into the batch's
        targets are read once (without payloads) and indexed, and cycles are found with one
        batched ancestor climb and one strongly-connected-components pass — never a scan of
        every live edge per created edge, which held an import window's CPU for minutes."""
        cset = {t.upper() for t in (containment_edge_types or [])}

        def _etype(p: Mapping) -> str:
            return str(p.get("edgeType") or p.get("edge_type") or "").upper()

        create_targets = {t for _e, v in edge_creates for _s2, t in [_edge_src_tgt(v)] if t}
        existing_incident = (await self._incident_live_edge_skeletons(
            s, graph_id, branch_id, create_targets, sides=("target",)) if create_targets else {})
        # An edge this batch re-points is judged where it now points, never where it was.
        rewritten = {eid for eid, _v in edge_creates}
        # Index the live edges into the batch's targets once: (source, target, type) → their ids,
        # and child → {containment edge id: parent}.
        by_triple: Dict[Tuple[str, str, str], set] = {}
        parents_of: Dict[str, Dict[str, str]] = {}
        for oeid, op_ in existing_incident.items():
            if oeid in deleted_edge_ids or oeid in rewritten:
                continue
            osrc, otgt = _edge_src_tgt(op_)
            oet = _etype(op_)
            by_triple.setdefault((osrc, otgt, oet), set()).add(oeid)
            if oet in cset and osrc:
                parents_of.setdefault(otgt, {})[oeid] = osrc
        viol: List[dict] = []
        batch_parent: Dict[str, set] = {}     # target → containment sources added in THIS batch
        batch_seen: set = set()               # (src,tgt,type) created in THIS batch
        for eid, v in edge_creates:
            src, tgt = _edge_src_tgt(v)
            if not src or not tgt:
                continue
            etype = _etype(v)
            # (a) duplicate — against existing live edges + earlier creates in this batch.
            key = (src, tgt, etype)
            if key in batch_seen or any(oeid != eid for oeid in by_triple.get(key, ())):
                viol.append({"entity_id": eid, "kind": "edge",
                             "reason": "These entities are already connected by this relationship."})
            batch_seen.add(key)
            # (b) second containment parent.
            if etype in cset:
                parents = {osrc for oeid, osrc in parents_of.get(tgt, {}).items() if oeid != eid}
                parents |= batch_parent.get(tgt, set())
                if parents - {src}:
                    viol.append({"entity_id": eid, "kind": "edge",
                                 "reason": "This entity already has a parent — use “Move to” to change it, "
                                           "rather than adding a second parent."})
                batch_parent.setdefault(tgt, set()).add(src)
        # (c) containment cycle — a new parent→child edge cycles if the child is an ancestor
        #     of the parent in the EFFECTIVE post-batch graph: live edges MINUS this batch's
        #     deletes PLUS its other creates. Overlaying the batch both admits a legitimate
        #     one-commit restructure (delete P→C + create C→P) and catches a cycle built
        #     entirely inside one batch (create A→B + create B→A).
        if cset:
            batch_cont = {eid: v for eid, v in edge_creates if _etype(v) in cset}
            checks = [(eid, *_edge_src_tgt(v)) for eid, v in batch_cont.items()]
            checks = [(eid, a, b) for eid, a, b in checks if a and b]
            looped: set = set()
            if any(a != b for _e, a, b in checks):
                # Every live containment edge on a path up from any batch endpoint: one climb
                # for the whole batch, a query per hierarchy LEVEL.
                ends = {x for _e, a, b in checks for x in (a, b)}
                _seen, live = await self._containment_parents_climb(
                    s, graph_id, branch_id, ends, cset, None, skeleton=True)
                graph_edges = [(oeid, *_edge_src_tgt(p)) for oeid, p in live.items()
                               if oeid not in deleted_edge_ids and oeid not in rewritten]
                graph_edges += checks
                if len(graph_edges) > _CYCLE_THREAD_MIN:
                    looped = await asyncio.to_thread(_containment_cycle_edges, graph_edges, checks)
                else:
                    looped = _containment_cycle_edges(graph_edges, checks)
            for eid, src, tgt in checks:
                if src == tgt:
                    viol.append({"entity_id": eid, "kind": "edge",
                                 "reason": "An entity can’t contain itself."})
                elif eid in looped:
                    viol.append({"entity_id": eid, "kind": "edge",
                                 "reason": "This move would create a containment loop."})
        return viol

    async def trace_from_state(
        self, *, graph_id: str, urn: str, level: int,
        upstream_depth: int, downstream_depth: int,
        lineage_edge_types: Sequence[str], containment_edge_types: Sequence[str],
        max_nodes: int, branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        include_containment_edges: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware RAW lineage trace — the draft/as-of counterpart of the provider's
        ``trace_at_level``. A bounded hop-by-hop BFS over lineage edges (upstream follows IN,
        downstream follows OUT), capped at ``max_nodes``; then every result node's containment
        ancestor chain is added so the canvas layer-assignment invariant holds. RAW only — a draft
        has no AGGREGATED rollups (those are FalkorDB-only), so ``level`` is informational and
        ``effectiveLevel`` echoes it. Mirrors TraceResult."""
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            focus = await self._eid_for_urn(s, graph_id, branch_id, urn, as_of_seq)
            if focus is None:
                return {
                    "nodes": [], "edges": [], "containmentEdges": [],
                    "upstreamUrns": [], "downstreamUrns": [],
                    "focus": {"urn": urn, "level": level, "entityType": "unknown"},
                    "effectiveLevel": level, "truncated": False, "truncationReason": "orphan",
                }
            seen_nodes = {focus}
            lineage_edges: Dict[str, dict] = {}
            upstream_ids: set = set()
            downstream_ids: set = set()
            truncated = False

            async def _bfs(direction: str, depth: int, collected: set):
                nonlocal truncated
                frontier = {focus}
                for _ in range(max(0, depth)):
                    if not frontier or len(seen_nodes) >= max_nodes:
                        truncated = truncated or len(seen_nodes) >= max_nodes
                        break
                    inc = await self._incident_live_edges(s, graph_id, branch_id, frontier, as_of_seq)
                    nxt: set = set()
                    for eid, p in inc.items():
                        et = (p.get("edgeType") or "").upper()
                        if et in cset or (lset is not None and et not in lset):
                            continue
                        src, tgt = _edge_src_tgt(p)
                        hit = tgt if (direction == "down" and src in frontier) else (
                            src if (direction == "up" and tgt in frontier) else None)
                        if not hit:
                            continue
                        lineage_edges[eid] = p
                        if hit not in seen_nodes:
                            if len(seen_nodes) >= max_nodes:
                                truncated = True
                                continue
                            seen_nodes.add(hit)
                            collected.add(hit)
                            nxt.add(hit)
                    frontier = nxt

            await _bfs("up", upstream_depth, upstream_ids)
            await _bfs("down", downstream_depth, downstream_ids)

            cont_edges: Dict[str, dict] = {}
            if include_containment_edges and cset:
                seen_nodes, cont_edges = await self._containment_ancestors(
                    s, graph_id, branch_id, set(seen_nodes), cset, as_of_seq)
            node_vals = await self._current_values(s, graph_id, branch_id, seen_nodes, as_of_seq)

        nodes = {eid: p for eid, p in node_vals.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_lineage = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage_edges.items()
                       if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        out_cont = [_graphedge_dict(eid, p, urn_of) for eid, p in cont_edges.items()
                    if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        focus_type = (nodes.get(focus) or {}).get("entityType") or "unknown"
        return {
            "nodes": out_nodes,
            "edges": out_lineage,
            "containmentEdges": out_cont,
            "upstreamUrns": [urn_of[e] for e in upstream_ids if e in nodes],
            "downstreamUrns": [urn_of[e] for e in downstream_ids if e in nodes],
            "focus": {"urn": urn, "level": level, "entityType": focus_type},
            "effectiveLevel": level,
            "truncated": truncated,
            "truncationReason": ("max_nodes" if truncated else None),
        }

    async def expand_from_state(
        self, *, graph_id: str, source_urn: str, target_urn: str, next_level: int,
        lineage_edge_types: Sequence[str], containment_edge_types: Sequence[str],
        max_nodes: int, branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
        include_containment_edges: bool = True,
    ) -> Dict[str, object]:
        """Branch/as-of-aware RAW expand — the draft/as-of counterpart of the provider's
        ``expand_aggregated``. A draft carries only RAW lineage, so this returns the raw lineage
        edges from the source anchor's containment subtree to the target anchor's subtree (bounded
        by ``max_nodes``), plus the ancestor chains for the canvas invariant. ``next_level`` is
        informational (no level rollup on a draft). Mirrors TraceResult, focused on the source."""
        lset = {t.upper() for t in lineage_edge_types} if lineage_edge_types else None
        cset = {t.upper() for t in (containment_edge_types or [])}
        async with self._session() as s:
            if branch_id is None:
                branch_id = await self._main_branch_id(s, graph_id)
            src = await self._eid_for_urn(s, graph_id, branch_id, source_urn, as_of_seq)
            tgt = await self._eid_for_urn(s, graph_id, branch_id, target_urn, as_of_seq)
            if src is None or tgt is None:
                return {
                    "nodes": [], "edges": [], "containmentEdges": [],
                    "upstreamUrns": [], "downstreamUrns": [],
                    "focus": {"urn": source_urn, "level": next_level, "entityType": "unknown"},
                    "effectiveLevel": next_level, "truncated": False, "truncationReason": "orphan",
                }
            src_sub = await self._containment_descendants(
                s, graph_id, branch_id, {src}, cset, as_of_seq, max_nodes) if cset else {src}
            tgt_sub = await self._containment_descendants(
                s, graph_id, branch_id, {tgt}, cset, as_of_seq, max_nodes) if cset else {tgt}
            lineage_edges: Dict[str, dict] = {}
            result_nodes: set = set()
            for eid, p in (await self._incident_live_edges(
                    s, graph_id, branch_id, src_sub, as_of_seq)).items():
                et = (p.get("edgeType") or "").upper()
                if et in cset or (lset is not None and et not in lset):
                    continue
                a, b = _edge_src_tgt(p)
                if a in src_sub and b in tgt_sub:
                    lineage_edges[eid] = p
                    result_nodes.add(a)
                    result_nodes.add(b)
            truncated = len(result_nodes) >= max_nodes
            cont_edges: Dict[str, dict] = {}
            if include_containment_edges and cset and result_nodes:
                result_nodes, cont_edges = await self._containment_ancestors(
                    s, graph_id, branch_id, set(result_nodes), cset, as_of_seq)
            node_vals = await self._current_values(s, graph_id, branch_id, result_nodes, as_of_seq)

        nodes = {eid: p for eid, p in node_vals.items() if p is not None and not _is_edge_payload(p)}
        urn_of = {eid: (p.get("urn") or f"gv:{eid}") for eid, p in nodes.items()}
        out_nodes = [_graphnode_dict(eid, urn_of[eid], nodes[eid]) for eid in nodes]
        out_lineage = [_graphedge_dict(eid, p, urn_of) for eid, p in lineage_edges.items()
                       if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        out_cont = [_graphedge_dict(eid, p, urn_of) for eid, p in cont_edges.items()
                    if _edge_src_tgt(p)[0] in nodes and _edge_src_tgt(p)[1] in nodes]
        focus_type = (nodes.get(src) or {}).get("entityType") or "unknown"
        return {
            "nodes": out_nodes,
            "edges": out_lineage,
            "containmentEdges": out_cont,
            "upstreamUrns": [],
            "downstreamUrns": [urn_of[e] for e in (result_nodes - {src}) if e in nodes],
            "focus": {"urn": source_urn, "level": next_level, "entityType": focus_type},
            "effectiveLevel": next_level,
            "truncated": truncated,
            "truncationReason": ("max_nodes" if truncated else None),
        }

    async def entity_history(
        self, *, graph_id: str, entity_id: str, viewer: Optional[Viewer] = None,
    ) -> List[dict]:
        """Full revision timeline of one entity (plan §7 tier 1). With a ``viewer``, versions written
        on drafts the caller can't read are dropped (the published main history stays visible)."""
        async with self._session() as s:
            rows = (
                await s.execute(
                    select(NodeVersionORM)
                    .where(
                        NodeVersionORM.graph_id == graph_id,
                        NodeVersionORM.entity_id == entity_id,
                    )
                    .order_by(NodeVersionORM.commit_seq, NodeVersionORM.created_at)
                )
            ).scalars().all()
            if not rows:
                rows = (
                    await s.execute(
                        select(EdgeVersionORM)
                        .where(
                            EdgeVersionORM.graph_id == graph_id,
                            EdgeVersionORM.entity_id == entity_id,
                        )
                        .order_by(EdgeVersionORM.commit_seq, EdgeVersionORM.created_at)
                    )
                ).scalars().all()
            if viewer is not None:
                ok = await self._readable_branch_ids(s, [r.branch_id for r in rows], viewer)
                rows = [r for r in rows if r.branch_id in ok]
            return [
                {
                    "commit_id": r.commit_id,
                    "commit_seq": r.commit_seq,
                    "branch_id": r.branch_id,
                    "op": r.op,
                    "content_hash": r.content_hash,
                    "prev_content_hash": r.prev_content_hash,
                    "actor": r.actor,
                    "change_reason": r.change_reason,
                    "payload": r.payload,
                    "created_at": r.created_at,
                }
                for r in rows
            ]

    @staticmethod
    def _commit_meta(c: "CommitORM") -> dict:
        # The commit log's wire shape: keep ``CommitLogEntry`` (endpoints/versioning.py) in step.
        kind = c.actor_kind or provenance.actor_kind(c.actor)
        return {
            "commit_id": c.id, "commit_seq": c.commit_seq,
            "parent_commit_id": c.parent_commit_id, "kind": c.kind,
            "message": c.message, "actor": c.actor, "contributors": c.contributors,
            "source_branch_id": c.source_branch_id,
            "source_commit_count": c.source_commit_count,
            "originating_view_id": c.originating_view_id,
            "merkle_root": c.merkle_root, "stats": c.stats, "created_at": c.created_at,
            "actor_kind": kind, "api_key_id": c.api_key_id, "correlation_id": c.correlation_id,
            "automation": provenance.is_automation(kind, c.actor, c.api_key_id),
            "change_reason": c.change_reason,
        }

    async def commit_log(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, published_only: bool = False,
        limit: int = 100, offset: int = 0, before: Optional[int] = None,
        after: Optional[int] = None, viewer: Optional[Viewer] = None,
        origin: Optional[str] = None,
    ) -> List[dict]:
        """Newest-first commit log for a graph (plan §7). Default: a branch (``main`` if
        unset). When ``originating_view_id`` is given, scope to that view's history.

        ``before`` / ``after`` are exclusive bounds on ``commit_seq`` — exact keyset paging on
        one branch, where seqs are unique and only ever grow. ``main``'s log stops at its head:
        enabling version control writes the import commit before the head moves to it, and
        every other read path already stops there, so a commit the log shows has landed and
        will never change its place.

        Two view-scoped modes:
        - ``published_only=False`` (raw): every commit attributed to the view across ALL
          branches — the draft checkpoints/edits plus the squash on main. Fine-grained but
          noisy; a single-view graph shows far more rows than the graph's ``main`` log.
        - ``published_only=True`` (the "This view" default): only the PUBLISHED (``main``)
          timeline as it originated from this view — the view's squash-publishes PLUS the
          graph-level events every view shares (genesis / import / revert, which carry no
          view). For a single-view data source this equals the whole-graph log by
          construction; each squash then drills down to its raw commits via
          :meth:`squashed_commits`. Scales cleanly: reads the bounded ``main`` timeline
          (covered by ``uq_commits_branch_seq``), not every draft commit ever made.

        A fork's log holds only its own divergence — inherited history lives on the parent.
        With a ``viewer``, a draft branch is gated (:meth:`_branch_readable`) and the
        raw view-scoped log drops non-viewable drafts (published_only rows are all on the
        readable ``main``).

        ``origin``: ``people`` (made by a person by hand) or ``automation`` (a service account,
        the platform, or any API key — :mod:`.provenance`); every commit when unset."""
        commits, _more = await self.commit_log_page(
            graph_id=graph_id, branch_id=branch_id, originating_view_id=originating_view_id,
            published_only=published_only, limit=limit, offset=offset, before=before,
            after=after, viewer=viewer, origin=origin)
        return commits

    async def commit_log_page(
        self, *, graph_id: str, branch_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, published_only: bool = False,
        limit: int = 100, offset: int = 0, before: Optional[int] = None,
        after: Optional[int] = None, viewer: Optional[Viewer] = None,
        origin: Optional[str] = None,
    ) -> Tuple[List[dict], bool]:
        """:meth:`commit_log`, and whether more commits lie past this page — counted before the
        raw view-scoped log drops drafts the viewer can't read, so a short page there is never
        mistaken for the end."""
        async with self._session() as s:
            stmt = select(CommitORM).where(CommitORM.graph_id == graph_id)
            main_id = None
            if originating_view_id is not None and published_only:
                main_id = await self._main_branch_id(s, graph_id)
                stmt = stmt.where(
                    CommitORM.branch_id == main_id,
                    or_(CommitORM.originating_view_id == originating_view_id,
                        CommitORM.originating_view_id.is_(None)),
                )
            elif originating_view_id is not None:
                stmt = stmt.where(CommitORM.originating_view_id == originating_view_id)
            else:
                if branch_id is None:
                    branch_id = await self._main_branch_id(s, graph_id)
                branch = await self._get_branch(s, graph_id, branch_id)
                await self._assert_branch_readable(s, branch, viewer)
                stmt = stmt.where(CommitORM.branch_id == branch_id)
                if branch.kind == "main":
                    main_id = branch_id
            if main_id is not None:
                head = (await s.get(GraphORM, graph_id)).main_head_commit_seq
                stmt = stmt.where(CommitORM.commit_seq <= head)
            if before is not None:
                stmt = stmt.where(CommitORM.commit_seq < before)
            if after is not None:
                stmt = stmt.where(CommitORM.commit_seq > after)
            if origin is not None:
                cols = (CommitORM.actor_kind, CommitORM.actor, CommitORM.api_key_id)
                stmt = stmt.where(provenance.is_people_sql(*cols) if origin == "people"
                                  else provenance.is_automation_sql(*cols))
            rows = (await s.execute(
                stmt.order_by(CommitORM.commit_seq.desc()).limit(limit + 1).offset(offset)
            )).scalars().all()
            has_more = len(rows) > limit
            rows = rows[:limit]
            if viewer is not None and originating_view_id is not None and not published_only:
                ok = await self._readable_branch_ids(s, [r.branch_id for r in rows], viewer)
                rows = [r for r in rows if r.branch_id in ok]
            return [self._commit_meta(r) for r in rows], has_more

    async def squashed_commits(
        self, *, graph_id: str, commit_id: str, limit: int = 100, offset: int = 0,
    ) -> List[dict]:
        """The raw draft commits squashed into a squash/merge commit — its provenance,
        newest-first and paginated. Reads the squash's stored ``source_commit_ids`` (the
        draft's own checkpoints/edits, retained after publish) and fetches that bounded set.
        Empty for a non-squash commit (genesis/edit/import have no source commits). This is
        the drill-down behind the "merged N commits" affordance so the published "This view"
        timeline stays short while every squash remains fully auditable on demand."""
        async with self._session() as s:
            ids = (await s.execute(select(CommitORM.source_commit_ids).where(
                CommitORM.graph_id == graph_id, CommitORM.id == commit_id))).scalar_one_or_none()
            if not ids:
                return []
            rows = (await s.execute(select(CommitORM).where(
                CommitORM.graph_id == graph_id, CommitORM.id.in_(list(ids)),
            ).order_by(CommitORM.commit_seq.desc()).limit(limit).offset(offset))).scalars().all()
            return [self._commit_meta(r) for r in rows]
    async def diff_commits(
        self, *, graph_id: str, branch_id: str, from_seq: int, to_seq: int,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """Field-level diff between two commits of a branch (plan §7), **O(changed)**:
        scans only the version rows in ``(from_seq, to_seq]`` (a commit writes rows
        only for changed entities), then resolves each changed entity's value at
        each endpoint. Never reconstructs full graph state."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            self._require_changes(branch)
            changed = await self._changed_in_window(s, graph_id, branch_id, from_seq, to_seq)
            if not changed:
                return {"added": [], "removed": [], "modified": {}}
            a = await self._values_at(s, graph_id, branch_id, changed, from_seq)
            b = await self._values_at(s, graph_id, branch_id, changed, to_seq)
            # Draft: entities inherited from main have no row on the branch at ``from_seq``; resolve
            # their 'before' from main@base_commit_seq so deletes/modifies of base entities diff
            # correctly (else a base-delete collapses to None→None and is dropped). Mirrors
            # :meth:`_commit_diff_states` — keeps the per-commit summary == flat diff invariant.
            if branch.kind != "main" and branch.base_commit_seq:
                main_id = await self._main_branch_id(s, graph_id)
                inherit = {eid for eid in changed if eid not in a}
                if inherit:
                    base_a = await self._values_at(s, graph_id, main_id, inherit, branch.base_commit_seq)
                    a.update({eid: v for eid, v in base_a.items() if v is not None})
            return diff_states(a, b)

    async def diff_branch_vs_base(
        self, *, graph_id: str, branch_id: str, viewer: Optional[Viewer] = None,
        payloads: str = "all",
    ) -> Dict[str, object]:
        """UI-shaped net diff of a draft against its base (``main`` at the branch
        point): full node/edge payloads with before/after, classified
        added/removed/modified. This is the shape the canvas diff overlay needs —
        a removed entity renders as a ghost, so it carries its whole payload, not
        just an id.

        Unlike :meth:`diff_commits` (two seqs on one branch), this is a *cross-branch*
        diff: a draft numbers its commits in its own seq space, so the change set is
        the entities the draft wrote rows for (bounded by draft size). ``before`` is
        each entity's value on ``main`` at the branch point; ``after`` its effective
        value on the draft (base overlaid with the draft's edits).

        ``payloads="changes"`` classifies the same way from content hashes, without loading a
        modified entity's payloads: a modified entry is its ``entityId`` and ``kind`` alone, while
        added and removed entries keep the payload the canvas draws them from. It is what the
        draft bar needs — counts and which nodes to ring — up to ``DIFF_TREE_MAX_CHANGES`` changes.

        A draft past it is :class:`DiffTooLarge` in either mode, before anything is read: a payload
        per added and removed entity is tens of megabytes at 100,000. Its readers use its change
        list (:meth:`change_summary`, :meth:`change_index_compact`) instead."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            self._require_changes(branch)
            changed_n = await self._change_count(s, graph_id, branch_id)
            if changed_n > config.DIFF_TREE_MAX_CHANGES:
                raise DiffTooLarge(changed_n, config.DIFF_TREE_MAX_CHANGES)
            main_id = await self._main_branch_id(s, graph_id)
            base_seq = branch.base_commit_seq or 0
            if payloads == "changes":
                return await self._diff_changes_vs_base(s, graph_id, branch_id, main_id, base_seq)
            changed: set = set()
            for model in (NodeVersionORM, EdgeVersionORM):
                rows = (await s.execute(
                    select(model.entity_id).where(
                        model.graph_id == graph_id, model.branch_id == branch_id,
                    ).distinct()
                )).scalars().all()
                changed.update(rows)
            if not changed:
                return {"added": [], "removed": [], "modified": []}
            before = await self._values_at(s, graph_id, main_id, changed, base_seq)
            after = await self._current_values(s, graph_id, branch_id, list(changed))
        added: List[dict] = []
        removed: List[dict] = []
        modified: List[dict] = []
        for eid in changed:
            # A degenerate empty payload ({}) is not a live entity (no urn/entityType/endpoints) —
            # normalize it to absent so it reads as a deletion, never as a node that fails GraphNode
            # validation downstream (the reported 500) or shows as an empty diff row. Guards against
            # any pre-existing malformed row as well as a freshly-corrupt one.
            b, a = before.get(eid) or None, after.get(eid) or None
            if b is None and a is None:
                continue
            kind = "edge" if _is_edge_payload(a or b or {}) else "node"
            if b is None:
                added.append({"entityId": eid, "kind": kind, "after": a})
            elif a is None:
                removed.append({"entityId": eid, "kind": kind, "before": b})
            elif b != a:
                modified.append({"entityId": eid, "kind": kind, "before": b, "after": a})
        return {"added": added, "removed": removed, "modified": modified}

    async def _diff_changes_vs_base(self, s, graph_id, branch_id, main_id, base_seq) -> Dict[str, object]:
        """:meth:`diff_branch_vs_base` with ``payloads="changes"``: the draft's heads against
        main's content hashes at the branch point. An empty payload counts as absent, as there."""
        heads = await self._head_index(s, graph_id, branch_id)
        before = await self._hashes_at(s, graph_id, main_id, list(heads), base_seq)
        added_refs: Dict[str, tuple] = {}
        removed_ids: List[str] = []
        modified: List[dict] = []
        for eid, h in heads.items():
            b = before.get(eid)                              # live at the branch point
            if b is None and h.live:
                added_refs[eid] = (h.kind, graph_id, h.version_id)
            elif b is not None and not h.live:
                removed_ids.append(eid)
            elif b is not None and b.content_hash != h.content_hash:
                modified.append({"entityId": eid, "kind": b.kind})
        after = await self._payloads_by_version(s, added_refs.values())
        gone = await self._values_at(s, graph_id, main_id, removed_ids, base_seq)
        # Each entity named as the canvas names it — a node by its urn, an edge's ends by their
        # nodes' urns — the draft's as the draft holds them, a removed one's as main did at the
        # branch point. Entity ids stay ``entityId``: an imported node's is not its urn.
        now_ends = _payload_ends({vid: after.get(vid) for _k, _g, vid in added_refs.values()})
        now_ends |= {x for m in modified if m["kind"] != "node"
                     for x in (heads[m["entityId"]].src, heads[m["entityId"]].tgt) if x}
        now_urns = await self._current_urns(s, graph_id, branch_id, now_ends, known=heads)
        was_urns = await self._current_urns(s, graph_id, main_id, _payload_ends(gone), as_of_seq=base_seq)

        def _named(eid: str, kind: str, value: Optional[dict], urns: Mapping[str, str]) -> dict:
            h, b = heads.get(eid), before.get(eid)
            if kind == "node":
                return {"urn": (value or {}).get("urn") or (h and h.urn) or (b and b.urn)
                        or f"gv:{eid}"}
            src, tgt = _edge_src_tgt(value) if value else (h.src, h.tgt)
            return {"sourceUrn": _end(urns, src), "targetUrn": _end(urns, tgt)}

        return {
            "added": [{"entityId": eid, "kind": kind, "after": after[vid],
                       **_named(eid, kind, after[vid], now_urns)}
                      for eid, (kind, _, vid) in added_refs.items() if after.get(vid)],
            "removed": [{"entityId": eid, "kind": before[eid].kind, "before": gone[eid],
                         **_named(eid, before[eid].kind, gone[eid], was_urns)}
                        for eid in removed_ids if gone.get(eid)],
            "modified": [{**m, **_named(m["entityId"], m["kind"], None, now_urns)} for m in modified],
        }

    async def branch_overlay_delta(self, *, graph_id: str, branch_id: str,
                                   extend: Optional[Mapping[str, object]] = None) -> Dict[str, object]:
        """The draft's patch set vs **main at the draft's fork point**, **reader-shaped** for a
        read-overlay (:class:`DraftOverlayProvider`): the draft's effective nodes/edges to upsert
        and the before-values of those it removed, PLUS a rewind of any change main took after the
        fork (see below). Bounded by draft size + main's post-fork advance. **Empty only when the
        draft has no edits AND is up to date with main** — that is the pure pass-through case (the
        draft reads exactly like ``main``).

        Fork-point isolation: the overlay is applied on a LIVE main (head) read, but a draft must
        read ``main`` AS OF ITS FORK POINT ⊕ its own edits. So when main advanced after the fork
        (another branch merged into it), this patch also rewinds those advances — main-added
        entities are removed, main-modified/deleted ones restored to their fork-point value — for
        every entity the draft did not itself touch. Without this a draft silently reflects changes
        it never merged (a commit-less "pull"). Edge endpoints are named by their nodes' urns
        (:meth:`_current_urns`), as the projector names them in FalkorDB: an imported node's
        ``entity_id`` is not its urn.

        A node the draft MODIFIED comes as ``nodesModified`` — its urn and entity id, never its
        payload: a reader loads the payloads of just the nodes it is about to serve
        (:meth:`overlay_payloads`), so a draft that changed 100k nodes costs each read a page of
        payloads, not 100k of them. A node the draft created comes as a skeleton in
        ``nodesUpsert`` — what its version row says (urn, entityId, entityType, displayName,
        qualifiedName; ``lazy``), all a reader lists, matches and searches it by — and an edge the
        draft added or changed likewise (id, edgeType, its ends; ``lazy``): a reader loads their
        payloads too for what it serves (``overlay_payloads``, ``kind='edge'``). One it removed
        comes as its urn or, for an edge, its type and ends. The rewind of main's post-fork advance
        comes the same way (:meth:`_rewound`): a draft's value of an entity it did not touch is
        main's at its branch point, which is what a read loads for it. So building the patch set
        reads no payload, whatever the draft's size or main's advance since it branched.

        A fork's ``main`` is read the same way over its root's store: its patch set is
        :meth:`_fork_overlay_delta`'s, and ``extend`` is one an earlier call returned for it."""
        empty = {"nodesUpsert": [], "nodesModified": [], "nodesRemove": [], "edgesUpsert": [],
                 "edgesRemove": [], "nodesNew": []}
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            if branch.kind == "main":
                graph = await s.get(GraphORM, graph_id)
                if graph is not None and graph.fork_parent_graph_id:
                    return await self._fork_overlay_delta(s, graph, branch, extend)
            if getattr(branch, "status", None) == "merged":
                # Everything the draft changed is IN main now: reading it as main ⊕ its edits
                # applied them twice — each added child counted again in its parent's count (a
                # "Load 2 more" that loads nothing in a tab still showing the published draft).
                return empty
            main_id = await self._main_branch_id(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            base_seq = branch.base_commit_seq or 0
            head_seq = graph.main_head_commit_seq if graph is not None else base_seq
            heads = await self._head_index(s, graph_id, branch_id)
            changed: set = set(heads)
            # Fork-point isolation: entities MAIN advanced in (base_seq, head] since this draft forked,
            # minus the draft's own touched set (its edits already win via the delta below). The overlay
            # applies on a LIVE main (head) read, so without this a draft silently reflects any change
            # another branch merged into main — a commit-less "pull". Empty when the draft is up to date.
            advanced: set = set()
            if head_seq > base_seq:
                advanced = (await self._changed_in_window(
                    s, graph_id, main_id, base_seq, head_seq)) - changed
            if not changed and not advanced:
                return empty                       # no draft edits AND up to date → pure pass-through
            node_ids = [eid for eid, h in heads.items() if h.kind == "node"]
            edge_ids = [eid for eid, h in heads.items() if h.kind != "node"]
            # Which the draft created, modified or removed, from hashes; what each is, from version
            # rows — no payload (a draft's own edges are what it holds now: its heads). Its edges
            # are counted against where the store holds them: main at its head, not at the branch
            # point, where an edge main deleted or re-pointed since would be counted nowhere.
            base_nodes = await self._hashes_at(s, graph_id, main_id, node_ids, base_seq)
            held = await self._hashes_at(s, graph_id, main_id, edge_ids, head_seq) if edge_ids else {}
            # Edge ends by urn: the draft's edges as the draft holds their ends (its own nodes,
            # then main at the branch point); the store's as main's head holds them.
            urns = await self._current_urns(s, graph_id, branch_id, _ends(heads), known=heads)
            held_urns = await self._current_urns(s, graph_id, main_id, _ends(held), as_of_seq=head_seq)
            # ── Fork-point rewind ── undo main's post-fork advances so the read reflects main@base_seq
            # ⊕ the draft (never live main), for each entity main changed after the fork that the
            # draft did NOT touch: main-ADDED → removed from the read; main-DELETED → restored;
            # main-MODIFIED → its fork-point value, loaded when a read serves it, and an edge main
            # moved counted where it ran then (``was``), never twice. Bounded by main's advance,
            # told from hashes: a 100k publish costs the drafts still open a classification of it,
            # never its payloads. A fork's: its parent's at the fork point for what its main has no
            # row of.
            rewind = (await self._rewound(s, graph_id, main_id, advanced, base_seq, head_seq)
                      if advanced else None)
        # One dict per entity the draft changed: built in a thread, as its head index was — on a
        # draft's first read this runs in the web process, and 200k of them are a stall of their own.
        nodes_upsert, nodes_modified, nodes_remove, edges_upsert, edges_remove, nodes_new = (
            await asyncio.to_thread(_overlay_patch, heads, node_ids, edge_ids, base_nodes, held,
                                    urns, held_urns))
        if rewind is not None:
            nodes_upsert += rewind["nodesUpsert"]
            nodes_modified += rewind["nodesModified"]
            nodes_remove += rewind["nodesRemove"]
            edges_upsert += rewind["edgesUpsert"]
            edges_remove += rewind["edgesRemove"]
            nodes_new += rewind["nodesNew"]
        return {"nodesUpsert": nodes_upsert, "nodesModified": nodes_modified, "nodesRemove": nodes_remove,
                "edgesUpsert": edges_upsert, "edgesRemove": edges_remove, "nodesNew": nodes_new}

    async def _fork_overlay_delta(self, s, fork: GraphORM, main: BranchORM,
                                  extend: Optional[Mapping[str, object]]) -> Dict[str, object]:
        """A fork's ``main`` as a patch set over its root's store (the graph up its
        ``fork_parent_graph_id`` that is no fork): the fork's value at its head against the root's
        at the root's head (:func:`_fork_patch`), for every entity the two may differ on — the
        fork's own changes (its heads), each fork between it and the root up to the base the level
        below reads it at, and the root's changes since the outermost base. Bounded by those
        changes, never by the graph, and told from hashes and version-row columns: a reader loads
        the fork's value of what it serves (:meth:`overlay_payloads`, through :meth:`_layers` —
        its own, or its parent's at the base).

        ``since`` says what it is of: the fork's head, the seq each of its layers reads, the root's
        head. ``extend`` — one an earlier call returned, of the same fork head and bases — is
        extended by the root's changes since its root head instead of built again."""
        layers = await self._layers(s, fork.id, main.id, fork.main_head_commit_seq)
        root_id, root_main, base = layers[-1]
        root_head = (await s.get(GraphORM, root_id)).main_head_commit_seq
        since = {"head": main.head_commit_id, "layers": [at for _g, _b, at in layers],
                 "rootHead": root_head}
        prev = (extend or {}).get("since")
        if (prev and prev["head"] == since["head"] and prev["layers"] == since["layers"]
                and prev["rootHead"] <= root_head):
            ids = await self._changed_in_window(s, root_id, root_main, prev["rootHead"], root_head)
            window = await self._fork_classified(s, layers, ids, root_head)
            return {**await asyncio.to_thread(_extended_patch, extend, window, ids), "since": since}
        heads = await self._head_index(s, fork.id, main.id)
        ids = set(heads)
        for gid, bid, at in layers[1:-1]:              # each fork between: its own, to its base
            ids |= await self._own_changes(s, gid, bid, at)
        if root_head > base:
            ids |= await self._changed_in_window(s, root_id, root_main, base, root_head)
        return {**await self._fork_classified(s, layers, ids, root_head, heads), "since": since}

    async def _fork_classified(self, s, layers, ids, root_head: int,
                               heads: Optional[Mapping[str, "_Head"]] = None) -> Dict[str, list]:
        """:func:`_fork_patch` of ``ids``: the fork's value at its head — from ``heads``, its own,
        where it has one, else through its layers (``layers``, :meth:`_layers` at its head) —
        against the root's at ``root_head``."""
        fork_id, fork_main, head_seq = layers[0]
        if heads is None:
            ours = await self._hashes_at(s, fork_id, fork_main, ids, head_seq)
        else:
            ours = {eid: _Stored(h.kind, h.content_hash, h.urn, h.type, h.src, h.tgt, h.name, h.qname)
                    for eid, h in heads.items() if h.live and eid in ids}
            rest = [eid for eid in ids if eid not in heads]
            if rest:
                ours.update(await self._hashes_at(s, *layers[1][:2], rest, layers[1][2]))
        root_id, root_main, _base = layers[-1]
        theirs = await self._hashes_at(s, root_id, root_main, ids, root_head)
        our_urns = await self._current_urns(s, fork_id, fork_main, _ends(ours), known=ours)
        their_urns = await self._current_urns(s, root_id, root_main, _ends(theirs),
                                              as_of_seq=root_head, known=theirs)
        return await asyncio.to_thread(_fork_patch, ids, ours, theirs, our_urns, their_urns)

    async def _own_changes(self, s, graph_id: str, branch_id: str, at: int) -> set:
        """Entity ids a branch's own commits up to ``at`` touched — its rows alone, where
        :meth:`_changed_in_window` adds a fork's parent's between its bases."""
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            changed.update((await s.execute(select(model.entity_id).where(
                model.graph_id == graph_id, model.branch_id == branch_id,
                model.commit_seq <= at).distinct())).scalars().all())
        return changed

    @staticmethod
    async def _own_change_count(s, graph_id: str, branch_id: str, lo: int, hi: int, cap: int) -> int:
        """How many entities a branch's own commits in ``(lo, hi]`` touched, counted no further than
        ``cap + 1`` a kind: the size of a window that may be large, at the cost of ``cap``."""
        total = 0
        for model in (NodeVersionORM, EdgeVersionORM):
            ids = select(model.entity_id).where(
                model.graph_id == graph_id, model.branch_id == branch_id,
                model.commit_seq > lo, model.commit_seq <= hi).distinct().limit(cap + 1).subquery()
            total += int(await s.scalar(select(func.count()).select_from(ids)) or 0)
        return total

    async def _fork_candidates(self, s, fork: GraphORM, main_id: str, cap: int,
                               layers: Optional[list] = None,
                               root_head: Optional[int] = None) -> int:
        """At least as many entities as a fork's patch set classifies (:meth:`_fork_overlay_delta`):
        its own changes, each fork between up to its base and the root's since the outermost base,
        each counted no further than ``cap + 1``. Kept per version of the fork (its head, the base
        each layer reads, its root's head) and ``cap``: while none of them moves, history being
        append-only, nothing it counts does."""
        if layers is None:
            layers = await self._layers(s, fork.id, main_id, fork.main_head_commit_seq)
        root_id, root_main, base = layers[-1]
        if root_head is None:
            root_head = (await s.get(GraphORM, root_id)).main_head_commit_seq
        key = (fork.id, fork.main_head_commit_seq, tuple(at for _g, _b, at in layers), root_head, cap)
        if key in _FORK_COUNTS:
            _FORK_COUNTS.move_to_end(key)
            return _FORK_COUNTS[key]
        own = select(EntityHeadORM.entity_id).where(
            EntityHeadORM.graph_id == fork.id, EntityHeadORM.branch_id == main_id).limit(cap + 1)
        total = int(await s.scalar(select(func.count()).select_from(own.subquery())) or 0)
        for gid, bid, at in layers[1:-1]:
            total += await self._own_change_count(s, gid, bid, -1, at, cap)
        total += await self._own_change_count(s, root_id, root_main, base, root_head, cap)
        _FORK_COUNTS[key] = total
        while len(_FORK_COUNTS) > _FORK_COUNTS_KEPT:
            _FORK_COUNTS.popitem(last=False)
        return total

    async def fork_read_plan(self, graph_id: str) -> Dict[str, object]:
        """What reading a fork's ``main`` takes, read in one session: its version (as
        :meth:`overlay_version` gives it — the reader is handed it, so its first read does not
        compute it again); how it is read (``reads_from``, :meth:`fork_reads_from`'s answer from
        the count kept per version); its root (graph, ``main``, data source, in the trash or not);
        and the root's store as its ``projection_state`` row says it is now: its committed and
        projected seqs, its status (``fresh`` by :func:`serves_head`), its pin, and its class and
        size (what marks a read of it while it is out of FalkorDB, ``residency.mark``). That row is
        read every time: an eviction moves the store without moving any seq the version holds.
        With residency on, a person's read holds the root's read lease after this, and its store as
        then read decides instead (``ContextEngine._fork_main_reader``)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None or not graph.fork_parent_graph_id:
                raise ValueError(f"not a fork: {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)
            branch = await self._get_branch(s, graph_id, main_id)
            layers = await self._layers(s, graph_id, main_id, graph.main_head_commit_seq)
            root_id, root_main, _base = layers[-1]
            root = await s.get(GraphORM, root_id)
            n = await self._fork_candidates(s, graph, main_id, config.FORK_REWIND_MAX,
                                            layers=layers, root_head=root.main_head_commit_seq)
            ps = await s.get(ProjectionStateORM, root_id)
            committed = root.main_head_commit_seq
            projected = ps.projected_commit_seq if ps is not None else 0
            status = ps.status if ps is not None else "idle"
            return {
                "main_id": main_id,
                "version": (branch.head_commit_id, tuple(at for _g, _b, at in layers), committed,
                            getattr(branch, "status", None)),
                "reads_from": "postgres" if n > config.FORK_REWIND_MAX else "overlay",
                "root_id": root_id, "root_main": root_main,
                "root_data_source_id": root.data_source_id, "root_trashed": root.deleted_at is not None,
                "committed": committed, "projected": projected, "status": status,
                "fresh": serves_head(projected, committed, status),
                "falkor_provider": ps.falkor_provider if ps is not None else None,
                "falkor_graph_name": ps.falkor_graph_name if ps is not None else None,
                "residency": ps.residency if ps is not None else None,
                "size_bytes": ps.size_bytes if ps is not None else None,
            }

    async def fork_reads_from(self, graph_id: str) -> str:
        """How a fork's ``main`` is read: ``"overlay"``, its patch set over its root's store, or —
        past ``config.FORK_REWIND_MAX`` entities to classify — ``"postgres"``, its layered reads
        (``VersionedBranchProvider``)."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            n = await self._fork_candidates(s, graph, main_id, config.FORK_REWIND_MAX)
        return "postgres" if n > config.FORK_REWIND_MAX else "overlay"

    async def revision_read_plan(self, graph_id: str, as_of_seq: int) -> Dict[str, object]:
        """What reading ``main`` as it was at revision ``as_of_seq`` takes, read in one session:
        main's id and head, the revision's commit, and how far behind the head it is — a count of
        the entities main changed since, capped at ``REVISION_REWIND_MAX`` and kept per
        (revision, head): history never changes, so neither does the count. ``too_far`` past the
        cap; ``fork`` when the graph is a fork's, whose past is not opened yet. ``ValueError`` for
        a seq that is not a revision of main's."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)
            head = graph.main_head_commit_seq or 0
            commit_id = None
            if 0 <= as_of_seq <= head:
                commit_id = await s.scalar(select(CommitORM.id).where(
                    CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                    CommitORM.commit_seq == as_of_seq))
            if commit_id is None:
                raise ValueError(f"no revision {as_of_seq} on this graph's main")
            cap = config.REVISION_REWIND_MAX
            key = ("rev", graph_id, as_of_seq, head, cap)
            changed = _FORK_COUNTS.get(key)
            if changed is None:
                changed = await self._own_change_count(s, graph_id, main_id, as_of_seq, head, cap)
                _FORK_COUNTS[key] = changed
                while len(_FORK_COUNTS) > _FORK_COUNTS_KEPT:
                    _FORK_COUNTS.popitem(last=False)
            else:
                _FORK_COUNTS.move_to_end(key)
        return {"main_id": main_id, "head": head, "commit_id": commit_id, "changed": changed,
                "too_far": changed > cap, "fork": bool(graph.fork_parent_graph_id)}

    async def revision_overlay_delta(
        self, *, graph_id: str, as_of_seq: int, head_seq: int,
        extend: Optional[Mapping[str, object]] = None,
    ) -> Dict[str, object]:
        """``main`` as it was at revision ``as_of_seq``, as a patch set over ``main`` at
        ``head_seq`` — the store a read goes through: a fork of main at that revision with no
        changes of its own (:func:`_fork_patch`). For every entity main changed since, its value
        then against its value at the head, told from content hashes and version-row columns,
        never a payload; a read loads the values it serves (:meth:`overlay_payloads` with
        ``as_of_seq``). Bounded by what changed since the revision, never by the graph.

        ``head_seq`` is the head the caller keyed the delta by, so a delta is never built against
        another head than its key names. ``extend`` — one an earlier call returned for the same
        revision at an older head — is extended by what main changed since that head instead of
        built again. Never :meth:`branch_overlay_delta` for ``main``: its head index is all of it."""
        since = {"asOf": as_of_seq, "head": head_seq}
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
            prev = (extend or {}).get("since") or {}
            if prev.get("asOf") == as_of_seq and isinstance(prev.get("head"), int) \
                    and prev["head"] <= head_seq:
                ids = await self._changed_in_window(s, graph_id, main_id, prev["head"], head_seq)
                window = await self._rewound(s, graph_id, main_id, ids, as_of_seq, head_seq)
                return {**await asyncio.to_thread(_extended_patch, extend, window, ids), "since": since}
            ids = await self._changed_in_window(s, graph_id, main_id, as_of_seq, head_seq)
            patch = await self._rewound(s, graph_id, main_id, ids, as_of_seq, head_seq)
        return {**patch, "since": since}

    async def _rewound(self, s, graph_id: str, main_id: str, ids, at_seq: int,
                       head_seq: int) -> Dict[str, list]:
        """``ids`` as ``main`` held them at ``at_seq``, as a patch set over ``main`` at ``head_seq``
        (:func:`_fork_patch`): what main made since is removed, what it deleted is back, and what
        it changed is named — told from content hashes and version-row columns alone. A read loads
        the values it serves: a revision's at ``at_seq``, a draft's at its branch point."""
        ours = await self._hashes_at(s, graph_id, main_id, ids, at_seq)
        theirs = await self._hashes_at(s, graph_id, main_id, ids, head_seq)
        # Edge ends by urn, as main named them at each side's seq.
        our_urns = await self._current_urns(s, graph_id, main_id, _ends(ours), as_of_seq=at_seq,
                                            known=ours)
        their_urns = await self._current_urns(s, graph_id, main_id, _ends(theirs), as_of_seq=head_seq,
                                              known=theirs)
        return await asyncio.to_thread(_fork_patch, ids, ours, theirs, our_urns, their_urns)

    async def overlay_version(self, *, graph_id: str, branch_id: str) -> tuple:
        """What a draft's :meth:`branch_overlay_delta` depends on: the draft's head and branch point,
        main's head, and the draft's status. Equal versions give equal deltas, so a reader may
        reuse one across requests instead of recomputing it for each. A fork's ``main``'s: its
        head, the seq each of its layers reads (its bases), its root's head and its status."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            graph = await s.get(GraphORM, graph_id)
            if branch.kind == "main" and graph is not None and graph.fork_parent_graph_id:
                layers = await self._layers(s, graph_id, branch_id, graph.main_head_commit_seq)
                root = await s.get(GraphORM, layers[-1][0])
                return (branch.head_commit_id, tuple(at for _g, _b, at in layers),
                        root.main_head_commit_seq, getattr(branch, "status", None))
            return (branch.head_commit_id, branch.base_commit_seq,
                    getattr(graph, "main_head_commit_seq", None), getattr(branch, "status", None))

    async def overlay_payloads(self, *, graph_id: str, branch_id: str, entity_ids: Sequence[str],
                               kind: str = "node", as_of_seq: Optional[int] = None) -> List[dict]:
        """The draft's current value of each of ``entity_ids``, reader-shaped — the nodes
        (:meth:`branch_overlay_delta`'s ``nodesModified`` and created skeletons) or, with
        ``kind='edge'``, the edges a read loads for the page it serves. ``as_of_seq``: ``main``'s
        value at that revision (:meth:`revision_overlay_delta`'s patch set)."""
        async with self._session() as s:
            values = await self._current_values(s, graph_id, branch_id, list(entity_ids),
                                                as_of_seq=as_of_seq)
            urns = (await self._current_urns(s, graph_id, branch_id, _payload_ends(values),
                                             as_of_seq=as_of_seq)
                    if kind == "edge" else {})
        if kind == "edge":
            return [_graphedge_dict(eid, v, urns) for eid, v in values.items() if v]
        return [_graphnode_dict(eid, v.get("urn") or f"gv:{eid}", v) for eid, v in values.items() if v]

    async def diff_branch_summary(
        self, *, graph_id: str, branch_id: str, containment_edge_types, limit: int = 200,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """Hierarchical counterpart of :meth:`diff_branch_vs_base` — the draft's changes as a
        containment tree for the canvas Changes panel. Built on the same O(draft) change set,
        augmented with the *unchanged* containment ancestors of the changed nodes so edits nest
        under their real container (a column under its table) without composing full state.

        A draft past ``DIFF_TREE_MAX_CHANGES`` is counted, not laid out: the same counts and a
        per-type rollup of the changed entities, from the narrow change index, with no groups and
        ``tooLarge`` saying so."""
        async with self._session() as s:
            counted = await self._count_if_too_large(s, graph_id, branch_id, containment_edge_types, viewer)
            if counted is not None:
                return counted
            merged, theirs = await self._branch_diff_states(
                s, graph_id, branch_id, containment_edge_types, viewer=viewer)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_branch_children(
        self, *, graph_id: str, branch_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0, viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """One container's direct children in a draft's hierarchical diff (lazy-load step).
        :class:`DiffTooLarge` for a draft the tree doesn't lay out."""
        async with self._session() as s:
            counted = await self._count_if_too_large(s, graph_id, branch_id, containment_edge_types, viewer)
            if counted is not None:
                raise DiffTooLarge(counted["tooLarge"]["changed"], counted["tooLarge"]["limit"])
            merged, theirs = await self._branch_diff_states(
                s, graph_id, branch_id, containment_edge_types, viewer=viewer)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def branch_change_count(self, *, graph_id: str, branch_id: str) -> int:
        """How many entities a draft has changed (its own heads) — one indexed count, to decide
        whether it publishes inside a request or as a job."""
        async with self._session() as s:
            return await self._change_count(s, graph_id, branch_id)

    async def merged_commit_id(self, *, graph_id: str, branch_id: str) -> Optional[str]:
        """The ``main`` commit a MERGED draft landed as, or ``None`` while the draft is not merged.

        How a publish job knows its publish already happened: its worker may have died (or been
        superseded) after the squash committed and before the job finished, and publishing again
        only fails on a merged draft. The squash commit names the draft (``source_branch_id``); a
        draft whose squash changed nothing is merged with no commit of its own, and then the answer
        is what the publish returned, the draft's head (``""`` when it has none)."""
        async with self._session() as s:
            draft = await s.get(BranchORM, branch_id)
            if draft is None or draft.graph_id != graph_id or draft.status != "merged":
                return None
            squash = await s.scalar(select(CommitORM.id).where(
                CommitORM.graph_id == graph_id, CommitORM.kind == "squash_publish",
                CommitORM.source_branch_id == branch_id,
            ).order_by(CommitORM.commit_seq.desc()).limit(1))
            return squash or draft.head_commit_id or ""

    @staticmethod
    async def _change_count(s, graph_id: str, branch_id: str) -> int:
        return await s.scalar(select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id)) or 0

    async def _count_if_too_large(self, s, graph_id, branch_id, containment_edge_types, viewer):
        """The Changes summary of a draft past ``DIFF_TREE_MAX_CHANGES`` — or ``None`` for one the
        tree can lay out. Classified like :meth:`diff_branch_vs_base` from hashes; the impact
        rollup counts the changed entities by type (the tree's also counts their containers)."""
        branch = await self._get_branch(s, graph_id, branch_id)
        await self._assert_branch_readable(s, branch, viewer)
        self._require_changes(branch)
        changed = await self._change_count(s, graph_id, branch_id)
        if changed <= config.DIFF_TREE_MAX_CHANGES:
            return None
        heads = await self._head_index(s, graph_id, branch_id)
        main_id = await self._main_branch_id(s, graph_id)
        before = await self._hashes_at(s, graph_id, main_id, list(heads), branch.base_commit_seq or 0)
        cset = {t.upper() for t in (containment_edge_types or [])}
        counts = {"added": 0, "modified": 0, "removed": 0}
        entity_counts = {"added": 0, "modified": 0, "removed": 0}
        edge_counts = {"added": 0, "modified": 0, "removed": 0}
        impact: Dict[str, int] = {}
        for eid, h in heads.items():
            b = before.get(eid)
            status = ("added" if b is None and h.live else
                      "removed" if b is not None and not h.live else
                      "modified" if b is not None and b.content_hash != h.content_hash else None)
            if status is None:
                continue
            counts[status] += 1
            typ = h.type if h.live else b.type
            if h.kind == "node":
                entity_counts[status] += 1
                impact[typ or "Other"] = impact.get(typ or "Other", 0) + 1
            elif (typ or "").upper() not in cset:            # a relationship, not structure
                edge_counts[status] += 1
        return {"groups": [], "groupTotal": 0, "counts": counts, "entityCounts": entity_counts,
                "edgeCounts": edge_counts, "impact": impact,
                "tooLarge": {"changed": changed, "limit": config.DIFF_TREE_MAX_CHANGES}}

    # ------------------------------------------------------------------ #
    # Change lists at any size (change_index.py)                          #
    # ------------------------------------------------------------------ #
    async def change_summary(
        self, *, graph_id: str, origin: ChangeOrigin, containment_edge_types,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """What an origin changes — a draft against ``main`` at its branch point, or ``main``
        between two revisions — counted by kind, status and type, from the same index its list
        pages through, so the two always agree. Payload-free at any size; past
        ``CHANGE_LIST_MAX`` the origin is counted, not listed (``tooLarge``)."""
        index = await self._change_index(graph_id, origin, containment_edge_types, viewer)
        return index.summary(origin)

    async def change_entries(
        self, *, graph_id: str, origin: ChangeOrigin, containment_edge_types,
        viewer: Optional[Viewer] = None, kind: Optional[str] = None,
        statuses: Sequence[str] = (), type_: Optional[str] = None, q: Optional[str] = None,
        offset: int = 0, limit: int = 100,
    ) -> Dict[str, object]:
        """A page of an origin's changes in the index's fixed order (entities, then
        relationships, then structure; by type, then name), narrowed by kind, status, type and
        text. No payload: what a row shows comes from version-row columns, and an edge's ends are
        named for the page it is on."""
        index = await self._change_index(graph_id, origin, containment_edge_types, viewer)
        positions = await asyncio.to_thread(index.view, kind=kind, statuses=statuses,
                                            type_=type_, q=q)
        page = index.page(positions, offset, limit)
        names = await self._end_names(graph_id, origin, index, page)
        return {"entries": [entry_dict(e, names) for e in page], "total": len(positions),
                "offset": offset, "limit": limit,
                "hasMore": offset + len(page) < len(positions), "tooLarge": index.too_large}

    async def change_entry(
        self, *, graph_id: str, origin: ChangeOrigin, entity_id: str,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """One entity's value before and after, for an origin — what a row of a change list
        shows when it is opened: two point reads, whatever the origin's size."""
        async with self._session() as s:
            if origin.branch_id is not None:
                branch = await self._draft_of(s, graph_id, origin.branch_id, viewer)
                main_id = await self._main_branch_id(s, graph_id)
                before = (await self._values_at(s, graph_id, main_id, [entity_id],
                                                branch.base_commit_seq or 0)).get(entity_id)
                after = (await self._current_values(s, graph_id, branch.id, [entity_id])).get(entity_id)
            else:
                main_id = await self._window_main(s, graph_id, origin)
                before = (await self._values_at(s, graph_id, main_id, [entity_id],
                                                origin.from_seq)).get(entity_id)
                after = (await self._values_at(s, graph_id, main_id, [entity_id],
                                               origin.to_seq)).get(entity_id)
        before, after = before or None, after or None        # an empty payload is no entity
        if before is None and after is None:
            raise ValueError(f"{entity_id} is not in this change list")
        status = ("added" if before is None else "removed" if after is None else
                  "modified" if before != after else "unchanged")
        kind = "edge" if _is_edge_payload(after or before) else "node"
        return {"entityId": entity_id, "kind": kind, "status": status,
                "before": before, "after": after}

    async def change_index_compact(
        self, *, graph_id: str, origin: ChangeOrigin, containment_edge_types,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """Every change of an origin as a short array (:func:`compact_entries`) — what the canvas
        decorates entities by, and finds a draft's created entities and their parents from — at
        about 70 bytes an entity. Past ``CHANGE_LIST_MAX``, ``truncated`` and no entries."""
        index = await self._change_index(graph_id, origin, containment_edge_types, viewer)
        return {"origin": origin.as_dict(), "entries": await asyncio.to_thread(compact_entries, index),
                "total": sum(index.counts.values()), "truncated": index.too_large is not None}

    async def _change_index(self, graph_id: str, origin: ChangeOrigin, containment_edge_types,
                            viewer: Optional[Viewer]) -> ChangeIndex:
        """The origin's index from this process's cache, built once per version of it: a draft's
        by its head, branch point and status; a window by its two seqs, which never change. The
        viewer's access is checked on every request, before the cache is."""
        cset = tuple(sorted({(t or "").upper() for t in (containment_edge_types or [])}))
        async with self._session() as s:
            if origin.branch_id is not None:
                branch = await self._draft_of(s, graph_id, origin.branch_id, viewer)
                key = ("draft", graph_id, branch.id, branch.head_commit_id,
                       branch.base_commit_seq or 0, branch.status, cset)
                branch_id = branch.id

                def build():
                    return self._build_draft_change_index(graph_id, branch_id, cset)
            else:
                main_id = await self._window_main(s, graph_id, origin)
                lo, hi = origin.from_seq, origin.to_seq
                key = ("window", graph_id, main_id, lo, hi, cset)

                def build():
                    return self._build_window_change_index(graph_id, main_id, lo, hi, cset)
        return await _CHANGE_INDEXES.get(key, build)

    async def _draft_of(self, s, graph_id: str, branch_id: str, viewer: Optional[Viewer]) -> BranchORM:
        """The draft a change list of a branch is of, once the viewer may read it. ``main``'s
        changes are listed between two of its revisions instead."""
        branch = await self._get_branch(s, graph_id, branch_id)
        if branch.kind == "main":
            raise ValueError("main's changes are listed between two of its revisions: "
                             "name fromSeq and toSeq instead of the branch")
        await self._assert_branch_readable(s, branch, viewer)
        self._require_changes(branch)
        return branch

    async def _window_main(self, s, graph_id: str, origin: ChangeOrigin) -> str:
        """``main``'s id, once ``origin`` names two of its revisions: ``0 <= from < to <= head``."""
        graph = await s.get(GraphORM, graph_id)
        if graph is None:
            raise ValueError(f"unknown graph {graph_id}")
        head = graph.main_head_commit_seq or 0
        lo, hi = origin.from_seq, origin.to_seq
        if lo is None or hi is None or not 0 <= lo < hi <= head:
            raise ValueError(f"no such revisions: compare 0 <= fromSeq < toSeq <= {head}, "
                             "main's newest")
        return await self._main_branch_id(s, graph_id)

    @contextlib.asynccontextmanager
    async def _bounded_session(self):
        """A session whose every statement Postgres cancels past
        ``CHANGE_INDEX_STATEMENT_TIMEOUT_MS``, answered as :class:`ChangeListBusy`: for the reads a
        person waits on that a bad plan could otherwise stretch to minutes on a pooled connection."""
        try:
            async with self._session() as s:
                await s.execute(_STATEMENT_TIMEOUT, {"ms": str(config.CHANGE_INDEX_STATEMENT_TIMEOUT_MS)})
                yield s
        except DBAPIError as exc:
            if getattr(exc.orig, "sqlstate", None) == _QUERY_CANCELED:
                raise ChangeListBusy() from exc
            raise

    async def _build_draft_change_index(self, graph_id: str, branch_id: str, cset) -> ChangeIndex:
        """A draft's changes against ``main`` at its branch point — its heads a page at a time,
        each classified against main's value there from content hashes. Holds the entries of a
        draft up to ``CHANGE_LIST_MAX``; past it, counts them a page at a time and keeps none."""
        async with self._bounded_session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            main_id = await self._main_branch_id(s, graph_id)
            base = branch.base_commit_seq or 0
            changed = await self._change_count(s, graph_id, branch_id)
            keep = changed <= config.CHANGE_LIST_MAX
            builder = ChangeIndexBuilder(cset, keep=keep)
            conn = await s.connection()
            async for page in self._head_row_pages(conn, graph_id, branch_id):
                heads = await self._heads_from_rows(conn, graph_id, page)
                before = await self._hashes_at(s, graph_id, main_id, list(heads), base)
                await asyncio.to_thread(_add_draft_page, builder, heads, before)
            too_large = None if keep else {"changed": changed, "limit": config.CHANGE_LIST_MAX}
            index = await asyncio.to_thread(builder.finish, too_large=too_large)
            index.end_urns = await self._end_urns(s, graph_id, branch_id, index)
        return index

    async def _build_window_change_index(self, graph_id: str, main_id: str, lo: int, hi: int,
                                         cset) -> ChangeIndex:
        """``main``'s changes in ``(lo, hi]``: the entities its commits there touched
        (:meth:`_changed_in_window`), each resolved at both ends from content hashes, a chunk at a
        time. A window past ``CHANGE_LIST_MAX`` entities is counted from what its revisions
        recorded of themselves instead, without reading its entities."""
        cap = config.CHANGE_LIST_MAX
        async with self._bounded_session() as s:
            window, stats = await self._window_commits(s, graph_id, main_id, lo, hi)
            ids: Optional[set] = None
            if await self._own_change_count(s, graph_id, main_id, lo, hi, cap) <= cap:
                ids = await self._changed_in_window(s, graph_id, main_id, lo, hi)
            if ids is None or len(ids) > cap:
                create, update, delete = stats
                return ChangeIndex.counted(
                    {"added": create, "modified": update, "removed": delete},
                    too_large={"changed": max(create + update + delete, cap + 1), "limit": cap},
                    window=window, approximate=window["commitCount"] > 1)
            builder = ChangeIndexBuilder(cset)
            for chunk in _chunks(list(ids), _IN_LIST_MAX):
                before = await self._hashes_at(s, graph_id, main_id, chunk, lo)
                after = await self._hashes_at(s, graph_id, main_id, chunk, hi)
                await asyncio.to_thread(_add_window_chunk, builder, chunk, before, after)
            index = await asyncio.to_thread(builder.finish, window=window)
            index.end_urns = await self._end_urns(s, graph_id, main_id, index, as_of_seq=hi)
        return index

    async def _end_urns(self, s, graph_id: str, branch_id: str, index: ChangeIndex,
                        as_of_seq: Optional[int] = None) -> Dict[str, str]:
        """The urns of ``index``'s edge ends where they are not the ends' ids (an imported node's):
        an end the index itself lists by its entry, the rest as a read of ``branch_id`` (at
        ``as_of_seq``) names them (:meth:`_current_urns`). Once per index, which is cached."""
        nodes = {e.entity_id: e.urn or f"gv:{e.entity_id}" for e in index.entries if e.kind == "node"}
        ends = {x for e in index.entries if e.kind == "edge" for x in (e.src, e.tgt) if x}
        urns = {i: nodes[i] for i in ends if i in nodes}
        rest = [i for i in ends if i not in urns]
        if rest:
            urns.update(await self._current_urns(s, graph_id, branch_id, rest, as_of_seq))
        return {i: u for i, u in urns.items() if u != i}

    async def _window_commits(self, s, graph_id: str, main_id: str, lo: int,
                              hi: int) -> Tuple[Dict[str, object], Tuple[int, int, int]]:
        """The revisions a window of ``main`` spans — how many, by whom, when, and the revisions
        at its two ends — and the ``(create, update, delete)`` they recorded of themselves."""
        rows = (await s.execute(
            select(CommitORM.commit_seq, CommitORM.id, CommitORM.kind, CommitORM.message,
                   CommitORM.actor, CommitORM.contributors, CommitORM.created_at, CommitORM.stats)
            .where(CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                   CommitORM.commit_seq >= lo, CommitORM.commit_seq <= hi)
            .order_by(CommitORM.commit_seq)
        )).all()

        def end(r) -> Dict[str, object]:
            return {"seq": r.commit_seq, "commitId": r.id, "kind": r.kind, "message": r.message,
                    "actor": r.actor, "createdAt": r.created_at}

        start = next((r for r in rows if r.commit_seq == lo), None)
        inside = [r for r in rows if r.commit_seq > lo]
        people: Dict[str, None] = {}
        create = update = delete = 0
        for r in inside:
            for person in [r.actor, *(r.contributors or [])]:
                if person:
                    people.setdefault(person, None)
            c, u, d = stat_changes(r.stats)
            create, update, delete = create + c, update + u, delete + d
        window = {
            "commitCount": len(inside),
            "contributors": list(people)[:_WINDOW_CONTRIBUTORS_LISTED],
            "contributorCount": len(people),
            "firstAt": inside[0].created_at if inside else None,
            "lastAt": inside[-1].created_at if inside else None,
            "from": end(start) if start is not None else None,
            "to": end(inside[-1]) if inside and inside[-1].commit_seq == hi else None,
        }
        return window, (create, update, delete)

    async def _end_names(self, graph_id: str, origin: ChangeOrigin, index: ChangeIndex,
                         page: Sequence) -> Dict[str, Optional[str]]:
        """Display names of the ends of a page's edges: from the index where the origin changed
        the node (as it is now, or as it was if removed), else from ``main`` where the origin
        left it (a draft's branch point, a window's end) — one lookup for the page."""
        ends = {x for e in page if e.kind == "edge" for x in (e.src, e.tgt) if x}
        names: Dict[str, Optional[str]] = {}
        rest: List[str] = []
        for eid in ends:
            i = index.by_id.get(eid)
            if i is not None and index.entries[i].kind == "node":
                names[eid] = index.entries[i].name or index.entries[i].urn
            else:
                rest.append(eid)
        if rest:
            async with self._session() as s:
                main_id = await self._main_branch_id(s, graph_id)
                if origin.branch_id is not None:
                    seq = (await self._get_branch(s, graph_id, origin.branch_id)).base_commit_seq or 0
                else:
                    seq = origin.to_seq
                stored = await self._hashes_at(s, graph_id, main_id, rest, seq)
            names.update({eid: v.name or v.urn for eid, v in stored.items() if v.kind == "node"})
        return names

    async def history_months(
        self, *, graph_id: str, tz: str, originating_view_id: Optional[str] = None,
    ) -> Dict[str, object]:
        """``main``'s revisions by month and day in the reader's time zone — the History tab's
        calendar, and how "the graph at the end of October" finds its revision (a month's
        ``lastSeq``). One grouped read of main's commits up to its head, kept per head.
        ``originating_view_id`` counts what the "This view" timeline lists: the view's publishes
        and the graph-wide revisions every view shares."""
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown time zone {tz!r}") from exc
        async with self._bounded_session() as s:
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            head = graph.main_head_commit_seq or 0
            key = (graph_id, head, tz, originating_view_id)
            hit = _HISTORY_MONTHS.get(key)
            if hit is not None:
                _HISTORY_MONTHS.move_to_end(key)
                return hit
            main_id = await self._main_branch_id(s, graph_id)
            local = func.timezone(tz, cast(CommitORM.created_at, TIMESTAMP(timezone=True)))
            inner = select(func.to_char(local, "YYYY-MM-DD").label("day"),
                           CommitORM.commit_seq.label("seq"), CommitORM.created_at.label("at")
                           ).where(CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                                   CommitORM.commit_seq <= head)
            if originating_view_id is not None:
                inner = inner.where(or_(CommitORM.originating_view_id == originating_view_id,
                                        CommitORM.originating_view_id.is_(None)))
            days = inner.subquery()
            rows = (await s.execute(
                select(days.c.day, func.count(), func.min(days.c.seq), func.max(days.c.seq),
                       func.max(days.c.at)).group_by(days.c.day).order_by(days.c.day)
            )).all()
        months: "OrderedDict[str, Dict[str, object]]" = OrderedDict()
        for day, count, first, last, last_at in rows:
            month = months.setdefault(day[:7], {"month": day[:7], "count": 0, "firstSeq": first,
                                                "lastSeq": last, "lastAt": last_at, "days": []})
            month["count"] += int(count)
            month["firstSeq"] = min(month["firstSeq"], first)
            month["lastSeq"], month["lastAt"] = max(month["lastSeq"], last), last_at
            month["days"].append({"day": day, "count": int(count), "firstSeq": first, "lastSeq": last})
        answer = {"headSeq": head, "tz": tz, "months": list(months.values())}
        _HISTORY_MONTHS[key] = answer
        while len(_HISTORY_MONTHS) > _HISTORY_MONTHS_KEPT:
            _HISTORY_MONTHS.popitem(last=False)
        return answer

    async def diff_commit_summary(
        self, *, graph_id: str, commit_id: str, containment_edge_types, limit: int = 200,
        viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """Hierarchical summary of ONE commit's changes — the History tab's drill-down. Same
        containment tree as the draft/PR diff, scoped to exactly the rows this commit wrote; the
        global counts equal the flat ``diff_commits`` tally for the commit's window."""
        async with self._session() as s:
            big = await self._commit_too_large(s, graph_id, commit_id, viewer)
            if big is None:
                merged, theirs = await self._commit_diff_states(s, graph_id, commit_id, containment_edge_types, viewer=viewer)
        if big is not None:
            commit, branch, changed = big
            if branch.kind == "main":
                # Counted by type from the revision's change index, which lists it a page at a time.
                index = await self._change_index(
                    graph_id, ChangeOrigin(from_seq=commit.commit_seq - 1, to_seq=commit.commit_seq),
                    containment_edge_types, viewer=None)
                return _counted_tree_summary(index, changed)
            create, update, delete = stat_changes(commit.stats)
            return {"groups": [], "groupTotal": 0, "counts": {"added": create, "modified": update,
                                                              "removed": delete},
                    "entityCounts": {}, "edgeCounts": {}, "impact": {},
                    "tooLarge": {"changed": changed, "limit": config.DIFF_TREE_MAX_CHANGES}}
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_summary_view(index, limit)

    async def diff_commit_children(
        self, *, graph_id: str, commit_id: str, container_key: str, containment_edge_types,
        limit: int = 200, offset: int = 0, viewer: Optional[Viewer] = None,
    ) -> Dict[str, object]:
        """One container's direct children in a commit's hierarchical diff (lazy-load step).
        :class:`DiffTooLarge` for a commit the tree doesn't lay out."""
        async with self._session() as s:
            big = await self._commit_too_large(s, graph_id, commit_id, viewer)
            if big is not None:
                raise DiffTooLarge(big[2], config.DIFF_TREE_MAX_CHANGES)
            merged, theirs = await self._commit_diff_states(s, graph_id, commit_id, containment_edge_types, viewer=viewer)
        index = _build_diff_hierarchy(merged, theirs, containment_edge_types)
        return _hierarchy_children_view(index, container_key, limit, offset)

    async def _commit_too_large(self, s, graph_id: str, commit_id: str,
                                viewer: Optional[Viewer]) -> Optional[Tuple[CommitORM, BranchORM, int]]:
        """A commit too large for its tree — ``(commit, branch, at least how many)`` past
        ``DIFF_TREE_MAX_CHANGES`` entities written (a fork's Update from parent counts its
        parent's window too) — else None. The tree reads every payload the commit wrote at both
        ends; a publish of a large import is the whole import."""
        commit = await s.get(CommitORM, (graph_id, commit_id))
        if commit is None:
            raise ValueError(f"unknown commit {commit_id}")
        branch = await self._get_branch(s, graph_id, commit.branch_id)
        await self._assert_branch_readable(s, branch, viewer)
        self._require_changes(branch)
        changed = await self._window_too_large(s, graph_id, commit.branch_id,
                                               commit.commit_seq - 1, commit.commit_seq)
        return None if changed is None else (commit, branch, changed)

    async def _window_too_large(self, s, graph_id: str, branch_id: str, lo: int,
                                hi: int) -> Optional[int]:
        """How many entities ``(lo, hi]`` on a branch touched, when that is past
        ``DIFF_TREE_MAX_CHANGES`` (a fork's window counts its parent's too) — else None. Decided
        by a count capped at the limit, so a small window costs a small count; past it, one exact
        count over the window's rows says how many."""
        cap = config.DIFF_TREE_MAX_CHANGES
        changed = await self._own_change_count(s, graph_id, branch_id, lo, hi, cap)
        parent = await self._parent_window(s, graph_id, branch_id, lo, hi)
        if parent is not None and changed <= cap:
            changed += await self._own_change_count(s, *parent, cap)
        if changed <= cap:
            return None
        return await self._count_changed_in_window(s, graph_id, branch_id, lo, hi)

    async def _branch_diff_states(self, s, graph_id, branch_id, containment_edge_types, viewer=None):
        """``(merged, theirs)`` for a draft restricted to its own changes PLUS the unchanged
        containment skeleton (ancestor nodes + the containment edges linking them) of the
        changed nodes. The skeleton is added identically to both sides, so ``net_delta`` still
        yields exactly the draft's changes — the extra entries only give the hierarchy real
        containers to nest under. Stays O(draft + ancestors): no full-state composition."""
        branch = await self._get_branch(s, graph_id, branch_id)
        await self._assert_branch_readable(s, branch, viewer)
        self._require_changes(branch)
        main_id = await self._main_branch_id(s, graph_id)
        base_seq = branch.base_commit_seq or 0
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            rows = (await s.execute(
                select(model.entity_id).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                ).distinct()
            )).scalars().all()
            changed.update(rows)
        if not changed:
            return {}, {}
        before = await self._values_at(s, graph_id, main_id, changed, base_seq)
        after = await self._current_values(s, graph_id, branch_id, list(changed))
        theirs: Dict[str, Optional[dict]] = {eid: before.get(eid) for eid in changed}
        merged: Dict[str, Optional[dict]] = {eid: after.get(eid) for eid in changed}
        cset = {t.upper() for t in (containment_edge_types or [])}
        await self._augment_containment_skeleton(
            s, graph_id, branch_id, changed, after, theirs, merged, cset)
        return merged, theirs

    async def _augment_containment_skeleton(
        self, s, graph_id, branch_id, changed, after, theirs, merged, cset,
    ):
        """Add the *unchanged* containment skeleton (ancestor nodes + the containment edges linking
        them) of the changed nodes to BOTH ``theirs`` and ``merged`` identically — so ``net_delta``
        still yields exactly the changes, while the hierarchy gets real containers to nest under.
        Shared by the draft and per-commit diff paths so they can't drift. Resolved at branch head
        (containment is stable); mutates ``theirs``/``merged`` in place; no-op when ``cset`` empty."""
        if not cset:
            return
        skel_nodes, skel_edges = await self._containment_skeleton(
            s, graph_id, branch_id, changed, after, cset)
        for eid, p in {**skel_edges, **skel_nodes}.items():
            if eid not in changed:                 # add only the unchanged structure
                theirs[eid] = p
                merged[eid] = p
        # Label any container referenced by a containment edge but not yet present — e.g. the
        # surviving parent of a deleted subtree (the skeleton walk seeds from live nodes only, so
        # it never reaches it). Bounded: one lookup of the missing parents.
        referenced: set = set()
        for p in theirs.values():
            if p and _is_edge_payload(p) and (p.get("edgeType") or "").upper() in cset:
                src = p.get("sourceEntityId") or p.get("source_entity_id")
                if src:
                    referenced.add(src)
        missing = referenced - merged.keys()
        if missing:
            for eid, p in (await self._current_values(s, graph_id, branch_id, missing)).items():
                if p is not None:
                    theirs[eid] = p
                    merged[eid] = p

    async def _commit_diff_states(self, s, graph_id, commit_id, containment_edge_types, viewer=None):
        """``(merged, theirs)`` for a single commit — exactly the rows it wrote (the
        ``(seq-1, seq]`` window). before/after are resolved with the SAME primitives as
        :meth:`diff_commits` (``_values_at``, a fork's through its parent), so a
        commit's hierarchical summary counts equal the flat ``diff_commits`` tally for every kind
        of commit; the containment skeleton (resolved at branch head) gives the changes their
        containers to nest under."""
        commit = await s.get(CommitORM, (graph_id, commit_id))
        if commit is None:
            raise ValueError(f"unknown commit {commit_id}")
        branch_id, seq = commit.branch_id, commit.commit_seq
        branch = await self._get_branch(s, graph_id, branch_id)
        await self._assert_branch_readable(s, branch, viewer)
        self._require_changes(branch)
        changed = await self._changed_in_window(s, graph_id, branch_id, seq - 1, seq)
        if not changed:
            return {}, {}
        before = await self._values_at(s, graph_id, branch_id, changed, seq - 1)
        after = await self._values_at(s, graph_id, branch_id, changed, seq)
        # A draft inherits unchanged entities from main: a commit that deletes/modifies a
        # base-inherited entity has NO row on the draft before ``seq``, so its 'before' is missing
        # and a delete would collapse to None→None (dropped by net_delta → empty diff despite real
        # stats). Resolve those from main@base_commit_seq, mirroring :meth:`_branch_diff_states`.
        if branch.kind != "main" and branch.base_commit_seq:
            main_id = await self._main_branch_id(s, graph_id)
            inherit = {eid for eid in changed if eid not in before}
            if inherit:
                base_before = await self._values_at(s, graph_id, main_id, inherit, branch.base_commit_seq)
                before.update({eid: v for eid, v in base_before.items() if v is not None})
        theirs: Dict[str, Optional[dict]] = {eid: before.get(eid) for eid in changed}
        merged: Dict[str, Optional[dict]] = {eid: after.get(eid) for eid in changed}
        cset = {t.upper() for t in (containment_edge_types or [])}
        await self._augment_containment_skeleton(
            s, graph_id, branch_id, changed, after, theirs, merged, cset)
        return merged, theirs

    async def _containment_skeleton(self, s, graph_id, branch_id, changed, changed_after, cset):
        """Walk UP from the changed *live* nodes to their roots via incoming containment edges,
        returning ``({node_eid: payload}, {edge_eid: payload})`` for the unchanged structure
        linking changes to their containers. Bounded by (changed nodes × containment depth)."""
        skel_nodes: Dict[str, dict] = {}
        skel_edges: Dict[str, dict] = {}
        frontier = {
            eid for eid in changed
            if changed_after.get(eid) is not None and not _is_edge_payload(changed_after.get(eid) or {})
        }
        seen = set(frontier)
        depth = 0
        while frontier and depth < 64:
            links = await self._incoming_containment_edges(s, graph_id, branch_id, frontier, cset)
            to_fetch: set = set()
            next_frontier: set = set()
            for _child, (edge_eid, parent_eid, edge_p) in links.items():
                skel_edges.setdefault(edge_eid, edge_p)
                if parent_eid not in seen:
                    seen.add(parent_eid)
                    next_frontier.add(parent_eid)
                    if parent_eid not in changed:
                        to_fetch.add(parent_eid)
            if to_fetch:
                vals = await self._current_values(s, graph_id, branch_id, to_fetch)
                for eid, p in vals.items():
                    if p is not None:
                        skel_nodes[eid] = p
            frontier = next_frontier
            depth += 1
        return skel_nodes, skel_edges

    async def _incoming_containment_edges(self, s, graph_id, branch_id, child_ids, cset):
        """Live containment edges whose TARGET is in *child_ids* →
        ``{child_eid: (edge_eid, parent_eid, payload)}`` — the child→parent step of the
        upward walk, bounded by ``|child_ids|`` (≈ one parent each) via ix_ev_target; a fork's
        through its parent (:meth:`_incident_edge_ids`)."""
        if not child_ids:
            return {}
        cand = await self._incident_edge_ids(s, graph_id, branch_id, child_ids, sides=("target",),
                                             edge_types={c.upper() for c in cset})
        vals = await self._current_values(s, graph_id, branch_id, cand)
        out: Dict[str, Tuple[str, str, dict]] = {}
        child_set = set(child_ids)
        for eid, p in vals.items():
            if p is None or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt and tgt in child_set:
                out[tgt] = (eid, src, p)
        return out

    async def get_graph(self, graph_id: str) -> Optional[Dict[str, object]]:
        """Graph metadata (or ``None``) — also the API's tenant-isolation guard.

        Soft-deleted graphs are invisible here, as in :meth:`get_graph_by_data_source`: a graph
        in the trash, or being purged, is no graph to any route."""
        async with self._session() as s:
            g = await s.get(GraphORM, graph_id)
            return None if g is None or g.deleted_at is not None else self._graph_meta(g)

    async def get_graph_by_data_source(self, data_source_id: str) -> Optional[Dict[str, object]]:
        """Reverse lookup: the versioned graph backing a data source (1:1 via the
        ``uq_graphs_data_source`` unique constraint), or ``None``.

        Soft-deleted graphs are invisible here. A graph awaiting purge is being dismantled row by
        row; anything that resolved it would be reading a graph that is half gone."""
        async with self._session() as s:
            g = (await s.execute(
                select(GraphORM).where(GraphORM.data_source_id == data_source_id,
                                       GraphORM.deleted_at.is_(None))
            )).scalar_one_or_none()
            return None if g is None else self._graph_meta(g)

    async def move_graph_workspace(self, data_source_id: str, new_workspace_id: str, *,
                                   from_workspace_id: str, refuse_failed_enable: bool = True,
                                   refuse_active_jobs: bool = True,
                                   tombstone_by: Optional[str] = None) -> List[str]:
        """Re-home a data source's versioned graph, and every fork of it, from
        ``from_workspace_id`` into ``new_workspace_id`` — the graphver half of moving the data
        source. Returns the moved graph ids, root first; ``[]`` when the source is not versioned.

        Each graph is locked before its forks are read: a fork is created under its graph's
        lock, and a job under its move lock (:meth:`_lock_move`), in the workspace it reads
        there, so none appears unseen or in the old workspace. A graph found already in
        ``new_workspace_id`` moves again (a retry that finishes a move); one in any other
        workspace was moved by another request (:class:`GraphMoved`). Nothing moves while any of
        them has a pending or running job (:class:`JobActive`), because a job runs in the
        workspace it was queued in; the finished ones move with their graph, so lookups scoped by
        workspace still find them. ``refuse_active_jobs=False`` waives that, for putting the graph
        back after its source failed to commit: the source never left, so its graph, and any job
        started on it meanwhile, belong where it is.

        Open drafts and review requests move with their graph: each graph row is held FOR UPDATE
        first, so one being opened, a restore or a trash in flight finishes and moves along.
        Taking the graph out of ``from_workspace_id`` is refused (:class:`MoveBlocked`) while an
        enable that failed waits to be resumed or cancelled where it was started.
        ``refuse_failed_enable=False`` waives that — putting the graph back after its source
        failed to commit, and the reaper re-filing a graph whose source already lives elsewhere —
        and ``tombstone_by`` also trashes a still-live graph, as that actor, in this transaction
        (after its lifecycle key, as the trash takes it)."""
        async with self._session() as s:
            root = await s.scalar(
                select(GraphORM.id).where(GraphORM.data_source_id == data_source_id))
            if root is None:
                return []
            if tombstone_by:
                await self._lock_lifecycle(s, root)
            ids, todo = [], [root]
            while todo:
                gid = todo.pop(0)
                await self._lock_graph(s, gid)
                await self._lock_move(s, gid)
                if gid == root:
                    at = await s.scalar(select(GraphORM.workspace_id).where(GraphORM.id == root))
                    if at not in (from_workspace_id, new_workspace_id):
                        raise GraphMoved(root)
                ids.append(gid)
                todo += sorted((await s.execute(select(GraphORM.id).where(
                    GraphORM.fork_parent_graph_id == gid))).scalars().all())
            active = None if not refuse_active_jobs else await s.scalar(select(JobORM.id).where(
                JobORM.graph_id.in_(ids), JobORM.status.in_(("pending", "running"))).limit(1))
            if active is not None:
                raise JobActive(active, "Version control is busy with this data source — turning "
                                        "it on, an import, an export or a publish. Try again once "
                                        "that finishes.")
            for gid in ids:         # parent before child: what is opening on one finishes first
                await self._bounded_lock(s, select(GraphORM.id).where(GraphORM.id == gid)
                                         .with_for_update(), f"graph {gid}")
            if (refuse_failed_enable and at == from_workspace_id and await s.scalar(
                    select(JobORM.id).where(*bootstrap_unfinished(root)).limit(1)) is not None):
                raise MoveBlocked("Turning on version control for this data source didn't "
                                  "finish. Resume or cancel it first.")
            await s.execute(update(GraphORM).where(GraphORM.id.in_(ids))
                            .values(workspace_id=new_workspace_id))
            await s.execute(update(JobORM).where(JobORM.graph_id.in_(ids))
                            .values(workspace_id=new_workspace_id))
            if tombstone_by:
                await s.execute(update(GraphORM).where(GraphORM.id == root,
                                                       GraphORM.deleted_at.is_(None))
                                .values(deleted_at=_now(), deleted_by=tombstone_by))
            return ids

    async def projection_placements(self, graph_ids: Sequence[str]) -> Dict[str, Dict[str, object]]:
        """Where each live graph projects, for the placement routes: its workspace (their gate),
        data source, and the FalkorDB key and provider from ``projection_state`` — the key the
        projector writes, which for a fork or a blank model is not its data source's
        ``graph_name``. Soft-deleted and unknown ids are absent; one query."""
        if not graph_ids:
            return {}
        async with self._session() as s:
            rows = (await s.execute(
                select(GraphORM.id, GraphORM.workspace_id, GraphORM.data_source_id,
                       ProjectionStateORM.falkor_graph_name, ProjectionStateORM.falkor_provider)
                .outerjoin(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
                .where(GraphORM.id.in_(list(graph_ids)), GraphORM.deleted_at.is_(None))
            )).all()
        return {r.id: {"workspace_id": r.workspace_id, "data_source_id": r.data_source_id,
                       "falkor_graph_name": r.falkor_graph_name, "falkor_provider": r.falkor_provider}
                for r in rows}

    async def main_heads(
        self, *, workspace_id: str, data_source_ids: Sequence[str],
    ) -> Dict[str, Dict[str, object]]:
        """``{data_source_id: {graph_id, kind, main_head_commit_seq, main_head_commit_id,
        main_head_committed_at}}`` for each of ``data_source_ids`` whose version control is on in
        ``workspace_id``: a live graph there (the tenancy rule :meth:`resolve_graph` applies) whose
        "enable version control" job, if it had one, finished. A source that is absent is not
        versioned here.

        While version control is still being turned on the graph is left out: until the job
        finishes the graph isn't one yet, and a cancelled enable deletes it — the next enable
        makes a new graph id — so nothing that might vanish is handed out. Three indexed reads
        per ``_HEADS_PER_READ`` sources: the graphs with their ``main``, any unfinished enable
        among them, and the head commits."""
        ids = list(data_source_ids)
        if not ids:
            return {}
        out: Dict[str, Dict[str, object]] = {}
        async with self._session() as s:
            for chunk in _chunks(ids, _HEADS_PER_READ):
                out.update(await self._main_heads(s, workspace_id, chunk))
        return out

    async def _main_heads(self, s, workspace_id: str, ids: List[str]) -> Dict[str, Dict[str, object]]:
        graphs = (await s.execute(
            select(GraphORM.id, GraphORM.data_source_id, GraphORM.kind,
                   GraphORM.main_head_commit_seq, BranchORM.id)
            .join(BranchORM, (BranchORM.graph_id == GraphORM.id) & (BranchORM.kind == "main"))
            .where(GraphORM.data_source_id.in_(ids), GraphORM.workspace_id == workspace_id,
                   GraphORM.deleted_at.is_(None))
        )).all()
        if not graphs:
            return {}
        enabling = set((await s.execute(
            select(JobORM.graph_id).where(
                JobORM.job_type == "bootstrap", JobORM.graph_id.in_([g[0] for g in graphs]),
                JobORM.status.in_(_UNFINISHED_ENABLEMENT))
        )).scalars())
        live = [g for g in graphs if g[0] not in enabling]
        heads: Dict[str, Tuple[str, str]] = {}
        if live:
            heads = {gid: (cid, at) for gid, cid, at in (await s.execute(
                select(CommitORM.graph_id, CommitORM.id, CommitORM.created_at).where(
                    CommitORM.graph_id.in_([g[0] for g in live]),      # partition pruning
                    tuple_(CommitORM.graph_id, CommitORM.branch_id, CommitORM.commit_seq).in_(
                        [(gid, main, seq) for gid, _ds, _kind, seq, main in live]))
            )).all()}
        return {
            ds: {"graph_id": gid, "kind": kind, "main_head_commit_seq": int(seq),
                 "main_head_commit_id": heads.get(gid, (None, None))[0],
                 "main_head_committed_at": heads.get(gid, (None, None))[1]}
            for gid, ds, kind, seq, _main in live
        }

    @staticmethod
    def _draft_ref(b: BranchORM) -> dict:
        return {"branch_id": b.id, "head_commit_id": b.head_commit_id,
                "base_commit_seq": b.base_commit_seq,
                "originating_view_id": b.originating_view_id}

    async def resolve_graph(
        self, *, data_source_id: str, actor: str, workspace_id: Optional[str] = None,
        open_draft_if_absent: bool = True, originating_view_id: Optional[str] = None,
        draft_visibility: str = "private",
    ) -> Optional[Dict[str, object]]:
        """Resolve a data source to its versioned graph plus the caller's editing
        draft — the UI's boot lookup. Returns the graph's ``main`` head, its lifecycle state and
        rev, and the actor's newest open draft (opening one when absent if requested), or ``None``
        when no versioned graph backs the data source (optionally scoped to a
        workspace for tenant isolation)."""
        async with self._session() as s:
            g = (await s.execute(
                select(GraphORM).where(GraphORM.data_source_id == data_source_id,
                                       GraphORM.deleted_at.is_(None))   # purge in flight => gone
            )).scalar_one_or_none()
            if g is None or (workspace_id is not None and g.workspace_id != workspace_id):
                return None
            graph_id, main_head, graph_kind = g.id, g.main_head_commit_seq, g.kind
            lifecycle_state, lifecycle_rev = g.lifecycle_state, g.lifecycle_rev
            main_id = await self._main_branch_id(s, graph_id)
            draft_q = select(BranchORM).where(
                BranchORM.graph_id == graph_id, BranchORM.owner == actor,
                BranchORM.kind == "draft", BranchORM.status == "open",
            ).order_by(BranchORM.created_at.desc())
            if originating_view_id is None:
                # Legacy/no-view caller: the owner's most-recent open draft (unchanged).
                draft = (await s.execute(draft_q)).scalars().first()
            else:
                # Branch-per-view: a draft is isolated per (data source, owner, view).
                # Prefer THIS view's own (most-recent) draft; else claim a not-yet-attributed
                # (originating_view_id IS NULL) legacy draft for this view; else this view has
                # no draft (only OTHER views' drafts exist) and one is opened below if requested.
                drafts = (await s.execute(draft_q)).scalars().all()
                draft = next(
                    (d for d in drafts if d.originating_view_id == originating_view_id), None)
                if draft is None:
                    # Claim-if-null: a draft opened before view tracking (or from a path that
                    # couldn't name its view) adopts the caller's view — but ONLY on a
                    # write-intent resolve (open_draft_if_absent); a plain read must not
                    # write-on-read (two concurrent reads from different views could
                    # otherwise race to claim the same null draft). A read still SEES the
                    # null draft (the view shows it) without mutating it; an already-
                    # attributed draft is never re-assigned.
                    draft = next((d for d in drafts if d.originating_view_id is None), None)
                    if draft is not None and open_draft_if_absent:
                        draft.originating_view_id = originating_view_id
            my_draft = self._draft_ref(draft) if draft is not None else None
        if my_draft is None and open_draft_if_absent:
            branch_id = await self.open_draft(
                graph_id=graph_id, owner=actor, originating_view_id=originating_view_id,
                visibility=draft_visibility)
            async with self._session() as s:
                my_draft = self._draft_ref(await s.get(BranchORM, branch_id))
        return {
            "graph_id": graph_id, "main_branch_id": main_id,
            "main_head_commit_seq": main_head, "my_draft": my_draft,
            "kind": graph_kind, "lifecycle_state": lifecycle_state, "lifecycle_rev": lifecycle_rev,
        }

    async def list_branches(
        self, *, graph_id: str, limit: int = 100, cursor: Optional[str] = None,
        status: Sequence[str] = ("open", "publishing"),
        viewer: Optional[Viewer] = None, originating_view_id: Optional[str] = None,
        scope: str = "all", visibility: Optional[str] = None,
    ) -> Tuple[List[dict], Optional[str]]:
        """A page of a graph's branches (``main`` + drafts/forks) and the cursor of the next page
        (``None`` on the last). ``main`` comes first, then drafts newest first. Graph-keyed by
        DEFAULT (every view's branches, the Data-Source rollup); ``originating_view_id`` narrows
        to that view's own branches (``main`` carries no view, so it drops out). ``status`` keeps
        those statuses (``"all"`` keeps every one). A ``viewer`` gets only the branches
        :meth:`_branch_readable` lets them read, filtered here in SQL before the LIMIT so others'
        private drafts can't crowd theirs off a page. ``scope`` narrows that to the viewer's own
        drafts (``mine``), the drafts shared with them as a member (``shared``) or the public ones
        (``public``), and ``visibility`` to one level; either leaves ``main`` out. With a ``viewer``
        each row carries ``my_role``: theirs on it, as :meth:`my_branch_role` answers (``None`` on
        ``main``), and ``access``: what they may do with it (:meth:`_access`), so a client offers
        changes only on the drafts that take them. ``ValueError`` on a malformed cursor.
        Every page but the last is full. The viewer's teams are ``viewer.groups`` when given, else
        looked up only when a team's row could decide."""
        rank = case((BranchORM.kind == "main", 0), else_=1)       # main first
        stmt = select(BranchORM).where(BranchORM.graph_id == graph_id)
        if originating_view_id is not None:
            stmt = stmt.where(BranchORM.originating_view_id == originating_view_id)
        if "all" not in status:
            stmt = stmt.where(BranchORM.status.in_(status))
        if cursor is not None:
            after_rank, after_at, after_id = cursor.split("|", 2)
            stmt = stmt.where(or_(
                rank > int(after_rank),
                and_(rank == int(after_rank),
                     tuple_(BranchORM.created_at, BranchORM.id) < tuple_(after_at, after_id))))
        async with self._session() as s:
            groups = None
            if viewer is not None:
                groups = await self._viewer_groups(s, viewer, graph_id=graph_id)
                stmt = stmt.where(or_(BranchORM.kind == "main",
                                      self._readable_draft_clause(viewer, groups, graph_id=graph_id)))
            if scope != "all" or visibility is not None:
                stmt = stmt.where(BranchORM.kind != "main")
            if visibility is not None:
                stmt = stmt.where(BranchORM.visibility == visibility)
            if scope == "public":
                stmt = stmt.where(BranchORM.visibility == "public")
            elif scope in ("mine", "shared") and viewer is not None:
                if scope == "mine":
                    stmt = stmt.where(BranchORM.owner == viewer.actor)
                else:
                    stmt = stmt.where(BranchORM.owner != viewer.actor, BranchORM.is_shared,
                                      BranchORM.id.in_(select(BranchMemberORM.branch_id).where(
                                          self._member_of(viewer, groups))))
            rows = (await s.execute(
                stmt.order_by(rank, BranchORM.created_at.desc(), BranchORM.id.desc()).limit(limit + 1)
            )).scalars().all()
            out = [self._branch_meta(b) for b in rows[:limit]]
            if viewer is not None:
                roles = await self._my_roles(s, rows[:limit], viewer.actor, groups)
                for b, m in zip(rows[:limit], out):
                    m["my_role"] = roles.get(m["branch_id"])
                    m["access"] = self._access(b, m["my_role"], viewer)
        nxt = None
        if len(rows) > limit:
            last = rows[limit - 1]
            nxt = f"{0 if last.kind == 'main' else 1}|{last.created_at}|{last.id}"
        return out, nxt

    async def get_branch(self, *, graph_id: str, branch_id: str, viewer: "Viewer") -> dict:
        """One branch as the list shows it, with ``my_role`` and ``access``. ``ValueError`` when
        it isn't one of the graph's branches, :class:`DraftNotReadable` when ``viewer`` may not
        read it."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            meta = self._branch_meta(branch)
            groups = await self._viewer_groups(s, viewer, graph_id=graph_id)
            meta["my_role"] = (await self._my_roles(s, [branch], viewer.actor, groups)).get(branch.id)
            meta["access"] = self._access(branch, meta["my_role"], viewer)
            meta["contributors"] = await self._contributors(s, graph_id, branch_id)
            return meta

    @staticmethod
    async def _my_roles(s, branches: Sequence[BranchORM], actor: str,
                        groups: Optional[set] = None) -> Dict[str, str]:
        """*actor*'s role on each of *branches* that gives one — :meth:`_branch_role` for a page,
        in one query for the shared drafts' member rows. The actor's groups are ``groups`` when
        already loaded, else looked up once, and only when a group row could raise a role; when that
        lookup fails a row keeps its user role, so a groups outage never takes the whole list down."""
        roles = {b.id: "owner" for b in branches if b.kind != "main" and b.owner == actor}
        shared = [b.id for b in branches if b.is_shared and b.id not in roles]
        if not shared:
            return roles
        rows = (await s.execute(select(BranchMemberORM).where(
            BranchMemberORM.branch_id.in_(shared)))).scalars().all()
        for bid in shared:
            mine = [r for r in rows if r.branch_id == bid]
            best = max((r.role for r in mine if r.subject_type == "user" and r.subject_id == actor),
                       key=ROLE_RANK.__getitem__, default=None)
            higher = [r for r in mine if r.subject_type == "group"
                      and ROLE_RANK[r.role] > ROLE_RANK.get(best, 0)]
            if higher:
                if groups is None:
                    try:
                        groups = set(await _load_actor_groups(actor))
                    except GroupsUnavailable:
                        groups = set()
                best = max([r.role for r in higher if r.subject_id in groups] + ([best] if best else []),
                           key=ROLE_RANK.__getitem__, default=None)
            if best:
                roles[bid] = best
        return roles

    async def get_pr(self, pr_id: str) -> Optional[dict]:
        async with self._session() as s:
            pr = await s.get(MergeRequestORM, pr_id)
            if pr is None:
                return None
            meta = await self._pr_meta(s, pr)
            # Enrich with the SOURCE branch's owner/name so the review drawer can show who owns the
            # draft (one PK lookup; only on the single-PR read, not the list, to avoid an N+1).
            src = await s.get(BranchORM, pr.source_branch_id) if pr.source_branch_id else None
            if src is not None:
                meta["source_branch_owner"] = src.owner
                meta["source_branch_name"] = src.name
                meta["originating_view_id"] = src.originating_view_id   # for "back to the view" nav
            # A merged draft review's commit on main, by seq: what its change list pages through
            # (main between seq - 1 and seq) when it is too large for one diff, its draft's own
            # rows removed or not.
            squash = await self._review_squash(s, pr)
            meta["resulting_commit_seq"] = squash.commit_seq if squash is not None else None
            return meta

    @staticmethod
    def _pulls_filtered(stmt, *, target_graph_id, data_source_id, originating_view_id,
                        status, active_only, viewer=None, groups=None):
        """Apply the optional PR scope filters shared by :meth:`list_pulls`/:meth:`count_pulls`.
        ``data_source_id`` joins the target graph (all PRs on a data source & its views);
        ``originating_view_id`` joins the source branch (PRs raised from one view) — both stay
        within the versioning store, so the join is local. ``active_only`` drops the terminal
        (merged/closed) PRs — the "still needs attention" set the indicator counts. ``status``
        "open" means the same set (a PR is stored as mergeable/conflicts/approved, never plain
        "open"); any other ``status`` is an exact match. A ``viewer`` sees the PRs they authored or
        review, a draft's review when they may read the draft (``groups``: their teams, as
        :meth:`_viewer_groups` loads them), and, when they manage, a fork's PR."""
        if data_source_id is not None:
            stmt = stmt.join(GraphORM, GraphORM.id == MergeRequestORM.target_graph_id).where(
                GraphORM.data_source_id == data_source_id)
        if target_graph_id is not None:
            stmt = stmt.where(MergeRequestORM.target_graph_id == target_graph_id)
        if originating_view_id is not None:
            stmt = stmt.join(BranchORM, BranchORM.id == MergeRequestORM.source_branch_id).where(
                BranchORM.originating_view_id == originating_view_id)
        if status == "open":
            active_only = True
        elif status is not None:
            stmt = stmt.where(MergeRequestORM.status == status)
        if active_only:
            stmt = stmt.where(MergeRequestORM.status.notin_(_TERMINAL_PR_STATUS))
        if viewer is not None:
            draft_mr = MergeRequestORM.source_graph_id == MergeRequestORM.target_graph_id
            seen = [MergeRequestORM.actor == viewer.actor,
                    MergeRequestORM.reviewers.contains([viewer.actor]),
                    and_(draft_mr, MergeRequestORM.source_branch_id.in_(
                        select(BranchORM.id).where(
                            GraphVersioningService._readable_draft_clause(viewer, groups))))]
            if viewer.can_manage:
                seen.append(or_(MergeRequestORM.source_graph_id.is_(None), ~draft_mr))
            stmt = stmt.where(or_(*seen))
        return stmt

    async def list_pulls(
        self, *, target_graph_id: Optional[str] = None, data_source_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, status: Optional[str] = None,
        active_only: bool = False, limit: int = 100, offset: int = 0,
        viewer: Optional[Viewer] = None,
    ) -> List[dict]:
        """PRs in scope, newest first. Scope is any combination of: a target graph's ``main``
        (the base owner's review queue), a data source (every view's PRs against it), or a
        single originating view — optionally narrowed to one ``status`` or to ``active_only``
        (not merged/closed). A ``viewer`` sees the PRs :meth:`_pulls_filtered` lets them."""
        async with self._session() as s:
            stmt = self._pulls_filtered(
                select(MergeRequestORM), target_graph_id=target_graph_id,
                data_source_id=data_source_id, originating_view_id=originating_view_id,
                status=status, active_only=active_only, viewer=viewer,
                groups=await self._viewer_groups(s, viewer) if viewer is not None else None,
            ).order_by(MergeRequestORM.created_at.desc()).limit(limit).offset(offset)
            rows = (await s.execute(stmt)).scalars().all()
            return [await self._pr_meta(s, pr) for pr in rows]

    async def count_pulls(
        self, *, target_graph_id: Optional[str] = None, data_source_id: Optional[str] = None,
        originating_view_id: Optional[str] = None, status: Optional[str] = None,
        active_only: bool = False, viewer: Optional[Viewer] = None,
    ) -> int:
        """Count PRs matching the same scope filters as :meth:`list_pulls` — for the view's
        PR indicator (active PRs from this view vs on its whole data source)."""
        async with self._session() as s:
            stmt = self._pulls_filtered(
                select(func.count(MergeRequestORM.id)), target_graph_id=target_graph_id,
                data_source_id=data_source_id, originating_view_id=originating_view_id,
                status=status, active_only=active_only, viewer=viewer,
                groups=await self._viewer_groups(s, viewer) if viewer is not None else None,
            )
            return int((await s.execute(stmt)).scalar_one())

    @staticmethod
    def _graph_meta(g: GraphORM) -> Dict[str, object]:
        return {
            "graph_id": g.id, "workspace_id": g.workspace_id, "tenant_id": g.tenant_id,
            "data_source_id": g.data_source_id,
            "kind": g.kind, "base_ontology_id": g.base_ontology_id,
            "fork_parent_graph_id": g.fork_parent_graph_id,
            "fork_base_commit_seq": g.fork_base_commit_seq,
            "main_head_commit_seq": g.main_head_commit_seq,
            "created_by": g.created_by, "created_at": g.created_at,
            "deleted_at": g.deleted_at,
        }

    @staticmethod
    def _branch_meta(b: BranchORM) -> dict:
        # ``is_shared`` for clients that predate levels: someone besides its owner reads it (a
        # public draft, or one with members), as it meant before.
        return {
            "branch_id": b.id, "kind": b.kind, "name": b.name, "description": b.description,
            "owner": b.owner, "is_shared": b.is_shared or (b.kind != "main" and b.visibility == "public"),
            "visibility": b.visibility,
            "status": b.status, "base_commit_seq": b.base_commit_seq,
            "head_commit_id": b.head_commit_id, "originating_view_id": b.originating_view_id,
            "created_by": b.created_by, "created_at": b.created_at, "updated_at": b.updated_at,
            "pruned_at": b.pruned_at,
        }

    async def branch_freshness(self, *, graph_id: str, branch_id: str,
                               since_seq: Optional[int] = None,
                               viewer: Optional["Viewer"] = None) -> Dict[str, object]:
        """O(1) collaboration signal: has ``main`` advanced under this draft since it branched?
        Compares the draft's branch point (``base_commit_seq``) to the graph's CURRENT main head
        (which bumps in the same transaction as any publish/merge, so this is live). Deliberately
        cheap — just two PK reads and an int compare — so a client can poll it frequently while
        editing; the expensive 3-way merge / conflict detection runs only when the user actually
        pulls or publishes. ``main`` (and a fork's own main) is never behind itself.

        Also the branch's own head (``head_commit_seq``, its latest commit's seq on it) and level.
        With ``since_seq`` (the head a client last saw), what others committed to it since:
        ``saved_since`` {commits, changes, by (most commits first, then the latest), capped} —
        ``viewer``'s own commits aside, and of others' only the newest ``_SAVED_SINCE_SCAN``. With
        ``viewer``, what they may do with it (``access``), so a write lost to a change of level
        shows on the next poll."""
        async with self._session() as s:
            graph = await s.get(GraphORM, graph_id)
            branch = await s.get(BranchORM, branch_id)
            if graph is None or branch is None or branch.graph_id != graph_id:
                raise ValueError("unknown graph/branch")
            main_head = graph.main_head_commit_seq or 0
            base = branch.base_commit_seq or 0
            behind_by = 0 if branch.kind == "main" else max(0, main_head - base)
            main_id = await self._main_branch_id(s, graph_id)
            people = (await self._people_since(s, graph_id, main_id, base, main_head)) if behind_by else 0
            # Why the draft must pull before it lands (_pull_needed), so the client can say so before
            # anyone presses Publish. Behind automation alone, whether it touched what the draft
            # changes is read only for a draft small enough to read on every poll; a bigger one
            # finds out when it publishes (``reason: overlap``).
            reason = PULL_PEOPLE if people else None
            if behind_by and not people and \
                    await self._change_count(s, graph_id, branch_id) <= _FRESHNESS_OVERLAP_MAX:
                reason = await self._pull_needed(s, graph_id, main_id, branch, main_head)
            out = {
                "behind": behind_by > 0,
                "behind_by": behind_by,
                "behind_by_people": people,
                "pull_required": reason is not None,
                "pull_reason": reason,
                "main_head_commit_seq": main_head,
                "base_commit_seq": base,
                "status": branch.status,      # a closed draft says so without listing every draft
                "head_commit_seq": int(await s.scalar(
                    select(func.coalesce(func.max(CommitORM.commit_seq), 0)).where(
                        CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id))),
                "visibility": branch.visibility,
                "saved_since": None,
                "access": None,
            }
            if since_seq is not None:
                others = [CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
                          CommitORM.commit_seq > since_seq]
                if viewer is not None:
                    others.append(CommitORM.actor != viewer.actor)
                rows = (await s.execute(
                    select(CommitORM.actor, CommitORM.stats, CommitORM.commit_seq).where(*others)
                    .order_by(CommitORM.commit_seq.desc()).limit(_SAVED_SINCE_SCAN + 1))).all()
                capped = len(rows) > _SAVED_SINCE_SCAN
                rows = rows[:_SAVED_SINCE_SCAN]
                out["saved_since"] = {
                    "commits": len(rows),
                    "changes": sum(sum((stats or {}).get(op, 0) for op in ("create", "update", "delete"))
                                   for _actor, stats, _seq in rows),
                    "by": _most_commits_first((actor, seq) for actor, _stats, seq in rows if actor),
                    "capped": capped,
                }
            if viewer is not None:
                groups = await self._viewer_groups(s, viewer, graph_id=graph_id)
                role = (await self._my_roles(s, [branch], viewer.actor, groups)).get(branch.id)
                out["access"] = self._access(branch, role, viewer)
            return out

    async def draft_people(self, *, graph_id: str, branch_id: str, limit: int = 200) -> dict:
        """Who to tell what became of a draft: its ``people`` — its owner, its members (people; a
        team's members aren't listed one by one) and whoever committed to it, the most active first,
        ``limit`` at most — and which of them may read it now (``readers``): on a private draft its
        owner, its members (teams included) and the people on its review. With its ``name`` and
        the view it was opened from, to say which draft it is and where."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            people = [branch.owner] if branch.owner else []
            if branch.is_shared:
                people += list((await s.execute(select(BranchMemberORM.subject_id).where(
                    BranchMemberORM.branch_id == branch_id,
                    BranchMemberORM.subject_type == "user"))).scalars())
            people += await self._contributors(s, graph_id, branch_id, limit=limit)
            people = list(dict.fromkeys(people))[:limit]
            readers = [who for who in people
                       if await self._branch_readable(s, branch, Viewer(actor=who, can_read=True))]
            return {"name": branch.name, "originating_view_id": branch.originating_view_id,
                    "people": people, "readers": readers}

    async def _contributors(self, s, graph_id: str, branch_id: str, limit: int = 50) -> List[str]:
        """Who committed to a branch, most commits first, then the latest: ``limit`` of them."""
        rows = (await s.execute(
            select(CommitORM.actor, func.count(), func.max(CommitORM.commit_seq))
            .where(CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
                   CommitORM.actor.isnot(None))
            .group_by(CommitORM.actor)
            .order_by(func.count().desc(), func.max(CommitORM.commit_seq).desc())
            .limit(limit))).all()
        return [actor for actor, _n, _latest in rows]

    async def _pr_meta(self, s, pr: MergeRequestORM) -> dict:
        # A draft MR is "behind" when its base lags the target graph's main head; the FE gates
        # Merge on this so reviewers pull latest first. A fork's PR waits on its fork's Update
        # from parent instead (ForkNotUpToDate at merge; the fork's listing says how far behind it
        # is), not on a Pull latest, so behind stays null for it. (``s.get`` is identity-mapped, so
        # listing many PRs on one graph doesn't re-query the head.)
        #
        # Read the base from the LIVE source branch, never from ``pr.base_commit_seq``: that column
        # is frozen at PR-creation time, but ``rebase_draft`` advances the BRANCH's base and does
        # not touch the PR row. Reading the frozen value made a pulled draft report behind forever
        # — and since the FE swaps Merge for "Pull latest" on that flag, the PR could never be
        # merged (re-pulling short-circuits as already_up_to_date). This now mirrors the gate
        # merge_mr actually enforces (it reads draft.base_commit_seq), so UI and server agree.
        behind = behind_by = people = None
        src = await s.get(BranchORM, pr.source_branch_id)
        if self._is_draft_mr(pr):
            graph = await s.get(GraphORM, pr.target_graph_id)
            base = (src.base_commit_seq if src else pr.base_commit_seq) or 0
            head = graph.main_head_commit_seq if graph else 0
            behind_by = max(0, head - base)
            behind = behind_by > 0
            # Merge waits on a pull only for people's commits (_pull_needed); see branch_freshness.
            people = (await self._people_since(s, pr.target_graph_id, await self._main_branch_id(
                s, pr.target_graph_id), base, head)) if behind else 0
        # A live PR shows only the approvals that still hold, so a reviewer whose approval went
        # stale is asked again, and the PR is no longer shown as approved. ``stale`` names them.
        status, approved_by, approval_status = pr.status, pr.approved_by, pr.approval_status
        stale: List[str] = []
        if approved_by and status not in ("merged", "closed"):
            approved_by, stale = await self._approvals(s, pr)
            if pr.reviewers:
                approval_status = "approved" if set(pr.reviewers) <= set(approved_by) else "pending"
                if status == "approved" and approval_status != "approved":
                    status = "mergeable"
        return {
            "pr_id": pr.id, "graph_id": pr.graph_id, "source_graph_id": pr.source_graph_id,
            "source_branch_id": pr.source_branch_id,
            # The source's head now: what an approval is of (``approve_pr``'s expected head).
            "head_commit_id": src.head_commit_id if src else None,
            "target_graph_id": pr.target_graph_id, "target_branch": pr.target_branch,
            "base_commit_seq": pr.base_commit_seq, "status": status,
            "behind": behind, "behind_by": behind_by,
            "behind_by_people": people, "pull_required": None if people is None else people > 0,
            "title": pr.title, "description": pr.description,
            "conflicts": pr.conflicts, "resulting_commit_id": pr.resulting_commit_id,
            "reviewers": pr.reviewers, "approved_by": approved_by, "stale_approved_by": stale,
            "approval_status": approval_status, "checks_status": pr.checks_status,
            "actor": pr.actor, "created_at": pr.created_at, "updated_at": pr.updated_at,
            "merged_at": pr.merged_at, "merged_by": pr.merged_by, "merged_via": pr.merged_via,
            "closed_at": pr.closed_at, "closed_by": pr.closed_by,
        }

    # ------------------------------------------------------------------ #
    # Internal helpers                                                    #
    # ------------------------------------------------------------------ #
    async def _main_branch_id(self, s, graph_id: str) -> str:
        return (
            await s.execute(
                select(BranchORM.id).where(
                    BranchORM.graph_id == graph_id, BranchORM.kind == "main"
                )
            )
        ).scalar_one()

    async def _get_branch(self, s, graph_id: str, branch_id: str) -> BranchORM:
        b = await s.get(BranchORM, branch_id)
        if b is None or b.graph_id != graph_id:
            raise ValueError("unknown branch")
        return b

    async def _branch_role(self, s, branch: BranchORM, actor: str, groups: Sequence[str] = (),
                           need: Optional[str] = None):
        """Effective role of *actor* on *branch*: the owner is an implicit
        maintainer; on a private draft nobody else has one (member rows left on it
        grant nothing); otherwise the highest role from matching user/group members.
        The actor's groups are ``groups`` when given, else looked up
        (:func:`_load_actor_groups`) only when a group row could decide the answer:
        one that ranks above the actor's own row and meets ``need``."""
        if branch.owner == actor:
            return "maintainer"
        if not branch.is_shared:
            return None
        rows = (await s.execute(select(BranchMemberORM).where(
            BranchMemberORM.branch_id == branch.id
        ))).scalars().all()
        best = None
        for r in rows:
            if r.subject_type == "user" and r.subject_id == actor:
                if best is None or ROLE_RANK[r.role] > ROLE_RANK[best]:
                    best = r.role
        if need and best and ROLE_RANK[best] >= ROLE_RANK[need]:
            return best
        floor = max(ROLE_RANK.get(best, 0) + 1, ROLE_RANK[need] if need else 0)
        cand = [r for r in rows if r.subject_type == "group" and ROLE_RANK[r.role] >= floor]
        if cand:
            mine = set(groups) if groups else set(await _load_actor_groups(actor))
            for r in cand:
                if r.subject_id in mine and (best is None or ROLE_RANK[r.role] > ROLE_RANK[best]):
                    best = r.role
        return best

    @staticmethod
    def _require_open(branch: BranchORM, *, publishing_ok: bool = False) -> None:
        """Edits/checkpoints/publish need an ``open`` draft. Merged or abandoned
        drafts are inert (plan §17 #8); ``main`` stays open for its lifetime. A draft
        being published by a job is closed to everyone but that job (``publishing_ok``)."""
        if branch.status != "open" and not (publishing_ok and branch.status == "publishing"):
            raise BranchNotOpen(branch.id, branch.status)

    @staticmethod
    async def _require_no_import(s, branch_id: str) -> None:
        """A draft is not published while an import is pending or running on it
        (:class:`JobActive`): main would get the windows it has written so far, and the import
        fail on the closed draft. Under the draft's lock, so no import window lands in between.
        A pending one the transfer lane's reaper will fail (:func:`never_runs`) does not count."""
        active = await s.scalar(select(JobORM.id).where(
            JobORM.branch_id == branch_id, JobORM.job_type == "ingest",
            JobORM.status.in_(("pending", "running")),
            # IS NOT TRUE: a phase that is NULL makes the queued rule NULL, not false.
            and_(JobORM.status == "pending", or_(*never_runs())).is_not(True)).limit(1))
        if active is not None:
            raise JobActive(active, f"An import is still running on this draft (job {active}). "
                                    "Publish once it has finished.")

    async def _require_edit(self, s, branch: BranchORM, actor: str, groups: Sequence[str], *,
                            can_manage: bool = True) -> None:
        """Who writes a draft: its owner; an editor or maintainer member; and, on a public draft,
        anyone who changes its data source (``can_manage``: the routes that write require it, so
        only a route that doesn't — a view's — passes it in)."""
        if branch.kind == "main" or branch.owner == actor:
            return
        if branch.visibility == "public" and can_manage:
            return
        if not branch.is_shared:                          # a private draft is its owner's alone (D4)
            await self._unknown_unless_readable(s, branch, actor, groups)
            raise NotDraftOwner(branch.id, branch.owner)
        role = await self._branch_role(s, branch, actor, groups, need="editor")
        if role is None or ROLE_RANK[role] < ROLE_RANK["editor"]:
            await self._unknown_unless_readable(s, branch, actor, groups)
            raise DraftRoleRequired(branch.id, "editor")

    async def _require_manage(self, s, branch: BranchORM, actor: str, groups: Sequence[str]) -> None:
        role = await self._branch_role(s, branch, actor, groups, need="maintainer")
        if role != "maintainer":
            await self._unknown_unless_readable(s, branch, actor, groups)
            if not branch.is_shared:
                raise NotDraftOwner(branch.id, branch.owner)
            raise DraftRoleRequired(branch.id, "maintainer")

    async def _unknown_unless_readable(self, s, branch: BranchORM, actor: str, groups: Sequence[str]) -> None:
        """Before a refusal names a draft's owner or a role on it: a private draft the actor may not
        even read is unknown to them (:class:`DraftNotReadable`, a 404 as on a read), so a write
        can't learn it is there. Whoever reaches a write reads the data source, so a public draft
        is known to them."""
        if branch.visibility == "public":
            return
        if branch.is_shared and await self._branch_role(s, branch, actor, groups, need="viewer") is not None:
            return
        if not await self._is_pr_participant_for_branch(s, branch.id, actor):
            raise DraftNotReadable(f"{actor} cannot view branch {branch.id}")

    async def _require_publish(self, s, branch: BranchORM, actor: str, groups: Sequence[str]) -> None:
        """Publishing a draft needs its owner or a maintainer, at either level: a public draft's
        other writers ask for a review. The refusal says so (``hint: merge_request``): a merge
        request on the draft is merged by anyone who may publish there, whoever owns the draft —
        how a service account lands a person's draft, or a person a service account's."""
        try:
            await self._require_manage(s, branch, actor, groups)
        except (NotDraftOwner, DraftRoleRequired) as exc:
            exc.detail = {
                **exc.detail, "hint": "merge_request",
                "message": (f"{exc.detail['message']}: only its owner or a maintainer publishes it "
                            "directly. Open a merge request on it instead; anyone who may publish "
                            "here can merge that."),
            }
            raise

    # ── Read visibility (draft privacy + PR scoping) ──────────────────────────
    async def _is_pr_participant_for_branch(self, s, branch_id: str, actor: str) -> bool:
        """True if *actor* authored or is a reviewer of any MR sourced from this branch — lets PR
        reviewers read the draft's commits/diff without being draft members. One indexed lookup."""
        row = (await s.execute(
            select(MergeRequestORM.id).where(
                MergeRequestORM.source_branch_id == branch_id,
                or_(MergeRequestORM.actor == actor,
                    MergeRequestORM.reviewers.contains([actor])),
            ).limit(1)
        )).first()
        return row is not None

    async def _branch_readable(self, s, branch: BranchORM, viewer: "Viewer") -> bool:
        """Who may READ a branch's history/content. ``main`` is readable by any
        ``datasource:read`` caller, and so is a public draft. A private draft is its owner's, its
        members' (any role, directly or through a team) and its reviews' authors and reviewers;
        managing the workspace opens none. Owner and public short-circuit before any query, so
        the common paths stay O(1). :meth:`_readable_draft_clause` says the same in SQL."""
        if branch.kind == "main":
            return True
        if branch.owner == viewer.actor or (branch.visibility == "public" and viewer.can_read):
            return True
        if branch.is_shared and await self._branch_role(s, branch, viewer.actor, viewer.groups,
                                                        need="viewer") is not None:
            return True
        return await self._is_pr_participant_for_branch(s, branch.id, viewer.actor)

    @staticmethod
    def _readable_draft_clause(viewer: "Viewer", groups, *, graph_id: Optional[str] = None):
        """The drafts ``viewer`` may read, as a condition on ``branches`` (:meth:`_branch_readable`
        in one query): their own; the public ones when they read the data source; those they, or a
        team of theirs in ``groups``, are a member of; those a review of theirs comes from.
        ``graph_id`` narrows the reviews looked at to one graph's."""
        member = GraphVersioningService._member_of(viewer, groups)
        reviews = select(MergeRequestORM.source_branch_id).where(
            or_(MergeRequestORM.actor == viewer.actor, MergeRequestORM.reviewers.contains([viewer.actor])))
        if graph_id is not None:
            reviews = reviews.where(MergeRequestORM.graph_id == graph_id)
        terms = [BranchORM.owner == viewer.actor,
                 and_(BranchORM.is_shared, BranchORM.id.in_(select(BranchMemberORM.branch_id).where(member))),
                 BranchORM.id.in_(reviews)]
        if viewer.can_read:
            terms.insert(1, BranchORM.visibility == "public")
        return or_(*terms)

    @staticmethod
    def _member_of(viewer: "Viewer", groups):
        """A member row naming ``viewer``, or a team of theirs in ``groups``."""
        member = and_(BranchMemberORM.subject_type == "user", BranchMemberORM.subject_id == viewer.actor)
        if groups:
            member = or_(member, and_(BranchMemberORM.subject_type == "group",
                                      BranchMemberORM.subject_id.in_(groups)))
        return member

    @staticmethod
    def _access(branch, role: Optional[str], viewer: "Viewer") -> Dict[str, bool]:
        """What ``viewer``, holding ``role`` on a branch they read (``'owner'``, a member role or
        None), may do with it: write it, and manage it (rename, abandon, its level and members).
        ``main`` is written only through publishing. A public draft is written by anyone who
        changes its data source. The draft's status is not considered: a closed draft takes no
        write from anyone."""
        if branch.kind == "main":
            return {"canRead": True, "canWrite": False, "canManage": False}
        writes = role in ("owner", "maintainer", "editor") or (
            branch.visibility == "public" and viewer.can_manage)
        return {"canRead": True, "canWrite": writes, "canManage": role in ("owner", "maintainer")}

    @staticmethod
    async def _viewer_groups(s, viewer: "Viewer", *, graph_id: Optional[str] = None) -> set:
        """``viewer``'s teams for :meth:`_readable_draft_clause`: as given, else looked up once,
        and only when a shared draft (of ``graph_id``, when given) has a team's row; a failed
        lookup keeps their own rows, as in :meth:`_my_roles`."""
        if viewer.groups:
            return set(viewer.groups)
        teams = select(BranchMemberORM.branch_id).join(
            BranchORM, BranchORM.id == BranchMemberORM.branch_id).where(
            BranchORM.is_shared, BranchMemberORM.subject_type == "group")
        if graph_id is not None:
            teams = teams.where(BranchORM.graph_id == graph_id)
        if not await s.scalar(teams.limit(1)):
            return set()
        try:
            return set(await _load_actor_groups(viewer.actor))
        except GroupsUnavailable:
            return set()

    async def _assert_branch_readable(self, s, branch: BranchORM, viewer: Optional["Viewer"]) -> None:
        """No-op when ``viewer`` is None (internal/test callers); else raise on a private draft."""
        if viewer is not None and not await self._branch_readable(s, branch, viewer):
            raise DraftNotReadable(f"{viewer.actor} cannot view branch {branch.id}")

    async def assert_branch_readable(self, *, graph_id: str, branch_id: str, viewer: Optional["Viewer"],
                                     changes: bool = False) -> None:
        """Raise ``ValueError`` when ``branch_id`` isn't one of the graph's branches, and
        ``AccessDenied`` when ``viewer`` may not read it (someone else's private draft). With
        ``changes`` — the caller reads the draft's changes, not only its record —
        :class:`DraftPruned` too for a closed draft whose changes were removed."""
        async with self._session() as s:
            branch = await self._get_branch(s, graph_id, branch_id)
            await self._assert_branch_readable(s, branch, viewer)
            if changes:
                self._require_changes(branch)

    async def check_view_branch(self, *, data_source_id: Optional[str], branch_id: str, viewer: "Viewer",
                                write: bool) -> None:
        """The gate for a view route's ``branchId`` (VIEWS-5). ``ValueError`` (404) unless the
        branch is on the live graph of ``data_source_id`` and ``viewer`` may read it. Main reads
        as the published view; a write to it is ``MainWriteForbidden``. A draft write needs the
        draft open (``BranchNotOpen``) and ``_require_edit`` (``AccessDenied``). Reads of a merged
        or abandoned draft pass: a tab still on it must load."""
        async with self._session() as s:
            branch = await s.get(BranchORM, branch_id)
            graph = await s.get(GraphORM, branch.graph_id) if branch is not None else None
            if (graph is None or graph.deleted_at is not None or graph.data_source_id != data_source_id
                    or not await self._branch_readable(s, branch, viewer)):
                raise ValueError("unknown branch")
            if not write:
                return
            if branch.kind == "main":
                raise MainWriteForbidden()
            self._require_open(branch)
            await self._require_edit(s, branch, viewer.actor, (), can_manage=viewer.can_manage)

    async def _readable_branch_ids(self, s, branch_ids, viewer: "Viewer") -> set:
        """Subset of *branch_ids* the viewer may read — for filtering cross-branch results
        (view-scoped commit logs, entity history): :meth:`_readable_draft_clause` in one query."""
        ids = {b for b in branch_ids if b}
        if not ids:
            return set()
        groups = await self._viewer_groups(s, viewer)
        return set((await s.execute(select(BranchORM.id).where(
            BranchORM.id.in_(ids),
            or_(BranchORM.kind == "main", self._readable_draft_clause(viewer, groups))))).scalars().all())

    async def _next_seq(self, s, graph_id: str, branch_id: str) -> int:
        cur = (
            await s.execute(
                select(func.coalesce(func.max(CommitORM.commit_seq), 0)).where(
                    CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id
                )
            )
        ).scalar_one()
        return int(cur) + 1

    async def _heads(self, s, graph_id: str, branch_id: str) -> Dict[str, EntityHeadORM]:
        rows = (
            await s.execute(
                select(EntityHeadORM).where(
                    EntityHeadORM.graph_id == graph_id,
                    EntityHeadORM.branch_id == branch_id,
                )
            )
        ).scalars().all()
        return {r.entity_id: r for r in rows}

    async def _effective_head_hash(
        self, s, graph_id: str, branch_id: str, entity_id: str
    ) -> Optional[str]:
        main_id = await self._main_branch_id(s, graph_id)
        for bid in (branch_id, main_id):
            row = await s.get(EntityHeadORM, (graph_id, bid, entity_id))
            if row is not None:
                return None if row.is_tombstone else row.content_hash
        return None

    async def _composed_state(self, s, graph_id: str, branch_id: str) -> Dict[str, Optional[dict]]:
        """Live payload state of a branch, fork-aware — the one primitive every
        read/merge path composes from (so 'current state' has a single definition).

        * ``main`` → the graph's reconstructed state at its head (a fork's main is
          seeded copy-on-write from its parent at the fork point).
        * a draft → the graph's ``main`` at the draft's branch point overlaid with
          the draft's own staged changes (the 'ours' side of a rebase).
        """
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            graph = await s.get(GraphORM, graph_id)
            return await self._state_as_of(s, graph_id, main_id, graph.main_head_commit_seq)
        branch = await s.get(BranchORM, branch_id)
        base = await self._state_as_of(s, graph_id, main_id, branch.base_commit_seq or 0)
        base.update(await self._branch_own_payloads(s, graph_id, branch_id))
        return base

    async def entity_indexes(self, *, graph_id: str, branch_id: str) -> Dict[str, object]:
        """Match indexes over a branch's composed state (plan Phase 3 — import matching).

        Returns ``{"urn_to_eid": {urn: eid}, "qname_to_eid": {qualifiedName: eid},
        "edge_to_eid": {(src_eid, tgt_eid, edge_type): eid}, "node_eids": set, "edge_eids": set}``
        so a re-import can match file rows to EXISTING entities (nodes by ``urn``, edges by
        endpoint-triple — the same keying :meth:`sync_ingest`'s ``_external_state`` uses; a
        ``qualifiedName`` index resolves human-authored edge endpoints, last-writer-wins since
        qnames aren't unique) instead of duplicating them. Composed over ``main`` ⊕ the draft, so
        an import onto a draft still matches ``main``'s entities.
        """
        async with self._session() as s:
            state = await self._composed_state(s, graph_id, branch_id)
        urn_to_eid: Dict[str, str] = {}
        qname_to_eid: Dict[str, str] = {}
        edge_to_eid: Dict[tuple, str] = {}
        node_eids: set = set()
        edge_eids: set = set()
        for eid, payload in state.items():
            if payload is None:
                continue
            if _is_edge_payload(payload):
                edge_eids.add(eid)
                edge_to_eid[(payload.get("sourceEntityId"), payload.get("targetEntityId"),
                             payload.get("edgeType"))] = eid
            else:
                node_eids.add(eid)
                if payload.get("urn"):
                    urn_to_eid[payload["urn"]] = eid
                if payload.get("qualifiedName"):
                    qname_to_eid[payload["qualifiedName"]] = eid
        current = {eid: payload for eid, payload in state.items() if payload is not None}
        return {"urn_to_eid": urn_to_eid, "qname_to_eid": qname_to_eid,
                "edge_to_eid": edge_to_eid, "node_eids": node_eids, "edge_eids": edge_eids,
                "current": current}

    async def _composed_state_as_of(
        self, s, graph_id: str, branch_id: str, as_of_seq: int
    ) -> Dict[str, Optional[dict]]:
        """As-of analogue of :meth:`_composed_state` — branch state at
        ``commit_seq <= as_of_seq`` (fork-aware). ``main`` reconstructs at the seq;
        a draft seeds from ``main`` at its branch point (capped at the seq) overlaid
        with the draft's own version rows ≤ the seq."""
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            return await self._state_as_of(s, graph_id, main_id, as_of_seq)
        branch = await s.get(BranchORM, branch_id)
        base_seq = min(as_of_seq, branch.base_commit_seq or 0)
        base = await self._state_as_of(s, graph_id, main_id, base_seq)
        base.update(await self._state_as_of(s, graph_id, branch_id, as_of_seq))
        return base

    async def _people_since(self, s, graph_id: str, main_id: str, base_seq: int, head_seq: int) -> int:
        """How many of ``main``'s commits in ``(base_seq, head_seq]`` people made by hand — what
        makes a draft pull before it lands (:meth:`_pull_needed`). One indexed count over the
        window, cheap enough for the freshness poll."""
        if head_seq <= base_seq:
            return 0
        return int(await s.scalar(select(func.count()).select_from(CommitORM).where(
            CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
            CommitORM.commit_seq > base_seq, CommitORM.commit_seq <= head_seq,
            provenance.is_people_sql(CommitORM.actor_kind, CommitORM.actor, CommitORM.api_key_id),
        )) or 0)

    async def _require_landable(self, s, graph_id: str, main_id: str, draft: BranchORM,
                                head_seq: int) -> None:
        """:class:`NotUpToDate` when ``draft`` must pull before it lands (:meth:`_pull_needed`)."""
        reason = await self._pull_needed(s, graph_id, main_id, draft, head_seq)
        if reason is not None:
            raise NotUpToDate(draft.id, draft.base_commit_seq or 0, head_seq, reason=reason)

    async def _pull_needed(self, s, graph_id: str, main_id: str, draft: BranchORM,
                           head_seq: int) -> Optional[str]:
        """Why ``draft`` must pull the latest before it is published or merged, or ``None`` when it
        may land as it is (doc 19 §3.5).

        Up to date, it lands. Behind ``main``, it still lands when **every** commit since its base
        is automation's (:func:`.provenance.is_automation` — a service account, the platform, an
        API key) and none of them changed an entity the draft changes, or met it at an edge (an
        edge onto a node the draft deletes; a node deleted under an edge the draft makes). Then the
        bounded merge (:meth:`_compute_merge_bounded`) lands exactly the draft's
        own changes onto current main, with nothing to merge, and the squash re-checks the ontology
        and edge integrity against current main, as every publish does. A stream that commits every
        few minutes would otherwise block every person's publish until they pulled.

        Otherwise the person pulls first, so what they review is what lands, as before:
        ``PULL_PEOPLE`` when anyone else changed main; ``PULL_OVERLAP`` when automation changed
        what the draft changes; ``PULL_SIZE`` for a draft past ``SQUASH_PAGED_ABOVE``, which only
        the paged, up-to-date squash publishes."""
        base_seq = draft.base_commit_seq or 0
        if base_seq >= head_seq:
            return None
        made = (await s.execute(
            select(CommitORM.actor_kind, CommitORM.actor, CommitORM.api_key_id).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                CommitORM.commit_seq > base_seq, CommitORM.commit_seq <= head_seq,
            ))).all()
        if not made or not all(provenance.is_automation(k, a, key) for k, a, key in made):
            return PULL_PEOPLE
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            return PULL_PEOPLE           # a fork's main also moves with its parent: pull, as before
        if await self._change_count(s, graph_id, draft.id) > config.SQUASH_PAGED_ABOVE:
            return PULL_SIZE
        heads = await self._heads(s, graph_id, draft.id)
        if set(heads) & await self._changed_in_window(s, graph_id, main_id, base_seq, head_seq):
            return PULL_OVERLAP          # both changed one entity
        # Changes of different entities that still meet at an edge. Deleting a node deletes its edges
        # in the same commit, so the draft would delete an edge automation just made; and an edge the
        # draft makes would end at a node automation deleted. A new edge onto a node the other side
        # renamed merges cleanly, and lands.
        deleted = {e for e, h in heads.items() if h.entity_kind == "node" and h.is_tombstone}
        if deleted & await self._window_edge_ends(s, graph_id, main_id, base_seq, head_seq):
            return PULL_OVERLAP
        ends: set = set()
        live_edges = [h.head_version_id for h in heads.values()
                      if h.entity_kind == "edge" and not h.is_tombstone]
        for chunk in _chunks(live_edges, _IN_LIST_MAX):
            for src, tgt in (await s.execute(
                    select(EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id).where(
                        EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.id.in_(chunk)))).all():
                ends.update(e for e in (src, tgt) if e)
        if ends and ends & set((await s.execute(select(NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                NodeVersionORM.commit_seq > base_seq, NodeVersionORM.commit_seq <= head_seq,
                NodeVersionORM.op == "delete").distinct())).scalars()):
            return PULL_OVERLAP
        return None

    @staticmethod
    async def _window_edge_ends(s, graph_id: str, branch_id: str, base_seq: int, head_seq: int) -> set:
        """The nodes that edges made or changed on ``branch_id`` in ``(base_seq, head_seq]`` end at."""
        ends: set = set()
        for src, tgt in (await s.execute(
                select(EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id).where(
                    EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.branch_id == branch_id,
                    EdgeVersionORM.commit_seq > base_seq, EdgeVersionORM.commit_seq <= head_seq,
                    EdgeVersionORM.op != "delete").distinct())).all():
            ends.update(e for e in (src, tgt) if e)
        return ends

    async def _branch_own_payloads(
        self, s, graph_id: str, branch_id: str
    ) -> Dict[str, Optional[dict]]:
        """Payloads for entities THIS branch itself changed (its own heads only);
        tombstone → None.  Used as the 'ours' side of a rebase merge."""
        heads = await self._heads(s, graph_id, branch_id)
        out: Dict[str, Optional[dict]] = {}
        refs, kindvid = [], {}
        for eid, h in heads.items():
            if h.is_tombstone:
                out[eid] = None
            else:
                kindvid[eid] = h.head_version_id
                refs.append((h.entity_kind, graph_id, h.head_version_id))
        # Chunked: a draft can change more entities than one statement may name (asyncpg caps a
        # statement at 32,767 parameters) — a large import or a bulk property change.
        payload_by_vid = await self._payloads_by_version(s, refs)
        for eid, vid in kindvid.items():
            out[eid] = payload_by_vid.get(vid)
        return out

    async def _compute_merge(self, s, graph_id, graph, draft, main_id, resolutions, own=None):
        """3-way merge a draft onto current main.

        base   = main state at the draft's branch point (common ancestor)
        ours   = base + the draft's own changes (``own``, when the caller already read them)
        theirs = current main state
        Returns ``(merged_state, conflicts, theirs_state)``.
        """
        base = await self._state_as_of(s, graph_id, main_id, draft.base_commit_seq or 0)
        theirs = await self._state_as_of(s, graph_id, main_id, graph.main_head_commit_seq)
        ours = dict(base)
        ours.update(own if own is not None else await self._branch_own_payloads(s, graph_id, draft.id))

        set_fields = frozenset(config.SET_FIELDS)
        merged: Dict[str, Optional[dict]] = {}
        conflicts: List[dict] = []
        for eid in sorted(set(base) | set(theirs) | set(ours)):
            out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields)
            if eid in resolutions:
                # Settle only the conflicting field-paths on top of the auto-merge (see
                # _settle_conflicts) — never wholesale-replace, so the other side's non-conflicting
                # changes to this entity are not dropped when the resolution omits them.
                merged[eid] = _settle_conflicts(
                    out.merged, _normalize_resolution(resolutions[eid]), out.conflicts)
                continue
            merged[eid] = out.merged
            for c in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(c.path),
                    "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                })
        return _collapse_empty_payloads(merged), conflicts, theirs

    async def _compute_merge_bounded(self, s, graph_id, graph, draft, main_id, resolutions,
                                     own=None):
        """Bounded (O(changed)) analogue of :meth:`_compute_merge` for the write path and every
        read that previews it (pull latest, the publish preview, a review's diff).

        Composes base/theirs/ours only over the entities that actually changed — the draft's
        own edits ∪ entities main changed since the draft's branch point ∪ explicit
        resolutions — via the index-backed :meth:`_values_at` (DISTINCT ON), NOT the
        O(history) :meth:`_state_as_of` full replay. Entities outside this set are identical
        on all three sides, so they contribute nothing to ``net_delta(theirs, merged)``;
        excluding them is exact. Returns SPARSE ``(merged, conflicts, theirs)`` — the
        squash then hydrates the live neighborhood the cascade/integrity guards need
        (:meth:`_hydrate_merge_neighborhood`). ``own`` as for :meth:`_compute_merge`. A fork's
        main reads its parent's at the fork point for what it has no row of (:meth:`_values_at`)."""
        base_seq = draft.base_commit_seq or 0
        head_seq = graph.main_head_commit_seq
        if own is None:
            own = await self._branch_own_payloads(s, graph_id, draft.id)
        changed = set(own) | set(resolutions)
        changed |= await self._changed_in_window(s, graph_id, main_id, base_seq, head_seq)
        base = await self._values_at(s, graph_id, main_id, changed, base_seq)
        # Up to date (so at publish and merge but for a draft behind only automation that touched
        # none of its entities, _pull_needed): main's side IS the base — one copy of every changed
        # payload fewer to hold.
        theirs = base if head_seq == base_seq else await self._values_at(s, graph_id, main_id, changed, head_seq)
        ours = {eid: base.get(eid) for eid in changed}
        ours.update(own)

        set_fields = frozenset(config.SET_FIELDS)
        merged: Dict[str, Optional[dict]] = {}
        conflicts: List[dict] = []
        for eid in sorted(changed):
            out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields)
            if eid in resolutions:
                # Settle only the conflicting field-paths (see _settle_conflicts) — never
                # wholesale-replace — so a non-conflicting change the other side made survives.
                merged[eid] = _settle_conflicts(
                    out.merged, _normalize_resolution(resolutions[eid]), out.conflicts)
                continue
            merged[eid] = out.merged
            for c in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(c.path),
                    "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                })
        return _collapse_empty_payloads(merged), conflicts, theirs

    async def _hydrate_merge_neighborhood(self, s, graph_id, main_id, merged, theirs) -> None:
        """Make a SPARSE merged/theirs (from :meth:`_compute_merge_bounded`) safe for the
        in-dict cascade + referential-integrity guards, which only see entities present in
        the dict. Pulls the live MAIN neighborhood the guards reason about:

        * live incident edges (on main) of every tombstoned entity in ``merged`` — so a
          node delete cascades to an edge that the draft didn't itself touch, AND
        * the current value of every endpoint referenced by a live edge in ``merged`` — so
          an edge added between two UNCHANGED main nodes doesn't trip a false 'dangling' error.

        Each hydrated entity is added at its current main value to BOTH ``merged`` and
        ``theirs`` (so it nets to zero in ``net_delta`` unless the cascade then tombstones
        it). Bounded by the degree of the tombstoned nodes — never the whole graph."""
        graph = await s.get(GraphORM, graph_id)
        head = graph.main_head_commit_seq if graph else (1 << 62)
        tomb = [eid for eid, p in merged.items() if p is None]
        incident = await self._incident_live_edges(s, graph_id, main_id, tomb) if tomb else {}
        endpoints: set = set()
        for p in list(merged.values()) + list(incident.values()):
            if not p:
                continue
            a, b = _edge_src_tgt(p)
            if a:
                endpoints.add(a)
            if b:
                endpoints.add(b)
        need = [e for e in (set(incident) | endpoints) if e not in merged]
        if not need:
            return
        main_vals = await self._values_at(s, graph_id, main_id, need, head)
        for eid in need:
            v = main_vals.get(eid)
            if v is None:
                continue                     # absent/tombstoned on main — nothing to hydrate
            merged.setdefault(eid, v)        # present as current main value (unchanged → no delta)
            theirs.setdefault(eid, v)        # mirror so net_delta nets it to zero

    async def _kind_map_multi(
        self, s, pairs: Sequence[Tuple[str, str]],
        entity_ids: Optional[Sequence[str]] = None,
    ) -> Dict[str, str]:
        """``entity_id → kind`` across several ``(graph_id, branch_id)`` head sets
        (first match wins) — spans a fork and its parent for cross-graph merges.

        ``entity_ids`` bounds the lookup to those ids via chunked IN-lists on the
        ``(graph_id, branch_id, entity_id)`` PK. The merge/rebase/revert paths only
        need kinds for their DELTA, so resolving them stays O(delta) — a full-branch
        head scan here ran inside the merge advisory lock and made publishing a
        5-entity change O(entire graph)."""
        out: Dict[str, str] = {}
        id_chunks: Optional[List[list]] = None
        if entity_ids is not None:
            ids = list(dict.fromkeys(entity_ids))
            if not ids:
                return out
            id_chunks = list(_chunks(ids, _IN_LIST_MAX))
        for gid, bid in pairs:
            for chunk in (id_chunks if id_chunks is not None else [None]):
                stmt = select(EntityHeadORM.entity_id, EntityHeadORM.entity_kind).where(
                    EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == bid,
                )
                if chunk is not None:
                    stmt = stmt.where(EntityHeadORM.entity_id.in_(chunk))
                for eid, kind in (await s.execute(stmt)).all():
                    out.setdefault(eid, kind)
        return out

    @staticmethod
    def _resolve_delta_kinds(
        deltas: List[Delta], fallback: Dict[str, str]
    ) -> Dict[str, str]:
        """Authoritative node/edge kind for each delta being written: the PAYLOAD
        shape wins (``_is_edge_payload``), matching the edit/sync paths
        (``_apply_ops_once``/``sync_ingest``). A delete delta carries no payload, so
        it falls back to the head-pointer kind, then ``node``.

        The merge paths previously trusted only the mutable ``EntityHeadORM`` kind
        (``_kind_map_multi``), which — combined with the head upsert formerly omitting
        ``entity_kind`` — could be stale and steer a merged delta into the WRONG
        version table, so it then read back as missing (deleted) and got re-created.
        Deriving kind from the payload here makes the write table deterministic."""
        out = dict(fallback)
        for d in deltas:
            if d.payload is not None:
                out[d.entity_id] = "edge" if _is_edge_payload(d.payload) else "node"
            else:
                out.setdefault(d.entity_id, fallback.get(d.entity_id, "node"))
        return out

    async def _commit_merkle(self, s, graph_id: str, branch_id: str, commit,
                             deltas: List[Delta]) -> Optional[str]:
        """Merkle root for a commit. For a **non-fork `main`** (linear, long-lived)
        this is the incremental persisted CoW build — O(changed·depth), writing
        only changed-path rows. A draft's commit and a fork's get none: only a non-fork
        ``main``'s roots are ever read (the projector's diff); an import window would otherwise
        write tens of thousands of tree rows nobody reads, and a fork's would be built from its
        parent's whole state on every commit."""
        branch = await s.get(BranchORM, branch_id)
        if branch is not None and branch.kind != "main":
            return None
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            return None
        changes: Dict[str, Optional[str]] = {
            d.entity_id: (None if d.op == "delete" else d.content_hash) for d in deltas
        }
        return await self._merkle.commit_tree(
            s, graph_id, branch_id, commit.id, commit.commit_seq, changes
        )

    async def bulk_ingest(
        self, *, graph_id: str, rows, actor: str,
        idempotency_key: Optional[str] = None, message: str = "bulk import",
        session=None, standard_ids: bool = False,
    ) -> Dict[str, object]:
        """Day-0 / large-delta import (plan §4, §10): validate rows, assign stable
        entity_ids (urn-keyed for idempotent re-sync), and write ONE ``import``
        commit on ``main`` via **chunked bulk inserts** — never row-by-row. Invalid
        rows are skipped and returned in a ``rejected`` report; valid rows still
        land. Idempotent on ``idempotency_key`` (a retry returns the first commit).

        ATOMIC: the whole import (every insert chunk + the Merkle update + the commit
        row) runs in one transaction — any chunk failing rolls the entire commit back,
        so a graph is never left partially seeded. Pass ``session`` to fold this into a
        larger transaction (e.g. create-graph + seed as one unit).

        Without ``session`` (the API path) it runs under the graph lock, is retried, and seeds
        only an EMPTY graph: every row becomes a ``create`` with no prior, so on a graph that has
        entities it would write versions that ignore what main holds. Updating one is a sync.

        ``standard_ids`` (the API route): a new entity's id is what an import gives it — a
        ``urn:uuid`` the row brings, else one derived from its urn or its own id (an edge's, from
        its ends and type). Otherwise (the bootstrap) a node is named by its id or urn as given."""
        rows = list(rows)        # every attempt reads it
        scope = await self.identity_scope(graph_id) if standard_ids else None

        async def once():
            return await self._bulk_ingest_once(
                graph_id=graph_id, rows=rows, actor=actor, idempotency_key=idempotency_key,
                message=message, session=session, scope=scope)
        if session is not None:  # seeding a graph made in this transaction: no one else sees it
            return await once()
        return await self._retry_seq(f"bulk import into {graph_id}", once)

    async def _bulk_ingest_once(
        self, *, graph_id: str, rows, actor: str, idempotency_key: Optional[str],
        message: str, session, scope: Optional[str] = None,
    ) -> Dict[str, object]:
        """One attempt at :meth:`bulk_ingest`."""
        async with self._session_scope(session) as s:
            if session is None:
                await self._lock_graph(s, graph_id)
                await self._assert_not_bootstrapping(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)

            if idempotency_key:
                prior = await s.scalar(select(CommitORM).where(
                    CommitORM.graph_id == graph_id,
                    CommitORM.idempotency_key == idempotency_key,
                ))
                if prior is not None:
                    st = prior.stats or {}
                    return {"commit_id": prior.id, "commit_seq": prior.commit_seq,
                            "ingested": st.get("nodes", 0) + st.get("edges", 0),
                            "rejected": [], "idempotent_replay": True}
            if session is None:              # after the replay: an import that landed still answers
                await self._assert_writable(s, graph_id)
            if session is None and await s.scalar(select(EntityHeadORM.entity_id).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.is_tombstone.is_(False)).limit(1)) is not None:
                raise ConcurrencyError("bulk import only seeds an empty graph — this one already "
                                       "has entities; use sync to update it")

            rejected: List[dict] = []
            node_deltas: List[Delta] = []
            edge_src: List[tuple] = []
            urn_to_eid: Dict[str, str] = {}
            node_eids: set = set()

            for i, row in enumerate(rows):
                kind = (row or {}).get("kind")
                if kind == "node":
                    if not row.get("entityType"):
                        rejected.append({"row": i, "reason": "node missing entityType"})
                        continue
                    # One identity: a node is named by its urn when it brings no id, and a node
                    # that brings neither is given a urn:uuid that is its urn too. Minting
                    # (``scope``), it takes the id an import would give it.
                    if scope is not None:
                        eid = _derived_node_id(scope, row) or new_entity_id()
                    else:
                        eid = row.get("entity_id") or row.get("id") or row.get("urn") or new_entity_id()
                    if eid in node_eids:
                        rejected.append({"row": i, "reason": f"another node in this file is '{eid}'"})
                        continue
                    node_eids.add(eid)
                    payload = _sanitize_node_properties(
                        {k: v for k, v in row.items() if k not in ("kind", "id", "entity_id")})
                    if not payload.get("urn"):
                        payload["urn"] = eid
                    node_deltas.append(Delta(eid, "create", payload, None, content_hash(payload)))
                    if row.get("urn"):
                        urn_to_eid[row["urn"]] = eid
                    for own in (row.get("entity_id"), row.get("id")):     # the file's own names
                        if own:
                            urn_to_eid.setdefault(own, eid)
                    urn_to_eid[eid] = eid
                elif kind == "edge":
                    edge_src.append((i, row))
                else:
                    rejected.append({"row": i, "reason": f"unknown kind {kind!r}"})

            edge_deltas: List[Delta] = []
            edge_eids: set = set()
            for i, row in edge_src:
                et, src, tgt = row.get("edgeType"), row.get("source"), row.get("target")
                if not (et and src and tgt):
                    rejected.append({"row": i, "reason": "edge missing edgeType/source/target"})
                    continue
                seid, teid = urn_to_eid.get(src), urn_to_eid.get(tgt)
                if not (seid and teid):
                    rejected.append({"row": i, "reason": "edge endpoint not found"})
                    continue
                eid = (_derived_edge_id(scope, row, seid, teid, et) if scope is not None
                       else row.get("entity_id") or row.get("id") or new_entity_id())
                if eid in edge_eids:
                    rejected.append({"row": i, "reason": f"another edge in this file is '{eid}'"})
                    continue
                edge_eids.add(eid)
                payload = edge_payload_from_parts(edge_type=et, source_entity_id=seid,
                                                  target_entity_id=teid, row=row)
                edge_deltas.append(Delta(eid, "create", payload, None, content_hash(payload)))

            deltas = node_deltas + edge_deltas
            if not deltas:
                return {"commit_id": None, "ingested": 0, "rejected": rejected}

            new_seq = graph.main_head_commit_seq + 1
            main = await s.get(BranchORM, main_id)
            commit = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="import", message=message,
                actor=actor, **commit_provenance(actor), idempotency_key=idempotency_key,
                stats={"nodes": len(node_deltas), "edges": len(edge_deltas)},
            )
            s.add(commit)
            await s.flush()
            await self._bulk_insert_versions(s, graph_id, main_id, commit, node_deltas, edge_deltas, actor)
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = new_seq
            if session is None:     # with one, it seeds a graph being enabled: `enabled` says so
                main_activity.note(s, graph, commit)
            commit.merkle_root = await self._commit_merkle(s, graph_id, main_id, commit, deltas)
            graph.updated_at = _now()
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return {"commit_id": commit.id, "commit_seq": new_seq, "ingested": len(deltas),
                    "nodes": len(node_deltas), "edges": len(edge_deltas), "rejected": rejected}

    async def resync_from_provider(
        self, *, graph_id: str, provider, actor: str, source: str = "provider",
        strategy: str = "merge", resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        containment_edge_types: Optional[Sequence[str]] = None, batch: int = 2000,
        allow_curation_risk: bool = False, allow_mass_delete: bool = False,
    ) -> Dict[str, object]:
        """Re-synchronize a versioned graph from its provider's CURRENT state, on demand —
        runnable at any time for any versioned graph (requirement: on-demand sync). Pages
        the provider's full snapshot (OUTSIDE the txn) and feeds it through the 3-way
        :meth:`sync_ingest`, so authoritative source changes land on ``main`` WITHOUT
        clobbering user edits (a field both sides changed conflicts unless
        ``strategy='external_wins'``). The projector then refreshes FalkorDB. The
        ``collect_provider_rows`` output shape (kind/urn/entityType for nodes;
        edgeType/source/target for edges) is exactly what ``sync_ingest`` consumes."""
        # Refuse BEFORE paging the provider. `collect_provider_rows` is the first of the six
        # whole-graph allocations, and by the time it has finished the process may already be
        # dead — so the check that saves us has to come before it, not inside sync_ingest's
        # transaction. (sync_ingest checks too: it is O(graph) for its OWN callers regardless
        # of how many rows they hand it.)
        await self._assert_syncable(graph_id)
        async with self._session() as s:      # nor for a graph that is not writable
            await self._assert_writable(s, graph_id)
        # A sync refused for curation at risk is refused whatever the provider holds, so ask
        # first. sync_ingest asks again under the lock.
        if not allow_curation_risk:
            async with self._session() as s:
                main_id = await self._main_branch_id(s, graph_id)
                human = await self._human_commit_in_sync_base(
                    s, graph_id, main_id, await self._last_sync_seq(s, graph_id, main_id))
            if human is not None:
                raise _curation_at_risk(human)
        from backend.app.providers.versioned_bootstrap import collect_provider_rows
        rows = await collect_provider_rows(provider, batch=batch)
        return await self.sync_ingest(
            graph_id=graph_id, rows=rows, actor=actor, source=source,
            strategy=strategy, resolutions=resolutions,
            containment_edge_types=containment_edge_types, message="resync from provider",
            allow_curation_risk=allow_curation_risk, allow_mass_delete=allow_mass_delete)

    async def bring_into_history(self, *, graph_id: str, client, rules, actor: str,
                                 strategy: str = "merge") -> Dict[str, object]:
        """Take what a customer's FalkorDB graph holds that history doesn't into ``main``, as
        one ``sync`` commit. ``client`` is the key the projection publishes into, read whole as
        the enable reads it (``BootstrapRunner.read_graph``, each type spelled by ``rules``). The
        caller has seen that key hold main — a fresh watermark, on a key the platform doesn't
        own — so every edit people made is in it and none reads back as an old value
        (``curation_at_risk`` does not apply). A field both people and the graph changed
        conflicts unless ``strategy='external_wins'``.

        Nothing is deleted from history: a node the graph lacks may be one a read missed, and a
        publish writes history back into the key. Identifiers several nodes in the graph share
        with different contents are left out (``duplicates``).

        The projector writes each type back in the graph's spelling of it, as read here and
        recorded (``physical_types``). A type the graph spells more than one way is refused
        (:class:`AmbiguousSpelling`): brought in, what one spelling holds would be written back
        as a copy under the other."""
        await self._assert_syncable(graph_id)       # before the read, as for any re-sync
        async with self._session() as s:
            await self._assert_writable(s, graph_id)
        from .bootstrap_worker import BootstrapRunner
        rows, spelled, clashes = await BootstrapRunner(None).read_graph(client, rules)
        twice = {t: s for kind in ("nodes", "edges") for t, s in spelled[kind].items() if len(s) > 1}
        if twice:
            raise AmbiguousSpelling(twice)
        await self._record_spelling(graph_id, spelled)
        await self._as_history_holds(graph_id, rows)
        result = await self.sync_ingest(
            graph_id=graph_id, rows=rows, actor=actor, source="provider", strategy=strategy,
            message="bring into history", holds_main=True, deletes=False)
        return {**result, "duplicates": sorted(clashes)[:200]}

    async def _record_spelling(self, graph_id: str, spelled: Mapping[str, Mapping[str, Set[str]]]
                               ) -> None:
        """Record, over what was recorded, a customer's graph's spelling of each type a read of
        it found spelled one way (``projection_state.physical_types``): the graph's own word is
        what the projector writes. A key the platform owns is spelled as declared."""
        from .reconcile import spelling_key
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id, with_for_update=True)
            if ps is None or ps.owns_falkor_graph:
                return
            types = {}
            for kind in ("nodes", "edges"):
                seen = {t: next(iter(v)) for t, v in (spelled.get(kind) or {}).items() if len(v) == 1}
                keys = {spelling_key(t) for t in seen}
                types[kind] = {t: v for t, v in ((ps.physical_types or {}).get(kind) or {}).items()
                               if spelling_key(t) not in keys}
                types[kind].update(seen)
            ps.physical_types = types

    async def _as_history_holds(self, graph_id: str, rows: List[dict]) -> None:
        """Make a FalkorDB graph's rows say what history would, so a sync of them holds only
        real changes. A field filled in empty (:data:`_FILLED_IN`) that the node's head doesn't
        hold is dropped; an edge whose id is also a node's is ``edge:<id>``, as the enable keys
        it (``bootstrap_worker._rekey``) — else it would take the node's place in the merge; and
        a type history holds the item as, in another casing (the ontology changed its own since),
        is history's. One indexed lookup per chunk."""
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
            nodes = [r for r in rows if r.get("kind") == "node" and r.get("urn")]
            for chunk in _chunks(nodes, 5000):
                held = dict((await s.execute(
                    select(NodeVersionORM.urn, NodeVersionORM.payload)
                    .join(EntityHeadORM, (EntityHeadORM.graph_id == NodeVersionORM.graph_id)
                          & (EntityHeadORM.head_version_id == NodeVersionORM.id))
                    .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                           EntityHeadORM.is_tombstone.is_(False),
                           NodeVersionORM.urn.in_([r["urn"] for r in chunk])))).all())
                for r in chunk:
                    head = held.get(r["urn"])
                    for k, empty in (_FILLED_IN.items() if head is not None else ()):
                        if k in r and k not in head and r[k] == empty:
                            del r[k]
                    if head is not None and _same_type(head.get("entityType"), r.get("entityType")):
                        r["entityType"] = head["entityType"]
            named = {r["id"] for r in nodes if r.get("id")}       # a new node's id is its urn
            edges = [r for r in rows if r.get("kind") == "edge" and r.get("id")]
            for chunk in _chunks([r["id"] for r in edges if r["id"] not in named], 10000):
                named.update((await s.execute(select(EntityHeadORM.entity_id).where(
                    EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                    EntityHeadORM.entity_kind == "node",
                    EntityHeadORM.entity_id.in_(chunk)))).scalars())
            for r in edges:
                if r["id"] in named:
                    r["id"] = f"edge:{r['id']}"
            for chunk in _chunks([r["id"] for r in edges], 10000):
                typed = dict((await s.execute(
                    select(EntityHeadORM.entity_id, EdgeVersionORM.edge_type)
                    .join(EdgeVersionORM, (EdgeVersionORM.graph_id == EntityHeadORM.graph_id)
                          & (EdgeVersionORM.id == EntityHeadORM.head_version_id))
                    .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                           EntityHeadORM.entity_kind == "edge",
                           EntityHeadORM.is_tombstone.is_(False),
                           EntityHeadORM.entity_id.in_(chunk)))).all())
                for r in edges:
                    if _same_type(typed.get(r["id"]), r.get("edgeType")):
                        r["edgeType"] = typed[r["id"]]

    async def _assert_syncable(self, graph_id: str) -> None:
        """Refuse a sync the machine cannot survive, with the number that proves it.

        See :class:`GraphTooLargeToSync`. The count is the only cheap thing in this operation:
        one indexed count against `entity_heads`, versus the several gigabytes the merge would
        otherwise ask for. Fail fast, fail honestly, change nothing."""
        limit = config.RESYNC_MAX_ENTITIES
        if limit <= 0:
            return                                      # explicitly disabled by an operator
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
            entities = await self._main_live_count(s, graph_id, main_id)
        if entities > limit:
            logger.warning(
                "refusing sync for graph %s: %d entities exceeds the %d limit (~%.1f GB)",
                graph_id, entities, limit, entities * _SYNC_BYTES_PER_ENTITY / 1_073_741_824)
            raise GraphTooLargeToSync(entities, limit)

    async def _main_live_count(self, s, graph_id: str, main_id: str) -> int:
        return await s.scalar(
            select(func.count()).select_from(EntityHeadORM).where(
                EntityHeadORM.graph_id == graph_id,
                EntityHeadORM.branch_id == main_id,
                EntityHeadORM.is_tombstone.is_(False),
            )) or 0

    async def _last_sync_seq(self, s, graph_id: str, main_id: str) -> int:
        """Main's newest import or sync commit: the seq a sync's merge base is read at."""
        return await s.scalar(select(CommitORM.commit_seq).where(
            CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
            CommitORM.kind.in_(("import", "sync")),
        ).order_by(CommitORM.commit_seq.desc()).limit(1)) or 0

    async def _human_commit_in_sync_base(self, s, graph_id: str, main_id: str, last_seq: int):
        """The newest human commit on main OLDER than the last import or sync, or None.

        Not "any human commit since the last sync": those are outside the merge base, so the
        3-way merge keeps them as ours. The ones before it are IN the base, so a sync reads
        them as the source's old values and reverts them, and deletes what people created
        (AUTOVSHUMAN-01). Stop-gap until INGEST S1's source shadow becomes the base."""
        return (await s.execute(
            select(CommitORM.id, CommitORM.commit_seq, CommitORM.kind, CommitORM.actor,
                   CommitORM.created_at).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == main_id,
                CommitORM.commit_seq < last_seq,
                CommitORM.kind.notin_(_MACHINE_COMMIT_KINDS),
            ).order_by(CommitORM.commit_seq.desc()).limit(1))).first()

    async def edge_payload_health(
        self, graph_id: str, *, sample_limit: int = 20
    ) -> Dict[str, object]:
        """Flag edges on ``main`` whose durable payload is in the pre-contract FLATTENED shape
        (user properties spread at the top level, ``confidence`` dropped) — i.e. graphs bootstrapped
        or synced before the serialization contract. A non-zero ``flattened`` count means the graph
        should be re-imported from its source via :meth:`resync_from_provider`
        (``strategy='external_wins'``) to recover properties AND confidence — iff the source still
        holds them. Keyset-paged over ``entity_heads`` (O(batch) memory). Returns
        ``{scanned, flattened, samples}`` with ``samples`` bounded to ``sample_limit``."""
        from .entity_serde import is_flattened_edge_payload
        scanned = 0
        flattened = 0
        samples: List[dict] = []
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
        if main_id is None:
            return {"scanned": 0, "flattened": 0, "samples": []}
        cursor = ""
        while True:
            async with self._session() as s:
                rows = (await s.execute(
                    select(EntityHeadORM.entity_id, EdgeVersionORM.payload).join(
                        EdgeVersionORM,
                        (EdgeVersionORM.graph_id == EntityHeadORM.graph_id)
                        & (EdgeVersionORM.id == EntityHeadORM.head_version_id),
                    ).where(
                        EntityHeadORM.graph_id == graph_id,
                        EntityHeadORM.branch_id == main_id,
                        EntityHeadORM.entity_kind == "edge",
                        EntityHeadORM.is_tombstone.is_(False),
                        EntityHeadORM.entity_id.collate("C") > cursor,
                    ).order_by(EntityHeadORM.entity_id.collate("C")).limit(2000)
                )).all()
            for eid, payload in rows:
                scanned += 1
                if is_flattened_edge_payload(payload or {}):
                    flattened += 1
                    if len(samples) < sample_limit:
                        samples.append({"entityId": eid,
                                        "edgeType": (payload or {}).get("edgeType")})
            if len(rows) < 2000:
                break
            cursor = rows[-1][0]
        return {"scanned": scanned, "flattened": flattened, "samples": samples}

    async def sync_ingest(
        self, *, graph_id: str, rows, actor: str, source: str = "external",
        idempotency_key: Optional[str] = None, message: str = "external sync",
        strategy: str = "merge", resolutions: Optional[Mapping[str, Optional[dict]]] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
        allow_curation_risk: bool = False, allow_mass_delete: bool = False,
        holds_main: bool = False, deletes: bool = True, standard_ids: bool = False,
    ) -> Dict[str, object]:
        """Re-sync an authoritative/external snapshot into ``main`` as a single ``sync``
        commit **without clobbering user edits** (plan §D5). 3-way merge: base = the
        previous import/sync snapshot, ours = current main (the user's edits since),
        theirs = the external snapshot. A field both sides changed conflicts under
        ``strategy='merge'`` (resubmit with ``resolutions``) or takes the external value
        under ``strategy='external_wins'``. The snapshot is authoritative: an entity it
        drops is deleted if the user hadn't touched it. Idempotent on ``idempotency_key``.

        MEMORY: this reconstructs the whole graph several times over (base, ours, theirs,
        merged, plus the urn/edge match indexes), so it is O(graph) for EVERY caller — no
        matter how few rows they pass. Pushing a SINGLE row into a 7.7M-entity graph asks for
        ~30 GB just as surely as a full re-sync does. That is why the guard lives here and not
        only on the resync path. See :class:`GraphTooLargeToSync`.

        Two stop-gap refusals, each with an admin override that is named in the commit message
        and in the report's ``overrides``: :class:`CurationAtRisk` when main holds a human commit
        older than the last import or sync (``allow_curation_risk``), and
        :class:`MassDeleteBlocked` when the sync would delete more than
        max(``SYNC_DELETE_MAX_ABS``, ``SYNC_DELETE_MAX_FRACTION`` x live) entities
        (``allow_mass_delete``). ``holds_main``: the snapshot is the graph's own published key
        (:meth:`bring_into_history`), which nothing people did is missing from, so
        :class:`CurationAtRisk` does not apply. ``deletes=False``: the snapshot may be partial,
        so an entity it doesn't mention is left as it is.

        ``standard_ids`` (the API route): an entity the snapshot brings that main doesn't hold
        takes the id an import would give it (``_derived_node_id``, ``_derived_edge_id``). One
        that names an entity by an id it already has — whatever its format, from before, a
        ``urn:uuid`` in any case — is that entity, so it is updated or deleted as ever; a row with
        no urn that names one so is taken as it comes. A node a row with no urn makes carries its
        id as its urn, and the row finds it by that id next time, whatever urn it carries by then.
        One main deleted comes back under its id: a node by the urn it last had, an edge by the
        ends and type it last joined. An edge names a node of the snapshot by its urn or its own
        id."""
        await self._assert_syncable(graph_id)
        rows = list(rows)        # every attempt reads it; a spent iterator would delete everything
        scope = await self.identity_scope(graph_id) if standard_ids else None
        return await self._retry_seq(
            f"sync {graph_id}",
            lambda: self._sync_ingest_once(
                graph_id=graph_id, rows=rows, actor=actor, source=source,
                idempotency_key=idempotency_key, message=message, strategy=strategy,
                resolutions=resolutions, containment_edge_types=containment_edge_types,
                allow_curation_risk=allow_curation_risk, allow_mass_delete=allow_mass_delete,
                holds_main=holds_main, deletes=deletes, scope=scope))

    async def _sync_ingest_once(
        self, *, graph_id: str, rows, actor: str, source: str,
        idempotency_key: Optional[str], message: str, strategy: str,
        resolutions: Optional[Mapping[str, Optional[dict]]],
        containment_edge_types: Optional[Sequence[str]],
        allow_curation_risk: bool, allow_mass_delete: bool, holds_main: bool = False,
        deletes: bool = True, scope: Optional[str] = None,
    ) -> Dict[str, object]:
        """One attempt at :meth:`sync_ingest`, under the graph lock: the idempotent replay, the
        last sync and main's head are all read with main held still."""
        async with self._session() as s:
            await self._lock_graph(s, graph_id)
            await self._assert_not_bootstrapping(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)

            if idempotency_key:
                prior = await s.scalar(select(CommitORM).where(
                    CommitORM.graph_id == graph_id,
                    CommitORM.idempotency_key == idempotency_key,
                ))
                if prior is not None:
                    st = prior.stats or {}
                    return {"commit_id": prior.id, "commit_seq": prior.commit_seq,
                            "applied": st.get("nodes", 0) + st.get("edges", 0),
                            "rejected": [], "idempotent_replay": True}
            await self._assert_writable(s, graph_id)     # after the replay, as for bulk

            last_seq = await self._last_sync_seq(s, graph_id, main_id)
            # After the replay, so a retried key still answers; before any O(graph) work.
            overrides: List[str] = []
            human = (None if holds_main
                     else await self._human_commit_in_sync_base(s, graph_id, main_id, last_seq))
            if human is not None:
                if not allow_curation_risk:
                    raise _curation_at_risk(human)
                overrides.append("curation_at_risk")

            # BOUNDED. This used to be two full `_state_as_of` replays plus an `_external_state`
            # that indexed the whole of `ours` — six whole-graph structures resident at once, and
            # 2.03 GB of RSS measured to compute 808 changes on a 478k graph.
            #
            # It is exact to leave the rest out, for the same reason `_compute_merge_bounded`
            # gives on the PR path: an entity identical on all three sides contributes nothing to
            # `net_delta`. Here we can prove "identical" cheaply — if the external payload hashes
            # to what `entity_heads` already holds, then theirs == ours, and three_way_merge
            # returns ours whatever base was. So it is dropped the moment it is read.
            #
            # Deletions are the one thing that CANNOT be dropped, because they are defined by
            # ABSENCE: an entity the snapshot no longer mentions must be deleted, and you cannot
            # see an absence by looking at what is there. So the external id SET is kept (strings
            # only) and the live head is streamed against it.
            theirs, seen, rejected = await self._external_state_bounded(s, graph_id, main_id, rows,
                                                                        scope=scope)
            deletions = (await self._live_ids_absent_from(s, graph_id, main_id, seen)
                         if deletes else set())
            changed = set(theirs) | deletions | set(resolutions or {})
            base = await self._values_at(s, graph_id, main_id, changed, last_seq)
            ours = await self._values_at(s, graph_id, main_id, changed, graph.main_head_commit_seq)

            set_fields = frozenset(config.SET_FIELDS)
            res = dict(resolutions or {})
            merged: Dict[str, Optional[dict]] = {}
            conflicts: List[dict] = []
            overridden: List[dict] = []
            # `external_wins` is a FIELD-level policy, not an entity-level one. It used to be
            # `merged[eid] = theirs` — replacing the whole entity with the external payload and
            # discarding the field merge entirely. One disputed field therefore took the entire
            # entity down with it, silently deleting any curation the source had never heard of
            # (`businessOwner`, `classification`, …). It destroyed most where the graph was worth
            # most. Now the source wins the FIELDS it disputes; everything a human added that the
            # source never touched survives.
            policy = "theirs" if strategy == "external_wins" else "ours"
            # `changed` IS the union that matters — everything else is identical on all three
            # sides by construction (see the note above), and would net to zero anyway.
            for eid in sorted(changed):
                if eid in res:
                    merged[eid] = _normalize_resolution(res[eid])
                    continue
                out = three_way_merge(base.get(eid), ours.get(eid), theirs.get(eid), set_fields,
                                      on_conflict=policy)
                merged[eid] = out.merged
                for c in out.conflicts:
                    row = {
                        "entity_id": eid, "path": list(c.path),
                        "base": c.base, "ours": c.ours, "theirs": c.theirs, "kind": c.kind,
                    }
                    # Under external_wins the conflict is not an error to resolve — it is a
                    # RECEIPT. Overwriting someone's work is allowed; doing it silently is not,
                    # so the caller gets back exactly which edits the source overruled.
                    (overridden if policy == "theirs" else conflicts).append(row)
            if conflicts:
                raise MergeConflict(conflicts)
            if overridden:
                logger.info("sync overrode %d user edit(s) on graph %s (external_wins)",
                            len(overridden), graph_id)

            _collapse_empty_payloads(merged)                            # {} → tombstone before guards
            # `merged` is now SPARSE, and the three guards below only reason about entities that
            # are IN the dict. Without this, a node deleted by the source would not cascade to an
            # edge the snapshot never mentioned (dangling edge = corruption), and an edge between
            # two unchanged nodes would trip a false "dangling endpoint" error because neither
            # endpoint is in the dict. Hydrating the live neighbourhood is how the PR merge path
            # already solves exactly this — do NOT try to window the cascades themselves; that is
            # where a silent, data-losing bug would come from. Bounded by the degree of the
            # deleted nodes, never by the graph.
            await self._hydrate_merge_neighborhood(s, graph_id, main_id, merged, ours)
            self._cascade_containment(merged, containment_edge_types)   # drop orphaned descendants
            self._cascade_incident_edges(merged)                        # then their dangling edges
            self._assert_referential_integrity(merged)
            deltas = net_delta(ours, merged)                 # changes to apply on top of current main
            if not deltas:
                return {"commit_id": None, "commit_seq": graph.main_head_commit_seq,
                        "applied": 0, "rejected": rejected, "idempotent_replay": False,
                        # WHICH user edits the source overruled. Overwriting a
                        # person's work is allowed; doing it silently is not.
                        "overridden": overridden[:200], "overrides": overrides}

            # Counts the cascaded deletes too: that is what lands.
            deletes = sum(1 for d in deltas if d.op == "delete")
            if deletes > config.SYNC_DELETE_MAX_ABS:
                live = await self._main_live_count(s, graph_id, main_id)
                limit = max(config.SYNC_DELETE_MAX_ABS, int(config.SYNC_DELETE_MAX_FRACTION * live))
                if deletes > limit:
                    if not allow_mass_delete:
                        raise MassDeleteBlocked(
                            deletes, limit,
                            f"this sync would delete {deletes:,} of {live:,} entities (limit "
                            f"{limit:,}). A snapshot that is missing rows reads as 'the source "
                            "deleted them'. A workspace admin can re-run with allowMassDelete.",
                            live=live)
                    overrides.append("mass_delete")
            if overrides:
                message = f"{message} (admin override: {', '.join(overrides)})"
                logger.warning("sync on graph %s by %s proceeded under admin override: %s",
                               graph_id, actor, overrides)

            kind_by_entity = {eid: ("edge" if _is_edge_payload(p) else "node")
                              for eid, p in ours.items() if p is not None}
            kind_by_entity.update({eid: ("edge" if _is_edge_payload(p) else "node")
                                   for eid, p in merged.items() if p is not None})

            new_seq = graph.main_head_commit_seq + 1
            main = await s.get(BranchORM, main_id)
            commit = CommitORM(
                graph_id=graph_id, branch_id=main_id, commit_seq=new_seq,
                parent_commit_id=main.head_commit_id, kind="sync", message=message,
                actor=actor, **commit_provenance(actor), idempotency_key=idempotency_key, change_reason=source,
            )
            s.add(commit)
            await s.flush()
            await self._write_deltas(s, graph_id, main_id, commit, deltas, kind_by_entity, actor)
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = new_seq
            main_activity.note(s, graph, commit)
            commit.merkle_root = await self._commit_merkle(s, graph_id, main_id, commit, deltas)
            graph.updated_at = _now()
            commit.stats = _delta_stats(deltas)
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.target_commit_seq = new_seq
            return {"commit_id": commit.id, "commit_seq": new_seq,
                    "applied": len(deltas), "rejected": rejected, "idempotent_replay": False,
                        # WHICH user edits the source overruled. Overwriting a
                        # person's work is allowed; doing it silently is not.
                        "overridden": overridden[:200], "overrides": overrides}

    async def _external_state_bounded(self, s, graph_id: str, main_id: str, rows,
                                      scope: Optional[str] = None):
        """`_external_state`, without holding the graph. ``scope``: what main doesn't hold takes
        an id as an import mints it (:meth:`sync_ingest`'s ``standard_ids``).

        Returns ``(theirs, seen, rejected)`` where

        * ``theirs`` — {entity_id: payload} for ONLY the rows that can produce a delta, i.e.
          those that are new, or whose payload differs from what main already holds;
        * ``seen``   — every external entity id, including the discarded ones. This set is the
          price of authoritative deletion and cannot be avoided: an entity the snapshot no longer
          mentions must be DELETED, and you cannot see an absence by looking at what is present.
          Strings only — a few tens of MB at 478k, versus the gigabytes the payloads cost.

        The discard rule is exact, not a heuristic. If the external payload hashes to what
        ``entity_heads`` already holds then theirs == ours, and ``three_way_merge(base, X, X)``
        returns X for any base: no conflict, no delta, nothing to do. A tombstoned head is never
        discarded — there, "same hash" would mean the user DELETED something the source still has,
        which is a real decision the merge has to make.

        The old code instead built ``urn_index`` and ``edge_index`` by iterating the whole of
        ``ours``, which is what made even a ONE-ROW /sync call O(graph).
        """
        # The SAME hash the write path stamps onto entity_heads (`_write_deltas` → merkle
        # .content_hash). If it were a different function the discard rule would be silently
        # wrong: every entity would look changed, or worse, changed ones would look identical.
        _ch = content_hash

        rows = list(rows)
        theirs: Dict[str, dict] = {}
        seen: set = set()
        rejected: List[dict] = []

        # ── nodes ────────────────────────────────────────────────────────────
        node_rows = [(i, r) for i, r in enumerate(rows) if (r or {}).get("kind") == "node"]
        # The urn a row's node carries: its own, or — minting, for a row with none — the id it
        # derives, which a node made from that row carries as its urn.
        keys = {i: r.get("urn") or (_derived_node_id(scope, r) if scope is not None else None)
                for i, r in node_rows}
        known = await self._heads_by_urn(s, graph_id, main_id, keys.values())   # urn -> (eid, hash, tomb)
        # Minting: the deleted nodes whose urn it last was, and which of the ids a row not found by
        # its urn could be named by main holds — its own id (an entity made before, kept whatever
        # its format) and the one it would mint (a urn:uuid it brings, in canonical form).
        held: set = set()
        gone: Dict[str, set] = {}
        if scope is not None:
            gone = await self._deleted_by(s, graph_id, main_id, NodeVersionORM, ("urn",),
                                          {k for k in keys.values() if k and k not in known})
            held = await self._heads_present(s, graph_id, main_id, {
                v for i, r in node_rows if keys[i] not in known
                for v in (r.get("entity_id"), r.get("id"), _derived_node_id(scope, r)) if v})
        urn_to_eid: Dict[str, str] = {}
        for i, row in node_rows:
            if not row.get("entityType"):
                rejected.append({"row": i, "reason": "node missing entityType"})
                continue
            urn = row.get("urn")
            hit = known.get(keys[i]) if keys[i] else None
            payload = _sanitize_node_properties(
                {k: v for k, v in row.items() if k not in ("kind", "id", "entity_id")})
            given = row.get("entity_id") or row.get("id")
            named = next((v for v in (given, uuid_urn(given)) if v and v in held), None)
            if hit or scope is None:
                # A new node is named by its urn, as the bootstrap names every node; an earlier
                # sync's ``sync:<urn>`` is found by its urn (``known``) and kept.
                eid = (hit[0] if hit else None) or given or urn
            elif named:                        # an entity it names by the id it has
                eid = named
            elif not urn and keys[i] in held:  # the node it made, whatever urn it carries now
                eid = keys[i]
            else:
                eid = _id_to_take(_derived_node_id(scope, row), gone.get(keys[i]) or set(), held)
            # A node with no urn carries the id its row derives, which finds it next time; one the
            # row names by an id from before is taken as the row comes, as it always was.
            if scope is not None and not urn and (hit or not named):
                payload["urn"] = keys[i] or eid
            if not eid:                        # neither a urn nor an id: a urn:uuid for both
                eid = new_entity_id()
                payload["urn"] = eid
            seen.add(eid)
            if urn:
                urn_to_eid[urn] = eid
            for own in (row.get("entity_id"), row.get("id")):     # the row's own names, in any case
                for name in (own, uuid_urn(own)):
                    if name:
                        urn_to_eid[name] = eid
            urn_to_eid[eid] = eid
            if hit and not hit[2] and hit[1] == _ch(payload):
                continue                       # identical to what we hold → cannot produce a delta
            theirs[eid] = payload

        # ── edges ────────────────────────────────────────────────────────────
        edge_rows = [(i, r) for i, r in enumerate(rows) if (r or {}).get("kind") == "edge"]
        # Endpoints the node pass did not resolve (an edge may reference a node the snapshot
        # doesn't re-send). Batch-look those up rather than indexing the whole graph.
        need = {u for _, r in edge_rows for u in (r.get("source"), r.get("target"))
                if u and u not in urn_to_eid}
        for urn, hit in (await self._heads_by_urn(s, graph_id, main_id, list(need))).items():
            urn_to_eid[urn] = hit[0]

        triples = []
        for _, r in edge_rows:
            se, te = urn_to_eid.get(r.get("source")), urn_to_eid.get(r.get("target"))
            if se and te and r.get("edgeType"):
                triples.append((se, te, r["edgeType"]))
        by_triple = await self._heads_by_edge_triple(s, graph_id, main_id, triples)
        held = set()
        gone = {}
        if scope is not None:
            minted = {}                        # row → the id it would mint, if main lacks it
            for i, r in edge_rows:
                se, te, et = urn_to_eid.get(r.get("source")), urn_to_eid.get(r.get("target")), r.get("edgeType")
                if se and te and et and (se, te, et) not in by_triple:
                    minted[i] = _derived_edge_id(scope, r, se, te, et)
            held = await self._heads_present(s, graph_id, main_id, {
                v for i, r in edge_rows if i in minted
                for v in (r.get("entity_id"), r.get("id"), minted[i]) if v})
            # The deleted edges that last joined those ends with that type.
            gone = await self._deleted_by(
                s, graph_id, main_id, EdgeVersionORM, ("source_entity_id", "target_entity_id", "edge_type"),
                {t for t in triples if t not in by_triple})

        for i, row in edge_rows:
            et, src, tgt = row.get("edgeType"), row.get("source"), row.get("target")
            if not (et and src and tgt):
                rejected.append({"row": i, "reason": "edge missing edgeType/source/target"})
                continue
            seid, teid = urn_to_eid.get(src), urn_to_eid.get(tgt)
            if not (seid and teid):
                rejected.append({"row": i, "reason": "edge endpoint not found"})
                continue
            hit = by_triple.get((seid, teid, et))
            given = row.get("entity_id") or row.get("id")
            named = next((v for v in (given, uuid_urn(given)) if v and v in held), None)
            if hit or scope is None:
                eid = (hit[0] if hit else None) or given or f"sync:e:{seid}->{teid}:{et}"
            elif named:                        # an edge it names by the id it has
                eid = named
            else:
                eid = _id_to_take(_derived_edge_id(scope, row, seid, teid, et),
                                  gone.get((seid, teid, et)) or set(), held)
            payload = edge_payload_from_parts(edge_type=et, source_entity_id=seid,
                                              target_entity_id=teid, row=row)
            seen.add(eid)
            if hit and not hit[2] and hit[1] == _ch(payload):
                continue
            theirs[eid] = payload

        return theirs, seen, rejected

    async def resolve_identities(self, *, graph_id: str, identifier: str,
                                 values: Sequence[str]) -> List[Dict[str, object]]:
        """What each of ``values`` names on ``main``, as an import naming ``identifier`` finds a
        row's entity (doc 08 §3b), without importing anything: ``{value, status, entityId}`` with
        ``status`` ``found``, ``none`` or ``duplicate`` (``entityIds``: the live nodes holding it).
        ``entity_id``: a live entity of that id. ``urn``: the live nodes whose urn it is, else the
        live node an import derived from it. On a fork both read its main as an import into it
        does: its own rows, then its parent's at the fork point. ``prop.<name>``: the live nodes
        holding it, by the property's index (:mod:`.import_export.keys`), caught up first;
        ``NotIndexed`` before an import has built it, ``NotOnAFork`` on a fork. Values compare as
        an import's keys do (trimmed text)."""
        from .import_export import keys as matching
        from .import_export.resolve import key_value, pointer_id, pointer_seed
        asked = {v: key_value(v) for v in values}
        wanted = sorted({k for k in asked.values() if k})
        holders: Dict[str, set] = {}
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)

            # Main as a read composes it: on a fork, its own rows, then its parent's at the fork point.
            async def live(ids):
                state = await self._current_skeletons(s, graph_id, main_id, set(ids))
                return {e for e, skeleton in state.items() if skeleton is not None}

            if identifier == "entity_id":
                found = await live(wanted)
                holders = {v: {v} for v in wanted if v in found}
            elif identifier == "urn":
                carried = await self._holders_by_urn(s, graph_id, main_id, set(wanted))
                state = await self._current_skeletons(
                    s, graph_id, main_id, {e for ids in carried.values() for e in ids})
                for urn, ids in carried.items():
                    on = {e for e in ids if (state.get(e) or {}).get("urn") == urn}
                    if on:
                        holders[urn] = on
                rest = [v for v in wanted if v not in holders]
                if rest:
                    scope = await self.identity_scope(graph_id)
                    derived = {pointer_id(scope, pointer_seed(v)): v for v in rest}
                    for eid in await live(derived):
                        holders[derived[eid]] = {eid}
            else:
                name = identifier[len("prop."):]
                await matching.ensure_ready(graph_id, name)
                for v, held in (await matching.lookup(graph_id, name, wanted)).items():
                    on = {e for e, is_live in held if is_live}
                    if on:
                        holders[v] = on
        out: List[Dict[str, object]] = []
        for v, k in asked.items():
            ids = sorted(holders.get(k, ())) if k else []
            status = "found" if len(ids) == 1 else "duplicate" if ids else "none"
            out.append({"value": v, "status": status, "entityId": ids[0] if len(ids) == 1 else None,
                        **({"entityIds": ids} if len(ids) > 1 else {})})
        return out

    async def _heads_present(self, s, graph_id: str, main_id: str, ids) -> set:
        """Those of ``ids`` main holds a head of, live or deleted. O(ids), by primary key."""
        out: set = set()
        for chunk in _chunks([i for i in dict.fromkeys(ids) if i], 5000):
            out.update((await s.execute(select(EntityHeadORM.entity_id).where(
                EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == main_id,
                EntityHeadORM.entity_id.in_(list(chunk))))).scalars())
        return out

    async def _heads_by_urn(self, s, graph_id: str, main_id: str, urns):
        """urn → (entity_id, content_hash, is_tombstone) at main's head. O(urns), via ix_nv_urn."""
        out: Dict[str, tuple] = {}
        uniq = [u for u in dict.fromkeys(urns) if u]
        for chunk in _chunks(uniq, 5000):
            rows = (await s.execute(
                select(NodeVersionORM.urn, EntityHeadORM.entity_id,
                       EntityHeadORM.content_hash, EntityHeadORM.is_tombstone)
                .join(NodeVersionORM,
                      (NodeVersionORM.graph_id == EntityHeadORM.graph_id)
                      & (NodeVersionORM.id == EntityHeadORM.head_version_id))
                .where(EntityHeadORM.graph_id == graph_id,
                       EntityHeadORM.branch_id == main_id,
                       NodeVersionORM.urn.in_(list(chunk)))
            )).all()
            for urn, eid, ch, tomb in rows:
                out[urn] = (eid, ch, bool(tomb))
        return out

    async def _heads_by_edge_triple(self, s, graph_id: str, main_id: str, triples):
        """(source, target, type) → (entity_id, content_hash, is_tombstone). O(triples).

        Edge identity in a sync is the endpoint triple, not a urn — the same keying the old
        `_external_state` used, except that one built the whole index in memory."""
        out: Dict[tuple, tuple] = {}
        uniq = list(dict.fromkeys(triples))
        for chunk in _chunks(uniq, 3000):
            rows = (await s.execute(
                select(EdgeVersionORM.source_entity_id, EdgeVersionORM.target_entity_id,
                       EdgeVersionORM.edge_type, EntityHeadORM.entity_id,
                       EntityHeadORM.content_hash, EntityHeadORM.is_tombstone)
                .join(EdgeVersionORM,
                      (EdgeVersionORM.graph_id == EntityHeadORM.graph_id)
                      & (EdgeVersionORM.id == EntityHeadORM.head_version_id))
                .where(EntityHeadORM.graph_id == graph_id,
                       EntityHeadORM.branch_id == main_id,
                       tuple_(EdgeVersionORM.source_entity_id,
                              EdgeVersionORM.target_entity_id,
                              EdgeVersionORM.edge_type).in_(list(chunk)))
            )).all()
            for se, te, et, eid, ch, tomb in rows:
                out[(se, te, et)] = (eid, ch, bool(tomb))
        return out

    async def _deleted_by(self, s, graph_id: str, main_id: str, model, columns: Sequence[str],
                          keys) -> Dict[Any, set]:
        """key → the entities deleted on main whose last live version held it in ``columns`` (a
        node's urn; an edge's ends and type, as a tuple). A delete's version holds none, so the
        lookups through the head (:meth:`_heads_by_urn`, :meth:`_heads_by_edge_triple`) miss them.
        O(keys): each step seeks by index, its keys bound as arrays — the entities whose rows held
        a key (``ix_nv_urn``; an edge's by both ends, ``ix_ev_source`` and ``ix_ev_target``), those
        of them deleted (by primary key), then their last live versions (``ix_*_entity_hist``) —
        and is planned for its graph and keys each time. The generic plan a prepared statement
        comes to after five runs takes ``graph_id = $1`` for a few rows, so it reads the whole
        graph and tests each row against every key."""
        cols = [getattr(model, c) for c in columns]
        carriers = select(model.entity_id, *cols).where(
            model.graph_id == graph_id, model.branch_id == main_id,
            *(c == any_(bindparam(f"k{n}", type_=ARRAY(Text))) for n, c in enumerate(cols))).distinct()
        last = (select(model.entity_id, *cols)
                .where(model.graph_id == graph_id, model.branch_id == main_id,
                       model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                       model.op != "delete")
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id))

        def key_of(vals):
            return vals[0] if len(vals) == 1 else tuple(vals)

        out: Dict[Any, set] = {}
        keys = list(dict.fromkeys(k for k in keys if k))
        if not keys:
            return out
        was = await s.scalar(text("SELECT current_setting('plan_cache_mode')"))
        await s.execute(_PLAN_CACHE_MODE, {"mode": "force_custom_plan"})     # put back below
        for chunk in _chunks(keys, _IN_LIST_MAX):
            wanted = set(chunk)
            parts = zip(*chunk) if len(cols) > 1 else [chunk]
            carried = {eid for eid, *vals in (await s.execute(
                carriers, {f"k{n}": sorted(set(p)) for n, p in enumerate(parts)})).all()
                if key_of(vals) in wanted}
            deleted = [e for e, live in (await self._heads_live(s, graph_id, main_id, carried)).items()
                       if not live]
            for ids in _chunks(deleted, _IN_LIST_MAX):
                for eid, *vals in (await s.execute(last, {"ids": list(ids)})).all():
                    if key_of(vals) in wanted:
                        out.setdefault(key_of(vals), set()).add(eid)
        await s.execute(_PLAN_CACHE_MODE, {"mode": was})
        return out

    async def _live_ids_absent_from(self, s, graph_id: str, main_id: str, seen: set) -> set:
        """Live entities on main the snapshot no longer mentions — i.e. the DELETIONS.

        Streamed in keyset windows and membership-tested against `seen`, so main's head is never
        held in memory. This is the one thing a bounded sync cannot dodge: absence is only visible
        by looking at everything present and subtracting. Get it wrong and the sync silently stops
        deleting, which is the failure nobody notices until the graph is quietly wrong.
        """
        gone: set = set()
        after = ""
        while True:
            rows = (await s.execute(
                select(EntityHeadORM.entity_id)
                .where(EntityHeadORM.graph_id == graph_id,
                       EntityHeadORM.branch_id == main_id,
                       EntityHeadORM.is_tombstone.is_(False),
                       EntityHeadORM.entity_id > after)
                .order_by(EntityHeadORM.entity_id)
                .limit(20000)
            )).all()
            if not rows:
                return gone
            for (eid,) in rows:
                if eid not in seen:
                    gone.add(eid)
            after = rows[-1][0]

    @staticmethod
    def _external_state(rows, ours: Mapping[str, Optional[dict]]):
        """Parse external rows into a desired ``{entity_id: payload}`` state, matching
        each row to an EXISTING main entity so a re-sync updates in place rather than
        duplicating: nodes by ``urn``, edges by ``(source, target, edgeType)``. New
        external entities get a stable id. Returns ``(state, rejected)``."""
        urn_index: Dict[str, str] = {}
        edge_index: Dict[tuple, str] = {}
        for eid, p in ours.items():
            if p is None:
                continue
            if _is_edge_payload(p):
                edge_index[(p.get("sourceEntityId"), p.get("targetEntityId"), p.get("edgeType"))] = eid
            elif p.get("urn"):
                urn_index[p["urn"]] = eid

        theirs: Dict[str, dict] = {}
        rejected: List[dict] = []
        urn_to_eid: Dict[str, str] = {}
        for i, row in enumerate(rows):
            if (row or {}).get("kind") != "node":
                continue
            if not row.get("entityType"):
                rejected.append({"row": i, "reason": "node missing entityType"})
                continue
            urn = row.get("urn")
            eid = (urn_index.get(urn) or row.get("entity_id") or row.get("id")
                   or (f"sync:{urn}" if urn else new_entity_id()))
            payload = _sanitize_node_properties(
                {k: v for k, v in row.items() if k not in ("kind", "id", "entity_id")})
            theirs[eid] = payload
            if urn:
                urn_to_eid[urn] = eid
            if row.get("id"):
                urn_to_eid[row["id"]] = eid
            urn_to_eid[eid] = eid

        for i, row in enumerate(rows):
            if (row or {}).get("kind") != "edge":
                continue
            et, src, tgt = row.get("edgeType"), row.get("source"), row.get("target")
            if not (et and src and tgt):
                rejected.append({"row": i, "reason": "edge missing edgeType/source/target"})
                continue
            seid = urn_to_eid.get(src) or urn_index.get(src)
            teid = urn_to_eid.get(tgt) or urn_index.get(tgt)
            if not (seid and teid):
                rejected.append({"row": i, "reason": "edge endpoint not found"})
                continue
            eid = (edge_index.get((seid, teid, et)) or row.get("entity_id")
                   or row.get("id") or f"sync:e:{seid}->{teid}:{et}")
            payload = edge_payload_from_parts(edge_type=et, source_entity_id=seid,
                                              target_entity_id=teid, row=row)
            theirs[eid] = payload
        return theirs, rejected

    async def _retry_seq(self, label: str, fn):
        """Run ``fn`` — an async thunk that opens its OWN session, RE-FETCHES state, and
        commits — retrying with bounded, full-jitter backoff when it lost to a concurrent
        writer: a ``commit_seq`` unique-constraint collision, a head CAS miss, or a lock not
        granted within ``GRAPH_LOCK_TIMEOUT_MS`` (:class:`LockBusy`). Because the whole body
        re-runs on each attempt, the write is always recomputed against the current head: this
        fixes both the crash (unhandled ``IntegrityError``) AND the read-stale-then-write race
        where a merge computed against a stale ``main`` would otherwise silently drop
        intervening edits. Raises :class:`ContentionExhausted` (503, retryable) when every
        attempt lost."""
        for attempt in range(config.COMMIT_MAX_RETRIES):
            try:
                return await fn()
            except (IntegrityError, _StaleHead, LockBusy) as exc:
                if isinstance(exc, ContentionExhausted):   # an inner retry gave up: not again
                    raise
                # Only a unique-key race is "the branch moved": any other integrity error (a
                # check or a not-null) fails the same way every time, and re-running a large
                # import window or publish for it only multiplies the work.
                state = getattr(getattr(exc, "orig", None), "sqlstate", None)
                if isinstance(exc, IntegrityError) and state not in (None, "23505"):
                    raise
                # IntegrityError = commit_seq collision; _StaleHead = per-entity head CAS miss;
                # LockBusy = another writer still holds the lock. All mean "the branch moved (or is
                # moving) under us" — re-run the thunk, which re-reads current state and recomputes
                # (auto-rebase / 3-way merge) against the new head.
                if attempt + 1 >= config.COMMIT_MAX_RETRIES:
                    raise ContentionExhausted(f"{label}: every attempt lost to a concurrent "
                                              "writer; try again") from exc
                # Full jitter: writers that collided once do not collide again in lockstep.
                await asyncio.sleep(random.uniform(0, min(2.0, 0.02 * (2 ** attempt))))

    @staticmethod
    async def _bounded_lock(s, stmt, what: str):
        """Execute the lock-taking ``stmt``, waiting at most ``GRAPH_LOCK_TIMEOUT_MS`` for the
        lock: a wait that runs out (SQLSTATE 55P03) is :class:`LockBusy`, which ``_retry_seq``
        retries. The timeout is ``SET LOCAL`` (``set_config(..., true)``), so it holds for the
        rest of the transaction and ends with it."""
        ms = config.GRAPH_LOCK_TIMEOUT_MS
        await s.execute(_SET_LOCK_TIMEOUT, {"ms": str(ms)})
        try:
            return await s.execute(stmt)
        except DBAPIError as exc:
            if getattr(exc.orig, "sqlstate", None) != "55P03":
                raise
            raise LockBusy(f"{what} is busy with another change; try again shortly",
                           retry_after=max(1, ms // 1000)) from exc

    @staticmethod
    async def _lock_graph(s, graph_id: str) -> None:
        """Serialize same-graph main-advancing writes (publish, merge, revert, restore, sync,
        bulk import, and apply_ops on main) with a transaction-scoped Postgres advisory lock
        (auto-released at commit/rollback). Acquire it BEFORE reading ``main`` head/state so the
        write composes against the current main; different graphs never contend, so this adds no
        cross-graph latency and makes the commit-seq retry converge in ~1 attempt. The wait is
        bounded (:meth:`_bounded_lock`)."""
        await GraphVersioningService._bounded_lock(
            s, select(func.pg_advisory_xact_lock(func.hashtext(graph_id))), f"graph {graph_id}")

    @staticmethod
    async def _lock_lifecycle(s, graph_id: str, *, shared: bool = False) -> None:
        """Take the graph's lifecycle key for the transaction: ``shared`` for a draft writer,
        before :meth:`_assert_writable`; exclusive for a transition (freeze, trash, restore, a purge
        queued), before :meth:`_lock_graph` and the row. Row locks let each new FOR KEY SHARE past a
        waiting FOR UPDATE, so overlapping draft saves could hold a transition off for ever; this
        key's queue is fair, so the saves that ask after a transition wait for it. Main writers do
        not take it: they hold the graph lock, which a transition takes after this key. The wait is
        bounded (:meth:`_bounded_lock`)."""
        take = func.pg_advisory_xact_lock_shared if shared else func.pg_advisory_xact_lock
        await GraphVersioningService._bounded_lock(
            s, select(take(func.hashtext(f"gvlifecycle:{graph_id}"))), f"graph {graph_id}")

    @staticmethod
    async def _lock_move(s, graph_id: str, *, shared: bool = False) -> None:
        """The lock a move of the graph's data source holds (exclusive, after :meth:`_lock_graph`)
        and a job's creation takes ``shared``: jobs fence against a move without waiting on main
        writers or on each other. The wait is bounded (:meth:`_bounded_lock`)."""
        lock = func.pg_advisory_xact_lock_shared if shared else func.pg_advisory_xact_lock
        await GraphVersioningService._bounded_lock(
            s, select(lock(func.hashtext(f"gvmove:{graph_id}"))), f"graph {graph_id}")

    @staticmethod
    async def _lock_branch(s, graph_id: str, branch_id: str) -> BranchORM:
        """Take a branch's row lock for the transaction and return the row as committed. Every
        writer of one draft (apply_ops, stage, checkpoint, pull, claim, abandon) serializes here,
        so a writer that waited sees what the holder committed, a closed status included. FOR NO
        KEY UPDATE: inserts that reference the branch (its members) do not wait on it. Scoped to
        the graph, so another graph's draft is unknown here. The wait is bounded
        (:meth:`_bounded_lock`)."""
        branch = (await GraphVersioningService._bounded_lock(
            s,
            select(BranchORM).where(BranchORM.id == branch_id, BranchORM.graph_id == graph_id)
            .with_for_update(key_share=True).execution_options(populate_existing=True),
            f"draft {branch_id}",
        )).scalar_one_or_none()
        if branch is None:
            raise ValueError("unknown branch")
        return branch

    async def apply_ops(
        self, *, graph_id: str, ops: Sequence[Mapping], actor: str,
        message: str = "edit", branch_id: Optional[str] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        on_commit: Optional[Callable[[Any], Awaitable[None]]] = None,
        allow_main: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        from_client: bool = False,
    ) -> Optional[str]:
        """Apply create/update/delete ops as ONE audited commit (default on ``main``) —
        the 'versioned write' primitive behind provider write-through, so an ordinary
        graph write becomes a durable, attributed commit without a draft round-trip.
        Each op is ``{op, entity_kind, entity_id, payload}``. Returns the commit id, or
        ``None`` if the ops are a no-op against current state.

        Cost is **O(ops)**, not O(graph): it resolves only the affected entities' current
        values (``_current_values``), cascades node deletes to their live incident edges
        via a bounded degree query (``_incident_live_edges``), and checks referential
        integrity only for the edges this commit writes — never composing full state.

        Concurrent writers to the same branch race for the next ``commit_seq``; on the
        unique-constraint collision this retries (bounded backoff) before giving up with
        :class:`ContentionExhausted`. Under ``strict`` ontology enforcement the written
        entities are validated (the write-through gate, parity with publish/stage).

        ``on_commit(session)``, when given, is awaited at the end of the batch's transaction, in
        its session — after the commit is written, or when the ops turn out to change nothing —
        so what the caller records with it lands or rolls back WITH the batch: an import window's
        row resolutions and its job checkpoint. A retry re-runs it with the batch; anything it
        raises rolls the batch back and propagates.

        A ``branch_id`` that names main (its id or ``'main'``) raises :class:`MainWriteForbidden`
        unless ``allow_main``: a caller that writes drafts must never be handed main. A draft that
        is not open raises :class:`BranchNotOpen`, and someone else's private draft
        :class:`NotDraftOwner`.

        ``node_identity``, the data source's resolved mapping, keeps each written node's own
        name and identity properties in step with its ``displayName`` / ``urn``
        (``node_identity.bind_node_write``); a node create op marked ``minted`` had its urn
        minted for this write. ``None`` binds nothing.

        ``from_client``: the ops are a client's — the canvas, the graph API — which names a node
        by its urn. An op id, a move's parent or an edge's end that is no entity id but the urn of
        one live node is resolved to that node (a create, to the one deleted node holding it: a
        restore); a urn several live nodes carry is refused (:class:`AmbiguousUrn`). A create
        never replaces a live entity (:class:`EntityExists`), and an edge create needs both ends
        (:class:`EdgeEndsMissing`). An import and the system's own writes leave it off.
        """
        result = await self.apply_ops_detailed(
            graph_id=graph_id, ops=ops, actor=actor, message=message, branch_id=branch_id,
            containment_edge_types=containment_edge_types, ontology_rules=ontology_rules,
            on_commit=on_commit, allow_main=allow_main, node_identity=node_identity,
            from_client=from_client)
        return result.commit_id

    async def apply_ops_detailed(
        self, *, graph_id: str, ops: Sequence[Mapping], actor: str,
        message: str = "edit", branch_id: Optional[str] = None,
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        on_commit: Optional[Callable[[Any], Awaitable[None]]] = None,
        allow_main: bool = False,
        idempotency_key: Optional[str] = None,
        aim_edges: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        from_client: bool = False,
    ) -> ApplyResult:
        """:meth:`apply_ops`, answering with every addressed entity's value after the batch.

        With ``idempotency_key``, a batch whose commit on the branch already carries the key is
        not applied again: the answer is that commit, with the addressed entities' current values.
        A replay runs no ``on_commit``, so the two never go together.

        ``aim_edges``: each edge update or delete goes to the edge its id names on the branch
        (:meth:`resolve_edges`), once the branch has been found writable by ``actor`` and a
        retry answered; an id that names only an item is refused (:class:`NotAnEdge`)."""
        assert not (idempotency_key and on_commit), "a replay would skip on_commit"
        return await self._retry_seq(
            f"apply_ops on {graph_id}/{branch_id or 'main'}",
            lambda: self._apply_ops_once(
                graph_id=graph_id, ops=ops, actor=actor, message=message,
                branch_id=branch_id, containment_edge_types=containment_edge_types,
                ontology_rules=ontology_rules, on_commit=on_commit, allow_main=allow_main,
                idempotency_key=idempotency_key, aim_edges=aim_edges,
                node_identity=node_identity, from_client=from_client),
        )

    async def _apply_ops_once(
        self, *, graph_id: str, ops: Sequence[Mapping], actor: str,
        message: str, branch_id: Optional[str],
        containment_edge_types: Optional[Sequence[str]] = None,
        ontology_rules: Optional[OntologyRules] = None,
        on_commit: Optional[Callable[[Any], Awaitable[None]]] = None,
        allow_main: bool = False,
        idempotency_key: Optional[str] = None,
        aim_edges: bool = False,
        node_identity: Optional[ResolvedNodeIdentity] = None,
        from_client: bool = False,
    ) -> ApplyResult:
        async with self._session() as s:
            await self._assert_not_bootstrapping(s, graph_id)
            graph = await s.get(GraphORM, graph_id)
            if graph is None:
                raise ValueError(f"unknown graph {graph_id}")
            main_id = await self._main_branch_id(s, graph_id)
            bid = main_id if branch_id in (None, "main") else branch_id

            # Serialize main-advancing writes on this graph BEFORE reading the head, so a
            # write-through composes against — and advances — the current main atomically
            # (head read → commit → head advance): the same lock publish/merge/revert take,
            # without which a write-through racing a merge reads a stale head and spuriously
            # trips NotUpToDate / flaps the projection target. The graph row was loaded before
            # the lock, and the holder may have moved main since: re-read it, or every read of
            # main below (values, skeletons, cascades) is at the old head. A draft write takes
            # the draft's row lock instead, then checks the draft is still open: its writers
            # serialize, and none lands on a merged or abandoned draft. Both are xact-scoped, so
            # _retry_seq re-takes them on each fresh-session attempt. The graph's row is checked in
            # between (after the graph lock, before the draft's); a refusal waits for the replay.
            if bid == main_id:
                if branch_id is not None and not allow_main:
                    raise MainWriteForbidden()
                await self._lock_graph(s, graph_id)
                await s.refresh(graph)
            else:
                await self._lock_lifecycle(s, graph_id, shared=True)
            refusal = None
            try:
                await self._assert_writable(s, graph_id)
            except GraphNotWritable as exc:
                refusal = exc
            branch = (await s.get(BranchORM, bid) if bid == main_id
                      else await self._lock_branch(s, graph_id, bid))

            # A retry of a save that already landed answers with its commit. After the lock, so a
            # retry racing its first attempt waits for it and then finds it (uq_commits_idem, which
            # _retry_seq retries on, is the backstop); before the open check, so a save that
            # landed on a draft closed since still reports what it did.
            if idempotency_key:
                prior = await s.scalar(select(CommitORM.id).where(
                    CommitORM.graph_id == graph_id, CommitORM.branch_id == bid,
                    CommitORM.idempotency_key == idempotency_key))
                if prior is not None:
                    if aim_edges:                  # at the edges that save wrote, as it aimed them
                        ops = await self._aimed_as_written(s, graph_id, prior, ops)
                    names: Dict[str, str] = {}
                    if from_client:                # at the nodes that save wrote, as it named them
                        ops, names = await self._by_entity_id(s, graph_id, bid, ops, written_by=prior)
                    kinds = {o["entity_id"]: o.get("entity_kind", "node") for o in ops}
                    cur = await self._current_values(s, graph_id, bid, list(kinds))
                    return ApplyResult(
                        prior, {eid: (k, cur.get(eid)) for eid, k in kinds.items()},
                        {eid: (v.get("urn") or eid) for eid, v in cur.items()
                         if v is not None and not _is_edge_payload(v)}, names)
            if refusal is not None:
                raise refusal
            if bid != main_id:
                self._require_open(branch)
                await self._require_edit(s, branch, actor, ())
            if aim_edges:
                ops = await self._aimed(s, graph_id, bid, ops)
            names = {}
            if from_client:
                # Inside the lock and after the open/edit checks: the names resolve against what
                # this batch composes on, on every retry, and never read a draft the actor can't
                # edit. Before the moves expand and the fold, which key on entity ids.
                ops, names = await self._by_entity_id(s, graph_id, bid, ops)
                _refuse_bad_creates(ops)

            ops = await self._expand_moves(s, graph_id, bid, ops, containment_edge_types)

            # Resolve ops → new payloads for the AFFECTED entities only. Several ops on ONE
            # entity in one batch COMPOSE, in order: an update after a create (a node renamed
            # before its first save) patches the create's payload, and two updates become one
            # patch that keeps BOTH updates' property removals (applying the first onto the
            # second dropped the first's removal). Replacing instead stored a renamed new node
            # as {displayName} alone — no type, no urn — which then failed every read of the draft.
            fold = fold_batch_ops(
                ops, is_edge_payload=_is_edge_payload, sanitize_node=_sanitize_node_properties)
            new_vals: Dict[str, Optional[dict]] = fold.new_vals
            kind_by_entity: Dict[str, str] = fold.kind_by_entity
            update_ids: set = fold.update_ids
            base_versions: Dict[str, str] = fold.base_versions   # entity_id → client's OCC token

            # Prior values of just the affected entities (bounded; base+overlay for a draft).
            cur_vals = await self._current_values(s, graph_id, bid, list(new_vals))
            if from_client:
                # A create that holds a live entity's id would replace it whole (the fold reads a
                # create as a full replace) or turn an edge into a node. A deleted one's is a
                # restore. One the batch deleted first is a replace the client asked for.
                first: Dict[str, str] = {}
                for o in ops:
                    first.setdefault(o["entity_id"], o.get("op", "update"))
                taken = [eid for eid, op in first.items()
                         if op == "create" and cur_vals.get(eid) is not None]
                if taken:
                    raise EntityExists(taken, names)

            # An `update` is a field-level PATCH onto the entity's current value (a version row stores
            # the FULL payload, composed last-writer-wins per ENTITY), preserving fields the op didn't
            # mention. When the op carries a `base_version` (the content_hash the client edited FROM),
            # enforce OPTIMISTIC CONCURRENCY: 3-way merge (base, base⊕patch, current_head) so two users
            # editing the SAME field concurrently CONFLICT instead of one silently overwriting the
            # other; disjoint fields still auto-merge. No / unresolvable token ⇒ plain PATCH-onto-current
            # (backward-compatible — provider write-through and full-payload callers are unaffected).
            base_payloads = (await self._payloads_by_content_hash(
                s, graph_id, base_versions, kind_by_entity) if base_versions else {})
            occ_conflicts: List[dict] = []
            occ_set_fields = frozenset(config.SET_FIELDS)
            for eid in update_ids:
                patch = new_vals.get(eid)
                if patch is None:
                    continue
                cur = cur_vals.get(eid)
                base = base_payloads.get(eid)
                if base is not None and cur is not None:
                    out = three_way_merge(base, self._patch_payload(base, patch), cur, occ_set_fields)
                    new_vals[eid] = out.merged
                    for cf in out.conflicts:
                        occ_conflicts.append({
                            "entity_id": eid, "entity_kind": kind_by_entity.get(eid, "node"),
                            "path": list(cf.path), "base": cf.base,
                            "ours": cf.ours, "theirs": cf.theirs, "kind": cf.kind})
                else:
                    new_vals[eid] = self._patch_payload(cur, patch)
            if occ_conflicts:
                # Each conflicting entity's CURRENT value rides along, so the client can rebase the
                # user's edit onto it without another read.
                raise MergeConflict(_with_refs(occ_conflicts, names), current={
                    c["entity_id"]: (c["entity_kind"], cur_vals.get(c["entity_id"]))
                    for c in occ_conflicts})

            # Each node's own name / identity properties, kept in step with what this batch writes.
            # Judged on the composed, merged values against their priors — after the OCC merge, so
            # a mirrored value is never "ours" in it and a conflict only names fields the caller sent.
            if node_identity is not None:
                new_vals.update(bind_node_writes(
                    new_vals, cur_vals, kind_by_entity=kind_by_entity, identity=node_identity,
                    created={e for e in new_vals if e not in update_ids},
                    minted={o["entity_id"] for o in ops if o.get("minted")}))

            # Cascade a node delete to its containment subtree (ontology-driven) AND every
            # live edge incident to any deleted node (source or target, ANY type) — so no
            # descendant is orphaned and no edge dangles. One commit ⇒ the cascade is atomic.
            deleted_nodes = {eid for eid, v in new_vals.items()
                             if v is None and kind_by_entity.get(eid) == "node"}
            if deleted_nodes:
                subtree, inc_edges = await self._cascade_deletes(
                    s, graph_id, bid, deleted_nodes, containment_edge_types, overlay=new_vals)
                new_desc = [d for d in subtree if d not in new_vals]
                if new_desc:
                    desc_vals = await self._current_values(s, graph_id, bid, new_desc)
                    for d in new_desc:
                        if desc_vals.get(d) is not None:        # a live descendant node
                            new_vals[d] = None
                            cur_vals[d] = desc_vals[d]
                            kind_by_entity[d] = "node"
                for d in subtree:                                # a descendant edited in this save
                    new_vals[d] = None                           # goes too (its prior is known)
                for eid, payload in inc_edges.items():           # all incident edges, any type
                    if eid not in new_vals:                      # stored, untouched: prior = stored
                        cur_vals.setdefault(eid, payload)
                    new_vals[eid] = None                         # incl. ones drawn in this save
                    kind_by_entity[eid] = "edge"

            # Referential integrity (bounded): every edge written here must have live
            # endpoints in the resulting state. Resolve only unknown endpoints.
            endpoints: set = set()
            for v in new_vals.values():
                if v is None:
                    continue
                src = v.get("sourceEntityId") or v.get("source_entity_id")
                tgt = v.get("targetEntityId") or v.get("target_entity_id")
                if src is not None or tgt is not None:
                    endpoints.update((src, tgt))
            endpoints.discard(None)
            unknown = [e for e in endpoints if e not in new_vals and e not in cur_vals]
            if unknown:
                # Liveness, urn and type are all the endpoints are read for — never their payloads
                # (an import edge window's endpoints are ~100k nodes).
                cur_vals.update(await self._current_skeletons(s, graph_id, bid, unknown))

            def _live(eid) -> bool:
                return (new_vals[eid] if eid in new_vals else cur_vals.get(eid)) is not None

            for eid, v in new_vals.items():
                if v is None:
                    continue
                src = v.get("sourceEntityId") or v.get("source_entity_id")
                tgt = v.get("targetEntityId") or v.get("target_entity_id")
                if src is None and tgt is None:
                    continue                                   # a node
                if not _live(src) or not _live(tgt):
                    raise ConcurrencyError(f"edge {eid} would dangle: {src}->{tgt}")

            # Untyped creations, hierarchy integrity and the ontology — judged on what is WRITTEN
            # (a patch of nothing is a creation; a retype or a re-pointed edge is judged in full).
            try:
                await self._enforce_written(
                    s, graph_id, bid, new_vals, cur_vals, kind_by_entity,
                    containment_edge_types=containment_edge_types or [],
                    ontology_rules=ontology_rules,
                    strict=graph.ontology_enforcement == "strict",
                    edited=update_ids)
            except OntologyViolation as exc:            # in the names the batch was sent in
                _with_refs(exc.violations, names)
                raise

            ontology = Ontology.from_spec(graph.ontology_spec)   # write-through ontology gate
            if ontology is not None and graph.ontology_enforcement == "strict":
                viol = validate_entities(
                    [(eid, kind_by_entity.get(eid, "node"), v)
                     for eid, v in new_vals.items() if v is not None], ontology)
                if viol:
                    raise OntologyViolation(_with_refs(viol, names))

            # Canonicalize entity/edge-type casing to the ontology's declared spelling before
            # the delta is content-hashed and written, so a write-through (or the repair script)
            # that carries a case variant lands canonical rows — the case-sensitive FalkorDB
            # projection then matches the containment predicate. Ungated by enforcement mode:
            # normalization is always safe (a case variant is never a violation).
            if ontology_rules is not None:
                for v in new_vals.values():
                    canonicalize_payload_types(v, ontology_rules)

            written = {eid: (kind_by_entity.get(eid, "node"), v) for eid, v in new_vals.items()}
            urns = {eid: (v.get("urn") or eid) for eid, v in {**cur_vals, **new_vals}.items()
                    if v is not None and not _is_edge_payload(v)}
            deltas = net_delta({k: cur_vals.get(k) for k in new_vals}, new_vals)
            if not deltas:
                if on_commit is not None:
                    await on_commit(s)
                return ApplyResult(None, written, urns, names)
            for d in deltas:
                kind_by_entity.setdefault(
                    d.entity_id, "edge" if _is_edge_payload(cur_vals.get(d.entity_id) or {}) else "node")

            last = await s.scalar(select(CommitORM.commit_seq).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == bid,
            ).order_by(CommitORM.commit_seq.desc()).limit(1)) or 0
            new_seq = last + 1
            commit = CommitORM(
                graph_id=graph_id, branch_id=bid, commit_seq=new_seq,
                parent_commit_id=branch.head_commit_id, kind="edit",
                message=message, actor=actor, **commit_provenance(actor),
                # Attribute to the draft's view (NULL on main write-throughs) so the
                # per-view history filter sees interactive canvas saves too.
                originating_view_id=branch.originating_view_id,
                idempotency_key=idempotency_key,
            )
            s.add(commit)
            await s.flush()
            await self._write_deltas(s, graph_id, bid, commit, deltas, kind_by_entity, actor,
                                     occ_guard=True)
            branch.head_commit_id = commit.id
            commit.merkle_root = await self._commit_merkle(s, graph_id, bid, commit, deltas)
            commit.stats = _delta_stats(deltas)
            graph.updated_at = _now()
            if branch.kind == "main":
                graph.main_head_commit_seq = new_seq
                main_activity.note(s, graph, commit)
                ps = await s.get(ProjectionStateORM, graph_id)
                if ps is not None:
                    ps.target_commit_seq = new_seq
            if on_commit is not None:
                # The commit's pending ORM writes first, so the hook's (a job-row checkpoint) is
                # the last statement and holds that row's lock only until the commit.
                await s.flush()
                await on_commit(s)
            return ApplyResult(commit.id, written, urns, names)

    async def _bulk_insert_versions(self, s, graph_id, branch_id, commit, node_deltas, edge_deltas, actor) -> None:
        """Chunked multi-row INSERTs into the version tables + a bulk head upsert
        (the COPY-style bulk path; never one INSERT per row)."""
        now = _now()
        head_rows: List[dict] = []
        node_dicts: List[dict] = []
        for d in node_deltas:
            vid = prefixed_id("nv"); p = d.payload or {}
            node_dicts.append(dict(
                graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                commit_seq=commit.commit_seq, branch_id=branch_id, op="create",
                content_hash=d.content_hash, prev_content_hash=None, payload=d.payload,
                actor=actor, created_at=now, urn=p.get("urn"), entity_type=p.get("entityType"),
                display_name=p.get("displayName"), qualified_name=p.get("qualifiedName"),
            ))
            head_rows.append(dict(graph_id=graph_id, branch_id=branch_id, entity_id=d.entity_id,
                                  entity_kind="node", head_version_id=vid, content_hash=d.content_hash,
                                  is_tombstone=False, updated_at=now))
        edge_dicts: List[dict] = []
        for d in edge_deltas:
            vid = prefixed_id("ev"); p = d.payload or {}
            edge_dicts.append(dict(
                graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                commit_seq=commit.commit_seq, branch_id=branch_id, op="create",
                content_hash=d.content_hash, prev_content_hash=None, payload=d.payload,
                actor=actor, created_at=now,
                source_entity_id=p.get("sourceEntityId") or "", target_entity_id=p.get("targetEntityId") or "",
                edge_type=p.get("edgeType"), confidence=p.get("confidence"), discriminator=p.get("discriminator"),
            ))
            head_rows.append(dict(graph_id=graph_id, branch_id=branch_id, entity_id=d.entity_id,
                                  entity_kind="edge", head_version_id=vid, content_hash=d.content_hash,
                                  is_tombstone=False, updated_at=now))
        # PostgreSQL caps bind parameters at 65535 PER statement. A multi-row INSERT
        # uses rows × columns params, so chunking purely by row count (e.g. 5000 rows ×
        # 17 edge columns = 85k) overflows it. Size each batch by the column count so a
        # large bootstrap commit (thousands of nodes/edges) stays under the cap.
        for batch in _chunks(node_dicts, _rows_per_insert(node_dicts)):
            await s.execute(pg_insert(NodeVersionORM).values(batch))
        for batch in _chunks(edge_dicts, _rows_per_insert(edge_dicts)):
            await s.execute(pg_insert(EdgeVersionORM).values(batch))
        for batch in _chunks(head_rows, _rows_per_insert(head_rows)):
            stmt = pg_insert(EntityHeadORM).values(batch)
            await s.execute(stmt.on_conflict_do_update(
                index_elements=["graph_id", "branch_id", "entity_id"],
                set_={"head_version_id": stmt.excluded.head_version_id,
                      "content_hash": stmt.excluded.content_hash,
                      "is_tombstone": stmt.excluded.is_tombstone,
                      "entity_kind": stmt.excluded.entity_kind,
                      "updated_at": stmt.excluded.updated_at},
            ))

    @staticmethod
    def _patch_payload(base: Optional[dict], patch: dict) -> dict:
        """Apply a partial update `patch` onto `base` (see ``backend.common.property_patch``):
        top-level fields override, ``properties`` is merged key by key, and a property marked
        for removal (``unsetProperties`` on the wire, or an import's ``\\N``) is removed."""
        return apply_patch(base, patch)

    @staticmethod
    def _compose_patches(first: dict, second: dict) -> dict:
        """Two partial updates of ONE entity in one batch, as the one patch they make in order
        (see ``backend.common.property_patch.compose_patches``): a removal stays a removal until
        it meets the stored value."""
        return compose_patches(first, second)

    async def _payloads_by_content_hash(
        self, s, graph_id: str, eid_to_token: Mapping[str, str], kind_by_entity: Mapping[str, str]
    ) -> Dict[str, dict]:
        """Resolve each entity's payload at the version whose ``content_hash`` == the client's
        echoed OCC token — the base the client edited from. Bounded point-lookups via
        ``ix_nv_content_hash``/``ix_ev_content_hash``; a token with no matching row (squashed /
        GC'd / cross-graph) is simply absent (OCC degrades to a plain patch for that entity)."""
        out: Dict[str, dict] = {}
        node_ids = [e for e in eid_to_token if kind_by_entity.get(e) != "edge"]
        edge_ids = [e for e in eid_to_token if kind_by_entity.get(e) == "edge"]
        for model, ids in ((NodeVersionORM, node_ids), (EdgeVersionORM, edge_ids)):
            if not ids:
                continue
            tokens = list({eid_to_token[e] for e in ids})
            for chunk in _chunks(ids, _IN_LIST_MAX):
                rows = (await s.execute(
                    select(model.entity_id, model.content_hash, model.payload).where(
                        model.graph_id == graph_id, model.entity_id.in_(chunk),
                        model.content_hash.in_(tokens))
                )).all()
                by = {(eid, h): p for eid, h, p in rows}
                for e in chunk:
                    p = by.get((e, eid_to_token[e]))
                    if p is not None:
                        out[e] = p
        return out

    async def _write_deltas(
        self, s, graph_id, branch_id, commit, deltas: List[Delta], kind_by_entity, actor,
        *, occ_guard: bool = False, editors: Optional[Mapping[str, str]] = None,
    ) -> None:
        """Write ``deltas`` as version rows of ``commit`` and move their heads. Each row names
        ``actor`` — or, for an entity in ``editors``, who made that change (a squash: the draft's
        editor, not its publisher)."""
        now = _now()
        editors = editors or {}
        node_rows: List[dict] = []
        edge_rows: List[dict] = []
        heads: List[dict] = []
        for d in deltas:
            kind = kind_by_entity.get(d.entity_id, "node")
            p = d.payload or {}
            if kind == "node":
                vid = prefixed_id("nv")
                node_rows.append(dict(
                    graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                    commit_seq=commit.commit_seq, branch_id=branch_id, op=d.op,
                    content_hash=d.content_hash, prev_content_hash=d.prev_content_hash,
                    payload=d.payload, actor=editors.get(d.entity_id) or actor, change_reason=None,
                    created_at=now, urn=p.get("urn"), entity_type=p.get("entityType"),
                    display_name=p.get("displayName"), qualified_name=p.get("qualifiedName"),
                ))
            else:
                vid = prefixed_id("ev")
                edge_rows.append(dict(
                    graph_id=graph_id, id=vid, entity_id=d.entity_id, commit_id=commit.id,
                    commit_seq=commit.commit_seq, branch_id=branch_id, op=d.op,
                    content_hash=d.content_hash, prev_content_hash=d.prev_content_hash,
                    payload=d.payload, actor=editors.get(d.entity_id) or actor, change_reason=None,
                    created_at=now,
                    source_entity_id=p.get("sourceEntityId") or p.get("source_entity_id") or "",
                    target_entity_id=p.get("targetEntityId") or p.get("target_entity_id") or "",
                    edge_type=p.get("edgeType"), confidence=p.get("confidence"),
                    discriminator=p.get("discriminator"),
                ))
            heads.append({"entity_id": d.entity_id, "entity_kind": kind, "head_version_id": vid,
                          "content_hash": d.content_hash, "is_tombstone": d.op == "delete",
                          "pre_image": d.prev_content_hash or _HASH_NONE})
        # The version rows, as batched multi-row INSERTs (executemany) rather than an ORM object
        # each: a large commit (an import window) spent most of its time building them.
        if node_rows:
            await s.execute(insert(NodeVersionORM.__table__), node_rows)
        if edge_rows:
            await s.execute(insert(EdgeVersionORM.__table__), edge_rows)
        # Upsert the head pointers (keeps version tables append-only), a batch per statement.
        for i in range(0, len(heads), _HEAD_BATCH):
            await self._upsert_heads(s, graph_id, branch_id, heads[i:i + _HEAD_BATCH], occ_guard)

    async def _upsert_heads(self, s, graph_id, branch_id, heads: List[dict], occ_guard: bool) -> None:
        """Point each entity's head at its new version. ``deltas`` hold one change per entity
        (``net_delta``), so no statement names an entity twice.

        With ``occ_guard`` it is a per-entity compare-and-swap: a head advances ONLY if it is still
        the pre-image this commit read. Under concurrent same-branch writes a stale-read-then-write
        becomes a no-op we detect and retry (``_StaleHead``) — closing the lost-update window
        without a coarse lock. Versions are append-only; the mutable head pointer is the only
        contended resource, and this is its CAS. A create reads the entity as absent, so its
        pre-image is the empty-state hash (content_hash(None)) — which is exactly what a tombstone
        head stores, so a legit delete→re-create (resurrect) MATCHES, while a concurrent LIVE
        create (different hash) correctly misses. Two statements a batch, not one per entity: an
        UPDATE advances the heads still at their pre-image, then an INSERT adds the entities with
        no head yet. An entity advanced by neither lost the race."""
        arrays = {"eids": [h["entity_id"] for h in heads], "vids": [h["head_version_id"] for h in heads],
                  "hashes": [h["content_hash"] for h in heads], "tombs": [h["is_tombstone"] for h in heads],
                  "kinds": [h["entity_kind"] for h in heads]}
        scalars = {"graph_id": graph_id, "branch_id": branch_id, "now": _now()}
        if not occ_guard:
            await s.execute(_UPSERT_HEADS, {**arrays, **scalars})
            return
        advanced = set((await s.execute(
            _ADVANCE_HEADS, {**arrays, **scalars, "pres": [h["pre_image"] for h in heads],
                             "absent": _HASH_NONE, "empty": _HASH_EMPTY})).scalars())
        fresh = [i for i, h in enumerate(heads) if h["entity_id"] not in advanced]
        if fresh:
            rest = {k: [v[i] for i in fresh] for k, v in arrays.items()}
            advanced.update((await s.execute(_ADD_HEADS, {**rest, **scalars})).scalars())
        for h in heads:
            if h["entity_id"] not in advanced:
                raise _StaleHead(h["entity_id"])

    async def _branch_contributors(self, s, graph_id, branch_id) -> List[str]:
        rows = (await s.execute(
            select(CommitORM.actor).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
                CommitORM.actor.is_not(None),
            ).distinct()
        )).scalars().all()
        return sorted(set(rows))

    async def _branch_commit_ids(self, s, graph_id, branch_id) -> List[str]:
        rows = (await s.execute(
            select(CommitORM.id).where(
                CommitORM.graph_id == graph_id, CommitORM.branch_id == branch_id,
            ).order_by(CommitORM.commit_seq)
        )).scalars().all()
        return list(rows)

    async def _state_as_of(self, s, graph_id, branch_id, seq: int) -> Dict[str, Optional[dict]]:
        """Reconstruct a branch's state at ``commit_seq <= seq`` from version rows.

        Copy-on-write fork aware: a fork's ``main`` is seeded from its parent's
        state at the base it read at ``seq`` (:func:`fork_base_at`; recursively, so a
        fork-of-a-fork resolves) before the fork's own divergence is overlaid — no
        parent rows are ever copied.

        Two-phase, O(live state) not O(history): phase 1 picks each entity's WINNING
        version at the seq via a NARROW ``DISTINCT ON`` over ``ix_*_entity_hist``
        (entity_id, version id, op — payloads never enter the sort, and superseded
        versions are never transferred); phase 2 point-fetches payloads by version id
        for the LIVE winners only (deletes skip payload I/O entirely). Replaces the
        full-history replay that loaded every version row ever written.
        """
        state: Dict[str, Optional[dict]] = {}
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            main_id = await self._main_branch_id(s, graph_id)
            if branch_id == main_id:
                parent_main = await self._main_branch_id(s, graph.fork_parent_graph_id)
                state.update(await self._state_as_of(
                    s, graph.fork_parent_graph_id, parent_main, await fork_base_at(s, graph, seq),
                ))
        for model in (NodeVersionORM, EdgeVersionORM):
            winners = (await s.execute(
                select(model.entity_id, model.id, model.op)
                .where(model.graph_id == graph_id, model.branch_id == branch_id,
                       model.commit_seq <= seq)
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id)
            )).all()
            live_vids = [vid for _eid, vid, op in winners if op != "delete"]
            payload_by_vid: Dict[str, dict] = {}
            for chunk in _chunks(live_vids, _IN_LIST_MAX):
                for vid, payload in (await s.execute(
                    select(model.id, model.payload).where(
                        model.graph_id == graph_id, model.id.in_(chunk))
                )).all():
                    payload_by_vid[vid] = payload
            for eid, vid, op in winners:
                state[eid] = None if op == "delete" else payload_by_vid.get(vid)
        return state

    async def _heads_as_of(self, s, graph_id, branch_id, seq) -> Dict[str, Optional[tuple]]:
        """The NARROW form of :meth:`_state_as_of` — the same winners (fork-aware, the same
        ordering), but no payloads: ``entity_id -> None`` (deleted) or a tuple

        * node: ``("node", graph_id, version_id, content_hash, urn, entity_type)``
        * edge: ``("edge", graph_id, version_id, content_hash, edge_type, source_id, target_id)``

        ``graph_id`` is the graph whose rows hold the version (a fork's base lives in its
        parent), for :meth:`_payloads_by_version`. What a reconcile diffs on: a few dozen bytes
        per entity instead of its whole payload, and no JSON to hash."""
        heads: Dict[str, Optional[tuple]] = {}
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            main_id = await self._main_branch_id(s, graph_id)
            if branch_id == main_id:
                parent_main = await self._main_branch_id(s, graph.fork_parent_graph_id)
                heads.update(await self._heads_as_of(
                    s, graph.fork_parent_graph_id, parent_main, await fork_base_at(s, graph, seq)))
        for model, kind in ((NodeVersionORM, "node"), (EdgeVersionORM, "edge")):
            cols = ((model.entity_id, model.id, model.op, model.content_hash,
                     model.urn, model.entity_type) if kind == "node" else
                    (model.entity_id, model.id, model.op, model.content_hash,
                     model.edge_type, model.source_entity_id, model.target_entity_id))
            rows = (await s.execute(
                select(*cols)
                .where(model.graph_id == graph_id, model.branch_id == branch_id,
                       model.commit_seq <= seq)
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id)
            )).all()
            for eid, vid, op, chash, *rest in rows:
                heads[eid] = None if op == "delete" else (kind, graph_id, vid, chash, *rest)
        return heads

    async def _payloads_by_version(self, s, refs) -> Dict[str, dict]:
        """``version_id -> payload`` for ``refs`` = iterable of ``(kind, graph_id, version_id)``
        — the second phase: only for what a reconcile must actually write."""
        grouped: Dict[Tuple[str, str], List[str]] = {}
        for kind, gid, vid in refs:
            grouped.setdefault((kind, gid), []).append(vid)
        out: Dict[str, dict] = {}
        for (kind, gid), vids in grouped.items():
            model = NodeVersionORM if kind == "node" else EdgeVersionORM
            for chunk in _chunks(vids, _IN_LIST_MAX):
                for vid, payload in (await s.execute(
                    select(model.id, model.payload).where(model.graph_id == gid, model.id.in_(chunk))
                )).all():
                    out[vid] = payload
        return out

    async def _changed_in_window(self, s, graph_id, branch_id, from_seq, to_seq) -> set:
        """Entity ids touched by commits in ``(from_seq, to_seq]`` — O(changed),
        index-backed by ``ix_*_branch_changeset`` (a commit writes rows only for
        the entities it changed). A fork's ``main`` adds what its parent's changed between
        the bases it read at either end (:meth:`_parent_window`), up a fork of a fork too."""
        changed: set = set()
        for model in (NodeVersionORM, EdgeVersionORM):
            rows = (await s.execute(
                select(model.entity_id).where(
                    model.graph_id == graph_id, model.branch_id == branch_id,
                    model.commit_seq > from_seq, model.commit_seq <= to_seq,
                ).distinct()
            )).scalars().all()
            changed.update(rows)
        parent = await self._parent_window(s, graph_id, branch_id, from_seq, to_seq)
        if parent is not None:
            changed |= await self._changed_in_window(s, *parent)
        return changed

    async def _parent_window(self, s, graph_id, branch_id, from_seq, to_seq):
        """``(parent graph, its main, lo, hi)`` when ``branch_id`` is a fork's ``main`` whose
        reads at ``from_seq`` and ``to_seq`` compose its parent at different seqs
        (:func:`fork_base_at`), the window of the parent's history between them; else None.

        A window's ends are taken no earlier than the fork point (its first ``fork_seq``): the
        fork's own history starts there, so its genesis commit's window (the seq before it, to it)
        holds nothing of the parent's commit at that seq."""
        graph = await s.get(GraphORM, graph_id)
        if (graph is None or not graph.fork_parent_graph_id
                or branch_id != await self._main_branch_id(s, graph_id)):
            return None
        point = graph.fork_base_commit_seq or 0
        lo, hi = sorted((await fork_base_at(s, graph, max(from_seq, point)),
                         await fork_base_at(s, graph, max(to_seq, point))))
        if lo == hi:
            return None
        parent_id = graph.fork_parent_graph_id
        return parent_id, await self._main_branch_id(s, parent_id), lo, hi

    async def _layers(self, s, graph_id: str, branch_id: str, seq: int) -> List[Tuple[str, str, int]]:
        """The ``(graph, branch, seq)`` a read of ``branch_id`` at ``seq`` composes, nearest first:
        the branch itself and, for a fork's ``main``, its parent's ``main`` at the base the fork read
        at ``seq`` (:func:`fork_base_at`: at ``seq``, before the fork point), and so up a fork of a
        fork — a fork copies no row of its parent's."""
        layers = [(graph_id, branch_id, seq)]
        graph = await s.get(GraphORM, graph_id)
        while graph is not None and graph.fork_parent_graph_id:
            if branch_id != await self._main_branch_id(s, graph.id):
                break
            if await s.get(GraphORM, graph.fork_parent_graph_id) is None:
                # Purged under it (an earlier release did): not found, never a crash.
                raise ValueError(f"the graph fork {graph.id} was forked from is gone")
            branch_id = await self._main_branch_id(s, graph.fork_parent_graph_id)
            seq = await fork_base_at(s, graph, seq)
            layers.append((graph.fork_parent_graph_id, branch_id, seq))
            graph = await s.get(GraphORM, graph.fork_parent_graph_id)
        return layers

    async def _values_at(self, s, graph_id, branch_id, ids, seq) -> Dict[str, Optional[dict]]:
        """Latest value (``commit_seq <= seq``) per entity in *ids* — O(ids) via
        DISTINCT ON (``ix_*_entity_hist``). Deleted → ``None``; absent ids omitted. A fork's
        ``main`` reads its parent's for what it has no row of (:meth:`_layers`)."""
        out: Dict[str, Optional[dict]] = {}
        id_list = list(ids)
        if not id_list:
            return out
        for gid, bid, at in await self._layers(s, graph_id, branch_id, seq):
            for model in (NodeVersionORM, EdgeVersionORM):
                # The ids go as one array (``= ANY``), a chunk at a time: an IN list of thousands is
                # compiled one bind at a time, and a cascade delete can touch tens of thousands.
                stmt = (
                    select(model.entity_id, model.op, model.payload)
                    .where(model.graph_id == gid, model.branch_id == bid,
                           model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                           model.commit_seq <= at)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id)
                )
                for chunk in _chunks(id_list, _IN_LIST_MAX):
                    for eid, op, payload in (await s.execute(stmt, {"ids": list(chunk)})).all():
                        out[eid] = None if op == "delete" else payload
            id_list = [i for i in id_list if i not in out]
            if not id_list:
                break
        return out

    async def _hashes_at(self, s, graph_id, branch_id, ids, seq) -> Dict[str, "_Stored"]:
        """:meth:`_values_at` without the payloads: a :class:`_Stored` per id live at ``seq``
        (deleted, absent, empty- and null-payload ids omitted) — whether a value changed, what it
        is called and where an edge points, told without loading it."""
        out: Dict[str, _Stored] = {}
        id_list = list(ids)
        if not id_list:
            return out
        # A draft's first read runs this over every id the draft changed, on the web process's
        # loop: the ids go as one array (``= ANY``), not an IN list compiled one bind at a time,
        # and the rows come back plain, without the ORM's loading.
        conn = await s.connection()
        for gid, bid, at in await self._layers(s, graph_id, branch_id, seq):
            seen: set = set()
            for kind, model in (("node", NodeVersionORM), ("edge", EdgeVersionORM)):
                named = ((model.urn, model.entity_type, null(), null(), model.display_name,
                          model.qualified_name) if kind == "node"
                         else (null().label("urn"), model.edge_type, model.source_entity_id,
                               model.target_entity_id, null(), null()))
                stmt = (
                    select(model.entity_id, model.op, model.content_hash, *named)
                    .where(model.graph_id == gid, model.branch_id == bid,
                           model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                           model.commit_seq <= at)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id)
                )
                for chunk in _chunks(id_list, _IN_LIST_MAX):
                    for eid, op, chash, urn, typ, src, tgt, name, qname in (
                            await conn.execute(stmt, {"ids": list(chunk)})).all():
                        seen.add(eid)
                        if op != "delete" and chash not in (_HASH_EMPTY, _HASH_NONE):
                            out[eid] = _Stored(kind, chash, urn, typ, src, tgt, name, qname)
            id_list = [i for i in id_list if i not in seen]     # a fork's: on to its parent's
            if not id_list:
                break
        return out

    async def _skeletons_at(self, s, graph_id, branch_id, ids, seq) -> Dict[str, Optional[dict]]:
        """:meth:`_values_at` built from the version row's identity columns instead of its payload:
        a node as ``{urn, entityType}``, an edge as ``{edgeType, sourceEntityId, targetEntityId}``,
        an empty payload as ``{}``. Deleted → ``None``; absent ids omitted — the same liveness as
        :meth:`_values_at`, for the checks that only need to know what an entity is and where an
        edge points (integrity, typing an edge's ends) and not what it holds."""
        out: Dict[str, Optional[dict]] = {}
        id_list = list(ids)
        if not id_list:
            return out
        for gid, bid, at in await self._layers(s, graph_id, branch_id, seq):
            for kind, model in (("node", NodeVersionORM), ("edge", EdgeVersionORM)):
                named = ((model.urn, model.entity_type, null(), null()) if kind == "node" else
                         (null(), func.coalesce(model.edge_type, model.payload["edge_type"].astext),
                          model.source_entity_id, model.target_entity_id))
                stmt = (
                    select(model.entity_id, model.op, model.content_hash, *named)
                    .where(model.graph_id == gid, model.branch_id == bid,
                           model.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                           model.commit_seq <= at)
                    .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                    .distinct(model.entity_id)
                )
                for chunk in _chunks(id_list, _IN_LIST_MAX):
                    for eid, op, chash, urn, typ, src, tgt in (
                            await s.execute(stmt, {"ids": list(chunk)})).all():
                        if op == "delete" or chash == _HASH_NONE:    # a null payload reads as None too
                            out[eid] = None
                        elif chash == _HASH_EMPTY:
                            out[eid] = {}
                        elif kind == "node":
                            out[eid] = {k: v for k, v in (("urn", urn), ("entityType", typ)) if v is not None}
                        else:
                            out[eid] = {k: v for k, v in (("edgeType", typ), ("sourceEntityId", src),
                                                          ("targetEntityId", tgt)) if v}
            id_list = [i for i in id_list if i not in out]      # a fork's: on to its parent's
            if not id_list:
                break
        return out

    async def _head_index(self, s, graph_id: str, branch_id: str) -> Dict[str, "_Head"]:
        """A branch's own heads without their payloads: a :class:`_Head` per entity it changed —
        what its version row says (a node's urn, type and names; an edge's type and ends). What a
        draft changed, at any draft size.

        The heads first, then their version rows by id, ``_IN_LIST_MAX`` at a time — never one
        join of the two: on a partition a large import has just filled and nothing has analyzed
        yet, the planner reads its estimate of one row literally and joins in a nested loop that
        scans the graph's versions once per head (four minutes for a 20k+20k draft).

        This runs in the web process on a draft's first read, so nothing in it holds the event
        loop for long: the heads come in ``_HEAD_PAGE`` pages (a keyset on the primary key), their
        version rows by ``= ANY(<one array>)`` (an IN list of thousands is compiled one bind at a
        time), as plain rows (no ORM loading), and the index is built in a thread. One 200k-row
        result plus 200k ``_Head`` built in one go was half a second the loop served nothing else."""
        conn = await s.connection()
        heads: List[tuple] = []
        async for page in self._head_row_pages(conn, graph_id, branch_id):
            heads.extend(page)
        return await self._heads_from_rows(conn, graph_id, heads)

    @staticmethod
    async def _head_row_pages(conn, graph_id: str, branch_id: str):
        """A branch's head-pointer rows (entity id, kind, version id, content hash, tombstone),
        ``_HEAD_PAGE`` at a time in entity-id order — a keyset on the primary key — for readers
        that classify a large draft a page at a time (:meth:`_head_index`, the change index)."""
        after = ""
        while True:
            page = (await conn.execute(
                select(EntityHeadORM.entity_id, EntityHeadORM.entity_kind,
                       EntityHeadORM.head_version_id, EntityHeadORM.content_hash,
                       EntityHeadORM.is_tombstone)
                .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
                       EntityHeadORM.entity_id > after)
                .order_by(EntityHeadORM.entity_id).limit(_HEAD_PAGE)
            )).all()
            if page:
                yield page
            if len(page) < _HEAD_PAGE:
                return
            after = page[-1][0]

    async def _heads_from_rows(self, conn, graph_id: str, heads: Sequence[tuple]) -> Dict[str, "_Head"]:
        """:meth:`_head_index`'s :class:`_Head` for each of ``heads`` (head-pointer rows: entity
        id, kind, version id, content hash, tombstone), from their version rows."""
        # vid -> (table, urn, type, displayName, qualifiedName, source, target). A head is looked
        # for in its kind's table first, then the other one (a head whose kind went stale).
        rows: Dict[str, tuple] = {}
        for first in ("node", "edge"):
            for table in (first, "edge" if first == "node" else "node"):
                vids = [vid for _e, kind, vid, _h, _t in heads if kind == first and vid not in rows]
                model = NodeVersionORM if table == "node" else EdgeVersionORM
                named = ((model.urn, model.entity_type, model.display_name, model.qualified_name,
                          null(), null()) if table == "node" else
                         (null(), model.edge_type, null(), null(), model.source_entity_id,
                          model.target_entity_id))
                stmt = select(model.id, *named).where(
                    model.graph_id == graph_id,
                    model.id == any_(bindparam("vids", type_=ARRAY(Text))))
                for chunk in _chunks(vids, _HEAD_PAGE):
                    for vid, *cols in (await conn.execute(stmt, {"vids": list(chunk)})).all():
                        rows[vid] = (table, *cols)
        return await asyncio.to_thread(_heads_of, heads, rows)

    async def _heads_present(self, s, graph_id: str, branch_id: str, ids) -> set:
        """Those of ``ids`` that have a head on ``branch_id`` (a draft changed them)."""
        return set(await self._heads_live(s, graph_id, branch_id, ids))

    async def _heads_live(self, s, graph_id: str, branch_id: str, ids) -> Dict[str, bool]:
        """For each of ``ids`` with a head on ``branch_id``, whether that head is live (as
        :class:`_Head` says: not deleted, and not an empty or null payload)."""
        ids = list(ids)
        if not ids:
            return {}
        conn = await s.connection()
        stmt = select(EntityHeadORM.entity_id, EntityHeadORM.is_tombstone,
                      EntityHeadORM.content_hash).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.entity_id == any_(bindparam("ids", type_=ARRAY(Text))))
        out: Dict[str, bool] = {}
        for chunk in _chunks(ids, _IN_LIST_MAX):
            for eid, tomb, chash in (await conn.execute(stmt, {"ids": list(chunk)})).all():
                out[eid] = not tomb and chash not in (_HASH_EMPTY, _HASH_NONE)
        return out

    async def _current_values(
        self, s, graph_id: str, branch_id: str, ids, as_of_seq: Optional[int] = None,
    ) -> Dict[str, Optional[dict]]:
        """Value of each id on a branch, bounded to *ids* (absent ids omitted).
        ``as_of_seq`` reconstructs the value at that commit (time-travel); ``None`` = head.
        ``main`` → values at the seq; a draft → ``main`` at its branch point overlaid with
        the draft's own rows. O(ids) via ``_values_at`` — never composes full state."""
        ids = list(ids)
        if not ids:
            return {}
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            graph = await s.get(GraphORM, graph_id)
            seq = graph.main_head_commit_seq if as_of_seq is None else as_of_seq
            return await self._values_at(s, graph_id, main_id, ids, seq)
        branch = await s.get(BranchORM, branch_id)
        base_seq = branch.base_commit_seq or 0
        if as_of_seq is not None:
            base_seq = min(base_seq, as_of_seq)
        out = await self._values_at(s, graph_id, main_id, ids, base_seq)
        overlay_seq = (1 << 62) if as_of_seq is None else as_of_seq
        out.update(await self._values_at(s, graph_id, branch_id, ids, overlay_seq))
        return out

    async def _current_skeletons(
        self, s, graph_id: str, branch_id: str, ids, as_of_seq: Optional[int] = None,
    ) -> Dict[str, Optional[dict]]:
        """:meth:`_current_values` as :meth:`_skeletons_at` — the same layering (``main`` at the
        seq, or a draft over ``main`` at its branch point) and liveness, without a payload."""
        ids = list(ids)
        if not ids:
            return {}
        main_id = await self._main_branch_id(s, graph_id)
        if branch_id == main_id:
            graph = await s.get(GraphORM, graph_id)
            seq = graph.main_head_commit_seq if as_of_seq is None else as_of_seq
            return await self._skeletons_at(s, graph_id, main_id, ids, seq)
        branch = await s.get(BranchORM, branch_id)
        base_seq = branch.base_commit_seq or 0
        if as_of_seq is not None:
            base_seq = min(base_seq, as_of_seq)
        out = await self._skeletons_at(s, graph_id, main_id, ids, base_seq)
        overlay_seq = (1 << 62) if as_of_seq is None else as_of_seq
        out.update(await self._skeletons_at(s, graph_id, branch_id, ids, overlay_seq))
        return out

    async def _current_urns(
        self, s, graph_id: str, branch_id: str, ids, as_of_seq: Optional[int] = None,
        known: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, str]:
        """The urn a read of ``branch_id`` names each node id by — :meth:`_current_values`'s
        layering (``main`` at the seq, or a draft's own rows over ``main`` at its branch point),
        from version-row columns, no payload. ``known``: values in hand (:class:`_Head` or
        :class:`_Stored`) whose node urn decides. A node with no urn is ``gv:<id>``, as the
        projector names it (``_node_urn``); an id no layer holds as a node takes the last urn any
        row of it carried, else stands for itself, as it did before ids and urns could differ.

        Version rows hold an edge's ends as entity ids and readers match them by urn: an imported
        node's id (``ent_…``) is not its urn, where a canvas or bootstrap node's is."""
        want = [i for i in dict.fromkeys(ids) if i]
        out: Dict[str, str] = {}
        for i in want:
            v = (known or {}).get(i)
            if v is not None and v.kind == "node" and v.urn:
                out[i] = v.urn
        rest = [i for i in want if i not in out]
        if rest:
            main_id = await self._main_branch_id(s, graph_id)
            if branch_id == main_id:
                graph = await s.get(GraphORM, graph_id)
                at = [(main_id, graph.main_head_commit_seq if as_of_seq is None else as_of_seq)]
            else:
                base = (await s.get(BranchORM, branch_id)).base_commit_seq or 0
                at = [(branch_id, (1 << 62) if as_of_seq is None else as_of_seq),
                      (main_id, base if as_of_seq is None else min(base, as_of_seq))]
            for bid, seq in at:
                for i, v in (await self._hashes_at(s, graph_id, bid, rest, seq)).items():
                    if v.kind == "node":
                        out[i] = v.urn or f"gv:{i}"
                rest = [i for i in rest if i not in out]
                if not rest:
                    break
        if rest:
            out.update(await self._last_urns(s, graph_id, rest))
        return {i: out.get(i, i) for i in want}

    async def _last_urns(self, s, graph_id: str, ids: Sequence[str]) -> Dict[str, str]:
        """The last urn any row of each node id carried, here or up a fork's parents: the name of
        an end its layers no longer hold live (an edge removed with its node)."""
        graph_ids = [gid for gid, _b, _at in await self._layers(
            s, graph_id, await self._main_branch_id(s, graph_id), 1 << 62)]
        stmt = (select(NodeVersionORM.entity_id, NodeVersionORM.urn)
                .where(NodeVersionORM.graph_id == bindparam("gid"),
                       NodeVersionORM.entity_id == any_(bindparam("ids", type_=ARRAY(Text))),
                       NodeVersionORM.urn.isnot(None))
                .order_by(NodeVersionORM.entity_id, NodeVersionORM.created_at.desc())
                .distinct(NodeVersionORM.entity_id))
        out: Dict[str, str] = {}
        for gid in graph_ids:
            rest = [i for i in ids if i not in out]
            for chunk in _chunks(rest, _IN_LIST_MAX):
                out.update((await s.execute(stmt, {"gid": gid, "ids": list(chunk)})).all())
            if len(out) == len(ids):
                break
        return out

    async def _incident_edge_ids(
        self, s, graph_id: str, branch_id: str, node_ids, *, sides=("source", "target"),
        edge_types: Optional[Collection[str]] = None,
    ) -> set:
        """Ids of every edge that ever touched *node_ids* on the branch's own layers — ``main`` and,
        for a draft, the draft, and for a fork's ``main`` its parent's (the rows
        :meth:`_current_values` composes) — via ix_ev_source/ix_ev_target. ``edge_types``
        (upper-case) narrows to those types, keeping rows whose type column is unset so a
        payload-only spelling is still judged."""
        ids = list(node_ids)
        if not ids:
            return set()
        main_id = await self._main_branch_id(s, graph_id)
        layers = [(graph_id, [main_id] if branch_id == main_id else [main_id, branch_id])]
        layers += [(gid, [bid]) for gid, bid, _at in (await self._layers(s, graph_id, main_id, 0))[1:]]
        cols = {"source": EdgeVersionORM.source_entity_id, "target": EdgeVersionORM.target_entity_id}
        cand: set = set()
        for gid, branches in layers:
            for side in sides:
                stmt = select(EdgeVersionORM.entity_id).where(
                    EdgeVersionORM.graph_id == gid, EdgeVersionORM.branch_id.in_(branches),
                    cols[side] == any_(bindparam("ids", type_=ARRAY(Text))))
                if edge_types is not None:
                    stmt = stmt.where(or_(func.upper(EdgeVersionORM.edge_type).in_(list(edge_types)),
                                          EdgeVersionORM.edge_type.is_(None)))
                for chunk in _chunks(ids, _IN_LIST_MAX):   # one array a chunk (see _values_at)
                    cand.update((await s.execute(stmt.distinct(), {"ids": list(chunk)})).scalars().all())
        return cand

    async def _incident_live_edges(
        self, s, graph_id: str, branch_id: str, node_ids, as_of_seq: Optional[int] = None,
    ) -> Dict[str, dict]:
        """Currently-live edges on a branch incident to any of *node_ids* — bounded by
        node degree via ix_ev_source/ix_ev_target. Returns {edge_entity_id: payload}."""
        cand = await self._incident_edge_ids(s, graph_id, branch_id, node_ids)
        vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
        return {eid: p for eid, p in vals.items() if p is not None}

    async def _incident_live_edge_skeletons(
        self, s, graph_id: str, branch_id: str, node_ids, *, sides=("source", "target"),
        edge_types: Optional[Collection[str]] = None,
    ) -> Dict[str, dict]:
        """:meth:`_incident_live_edges` at head as skeletons (:meth:`_skeletons_at`) — where each
        live edge points and its type, never its payload."""
        cand = await self._incident_edge_ids(s, graph_id, branch_id, node_ids, sides=sides,
                                             edge_types=edge_types)
        vals = await self._current_skeletons(s, graph_id, branch_id, cand)
        return {eid: p for eid, p in vals.items() if p is not None}

    async def _expand_moves(
        self, s, graph_id: str, branch_id: str, ops: Sequence[Mapping],
        containment_edge_types: Optional[Sequence[str]],
    ) -> List[Mapping]:
        """Expand each ``move`` op — ``{op: "move", entity_id: child, payload: {parentEntityId,
        edgeType, edgeId}}`` — into the edits it means, resolved against what is STORED: delete
        every containment link the child has (on this branch, plus any this batch created before
        the move), then, unless the move is to the top level (no parent), create the new one.

        A move used to be expressed by the client as "delete the old link I can see + create the
        new one"; a link the canvas had not loaded was never deleted, and the node kept two
        parents. Here the server finds the links, so a move is exact whatever the client loaded."""
        if not any(o.get("op") == "move" for o in ops):
            return list(ops)
        cset = {t.upper() for t in (containment_edge_types or [])}
        if not cset:
            raise ValueError("a move needs the ontology's containment relationship types")

        def _is_cont(p: Optional[Mapping]) -> bool:
            return bool(p) and str(p.get("edgeType") or p.get("edge_type") or "").upper() in cset

        children = [o["entity_id"] for o in ops if o.get("op") == "move"]
        stored = await self._incident_live_edges(s, graph_id, branch_id, children)
        out: List[Mapping] = []
        for o in ops:
            if o.get("op") != "move":
                out.append(o)
                continue
            child = o["entity_id"]
            p = o.get("payload") or {}
            links = {eid for eid, v in stored.items()
                     if _is_cont(v) and _edge_src_tgt(v)[1] == child}
            links |= {x["entity_id"] for x in out            # created earlier in this batch
                      if x.get("op") == "create" and x.get("entity_kind") == "edge"
                      and _is_cont(x.get("payload")) and _edge_src_tgt(x["payload"])[1] == child}
            for eid in sorted(links):
                out.append({"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None})
            parent = p.get("parentEntityId")
            if parent:
                if not p.get("edgeType") or not p.get("edgeId"):
                    raise ValueError("a move under a parent needs edgeType and edgeId")
                out.append({"op": "create", "entity_kind": "edge", "entity_id": p["edgeId"],
                            "payload": {"sourceEntityId": parent, "targetEntityId": child,
                                        "edgeType": p["edgeType"]}})
        return out

    async def _effective_incident_edges(
        self, s, graph_id: str, branch_id: str, node_ids, as_of_seq: Optional[int],
        overlay: Optional[Mapping[str, Optional[dict]]],
    ) -> Dict[str, dict]:
        """Live edges incident to *node_ids*: the branch's stored ones with *overlay* (the write
        in progress — entity → new value, ``None`` = deleted) laid over them, plus the overlay's
        own edges touching *node_ids*. Without the overlay this is :meth:`_incident_live_edges`."""
        inc = await self._incident_live_edges(s, graph_id, branch_id, node_ids, as_of_seq)
        if not overlay:
            return inc
        ids = set(node_ids)
        out: Dict[str, dict] = {}
        for eid, p in inc.items():
            v = overlay[eid] if eid in overlay else p
            if v is not None and (set(_edge_src_tgt(v)) & ids):
                out[eid] = v
        for eid, v in overlay.items():
            if eid not in out and v is not None and _is_edge_payload(v) \
                    and (set(_edge_src_tgt(v)) & ids):
                out[eid] = v
        return out

    async def _cascade_subtree(
        self, s, graph_id: str, branch_id: str, root_ids: set,
        cset: set, as_of_seq: Optional[int], cap: int, max_depth: int = 64,
        overlay: Optional[Mapping[str, Optional[dict]]] = None,
    ) -> set:
        """Containment subtree to delete when *root_ids* are deleted, respecting SHARED
        children: a descendant is included only when ALL of its containment parents are in
        the delete set — a child that still has a surviving parent is re-parented, not
        deleted. BFS from the roots; a child is (re)considered whenever any of its parents is
        newly deleted, so multi-parent (DAG) containment converges correctly."""
        deleted = set(root_ids)
        frontier = set(root_ids)
        for _ in range(max_depth):
            if not frontier or len(deleted) >= cap:
                break
            # Children reachable via containment OUT-edges from the newly-deleted frontier.
            inc = await self._effective_incident_edges(
                s, graph_id, branch_id, frontier, as_of_seq, overlay)
            candidates: set = set()
            for p in inc.values():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)              # a = parent (source), b = child (target)
                if a in frontier and b and b not in deleted:
                    candidates.add(b)
            if not candidates:
                break
            # Gather EVERY containment parent of each candidate; delete it only when they're
            # all already in the delete set (otherwise a surviving parent keeps it alive).
            cand_inc = await self._effective_incident_edges(
                s, graph_id, branch_id, candidates, as_of_seq, overlay)
            parents_of: Dict[str, set] = {}
            for p in cand_inc.values():
                if (p.get("edgeType") or "").upper() not in cset:
                    continue
                a, b = _edge_src_tgt(p)
                if b in candidates and a:
                    parents_of.setdefault(b, set()).add(a)
            nxt: set = set()
            for c in candidates:
                ps = parents_of.get(c)
                if ps and ps <= deleted and len(deleted) < cap:
                    deleted.add(c)
                    nxt.add(c)
            frontier = nxt
        return deleted

    async def _cascade_deletes(
        self, s, graph_id: str, branch_id: str, root_node_ids,
        containment_edge_types, as_of_seq: Optional[int] = None,
        overlay: Optional[Mapping[str, Optional[dict]]] = None,
    ) -> Tuple[set, Dict[str, dict]]:
        """The full tombstone set for deleting *root_node_ids* on a branch:

        * the **containment subtree** of nodes (transitive children via the ontology's
          containment edge types — `containment_edge_types`, resolved live by the caller,
          never hardcoded; shared children with a surviving parent are kept), and
        * **every live edge incident** to any of those nodes (source OR target, ANY type —
          containment, lineage, aggregated — so nothing dangles).

        Lineage-connected nodes are NOT added to the node set; only their edges are cleaned.
        Returns ``(subtree_node_ids, {edge_entity_id: payload})``. The same helper backs the
        read-only delete-impact preview AND the commit-time cascade, so they always agree.

        A write passes itself as *overlay* so the cascade follows the hierarchy AS WRITTEN: a
        child linked under the node in the same save goes with it, a relationship drawn to it in
        the same save goes too, and a child moved away from it in the same save stays."""
        roots = {r for r in root_node_ids if r}
        if not roots:
            return set(), {}
        cset = {t.upper() for t in (containment_edge_types or [])}
        subtree = await self._cascade_subtree(
            s, graph_id, branch_id, set(roots), cset, as_of_seq, _CASCADE_MAX_NODES, overlay=overlay,
        ) if cset else set(roots)
        subtree |= roots
        edges = await self._effective_incident_edges(
            s, graph_id, branch_id, subtree, as_of_seq, overlay)
        return subtree, edges

    async def delete_impact(
        self, *, graph_id: str, branch_id: str, root_urn: str, containment_edge_types,
        limit: int = 1000,
    ) -> Dict[str, object]:
        """Read-only preview: what deleting the node at *root_urn* would remove on this
        branch — the containment subtree (node payloads) + all incident edges (edge
        payloads), with accurate totals (the lists are capped at ``limit`` for the UI, the
        totals are not). Same traversal as the commit-time cascade, so the preview matches
        the result. Empty when the urn doesn't resolve to a live node."""
        async with self._session() as s:
            root = await self._eid_for_urn(s, graph_id, branch_id, root_urn)
            if root is None:
                return {"nodes": [], "edges": [], "node_total": 0, "edge_total": 0}
            subtree, edges = await self._cascade_deletes(
                s, graph_id, branch_id, {root}, containment_edge_types)
            node_vals = await self._current_values(s, graph_id, branch_id, list(subtree))
            live_node_ids = [eid for eid in subtree if node_vals.get(eid) is not None]
            edge_ids = list(edges)
            nodes = [{"entityId": eid, **(node_vals[eid] or {})} for eid in live_node_ids[:limit]]
            edge_list = [{"entityId": eid, **(edges[eid] or {})} for eid in edge_ids[:limit]]
            return {"nodes": nodes, "edges": edge_list,
                    "node_total": len(live_node_ids), "edge_total": len(edge_ids)}

    async def _eid_for_urn(
        self, s, graph_id: str, branch_id: str, urn: str, as_of_seq: Optional[int] = None,
    ) -> Optional[str]:
        """Resolve a seed urn to its live node's entity_id on a branch (bounded via
        ix_nv_urn + the ``gv:<eid>`` fast path); ``None`` if absent/tombstoned/not a node. A fork
        (its ``main``, or a draft on it) finds a node it only inherited: the candidates come from
        the rows of every graph its reads compose (:meth:`_layer_graph_ids`)."""
        cand: List[str] = [urn[3:]] if urn.startswith("gv:") else []
        graphs = await self._layer_graph_ids(s, graph_id)
        cand.extend((await s.execute(
            select(NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id.in_(graphs), NodeVersionORM.urn == urn,
            ).distinct()
        )).scalars().all())
        if not cand:
            return None
        vals = await self._current_values(s, graph_id, branch_id, cand, as_of_seq)
        for eid in cand:
            p = vals.get(eid)
            if p is not None and not _is_edge_payload(p) and (p.get("urn") == urn or f"gv:{eid}" == urn):
                return eid
        return None

    async def _layer_graph_ids(self, s, graph_id: str) -> List[str]:
        """The graphs whose rows a read on ``graph_id`` composes: itself, and for a fork every graph
        up its chain (:meth:`_layers`) — where a node it only inherited has its version rows."""
        graph = await s.get(GraphORM, graph_id)
        if graph is None or not graph.fork_parent_graph_id:
            return [graph_id]
        main_id = await self._main_branch_id(s, graph_id)
        return [gid for gid, _b, _at in await self._layers(s, graph_id, main_id, 0)]

    async def entity_recorded(self, *, graph_id: str, entity_id: str) -> bool:
        """Whether main holds any version of the entity, live OR deleted — how the write-through
        tells a node versioning never saw from one main deleted. This graph's rows only (not
        fork-aware)."""
        async with self._session() as s:
            main_id = await self._main_branch_id(s, graph_id)
            if entity_id in await self._current_skeletons(s, graph_id, main_id, [entity_id]):
                return True
            # An imported node is keyed by a minted id and carries its urn on its rows: a
            # write-through naming it by that urn names something main has recorded too.
            return bool((await self._holders_by_urn(s, graph_id, main_id, [entity_id])).get(entity_id))

    async def entity_value(
        self, *, graph_id: str, entity_id: str, branch_id: Optional[str] = None,
    ) -> Optional[dict]:
        """Current payload of one entity on a branch (default ``main``), or ``None`` — a
        bounded lookup for provider write-through (no full-state materialize)."""
        async with self._session() as s:
            bid = branch_id or await self._main_branch_id(s, graph_id)
            return (await self._current_values(s, graph_id, bid, [entity_id])).get(entity_id)

    async def resolve_edges(
        self, *, graph_id: str, edge_ids: Collection[str], branch_id: Optional[str] = None,
    ) -> Dict[str, Optional[Tuple[str, dict]]]:
        """The edge each id names on a branch (default ``main``): ``{id: (entity id, payload)}``;
        None for an id that names only a node; an id that names nothing is left out. Nodes and
        edges share one id space, so an edge whose id was also a node's was re-keyed ``edge:<id>``
        when its graph was copied in (``bootstrap_worker._rekey``), while the graph still calls it
        ``<id>``: that edge answers for ``<id>``. A node never does."""
        async with self._session() as s:
            bid = branch_id or await self._main_branch_id(s, graph_id)
            return await self._edges_named(s, graph_id, bid, edge_ids)

    async def _edges_named(self, s, graph_id: str, bid: str, edge_ids: Collection[str]
                           ) -> Dict[str, Optional[Tuple[str, dict]]]:
        ids = list(dict.fromkeys(edge_ids))
        vals = await self._current_values(s, graph_id, bid, ids + [f"edge:{i}" for i in ids])
        out: Dict[str, Optional[Tuple[str, dict]]] = {}
        for i in ids:
            eid = next((e for e in (i, f"edge:{i}") if _is_edge_payload(vals.get(e))), None)
            if eid is not None:
                out[i] = (eid, vals[eid])
            elif vals.get(i) is not None:
                out[i] = None
        return out

    async def _by_entity_id(self, s, graph_id: str, bid: str, ops: Sequence[Mapping],
                            written_by: Optional[str] = None) -> Tuple[List[Mapping], Dict[str, str]]:
        """``ops`` with each node they name by urn named by its entity id, and ``{entity id: the
        name sent}`` for the ops' own ids it changed. A client names a node by its urn; canvas and
        bootstrap nodes are keyed by it, an imported node by a minted id (``ent_…``).

        A node op's id, a move's parent and an edge's ends that are no entity id on the branch and
        are the urn of one live node become that node's id; of several, the batch is refused
        (:class:`AmbiguousUrn`); of none, they go as they came (today's errors). A create's id that
        is a live node's urn is refused (:class:`EntityExists`); one only a single deleted node
        held restores that node. Ids this batch creates are its own. ``written_by``, a retry's
        first commit: the names resolve to what it wrote, as they did then."""
        def _node(o: Mapping) -> bool:
            return o.get("entity_kind", "node") != "edge"

        created = {o["entity_id"] for o in ops if o.get("op") == "create"}
        asked: set = set()
        for o in ops:
            p = o.get("payload") or {}
            if _node(o) and o.get("op") != "create":
                asked.add(o["entity_id"])
            if o.get("op") == "move" and p.get("parentEntityId"):
                asked.add(p["parentEntityId"])
            if not _node(o) and o.get("op") in ("create", "update"):
                asked.update(x for x in _edge_src_tgt(p) if x)
        asked -= created
        creates = {o["entity_id"] for o in ops if o.get("op") == "create" and _node(o)}
        if not asked and not creates:
            return list(ops), {}
        known = await self._current_skeletons(s, graph_id, bid, asked | creates)
        unknown = (asked | creates) - set(known)          # no entity of the branch has that id
        mapping: Dict[str, str] = {}
        # A node with no urn reads as ``gv:<id>`` (``_current_urns``): that names its id.
        gv = {n: n[3:] for n in unknown if n.startswith("gv:")}
        if gv:
            held = await self._current_skeletons(s, graph_id, bid, set(gv.values()))
            mapping.update({n: e for n, e in gv.items() if e in held})
            unknown -= set(mapping)
        if written_by is not None and unknown:
            # A retry: what the first attempt wrote, by the urn each of its nodes carried.
            wrote = (await s.execute(select(NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id == graph_id,
                NodeVersionORM.commit_id == written_by))).scalars().all()
            by_urn = {u: e for e, u in (await self._last_urns(s, graph_id, list(wrote))).items()}
            mapping.update({n: by_urn[n] for n in unknown if n in by_urn})
        rest = unknown - set(mapping)
        if rest:
            holders = await self._holders_by_urn(s, graph_id, bid, rest)
            state = await self._current_skeletons(
                s, graph_id, bid, {e for ids in holders.values() for e in ids})
            ambiguous, existing = [], []
            for name in sorted(rest):
                ids = holders.get(name, set())
                live = [e for e in ids if (state.get(e) or {}).get("urn") == name]
                if name in creates:
                    if live:
                        existing.append(name)              # a second node with a live one's urn
                    elif len(ids) == 1:
                        mapping[name] = next(iter(ids))    # the one node that held it: restored
                elif len(live) == 1:
                    mapping[name] = live[0]
                elif len(live) > 1:
                    ambiguous.append(name)
            if ambiguous:
                raise AmbiguousUrn(ambiguous)
            if existing:
                raise EntityExists(existing)
        if not mapping:
            return list(ops), {}
        out: List[Mapping] = []
        names: Dict[str, str] = {}
        for o in ops:
            o2 = dict(o)
            if _node(o) and o["entity_id"] in mapping:
                o2["entity_id"] = mapping[o["entity_id"]]
                names[o2["entity_id"]] = o["entity_id"]
                p = o.get("payload") or {}
                if o["entity_id"].startswith("gv:") and p.get("urn") == o["entity_id"]:
                    # Restored as it was: a node with no urn, not one with ``gv:`` in it.
                    o2["payload"] = {k: v for k, v in p.items() if k != "urn"}
            p = o2.get("payload")
            if p:
                keys = (("parentEntityId",) if o.get("op") == "move" else ()) + (
                    () if _node(o) else ("sourceEntityId", "source_entity_id",
                                         "targetEntityId", "target_entity_id"))
                if any(p.get(k) in mapping for k in keys):
                    o2["payload"] = {**p, **{k: mapping[p[k]] for k in keys if p.get(k) in mapping}}
            out.append(o2)
        return out, names

    async def _unique_violations(self, s, graph_id: str, main_id: str,
                                 written: Mapping[str, Optional[dict]],
                                 ontology_rules: Optional[OntologyRules],
                                 seen: Optional[Dict[Tuple[str, str, str], set]] = None,
                                 source: Optional[Tuple[str, str]] = None) -> List[dict]:
        """Each value of a field its type keeps unique (``EntityRule.unique_fields``) that a node
        ``written`` carries and another live node of the type carries too — another written here,
        or one on ``main`` this write leaves as it is: ``[{type, field, value, entities}]``. One
        query a type and field over ``main``'s rows (its layers, a fork's), kept to the values asked,
        then those nodes' current values. Nothing when no type keeps a field unique. ``seen``: what
        the pages before this one wrote, for a publish written a page at a time. ``source``: the
        ``(graph, branch)`` a squash copies rows from, whose values ``written`` holds only as their
        identity columns — read in full for the types that keep a field unique."""
        if ontology_rules is None or not any(r.unique_fields for r in ontology_rules.entity_types.values()):
            return []

        def _keys(v: Optional[dict]) -> List[Tuple[str, str, str]]:
            if not v or _is_edge_payload(v):
                return []
            etype = ontology_rules.canonical_entity_type(v.get("entityType"))
            rule = ontology_rules.entity_types.get(etype) if etype else None
            props = v.get("properties") or {}
            return [(etype, f, val) for f in sorted(rule.unique_fields if rule else ())
                    if (val := _key_text(props.get(f))) is not None]

        if source is not None:
            need = [eid for eid, v in written.items()
                    if v and not _is_edge_payload(v) and "properties" not in v
                    and (r := ontology_rules.entity_types.get(
                        ontology_rules.canonical_entity_type(v.get("entityType")) or ""))
                    and r.unique_fields]
            if need:
                full = await self._current_values(s, source[0], source[1], need)
                written = {**written, **{e: full[e] for e in need if full.get(e) is not None}}
        holders: Dict[Tuple[str, str, str], set] = {}
        for eid, v in written.items():
            for key in _keys(v):
                holders.setdefault(key, set()).add(eid)
        if not holders:
            return []
        if seen is not None:
            for key, ids in holders.items():
                earlier = seen.setdefault(key, set())
                ids |= earlier - set(written)
                earlier |= ids
        wanted: Dict[Tuple[str, str], set] = {}
        for etype, field_, val in holders:
            wanted.setdefault((etype, field_), set()).add(val)
        graph = await s.get(GraphORM, graph_id)
        found: set = set()
        for gid, bid, at in await self._layers(s, graph_id, main_id, graph.main_head_commit_seq):
            for (etype, field_), vals in wanted.items():
                found.update((await s.execute(
                    select(NodeVersionORM.entity_id).where(
                        NodeVersionORM.graph_id == gid, NodeVersionORM.branch_id == bid,
                        NodeVersionORM.commit_seq <= at, NodeVersionORM.entity_type == etype,
                        NodeVersionORM.payload["properties"][field_].astext
                        == any_(bindparam("vals", type_=ARRAY(Text)))).distinct(),
                    {"vals": sorted(vals)})).scalars().all())
        for eid, v in (await self._current_values(s, graph_id, main_id, found - set(written))).items():
            for key in _keys(v):
                if key in holders:
                    holders[key].add(eid)
        return [{"type": t, "field": f, "value": val, "entities": sorted(ids)}
                for (t, f, val), ids in sorted(holders.items()) if len(ids) > 1]

    async def identities_taken(self, *, graph_id: str, branch_id: str,
                               names: Collection[str]) -> Tuple[set, Dict[str, str]]:
        """For the names new nodes would take as their id and urn: those taken — an entity of the
        branch holds the id (live or deleted, node or edge), or a live node carries the urn — and
        ``{name: id}`` for each only one deleted node ever carried as its urn, which a create of it
        brings back rather than a second entity with that urn (the projector deletes by urn)."""
        wanted = {n for n in names if n}
        if not wanted:
            return set(), {}
        async with self._session() as s:
            held = await self._current_skeletons(s, graph_id, branch_id, wanted)
            taken = set(held)
            # A name only a deleted entity holds as its id can still be one a deleted node carried
            # as its urn — a urn:uuid, whose id and urn are one — and so is brought back too.
            live = {e for e, skeleton in held.items() if skeleton is not None}
            holders = await self._holders_by_urn(s, graph_id, branch_id, wanted - live)
            state = await self._current_skeletons(
                s, graph_id, branch_id, {e for ids in holders.values() for e in ids})
        restore: Dict[str, str] = {}
        for name, ids in holders.items():
            if any((state.get(e) or {}).get("urn") == name for e in ids):
                taken.add(name)
            elif len(ids) == 1 and next(iter(ids)) in state and state[next(iter(ids))] is None:
                restore[name] = next(iter(ids))
        return taken, restore

    async def identity_scope(self, graph_id: str) -> str:
        """What an import derives node ids in: the data source at the root of the graph's fork
        lineage. A data source keeps its id while its graph is made again — a conversion
        abandoned and redone — and a fork shares its root's ids, so a file imported again lands
        on the nodes it made, wherever in the lineage it goes."""
        async with self._session() as s:
            root = (await self._layer_graph_ids(s, graph_id))[-1]
            graph = await s.get(GraphORM, root)
        return (graph.data_source_id if graph is not None else None) or root

    async def _holders_by_urn(self, s, graph_id: str, bid: str, urns) -> Dict[str, set]:
        """``{urn: entity ids}`` of the nodes whose rows on the branch — its own and ``main``'s,
        and up a fork's parents — ever carried each urn (``ix_nv_urn``). Who holds it now is the
        caller's to judge (:meth:`_current_skeletons`)."""
        main_id = await self._main_branch_id(s, graph_id)
        scopes = [(graph_id, sorted({bid, main_id}))] + [
            (gid, [b]) for gid, b, _at in (await self._layers(s, graph_id, main_id, 1 << 62))[1:]]
        stmt = (select(NodeVersionORM.urn, NodeVersionORM.entity_id)
                .where(NodeVersionORM.graph_id == bindparam("gid"),
                       NodeVersionORM.branch_id == any_(bindparam("bids", type_=ARRAY(Text))),
                       NodeVersionORM.urn == any_(bindparam("urns", type_=ARRAY(Text))))
                .distinct())
        out: Dict[str, set] = {}
        wanted = sorted(urns)
        for gid, bids in scopes:
            for chunk in _chunks(wanted, _IN_LIST_MAX):
                for urn, eid in (await s.execute(stmt, {"gid": gid, "bids": bids,
                                                        "urns": list(chunk)})).all():
                    out.setdefault(urn, set()).add(eid)
        return out

    async def _aimed(self, s, graph_id: str, bid: str, ops: Sequence[Mapping]) -> List[Mapping]:
        """``ops`` with each edge update or delete aimed at the edge its id names on the branch
        (:meth:`_edges_named`). An id that names only an item there is refused
        (:class:`NotAnEdge`); one that names nothing goes as it came."""
        asked = [o["entity_id"] for o in ops
                 if o.get("entity_kind") == "edge" and o.get("op") in ("update", "delete")]
        if not asked:
            return list(ops)
        named = await self._edges_named(s, graph_id, bid, asked)
        items = {i for i in asked if i in named and named[i] is None}
        if items:
            raise NotAnEdge(items)
        return [{**o, "entity_id": named[o["entity_id"]][0]}
                if o.get("entity_kind") == "edge" and o.get("op") in ("update", "delete")
                and named.get(o["entity_id"]) else o for o in ops]

    async def _aimed_as_written(self, s, graph_id: str, commit_id: str,
                                ops: Sequence[Mapping]) -> List[Mapping]:
        """A retried batch's edge ops aimed as its first attempt aimed them: at the ``edge:<id>``
        that attempt's commit wrote, when it wrote that and not ``<id>``. The edge may be deleted
        since, so what the branch holds now can't say."""
        wrote = set((await s.execute(select(EdgeVersionORM.entity_id).where(
            EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.commit_id == commit_id)
        )).scalars())
        return [{**o, "entity_id": f"edge:{o['entity_id']}"}
                if o.get("entity_kind") == "edge" and o["entity_id"] not in wrote
                and f"edge:{o['entity_id']}" in wrote else o for o in ops]

    async def _entity_value_at(self, s, graph_id, branch_id, entity_id, seq) -> Optional[dict]:
        """One entity's value at ``seq`` (fork-aware): this graph, else the parent
        at the fork point (recursively)."""
        return (await self._values_at(s, graph_id, branch_id, [entity_id], seq)).get(entity_id)

    @staticmethod
    def _cascade_incident_edges(state: Dict[str, Optional[dict]]) -> List[str]:
        """Tombstone every live edge incident to a tombstoned node so that deleting
        a node cascades to its edges within the same commit (plan §16.5 #8). Mutates
        ``state`` in place and returns the cascaded edge ids. Edges pointing at an
        endpoint that *never existed* are left for the integrity guard to reject."""
        tomb = {eid for eid, p in state.items() if p is None}
        if not tomb:
            return []
        cascaded = [
            eid for eid, p in state.items()
            if p is not None
            and (p.get("sourceEntityId") or p.get("source_entity_id")) is not None
            and ((p.get("sourceEntityId") or p.get("source_entity_id")) in tomb
                 or (p.get("targetEntityId") or p.get("target_entity_id")) in tomb)
        ]
        for eid in cascaded:
            state[eid] = None
        return cascaded

    @staticmethod
    def _cascade_containment(state: Dict[str, Optional[dict]], containment_edge_types) -> List[str]:
        """Tombstone the containment-descendants of every tombstoned node, in-memory over a
        FULL state (the sync/merge path's analog of the DB-backed `_cascade_deletes`).
        Ontology-driven via *containment_edge_types* — walks parent→child along containment
        edges present in the state. Mutates ``state``; returns the cascaded node ids.
        (Incident-edge cleanup runs separately via `_cascade_incident_edges`.)"""
        cset = {t.upper() for t in (containment_edge_types or [])}
        if not cset:
            return []
        children: Dict[str, set] = {}
        parents_of: Dict[str, set] = {}
        for p in state.values():
            if p is None or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt:
                children.setdefault(src, set()).add(tgt)
                parents_of.setdefault(tgt, set()).add(src)
        cascaded: List[str] = []
        deleted = {eid for eid, p in state.items() if p is None}
        frontier = set(deleted)
        while frontier:
            nxt: set = set()
            for parent in frontier:
                for child in children.get(parent, ()):
                    if child in deleted:
                        continue
                    ps = parents_of.get(child)               # delete only if NO parent survives
                    if ps and ps <= deleted:
                        state[child] = None
                        deleted.add(child)
                        cascaded.append(child)
                        nxt.add(child)
            frontier = nxt
        return cascaded

    @staticmethod
    def _assert_referential_integrity(state: Mapping[str, Optional[dict]]) -> None:
        live = {eid for eid, p in state.items() if p is not None}
        for eid, p in state.items():
            if p is None:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src is None and tgt is None:
                continue  # a node
            if src not in live or tgt not in live:
                raise ConcurrencyError(
                    f"edge {eid} would dangle (endpoint tombstoned): {src}->{tgt}"
                )


def _redefines(before: Optional[dict], after: Mapping, kind: str) -> bool:
    """Whether writing *after* over *before* defines a (partly) NEW entity for the ontology: it
    did not exist, or a type-defining field changed — a node's type; an edge's type or either
    end. Such a write faces the full ontology gate; any other edit is exempt."""
    if not before:
        return True
    if kind == "node":
        return (before.get("entityType") or "") != (after.get("entityType") or "")
    return (str(before.get("edgeType") or before.get("edge_type") or "").upper()
            != str(after.get("edgeType") or after.get("edge_type") or "").upper()
            or _edge_src_tgt(before) != _edge_src_tgt(after))


def _untyped_creations(
    created: Mapping[str, Optional[dict]], kind_by_entity: Mapping[str, str],
    edited: Collection[str] = (),
) -> List[dict]:
    """Violations for entities about to be CREATED without a type (a node's ``entityType``, an
    edge's ``edgeType``). Every reader needs one, so this holds in every enforcement mode — one
    untyped node made every read of its draft fail. Callers pass only entities that do not exist
    yet: ones already stored untyped (legacy data) stay editable, so they can be fixed."""
    out: List[dict] = []
    for eid, v in created.items():
        if v is None:
            continue
        kind = kind_by_entity.get(eid, "node")
        name = v.get("displayName") or eid
        typed = v.get("entityType") if kind == "node" else (v.get("edgeType") or v.get("edge_type"))
        if typed:
            continue
        if eid in edited:
            # An EDIT of something this branch does not have — never a creation the user meant.
            out.append({"entity_id": eid, "kind": kind, "rule": "entity_not_found", "name": name,
                        "reason": f"'{name}' isn't on this draft — the change edits "
                                  f"{'an entity' if kind == 'node' else 'a relationship'} that does not "
                                  "exist here (it may have been deleted). Refresh the view and try again."})
        elif kind == "node":
            out.append({"entity_id": eid, "kind": kind, "rule": "missing_entity_type", "name": name,
                        "reason": f"'{name}' has no entity type. Choose a type from the ontology."})
        else:
            out.append({"entity_id": eid, "kind": kind, "rule": "missing_edge_type", "name": name,
                        "reason": "A relationship needs a relationship type from the ontology."})
    return out


def _fold_shared(
    base_state: Mapping[str, Optional[dict]],
    changes: Sequence["WorkingChangeORM"],
    set_fields: frozenset,
    resolutions: Mapping[str, Optional[dict]],
    base_by_entity: Optional[Mapping[str, Optional[dict]]] = None,
) -> Tuple[Dict[str, Optional[dict]], List[dict]]:
    """Fold a shared draft's working changes into head state with per-collaborator
    3-way field merge (shared-draft OCC, plan §8).

    The OCC ancestor is the value each edit was STAGED against (``base_by_entity``,
    resolved from ``WorkingChangeORM.base_content_hash``), NOT the live head — so a
    same-field clash is caught even across separate checkpoints, not just within one
    batch. Different actors' edits 3-way merge over that ancestor (disjoint union,
    same-field → conflict); then, if the live head (``base_state``) MOVED since staging
    (e.g. a concurrent ``apply_ops`` on the shared draft), the folded result is 3-way
    merged against the current head too — so a single-actor stale checkpoint conflicts
    instead of silently overwriting. ``resolutions`` (``{entity_id: payload|None}``)
    settles an entity outright.
    """
    head: Dict[str, Optional[dict]] = dict(base_state)
    conflicts: List[dict] = []
    by_entity: Dict[str, List["WorkingChangeORM"]] = {}
    for c in changes:                                    # arrive in seq order
        by_entity.setdefault(c.entity_id, []).append(c)
    base_by_entity = base_by_entity or {}

    for eid, chs in by_entity.items():
        if eid in resolutions:                           # caller settled this entity
            head[eid] = _normalize_resolution(resolutions[eid])
            continue
        current = base_state.get(eid)                    # live committed head
        ancestor = base_by_entity.get(eid, current)      # what the editors staged against
        order: List[str] = []                            # actors, first-seen order
        net: Dict[str, Optional[dict]] = {}
        for c in chs:
            # Each collaborator's ops COMPOSE onto the staged ancestor exactly as ``materialize``
            # folds a private draft: an update is a PATCH. Taking the last payload as the whole
            # value dropped every field a partial update did not mention — a new node renamed
            # before checkpoint lost its type, and the 3-way merge read the missing fields as
            # deletions.
            if c.actor not in net:
                order.append(c.actor)
                net[c.actor] = ancestor
            net[c.actor] = materialize(
                {eid: net[c.actor]},
                [{"entity_id": eid, "op": c.op, "payload": c.payload}])[eid]
        merged = net[order[0]]
        for a in order[1:]:                              # iterative 3-way over the staged ancestor
            out = three_way_merge(ancestor, merged, net[a], set_fields)
            merged = out.merged
            for cf in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(cf.path),
                    "base": cf.base, "ours": cf.ours, "theirs": cf.theirs, "kind": cf.kind,
                })
        # OCC vs the live head: if it moved since these edits were staged, reconcile.
        if content_hash(ancestor) != content_hash(current):
            out = three_way_merge(ancestor, merged, current, set_fields)
            merged = out.merged
            for cf in out.conflicts:
                conflicts.append({
                    "entity_id": eid, "path": list(cf.path),
                    "base": cf.base, "ours": cf.ours, "theirs": cf.theirs, "kind": cf.kind,
                })
        head[eid] = merged
    return _collapse_empty_payloads(head), conflicts


def _is_edge_payload(payload: Mapping) -> bool:
    """Edge payloads carry both endpoints; node payloads don't.  Lets a composed
    state be split into nodes/edges without a second kind lookup (the same
    heuristic the referential-integrity guard uses)."""
    if not payload:
        return False
    has_src = "sourceEntityId" in payload or "source_entity_id" in payload
    has_tgt = "targetEntityId" in payload or "target_entity_id" in payload
    return has_src and has_tgt


def _curation_at_risk(human) -> CurationAtRisk:
    """The refusal for :meth:`GraphVersioningService._human_commit_in_sync_base`'s row."""
    commit_id, seq, kind, actor, created_at = human
    return CurationAtRisk(
        f"main has human changes from before the last sync (latest: {kind} commit {commit_id} "
        f"by {actor}); a sync would treat them as source data and could silently revert or "
        "delete them. A workspace admin can re-run with force to proceed.",
        {"id": commit_id, "seq": seq, "kind": kind, "actor": actor, "createdAt": created_at})


def _collapse_empty_payloads(state: Dict[str, Optional[dict]]) -> Dict[str, Optional[dict]]:
    """In place: collapse any degenerate EMPTY payload ({}) in a merged state to None (a tombstone).
    A {} entity has no identity (no urn/entityType/endpoints); three_way_merge can emit one on the
    auto-merge branch (both sides reduce every field to MISSING), and that value would otherwise slip
    past the cascade + referential-integrity guards (which key off ``p is None``) and net_delta as a
    live node — the delete/modify 500 class. Running this before those guards makes such a value
    delete + cascade like any other tombstone. Returns the same dict for chaining."""
    for eid, p in list(state.items()):
        if p is not None and not p:
            state[eid] = None
    return state


_RES_MISSING = object()


def _settle_conflicts(auto_merged: Optional[dict], resolution: Optional[dict], conflicts) -> Optional[dict]:
    """Apply a user conflict resolution by settling ONLY the conflicting field-paths on top of the
    3-way auto-merge — never a whole-entity replace. Any field the OTHER branch changed that this
    resolution didn't touch (a NON-conflicting change) therefore survives, instead of being silently
    dropped when the resolution payload omits it. A ``None`` resolution (accept deletion) or an
    entity-level delete/modify conflict (empty path) settles the whole entity, since the whole entity
    is the unit that diverged."""
    if resolution is None:
        return None
    if auto_merged is None or any(not c.path for c in conflicts):
        return resolution
    result = dict(auto_merged)
    for c in conflicts:
        _overlay_at_path(result, resolution, c.path)
    return result


def _overlay_at_path(target: dict, source, path) -> None:
    """Overlay ``source``'s value at ``path`` onto ``target``, copy-on-writing intermediate dicts so
    shared sub-objects are never mutated; if ``source`` lacks the path (the field was resolved to
    'removed') the leaf is deleted from ``target``."""
    sv = source
    for k in path:
        if isinstance(sv, Mapping) and k in sv:
            sv = sv[k]
        else:
            sv = _RES_MISSING
            break
    node = target
    for k in path[:-1]:
        child = node.get(k)
        child = dict(child) if isinstance(child, dict) else {}
        node[k] = child
        node = child
    leaf = path[-1]
    if sv is _RES_MISSING:
        node.pop(leaf, None)
    else:
        node[leaf] = sv


def _normalize_resolution(payload: Optional[dict]) -> Optional[dict]:
    """Interpret a conflict resolution. ``None`` means "delete this entity"; so does a
    degenerate EMPTY payload (``{}``) — which is what a client sends when it encodes "accept the
    upstream deletion" of a delete/modify conflict as an empty object instead of ``null`` (the
    whole-entity ``setIn(seed, [], null)`` case). Mapping both to ``None`` keeps an accepted
    deletion from landing as a LIVE but identity-less node (no urn/entityType), which then fails
    GraphNode validation on every read (the reported 500). A real resolution payload is returned
    unchanged."""
    return payload or None


def _edge_src_tgt(p: Mapping) -> Tuple[str, str]:
    return (p.get("sourceEntityId") or p.get("source_entity_id") or "",
            p.get("targetEntityId") or p.get("target_entity_id") or "")


def _graphnode_dict(entity_id: str, urn: str, payload: dict) -> dict:
    """Reader-compatible GraphNode shape (by alias) from a version payload. Surfaces the same
    top-level denormalised fields FalkorDB returns (``_node_from_props``) so a draft node is
    shaped identically to main; ``childCount`` is stamped separately by ``_attach_child_counts``."""
    return {
        "urn": urn,
        "entityId": entity_id,
        # "unknown" like main's reader (``_node_from_props``): writes refuse an untyped creation,
        # but one stored before that rule must still read — shown so it can be retyped, never a
        # 500 that takes the whole draft down with it.
        "entityType": payload.get("entityType") or "unknown",
        "displayName": payload.get("displayName") or "",
        "qualifiedName": payload.get("qualifiedName"),
        "description": payload.get("description"),
        "properties": payload.get("properties") or {},
        "tags": payload.get("tags") or [],
        "layerAssignment": payload.get("layerAssignment"),
        "sourceSystem": payload.get("sourceSystem"),
        "lastSyncedAt": payload.get("lastSyncedAt"),
        # OCC token: content_hash of THIS stored payload (matches the version row's content_hash, so
        # the client can echo it as `baseVersion` and the server resolves the base it edited from).
        "version": content_hash(payload),
    }


def _set_child_count(nd: dict, cc: int) -> None:
    """Stamp a reader node dict with its containment ``childCount`` (top-level field + mirrored
    into ``properties`` — the canvas reads either). The one attach shape every branch/as-of node
    read shares, so drafts stay at parity with FalkorDB's per-read child counts."""
    nd["childCount"] = cc
    nd["properties"] = {**(nd.get("properties") or {}), "childCount": cc}


def _graphedge_dict(entity_id: str, payload: dict, urn_of: Mapping) -> dict:
    src, tgt = _edge_src_tgt(payload)
    return {
        "id": entity_id,
        "sourceUrn": urn_of.get(src, f"gv:{src}"),
        "targetUrn": urn_of.get(tgt, f"gv:{tgt}"),
        "edgeType": payload.get("edgeType") or payload.get("edge_type") or "unknown",   # never a 500 (see above)
        "confidence": payload.get("confidence"),
        "properties": payload.get("properties") or {},
        "version": content_hash(payload),       # OCC token (see _graphnode_dict)
    }


def _chunks(seq, n):
    for i in range(0, len(seq), max(1, n)):
        yield seq[i:i + max(1, n)]


def _derived_node_id(scope: str, row: Mapping[str, Any]) -> Optional[str]:
    """A new node's id as an import makes it (doc 18 §3): a ``urn:uuid`` the row brings — as its
    ``entity_id``, ``id`` or ``urn`` — in canonical form; else one derived from its urn, as an
    import by urn derives it, else from its own id. ``None`` for a row with neither."""
    from .import_export.resolve import pointer_id, pointer_seed
    for v in (row.get("entity_id"), row.get("id"), row.get("urn")):
        if uuid_urn(v):
            return uuid_urn(v)
    seed = pointer_seed(row.get("urn")) or pointer_seed(row.get("entity_id"), row.get("id"))
    return pointer_id(scope, seed) if seed else None


def _derived_edge_id(scope: str, row: Mapping[str, Any], source: str, target: str,
                     edge_type: str) -> str:
    """A new edge's id as an import makes it: a ``urn:uuid`` the row brings, in canonical form;
    else one derived from its own id, or — with none — from its ends and type."""
    from .import_export.resolve import edge_pointer_id, key_value
    for v in (row.get("entity_id"), row.get("id")):
        if uuid_urn(v):
            return uuid_urn(v)
    own = key_value(row.get("entity_id")) or key_value(row.get("id"))
    return (derived_entity_id("edge", f"{scope}/pointer:{own}") if own
            else edge_pointer_id(scope, source, target, edge_type))


def _id_to_take(derived: Optional[str], back: Set[str], held: Collection[str]) -> str:
    """The id a synced entity main holds no live one of takes: a deleted one that last carried
    what names it (``back``), brought back — the one it derives first; else the id it derives,
    as an import mints it, unless another entity holds that; else a new v7."""
    if derived in back:
        return derived
    if len(back) == 1:
        return next(iter(back))
    return derived if derived and derived not in held else new_entity_id()


# Above this many edges the containment-loop pass runs in a thread, off the event loop.
_CYCLE_THREAD_MIN = 5000


def _containment_cycle_edges(edges: Sequence[Tuple[str, str, str]],
                             checks: Sequence[Tuple[str, str, str]]) -> set:
    """The ids in *checks* — ``(edge_id, parent, child)`` — whose edge closes a containment
    loop in *edges* (the same shape, the checked edges included): the child is an ancestor of
    the parent once every version of the edge itself is set aside. O(V+E).

    An edge whose ends sit in different strongly connected components is on no loop. Inside
    one, an edge with no other version in *edges* always is: a shortest way back from its child
    to its parent never runs along the edge itself. Only a re-pointed edge — its stored version
    still listed beside the new one — needs a search that sets both aside."""
    adj: Dict[str, List[Tuple[str, str]]] = {}
    versions: Dict[str, int] = {}
    for eid, a, b in edges:
        if a and b:
            adj.setdefault(a, []).append((eid, b))
            adj.setdefault(b, [])
            versions[eid] = versions.get(eid, 0) + 1
    comp = _strongly_connected(adj)
    out: set = set()
    for eid, a, b in checks:
        ca = comp.get(a)
        if a == b or ca is None or ca != comp.get(b):
            continue
        if versions.get(eid, 0) <= 1:
            out.add(eid)
            continue
        seen, stack = {b}, [b]
        while stack and eid not in out:
            for oeid, m in adj[stack.pop()]:
                if oeid == eid or m in seen or comp.get(m) != ca:
                    continue
                if m == a:
                    out.add(eid)
                    break
                seen.add(m)
                stack.append(m)
    return out


def _strongly_connected(adj: Mapping[str, Sequence[Tuple[str, str]]]) -> Dict[str, int]:
    """Tarjan's strongly connected components, iteratively (a hierarchy can be deeper than
    Python's recursion limit): node → component number."""
    index: Dict[str, int] = {}
    low: Dict[str, int] = {}
    on_stack: set = set()
    stack: List[str] = []
    comp: Dict[str, int] = {}
    counter = ncomp = 0
    for root in adj:
        if root in index:
            continue
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        work = [(root, 0)]
        while work:
            v, i = work[-1]
            nbrs = adj[v]
            if i < len(nbrs):
                work[-1] = (v, i + 1)
                w = nbrs[i][1]
                if w not in index:
                    index[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, 0))
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
                continue
            work.pop()
            if work:
                u = work[-1][0]
                low[u] = min(low[u], low[v])
            if low[v] == index[v]:
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp[w] = ncomp
                    if w == v:
                        break
                ncomp += 1
    return comp


# asyncpg caps bind parameters at 32767 (signed int16) per statement — stricter than
# PostgreSQL's own 65535. Stay under it with headroom. A multi-row INSERT costs
# rows × columns params.
_PG_MAX_BIND_PARAMS = 32000

# Max ids in a single ``... IN (:ids)`` predicate (the list dominates the param count;
# a handful of fixed predicates add the rest) — keeps a cascade's bounded reads safe.
_IN_LIST_MAX = 20000
# Nodes, by id, whose names :meth:`GraphVersioningService.schema_counts` samples per type.
_SCHEMA_SAMPLE_ROWS = 50_000
# Graphs whose schema counts this process keeps, for their head at the time (least recent out first).
_SCHEMA_COUNTS_KEPT = 64
_schema_counts_cache: "OrderedDict[Tuple[str, int], Dict[str, object]]" = OrderedDict()

# Data sources per round of ``main_heads``: its head-commit read binds four parameters per graph.
_HEADS_PER_READ = _PG_MAX_BIND_PARAMS // 5

# Rows per statement where a draft's first read builds its overlay (``_head_index``): the read runs
# on the web process's event loop, and each statement's rows are turned into Python objects there
# in one uninterrupted step — 20k at a time was a few hundred milliseconds of nothing else served.
_HEAD_PAGE = 5000

#: This process's change indexes (change_index.py), bounded by the entries they hold together.
_CHANGE_INDEXES = IndexCache(lambda: config.CHANGE_INDEX_CACHE_ENTRIES)
#: History calendars by (graph, main head, time zone, view): a new revision moves the head, so an
#: answer is never served for a head it was not counted at.
_HISTORY_MONTHS: "OrderedDict[tuple, Dict[str, object]]" = OrderedDict()
_HISTORY_MONTHS_KEPT = 256
#: Bounds every statement of a session a person waits on (``_bounded_session``). SET LOCAL takes
#: no parameter; set_config(..., is_local => true) is SET LOCAL, and keeps the value bound.
_STATEMENT_TIMEOUT = text("SELECT set_config('statement_timeout', :ms, true)")
_QUERY_CANCELED = "57014"
#: Contributors a window's summary names; past this it counts them.
_WINDOW_CONTRIBUTORS_LISTED = 50


def _add_draft_page(builder: ChangeIndexBuilder, heads: Mapping[str, "_Head"],
                    before: Mapping[str, "_Stored"]) -> None:
    """A page of a draft's heads into its change index: each against ``main`` at the branch
    point, a head that is not live as gone. Pure CPU, run in a thread."""
    builder.add_pairs((eid, before.get(eid), h if h.live else None) for eid, h in heads.items())


def _counted_tree_summary(index: ChangeIndex, changed: int) -> Dict[str, object]:
    """The Changes tree's summary (``DiffSummaryResponse``) of an origin too large to lay out
    as a tree — no groups, its counts from the change index, ``tooLarge`` naming the tree's cap
    — so the panel says how much changed and lists it from ``/graphs/{gid}/diff/entries``."""
    return {"groups": [], "groupTotal": 0, "counts": dict(index.counts),
            "entityCounts": dict(index.entity_counts or {}), "edgeCounts": dict(index.edge_counts or {}),
            "impact": dict(index.impact),
            "tooLarge": {"changed": changed, "limit": config.DIFF_TREE_MAX_CHANGES}}


def _add_window_chunk(builder: ChangeIndexBuilder, ids: Sequence[str],
                      before: Mapping[str, "_Stored"], after: Mapping[str, "_Stored"]) -> None:
    """A chunk of the entities a window of ``main`` touched into its change index, each as it
    was at the window's start and at its end. Pure CPU, run in a thread."""
    builder.add_pairs((eid, before.get(eid), after.get(eid)) for eid in ids)

# Upper bound on a single cascade-delete's containment subtree, so a pathological graph
# can't run unbounded. Generous; the chunked writes handle the volume.
_CASCADE_MAX_NODES = 1_000_000


def _rows_per_insert(dicts: List[dict]) -> int:
    """Rows per multi-row INSERT so rows × columns stays under the bind-param cap.
    Bounded by ``INGEST_BATCH_SIZE`` so it never exceeds the configured batch size."""
    ncols = len(dicts[0]) if dicts else 1
    return max(1, min(config.INGEST_BATCH_SIZE, _PG_MAX_BIND_PARAMS // ncols))


def _most_commits_first(commits: Iterable[Tuple[str, int]]) -> List[str]:
    """The actors of ``(actor, commit_seq)`` pairs, most commits first, then the latest."""
    count: Dict[str, int] = {}
    latest: Dict[str, int] = {}
    for actor, seq in commits:
        count[actor] = count.get(actor, 0) + 1
        latest[actor] = max(latest.get(actor, 0), seq)
    return sorted(count, key=lambda a: (-count[a], -latest[a]))


def _delta_stats(deltas: List[Delta]) -> dict:
    out = {"create": 0, "update": 0, "delete": 0}
    for d in deltas:
        out[d.op] += 1
    return out


def _plan_squash(
    heads: Mapping[str, "_Head"], main: Mapping[str, "_Stored"], gone: Collection[str],
    reread: Callable[["_Head"], bool],
) -> Tuple[List["_SquashRow"], List[str]]:
    """The narrow squash's plan: ``net_delta(main, draft)`` over the entities a draft changed, told
    from content hashes alone. ``heads`` are the draft's (:meth:`_head_index`), ``main`` its
    live values at the same seq (:meth:`_hashes_at`), ``gone`` the draft's live entities the
    squash deletes all the same (edges on a node it deleted). Returns ``(rows, reread)``: the rows
    to write, and the live entities ``reread`` picks whose payload must be read to decide (a type
    the ontology spells differently) — in entity order."""
    rows: List[_SquashRow] = []
    lane: List[str] = []
    for eid in sorted(heads):
        h = heads[eid]
        b = main.get(eid)
        live = h.live and bool(h.table) and eid not in gone
        if live and reread(h):
            lane.append(eid)
        elif live and b is None:
            rows.append(_SquashRow(eid, h.table, "create", h.version_id, None, h.content_hash))
        elif not live and b is not None:
            rows.append(_SquashRow(eid, h.kind, "delete", None, b.content_hash, _HASH_NONE))
        elif live and b.content_hash != h.content_hash:
            rows.append(_SquashRow(eid, h.table, "update", h.version_id, b.content_hash, h.content_hash))
    return rows, lane


def _written_values(copies: Sequence["_SquashRow"], heads: Mapping[str, "_Head"],
                    deltas: Sequence[Delta]) -> Dict[str, Optional[dict]]:
    """What a narrow squash writes, in entity order as the gates judge it: a copied row's value as
    its identity columns give it (:func:`_head_skeleton`), a delta's payload."""
    written: Dict[str, Optional[dict]] = {r.entity_id: _head_skeleton(heads[r.entity_id])
                                          for r in copies}
    written.update({d.entity_id: d.payload for d in deltas})
    return {eid: written[eid] for eid in sorted(written)}


def _head_skeleton(h: "_Head") -> dict:
    """A head's value as its version row's identity columns give it — :meth:`_skeletons_at`'s
    shape, plus a node's displayName, which the gate's messages name it by."""
    if h.table == "edge":
        return {k: v for k, v in (("edgeType", h.type), ("sourceEntityId", h.src),
                                  ("targetEntityId", h.tgt)) if v}
    return {k: v for k, v in (("urn", h.urn), ("entityType", h.type), ("displayName", h.name))
            if v is not None}


def _deltas_to_diff_vs_main(
    deltas: List[Delta], theirs: Mapping[str, Optional[dict]],
) -> Dict[str, list]:
    """Reshape a squash (``net_delta(theirs, merged)``) into the UI's
    ``DiffVsMainResponse`` shape — added/removed/modified with whole-payload
    before/after, exactly what :meth:`diff_branch_vs_base` emits — so a PR's Files
    Changed renders through the identical canvas/diff overlay. ``before`` is the
    target-side payload (``theirs``; a delete carries ``payload=None``, so its before
    must come from here); ``after`` is the merged payload."""
    added: List[dict] = []
    removed: List[dict] = []
    modified: List[dict] = []
    for d in deltas:
        before = theirs.get(d.entity_id)
        kind = "edge" if _is_edge_payload(d.payload or before or {}) else "node"
        if d.op == "create":
            added.append({"entityId": d.entity_id, "kind": kind, "after": d.payload})
        elif d.op == "delete":
            removed.append({"entityId": d.entity_id, "kind": kind, "before": before})
        else:
            modified.append({"entityId": d.entity_id, "kind": kind, "before": before, "after": d.payload})
    return {"added": added, "removed": removed, "modified": modified}


# --------------------------------------------------------------------------- #
# Hierarchical diff — reshape a flat squash into a lazy-loadable containment    #
# tree for the review UIs (canvas Changes panel + PR Files Changed). Pure /     #
# in-memory over two materialised states, so it is unit-testable without a DB.  #
# --------------------------------------------------------------------------- #
_OP_STATUS = {"create": "added", "update": "modified", "delete": "removed"}


def _build_diff_hierarchy(
    merged: Mapping[str, Optional[dict]],
    theirs: Mapping[str, Optional[dict]],
    containment_edge_types,
) -> dict:
    """Index a flat squash (``net_delta(theirs, merged)``) as a containment tree.

    Changed nodes nest under their real containment parent, walked up to a root; a change with
    no containment parent appears as its OWN top-level row (consistently named, whether or not it
    has changed descendants); a non-containment edge change is bucketed by edgeType.
    Containment-edge changes are *structural* — implied by their child node's
    create/delete — so they count toward the global totals but never get their own row. The PR
    path passes full merge states (every container present); the branch path passes its changes
    plus the unchanged ancestor skeleton. O(changed + containment edges in the states).

    Returns an index consumed by :func:`_hierarchy_summary_view` / `_hierarchy_children_view`.
    """
    cset = {t.upper() for t in (containment_edge_types or [])}
    deltas = net_delta(theirs, merged)
    delta_by_eid: Dict[str, Delta] = {d.entity_id: d for d in deltas}

    def payload_of(eid: str) -> dict:
        p = merged.get(eid)
        return (p if p is not None else theirs.get(eid)) or {}

    def is_edge(eid: str) -> bool:
        return _is_edge_payload(payload_of(eid))

    # child -> parent from containment edges (theirs first so merged wins on a reparent; a
    # deleted edge survives only in theirs, keeping a deleted child under its old parent).
    parent_of: Dict[str, str] = {}
    for state in (theirs, merged):
        for p in state.values():
            if not p or not _is_edge_payload(p):
                continue
            if (p.get("edgeType") or "").upper() not in cset:
                continue
            src = p.get("sourceEntityId") or p.get("source_entity_id")
            tgt = p.get("targetEntityId") or p.get("target_entity_id")
            if src and tgt:
                parent_of[tgt] = src

    changed_nodes = [eid for eid in delta_by_eid if not is_edge(eid)]
    changed_edges = [eid for eid in delta_by_eid if is_edge(eid)]

    def ancestors(eid: str) -> List[str]:
        chain: List[str] = []
        cur = parent_of.get(eid)
        while cur is not None and cur not in chain and len(chain) < 64:
            chain.append(cur)
            cur = parent_of.get(cur)
        return chain

    # relevant tree nodes = changed nodes + their (possibly unchanged) containment ancestors
    relevant: set = set(changed_nodes)
    for eid in changed_nodes:
        relevant.update(ancestors(eid))

    children_of: Dict[str, List[str]] = {}              # forest: each node has ≤1 parent
    for eid in relevant:
        par = parent_of.get(eid)
        if par in relevant:
            children_of.setdefault(par, []).append(eid)

    buckets: Dict[str, List[str]] = {}
    roots: List[str] = []
    for eid in relevant:
        if parent_of.get(eid) in relevant:
            continue                                     # nested under a relevant container
        if eid in children_of:
            roots.append(eid)                            # top-level container w/ changed descendants
        else:                                            # parent-less changed leaf → type bucket (scale)
            buckets.setdefault("type:" + (payload_of(eid).get("entityType") or "Other"), []).append(eid)
    for eid in changed_edges:
        p = payload_of(eid)
        if (p.get("edgeType") or "").upper() in cset:
            continue                                     # structural containment edge — suppressed
        buckets.setdefault("edge:" + (p.get("edgeType") or "Relationship"), []).append(eid)

    # A SINGLE-member bucket reads better as that entity by name — so a lone changed domain shows
    # by name (consistent with a changed container that has children), while only genuinely large
    # same-type groups stay bucketed. This also bounds the top level: a flat graph with no
    # containment would otherwise promote every changed node to its own (truncatable) root.
    for key in list(buckets):
        if len(buckets[key]) == 1:
            roots.append(buckets.pop(key)[0])

    # per-container rollup of changed-node counts (memoised DFS over the forest)
    subtree: Dict[str, dict] = {}

    def rollup(eid: str) -> dict:
        if eid in subtree:
            return subtree[eid]
        c = {"added": 0, "modified": 0, "removed": 0}
        d = delta_by_eid.get(eid)
        if d is not None and not is_edge(eid):
            c[_OP_STATUS[d.op]] += 1
        for ch in children_of.get(eid, ()):
            cc = rollup(ch)
            for k in c:
                c[k] += cc[k]
        subtree[eid] = c
        return c

    def node_view(eid: str) -> dict:
        d = delta_by_eid.get(eid)
        child = children_of.get(eid, [])
        p = payload_of(eid)
        single = {"added": 0, "modified": 0, "removed": 0}
        if d is not None:
            single[_OP_STATUS[d.op]] += 1
        if is_edge(eid):                                  # edge change → "source → target" + edgeType
            src = p.get("sourceEntityId") or p.get("source_entity_id") or "?"
            tgt = p.get("targetEntityId") or p.get("target_entity_id") or "?"
            label = f"{payload_of(src).get('displayName') or src} → {payload_of(tgt).get('displayName') or tgt}"
            entity_type = p.get("edgeType")
        else:
            label = p.get("displayName") or p.get("urn") or eid
            entity_type = p.get("entityType")
        return {
            "key": eid,
            "kind": "container" if child else "leaf",
            "entityKind": "edge" if is_edge(eid) else "node",
            "label": label,
            "entityType": entity_type,
            "status": _OP_STATUS[d.op] if d else "unchanged",
            "counts": rollup(eid) if child else single,
            "childTotal": len(child),
            "deleted": bool(d and d.op == "delete"),
            "before": theirs.get(eid),
            "after": merged.get(eid),
        }

    def bucket_view(key: str) -> dict:
        members = buckets[key]
        c = {"added": 0, "modified": 0, "removed": 0}
        for m in members:
            d = delta_by_eid.get(m)
            if d:
                c[_OP_STATUS[d.op]] += 1
        kind, _, name = key.partition(":")
        return {
            "key": key, "kind": "bucket", "entityKind": "edge" if kind == "edge" else "node",
            "label": name,
            "entityType": name if kind == "type" else None,
            "status": None, "counts": c, "childTotal": len(members),
            "deleted": False, "before": None, "after": None,
        }

    root_views = sorted(
        (node_view(e) for e in roots),
        key=lambda g: (-sum(g["counts"].values()), g["label"].lower()),
    )
    bucket_views = sorted((bucket_view(k) for k in buckets), key=lambda g: g["label"].lower())

    # Split the change tally into entities (nodes) vs relationships (non-containment edges) so the
    # UI can show both dimensions clearly. Containment edges are structural (suppressed in the tree)
    # and counted only in the grand total. ``impact`` stays an entityType rollup for the entity line.
    counts = {"added": 0, "modified": 0, "removed": 0}
    entity_counts = {"added": 0, "modified": 0, "removed": 0}
    edge_counts = {"added": 0, "modified": 0, "removed": 0}
    for d in deltas:
        st = _OP_STATUS[d.op]
        counts[st] += 1
        if is_edge(d.entity_id):
            if (payload_of(d.entity_id).get("edgeType") or "").upper() not in cset:
                edge_counts[st] += 1                       # relationship (non-containment) edge
        else:
            entity_counts[st] += 1
    impact: Dict[str, int] = {}
    for eid in relevant:
        et = payload_of(eid).get("entityType") or "Other"
        impact[et] = impact.get(et, 0) + 1

    return {
        "top": root_views + bucket_views,
        "counts": counts,
        "entity_counts": entity_counts,
        "edge_counts": edge_counts,
        "impact": impact,
        "children_of": children_of,
        "buckets": buckets,
        "node_view": node_view,
    }


def _hierarchy_summary_view(index: dict, limit: int) -> dict:
    """Top-level groups (capped) + global counts + entity/relationship split + entityType impact."""
    top = index["top"]
    return {
        "groups": top[: max(0, limit)],
        "groupTotal": len(top),
        "counts": index["counts"],
        "entityCounts": index["entity_counts"],
        "edgeCounts": index["edge_counts"],
        "impact": index["impact"],
    }


def _hierarchy_children_view(index: dict, key: str, limit: int, offset: int) -> dict:
    """One group's direct children (a page) — containers first, then leaves, label-ordered."""
    member_eids = index["children_of"].get(key) or index["buckets"].get(key) or []
    views = [index["node_view"](e) for e in member_eids]
    views.sort(key=lambda v: (0 if v["kind"] == "container" else 1, v["label"].lower(), v["key"]))
    return {"entries": views[offset: offset + max(0, limit)], "total": len(views)}
