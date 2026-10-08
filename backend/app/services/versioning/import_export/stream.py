"""Streaming export — a versioned graph's state, written in any format as it is read.

``ExportWorker`` used to materialize the whole state, build every record and hand the lot to a
writer: several copies of the graph in memory, on a 1–2 GiB pod, and a job whose artifact then had
to be stored and fetched again. Here the state comes a page at a time from a
:class:`~.snapshot.Snapshot` pinned to one commit; each page is filtered, turned into records and
encoded off the event loop, and its bytes go straight to the caller. An export of any size runs in
flat memory and downloads while it is produced, from whichever pod serves the request.

The spreadsheet formats (csv/tsv/xlsx) need every column before their first row, so they take one
extra pass over the same records that keeps only their keys. A draft's current state isn't pinned
to a commit, so an edit landing between the two passes can add a property the header lacks.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, Iterable, List, Optional, Set

from .formats import get_adapter
from .rowmodel import column_order, denormalize_edge, denormalize_node
from .snapshot import Snapshot, Winner
from .xlsx_adapter import EXCEL_MAX_ROWS, sheet_columns

logger = logging.getLogger(__name__)

#: The largest export: one streamed or written past it is cut off. 50 GB, what an export prepared on
#: the workers and downloaded in resumable pieces is built for.
MAX_BYTES = int(os.getenv("GRAPH_EXPORT_MAX_BYTES", str(50 * 1024 ** 3)))
#: Exports one server streams at once: one pod, across all of its worker processes (an export keeps
#: about one CPU core busy). Another waits its turn for up to SLOT_WAIT_S, then fails.
CONCURRENCY = int(os.getenv("GRAPH_EXPORT_CONCURRENCY", "2"))
SLOT_WAIT_S = float(os.getenv("GRAPH_EXPORT_SLOT_WAIT_SECS", "900"))
#: How long a plan may spend counting before it answers without exact counts.
PLAN_BUDGET_S = float(os.getenv("GRAPH_EXPORT_PLAN_BUDGET_SECS", "20"))

SPREADSHEET_FORMATS = ("csv", "tsv", "xlsx")

MEDIA_TYPES = {
    "ndjson": "application/x-ndjson",
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class ExportTooLarge(Exception):
    """The export passed :data:`MAX_BYTES`."""


class ExportsBusy(Exception):
    """No turn for the export came up within :data:`SLOT_WAIT_S`."""


class ExcelRowLimit(ValueError):
    """More rows than an Excel sheet holds."""


# ── What an export holds ─────────────────────────────────────────────────────


@dataclass
class Selection:
    """Which entities an export holds: a view's entities and/or an explicit selection.

    A node needs to be in the view and to match the selection. An edge needs both its ends kept:
    under a selection, both ends live and selected; under a view alone, both ends among the view's
    entities; with neither, every edge."""

    #: The view's entity ids; ``None`` for the whole data source.
    keep: Optional[Set[str]] = None
    #: Entity ids or URNs to export only.
    ids: Set[str] = field(default_factory=set)
    #: Entity types to export only (lower-cased).
    types: Set[str] = field(default_factory=set)

    @classmethod
    def of(cls, *, keep: Optional[Set[str]] = None, ids: Iterable[str] = (),
           types: Iterable[str] = ()) -> "Selection":
        return cls(keep=keep, ids={str(i) for i in ids if str(i).strip()},
                   types={str(t).strip().lower() for t in types if str(t).strip()})

    @property
    def selects(self) -> bool:
        return bool(self.ids or self.types)

    def node_ok(self, w: Winner) -> bool:
        if self.keep is not None and w.entity_id not in self.keep:
            return False
        if self.ids and w.entity_id not in self.ids and w.urn not in self.ids:
            return False
        if self.types and str(w.entity_type or "").strip().lower() not in self.types:
            return False
        return True

    def edge_ok(self, w: Winner, ends: Dict[str, Winner]) -> bool:
        if self.selects:
            return all(e in ends and self.node_ok(ends[e]) for e in (w.source_id, w.target_id))
        if self.keep is not None:
            return w.source_id in self.keep and w.target_id in self.keep
        return True


async def resolve_placements(snap: Snapshot, keys: Iterable[str]) -> Dict[str, str]:
    """``key -> entity id`` for a view's placement keys that name a live node here. A key is the
    entity's URN, or ``gv:<entity id>`` for a node without one (as the canvas names it)."""
    keys = list(dict.fromkeys(k for k in keys if k))
    found = await snap.nodes_by_urn(keys)
    rest = {k: (k[3:] if k.startswith("gv:") else k) for k in keys if k not in found}
    live = await snap.lookup_live("node", set(rest.values()))
    return {**found, **{k: eid for k, eid in rest.items() if eid in live}}


async def view_entities(snap: Snapshot, scope: Dict[str, Any]) -> Dict[str, Any]:
    """A view's entities: every node it places, and the containment descendants of each placement
    that inherits its children. Returns ``{keep, placed, found}``: the entity ids, how many
    placements the view has, and how many of them were found here."""
    placed = list(dict.fromkeys(scope.get("assigned_urns") or []))
    inherit = set(scope.get("inherit_urns") or [])
    containment = {str(t).upper() for t in (scope.get("containment_types") or [])}
    eid_of = await resolve_placements(snap, placed)
    roots = {eid for key, eid in eid_of.items() if key in inherit}
    keep = set(eid_of.values()) | await snap.containment_descendants(roots, containment)
    return {"keep": keep, "placed": len(placed), "found": len(eid_of)}


# ── Records ──────────────────────────────────────────────────────────────────


class TypeStats:
    """How many nodes and edges an export holds, by type, in the shape a provider's stats take
    (``nodeCount``, ``edgeCount``, ``entityTypeCounts``, ``edgeTypeCounts``): what the onboarding
    wizard's ontology suggestions read, so a package's data can be matched to a semantic layer
    without its graph. A missing type counts as ``Entity`` / ``REL``, as the projector labels it."""

    def __init__(self) -> None:
        self.counts: Dict[str, Counter] = {"node": Counter(), "edge": Counter()}

    def add(self, kind: str, types: Iterable[Optional[str]]) -> None:
        fallback = "Entity" if kind == "node" else "REL"
        self.counts[kind].update(str(t) if t else fallback for t in types)

    def clear(self) -> None:
        for counter in self.counts.values():
            counter.clear()

    def as_dict(self) -> Dict[str, Any]:
        nodes, edges = self.counts["node"], self.counts["edge"]
        return {"nodeCount": sum(nodes.values()), "edgeCount": sum(edges.values()),
                "entityTypeCounts": dict(nodes), "edgeTypeCounts": dict(edges)}


async def _payload_pages(snap: Snapshot, sel: Selection, kind: str) -> AsyncIterator[List[Winner]]:
    """The live entities of ``kind`` with their payloads, a page at a time. With a view's entities
    (``sel.keep``) only theirs are read: its nodes by id, and of the edges, the skeletons first
    (ends, no payload) and then the payloads of those between two of its nodes — a view of 5,000
    entities on a 200,000-entity graph reads 5,000 payloads, not 200,000."""
    if sel.keep is None:
        async for page in snap.iter_live(kind, payload=True):
            yield page
        return
    if kind == "node":
        ids = sorted(sel.keep)
        for i in range(0, len(ids), snap.page_size):
            chunk = ids[i:i + snap.page_size]
            live = await snap.lookup_live("node", chunk, payload=True)
            if live:
                yield [live[eid] for eid in chunk if eid in live]
        return
    async for page in snap.iter_live("edge"):
        kept = [w.entity_id for w in page if w.source_id in sel.keep and w.target_id in sel.keep]
        live = await snap.lookup_live("edge", kept, payload=True) if kept else {}
        if live:
            yield [live[eid] for eid in kept if eid in live]


def _node_records(page: List[Winner]) -> List[Dict[str, Any]]:
    return [{"kind": "node", **denormalize_node(w.entity_id, w.content_hash, json.loads(w.payload))}
            for w in page if w.payload is not None]


def _edge_records(page: List[Winner], ends: Dict[str, Winner]) -> List[Dict[str, Any]]:
    out = []
    for w in page:
        if w.payload is None:
            continue
        p = json.loads(w.payload)
        s, t = ends.get(p.get("sourceEntityId")), ends.get(p.get("targetEntityId"))
        out.append({"kind": "edge", **denormalize_edge(
            w.entity_id, w.content_hash, p,
            source_qname=s.qualified_name if s else None, target_qname=t.qualified_name if t else None,
            source_urn=s.urn if s else None, target_urn=t.urn if t else None)})
    return out


async def _edge_page(snap: Snapshot, sel: Selection, page: List[Winner]):
    ends = await snap.lookup_live("node", {e for w in page for e in (w.source_id, w.target_id) if e})
    return [w for w in page if sel.edge_ok(w, ends)], ends


async def record_pages(snap: Snapshot, sel: Selection, tally: Optional[Dict[str, int]] = None,
                       stats: Optional[TypeStats] = None) -> AsyncIterator[List[Dict[str, Any]]]:
    """The export's records, a page at a time: every node, then every edge. ``tally``, when
    given, counts this pass's records by kind as they go, and the passes (a spreadsheet takes two);
    ``stats``, this pass's records by type."""
    tally = tally if tally is not None else {}
    tally.update(node=0, edge=0, passes=tally.get("passes", 0) + 1)
    if stats is not None:
        stats.clear()
    async for page in _payload_pages(snap, sel, "node"):
        page = [w for w in page if sel.node_ok(w)]
        if page:
            records = await asyncio.to_thread(_node_records, page)
            tally["node"] += len(records)
            if stats is not None:
                stats.add("node", (r.get("entityType") for r in records))
            yield records
    async for page in _payload_pages(snap, sel, "edge"):
        page, ends = await _edge_page(snap, sel, page)
        if page:
            records = await asyncio.to_thread(_edge_records, page, ends)
            tally["edge"] += len(records)
            if stats is not None:
                stats.add("edge", (r.get("edgeType") for r in records))
            yield records


def _native_lines(kind: str, page: List[Winner], ends: Dict[str, Winner]) -> bytes:
    """Format-2 package lines for ``page``: identity, then the stored payload text verbatim."""
    out = []
    for w in page:
        head: Dict[str, Any] = {"kind": kind, "entity_id": w.entity_id, "baseVersion": w.content_hash}
        if kind == "edge":
            s, t = ends.get(w.source_id), ends.get(w.target_id)
            for key, value in (("sourceUrn", s and s.urn), ("targetUrn", t and t.urn),
                               ("sourceQualifiedName", s and s.qualified_name),
                               ("targetQualifiedName", t and t.qualified_name)):
                if value:
                    head[key] = value
        out.append(f'{json.dumps(head)[:-1]},"payload":{w.payload}}}\n')
    return "".join(out).encode("utf-8")


async def native_pages(snap: Snapshot, sel: Selection, tally: Optional[Dict[str, int]] = None,
                       stats: Optional[TypeStats] = None) -> AsyncIterator[bytes]:
    """The export as a view package's format-2 data lines, a page of bytes at a time: every node,
    then every edge, each ``{kind, entity_id, baseVersion, …, payload}`` with the payload exactly as
    stored — its JSON text written as read, never decoded and encoded again, so nothing a flat record
    can't hold is lost and the export costs no JSON work per row. An edge also carries its ends'
    URNs and qualified names (its payload has only their entity ids, minted per graph).
    ``tally``/``stats`` as for :func:`record_pages`, counted from the version columns.

    What the package writer switches to one release after readers accept format 2
    (``view_transfer.package``); ``rowmodel.normalize`` reads these lines today."""
    tally = tally if tally is not None else {}
    tally.update(node=0, edge=0, passes=tally.get("passes", 0) + 1)
    if stats is not None:
        stats.clear()
    async for page in _payload_pages(snap, sel, "node"):
        page = [w for w in page if sel.node_ok(w) and w.payload is not None]
        if page:
            tally["node"] += len(page)
            if stats is not None:
                stats.add("node", (w.entity_type for w in page))
            yield await asyncio.to_thread(_native_lines, "node", page, {})
    async for page in _payload_pages(snap, sel, "edge"):
        page, ends = await _edge_page(snap, sel, page)
        page = [w for w in page if w.payload is not None]
        if page:
            tally["edge"] += len(page)
            if stats is not None:
                stats.add("edge", (w.edge_type for w in page))
            yield await asyncio.to_thread(_native_lines, "edge", page, ends)


async def first_records(snap: Snapshot, limit: int) -> List[Dict[str, Any]]:
    """Up to ``limit`` nodes and ``limit`` edges as export records — a starter template's rows —
    from the first page of each that holds any, never the whole graph."""
    records: List[Dict[str, Any]] = []
    async for page in snap.iter_live("node", payload=True):
        records += await asyncio.to_thread(_node_records, page[:limit])
        break
    async for page in snap.iter_live("edge", payload=True):
        page = page[:limit]
        ends = await snap.lookup_live("node", {e for w in page for e in (w.source_id, w.target_id) if e})
        records += await asyncio.to_thread(_edge_records, page, ends)
        break
    return records


@dataclass
class Columns:
    #: The export's columns, in ``column_order``'s order.
    columns: List[str]
    #: Each xlsx sheet's columns (``node``/``edge``).
    sheets: Dict[str, List[str]]
    counts: Dict[str, int]


async def columns_of(pages: AsyncIterator[List[Dict[str, Any]]], extra_props: Iterable[str] = ()) -> Columns:
    """The spreadsheet columns, from a pass over the records that keeps only their keys."""
    keys: Dict[str, Set[str]] = {"node": set(), "edge": set()}
    counts = {"node": 0, "edge": 0}
    async for page in pages:
        for rec in page:
            keys[rec["kind"]].update(rec)
            counts[rec["kind"]] += 1
    # One record per kind carrying every key that kind has: what column_order and the sheet
    # columns read from a full record list, without keeping one.
    present = [{**dict.fromkeys(keys[k]), "kind": k} for k in ("node", "edge") if counts[k]]
    extra = [p for p in extra_props if str(p).strip()]
    columns = column_order(present, {"node": extra, "edge": extra} if extra else None)
    sheets = {k: sheet_columns([r for r in present if r["kind"] == k], columns) for k in ("node", "edge")}
    return Columns(columns=columns, sheets=sheets, counts=counts)


def excel_overflow(counts: Dict[str, int]) -> Optional[str]:
    """Why an Excel workbook can't hold ``counts`` (per kind), or ``None``."""
    for kind, sheet in (("node", "Nodes"), ("edge", "Edges")):
        if counts.get(kind, 0) > EXCEL_MAX_ROWS:
            return (f"This export has {counts[kind]:,} {kind}s, more than the {EXCEL_MAX_ROWS:,} rows "
                    f"an Excel sheet holds ({sheet}). Export it as CSV or NDJSON, or export a view or "
                    "a selection.")
    return None


def check_excel(counts: Dict[str, int]) -> None:
    reason = excel_overflow(counts)
    if reason:
        raise ExcelRowLimit(reason)


#: Opens a csv/tsv export: flushes the response at once (the columns take a pass to find), and tells
#: Excel the file is UTF-8, which it otherwise misreads. Imports strip it.
_BOM = "\ufeff".encode("utf-8")


async def write_export(pages: Callable[[], AsyncIterator[List[Dict[str, Any]]]], *, fmt: str,
                       columns: Optional[Columns] = None, props: Iterable[str] = ()) -> AsyncIterator[bytes]:
    """The export file's bytes, as they are produced. ``pages()`` starts a pass over the records
    (every node, then every edge); the spreadsheet formats take two, the first for their columns
    (with ``props`` added as empty ones), unless ``columns`` were already found."""
    adapter = get_adapter(fmt)

    async def body() -> AsyncIterator[bytes]:
        found = columns
        if fmt in SPREADSHEET_FORMATS and fmt != "xlsx":
            yield _BOM
        if fmt in SPREADSHEET_FORMATS and found is None:
            found = await columns_of(pages(), props)
        if fmt == "xlsx":
            check_excel(found.counts)
            async for chunk in adapter.write_pages(pages(), sheets=found.sheets):
                yield chunk
        elif fmt in SPREADSHEET_FORMATS:
            async for chunk in adapter.write_pages(pages(), columns=found.columns):
                yield chunk
        else:
            async for chunk in adapter.write_pages(pages()):
                yield chunk

    total = 0
    async for chunk in body():
        total += len(chunk)
        if total > MAX_BYTES:
            raise ExportTooLarge(f"export passed {MAX_BYTES:,} bytes")
        yield chunk


# ── Counting ─────────────────────────────────────────────────────────────────


async def count(snap: Snapshot, sel: Selection, *, budget_s: float = PLAN_BUDGET_S) -> Dict[str, Any]:
    """How many nodes and edges the export holds, without reading payloads. A whole published graph
    is counted from its head pointers at once; anything else is counted page by page until
    ``budget_s`` runs out, when the counts come back as ``None`` (unknown)."""
    if sel.keep is None and not sel.selects:
        heads = await snap.head_counts()
        if heads is not None:
            return {"nodes": heads["node"], "edges": heads["edge"], "exact": True}
    deadline = time.monotonic() + budget_s
    counts = {"node": 0, "edge": 0}
    for kind in ("node", "edge"):
        async for page in snap.iter_live(kind):
            if kind == "node":
                counts[kind] += sum(1 for w in page if sel.node_ok(w))
            elif sel.selects:
                counts[kind] += len((await _edge_page(snap, sel, page))[0])
            else:
                counts[kind] += sum(1 for w in page if sel.edge_ok(w, {}))
            if time.monotonic() > deadline:
                seen = counts["node"] + counts["edge"]
                return {"nodes": None, "edges": None, "exact": False, "seen": seen}
    return {"nodes": counts["node"], "edges": counts["edge"], "exact": True}


# ── Taking turns ─────────────────────────────────────────────────────────────


class Slots:
    """At most ``limit`` exports streaming at once on this server. A turn is an exclusive lock on
    one of ``limit`` files in ``directory``, which every worker process of a pod shares, so the
    limit holds for the pod rather than for each of its workers; and the kernel drops a lock when
    its holder exits, so a worker that dies never keeps its turn."""

    def __init__(self, limit: int, directory: Optional[str] = None) -> None:
        directory = directory or tempfile.gettempdir()
        self.paths = [os.path.join(directory, f"graph-export-turn-{i}.lock") for i in range(max(1, limit))]

    def _take(self) -> Optional[int]:
        for path in self.paths:
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except BlockingIOError:
                os.close(fd)
        return None

    async def acquire(self, wait_s: float) -> Optional[int]:
        """A turn, to hand back with :meth:`release`; ``None`` when none frees up in ``wait_s``."""
        deadline = time.monotonic() + wait_s
        while (turn := self._take()) is None:
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.25)
        return turn

    @staticmethod
    def release(turn: int) -> None:
        os.close(turn)                              # closing the file drops its lock


slots = Slots(CONCURRENCY)


async def in_turn(body: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """An export job's ``body``, once its turn comes, or :class:`ExportsBusy` if none does within
    :data:`SLOT_WAIT_S`. The turn goes back when the export ends or is closed. (A download takes
    its turn before its response starts, in ``graph_export.take_turn``.)"""
    turn = await slots.acquire(SLOT_WAIT_S)
    if turn is None:
        raise ExportsBusy("Too many exports are running right now. Try again in a few minutes.")
    try:
        async for chunk in body:
            yield chunk
    finally:
        slots.release(turn)
