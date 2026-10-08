"""A NEW data source seeded from a view package — the bootstrap job with ``origin='package'``.

"Create a new data source from this package" gives the package's data a home of its own: a
managed data source on a provider the user chose, with a graph name nothing else uses. The data
lands as the source's FIRST version on main, keeping the package's entity ids, by the same job
that enables version control on an existing graph (``bootstrap_worker``) — invisible until it is
proven, then live in one head flip. No draft, no publish:

  [reset →] counting → nodes → edges → validate → heads → merkle → index → project → finalize

What differs from copying a FalkorDB graph is where the data comes from and where it goes. This
module owns those phases; ``reset``, ``heads``, ``merkle`` and ``finalize`` are the bootstrap's.

* **counting** is a pre-flight of the two ends. The package's upload must still be there
  (``payload_missing`` — an abandoned or expired upload; the job's input is pinned against the
  sweep while it may run). The new key must be EMPTY (``target_not_empty``): a projection writes
  into it, and a key holding anything else would be someone's data, not ours. Only then does the
  job claim it (``summary.target.claimed``, ``owns_falkor_graph``) — a purge may drop a key the
  job claimed, never one it found occupied.
* **nodes / edges** read the package's NDJSON straight from the upload (``uploads.open_source``:
  inflated as it streams, its checksum verified at the end), ``PACKAGE_SEED_WINDOW`` lines a window.
  The cursor is the BYTE OFFSET of the next line (``nodes:<byte>``), so a resume re-reads from
  exactly where the last committed window ended; within one run the stream stays open. A window
  is parsed and converted in a worker thread — format 2 lines carry each stored payload whole,
  format 1 records go through the import's own reading (``rowmodel.normalize``,
  ``resolve._node_payload``/``_edge_payload``) — and its rows, tallies and cursor commit in ONE
  fenced transaction. Rows carry deterministic ids, so nothing is ever written twice.
* **validate** proves the copy before any of it is visible, and settles what the package may hold
  that a graph cannot: two entities sharing a type and urn would become ONE FalkorDB node. Nothing
  pre-existing is at stake — the target is empty, private and invisible until finalize — so they
  are collapsed deterministically, in SQL inside the import commit, and reported (D14).
* **index** creates the new key's urn indexes and waits for them, so every MERGE of the
  projection seeks instead of scanning a label per row.
* **project** writes the copy into the new key through the projector's own writer, in keyset
  windows, and proves FalkorDB holds what Postgres does.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional, Set, Tuple

from sqlalchemy import select, text

from backend.app.providers.index_policy import edge_index_ddl

from . import config
from .bootstrap_worker import (
    DUPLICATE_RULE,
    BootstrapFailure,
    BootstrapRunner,
    _add_reject_sample,
    _add_tally,
    _bump,
    _insert_versions,
    _normalize_synced_at,
    _percent,
    _PHASE_FLOOR,
    _same_tally,
    _t,
    _vid,
)
from .falkor_indexes import ensure_urn_indexes
from .ids import stable_prefixed_id
from .job_lease import Lease
from .merkle import content_hash
from .models import EdgeVersionORM, JobORM, NodeVersionORM, ProjectionStateORM, _now
from .projection import _READ_TIMEOUT_MS, _Pending, _q
from .reconcile import falkor_counts
from .service import _chunks, _sanitize_node_properties

logger = logging.getLogger(__name__)

# The phases this module runs for a package seed; the rest are the bootstrap's own.
OWN_PHASES = frozenset({"counting", "nodes", "edges", "validate", "index", "project"})

# Relationships the platform derives (the rollup layer): a package carries them only from an
# exporter that did not filter them, and the aggregation pipeline rebuilds them from raw edges.
_DERIVED_EDGE = "AGGREGATED"

# Which copy of a shared (type, urn) the collapse keeps — the bootstrap's rule, with the entity id
# standing in for the internal id: a package has no internal ids, and its entity ids are unique.
COLLAPSE_RULE = DUPLICATE_RULE.replace("internalId", "entityId")

# Groups of a collapse listed in the report (the counts are always whole).
_COLLAPSE_LISTED = 50

# The label the projector writes a node under (``_sanitize_label(entityType or "Entity")``), in SQL —
# two entities collide in FalkorDB when THIS and their urn agree.
_LABEL_SQL = ("regexp_replace(coalesce(nullif(entity_type, ''), 'Entity'), "
              "'[^[:alnum:]_]', '_', 'g')")


# --------------------------------------------------------------------------- #
# The data, as lines with their byte offsets                                   #
# --------------------------------------------------------------------------- #
class LineStream:
    """A package's NDJSON as ``(offset, line)`` pairs — ``offset`` is the byte the line starts at,
    which is what a cursor names. Opened at a cursor, it discards the bytes before it (the data is
    deflated, so there is nothing to seek); ``at`` is always where the next line starts, or the
    end of the data once ``eof``. A final line with no newline is still a line. Once its source
    has raised it is ``broken``: a source that raised is finished, and reading on would take that
    for the end of the data."""

    def __init__(self, chunks: AsyncIterator[bytes], at: int = 0):
        self._chunks = chunks
        self.at = at
        self._skip = at
        self._tail = b""
        self._lines: collections.deque = collections.deque()
        self.eof = False
        self.broken = False

    async def read(self, n: int) -> List[Tuple[int, bytes]]:
        """Up to ``n`` lines; fewer only at the end of the data."""
        out: List[Tuple[int, bytes]] = []
        while len(out) < n:
            if self._lines:
                line = self._lines.popleft()
                out.append((self.at, line))
                self.at += len(line) + 1
            elif self.eof:
                if self._tail:
                    out.append((self.at, self._tail))
                    self.at += len(self._tail)
                    self._tail = b""
                break
            else:
                await self._fill()
        return out

    async def _fill(self) -> None:
        try:
            chunk = await self._chunks.__anext__()
        except StopAsyncIteration:
            self.eof = True
            return
        except BaseException:
            self.broken = True
            raise
        if self._skip:
            if len(chunk) <= self._skip:
                self._skip -= len(chunk)
                return
            chunk, self._skip = chunk[self._skip:], 0
        # One split per chunk (C speed), never a slice of the buffer per line.
        parts = (self._tail + chunk).split(b"\n")
        self._tail = parts.pop()
        self._lines.extend(parts)

    async def aclose(self) -> None:
        aclose = getattr(self._chunks, "aclose", None)
        if aclose is not None:
            await aclose()


async def _stream_at(run: BootstrapRunner, ctx, payload_uri: str, at: int) -> LineStream:
    """The run's open stream, if it stands at ``at``; else a new one opened there (the old one —
    another phase's, one a window that rolled back read past, or a broken one — closed first: it
    holds a spooled copy of the upload)."""
    from .import_export.uploads import open_source

    if ctx.stream is not None and ctx.stream.at == at and not ctx.stream.broken:
        return ctx.stream
    if ctx.stream is not None:
        await ctx.stream.aclose()
    ctx.stream = LineStream(open_source(run._object_store(), payload_uri), at)
    return ctx.stream


# --------------------------------------------------------------------------- #
# A window's lines → version rows (pure; runs in a worker thread)              #
# --------------------------------------------------------------------------- #
@dataclass
class Window:
    """One window of lines, converted: the rows to insert and what happened to every line."""
    dicts: List[dict] = field(default_factory=list)
    lines: int = 0                     # lines of this phase's kind
    invalid: int = 0                   # of them, not something that can be stored
    other: int = 0                     # lines of neither kind, or not JSON (the nodes pass counts)
    derived: int = 0                   # edges: the platform's own rollups, never copied
    dupes: int = 0                     # the same entity id twice in this window
    dangling: int = 0                  # edges: an end that is no node of the package
    minted: int = 0                    # rows with no entity id, given a stable one
    first_edge_at: Optional[int] = None
    samples: List[dict] = field(default_factory=list)

    def reject(self, item: dict) -> None:
        if len(self.samples) < 10:
            self.samples.append(item)


def _line(raw: bytes) -> Optional[dict]:
    try:
        rec = json.loads(raw)
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None


def _row_id(rec: dict, offset: int, upload_id: str, win: Window) -> str:
    """The package's own entity id; one minted from the line's place in the package when it has
    none — the same id every time the line is read, so a replayed window collides with itself."""
    eid = str(rec.get("entity_id") or "").strip()
    if eid:
        return eid
    win.minted += 1
    return stable_prefixed_id("ent", f"{upload_id}:{offset}")


def node_rows(lines: List[Tuple[int, bytes]], *, ctx, graph_id: str, rules,
              upload_id: str) -> Window:
    """A window's node lines as ``node_versions`` rows. Format 2 carries the stored payload whole
    (kept as it is: nothing a flat record can't hold is lost); format 1 is read as an import reads
    it. Either way the payload is sanitized, its types put in the ontology's casing, and hashed."""
    from backend.app.providers.versioned_bootstrap import canonicalize_rows

    from .import_export.resolve import _no_deletes, _node_payload
    from .import_export.rowmodel import normalize

    win = Window()
    now = _now()
    seen: Set[str] = set()
    for offset, raw in lines:
        if not raw.strip():
            continue
        rec = _line(raw)
        kind = rec.get("kind") if rec is not None else None
        if kind == "edge":
            if win.first_edge_at is None:
                win.first_edge_at = offset
            continue
        if kind != "node":
            win.other += 1
            continue
        win.lines += 1
        if isinstance(rec.get("payload"), dict):
            payload = dict(rec["payload"])
        else:
            row = normalize(rec, "node")
            if row["op"] != "upsert":
                win.invalid += 1
                win.reject({"kind": "node", "offset": offset, "reason": "a package only adds items"})
                continue
            payload = _no_deletes(_node_payload(row))
        canonicalize_rows([payload], rules)
        payload = _sanitize_node_properties(payload)
        eid = _row_id(rec, offset, upload_id, win)
        if eid in seen:
            win.dupes += 1
            continue
        seen.add(eid)
        win.dicts.append(dict(
            graph_id=graph_id, id=_vid("nvb", ctx.commit_id, eid), entity_id=eid,
            commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
            op="create", content_hash=content_hash(payload), prev_content_hash=None,
            payload=payload, actor=ctx.actor, created_at=now, urn=payload.get("urn") or None,
            entity_type=payload.get("entityType"), display_name=payload.get("displayName"),
            qualified_name=payload.get("qualifiedName"),
        ))
    return win


@dataclass
class EdgeLine:
    """An edge line read, before its ends are checked: its id and payload without the ends, the
    ends' entity ids, and their urns (to find an end the line names only by urn)."""
    offset: int
    entity_id: str
    payload: dict
    source: Optional[str]
    target: Optional[str]
    source_urn: Optional[str]
    target_urn: Optional[str]


def edge_lines(lines: List[Tuple[int, bytes]], *, upload_id: str) -> Tuple[List[EdgeLine], Window]:
    """A window's edge lines, read: format 2's stored payload, or format 1's record as an import
    reads it. The platform's rollups are skipped; a line with no type, or with an end it names
    neither by id nor by urn, can't be stored."""
    from .import_export.resolve import _edge_payload, _no_deletes
    from .import_export.rowmodel import normalize

    win = Window()
    out: List[EdgeLine] = []
    for offset, raw in lines:
        if not raw.strip():
            continue
        rec = _line(raw)
        if rec is None or rec.get("kind") != "edge":
            continue
        win.lines += 1
        if isinstance(rec.get("payload"), dict):
            payload = dict(rec["payload"])
            src, tgt = payload.get("sourceEntityId"), payload.get("targetEntityId")
            etype = payload.get("edgeType")
        else:
            row = normalize(rec, "edge")
            src, tgt, etype = row.get("source_entity_id"), row.get("target_entity_id"), \
                row.get("edgeType")
            payload = _no_deletes(_edge_payload(row, src, tgt)) \
                if row["op"] == "upsert" and etype else None
        if str(etype or "").upper() == _DERIVED_EDGE:
            win.derived += 1
            continue
        src_urn, tgt_urn = rec.get("sourceUrn"), rec.get("targetUrn")
        if payload is None or not etype or not (src or src_urn) or not (tgt or tgt_urn):
            win.invalid += 1
            win.reject({"kind": "edge", "offset": offset,
                        "reason": "no type, or an end it doesn't name"})
            continue
        out.append(EdgeLine(offset, _row_id(rec, offset, upload_id, win), payload,
                            src or None, tgt or None, src_urn or None, tgt_urn or None))
    return out, win


def edge_rows(read: List[EdgeLine], win: Window, *, ctx, graph_id: str, rules,
              live: Set[str]) -> Window:
    """The read edges as ``edge_versions`` rows, their ends resolved (``source``/``target``) and
    checked against the package's nodes (``live``): an edge to an item the package doesn't hold
    is not copied, and counted."""
    from backend.app.services.versioning.ontology import canonicalize_payload_types

    now = _now()
    seen: Set[str] = set()
    for e in read:
        if e.source not in live or e.target not in live:
            win.dangling += 1
            win.reject({"kind": "edge", "id": e.entity_id, "reason": "endpoint item not in the package",
                        "source": e.source or e.source_urn, "target": e.target or e.target_urn})
            continue
        if e.entity_id in seen:
            win.dupes += 1
            continue
        seen.add(e.entity_id)
        payload = {**e.payload, "sourceEntityId": e.source, "targetEntityId": e.target}
        canonicalize_payload_types(payload, rules)
        et = str(payload.get("edgeType"))
        win.dicts.append(dict(
            graph_id=graph_id, id=_vid("evb", ctx.commit_id, e.entity_id), entity_id=e.entity_id,
            commit_id=ctx.commit_id, commit_seq=ctx.commit_seq, branch_id=ctx.main_id,
            op="create", content_hash=content_hash(payload), prev_content_hash=None,
            payload=payload, actor=ctx.actor, created_at=now, source_entity_id=e.source,
            target_entity_id=e.target, edge_type=et, confidence=payload.get("confidence"),
            discriminator=payload.get("discriminator"),
        ))
    return win


# --------------------------------------------------------------------------- #
# Phases                                                                       #
# --------------------------------------------------------------------------- #
def fresh_tallies() -> Dict[str, Any]:
    """What the copy counts, from nothing: per kind the lines read, the rows offered (``parsed``)
    and what landed (``written``, by type), and every way a line can fail to land."""
    return {
        "lines": {"nodes": 0, "edges": 0}, "otherLines": 0,
        "parsed": {"nodes": 0, "edges": 0},
        "written": {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}},
        "invalid": {"nodes": 0, "edges": 0}, "duplicateIds": {"nodes": 0, "edges": 0},
        "dangling": 0, "derived": 0, "mintedIds": 0, "rekeyedEdges": 0, "samples": [],
        "firstEdgeAt": None, "projected": 0,
    }


async def phase_counting(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    """The pre-flight of both ends (see the module docstring): the package is still there, and the
    new key is empty — then the key is claimed, in the transaction that records it. A restart keeps
    the claim (``summary.target``): the key then holds this package's own earlier copy, and the
    projection writes over it what it wrote before."""
    ctx = await run._ctx(lease, graph_id)
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        cursor, summary, payload_uri = job.last_cursor, dict(job.summary or {}), job.payload_uri
    if not payload_uri or not (await run._object_store().stat(payload_uri)).exists:
        raise BootstrapFailure(
            "The package this data source is made from is no longer available (it expired or was "
            "removed). Give up, and import the package again.", "payload_missing")
    target = dict(summary.get("target") or {})
    if not target.get("claimed"):
        client = await run._client(ctx)
        # The platform's own derived nodes (an aggregation run on the empty key stamps its marker
        # there) are not data, as the projection's verify does not count them either.
        res = await _q(client, f"MATCH (n) WHERE {config.not_derived_clause('n')} RETURN 1 LIMIT 1",
                       timeout_ms=_READ_TIMEOUT_MS, read_only=True)
        if getattr(res, "result_set", None):
            raise BootstrapFailure(
                f"The graph '{ctx.falkor_graph_name}' already holds data, so nothing was copied "
                "into it. Give up, and choose another graph name.", "target_not_empty")
        target = {"claimed": True, "graphName": ctx.falkor_graph_name,
                  "provider": ctx.falkor_provider, "claimedAt": _now()}
    package = summary.get("package") or {}
    manifest, stats = package.get("manifest") or {}, package.get("typeStats") or {}
    # What the progress bar counts to: the manifest's counts, else the types counted on upload.
    total = (int(manifest.get("nodes") or stats.get("nodeCount") or 0)
             + int(manifest.get("edges") or stats.get("edgeCount") or 0))
    async with run._session() as s:
        ps = await s.get(ProjectionStateORM, graph_id)
        ps.owns_falkor_graph = True
        summary.update(target=target, seed=fresh_tallies())
        await lease.checkpoint(s, expect_cursor=cursor, summary=summary, processed=0, progress=0,
                               total=total)
    return True


async def phase_nodes(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    return await _load(run, lease, graph_id, "nodes")


async def phase_edges(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    return await _load(run, lease, graph_id, "edges")


async def _load(run: BootstrapRunner, lease: Lease, graph_id: str, phase: str) -> bool:
    """One window of the package's data: read, converted, written, and checkpointed — rows,
    tallies and the cursor in ONE transaction.

    The nodes pass reads the whole file (nothing says every node comes before the first edge), and
    notes where the first edge line starts; the edges pass starts there. An edge's ends must be
    nodes of the package, which the nodes pass has stored by then."""
    ctx = await run._ctx(lease, graph_id)
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        cursor, summary, payload_uri = job.last_cursor, dict(job.summary or {}), job.payload_uri
    seed = summary["seed"]
    upload_id = str((summary.get("package") or {}).get("uploadId") or "")
    at = int(cursor.split(":")[1]) if cursor else (
        0 if phase == "nodes" else int(seed.get("firstEdgeAt") or 0))
    try:
        stream = await _stream_at(run, ctx, payload_uri, at)
        lines = await stream.read(config.PACKAGE_SEED_WINDOW)
    except FileNotFoundError as exc:
        raise BootstrapFailure(
            "The package this data source is made from is no longer available (it expired or was "
            "removed). Give up, and import the package again.", "payload_missing") from exc
    except ValueError as exc:                      # the data isn't what was checked on upload
        raise BootstrapFailure(str(exc), "payload_missing") from exc
    if not lines:
        if phase == "nodes" and seed.get("firstEdgeAt") is None:
            async with run._session() as s:        # no edge at all: the edges pass starts at the end
                summary["seed"] = {**seed, "firstEdgeAt": stream.at}
                await lease.checkpoint(s, expect_cursor=cursor, summary=summary)
        return True

    rules = await run._rules(lease, ctx)
    if phase == "nodes":
        win = await asyncio.to_thread(node_rows, lines, ctx=ctx, graph_id=graph_id, rules=rules,
                                      upload_id=upload_id)
    else:
        read, win = await asyncio.to_thread(edge_lines, lines, upload_id=upload_id)
        await _resolve_ends(run, graph_id, ctx.commit_id, read)
        live = await run._known_nodes(graph_id, ctx.commit_id,
                                      {x for e in read for x in (e.source, e.target) if x})
        win = await asyncio.to_thread(edge_rows, read, win, ctx=ctx, graph_id=graph_id,
                                      rules=rules, live=live)

    async with run._session() as s:
        rekeyed = (await run._rekey_edge_collisions(s, graph_id, ctx, win.dicts)
                   if phase == "edges" else 0)
        # What LANDED, from RETURNING: a row whose id is already stored (the same entity id in an
        # earlier window) is a duplicate, never a silent overwrite. One typed statement a window.
        landed = await _insert_versions(s, phase, ctx, graph_id, win.dicts)
        job = await s.get(JobORM, lease.job_id)
        summary = dict(job.summary or {})
        summary["seed"] = seed = _merge(summary["seed"], phase, win, landed, rekeyed)
        done = int(seed["written"]["nodes"]) + int(seed["written"]["edges"])
        await lease.checkpoint(s, expect_cursor=cursor, summary=summary, processed=done,
                               progress=_percent(phase, done, job.total),
                               last_cursor=f"{phase}:{stream.at}")
    if run._due(lease.job_id):
        logger.info("package seed %s: %s through byte %d, %d stored (graph=%s)", lease.job_id,
                    phase, stream.at, done, graph_id)
    return False


async def _resolve_ends(run: BootstrapRunner, graph_id: str, commit_id: str,
                        read: List[EdgeLine]) -> None:
    """Fill the ends a line names only by urn (no entity id) with the package's node of that urn —
    the lowest entity id, should several share it. One lookup per window, and only when needed."""
    urns = {u for e in read for u, eid in ((e.source_urn, e.source), (e.target_urn, e.target))
            if eid is None and u}
    if not urns:
        return
    found: Dict[str, str] = {}
    async with run._session() as s:
        for chunk in _chunks(sorted(urns), 10000):
            rows = (await s.execute(select(NodeVersionORM.urn, NodeVersionORM.entity_id).where(
                NodeVersionORM.graph_id == graph_id, NodeVersionORM.commit_id == commit_id,
                NodeVersionORM.urn.in_(list(chunk)),
            ).order_by(NodeVersionORM.urn, NodeVersionORM.entity_id).distinct(
                NodeVersionORM.urn))).all()
            found.update({u: eid for u, eid in rows})
    for e in read:
        e.source = e.source or found.get(e.source_urn)
        e.target = e.target or found.get(e.target_urn)


def _merge(seed: dict, phase: str, win: Window, landed: Set[str], rekeyed: int) -> dict:
    """Add one window's tallies to the job's (``fresh_tallies``)."""
    seed = json.loads(json.dumps(seed))            # a copy: the row read is the session's
    bucket, column, fallback = (("byLabel", "entity_type", "Entity") if phase == "nodes"
                                else ("byType", "edge_type", "REL"))
    written: Dict[str, int] = {}
    for d in win.dicts:
        if d["entity_id"] in landed:
            _bump(written, str(d[column] or fallback))
    seed["lines"][phase] += win.lines
    seed["otherLines"] += win.other
    seed["parsed"][phase] += len(win.dicts) + win.dupes + win.dangling
    seed["written"][phase] += len(landed)
    seed["written"][bucket] = _add_tally(seed["written"].get(bucket), written)
    seed["invalid"][phase] += win.invalid
    seed["duplicateIds"][phase] += win.dupes + len(win.dicts) - len(landed)
    seed["dangling"] += win.dangling
    seed["derived"] += win.derived
    seed["mintedIds"] += win.minted
    seed["rekeyedEdges"] += rekeyed
    if seed.get("firstEdgeAt") is None and win.first_edge_at is not None:
        seed["firstEdgeAt"] = win.first_edge_at
    for sample in win.samples:
        _add_reject_sample(seed, sample)
    return seed


async def phase_validate(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    """Prove the copy before any of it is visible — after collapsing the entities that share a
    type and urn (:func:`collapse_shared_identifiers`, once: its result is recorded with it).

    Blocking: every line of the package was read (against its manifest, when the package is
    verified), what was written reconciles with what was read and with what is stored, every
    connection's ends are stored, and every type survived. The rest is reported, not blocking: the
    collapse, items with no urn, re-keyed connections, lines that couldn't be stored, duplicate ids,
    connections to items the package doesn't hold, and how much the semantic layer covers."""
    ctx = await run._ctx(lease, graph_id)
    await _analyze_copy(run, lease, graph_id)
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        summary = dict(job.summary or {})
    if "collapse" not in summary["seed"]:
        async with run._session() as s:
            collapse = await collapse_shared_identifiers(s, graph_id, ctx.commit_id)
            job = await s.get(JobORM, lease.job_id)
            summary = dict(job.summary or {})
            summary["seed"] = {**summary["seed"], "collapse": collapse}
            await lease.checkpoint(s, summary=summary)
        if collapse["nodes"]:
            logger.info("package seed %s: %d item(s) sharing a type and urn collapsed into %d",
                        lease.job_id, collapse["nodes"], collapse["identifiers"])
    seed, package = summary["seed"], summary.get("package") or {}
    collapse = seed["collapse"]

    async with run._session() as s:
        pg_labels = dict((await s.execute(text(
            "SELECT coalesce(nullif(entity_type, ''), 'Entity'), count(*) "
            f'FROM {_t("node_versions")} WHERE graph_id = :g AND commit_id = :c GROUP BY 1'
        ), {"g": graph_id, "c": ctx.commit_id})).all())
        pg_types = dict((await s.execute(text(
            "SELECT coalesce(nullif(edge_type, ''), 'REL'), count(*) "
            f'FROM {_t("edge_versions")} WHERE graph_id = :g AND commit_id = :c GROUP BY 1'
        ), {"g": graph_id, "c": ctx.commit_id})).all())
        dangling = (await s.execute(text(
            f'SELECT count(*) FROM {_t("edge_versions")} e '
            "WHERE e.graph_id = :g AND e.commit_id = :c AND ("
            f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n WHERE n.graph_id = :g '
            "     AND n.commit_id = :c AND n.entity_id = e.source_entity_id) OR "
            f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n WHERE n.graph_id = :g '
            "     AND n.commit_id = :c AND n.entity_id = e.target_entity_id))"
        ), {"g": graph_id, "c": ctx.commit_id})).scalar_one()
        unkeyed = (await s.execute(text(
            f'SELECT count(*) FROM {_t("node_versions")} WHERE graph_id = :g AND commit_id = :c '
            "AND coalesce(urn, '') = ''"), {"g": graph_id, "c": ctx.commit_id})).scalar_one()

    stored_nodes, stored_edges = sum(pg_labels.values()), sum(pg_types.values())
    lines, parsed, written = seed["lines"], seed["parsed"], seed["written"]
    dupes, invalid = seed["duplicateIds"], seed["invalid"]
    manifest = package.get("manifest") or {}
    verified = package.get("integrity") == "verified"
    checks: List[dict] = []

    def check(key: str, ok: bool, detail: str, blocking: bool = True) -> None:
        checks.append({"key": key, "ok": bool(ok), "detail": detail, "blocking": blocking})

    # 1. Every line of the package was read — what its manifest says it holds (when it says).
    if manifest.get("nodes") is not None and manifest.get("edges") is not None:
        check("lines_seen", lines["nodes"] == int(manifest["nodes"])
              and lines["edges"] == int(manifest["edges"]),
              f"read {lines['nodes']:,} items and {lines['edges']:,} connections; the package says "
              f"{int(manifest['nodes']):,} and {int(manifest['edges']):,}", blocking=verified)
    # 2. What was written reconciles with what was read, and with what is stored.
    check("nodes_written", written["nodes"] == parsed["nodes"] - dupes["nodes"]
          and stored_nodes == written["nodes"] - collapse["nodes"],
          f"{stored_nodes:,} items stored")
    check("edges_written",
          written["edges"] == parsed["edges"] - dupes["edges"] - seed["dangling"]
          and stored_edges == written["edges"] - collapse["selfLoops"] - collapse["parallel"],
          f"{stored_edges:,} connections stored")
    # 3. No connection points at an item that isn't there.
    check("referentially_whole", int(dangling) == 0,
          f"{dangling} connection(s) referencing a missing item")
    # 4. Types survived — per item type and per relationship type.
    exp_labels = _add_tally(written["byLabel"], {k: -v for k, v in collapse["byLabel"].items()})
    exp_types = _add_tally(written["byType"], {k: -v for k, v in collapse["byType"].items()})
    check("types_preserved", _same_tally(pg_labels, exp_labels) and _same_tally(pg_types, exp_types),
          f"{len(pg_labels)} item type(s) and {len(pg_types)} relationship type(s) preserved")
    # 5. Reported, never blocking.
    check("shared_identifiers_collapsed", collapse["nodes"] == 0,
          f"{collapse['nodes']:,} item(s) shared a type and identifier with another and were "
          f"merged into {collapse['identifiers']:,} (kept: {collapse['rule']})", blocking=False)
    check("unkeyed_items", int(unkeyed) == 0,
          f"{unkeyed:,} item(s) have no identifier (urn): they are kept, keyed by their id",
          blocking=False)
    check("rekeyed_connections", seed["rekeyedEdges"] == 0,
          f"{seed['rekeyedEdges']:,} connection(s) shared an id with an item and were re-keyed",
          blocking=False)
    check("invalid_lines", invalid["nodes"] + invalid["edges"] + seed["otherLines"] == 0,
          f"{invalid['nodes'] + invalid['edges'] + seed['otherLines']:,} line(s) couldn't be "
          "stored", blocking=False)
    check("duplicate_ids", dupes["nodes"] + dupes["edges"] == 0,
          f"{dupes['nodes'] + dupes['edges']:,} line(s) repeated an id; the first was kept",
          blocking=False)
    check("dangling_connections", seed["dangling"] == 0,
          f"{seed['dangling']:,} connection(s) point at items the package doesn't hold",
          blocking=False)
    coverage = (summary.get("ontology") or {}).get("coverage")
    if coverage:
        uncovered = (len(coverage.get("uncoveredEntityTypes") or [])
                     + len(coverage.get("uncoveredRelationshipTypes") or []))
        check("ontology_coverage", uncovered == 0,
              f"the semantic layer declares all but {uncovered} of the package's types",
              blocking=False)

    report = {
        "checks": checks,
        "source": {"nodes": int(manifest.get("nodes") or 0),
                   "edges": int(manifest.get("edges") or 0)},
        "stored": {"nodes": stored_nodes, "edges": stored_edges},
        "labels": dict(pg_labels), "edgeTypes": dict(pg_types),
        "package": {"nodes": stored_nodes, "edges": stored_edges,
                    "sourceEnvironment": package.get("sourceEnvironment"),
                    "lines": lines, "invalid": invalid, "duplicateIds": dupes,
                    "dangling": seed["dangling"], "derivedSkipped": seed["derived"],
                    "otherLines": seed["otherLines"], "mintedIds": seed["mintedIds"],
                    "unkeyedItems": int(unkeyed), "rekeyedConnections": seed["rekeyedEdges"],
                    "collapse": collapse, "samples": seed["samples"], "coverage": coverage,
                    "integrity": package.get("integrity")},
        "merkle": "pending",
    }
    failed = [c for c in checks if c["blocking"] and not c["ok"]]
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        summary = dict(job.summary or {})
        summary["report"] = report
        if collapse["nodes"]:                      # status reads it as a graph bootstrap's
            summary["collapsed"] = {k: collapse[k] for k in ("nodes", "byLabel", "selfLoops")}
        await lease.checkpoint(s, summary=summary, progress=_PHASE_FLOOR["validate"])
    if failed:
        keys = {c["key"] for c in failed}
        raise BootstrapFailure(
            "The package's data didn't read back as its manifest describes it; the file may be "
            "damaged. Upload it again." if "lines_seen" in keys else
            "Some connections point at items that didn't make it into the copy." if
            "referentially_whole" in keys else
            "The copy didn't match the package exactly, so it was not applied.", "integrity")
    logger.info("package seed %s: integrity checks passed (%d checks)", lease.job_id, len(checks))
    return True


async def _analyze_copy(run: BootstrapRunner, lease: Lease, graph_id: str) -> None:
    """Refresh the planner's statistics of the partitions the copy was just loaded into.

    Until autovacuum gets to them, they describe the partitions without the copy: a graph id that
    isn't there, so every query of the rest of the job is planned for a handful of rows. Planned so,
    a join of the copy against itself ran for over ten minutes on 100k items. Best effort (it needs
    the tables' owner): without it the queries are only slower to plan well, once autovacuum runs."""
    try:
        async with run._session() as s:
            for table in ("node_versions", "edge_versions"):
                part = await s.scalar(text(
                    f"SELECT tableoid::regclass::text FROM {_t(table)} WHERE graph_id = :g LIMIT 1"),
                    {"g": graph_id})
                if part:
                    await s.execute(text(f"ANALYZE {part}"))
            await s.commit()
    except Exception as exc:                                 # noqa: BLE001 — best effort
        logger.warning("package seed %s: could not refresh statistics: %s", lease.job_id, exc)


def rank_copies(copies: List[tuple]) -> List[tuple]:
    """``(entity_id, entity_type, synced_at)`` copies of one (label, urn), the one to keep first:
    synced last (``COLLAPSE_RULE``; no time ranks after any), then the lowest entity id."""
    return sorted(copies, key=lambda c: (c[2] is None, -c[2].timestamp() if c[2] else 0.0, c[0]))


async def collapse_shared_identifiers(s, graph_id: str, commit_id: str) -> Dict[str, Any]:
    """Make every (projected label, urn) ONE entity, inside the import commit (D14).

    A package can hold two entities of one type with one urn — exported from a graph that had
    them, or written by hand — and FalkorDB, which keys nodes by label + urn, would fold them into
    one node the version store still counts twice. Nothing pre-existing is at stake here (the target
    is empty, private and invisible until finalize), so they are collapsed, deterministically, the
    way enabling version control collapses duplicates once a manager decides: the copy synced last
    (payload ``lastSyncedAt``) is kept, then the lowest entity id. The others' node versions go;
    their connections move to the copy kept; a connection that now joins the copy to itself — it
    joined two copies — is dropped, and so is a moved connection that now repeats one (source,
    type, target) already there, or a moved one of a lower id; parallels the package held itself
    are kept. Moved connections are hashed again (their ends are in their payload).

    One transaction with the caller's checkpoint, so it happens exactly once. Returns what it did:
    counts, per type, and the first groups (urn, label, kept, merged)."""
    t_nv, t_ev = _t("node_versions"), _t("edge_versions")
    # One scan and a window, not a join of the copy against its own groups: planned for the few
    # rows stale statistics promise, that join rescans every group once per item.
    rows = (await s.execute(text(
        f"SELECT label, urn, entity_id, entity_type, synced FROM (SELECT entity_id, urn, "
        f"{_LABEL_SQL} AS label, entity_type, payload->>'lastSyncedAt' AS synced, "
        f"count(*) OVER (PARTITION BY {_LABEL_SQL}, urn) AS n FROM {t_nv} "
        "WHERE graph_id = :g AND commit_id = :c AND coalesce(urn, '') <> '') k "
        "WHERE n > 1 ORDER BY label, urn, entity_id"
    ), {"g": graph_id, "c": commit_id})).all()
    out: Dict[str, Any] = {"identifiers": 0, "nodes": 0, "byLabel": {}, "selfLoops": 0,
                           "parallel": 0, "byType": {}, "repointed": 0, "rule": COLLAPSE_RULE,
                           "groups": []}
    if not rows:
        return out
    groups: Dict[Tuple[str, str], List[tuple]] = {}
    for label, urn, eid, etype, synced in rows:
        groups.setdefault((label, urn), []).append((eid, etype, _normalize_synced_at(synced)))
    # A format-1 package carries no lastSyncedAt: say what decided, not what would have.
    if not any(c[2] for copies in groups.values() for c in copies):
        out["rule"] = "lowest entityId (no copy carried lastSyncedAt)"
    losers: List[str] = []
    winners: List[str] = []
    for (label, urn), copies in groups.items():
        copies = rank_copies(copies)
        kept = copies[0][0]
        for eid, etype, _synced in copies[1:]:
            losers.append(eid)
            winners.append(kept)
            _bump(out["byLabel"], str(etype or "Entity"))
        if len(out["groups"]) < _COLLAPSE_LISTED:
            out["groups"].append({"urn": urn, "label": label, "kept": kept,
                                  "merged": [c[0] for c in copies[1:]]})
    out["identifiers"], out["nodes"] = len(groups), len(losers)
    mapping = ("WITH m AS (SELECT * FROM unnest(CAST(:losers AS text[]), "
               "CAST(:winners AS text[])) AS m(loser, winner)), "
               "hit AS (SELECT e.id, e.source_entity_id AS s0, e.target_entity_id AS t0, "
               "coalesce(ms.winner, e.source_entity_id) AS s1, "
               "coalesce(mt.winner, e.target_entity_id) AS t1 "
               f"FROM {t_ev} e LEFT JOIN m ms ON ms.loser = e.source_entity_id "
               "LEFT JOIN m mt ON mt.loser = e.target_entity_id "
               "WHERE e.graph_id = :g AND e.commit_id = :c "
               "AND (ms.loser IS NOT NULL OR mt.loser IS NOT NULL)) ")
    params = {"g": graph_id, "c": commit_id, "losers": losers, "winners": winners}
    # A connection between two copies of one urn would join the copy kept to itself: dropped.
    for (etype,) in (await s.execute(text(
            mapping + f"DELETE FROM {t_ev} e USING hit WHERE e.graph_id = :g AND e.id = hit.id "
            "AND hit.s1 = hit.t1 AND hit.s0 <> hit.t0 RETURNING e.edge_type"), params)).all():
        out["selfLoops"] += 1
        _bump(out["byType"], str(etype or "REL"))
    moved = (await s.execute(text(
        mapping + f"UPDATE {t_ev} e SET source_entity_id = hit.s1, target_entity_id = hit.t1, "
        "payload = jsonb_set(jsonb_set(e.payload, '{sourceEntityId}', to_jsonb(hit.s1)), "
        "'{targetEntityId}', to_jsonb(hit.t1)) "
        "FROM hit WHERE e.graph_id = :g AND e.id = hit.id RETURNING e.id"), params)).scalars().all()
    if moved:
        # A moved connection that now repeats one (source, type, target) goes: the connections
        # that were already there first, then the lowest id. Parallels the package itself held
        # stay, as they do wherever nothing moved.
        for (etype,) in (await s.execute(text(
                f"WITH touched AS (SELECT DISTINCT source_entity_id, target_entity_id, edge_type "
                f"FROM {t_ev} WHERE graph_id = :g AND id = ANY(CAST(:ids AS text[]))), "
                "r AS (SELECT e.id, e.edge_type, e.id = ANY(CAST(:ids AS text[])) AS moved, "
                "row_number() OVER (PARTITION BY e.source_entity_id, e.target_entity_id, "
                "e.edge_type ORDER BY e.id = ANY(CAST(:ids AS text[])), e.entity_id) AS n "
                f"FROM {t_ev} e JOIN touched t ON t.source_entity_id = e.source_entity_id "
                "AND t.target_entity_id = e.target_entity_id "
                "AND t.edge_type IS NOT DISTINCT FROM e.edge_type "
                "WHERE e.graph_id = :g AND e.commit_id = :c) "
                f"DELETE FROM {t_ev} e USING r WHERE e.graph_id = :g AND e.id = r.id AND r.n > 1 "
                "AND r.moved RETURNING r.edge_type"),
                {"g": graph_id, "c": commit_id, "ids": list(moved)})).all():
            out["parallel"] += 1
            _bump(out["byType"], str(etype or "REL"))
        # The moved connections that remain carry new ends in their payload: hash them again.
        for chunk in _chunks(list(moved), 5000):
            rows = (await s.execute(select(EdgeVersionORM.id, EdgeVersionORM.payload).where(
                EdgeVersionORM.graph_id == graph_id, EdgeVersionORM.id.in_(list(chunk))))).all()
            if not rows:
                continue
            hashes = await asyncio.to_thread(lambda r=rows: [content_hash(p) for _i, p in r])
            await s.execute(text(
                f"UPDATE {t_ev} e SET content_hash = v.h FROM unnest(CAST(:ids AS text[]), "
                "CAST(:hs AS text[])) AS v(id, h) WHERE e.graph_id = :g AND e.id = v.id"),
                {"g": graph_id, "ids": [i for i, _p in rows], "hs": hashes})
            out["repointed"] += len(rows)
    await s.execute(text(
        f"DELETE FROM {t_nv} WHERE graph_id = :g AND commit_id = :c "
        "AND entity_id = ANY(CAST(:losers AS text[]))"), params)
    return out


async def phase_index(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    """The new key's indexes, before anything is written into it: the urn index of every type the
    copy holds and every type its semantic layer declares (made, then waited for — an index still
    building is not used, and the projection would scan a label per row), and the rollup layer's
    edge indexes, as a graph the platform reads gets them (best effort: the rollups come later)."""
    ctx = await run._ctx(lease, graph_id)
    async with run._session() as s:
        labels = set((await s.execute(text(
            f"SELECT DISTINCT coalesce(nullif(entity_type, ''), 'Entity') "
            f'FROM {_t("node_versions")} WHERE graph_id = :g AND commit_id = :c'),
            {"g": graph_id, "c": ctx.commit_id})).scalars().all())
    rules = await run._rules(lease, ctx)
    labels |= set(getattr(rules, "entity_types", None) or {})
    client = await run._client(ctx)
    await ensure_urn_indexes(client, sorted(labels), strict=True, wait=True)
    for ddl in edge_index_ddl():
        try:
            await _q(client, ddl)
        except Exception as exc:  # noqa: BLE001 — "already indexed" is success; the rest is logged
            if "already indexed" not in str(exc).lower():
                logger.warning("package seed %s: edge index not created (%s): %s",
                               lease.job_id, ddl, exc)
    async with run._session() as s:
        await lease.checkpoint(s, progress=_PHASE_FLOOR["index"])
    return True


async def phase_project(run: BootstrapRunner, lease: Lease, graph_id: str) -> bool:
    """Write the copy into the new key: keyset windows of ``PACKAGE_PROJECT_WINDOW`` over the
    commit's node versions, then its edge versions (``project:nodes:<entity id>``), each through
    the projector's own writer — the same nodes, properties, fingerprints and indexes a projection
    writes, and every write a MERGE, so a window replayed after a crash converges. The key is
    known to hold nothing but this copy, so no node is read back for properties to remove. At the
    end FalkorDB must hold what Postgres does, counted as the projection's verify counts them;
    otherwise the job fails (``projection``) with its cursor back at the start, so a resume
    projects again."""
    projector = run._projector
    if projector is None:                          # pragma: no cover - wiring
        raise BootstrapFailure("This worker cannot write a new data source's graph.", "internal")
    ctx = await run._ctx(lease, graph_id)
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        at, total = job.last_cursor, int(job.total or 0)
    cursor = at or "project:nodes:"
    kind = "edges" if cursor.startswith("project:edges") else "nodes"
    after = cursor.split(":", 2)[2]
    client = await run._client(ctx)
    if ctx.level_map is None:
        ctx.level_map = await projector._resolve_level_map(graph_id)
    nodes: list = []
    edges: list = []
    last = None
    async with run._session() as s:
        if kind == "nodes":
            for eid, vid, urn, etype in (await s.execute(text(
                    f'SELECT entity_id, id, urn, entity_type FROM {_t("node_versions")} '
                    "WHERE graph_id = :g AND commit_id = :c AND entity_id > :after "
                    "ORDER BY entity_id LIMIT :w"),
                    {"g": graph_id, "c": ctx.commit_id, "after": after,
                     "w": config.PACKAGE_PROJECT_WINDOW})).all():
                nodes.append((eid, urn or f"gv:{eid}", _Pending(
                    ("node", graph_id, vid), (("urn", urn), ("entityType", etype)))))
                last = eid
        else:
            for eid, vid, etype, src, tgt, su, sl, tu, tl in (await s.execute(text(
                    "SELECT e.entity_id, e.id, e.edge_type, e.source_entity_id, "
                    "e.target_entity_id, sn.urn, sn.entity_type, tn.urn, tn.entity_type "
                    f'FROM {_t("edge_versions")} e '
                    f'JOIN {_t("node_versions")} sn ON sn.graph_id = e.graph_id '
                    "  AND sn.commit_id = e.commit_id AND sn.entity_id = e.source_entity_id "
                    f'JOIN {_t("node_versions")} tn ON tn.graph_id = e.graph_id '
                    "  AND tn.commit_id = e.commit_id AND tn.entity_id = e.target_entity_id "
                    "WHERE e.graph_id = :g AND e.commit_id = :c AND e.entity_id > :after "
                    "ORDER BY e.entity_id LIMIT :w"),
                    {"g": graph_id, "c": ctx.commit_id, "after": after,
                     "w": config.PACKAGE_PROJECT_WINDOW})).all():
                edges.append((eid, su or f"gv:{src}", tu or f"gv:{tgt}", _Pending(
                    ("edge", graph_id, vid),
                    (("edgeType", etype), ("sourceEntityId", src), ("targetEntityId", tgt))),
                    sl or "Entity", tl or "Entity"))
                last = eid
    if last is None:
        if kind == "nodes":
            async with run._session() as s:
                await lease.checkpoint(s, expect_cursor=at, last_cursor="project:edges:")
            return False
        return await _verify_projection(run, lease, graph_id, ctx, client, at)
    await projector._apply(client, nodes, edges, [], [], level_map=ctx.level_map,
                           provider_id=ctx.falkor_provider, known_empty=True)
    async with run._session() as s:
        job = await s.get(JobORM, lease.job_id)
        summary = dict(job.summary or {})
        seed = dict(summary["seed"])
        seed["projected"] = int(seed.get("projected") or 0) + len(nodes) + len(edges)
        summary["seed"] = seed
        span = _PHASE_FLOOR["finalize"] - _PHASE_FLOOR["project"] - 1
        await lease.checkpoint(
            s, expect_cursor=at, summary=summary, last_cursor=f"project:{kind}:{last}",
            progress=_PHASE_FLOOR["project"] + int(span * min(1.0, seed["projected"] / (total or 1))))
    if run._due(lease.job_id):
        logger.info("package seed %s: projected %d %s through %s (graph=%s)", lease.job_id,
                    len(nodes) + len(edges), kind, last, graph_id)
    return False


async def _verify_projection(run: BootstrapRunner, lease: Lease, graph_id: str, ctx, client,
                             at: Optional[str]) -> bool:
    """FalkorDB against Postgres, counted as the projection's verify counts them
    (``reconcile.pg_live_counts_projectable``: nodes, and edges as DISTINCT (source, projected type,
    target) triples, since the projector MERGEs one relationship per triple). Counted over the
    import commit's own rows, which ARE main's heads here — the heads join, planned on statistics
    that predate the bulk load it follows, can pick a nested loop that runs for many minutes."""
    async with run._session() as s:
        pg = (await s.execute(text(
            f'SELECT (SELECT count(*) FROM {_t("node_versions")} '
            "         WHERE graph_id = :g AND commit_id = :c), "
            "       (SELECT count(DISTINCT (source_entity_id, "
            "               regexp_replace(coalesce(nullif(edge_type, ''), 'REL'), "
            "                              '[^[:alnum:]_]', '_', 'g'), target_entity_id)) "
            f'        FROM {_t("edge_versions")} WHERE graph_id = :g AND commit_id = :c '
            "         AND edge_type IS DISTINCT FROM 'AGGREGATED')"),
            {"g": graph_id, "c": ctx.commit_id})).one()
    found = await falkor_counts(client, owned=True)
    if tuple(found) != tuple(pg):
        async with run._session() as s:
            # A resume projects the whole copy again (every write a MERGE).
            await lease.checkpoint(s, expect_cursor=at, last_cursor=None)
        raise BootstrapFailure(
            f"The new graph holds {found[0]:,} items and {found[1]:,} connections, and the copy "
            f"{pg[0]:,} and {pg[1]:,}. Resume to write it again.", "projection", action="resume")
    logger.info("package seed %s: projected %d items and %d connections (graph=%s)",
                lease.job_id, pg[0], pg[1], graph_id)
    return True
