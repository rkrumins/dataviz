"""Draft = main ⊕ sparse delta — a read-overlay so a no-change draft reads *identically* to main.

The journey invariant: opening a draft off main must change **nothing** — every node and every edge,
including the materialised aggregated-lineage rollups — until the draft actually edits something; then
only the entities it added / removed / changed may differ. The old draft provider composed the WHOLE
state from Postgres, which lacks the aggregated rollups main's FalkorDB has, so a no-change draft lost
all rolled-up lineage.

This provider instead **reuses main's reads** (whatever serves main — live FalkorDB when fresh, else
the Postgres main reader) and overlays only the draft's bounded patch set
(:meth:`GraphVersioningService.branch_overlay_delta`). For a no-change draft the patch set is empty and
every read is a pure pass-through → the draft IS main, by construction. Cost is ``O(main_read + delta)``
— never a per-draft FalkorDB graph and never a full re-derivation. Writes commit to the draft via the
ordinary branch path (reused from :class:`VersionedBranchProvider`).
"""
from __future__ import annotations

import asyncio
import copy
import logging
from collections import ChainMap, OrderedDict
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Tuple, TypeVar

from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.errors import RevisionReadOnly, RevisionUnsupported
from backend.common.interfaces.provider import resolve_identities_by_query
from backend.common.models.graph import (
    AggregatedEdgeInfo, AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphEdge,
    GraphNode, NodePage, NodeQuery, TopLevelNodesResult, TraceClosureResult, TraceResult,
)
from .versioned_branch_provider import VersionedBranchProvider

#: The overlay patches whatever trace shape it is handed and hands the SAME
#: shape back — a closure in, a closure out. Declaring the base type lost
#: ``frontierUp``/``frontierDown``/``seedTruncated`` to every static reader.
_TraceT = TypeVar("_TraceT", bound=TraceResult)

logger = logging.getLogger(__name__)

#: The scope notes a search through an overlay carries (``search_scope_note``): the base answers it.
DRAFT_SEARCH_NOTE = ("draft-only changes are not searchable yet: results come from the "
                     "published graph")
FORK_SEARCH_NOTE = ("the fork's own changes are not searchable yet: results come from the "
                    "parent data source's published graph")
DRAFT_ON_FORK_SEARCH_NOTE = ("draft-only changes and the fork's own changes are not searchable "
                             "yet: results come from the parent data source's published graph")


#: Where an overlay listing's tail starts. A listing's first page holds at most a page of what the
#: overlay added there, in name order; the rest come after the store's last page, at positions the
#: overlay owns — offsets from here (far past any store's row count, so never taken for a store's
#: position, and 2**40 is still an integer a browser holds exactly) or, for a listing paged by
#: cursor, cursors with this prefix. A 100k-node import used to arrive on the first page whole.
_TAIL_OFFSET = 1 << 40
_TAIL_CURSOR = "~overlay-tail:"


def _tail_index(offset: Optional[int] = 0, cursor: Optional[str] = None) -> Optional[int]:
    """How far into an overlay listing's tail a position is, or None for the store's own."""
    if cursor and cursor.startswith(_TAIL_CURSOR):
        try:
            return max(0, int(cursor[len(_TAIL_CURSOR):]))
        except ValueError:
            return 0
    if (offset or 0) >= _TAIL_OFFSET:
        return (offset or 0) - _TAIL_OFFSET
    return None


def _by_name(d: "_OverlayDelta", urns: Iterable[str]) -> List[str]:
    """``urns`` in name order (then urn), by the names the patch set holds for them."""
    def key(u: str):
        n = d.node_index.get(u)
        return ((n.display_name or "").casefold() if n is not None else "", u)
    return sorted(urns, key=key)


def _created_first(created: List[str], offset: int, limit: int) -> Tuple[List[str], Optional[Dict[str, int]]]:
    """A listing's page of one order — the draft's new nodes, then main's rows — so that every
    page is a slice of it and none has to remember an earlier one: the new nodes on the page, and
    the offset and limit of main's part of it (``None`` when they fill it)."""
    page = created[offset:offset + limit]
    room = limit - len(page)
    return page, ({"offset": max(0, offset - len(created)), "limit": room} if room > 0 else None)


class _OverlayDelta:
    """Indexed, reader-shaped view of a draft's patch set vs its main base.

    What the draft created or changed comes as skeletons — ``lazy`` entries, what the version row
    says (a node's urn, type and names; an edge's type and ends) — never payloads, so building this
    costs a draft's size in small objects, not its payloads. The index lists, matches and searches
    by those fields alone; a read loads the values of just the nodes (:meth:`load`) and edges
    (:meth:`edges`) it serves."""

    def __init__(self, raw: Dict[str, Any], containment_types: List[str]):
        cset = {t.upper() for t in (containment_types or [])}
        # What the cache counts this delta as holding; and a fork's patch set, which the next
        # build of the fork extends when only its root moved (``since`` says what it is of), kept
        # compact (:func:`_keep`).
        self.size = max(1, sum(len(raw.get(k) or ()) for k in (
            "nodesUpsert", "nodesModified", "nodesRemove", "edgesUpsert", "edgesRemove")))
        self.raw: Optional[Dict[str, Any]] = _keep(raw) if raw.get("since") else None
        self.node_upsert: Dict[str, GraphNode] = {}         # values to serve, by urn
        # Every node the patch set gives a value or a skeleton for, by urn: what listings, matches
        # and searches read. A skeleton is served once loaded.
        self.node_index: Dict[str, GraphNode] = {}
        self.node_new: set = set(raw.get("nodesNew", []))   # urns CREATED in the draft (vs modified)
        self.node_remove: set = set()
        self.edge_upsert: Dict[str, GraphEdge] = {}
        # Each of edge_upsert by the urn of either end, once per patch set: a read naming its ends
        # walks the edges it asks about, never every edge a 100k-edge import added.
        self.edges_at: Dict[str, List[GraphEdge]] = {}
        self.edge_lazy: set = set()                         # ids of the skeletons among edge_upsert
        self.edge_remove: Dict[str, GraphEdge] = {}
        self.lineage_added: List[GraphEdge] = []
        self.lineage_removed: List[GraphEdge] = []
        # parent urn -> net containment-child delta (drives childCount + children overlay)
        self.child_count_delta: Dict[str, int] = {}
        self.cont_added: List[GraphEdge] = []
        self.cont_removed: List[GraphEdge] = []
        # What reads of this delta look up once and share (:meth:`DraftOverlayProvider._chains`):
        # a request's view (:meth:`for_request`) is a shallow copy, so it holds this same dict.
        self.shared: Dict[str, Any] = {}

        # Nodes the draft modified or created, by urn → entity id: a read loads the ones it serves
        # (load()).
        self.node_modified: Dict[str, str] = {m["urn"]: m["entityId"] for m in raw.get("nodesModified", [])}
        # A skeleton's default_factory fields are given, not left to model_construct: it resolves
        # each through ``inspect.signature`` per instance, and on a 100k+100k draft that was 35 s of
        # CPU — and garbage enough to set off full collections that stalled the event loop.
        for d in raw.get("nodesUpsert", []):
            if d.get("lazy"):                               # fields straight from version columns
                n = GraphNode.model_construct(**d, properties={}, tags=[])
                self.node_modified[n.urn] = d["entityId"]
            else:
                n = GraphNode(**d)
                self.node_upsert[n.urn] = n
            self.node_index[n.urn] = n
        self._loader: Optional[Callable[[List[str]], Awaitable[List[dict]]]] = None
        self._edge_loader: Optional[Callable[[List[str]], Awaitable[List[dict]]]] = None
        self._edges_loaded: Dict[str, GraphEdge] = {}
        for d in raw.get("nodesRemove", []):
            self.node_remove.add(d["urn"])
        for d in raw.get("edgesUpsert", []):
            # ``was``: the base holds this edge too, there — its ends and type. It is served with
            # the overlay's value, and counted where it runs now: an edge still between the same
            # ends as the same type is counted as the base counts it already, never once more.
            was = d.get("was")
            fields = {k: v for k, v in d.items() if k != "was"}
            if d.get("lazy"):
                e = GraphEdge.model_construct(**fields, properties={})
                self.edge_lazy.add(e.id)
            else:
                e = GraphEdge(**fields)
            self.edge_upsert[e.id] = e
            for end in {e.source_urn, e.target_urn}:
                self.edges_at.setdefault(end, []).append(e)
            if was is not None:
                held = GraphEdge.model_construct(id=e.id, sourceUrn=was["sourceUrn"],
                                                 targetUrn=was["targetUrn"],
                                                 edgeType=was["edgeType"], properties={})
                if (held.source_urn, held.target_urn, (held.edge_type or "").upper()) == (
                        e.source_urn, e.target_urn, (e.edge_type or "").upper()):
                    continue
                self._count(held, -1, cset)
            self._count(e, +1, cset)
        for d in raw.get("edgesRemove", []):
            e = GraphEdge(**d)
            self.edge_remove[e.id] = e
            self._count(e, -1, cset)

    def _count(self, e: GraphEdge, sign: int, cset: set) -> None:
        """Count ``e`` in (+1) or out (-1) where it runs: a containment edge in its source's child
        count, a lineage edge in the rollups and degrees."""
        if (e.edge_type or "").upper() in cset:
            (self.cont_added if sign > 0 else self.cont_removed).append(e)
            self.child_count_delta[e.source_urn] = self.child_count_delta.get(e.source_urn, 0) + sign
        else:
            (self.lineage_added if sign > 0 else self.lineage_removed).append(e)

    @property
    def empty(self) -> bool:
        return not (self.node_upsert or self.node_modified or self.node_remove
                    or self.edge_upsert or self.edge_remove)

    @property
    def structure_moved(self) -> bool:
        """Whether the patch set moves something between containers — gives a child a
        containment link it also takes one from — so a rollup the store grouped by where it holds
        things is grouped differently on the overlay's state. Computed once per patch set."""
        hit = self.shared.get("structure-moved")
        if hit is None:
            given = {e.target_urn for e in self.cont_added}
            hit = self.shared["structure-moved"] = any(e.target_urn in given for e in self.cont_removed)
        return hit

    def for_request(self, loader: Callable[[List[str]], Awaitable[List[dict]]],
                    edge_loader: Optional[Callable[[List[str]], Awaitable[List[dict]]]] = None,
                    ) -> "_OverlayDelta":
        """This delta for one request: every index shared, plus the nodes and edges this request
        loads — kept apart, so a delta reused across requests never accumulates their payloads."""
        view = copy.copy(self)
        view.node_upsert = ChainMap({}, self.node_upsert)
        view._loader = loader
        view._edge_loader = edge_loader
        view._edges_loaded = {}
        return view

    async def load(self, urns: Iterable[str]) -> None:
        """Bring the draft's value of each node among ``urns`` it modified or created into this
        request's view. Every read that serves draft nodes calls it first, with those nodes."""
        want = [u for u in dict.fromkeys(urns) if u in self.node_modified and u not in self.node_upsert]
        if not want or self._loader is None:
            return
        for d in await self._loader([self.node_modified[u] for u in want]):
            n = GraphNode(**d)
            self.node_upsert[n.urn] = n

    async def served(self, urns: Iterable[str]) -> List[GraphNode]:
        """The draft's value of each of ``urns`` (nodes the index matched), loaded where it is a
        skeleton — in their order. A node whose value is gone by now is left out."""
        urns = list(urns)
        await self.load(urns)
        return [self.node_upsert[u] for u in urns if u in self.node_upsert]

    async def edges(self, edges: List[GraphEdge]) -> List[GraphEdge]:
        """``edges`` as served: each the draft added or changed carries its value, loaded for this
        response (only those among ``edges``); the rest as they are."""
        want = [e.id for e in edges if e.id in self.edge_lazy and e.id not in self._edges_loaded]
        if want and self._edge_loader is not None:
            for d in await self._edge_loader(list(dict.fromkeys(want))):
                e = GraphEdge(**d)
                self._edges_loaded[e.id] = e
        return [self._edges_loaded.get(e.id, e) for e in edges]

    @property
    def lineage_changed(self) -> bool:
        return bool(self.lineage_added or self.lineage_removed)

    def with_child_count(self, node: GraphNode) -> GraphNode:
        """Adjust a base/upserted node's childCount by the draft's containment delta under it."""
        adj = self.child_count_delta.get(node.urn)
        if not adj:
            return node
        return node.model_copy(update={"child_count": max(0, (node.child_count or 0) + adj)})

    def compose_page(
        self, base_items: List[GraphNode], added: List[GraphNode], *, first_page: bool,
        base_total: Optional[int], removed: int, added_total: Optional[int] = None,
    ) -> "tuple[List[GraphNode], Optional[int]]":
        """ONE rule for every listing the draft patches (a container's children, the
        top-level set): main's page with each item overlaid or dropped, the draft's NEW
        items on the first page only, and the listing's size as main's plus what the
        draft added minus what it removed from it.

        Positions — where the next page starts, whether there is one — stay MAIN's
        (the caller passes the base page's through): that is what lets a client that
        holds the draft's new items plus main's first pages ask for the next page and
        get exactly the rows it has not seen. Serving the new items on every page
        repeated them; counting them into the position skipped a row of main per item
        (a new child pushed an existing sibling out of view, and "Load N more" asked
        past the end forever); reporting the page length as the total invented or hid
        a remainder.

        ``added`` is what this page serves of the draft's new items — at most a page; the rest
        follow the store's last page (``_TAIL_OFFSET``) — and ``added_total`` how many there are,
        which the listing's size counts (default: ``added``'s)."""
        items: List[GraphNode] = []
        for n in base_items:
            merged = self.overlay_existing(n)
            if merged is not None:
                items.append(merged)
        if first_page:
            present = {n.urn for n in items}
            for n in added:
                if n.urn not in present:
                    items.append(n)
                    present.add(n.urn)
        n_added = len(added) if added_total is None else added_total
        total = None if base_total is None else max(0, base_total + n_added - removed)
        return items, total

    def overlay_existing(self, base_node: GraphNode) -> Optional[GraphNode]:
        """The visible form of a node that EXISTS in base (main): removed → None; modified → the
        draft's changed fields but KEEPING the base node's containment context (childCount, and its
        tree position) — the upsert from ``branch_overlay_delta`` is a reader node with NO childCount,
        so a plain replace would orphan a renamed node (childCount→0, drops out of its parent). Then
        the draft's own containment delta under the node is applied."""
        if base_node.urn in self.node_remove:
            return None
        up = self.node_upsert.get(base_node.urn)
        if up is None:
            if base_node.urn in self.node_modified:          # a read that forgot to load() it
                logger.warning("draft overlay: served main's value of modified node %s", base_node.urn)
            return self.with_child_count(base_node)
        if base_node.child_count is not None:               # a MODIFIED existing node keeps main's count
            up = up.model_copy(update={"child_count": base_node.child_count})
        return self.with_child_count(up)


def _line(key: tuple) -> tuple:
    """The draft or fork a cache key is of — its graph, branch and containment types — whatever
    version of it."""
    return key[0], key[1], key[3]


# A fork's patch set as its delta keeps it for the next extension: each list's entries as tuples
# of these fields, over the strings the index holds already — no dict per entry (1,043 bytes an
# entry with the index became 865; the index alone holds 737).
_KEPT_FIELDS = {"nodesUpsert": ("urn", "entityId", "entityType", "displayName", "qualifiedName", "lazy"),
                "nodesModified": ("entityId", "urn"), "nodesRemove": ("entityId", "urn"),
                "edgesUpsert": ("id", "sourceUrn", "targetUrn", "edgeType", "lazy", "was"),
                "edgesRemove": ("id", "sourceUrn", "targetUrn", "edgeType")}
_WAS_FIELDS = ("sourceUrn", "targetUrn", "edgeType")


def _keep(raw: Dict[str, Any]) -> Dict[str, Any]:
    """``raw``, a fork's patch set, as its delta keeps it: what its next extension needs, compact."""
    kept: Dict[str, Any] = {"since": raw["since"], "nodesNew": list(raw.get("nodesNew") or ())}
    for key, fields in _KEPT_FIELDS.items():
        kept[key] = [tuple((tuple(x["was"][f] for f in _WAS_FIELDS) if x.get("was") else None)
                           if f == "was" else x.get(f) for f in fields)
                     for x in raw.get(key) or ()]
    return kept


def _unkept(kept: Dict[str, Any]) -> Dict[str, Any]:
    """The patch set :func:`_keep` kept, reader-shaped again, for the service to extend."""
    out: Dict[str, Any] = {"since": kept["since"], "nodesNew": list(kept["nodesNew"])}
    for key, fields in _KEPT_FIELDS.items():
        rows = []
        for t in kept[key]:
            x = dict(zip(fields, t))
            if key == "edgesUpsert":
                was = x.pop("was")
                if was is not None:
                    x["was"] = dict(zip(_WAS_FIELDS, was))
            rows.append(x)
        out[key] = rows
    return out


def _ends(flows: List[GraphEdge]) -> List[str]:
    return sorted({u for e in flows for u in (e.source_urn, e.target_urn)})


def _rollup_cells(flows: List[GraphEdge], sign: int, chains: Dict[str, List[str]],
                  sources: set, targets: set, out: Dict[Tuple[str, str], Dict[str, Any]]) -> None:
    """Move rollup cells ``out`` by ``flows``, each counted ``sign``, as the materialiser rolls a
    flow up: into every cell (Sx, Tx), Sx ≠ Tx, where Sx is its source or a container above it
    among ``sources`` and Tx its target or one above it among ``targets``; no sources (or targets)
    named means every one. ``chains`` places the ends (``{urn: [parent, …, root]}``); an end with
    none is not a live node there, and only places itself. Pure CPU: no query."""
    for e in flows:
        sxs = {e.source_urn, *chains.get(e.source_urn, ())}
        if sources:
            sxs &= sources
        if not sxs:
            continue
        txs = {e.target_urn, *chains.get(e.target_urn, ())}
        if targets:
            txs &= targets
        for sx in sxs:
            for tx in txs:
                if sx == tx:
                    continue
                slot = out.setdefault((sx, tx), {"weight": 0, "types": set()})
                slot["weight"] += sign
                if e.edge_type:
                    slot["types"].add(e.edge_type)


class _DeltaCache:
    """This process's recent overlay deltas, keyed by what a delta depends on
    (``GraphVersioningService.overlay_version``): a draft's or fork's reads share one delta until it
    or what it overlays moves, instead of each read rebuilding it — at 100k changed entities a
    rebuild costs a read seconds. Built once per key, however many reads ask at the same time.

    Bounded by the entries its deltas hold together (``GRAPHVER_OVERLAY_CACHE_ENTRIES``), not by
    their number: many drafts and forks read at once each keep theirs, and the newest is kept
    whatever its size. A delta supersedes the older ones of its draft or fork."""

    def __init__(self, max_entries: Optional[int] = None):
        self._max = max_entries
        self._held = 0
        self._items: "OrderedDict[tuple, _OverlayDelta]" = OrderedDict()
        self._building: Dict[tuple, asyncio.Task] = {}

    def latest(self, line: tuple) -> Optional[Dict[str, Any]]:
        """The patch set of the newest delta held of ``line`` (:func:`_line`) that the next build
        may extend — a fork's, as kept (:func:`_unkept` gives it back) — or None."""
        for key in reversed(self._items):
            if _line(key) == line and self._items[key].raw is not None:
                return self._items[key].raw
        return None

    async def get(self, key: tuple, build: Callable[[], Awaitable[_OverlayDelta]]) -> _OverlayDelta:
        hit = self._items.get(key)
        if hit is not None:
            self._items.move_to_end(key)
            return hit
        task = self._building.get(key)
        if task is None or task.get_loop() is not asyncio.get_running_loop():
            task = asyncio.ensure_future(build())
            self._building[key] = task
            task.add_done_callback(lambda t, k=key: self._settle(k, t))
        return await asyncio.shield(task)          # one reader giving up doesn't cancel the build

    def _settle(self, key: tuple, task: asyncio.Task) -> None:
        if self._building.get(key) is task:
            del self._building[key]
        if task.cancelled() or task.exception() is not None:
            return
        for old in [k for k in self._items if _line(k) == _line(key)]:
            self._held -= self._items.pop(old).size
        delta = self._items[key] = task.result()
        self._held += delta.size
        limit = vconfig.OVERLAY_CACHE_ENTRIES if self._max is None else self._max
        while self._held > limit and len(self._items) > 1:
            self._held -= self._items.popitem(last=False)[1].size


_DELTAS = _DeltaCache()


class DraftOverlayProvider:
    """A ``GraphDataProvider`` for a live draft: reads = ``base`` (main) ⊕ the draft's sparse delta,
    writes = a commit on the draft. Empty delta ⇒ every read is a pure pass-through to ``base``.

    ``fork``: this is a fork's ``main``, read the same way over its root's store (``base``) with
    the fork's patch set; a draft on the fork overlays this one in turn. ``read_ns``: which version
    of its root's store a fork's reads were built against, carried in its cache keys
    (:meth:`physical_graph_id`). ``root_at``: the root's seq that store holds, when not the root's
    head — the version the root's key serves while its projection catches up or rebuilds: the
    fork's patch set is against the root there. ``version``: its ``overlay_version`` when the
    caller has read it already (``fork_read_plan``), so the first read does not read it again.

    ``as_of_seq``: this is ``main`` as it was at that revision, over ``main``'s store at its head
    (``base``) with the patch set of everything main changed since
    (``GraphVersioningService.revision_overlay_delta``); ``version`` is then ``("rev", seq, head)``
    and required. Read-only, and every read that would answer from the graph as it is now —
    search, trace — refuses (``RevisionUnsupported``) rather than pass for the past."""

    def __init__(self, base, *, svc, graph_id: str, branch_id: str, actor: Optional[str] = None,
                 fork: bool = False, read_ns: Optional[str] = None, version: Optional[tuple] = None,
                 as_of_seq: Optional[int] = None, root_at: Optional[int] = None):
        if as_of_seq is not None and (not version or version[0] != "rev"):
            raise ValueError("a revision's overlay is keyed by its version: ('rev', seq, head)")
        self._base = base
        self._svc = svc
        self._gid = graph_id
        self._branch = branch_id
        self._actor = actor or "system"
        self._fork = fork
        self._read_ns = read_ns
        self._version = version
        self._as_of = as_of_seq
        self._root_at = {"root_at": root_at} if root_at is not None else {}
        self._containment_types: List[str] = []
        self._delta: Optional[_OverlayDelta] = None
        # Writes (and as-of-free branch ops) reuse the ordinary branch provider — no duplication.
        # At a revision it reads (ancestor chains) as of then, and refuses to write.
        self._writer = VersionedBranchProvider(svc, graph_id=graph_id, branch_id=branch_id,
                                               actor=self._actor, as_of_seq=as_of_seq)

    # ---- lifecycle ----------------------------------------------------- #
    def set_containment_edge_types(self, edge_types, from_ontology: bool = False) -> None:
        self._containment_types = list(edge_types or [])
        self._delta = None                                   # re-classify edges on next read
        self._writer.set_containment_edge_types(edge_types, from_ontology)
        setter = getattr(self._base, "set_containment_edge_types", None)
        if callable(setter):
            setter(edge_types, from_ontology)

    def set_node_identity(self, identity_property=None, name_property=None) -> None:
        """Forward the resolved node-identity mapping to the base provider.

        ``ContextEngine._inject_identity`` is ``hasattr``-gated, so without this
        method a draft read silently skipped the injection: the base FalkorDB
        provider kept whatever mapping the PREVIOUS source left on it (instances
        are cached and shared per ``(provider_id, graph_name)``), which is the
        exact leak ``FalkorDBProvider.set_node_identity``'s "ALWAYS RESET"
        contract exists to prevent. An id-keyed source read through a draft
        therefore hydrated as an empty graph.

        Only ``_base`` gets it. ``self._writer`` is a
        ``VersionedBranchProvider`` reading Postgres graph-version state, where
        ``urn`` and ``displayName`` are already canonical columns — there is no
        physical source property to map there.
        """
        setter = getattr(self._base, "set_node_identity", None)
        if callable(setter):
            setter(identity_property, name_property)

    @property
    def name(self) -> str:
        return f"draft-overlay[{self._gid}:{self._branch}] over {getattr(self._base, 'name', '?')}"

    @property
    def manager_cache_key(self) -> Optional[tuple]:
        """A fork's reads of its root's FalkorDB store take that shard's admission slots, as the
        root's own do (``_bounded_compute``): its store's key. None for a draft, and over a
        Postgres reader, as before: those reads are Postgres-heavy, not FalkorDB fan-out."""
        through = self._fork or self._as_of is not None     # main's store, read for the past too
        return getattr(self._base, "manager_cache_key", None) if through else None

    def physical_graph_id(self) -> Optional[str]:
        """The physical graph behind this overlay's reads, which cached answers are keyed by: its
        store's, and for a fork's, the version of its root's store it was read against
        (``read_ns``). A fork's cache is its own data source's, which its root's writes and
        projections never bump: its key moving with the root's store is what keeps an answer
        built across a root publish from being served after it."""
        base, base_id = self._base, None
        for _ in range(5):
            get_id = getattr(base, "physical_graph_id", None)
            if callable(get_id):
                base_id = get_id()
                break
            base = getattr(base, "_base", None)
            if base is None:
                break
        if self._read_ns is None:
            return base_id
        return f"{base_id or ''}|{self._read_ns}"

    async def get_ontology_metadata(self):
        # Like VersionedBranchProvider: the engine resolves ontology from the data source and pushes
        # edge-type sets in; there is no per-branch ontology surface.
        raise NotImplementedError("DraftOverlayProvider does not introspect ontology")

    async def _delta_(self) -> _OverlayDelta:
        if self._delta is None:
            version = self._version or await self._svc.overlay_version(
                graph_id=self._gid, branch_id=self._branch, **self._root_at)
            cset = list(self._containment_types)
            # A revision's line is its own: readers of two revisions keep two deltas, not evict each
            # other's (a delta replaces the older ones of its line).
            line_branch = self._branch if self._as_of is None else f"{self._branch}@{self._as_of}"
            key = (self._gid, line_branch, version, tuple(cset))

            async def build() -> _OverlayDelta:
                # A fork's (or a revision's) patch set as it was before its store moved, to extend.
                prev = _DELTAS.latest(_line(key))
                if prev is not None:
                    prev = await asyncio.to_thread(_unkept, prev)
                extend = {"extend": prev} if prev else {}
                if self._as_of is not None:
                    raw = await self._svc.revision_overlay_delta(
                        graph_id=self._gid, as_of_seq=self._as_of, head_seq=version[2], **extend)
                else:
                    raw = await self._svc.branch_overlay_delta(
                        graph_id=self._gid, branch_id=self._branch, **self._root_at, **extend)
                # Indexing a large draft's patch set is pure CPU: off the event loop.
                return await asyncio.to_thread(_OverlayDelta, raw, cset)

            shared = await _DELTAS.get(key, build)
            self._delta = shared.for_request(self._load_modified, self._load_edges)
        return self._delta

    def _at(self) -> Dict[str, Any]:
        """Where values load from: the branch's head, or main at the revision being read."""
        return {} if self._as_of is None else {"as_of_seq": self._as_of}

    async def _load_modified(self, entity_ids: List[str]) -> List[dict]:
        return await self._svc.overlay_payloads(
            graph_id=self._gid, branch_id=self._branch, entity_ids=entity_ids, **self._at())

    async def _load_edges(self, entity_ids: List[str]) -> List[dict]:
        return await self._svc.overlay_payloads(
            graph_id=self._gid, branch_id=self._branch, entity_ids=entity_ids, kind="edge", **self._at())

    def _now_only(self, what: str) -> None:
        """Refuse, at a past revision, a read that answers from the published graph as it is now:
        it would pass the present off as the past."""
        if self._as_of is not None:
            raise RevisionUnsupported(
                what, f"{what} reads the published graph as it is now, not as it was at revision "
                      f"{self._as_of}: go back to Published to use it")

    def _no_writes(self) -> None:
        if self._as_of is not None:
            raise RevisionReadOnly()

    async def _chains(self, d: _OverlayDelta, kind: str, urns: List[str],
                      on: Any = None) -> Dict[str, List[str]]:
        """``urns``' containment chains (``{urn: [parent, …, root]}``, ``[]`` for a root, absent
        when not a live node) on this overlay's own state, or on the store's (``on=self._base``),
        for a set of urns its patch set fixes, which ``kind`` names: looked up once per patch set
        in one batched walk, and kept with it, so later reads of it place them without a query."""
        task = d.shared.get(kind)
        if task is None or task.get_loop() is not asyncio.get_running_loop():
            task = d.shared[kind] = asyncio.ensure_future((on or self).get_ancestor_chains(urns))
        try:
            return await asyncio.shield(task)
        except Exception:
            if d.shared.get(kind) is task:
                del d.shared[kind]                       # the next read asks again
            raise

    @staticmethod
    def _kept(node: GraphNode, query: NodeQuery) -> bool:
        """Whether ``node`` has a type and a name ``query`` asks for (its urns aside)."""
        if query.entity_types and node.entity_type not in query.entity_types:
            return False
        if query.search_query and query.search_query.lower() not in (node.display_name or "").lower():
            return False
        return True

    @classmethod
    def _created_for(cls, d: _OverlayDelta, query: NodeQuery) -> List[str]:
        """The nodes the patch set adds (``nodesNew``) that ``query`` asks for: those it names, in
        its order, when it names urns — looked up, not matched against every node the patch set
        holds (a 100-urn batch against a 100k-node draft was 10M set inserts) — else every match,
        in name order, kept on the patch set for the next page when the query has no text."""
        if query.urns:
            return [u for u in dict.fromkeys(query.urns)
                    if u in d.node_new and u in d.node_index and cls._kept(d.node_index[u], query)]
        key = ("created", tuple(sorted(query.entity_types or ())))
        if query.search_query:
            return _by_name(d, (u for u, n in d.node_index.items()
                                if u in d.node_new and cls._kept(n, query)))
        hit = d.shared.get(key)
        if hit is None:
            hit = d.shared[key] = _by_name(d, (u for u, n in d.node_index.items()
                                              if u in d.node_new and cls._kept(n, query)))
        return hit

    # ---- reads: base ⊕ delta ------------------------------------------- #
    async def get_node(self, urn: str) -> Optional[GraphNode]:
        d = await self._delta_()
        if urn in d.node_remove:
            return None
        base = await self._base.get_node(urn)
        await d.load([urn])
        if base is not None:                                 # exists in main → merge changes, keep childCount
            return d.overlay_existing(base)
        up = d.node_upsert.get(urn)                          # draft-NEW node (no base)
        return d.with_child_count(up) if up else None

    async def resolve_identities(self, urns: List[str]) -> Dict[str, Optional[Dict[str, Any]]]:
        """Which ``urns`` exist on the draft, and as what: main's answer (through its own, faster
        lookup where it has one), with what the draft created, changed or removed on top. The
        same three states as ``GraphDataProvider.resolve_identities``."""
        base_lookup = getattr(self._base, "resolve_identities", None)
        found = (await base_lookup(urns) if callable(base_lookup)
                 else await resolve_identities_by_query(self._base, urns))
        d = await self._delta_()
        if d.empty:
            return found
        await d.load(urns)
        out = dict(found)
        for urn in urns:
            if urn in d.node_remove:
                out[urn] = None
            elif urn in d.node_upsert:
                node = d.node_upsert[urn]
                out[urn] = {"type": node.entity_type, "name": node.display_name,
                            "qualifiedName": node.qualified_name}
        return out

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        d = await self._delta_()
        if d.empty:
            return await self._base.get_nodes(query)
        # Draft-NEW nodes the query asks for: all it names (a lookup), or — a listing — the page's
        # share of them, ahead of main's rows (_created_first).
        added = self._created_for(d, query)
        if query.urns:
            base = await self._base.get_nodes(query)
        else:
            added, rest = _created_first(added, query.offset or 0, query.limit or 100)
            base = await self._base.get_nodes(query.model_copy(update=rest)) if rest else []
        await d.load(n.urn for n in base)
        seen: set = set()
        out: List[GraphNode] = []
        for n in base:
            if n.urn in d.node_remove:
                continue
            merged = d.overlay_existing(n)                   # modified → changes + base's childCount
            if merged is not None:
                out.append(merged)
            seen.add(n.urn)
        return [d.with_child_count(n) for n in await d.served([u for u in added if u not in seen])] + out

    async def get_nodes_page(self, query: NodeQuery) -> NodePage:
        """A page in MAIN's order: `has_more` and `next_offset` are the base's, so a
        draft that deletes rows can't end paging early and the draft's new nodes —
        on the first page only — can't push the next page past rows of main. That page holds
        at most ``limit`` of them; the rest follow main's last page, at ``_TAIL_OFFSET``."""
        d = await self._delta_()
        if d.empty:
            return await self._base.get_nodes_page(query)
        offset, limit = query.offset or 0, query.limit or 100
        created = self._created_for(d, query)
        head = len(created) if query.urns else limit        # a lookup serves all it names at once
        tail = _tail_index(offset)
        if tail is not None:
            rest = created[head:]
            urns = rest[tail:tail + limit]
            nodes = [d.with_child_count(n) for n in await d.served(urns)]
            done = tail + len(urns)
            return NodePage(nodes=nodes, hasMore=done < len(rest), nextOffset=_TAIL_OFFSET + done)
        base = await self._base.get_nodes_page(query)
        await d.load(n.urn for n in base.nodes)
        seen: set = set()
        out: List[GraphNode] = []
        for n in base.nodes:
            if n.urn in d.node_remove:
                continue
            merged = d.overlay_existing(n)
            if merged is not None:
                out.append(merged)
            seen.add(n.urn)
        if not offset:
            out += [d.with_child_count(n) for n in await d.served(
                [u for u in created[:head] if u not in seen])]
        has_more, next_offset = base.has_more, base.next_offset
        if not has_more and len(created) > head:            # main is done; the rest of what it added
            has_more, next_offset = True, _TAIL_OFFSET
        return NodePage(nodes=out, hasMore=has_more, nextOffset=next_offset)

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        self._now_only("Search")
        d = await self._delta_()
        if d.empty:
            return await self._base.search_nodes(query, limit=limit, offset=offset)
        q = (query or "").lower()
        # Draft-NEW matches first, then main's (_created_first): each page its share of them.
        matches, rest = _created_first(_by_name(d, (urn for urn, n in d.node_index.items()
                                                    if urn in d.node_new
                                                    and q in (n.display_name or "").lower())),
                                       offset, limit)
        base = await self._base.search_nodes(query, **rest) if rest else []
        await d.load(n.urn for n in base)
        out: List[GraphNode] = []
        for n in base:
            if n.urn in d.node_remove:
                continue
            merged = d.overlay_existing(n)
            if merged is not None:
                out.append(merged)
        seen = {n.urn for n in out}
        return await d.served([u for u in matches if u not in seen]) + out

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        base = await self._base.get_edges(query)
        d = await self._delta_()
        if d.empty:
            return base
        out = [d.edge_upsert.get(e.id, e) for e in base if e.id not in d.edge_remove]
        seen = {e.id for e in out}
        src = set(query.source_urns or [])
        tgt = set(query.target_urns or [])
        anyu = set(query.any_urns or [])
        ets = set(query.edge_types or [])
        added = 0
        named = src or tgt or anyu                     # the ends asked about: walk just theirs
        pool = ((e for u in sorted(named) for e in d.edges_at.get(u, ())) if named
                else d.edge_upsert.values())
        for e in pool:
            eid = e.id
            if eid in seen:
                continue
            if src and e.source_urn not in src:
                continue
            if tgt and e.target_urn not in tgt:
                continue
            if anyu and not (e.source_urn in anyu or e.target_urn in anyu):
                continue
            if ets and e.edge_type not in ets:
                continue
            # At most the query's limit of the draft's own edges: each one served is loaded for
            # this response, and a broad query on a draft that added 100k edges must not load
            # them all, every time.
            if query.limit and added >= query.limit:
                break
            out.append(e)
            seen.add(eid)                              # an edge both of whose ends were named
            added += 1
        return await d.edges(out)

    async def get_children_with_edges(
        self, parent_urn: str, edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName", cursor: Optional[str] = None,
        sort_direction: str = "asc", lineage_scope: str = "page",
    ) -> ChildrenWithEdgesResult:
        scope_kw = {"lineage_scope": lineage_scope} if lineage_scope != "page" else {}
        d = await self._delta_()
        if d.empty:
            return await self._base.get_children_with_edges(
                parent_urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
                search_query=search_query, offset=offset, limit=limit,
                include_lineage_edges=include_lineage_edges, sort_property=sort_property,
                cursor=cursor, sort_direction=sort_direction, **scope_kw)
        first_page = offset == 0 and not cursor
        tail = _tail_index(offset, cursor)
        gained, gone, removed = self._parent_delta(d, parent_urn)
        if search_query:
            q = search_query.lower()
            gained = [u for u in gained if u not in d.node_index or q in (
                d.node_index[u].display_name or "").lower() or q in u.lower()]
        # What the overlay added under THIS parent, a page at a time: the first page of it with
        # main's first page, the rest after main's last (``_TAIL_OFFSET``) — see compose_page.
        if tail is not None:
            serve = gained[limit + tail:limit + tail + limit]
            base = (await self._base.get_children_with_edges(
                parent_urn, edge_types=edge_types, search_query=search_query, offset=0, limit=1,
                include_lineage_edges=False, sort_property=sort_property,
                sort_direction=sort_direction)).model_copy(update={
                    "children": [], "containment_edges": [], "lineage_edges": []})
        else:
            serve = gained[:limit] if first_page else []
            base = await self._base.get_children_with_edges(
                parent_urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
                search_query=search_query, offset=offset, limit=limit,
                include_lineage_edges=include_lineage_edges, sort_property=sort_property,
                cursor=cursor, sort_direction=sort_direction, **scope_kw)
        await d.load([c.urn for c in base.children] + [u for u in serve if u in d.node_index])
        # children: main's page overlaid (a renamed child keeps its base childCount so it
        # isn't orphaned), and this page's share of the draft's new children of THIS parent.
        added = [d.with_child_count(d.node_upsert[u] if u in d.node_upsert else d.node_index[u])
                 for u in serve if u in d.node_upsert or u in d.node_index]
        # A main node the draft moved here has only its edge in the draft, so read it from
        # main. Else a fixed orphan, dropped from the top-level page, showed nowhere.
        moved = [u for u in serve if u not in d.node_upsert and u not in d.node_index]
        if moved:
            found = await self._base.get_nodes(NodeQuery(urns=moved, limit=len(moved)))
            if search_query:
                q = search_query.lower()
                found = [n for n in found
                         if q in (n.display_name or "").lower() or q in (n.urn or "").lower()]
            added += [d.with_child_count(n) for n in found]
        children, total_children = d.compose_page(
            [c for c in base.children if c.urn not in gone], added,
            first_page=first_page or tail is not None,
            base_total=base.total_children, removed=removed, added_total=len(gained))
        present = {c.urn for c in children}
        # containment edges under this parent: main's on this page, and the draft's to the
        # children this page serves (the rest come with the pages that serve them)
        cont = [e for e in base.containment_edges
                if e.id not in d.edge_remove and e.target_urn not in gone]
        cont = await d.edges(cont + [e for e in d.cont_added
                                     if e.source_urn == parent_urn and e.target_urn in present])
        # lineage edges among the (now overlaid) visible child scope
        lineage = base.lineage_edges
        if include_lineage_edges:
            lineage = [d.edge_upsert.get(e.id, e) for e in lineage if e.id not in d.edge_remove]
            seen = {e.id for e in lineage}
            scope = present | {parent_urn}
            for e in d.lineage_added:
                if e.id in seen:
                    continue
                if lineage_scope == "siblings":
                    # The far end may sit on a page not loaded yet; the delta is
                    # small, so hand over every draft edge touching this page and
                    # let the client keep it once both ends are loaded.
                    if e.source_urn in present or e.target_urn in present:
                        lineage.append(e)
                elif e.source_urn in scope and e.target_urn in scope:
                    lineage.append(e)
            lineage = await d.edges(lineage)
        # Where the next page starts and whether there is one are facts about MAIN's
        # order, which only the base knows — a draft that drops a page's rows must
        # neither end paging nor move the next page. Past main's last page, the overlay's tail.
        rest = max(0, len(gained) - limit)
        if tail is not None:
            done = tail + len(serve)
            more = done < rest
            has_more, next_cursor, next_offset = (
                more, f"{_TAIL_CURSOR}{done}" if more else None, _TAIL_OFFSET + done)
        elif not base.has_more and rest:
            has_more, next_cursor, next_offset = True, f"{_TAIL_CURSOR}0", _TAIL_OFFSET
        else:
            has_more, next_cursor = base.has_more, base.next_cursor
            next_offset = base.next_offset if base.next_offset is not None else offset + len(base.children)
        return ChildrenWithEdgesResult(
            children=children, containmentEdges=cont, lineageEdges=lineage,
            totalChildren=total_children if total_children is not None else len(children),
            hasMore=has_more, nextCursor=next_cursor, nextOffset=next_offset,
            # A base page whose lineage could not be read stays marked as such:
            # the draft's answer is cached too, and must not pass for complete.
            degradedDetail=base.degraded_detail)

    @staticmethod
    def _parent_delta(d: _OverlayDelta, parent_urn: str) -> "tuple[List[str], set, int]":
        """What the patch set changes under one parent, kept on it for the parent's next page:
        the children it added there — created ones in name order, then main's nodes it moved
        there — those it took away and did not give back (``gone``), and how many containment
        links from the parent it removed. Indexed once per patch set, not scanned per page."""
        index = d.shared.get("children-delta")
        if index is None:
            added: Dict[str, List[str]] = {}
            taken: Dict[str, List[str]] = {}
            for e in d.cont_added:
                added.setdefault(e.source_urn, []).append(e.target_urn)
            for e in d.cont_removed:
                taken.setdefault(e.source_urn, []).append(e.target_urn)
            index = d.shared["children-delta"] = ({}, added, taken)
        orders, added, taken = index
        hit = orders.get(parent_urn)
        if hit is None:
            targets = list(dict.fromkeys(added.get(parent_urn, ())))
            live = [u for u in targets if u not in d.node_remove]
            known = [u for u in live if u in d.node_upsert or u in d.node_index]
            moved = sorted(u for u in live if u not in d.node_upsert and u not in d.node_index)
            # A child the overlay took away from this parent (its edge from here removed, or
            # moved elsewhere) and did not give back is not listed here, though the store lists it.
            gone = set(taken.get(parent_urn, ())) - set(targets)
            hit = orders[parent_urn] = (_by_name(d, known) + moved, gone,
                                        len(taken.get(parent_urn, ())))
        return hit

    async def get_children(
        self, parent_urn: str, entity_types: Optional[List[str]] = None,
        edge_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        offset: int = 0, limit: int = 100, sort_property: Optional[str] = "displayName",
        cursor: Optional[str] = None, sort_direction: str = "asc",
    ) -> List[GraphNode]:
        res = await self.get_children_with_edges(
            parent_urn, edge_types=edge_types, include_lineage_edges=False,
            offset=offset, limit=limit, sort_property=sort_property, cursor=cursor,
            sort_direction=sort_direction)
        return res.children

    async def get_top_level_or_orphan_nodes(
        self, *, root_entity_types: Optional[List[str]] = None,
        entity_types: Optional[List[str]] = None, search_query: Optional[str] = None,
        limit: int = 100, cursor: Optional[str] = None, include_child_count: bool = True,
        sort_direction: str = "asc",
    ) -> TopLevelNodesResult:
        d = await self._delta_()
        if d.empty:
            return await self._base.get_top_level_or_orphan_nodes(
                root_entity_types=root_entity_types, entity_types=entity_types,
                search_query=search_query, limit=limit, cursor=cursor,
                include_child_count=include_child_count, sort_direction=sort_direction)
        # Overlay main's top-level set: drop removed, merge modified (keeping base childCount). A
        # draft-CREATED node becomes a new root only when no draft containment targets it. Crucially a
        # MODIFIED existing node (e.g. a rename) is NOT hoisted to top-level — its parent edge lives on
        # main (outside the draft delta), so it keeps its real position; hoisting it was what made a
        # single rename "break the containment tree" (the node jumped to the root with childCount 0).
        has_parent = d.shared.get("has-parent")
        if has_parent is None:
            has_parent = d.shared["has-parent"] = {e.target_urn for e in d.cont_added}
        roots = self._created_roots(d, has_parent, entity_types, search_query)
        # A page of them with main's first page, the rest after main's last (``_TAIL_CURSOR``).
        tail = _tail_index(cursor=cursor)
        if tail is not None:
            serve = roots[limit + tail:limit + tail + limit]
            done = tail + len(serve)
            more = done < max(0, len(roots) - limit)
            return TopLevelNodesResult(
                nodes=[d.with_child_count(n) for n in await d.served(serve)], totalCount=None,
                hasMore=more, nextCursor=f"{_TAIL_CURSOR}{done}" if more else None)
        base = await self._base.get_top_level_or_orphan_nodes(
            root_entity_types=root_entity_types, entity_types=entity_types,
            search_query=search_query, limit=limit, cursor=cursor, include_child_count=include_child_count,
            sort_direction=sort_direction)
        await d.load(n.urn for n in base.nodes)
        et = set(entity_types or [])
        q = (search_query or "").lower()
        added = [d.with_child_count(n) for n in await d.served(roots[:limit])] if not cursor else []
        # A node of main the overlay took every parent edge from, and gave none, is a root here
        # though the store lists it under a parent: its chain on the overlay's state says so.
        lost = sorted({e.target_urn for e in d.cont_removed} - has_parent - d.node_remove)
        if lost:
            chains = await self._chains(d, "lost_parents", lost)
            lost = [u for u in lost if chains.get(u) == []]
        if lost and not cursor:
            found = await self._base.get_nodes(NodeQuery(urns=lost, limit=len(lost)))
            await d.load(n.urn for n in found)
            for n in found:
                m = d.overlay_existing(n)
                if m is not None and (not et or m.entity_type in et) and (
                        not q or q in (m.display_name or "").lower() or q in m.urn.lower()):
                    added.append(d.with_child_count(m))
        # A removed node was a root of main unless the draft also removed a parent link to it.
        had_parent = {e.target_urn for e in d.cont_removed}
        removed = sum(1 for urn in d.node_remove if urn not in had_parent and urn not in d.node_new)
        # A main top-level node the draft gives a parent is no longer top-level (an
        # orphan being fixed). The total keeps it: only this page shows which
        # targets were top-level in main.
        base_nodes = [n for n in base.nodes if n.urn not in has_parent]
        nodes, total = d.compose_page(
            base_nodes, added, first_page=not cursor,
            base_total=base.total_count, removed=removed,
            added_total=len(roots) + (len(added) - min(len(roots), limit) if not cursor else len(lost)))
        out = base.model_copy(update={"nodes": nodes, "total_count": total})
        if not base.has_more and len(roots) > limit:        # main is done; the rest of what it added
            out = out.model_copy(update={"has_more": True, "next_cursor": f"{_TAIL_CURSOR}0"})
        return out

    @staticmethod
    def _created_roots(d: _OverlayDelta, has_parent: set, entity_types: Optional[List[str]],
                       search_query: Optional[str]) -> List[str]:
        """The nodes the patch set adds that no containment link of its own points at — new roots
        — of the given types and text, in name order; kept on the patch set when there is no text."""
        et = set(entity_types or [])
        q = (search_query or "").lower()
        key = ("roots", tuple(sorted(et)))
        if not q:
            hit = d.shared.get(key)
            if hit is not None:
                return hit
        roots = _by_name(d, (urn for urn, n in d.node_index.items()
                             if urn in d.node_new and urn not in has_parent and urn not in d.node_remove
                             and (not et or n.entity_type in et)
                             and (not q or q in (n.display_name or "").lower() or q in urn.lower())))
        if not q:
            d.shared[key] = roots
        return roots

    async def get_aggregated_edges_between(
        self, source_urns: List[str], target_urns: Optional[List[str]],
        granularity: Any, containment_edges: List[str], lineage_edges: List[str],
        *, timeout: Optional[float] = None,
    ) -> AggregatedEdgeResult:
        base = await self._base.get_aggregated_edges_between(
            source_urns, target_urns, granularity, containment_edges, lineage_edges, timeout=timeout)
        d = await self._delta_()
        result = await self._rolled_up(d, base, source_urns, target_urns)
        if self._as_of is not None and d.structure_moved:
            # The overlay moves the flows it holds; flows unchanged since the revision stay grouped
            # where the store holds their ends now. Containers moved since, so say it is not exact.
            result = result.model_copy(update={"stale": True, "stale_reason": "revision_structure_moved"})
        return result

    async def _rolled_up(self, d: _OverlayDelta, base: AggregatedEdgeResult,
                         source_urns: List[str], target_urns: Optional[List[str]]) -> AggregatedEdgeResult:
        """``base``'s rollups moved by the patch set's own flows."""
        if not d.lineage_changed:
            return base                                      # no lineage delta ⇒ main's rollups verbatim
        # A flow the overlay added goes on where it runs, under its ends' containers on the
        # overlay's own state; one it removed (or moved away) comes off where the store counted
        # it, under the store's. Both sets of chains are looked up once per patch set.
        adjust: Dict[Tuple[str, str], Dict[str, Any]] = {}
        sources, targets = set(source_urns or []), set(target_urns or [])
        if sources or targets:
            if d.lineage_added:
                _rollup_cells(d.lineage_added, +1,
                              await self._chains(d, "flows_added", _ends(d.lineage_added)),
                              sources, targets, adjust)
            if d.lineage_removed:
                _rollup_cells(d.lineage_removed, -1,
                              await self._chains(d, "flows_removed", _ends(d.lineage_removed),
                                                 on=self._base),
                              sources, targets, adjust)
        by_pair = {(e.source_urn, e.target_urn): e for e in base.aggregated_edges}
        for (su, tu), adj in adjust.items():
            cur = by_pair.get((su, tu))
            w = int(adj["weight"])
            types = adj["types"]
            if cur is None:
                if w > 0:
                    by_pair[(su, tu)] = AggregatedEdgeInfo(
                        id=f"agg-{su}-{tu}", sourceUrn=su, targetUrn=tu, edgeCount=w,
                        edgeTypes=sorted(t for t in types if t), confidence=1.0, sourceEdgeIds=[])
            else:
                new_count = (cur.edge_count or 0) + w
                if new_count <= 0:
                    del by_pair[(su, tu)]
                else:
                    by_pair[(su, tu)] = cur.model_copy(update={
                        "edge_count": new_count,
                        "edge_types": sorted(set(cur.edge_types) | {t for t in types if t})})
        edges = sorted(by_pair.values(), key=lambda e: e.edge_count, reverse=True)
        # Everything else is the base's to say — stale, degraded detail, truncation
        # reason: a partial base must not be cached as complete once overlaid.
        return base.model_copy(update={
            "aggregated_edges": edges, "total_source_edges": sum(e.edge_count for e in edges)})

    async def get_node_degrees(
        self, urns: List[str], edge_types: Optional[List[str]] = None,
        *, include_rollups: bool = False,
    ) -> Dict[str, Dict[str, int]]:
        """Main's lineage counts, moved by the draft's own flows. A urn main
        could not count stays absent (unknown), and a base that cannot count at
        all (a stale projection is served by VersionedBranchProvider) says so,
        as the draft's other unsupported reads do: a 501 at the route. A flow
        the draft edited where it runs counts as main counts it, and one it
        moved counts where it runs now, as in the roll-ups above.

        Roll-up presence: a flow the draft added gives its source and every
        container above it a cell out, and its target and theirs a cell in, as
        the materialiser rolls it up. A flow it removed leaves main's flag as
        it is: other flows may hold that cell, and a flag left set keeps a
        marker solid, never falsely hollow. When the walk that places the
        added flows fails, the counts stand and the flags are left out, as
        when main's own probe fails: the canvas asks for them again.

        An entity the draft created is not in main, and asking main about it
        cost a full-scan query that on a large graph passed its deadline and
        left it unknown. All of its lineage is the draft's own, so the draft
        counts it from its own flows alone and main is never asked."""
        fn = getattr(self._base, "get_node_degrees", None)
        if fn is None:
            raise NotImplementedError(
                f"{getattr(self._base, 'name', type(self._base).__name__)} does not count node degrees")
        d = await self._delta_()
        mains = [u for u in urns if u not in d.node_new]
        base: Dict[str, Dict[str, int]] = {}
        if mains:
            base = await (fn(mains, edge_types, include_rollups=True) if include_rollups
                          else fn(mains, edge_types))
        nothing = {"in": 0, "out": 0, **({"rollupIn": 0, "rollupOut": 0} if include_rollups else {})}
        out = {**{u: dict(v) for u, v in base.items()},
               **{u: dict(nothing) for u in urns if u in d.node_new}}
        if not d.lineage_changed:
            return out
        types = {t.upper() for t in (edge_types or []) if t}
        added = [e for e in d.lineage_added if not types or (e.edge_type or "").upper() in types]
        removed = [e for e in d.lineage_removed if not types or (e.edge_type or "").upper() in types]
        for sign, edges in ((1, added), (-1, removed)):
            for e in edges:
                for urn, way in ((e.source_urn, "out"), (e.target_urn, "in")):
                    if urn in out:
                        out[urn][way] += sign
        for v in out.values():
            v["in"], v["out"] = max(0, v["in"]), max(0, v["out"])
        if include_rollups and added:
            try:
                chains = await self._chains(d, "flows_added", _ends(d.lineage_added))
            except Exception:
                for v in out.values():
                    v.pop("rollupIn", None)
                    v.pop("rollupOut", None)
                return out
            for e in added:
                for end, flag in ((e.source_urn, "rollupOut"), (e.target_urn, "rollupIn")):
                    for urn in (end, *chains.get(end, [])):
                        if urn in out:
                            out[urn][flag] = 1
        return out

    async def trace_at_level(
        self, urn: str, level: int, upstream_depth: int, downstream_depth: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, include_containment_edges: bool = False,
        include_inherited_lineage: bool = True,
    ) -> TraceResult:
        self._now_only("Lineage trace")
        base = await self._base.trace_at_level(
            urn, level, upstream_depth, downstream_depth, lineage_edge_types, containment_edge_types,
            max_nodes, timeout_ms, include_containment_edges=include_containment_edges,
            include_inherited_lineage=include_inherited_lineage)
        return await self._overlay_trace(base)

    async def expand_aggregated(
        self, source_urn: str, target_urn: str, next_level: Optional[int],
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, use_raw_edges: bool = False,
        include_containment_edges: bool = False,
        drill_anchor: Optional[str] = None,
    ) -> TraceResult:
        self._now_only("Lineage trace")
        base = await self._base.expand_aggregated(
            source_urn, target_urn, next_level, lineage_edge_types, containment_edge_types,
            max_nodes, timeout_ms, use_raw_edges=use_raw_edges,
            include_containment_edges=include_containment_edges,
            drill_anchor=drill_anchor)
        return await self._overlay_trace(base)

    async def trace_closure(
        self, urn: str, upstream_depth: int, downstream_depth: int,
        lineage_edge_types: List[str], containment_edge_types: List[str],
        max_nodes: int, timeout_ms: int, seed_urns: Optional[List[str]] = None,
        exclude_urns: Optional[List[str]] = None, after_cursor: Optional[str] = None,
        seed_cursor: Optional[str] = None,
    ) -> TraceClosureResult:
        self._now_only("Lineage trace")
        # Overlay lineage deltas can make frontier totalCount advisory-stale —
        # acceptable (it is a cue, not a ledger).
        #
        # The base is whatever serves main, and not every one of those reads
        # closures: a draft on a STALE projection is served by
        # VersionedBranchProvider, which has no trace_closure at all. Calling
        # through blindly raised AttributeError — a 500 on a read the API
        # already has an honest answer for, and the answer every sibling read
        # on that base gives: "this provider cannot do that", i.e. a 501.
        fn = getattr(self._base, "trace_closure", None)
        if fn is None:
            raise NotImplementedError(
                f"{getattr(self._base, 'name', type(self._base).__name__)} "
                "does not support trace_closure")
        base = await fn(
            urn, upstream_depth, downstream_depth, lineage_edge_types, containment_edge_types,
            max_nodes, timeout_ms, seed_urns=seed_urns, exclude_urns=exclude_urns,
            after_cursor=after_cursor, seed_cursor=seed_cursor)
        return await self._overlay_trace(base)

    async def _overlay_trace(self, base: _TraceT) -> _TraceT:
        """Patch a base trace with the draft's lineage delta, bounded to the trace's node scope."""
        d = await self._delta_()
        if not d.lineage_changed and not d.node_remove and not d.edge_upsert:
            return base
        # Drop nodes the rewind/draft removed (e.g. a main-added node that must not leak into this
        # draft's trace) and any base edge INCIDENT to a removed node. Keep other base edges — with
        # the overlay's value of one it changed — a base trace can legitimately carry boundary edges
        # whose endpoint node was capped out of base.nodes (max_nodes), and those must not be
        # dropped just because the scope shrank.
        nodes = [n for n in base.nodes if n.urn not in d.node_remove]
        scope = {n.urn for n in nodes}
        edges = [d.edge_upsert.get(e.id, e) for e in base.edges
                 if e.id not in d.edge_remove
                 and e.source_urn not in d.node_remove and e.target_urn not in d.node_remove]
        seen = {e.id for e in edges}
        edges += [e for e in d.lineage_added
                  if e.id not in seen and e.source_urn in scope and e.target_urn in scope]
        return base.model_copy(update={"nodes": nodes, "edges": await d.edges(edges)})

    # ---- deep search: the base answers, the draft's delta does not ------ #
    #: Read by ``AdvancedSearchService._build_scope_diagnostics`` to note
    #: that the results are the base's, not the draft's. A marker rather
    #: than an ``isinstance`` keeps the provider classes out of the
    #: service layer.
    is_overlay = True

    @property
    def search_scope_note(self) -> str:
        """What the scope diagnostics say a search here left out: the draft's changes, a fork's
        own (its base is its parent's published graph), or both, for a draft on a fork."""
        if self._fork:
            return FORK_SEARCH_NOTE
        if getattr(self._base, "is_overlay", False):
            return DRAFT_ON_FORK_SEARCH_NOTE
        return DRAFT_SEARCH_NOTE

    # The ontology's edge classification, as the base reads it (the scope
    # diagnostics report it).
    def _get_containment_edge_types(self):
        return self._base._get_containment_edge_types()

    def _get_lineage_edge_types(self):
        return self._base._get_lineage_edge_types()

    async def deep_search(self, query, *, deadline_ms=None):
        """Search the base graph — the draft's own edits are NOT included.

        The overlay patches reads it composes itself; the deep-search
        predicate tree compiles to Cypher inside the base provider, and
        there is no seam to overlay a sparse Postgres patch set onto a
        result page without re-implementing the whole compiler over it.
        So a draft searches what it is a draft OF — and a fork its parent's
        published graph — and the response says so: ``is_overlay`` and
        ``search_scope_note`` drive the scope-diagnostics note, so the gap
        is disclosed rather than silently narrowing someone's results.

        Pure delegation also means the provider's match-set cache entry
        may legitimately be SHARED with a main-graph search: identical
        query against identical data is identical work.
        """
        self._now_only("Search")
        return await self._base.deep_search(query, deadline_ms=deadline_ms)

    @property
    def supports_search_sessions(self) -> bool:
        return bool(getattr(self._base, "supports_search_sessions", False))

    async def deep_search_session(self, query, *, context):
        """The uncapped engine, on the base — the draft's edits are not
        searched, for the reason :meth:`deep_search` gives."""
        self._now_only("Search")
        return await self._base.deep_search_session(query, context=context)

    async def deep_search_count(self, query, *, context, advance=True):
        """A rule's total — the base's, like :meth:`deep_search`."""
        self._now_only("Search")
        return await self._base.deep_search_count(query, context=context, advance=advance)

    async def deep_search_membership(self, scope, items, urns, *, context):
        """Rule membership — the base's, like :meth:`deep_search`."""
        self._now_only("Search")
        return await self._base.deep_search_membership(scope, items, urns, context=context)

    async def deep_search_catalog(self, scope, *, context, wait_ms, session_id=None,
                                  refresh=False):
        """The property catalog — the base's, like :meth:`deep_search_session`."""
        self._now_only("Search")
        return await self._base.deep_search_catalog(scope, context=context, wait_ms=wait_ms,
                                                    session_id=session_id, refresh=refresh)

    async def deep_search_export(self, query, *, context, fmt, columns, wait_ms,
                                 session_id=None):
        """An export of every match — the base's, like :meth:`deep_search_session`."""
        self._now_only("Search")
        return await self._base.deep_search_export(query, context=context, fmt=fmt,
                                                   columns=columns, wait_ms=wait_ms,
                                                   session_id=session_id)

    async def deep_search_export_open(self, session_id, *, context):
        """A complete export, to stream — the base's."""
        self._now_only("Search")
        return await self._base.deep_search_export_open(session_id, context=context)

    async def deep_search_ancestor_counts(self, session_id, urns, *, context):
        """Container counts from a search session — the base's, like
        :meth:`deep_search_session`."""
        self._now_only("Search")
        return await self._base.deep_search_ancestor_counts(session_id, urns, context=context)

    async def deep_search_resolve_refs(self, scope, refs, *, context, confined=False,
                                       with_paths=False):
        """Name references, on the base — names a draft adds or changes are
        not searched, like :meth:`deep_search`."""
        self._now_only("Search")
        return await self._base.deep_search_resolve_refs(
            scope, refs, context=context, confined=confined, with_paths=with_paths)

    async def deep_search_explain(self, query):
        """Compile-only path. Delegated for the same reason as
        :meth:`deep_search` — the Cypher explained is the one that would
        actually run, i.e. the base's."""
        self._now_only("Search")
        return await self._base.deep_search_explain(query)

    async def deep_search_discover(self, *, sample_per_label: int = 200):
        """Schema discovery. Delegated like :meth:`deep_search`: what is
        queryable is a property of the base graph's storage."""
        self._now_only("Search")
        return await self._base.deep_search_discover(
            sample_per_label=sample_per_label,
        )

    async def deep_search_values(self, *, key, entity_types=None, q="", limit=25):
        """Value suggestions — the base's values, like :meth:`deep_search`."""
        self._now_only("Search")
        return await self._base.deep_search_values(
            key=key, entity_types=entity_types, q=q, limit=limit,
        )

    # ---- writes: commit to the draft (reused from the branch provider) -- #
    async def get_ancestor_chains(self, urns: List[str]) -> Dict[str, List[str]]:
        """Containment chains on the DRAFT (its moves included) — the branch reader's walk over the
        draft's composed state. ``{urn: [parent, …, root]}``; absent = unknown, ``[]`` = a root."""
        return await self._writer.get_ancestor_chains(urns)

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """An entity's ancestors in the draft, parent first, root last (as the main reader)."""
        chain = (await self.get_ancestor_chains([urn])).get(urn, [])[offset: offset + limit]
        if not chain:
            return []
        nodes = await self.get_nodes(NodeQuery(urns=chain, limit=len(chain)))
        by_urn = {n.urn: n for n in nodes}
        return [by_urn[u] for u in chain if u in by_urn]

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        self._no_writes()
        self._delta = self._version = None              # the write moves the draft's version
        return await self._writer.create_node(node, containment_edge)

    async def create_edge(self, edge: GraphEdge) -> bool:
        self._no_writes()
        self._delta = self._version = None              # the write moves the draft's version
        return await self._writer.create_edge(edge)

    async def update_edge(self, edge_id: str, properties: Dict[str, Any]) -> Optional[GraphEdge]:
        self._no_writes()
        self._delta = self._version = None              # the write moves the draft's version
        return await self._writer.update_edge(edge_id, properties)

    async def delete_edge(self, edge_id: str) -> bool:
        self._no_writes()
        self._delta = self._version = None              # the write moves the draft's version
        return await self._writer.delete_edge(edge_id)

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        self._no_writes()
        self._delta = self._version = None              # the write moves the draft's version
        return await self._writer.save_custom_graph(nodes, edges)
