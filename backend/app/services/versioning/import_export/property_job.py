"""Bulk property jobs: one property operation over many entities of a draft, run on the transfer lane.

A job is ONE operation (``op``) — ``set``, ``fillEmpty``, ``remove``, ``rename`` or ``copy`` of one
property key — over a target: up to ``PROPERTY_JOB_MAX_IDS`` entities named by id (their urns, or
``gv:<entity id>`` as the canvas names them), or every entity an Advanced Search predicate matches
in a view (``PROPERTY_JOB_MAX_TARGETS`` at most). It writes only to its draft, never to main.

An EDGE job (``entityKind`` ``edge``) is the same over relationships: named by id (an edge's own,
or ``source|TYPE|target`` as a Connections search names one without), or every edge a Connections
search matches (:func:`read_edge_targets`). A roll-up is never edited: it is refused ``derived``.

Its targets are kept as chunk files in the object store, ``property-jobs/{job}/targets/{i}.ndjson``,
``PROPERTY_JOB_WINDOW`` keys each: an id target's are written when the job is made; a search
target's by the job itself, from an export of the search (the injected ``targets`` hook). Each chunk
is then one WINDOW: its entities read from the draft as they stand, a properties patch planned for
each (:func:`plan_patch`), and the patches written as ONE commit — with the job's checkpoint (its
cursor, progress and running summary) in the same transaction, as an import window is. So the job
resumes where it stopped after a takeover, a window is never written twice, and a cancel (the row
no longer running) stops it at its next checkpoint, keeping the windows already written. Cursor:

  ``NULL``       a search target not resolved yet;
  ``apply:<i>``  the windows before chunk ``i`` written (``apply:0``: none yet).

What a window could not write as asked is kept in ``property-jobs/{job}/refused/{i}.ndjson`` (the
job's refused rows, as CSV through the API) and counted in the summary by reason: ``missing`` (no
such entity in the draft), ``deleted_in_draft``, ``conflict`` (a rename or copy whose new key is
held already, skipped), ``write_refused`` (the write gate turned it away; the window's other
entities are written, as an import's are) and, for an edge job, ``derived`` (a roll-up).
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, Iterable, List, Mapping, NamedTuple, Optional, Tuple

from sqlalchemy import select

from backend.app.services.storage.object_store import storage_key
from backend.common.derived_artifacts import is_derived_edge_type
from backend.common.property_patch import PROP_DELETE

from .. import config, db
from ..change_csv import cell
from ..errors import BranchNotOpen
from ..job_lease import Lease, Superseded
from ..models import BranchORM, CommitORM, JobORM
from ..service import OntologyViolation
from .snapshot import Snapshot, Winner, open_snapshot
from .stream import resolve_placements

logger = logging.getLogger(__name__)

KINDS = ("set", "fillEmpty", "remove", "rename", "copy")
#: The refused rows a job's summary shows; every one is in its refused files.
REFUSED_EXAMPLES = 20
#: Times a window's other entities are written again after the write gate refused some of them
#: (the gate stops at its first failing check), as an import window's are.
_QUARANTINE_ROUNDS = 4
_DETAIL_CHARS = 300
#: What a job's summary counts, before its first window.
COUNTERS = ("changed", "unchanged", "missing", "deletedInDraft", "conflicts")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_summary(chunks: int = 0) -> Dict[str, Any]:
    return {**dict.fromkeys(COUNTERS, 0), "refused": {"count": 0, "byReason": {}, "examples": []},
            "commits": 0, "firstCommitId": None, "lastCommitId": None, "chunks": chunks}


# --------------------------------------------------------------------------- #
# The plan: what one operation does to one entity's properties (pure)          #
# --------------------------------------------------------------------------- #
def _empty(value: Any) -> bool:
    return value is None or value == ""


def _same(a: Any, b: Any) -> bool:
    """Equal as stored: ``1``, ``1.0`` and ``True`` are three values."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def plan_patch(op: Mapping[str, Any], props: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The properties patch ``op`` makes to an entity holding ``props`` — a removal as
    :data:`PROP_DELETE` — or ``None`` when it changes nothing:

    * ``set`` writes ``value``, unless the entity holds it already;
    * ``fillEmpty`` writes ``value`` only where the key is absent, null or ``''``;
    * ``remove`` removes the key, where it is held;
    * ``rename`` moves the key's value to ``to`` and removes the key; ``copy`` keeps the key. An
      entity without the key is left as it is, and so is one that holds ``to`` already (a conflict,
      :func:`is_conflict`) unless ``onConflict`` is ``overwrite``."""
    kind, key = op["kind"], op["key"]
    if kind == "set":
        return None if key in props and _same(props[key], op["value"]) else {key: op["value"]}
    if kind == "fillEmpty":
        return {key: op["value"]} if _empty(props.get(key)) else None
    if kind == "remove":
        return {key: PROP_DELETE} if key in props else None
    to = op["to"]
    if key not in props or is_conflict(op, props):
        return None
    patch = {} if to in props and _same(props[to], props[key]) else {to: props[key]}
    if kind == "rename":
        patch[key] = PROP_DELETE
    return patch or None


def is_conflict(op: Mapping[str, Any], props: Mapping[str, Any]) -> bool:
    """A rename or copy that skips an entity because it holds the new key already."""
    return (op["kind"] in ("rename", "copy") and op["key"] in props and op["to"] in props
            and op.get("onConflict", "skip") != "overwrite")


def describe(op: Mapping[str, Any]) -> str:
    """The operation as its commits name it."""
    key, to = op["key"], op.get("to")
    return {"set": f"Set {key}", "fillEmpty": f"Fill {key} where empty", "remove": f"Remove {key}",
            "rename": f"Rename {key} → {to}", "copy": f"Copy {key} → {to}"}[op["kind"]]


def window_message(op: Mapping[str, Any], message: Optional[str], window: int, windows: int) -> str:
    return f"{message or 'Bulk property: ' + describe(op)} ({window}/{windows})"


class Planned(NamedTuple):
    ops: List[Dict[str, Any]]
    counts: Dict[str, int]
    refused: List[Dict[str, Any]]


def plan_window(op: Mapping[str, Any], found: Mapping[str, Tuple[str, Dict[str, Any], Optional[str]]],
                entity_kind: str = "node") -> Planned:
    """A window's update ops, from what its keys found (``key -> (entity id, properties, urn)``):
    one an entity, however many of its keys name it — ``entity_kind`` ``edge`` for an edge job. Pure."""
    ops: List[Dict[str, Any]] = []
    counts = dict.fromkeys(COUNTERS, 0)
    refused: List[Dict[str, Any]] = []
    seen = set()
    for key, (eid, props, urn) in found.items():
        if eid in seen:
            counts["unchanged"] += 1
            continue
        seen.add(eid)
        patch = plan_patch(op, props)
        if patch is not None:
            ops.append({"op": "update", "entity_kind": entity_kind, "entity_id": eid,
                        "payload": {"properties": patch}})
            counts["changed"] += 1
        elif is_conflict(op, props):
            counts["conflicts"] += 1
            refused.append(_refused(urn or key, eid, "conflict", f"It already has {op['to']}."))
        else:
            counts["unchanged"] += 1
    return Planned(ops, counts, refused)


def _refused(urn: Optional[str], eid: Optional[str], reason: str, detail: str) -> Dict[str, Any]:
    return {"urn": urn, "entityId": eid, "reason": reason, "detail": detail[:_DETAIL_CHARS]}


# --------------------------------------------------------------------------- #
# Reading a window's entities from the draft                                    #
# --------------------------------------------------------------------------- #
async def read_targets(snap: Snapshot, keys: Iterable[str]):
    """What ``keys`` name in the draft ``snap`` reads: ``key -> (entity id, properties, urn)`` for
    those live there; ``key -> entity id`` for those main holds and the draft deleted; and the keys
    neither holds. A key is an entity's urn or ``gv:<entity id>``; one whose urn the draft changed
    is found by what main calls it."""
    keys = list(dict.fromkeys(k for k in keys if k))
    at = await resolve_placements(snap, keys)
    rest = [k for k in keys if k not in at]
    deleted: Dict[str, str] = {}
    missing: List[str] = []
    if rest and snap.is_draft:
        on_main = await resolve_placements(snap.main_at_base(), rest)
        live = await snap.lookup_live("node", set(on_main.values()))
        for k in rest:
            eid = on_main.get(k)
            if eid is None:
                missing.append(k)
            elif eid in live:
                at[k] = eid
            else:
                deleted[k] = eid
    else:
        missing = rest
    winners = await snap.lookup_live("node", set(at.values()), payload=True)

    def parse() -> Dict[str, Tuple[str, Dict[str, Any], Optional[str]]]:
        out = {}
        for k, eid in at.items():
            w = winners.get(eid)
            if w is None:                       # gone between the two reads
                missing.append(k)
                continue
            payload = json.loads(w.payload) if w.payload else {}
            out[k] = (eid, dict(payload.get("properties") or {}), w.urn)
        return out

    return await asyncio.to_thread(parse), deleted, missing


def _triple(key: str) -> Optional[Tuple[str, str, str]]:
    """``(source urn, type, target urn)`` of a ``source|TYPE|target`` key — how a Connections
    search names an edge that has no id of its own — or None."""
    parts = key.split("|")
    return (parts[0], parts[1], parts[2]) if len(parts) == 3 and all(parts) else None


async def _edges_at(snap: Snapshot, keys: List[str]) -> Dict[str, str]:
    """``key -> entity id`` of the live edge each key names in ``snap``: its id — or ``edge:<id>``,
    the id a graph copied in gave an edge whose id a node held (the graph still calls it ``<id>``) —
    else, for ``source|TYPE|target``, the edge of that type between the nodes those urns name."""
    live = await snap.lookup_live("edge", set(keys) | {f"edge:{k}" for k in keys})
    at = {k: k if k in live else f"edge:{k}" for k in keys if k in live or f"edge:{k}" in live}
    triples = {k: t for k in keys if k not in at and (t := _triple(k)) is not None}
    if triples:
        nodes = await snap.nodes_by_urn({u for s, _t, g in triples.values() for u in (s, g)})
        between = await snap.edges_between({nodes[s] for s, _t, _g in triples.values() if s in nodes},
                                           {nodes[g] for _s, _t, g in triples.values() if g in nodes})
        by_type = {(s, g, t.upper()): eid for (s, g, t), eid in between.items()}
        for k, (s, t, g) in triples.items():
            eid = by_type.get((nodes.get(s), nodes.get(g), t.upper()))
            if eid is not None:
                at[k] = eid
    return at


async def edge_winners(snap: Snapshot, keys: Iterable[str]):
    """What ``keys`` name in the draft ``snap`` reads, as edges (:func:`_edges_at`): ``key -> its
    winner`` (with its payload) for the edges live there; ``key -> entity id`` for those main
    holds and the draft deleted; and the keys neither holds."""
    keys = list(dict.fromkeys(k for k in keys if k))
    at = await _edges_at(snap, keys)
    rest = [k for k in keys if k not in at]
    deleted: Dict[str, str] = {}
    missing: List[str] = []
    if rest and snap.is_draft:
        on_main = await _edges_at(snap.main_at_base(), rest)
        live = await snap.lookup_live("edge", set(on_main.values()))
        for k in rest:
            eid = on_main.get(k)
            if eid is None:
                missing.append(k)
            elif eid in live:
                at[k] = eid
            else:
                deleted[k] = eid
    else:
        missing = rest
    winners = await snap.lookup_live("edge", set(at.values()), payload=True)
    found: Dict[str, Winner] = {}
    for k, eid in at.items():
        if eid in winners:
            found[k] = winners[eid]
        else:                                   # gone between the two reads
            missing.append(k)
    return found, deleted, missing


async def read_edge_targets(snap: Snapshot, keys: Iterable[str]):
    """:func:`read_targets` for an edge job: ``key -> (entity id, properties, None)`` for the edges
    live in the draft, those it deleted, the keys that name none — and ``key -> entity id`` for
    the roll-ups among them (``derived``: a summary the aggregation job computes, never edited)."""
    winners, deleted, missing = await edge_winners(snap, keys)

    def parse():
        found: Dict[str, Tuple[str, Dict[str, Any], Optional[str]]] = {}
        derived: Dict[str, str] = {}
        for k, w in winners.items():
            if is_derived_edge_type(w.edge_type or ""):
                derived[k] = w.entity_id
                continue
            payload = json.loads(w.payload) if w.payload else {}
            found[k] = (w.entity_id, dict(payload.get("properties") or {}), None)
        return found, derived

    found, derived = await asyncio.to_thread(parse)
    return found, deleted, missing, derived


# --------------------------------------------------------------------------- #
# Chunk files                                                                  #
# --------------------------------------------------------------------------- #
def targets_key(job_id: str, i: int) -> str:
    return storage_key("property-jobs", job_id, "targets", f"{i}.ndjson")


def refused_key(job_id: str, i: int) -> str:
    return storage_key("property-jobs", job_id, "refused", f"{i}.ndjson")


async def _once(data: bytes):
    yield data


async def write_lines(store, key: str, items: Iterable[Any]) -> None:
    await store.put_stream(key, _once(b"".join(json.dumps(x).encode("utf-8") + b"\n" for x in items)))


async def read_lines(store, key: str) -> List[Any]:
    data = b"".join([c async for c in store.open_stream(key)])
    return [json.loads(line) for line in data.split(b"\n") if line.strip()]


async def write_targets(store, job_id: str, keys: Iterable[str], *, start: int = 0) -> int:
    """``keys`` as chunk files from chunk ``start``, ``PROPERTY_JOB_WINDOW`` a file; returns how
    many were written."""
    keys, size, n = list(keys), max(1, config.PROPERTY_JOB_WINDOW), 0
    for at in range(0, len(keys), size):
        await write_lines(store, targets_key(job_id, start + n), keys[at:at + size])
        n += 1
    return n


async def refused_csv(store, job_id: str, chunks: int) -> AsyncIterator[bytes]:
    """A job's refused rows as CSV — urn, entityId, reason, detail — window by window, each cell
    defused against spreadsheet formulas."""
    def rows(items) -> bytes:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\r\n")
        for item in items:
            writer.writerow(item)
        return buf.getvalue().encode("utf-8")

    yield rows([["urn", "entityId", "reason", "detail"]])
    for i in range(chunks):
        key = refused_key(job_id, i)
        if not (await store.stat(key)).exists:
            continue
        yield rows([[cell(r.get("urn")), cell(r.get("entityId")), cell(r.get("reason")), cell(r.get("detail"))]
                    for r in await read_lines(store, key)])


# --------------------------------------------------------------------------- #
# The worker                                                                   #
# --------------------------------------------------------------------------- #
class PropertyJobStopped(Exception):
    """The job can't go on, for a reason the person can act on (``code``; ``action``, if any)."""

    def __init__(self, message: str, code: str, action: Optional[str] = None):
        super().__init__(message)
        self.code, self.action = code, action


def _tally(summary: Mapping[str, Any], counts: Mapping[str, int], refused: List[Dict[str, Any]],
           commit_id: Optional[str]) -> Dict[str, Any]:
    """The running summary with one window's counts, refused rows and commit added."""
    out = dict(summary)
    for name in COUNTERS:
        out[name] = int(out.get(name) or 0) + counts.get(name, 0)
    report = dict(out.get("refused") or {"count": 0, "byReason": {}, "examples": []})
    by_reason = dict(report.get("byReason") or {})
    for row in refused:
        by_reason[row["reason"]] = by_reason.get(row["reason"], 0) + 1
    examples = list(report.get("examples") or [])
    examples += refused[:max(0, REFUSED_EXAMPLES - len(examples))]
    out["refused"] = {"count": int(report.get("count") or 0) + len(refused), "byReason": by_reason,
                      "examples": examples}
    if commit_id:
        out["commits"] = int(out.get("commits") or 0) + 1
        out["firstCommitId"] = out.get("firstCommitId") or commit_id
        out["lastCommitId"] = commit_id
    return out


class _Position(NamedTuple):
    cursor: Optional[str]
    summary: Dict[str, Any]
    processed: int
    total: int


class PropertyJobWorker:
    """Runs one bulk property job on its lease, from its cursor (see the module docstring).

    ``targets(job)`` — an async iterator of the keys a search target matches (injected at the API
    layer, which runs the search); ``write_context(job)`` — ``{ontology_rules, containment,
    node_identity}`` its windows are written with, as a save is."""

    def __init__(self, versioning, store, *, targets=None, write_context=None) -> None:
        self._svc = versioning
        self._store = store
        self._targets = targets
        self._write_context = write_context
        self._lease: Optional[Lease] = None

    async def run(self, job_id: str, *, lease: Lease) -> Dict[str, Any]:
        """Run the job to the end on ``lease``; returns its summary. Raises :class:`Superseded`
        once it is no longer this worker's (taken over, or cancelled)."""
        self._lease = lease
        job = await self._job(job_id)
        context = (await lease.retry_transient(lambda: self._write_context(job))
                   if self._write_context is not None else {})
        if (await self._position(job_id)).cursor is None:
            await lease.retry_transient(lambda: self._resolve(job_id, job))
        while await lease.retry_transient(lambda: self._next_window(job_id, job, context)):
            pass
        summary = (await self._position(job_id)).summary
        if not await lease.finish("completed", progress=100, summary=summary):
            raise Superseded(f"property job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        return summary

    async def _job(self, job_id: str) -> Dict[str, Any]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                raise ValueError(f"unknown property job {job_id}")
            return {**dict(row.field_scope or {}), "jobId": row.id, "graphId": row.graph_id,
                    "branchId": row.branch_id, "workspaceId": row.workspace_id,
                    "dataSourceId": row.data_source_id}

    async def _position(self, job_id: str) -> _Position:
        """Where the job has got, read afresh by every unit of work. Raises :class:`Superseded`
        when the row is no longer this worker's — taken over, or cancelled."""
        async with db.graphver_session() as s:
            row = (await s.execute(select(
                JobORM.last_cursor, JobORM.summary, JobORM.processed, JobORM.total,
                JobORM.retry_count, JobORM.status).where(JobORM.id == job_id))).one()
        if (row.retry_count, row.status) != (self._lease.epoch, "running"):
            raise Superseded(f"property job {job_id} (epoch {self._lease.epoch}) is no longer this "
                             "worker's")
        return _Position(row.last_cursor, dict(row.summary) if isinstance(row.summary, dict) else {},
                         row.processed or 0, row.total or 0)

    async def _resolve(self, job_id: str, job: Dict[str, Any]) -> None:
        """A search target's matches, as chunk files, then ``apply:0``. Run again whole when it
        stops part-way: the files are written over, and the search's export resumes as it is."""
        pos = await self._position(job_id)
        if pos.cursor is not None:
            return
        cap = config.PROPERTY_JOB_MAX_TARGETS
        keys: List[str] = []
        chunks = total = 0
        async for key in self._targets(job):
            keys.append(key)
            total += 1
            if total > cap:
                raise PropertyJobStopped(
                    f"The search matches more than {cap:,} entities, the most one job edits. Narrow "
                    "it, or split the edit into several jobs.", "too_many_targets")
            if len(keys) >= config.PROPERTY_JOB_WINDOW:
                chunks += await write_targets(self._store, job_id, keys, start=chunks)
                keys = []
                self._lease.check()
                async with db.graphver_session() as s:          # a fenced beat: a cancel stops here
                    await self._lease.checkpoint(s, expect_cursor=None, current_phase="resolve",
                                                 processed=total)
        chunks += await write_targets(self._store, job_id, keys, start=chunks)
        async with db.graphver_session() as s:
            await self._lease.checkpoint(s, expect_cursor=None, last_cursor="apply:0", total=total,
                                         processed=0, progress=0, current_phase="apply",
                                         summary={**pos.summary, "chunks": chunks})

    async def _next_window(self, job_id: str, job: Dict[str, Any], context: Dict[str, Any]) -> bool:
        """Write the window after the job's cursor; False once none is left."""
        pos = await self._position(job_id)
        i, chunks = int(pos.cursor.partition(":")[2]), int(pos.summary.get("chunks") or 0)
        if i >= chunks:
            return False
        graph_id, branch_id, op = job["graphId"], job["branchId"], job["op"]
        async with db.graphver_session() as s:
            status = await s.scalar(select(BranchORM.status).where(BranchORM.id == branch_id))
        if status != "open":
            raise self._closed(status, pos)
        keys = await read_lines(self._store, targets_key(job_id, i))
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
        kind = job.get("entityKind") or "node"
        if kind == "edge":
            found, deleted, missing, derived = await read_edge_targets(snap, keys)
        else:
            (found, deleted, missing), derived = await read_targets(snap, keys), {}
        ops, counts, refused = await asyncio.to_thread(plan_window, op, found, kind)
        counts["missing"] += len(missing)
        counts["deletedInDraft"] += len(deleted)
        refused += [_refused(k, eid, "deleted_in_draft", "Deleted in this draft.") for k, eid in deleted.items()]
        refused += [_refused(k, None, "missing", "Not in this draft.") for k in missing]
        refused += [_refused(k, eid, "derived", "A roll-up: change the relationships it summarises.")
                    for k, eid in derived.items()]
        message = window_message(op, job.get("message"), i + 1, chunks)
        processed = pos.processed + len(keys)
        started = _now()

        async def on_commit(s) -> None:
            # Recorded with the window, so a window that rolls back leaves no trace in the summary.
            commit_id = await _window_commit(s, graph_id, branch_id, message, started)
            if refused:
                await write_lines(self._store, refused_key(job_id, i), refused)
            else:
                await self._store.delete(refused_key(job_id, i))
            await self._lease.checkpoint(
                s, expect_cursor=pos.cursor, last_cursor=f"apply:{i + 1}", processed=processed,
                summary=_tally(pos.summary, counts, refused, commit_id), current_phase="apply",
                progress=min(99, processed * 100 // pos.total) if pos.total else 0)

        urns = {eid: urn or key for key, (eid, _props, urn) in found.items()}
        try:
            await self._apply(graph_id, branch_id, job["actor"], ops, counts, refused, urns,
                              message, on_commit, context)
        except BranchNotOpen as exc:
            raise self._closed(exc.status, pos) from exc
        return True

    @staticmethod
    def _closed(status: Optional[str], pos: _Position) -> PropertyJobStopped:
        n = int(pos.summary.get("commits") or 0)
        was = {"publishing": "being published"}.get(status or "", status or "closed")
        return PropertyJobStopped(
            f"The draft was {was} while this job ran, so it stopped. "
            f"{n} commit(s) it had written are in the draft's history; the rest was not edited.",
            "draft_closed")

    async def _apply(self, graph_id, branch_id, actor, ops, counts, refused, urns, message,
                     on_commit, context) -> None:
        """Write a window's ``ops`` as one commit with ``on_commit`` (alone when there are none).
        An entity the write gate refuses (:class:`OntologyViolation`) is left out and refused
        (``write_refused``), and the others are written again — up to ``_QUARANTINE_ROUNDS`` times;
        past them, or when a violation names an entity the window doesn't write, the window
        fails (resumable from its cursor)."""
        for attempt in range(_QUARANTINE_ROUNDS + 1):
            if not ops:
                async with db.graphver_session() as s:
                    await on_commit(s)
                return
            try:
                await self._svc.apply_ops(
                    graph_id=graph_id, branch_id=branch_id, ops=ops, actor=actor, message=message,
                    on_commit=on_commit, ontology_rules=context.get("ontology_rules"),
                    containment_edge_types=context.get("containment") or None,
                    node_identity=context.get("node_identity"))
                return
            except OntologyViolation as exc:
                reasons: Dict[str, List[str]] = {}
                for v in exc.violations or []:
                    reasons.setdefault(v.get("entity_id"), []).append(
                        str(v.get("reason") or v.get("rule") or "refused by the write gate"))
                written = {o["entity_id"] for o in ops}
                if attempt == _QUARANTINE_ROUNDS or not reasons or not set(reasons) <= written:
                    raise
                for o in ops:
                    if o["entity_id"] in reasons:
                        refused.append(_refused(urns.get(o["entity_id"]), o["entity_id"], "write_refused",
                                                "; ".join(reasons[o["entity_id"]])))
                counts["changed"] -= len(reasons)
                ops = [o for o in ops if o["entity_id"] not in reasons]
                logger.info("property job window: %d entit(ies) refused by the write gate, the other "
                            "%d written again", len(reasons), len(ops))


async def _window_commit(s, graph_id: str, branch_id: str, message: str, started: str) -> Optional[str]:
    """The commit this window wrote, in ``s`` (the window's transaction, the draft locked): the
    draft's head, when it is this window's — its message, written since the window began — and
    ``None`` when the window changed nothing."""
    head = (await s.get(BranchORM, branch_id)).head_commit_id
    row = (await s.execute(select(CommitORM.message, CommitORM.created_at).where(
        CommitORM.graph_id == graph_id, CommitORM.id == head))).first() if head else None
    return head if row is not None and row.message == message and row.created_at >= started else None
