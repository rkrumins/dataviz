"""Change lists that open at any size: a draft's changes, a revision's, two revisions compared.

Every surface that shows "what changed" used to build its answer per request from every changed
payload: the review drawer downloaded ~100 MB for a 100k-change draft, a revision's drill-down
had no size guard, and the Changes tab stopped at "too many to list". A change list is now one
**index per origin**, classified once from content hashes and version-row columns — no payload —
and kept for its pages:

- a **draft**: its heads against ``main`` at its branch point (what the draft changes);
- a **window** of ``main``: ``(from_seq, to_seq]`` — one revision is ``(K-1, K]``, two
  revisions compared are ``(A, B]``, what came in since a revision is ``(K, head]``.

The summary (counts by kind, status and type) and the list come from the same index, so they
always agree. Pages are offsets into its filtered view: its order is fixed when it is built and
the index is immutable for its key, so an offset means the same thing on every page and in every
process. Past ``CHANGE_LIST_MAX`` entities an origin is counted and not listed.

This module is pure: the entry type, classification, ordering, filtering and the cache. Reading
the store is :class:`GraphVersioningService`'s (``change_summary`` and its siblings).
"""
from __future__ import annotations

import asyncio
import threading
from array import array
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, NamedTuple, Optional, Tuple

STATUSES = ("added", "modified", "removed")
#: What a list can be narrowed to: entities, relationships, or the containment links that say
#: what is inside what (structure, which the Changes tree draws as nesting).
KINDS = ("node", "edge", "structure")


@dataclass(frozen=True)
class ChangeOrigin:
    """Whose changes: a draft's (``branch_id``) or ``main``'s between two of its revisions
    (``from_seq`` exclusive, ``to_seq`` inclusive). Exactly one of the two."""

    branch_id: Optional[str] = None
    from_seq: Optional[int] = None
    to_seq: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        if self.branch_id is not None:
            return {"branchId": self.branch_id}
        return {"fromSeq": self.from_seq, "toSeq": self.to_seq}


class ChangeEntry(NamedTuple):
    """One entity's change, told without its payload: what its version row says of it."""

    entity_id: str
    kind: str                       # "node" | "edge"
    status: str                     # "added" | "modified" | "removed"
    type: Optional[str]             # a node's entityType, an edge's edgeType
    name: Optional[str]             # a node's displayName
    qname: Optional[str]            # a node's qualifiedName
    urn: Optional[str]              # a node's urn
    src: Optional[str]              # an edge's ends, as entity ids
    tgt: Optional[str]
    structural: bool                # a containment edge: structure, not a relationship


def classify(before: Any, after: Any) -> Optional[str]:
    """What happened to one entity between two states, from content hashes. ``before`` and
    ``after`` are its stored values (anything with a ``content_hash``), ``None`` where it is not
    live. ``None`` back: no net change (it was changed and changed back)."""
    if before is None:
        return "added" if after is not None else None
    if after is None:
        return "removed"
    return "modified" if before.content_hash != after.content_hash else None


def _zero() -> Dict[str, int]:
    return {"added": 0, "modified": 0, "removed": 0}


def _bucket(entry: ChangeEntry) -> str:
    if entry.kind == "node":
        return "node"
    return "structure" if entry.structural else "edge"


def _sort_key(e: ChangeEntry) -> tuple:
    # Entities first, then relationships, then structure; within each by type, then name (an
    # edge has none of its own: its ends are named per page), then id — a total order.
    return (_bucket(e) != "node", e.structural, (e.type or "").casefold(),
            (e.name or e.urn or "").casefold(), e.entity_id)


class ChangeIndexBuilder:
    """Classifies an origin's entities a page at a time: counts always, entries while ``keep``
    (an origin past ``CHANGE_LIST_MAX`` is counted without keeping them). Pure CPU — callers run
    :meth:`add_pairs` and :meth:`finish` in a thread."""

    def __init__(self, containment_types: Iterable[str], keep: bool = True):
        self._cset = frozenset((t or "").upper() for t in (containment_types or ()))
        self._keep = keep
        self._entries: List[ChangeEntry] = []
        self._counts = {"all": _zero(), "node": _zero(), "edge": _zero(), "structure": _zero()}
        self._impact: Dict[str, int] = {}
        self._by_type: Dict[Tuple[str, Optional[str]], Dict[str, int]] = {}

    def add(self, entity_id: str, before: Any, after: Any) -> None:
        status = classify(before, after)
        if status is None:
            return
        # Named as it is now (added, modified) or as it was (removed).
        live = after if after is not None else before
        kind = "node" if live.kind == "node" else "edge"
        typ = live.type
        structural = kind == "edge" and (typ or "").upper() in self._cset
        bucket = "node" if kind == "node" else ("structure" if structural else "edge")
        self._counts["all"][status] += 1
        self._counts[bucket][status] += 1
        if kind == "node":
            self._impact[typ or "Other"] = self._impact.get(typ or "Other", 0) + 1
        slot = self._by_type.setdefault((bucket, typ), _zero())
        slot[status] += 1
        if self._keep:
            self._entries.append(ChangeEntry(
                entity_id, kind, status, typ,
                live.name if kind == "node" else None, live.qname if kind == "node" else None,
                live.urn if kind == "node" else None,
                live.src if kind == "edge" else None, live.tgt if kind == "edge" else None,
                structural))

    def add_pairs(self, pairs: Iterable[Tuple[str, Any, Any]]) -> None:
        for entity_id, before, after in pairs:
            self.add(entity_id, before, after)

    def finish(self, *, too_large: Optional[Dict[str, int]] = None,
               window: Optional[Dict[str, Any]] = None) -> "ChangeIndex":
        entries = sorted(self._entries, key=_sort_key) if self._keep else []
        by_type = [{"kind": bucket, "type": typ, **counts}
                   for (bucket, typ), counts in self._by_type.items()]
        by_type.sort(key=lambda r: (-(r["added"] + r["modified"] + r["removed"]),
                                    r["kind"], (r["type"] or "").casefold()))
        return ChangeIndex(
            entries,
            counts=self._counts["all"], entity_counts=self._counts["node"],
            edge_counts=self._counts["edge"], structure_counts=self._counts["structure"],
            impact=self._impact, by_type=by_type, too_large=too_large, window=window)


def _matches(e: ChangeEntry, kind: Optional[str], statuses: frozenset, type_: Optional[str],
             q: Optional[str]) -> bool:
    if kind is not None and _bucket(e) != kind:
        return False
    if statuses and e.status not in statuses:
        return False
    if type_ is not None and e.type != type_:
        return False
    if q:
        return any(q in (v or "").casefold() for v in (e.name, e.qname, e.urn, e.type, e.entity_id))
    return True


class ChangeIndex:
    """An origin's classified changes in their fixed order, with their counts. Immutable once
    built; filtered views are kept per filter (the last few), since paging through one asks for
    the same view again and again."""

    _VIEWS_KEPT = 8

    def __init__(self, entries: List[ChangeEntry], *, counts: Dict[str, int],
                 entity_counts: Optional[Dict[str, int]], edge_counts: Optional[Dict[str, int]],
                 structure_counts: Optional[Dict[str, int]], impact: Dict[str, int],
                 by_type: List[Dict[str, Any]], too_large: Optional[Dict[str, int]] = None,
                 window: Optional[Dict[str, Any]] = None, approximate: bool = False):
        self.entries = entries
        self.by_id: Dict[str, int] = {e.entity_id: i for i, e in enumerate(entries)}
        self.counts = counts
        self.entity_counts = entity_counts
        self.edge_counts = edge_counts
        self.structure_counts = structure_counts
        self.impact = impact
        self.by_type = by_type
        self.too_large = too_large
        self.window = window
        self.approximate = approximate
        self._views: "OrderedDict[tuple, array]" = OrderedDict()
        self._lock = threading.Lock()

    @classmethod
    def counted(cls, counts: Dict[str, int], *, too_large: Dict[str, int],
                window: Optional[Dict[str, Any]], approximate: bool) -> "ChangeIndex":
        """An origin too large to list, counted from what each revision recorded of itself
        (``commits.stats``): no per-kind or per-type split, and over more than one revision an
        upper bound (an entity changed twice is counted twice)."""
        return cls([], counts=counts, entity_counts=None, edge_counts=None, structure_counts=None,
                   impact={}, by_type=[], too_large=too_large, window=window,
                   approximate=approximate)

    @property
    def size(self) -> int:
        """What it holds against the cache's bound: an entry each (one for a counted origin)."""
        return max(1, len(self.entries))

    def summary(self, origin: ChangeOrigin) -> Dict[str, Any]:
        return {
            "origin": origin.as_dict(),
            "counts": dict(self.counts),
            "entityCounts": self.entity_counts,
            "edgeCounts": self.edge_counts,
            "structureCounts": self.structure_counts,
            "impact": dict(self.impact),
            "byType": list(self.by_type),
            "total": sum(self.counts.values()),
            "listed": len(self.entries),
            "approximate": self.approximate,
            "tooLarge": self.too_large,
            "window": self.window,
        }

    def view(self, *, kind: Optional[str] = None, statuses: Iterable[str] = (),
             type_: Optional[str] = None, q: Optional[str] = None) -> array:
        """The positions of the entries a filter keeps, in the index's order. O(entries) the first
        time a filter is asked for; run it in a thread."""
        wanted = frozenset(statuses or ())
        needle = (q or "").strip().casefold() or None
        key = (kind, wanted, type_, needle)
        with self._lock:
            hit = self._views.get(key)
            if hit is not None:
                self._views.move_to_end(key)
                return hit
        if kind is None and not wanted and type_ is None and needle is None:
            positions = array("I", range(len(self.entries)))
        else:
            positions = array("I", (i for i, e in enumerate(self.entries)
                                    if _matches(e, kind, wanted, type_, needle)))
        with self._lock:
            self._views[key] = positions
            while len(self._views) > self._VIEWS_KEPT:
                self._views.popitem(last=False)
        return positions

    def page(self, positions: array, offset: int, limit: int) -> List[ChangeEntry]:
        return [self.entries[i] for i in positions[offset:offset + limit]]

    def status_of(self, entity_id: str) -> Optional[str]:
        i = self.by_id.get(entity_id)
        return self.entries[i].status if i is not None else None


def entry_dict(e: ChangeEntry, names: Mapping[str, Optional[str]]) -> Dict[str, Any]:
    """An entry as the list's rows read it. An edge's ends are named from ``names`` (entity id →
    display name), looked up for the page it is on."""
    out: Dict[str, Any] = {"entityId": e.entity_id, "kind": e.kind, "status": e.status,
                           "type": e.type, "structural": e.structural}
    if e.kind == "node":
        out.update({"displayName": e.name, "qualifiedName": e.qname, "urn": e.urn})
    else:
        out.update({"sourceEntityId": e.src, "targetEntityId": e.tgt,
                    "sourceName": names.get(e.src or ""), "targetName": names.get(e.tgt or "")})
    return out


_STATUS_CODE = {"added": "a", "modified": "m", "removed": "r"}


def compact_entries(index: ChangeIndex) -> List[list]:
    """Every entry as a short array — ``[entityId, "n"|"e", "a"|"m"|"r", type]``, an edge with
    its ends after — what the canvas decorates by and finds created entities and their parents
    from, at about 70 bytes an entry instead of a payload."""
    out: List[list] = []
    for e in index.entries:
        status = _STATUS_CODE[e.status]
        if e.kind == "node":
            out.append([e.entity_id, "n", status, e.type])
        else:
            out.append([e.entity_id, "e", status, e.type, e.src, e.tgt])
    return out


def stat_changes(stats: Any) -> Tuple[int, int, int]:
    """``(create, update, delete)`` a revision recorded of itself in ``commits.stats``. Imports
    and genesis record ``{nodes, edges}`` (everything they brought in); the rest record
    ``{create, update, delete}``, nodes and edges together."""
    if not isinstance(stats, Mapping):
        return 0, 0, 0
    if any(k in stats for k in ("create", "update", "delete")):
        return (int(stats.get("create") or 0), int(stats.get("update") or 0),
                int(stats.get("delete") or 0))
    return int(stats.get("nodes") or 0) + int(stats.get("edges") or 0), 0, 0


class IndexCache:
    """This process's change indexes, keyed by what an index is of (an immutable version of its
    origin), each built once however many readers ask at the same time. Bounded by the entries
    they hold together (``limit()``), not by their number; the newest is kept whatever its size.
    A reader that gives up does not cancel a build another is waiting on."""

    def __init__(self, limit: Callable[[], int]):
        self._limit = limit
        self._held = 0
        self._items: "OrderedDict[tuple, ChangeIndex]" = OrderedDict()
        self._building: Dict[tuple, asyncio.Task] = {}

    async def get(self, key: tuple, build: Callable[[], Awaitable[ChangeIndex]]) -> ChangeIndex:
        hit = self._items.get(key)
        if hit is not None:
            self._items.move_to_end(key)
            return hit
        task = self._building.get(key)
        if task is None or task.get_loop() is not asyncio.get_running_loop():
            task = asyncio.ensure_future(build())
            self._building[key] = task
            task.add_done_callback(lambda t, k=key: self._settle(k, t))
        return await asyncio.shield(task)

    def _settle(self, key: tuple, task: asyncio.Task) -> None:
        if self._building.get(key) is task:
            del self._building[key]
        if task.cancelled() or task.exception() is not None:
            return
        index = task.result()
        old = self._items.pop(key, None)
        if old is not None:
            self._held -= old.size
        self._items[key] = index
        self._held += index.size
        while self._held > self._limit() and len(self._items) > 1:
            self._held -= self._items.popitem(last=False)[1].size

    def clear(self) -> None:
        self._items.clear()
        self._held = 0
