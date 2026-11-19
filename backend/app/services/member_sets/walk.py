"""The lineage walk, one closure step at a time — the one rule a Narrow and a member set share.

A walk keeps, for each entity it knows in the direction it walks: its distance from
the seeds (``hops``), the depth it has been walked to (``walked``), whether it waits
to be walked (queued), a hub's next page (cursor) and the seed it is nearest. Where
that state lives is the store's business — a Narrow keeps it in memory for one
request (``DictStore``), a member set in its rows (``store.SqlWalkStore``) so any
request, on any replica, can take the next step. The steps are the same either way:

* **What next.** A hub being paged first (its next page), then a container seed's
  next page of contents, then the queue: the nearest queued entities, all at one
  distance, up to ``CLOSURE_SEEDS`` — walked as far as the remaining depth allows
  (25 hops at most), with the most recently known entities excluded so the step
  ships what is new.
* **What it found.** Every partner's distance is read off the edges the step
  shipped — a walk from every anchor at once, nearest first — and so is the seed
  it is nearest. A member keeps its nearest distance, however it is found again.
* **What it left.** What the step could not finish is queued at its distance while
  depth is left: the depth boundary, a node the budget cut, an anchor the step
  could not afford (walked again, not lost). A hub's cursor is paged; a container's
  seed cursor is the next step.
* **When it gives up.** A step that failed (timed out, a read failed) is taken again
  with half its batch, down to one anchor; one anchor that fails ``TRIES`` times is
  let go, and the walk says it is ``incomplete`` rather than stopping or looping.
* **Hosts** (``is_leaf`` given). A partner whose type holds nothing (a column) brings
  in its container (its table), the parent the step shipped its chain with, at the
  nearest distance of what inside it was reached — containment is never a hop. A
  container that is a seed, or inside one, is never a host. ``walk_hosts``: a host
  that joins or comes nearer with depth left is queued and walked as a container
  seed is, from what inside it carries lineage — and every step goes one hop, so
  the walk keeps the tables in step with the columns. A step that could not read
  its partners or their chains is taken again before what it found is kept: a
  partner kept without its host would never be shipped again.

Every write a step makes is idempotent (distances only shrink, flags are set, rows
are inserted once), so a step taken twice — a crash between the graph call and its
commit, a lease taken over — changes nothing the first did not.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, List, Optional, Protocol, Sequence, Set, Tuple

from backend.common.models.graph import GraphNode, TraceClosureRequest, TraceClosureResult
from backend.common.models.view_membership import LINEAGE_DEPTH_MAX

#: "The whole way": a depth no walk reaches, an integer so a store can keep it.
ALL = 2 ** 30
#: A closure step's limits (TraceClosureRequest): anchors per step, URNs it may skip.
CLOSURE_SEEDS = 500
CLOSURE_EXCLUDE = 2_000
#: Tries one anchor (or one page) gets before what it could not walk is let go.
TRIES = 3
#: A closure step's reasons that mean it gave up rather than hit a cap. (``ancestors_failed``
#: is not one: the containers it nests partners in are no part of a membership.)
STEP_FAILURES = frozenset({"timeout", "seed_failed", "nodes_failed"})
#: A step's reasons that, finding hosts, mean partners came without their types or chains.
HOST_FAILURES = frozenset({"nodes_failed", "ancestors_failed"})

Leaf = Callable[[str], bool]


@dataclass
class Known:
    """What a store holds for one member, in the direction being walked. ``hops``
    None: a member this direction has not reached (yet)."""
    via: str
    hops: Optional[int] = None
    walked: int = -1
    origin: Optional[str] = None
    cursor: Optional[str] = None


@dataclass
class Work:
    """One step's anchors: a ``batch`` from the queue, a container seed's next page
    (``pending``) or a ``hub``'s next page — all at distance ``hops``."""
    kind: str
    anchors: List[str]
    hops: int
    origins: Dict[str, Optional[str]]
    cursor: Optional[str] = None


@dataclass
class Found:
    urn: str
    hops: int
    origin: Optional[str]
    node: Optional[GraphNode] = None


@dataclass
class Change:
    """What one step writes. ``new`` members join (``via`` the direction); ``nearer``
    ones keep the shorter distance; ``walked`` are dequeued, walked to ``remaining``;
    ``queue`` wait to be walked; ``cursors`` page hubs ("" once paged to the end);
    ``edges`` are the lineage the step shipped between members."""
    new: List[Found] = field(default_factory=list)
    nearer: List[Found] = field(default_factory=list)
    walked: List[str] = field(default_factory=list)
    remaining: int = 0
    queue: List[str] = field(default_factory=list)
    cursors: Dict[str, str] = field(default_factory=dict)
    edges: List[Tuple[str, str, str]] = field(default_factory=list)


@dataclass
class Stepped:
    """What a step did: how many joined, and whether it let something go unwalked."""
    work: Work
    joined: int
    gave_up: bool


class WalkStore(Protocol):
    """Where a walk's state lives. Every method is about one direction."""

    @property
    def full(self) -> bool:
        """No room for another member: the walk stops."""

    async def queue(self, direction: str, limit: int) -> List[Tuple[str, int, Optional[str]]]:
        """Up to ``limit`` queued ``(urn, hops, origin)``, all at the nearest queued
        distance, in the order they joined."""

    async def hub(self, direction: str) -> Optional[Tuple[str, str, int, Optional[str]]]:
        """A hub being paged: ``(urn, cursor, hops, origin)``, or None."""

    async def known_tail(self, direction: str, n: int, skip: Sequence[str]) -> List[str]:
        """The ``n`` most recently known entities in this direction, not in ``skip``."""

    async def read(self, direction: str, urns: Sequence[str]) -> Dict[str, Known]:
        """What the store holds for those of ``urns`` that are members."""

    async def apply(self, direction: str, change: Change) -> int:
        """Write ``change``. Returns how many joined (the cap may refuse some)."""


Call = Callable[[TraceClosureRequest], Awaitable[TraceClosureResult]]


def max_nodes() -> int:
    """A step's node budget: the closure's ceiling, not its default. A step
    clamped to the default (2,000) takes thousands of round trips to drain a
    flow one 10,000-node step carries in seconds."""
    from backend.app.services.context_engine import ContextEngine

    return ContextEngine.TRACE_MAX_NODES_HARD


def new_state() -> dict:
    """A direction's walk state, before its first step."""
    return {"pending": None, "batch": CLOSURE_SEEDS, "tries": 0}


async def leaf_rule(engine) -> Optional[Leaf]:
    """Whether an entity type holds nothing, as the data source's ontology says: a type
    it defines with nothing it can contain. A type it does not define, or only saw in
    the graph, is not one. None when the engine cannot say (or names no such type):
    no partner has a host."""
    if not hasattr(engine, "get_resolved_ontology"):
        return None
    resolved = await engine.get_resolved_ontology()
    sources = resolved.resolution_sources or {}
    leaves = {t.lower() for t, d in resolved.entity_type_definitions.items()
              if sources.get(t) != "introspection" and not d.hierarchy.can_contain}
    if not leaves:
        return None
    return lambda entity_type: (entity_type or "").lower() in leaves


async def step(store: WalkStore, state: dict, direction: str, target: int, call: Call, *,
               edges: bool = False, is_leaf: Optional[Leaf] = None,
               walk_hosts: bool = False) -> Optional[Stepped]:
    """Take the walk's next step, or None when there is nothing left to walk.

    ``target`` is the depth asked for (``ALL`` for the whole way); ``state`` the
    direction's walk state (``new_state``), updated in place; ``call`` runs one
    closure request. ``edges``: keep the lineage between members. ``is_leaf``: a
    partner of a type that holds nothing brings in its host; ``walk_hosts``: whose
    lineage is walked too."""
    work = await _next(store, state, direction)
    if work is None:
        return None
    exclude: List[str] = []
    if work.kind != "hub":
        exclude = await store.known_tail(direction, CLOSURE_EXCLUDE, work.anchors)
    # A host's lineage is walked a step after the column that brought it in, and a member
    # once known is not shipped again: walking the tables' lineage, a step goes one hop,
    # so nothing is found farther away than a table's walk would have found it.
    hop_max = 1 if is_leaf is not None and walk_hosts else LINEAGE_DEPTH_MAX
    result = await call(_request(work, direction, target, exclude, hop_max))
    failed = bool(result.truncated and result.truncation_reason in STEP_FAILURES)
    up = direction == "upstream"
    frontier = result.frontier_up if up else result.frontier_down
    wanted = set(work.anchors) | set(result.upstream_urns if up else result.downstream_urns)
    wanted |= {f.urn for f in frontier}
    if edges:
        wanted |= {u for e in result.edges for u in (e.source_urn, e.target_urn)}
    if is_leaf is not None:
        # Every container the chains name: a host, and what it sits in (a seed's insides are no host).
        wanted |= {e.source_urn for e in result.containment_edges}
    known = await store.read(direction, sorted(wanted))
    change, cut = absorb(work, result, known, direction, target, edges=edges, is_leaf=is_leaf,
                         walk_hosts=walk_hosts)
    # Finding hosts, a step that could not read its partners' types or chains is taken
    # again before anything it found is kept: a partner kept without its host would
    # not be shipped again.
    held = bool(is_leaf is not None and result.truncated and result.truncation_reason in HOST_FAILURES)
    settled = Change(remaining=change.remaining) if held else change
    gave_up = _settle(state, work, result, settled, cut, failed or held)
    if held and gave_up:
        # Let go: what it found is kept after all, without the hosts it could not read.
        change.walked += settled.walked
        change.cursors.update(settled.cursors)
        settled = change
    joined = await store.apply(direction, settled)
    return Stepped(work=work, joined=joined, gave_up=gave_up)


async def _next(store: WalkStore, state: dict, direction: str) -> Optional[Work]:
    hub = await store.hub(direction)
    if hub is not None:
        urn, cursor, hops, origin = hub
        return Work("hub", [urn], hops, {urn: origin}, cursor)
    pending = state.get("pending")
    if pending:
        return Work("pending", list(pending["anchors"]), pending["hops"],
                    dict(pending["origins"]), pending["cursor"])
    queued = await store.queue(direction, max(1, int(state.get("batch") or CLOSURE_SEEDS)))
    if not queued:
        return None
    return Work("batch", [u for u, _, _ in queued], queued[0][1], {u: o for u, _, o in queued})


def _request(work: Work, direction: str, target: int, exclude: List[str],
             hop_max: int = LINEAGE_DEPTH_MAX) -> TraceClosureRequest:
    up = direction == "upstream"
    if work.kind == "hub":
        return TraceClosureRequest(
            urn=work.anchors[0], direction=direction,
            upstream_depth=1 if up else 0, downstream_depth=0 if up else 1,
            after_cursor=work.cursor, max_nodes=max_nodes(),
        )
    depth = int(min(target - work.hops, hop_max))
    return TraceClosureRequest(
        urn=work.anchors[0], direction=direction,
        upstream_depth=depth if up else 0, downstream_depth=0 if up else depth,
        seed_urns=work.anchors, exclude_urns=exclude or None, seed_cursor=work.cursor,
        max_nodes=max_nodes(),
    )


def absorb(work: Work, result: TraceClosureResult, known: Dict[str, Known], direction: str,
           target: int, *, edges: bool = False, is_leaf: Optional[Leaf] = None,
           walk_hosts: bool = False) -> Tuple[Change, Set[str]]:
    """A closure step's answer as the writes it makes, and the anchors it could not
    afford (``cut``: walked again, not lost). Pure.

    The step's anchors sit at their known distance, and so does what inside them it
    walked from (a container seed walks from the entities inside it that carry
    lineage); every partner is then one hop further than the nearest entity that
    reaches it through an edge the step shipped, and nearest the same seed. With
    ``is_leaf``, everything shipped inside an anchor is walked from that anchor's own
    distance — a partner too, its own distance read off the edges into it — what is
    inside a host and reached is a partner, and the partners bring in their hosts
    (``_hosts``)."""
    up = direction == "upstream"
    side = result.upstream_urns if up else result.downstream_urns
    other = result.downstream_urns if up else result.upstream_urns
    start: Dict[str, int] = {}
    origin: Dict[str, Optional[str]] = {}
    for a in work.anchors:
        k = known.get(a)
        start[a] = k.hops if k is not None and k.hops is not None else work.hops
        origin[a] = work.origins.get(a) or (k.origin if k is not None else None) or a
    base = min(start.values(), default=work.hops)
    anchors_set = dict.fromkeys(work.anchors)
    parent = {e.target_urn: e.source_urn for e in result.containment_edges}
    inside: Set[str] = set()     # with is_leaf: shipped inside an anchor
    in_host: Set[str] = set()    # ... inside one that is no seed's: reached, a partner
    for node in result.nodes:
        if node.urn in start:
            continue
        at = _anchor(node.urn, parent, anchors_set)
        if is_leaf is not None and at is not None:
            start[node.urn], origin[node.urn] = start[at], origin[at]
            inside.add(node.urn)
            if not _in_seed(at, parent, known):
                in_host.add(node.urn)
        elif node.urn not in side and node.urn not in other:
            start[node.urn] = base
            origin[node.urn] = origin[at if at is not None else work.anchors[0]]

    reach: Dict[str, List[str]] = {}
    for edge in result.edges:
        frm, to = (edge.target_urn, edge.source_urn) if up else (edge.source_urn, edge.target_urn)
        reach.setdefault(frm, []).append(to)
    best: Dict[str, int] = dict(start)
    heap = [(d, u) for u, d in start.items()]
    heapq.heapify(heap)
    while heap:
        d, u = heapq.heappop(heap)
        if d > best.get(u, math.inf):
            continue
        for v in reach.get(u, ()):
            if d + 1 < best.get(v, math.inf):
                best[v] = d + 1
                origin[v] = origin.get(u)
                heapq.heappush(heap, (d + 1, v))
    # With is_leaf, a partner's distance is where an edge reaches it from (one walked
    # from inside an anchor starts there): one hop further than the nearest entity
    # that reaches it.
    arrival: Dict[str, Tuple[int, Optional[str]]] = {}
    if is_leaf is not None:
        for u, tos in reach.items():
            for v in tos:
                if (v in side or v in in_host) and u in best and best[u] + 1 < arrival.get(v, (math.inf,))[0]:
                    arrival[v] = (best[u] + 1, origin.get(u))

    change = Change(remaining=target - work.hops)
    nodes = {n.urn: n for n in result.nodes}
    hops_now: Dict[str, int] = {u: k.hops for u, k in known.items() if k.hops is not None}
    for urn in sorted(set(side) | set(arrival)):
        if is_leaf is not None:
            hops, near = arrival.get(urn, (None, None))
        else:
            hops, near = best.get(urn), origin.get(urn)
        if hops is None:
            # Shipped on this side with no edge to place it by: one step out.
            hops = base + 1
        near = near or origin[work.anchors[0]]
        k = known.get(urn)
        if k is None:
            change.new.append(Found(urn, hops, near, nodes.get(urn)))
        elif k.hops is None or hops < k.hops:
            change.nearer.append(Found(urn, hops, near))
        else:
            continue
        hops_now[urn] = min(hops, hops_now.get(urn, hops))
    if is_leaf is not None:
        _hosts(change, nodes, parent, known, hops_now, target, is_leaf, walk_hosts)
        # A member inside an anchor was walked from the anchor's distance: not again from its own.
        change.walked = [u for u in sorted(inside) if u in hops_now and hops_now[u] >= start[u]]

    frontier = result.frontier_up if up else result.frontier_down
    anchors = set(work.anchors)
    cut: Set[str] = set()
    for entry in frontier:
        hops = hops_now.get(entry.urn)
        if hops is None:
            continue
        k = known.get(entry.urn)
        if work.kind == "hub" and entry.urn in anchors:
            # The hub's own next page, or "" when this was its last.
            continue
        if (work.kind != "hub" and entry.next_cursor and hops < target
                and (k is None or k.cursor is None)):
            # A hub no step can carry: paged to the end, once.
            change.cursors[entry.urn] = entry.next_cursor
        if entry.urn in anchors:
            if entry.reason == "cut" and not entry.next_cursor:
                cut.add(entry.urn)
            continue
        walked = k.walked if k is not None else -1
        if hops < target and walked < target - hops:
            change.queue.append(entry.urn)

    if edges:
        members = set(known) | {f.urn for f in change.new}
        change.edges = sorted({(e.source_urn, e.target_urn, e.edge_type) for e in result.edges
                               if e.source_urn in members and e.target_urn in members})
    return change, cut


def _anchor(urn: str, parent: Dict[str, str], anchors: Dict[str, None]) -> Optional[str]:
    """The anchor an entity sits inside, found up its containment chain — None when
    the step shipped no chain to one (it is then counted with the first anchor)."""
    at, seen = parent.get(urn), 0
    while at is not None and seen < 64:
        if at in anchors:
            return at
        at, seen = parent.get(at), seen + 1
    return None


def _hosts(change: Change, nodes: Dict[str, GraphNode], parent: Dict[str, str], known: Dict[str, Known],
           hops_now: Dict[str, int], target: int, is_leaf: Leaf, walk_hosts: bool) -> None:
    """Bring in the host of each partner the step found (new or nearer) whose type
    holds nothing: its parent, at the nearest distance found inside it, nearest that
    partner's seed. A host the step found in its own right keeps the nearer of the
    two; one known as near, a seed or inside one, is left as it is. A host that joins
    or comes nearer with depth left is queued (``walk_hosts``)."""
    found = {f.urn: f for f in (*change.new, *change.nearer)}
    reached: Dict[str, Found] = {}
    for f in sorted(found.values(), key=lambda f: (f.hops, f.urn)):
        node, host = nodes.get(f.urn), parent.get(f.urn)
        if node is not None and host is not None and host not in reached and is_leaf(node.entity_type):
            reached[host] = Found(host, f.hops, f.origin, nodes.get(host))
    for host, h in sorted(reached.items()):
        if _in_seed(host, parent, known):
            continue
        k, own = known.get(host), found.get(host)
        if own is not None:
            if h.hops < own.hops:
                own.hops, own.origin = h.hops, h.origin
            h = own
        elif k is None:
            change.new.append(h)
        elif k.hops is None or h.hops < k.hops:
            change.nearer.append(Found(host, h.hops, h.origin))
        else:
            continue
        hops_now[host] = h.hops
        walked = k.walked if k is not None else -1
        if walk_hosts and h.hops < target and walked < target - h.hops:
            change.queue.append(host)


def _in_seed(urn: str, parent: Dict[str, str], known: Dict[str, Known]) -> bool:
    """Whether ``urn`` is a seed, or sits inside one, up the chain the step shipped."""
    at, seen = urn, 0
    while at is not None and seen < 64:
        k = known.get(at)
        if k is not None and k.via in ("seed", "inside"):
            return True
        at, seen = parent.get(at), seen + 1
    return False


def _settle(state: dict, work: Work, result: TraceClosureResult, change: Change,
            cut: Set[str], failed: bool) -> bool:
    """What the step leaves for the next one. True when it let anchors go unwalked.

    What a failed step found is kept — it is real — but its anchors are walked
    again: with half the batch, then up to ``TRIES`` times alone, then let go.
    A batch every anchor of which was cut is a failure too: a step that cannot
    get anywhere would otherwise be asked again for ever."""
    if not failed and work.kind == "batch" and cut and len(cut) == len(work.anchors):
        failed = True
    if failed:
        if work.kind == "batch" and len(work.anchors) > 1:
            state["batch"] = max(1, len(work.anchors) // 2)
            return False
        state["tries"] = int(state.get("tries") or 0) + 1
        if state["tries"] < TRIES:
            if work.kind == "hub":
                change.cursors[work.anchors[0]] = work.cursor or ""
            return False
        state["tries"] = 0
        if work.kind == "batch":
            change.walked += work.anchors
        elif work.kind == "pending":
            state["pending"] = None
        else:
            change.cursors[work.anchors[0]] = ""
        return True

    state["tries"] = 0
    if work.kind == "hub":
        frontier = result.frontier_up + result.frontier_down
        nxt = next((f.next_cursor for f in frontier if f.urn == work.anchors[0] and f.next_cursor), None)
        change.cursors[work.anchors[0]] = nxt or ""
        return False
    if work.kind == "batch":
        # Grow back toward the full batch once steps succeed again.
        state["batch"] = min(CLOSURE_SEEDS, max(1, int(state.get("batch") or CLOSURE_SEEDS)) * 2)
        change.walked += [a for a in work.anchors if a not in cut]
    pages = (state["pending"] or {}).get("pages", 1) if work.kind == "pending" else 0
    state["pending"] = ({
        "anchors": work.anchors, "hops": work.hops, "origins": work.origins,
        "cursor": result.seed_cursor, "pages": pages + 1,
    } if result.seed_cursor else None)
    return False


class DictStore:
    """A walk's state in memory: one direction of one resolution (a Narrow), over
    the members it is building (``view_membership._Members``)."""

    def __init__(self, members, seeds: Sequence[str]):
        self.members = members
        self.hops: Dict[str, int] = {s: 0 for s in seeds if s in members}
        self.walked: Dict[str, int] = {}
        self.queued: Dict[str, None] = dict.fromkeys(self.hops)
        self.cursors: Dict[str, str] = {}
        self.origin: Dict[str, Optional[str]] = {s: s for s in self.hops}

    @property
    def full(self) -> bool:
        return self.members.full

    def _seq(self, urn: str) -> int:
        return self.members.seq.get(urn, 0)

    async def queue(self, direction, limit):
        if not self.queued:
            return []
        nearest = min(self.hops[u] for u in self.queued)
        at = sorted((u for u in self.queued if self.hops[u] == nearest), key=self._seq)[:limit]
        return [(u, nearest, self.origin.get(u)) for u in at]

    async def hub(self, direction):
        paging = [u for u, c in self.cursors.items() if c]
        if not paging:
            return None
        urn = min(paging, key=self._seq)
        return urn, self.cursors[urn], self.hops[urn], self.origin.get(urn)

    async def known_tail(self, direction, n, skip):
        skip = set(skip)
        return [u for u in self.hops if u not in skip][-n:]

    async def read(self, direction, urns):
        out: Dict[str, Known] = {}
        for urn in urns:
            entry = self.members.entries.get(urn)
            if entry is not None:
                out[urn] = Known(via=entry.via, hops=self.hops.get(urn),
                                 walked=self.walked.get(urn, -1), origin=self.origin.get(urn),
                                 cursor=self.cursors.get(urn))
        return out

    async def apply(self, direction, change):
        joined = 0
        for found in change.new:
            if self.members.add(found.urn, direction, found.hops):
                joined += 1
                self.hops[found.urn] = found.hops
                self.origin[found.urn] = found.origin
        for found in change.nearer:
            self.hops[found.urn] = min(found.hops, self.hops.get(found.urn, found.hops))
            self.members.add(found.urn, direction, found.hops)
            if self.members.entries[found.urn].via == direction:
                self.origin[found.urn] = found.origin
        for urn in change.walked:
            self.walked[urn] = change.remaining
            self.queued.pop(urn, None)
        for urn in change.queue:
            if urn in self.hops:
                self.queued[urn] = None
        self.cursors.update(change.cursors)
        return joined
