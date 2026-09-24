"""Lineage bridges — which members of a set reach which, through lineage the
set does not contain.

A curated view shows a SET of entities, its members. Between two members the
graph may carry lineage that runs through entities the view does not show:
A→B→C with only A and C in the view. The canvas draws a line only when both
ends are loaded, so that connection used to vanish. This module computes, for
every ordered pair of members, whether such a connection exists and how long
its shortest form is:

    link a→b with hops h  ⇔  the shortest RAW-lineage path from a node OWNED
                              by a to a node OWNED by b whose INTERIOR nodes
                              are owned by nobody has h edges, and h ≤ maxHops

``hops == 1`` is a direct link; ``hops ≥ 2`` is a VIRTUAL HOP, which the reader
sees as "A ⇢ C, via 1 step". A path stops at the first member it reaches: with
A, C and F picked out of A→B→C→D→E→F the answer is A⇢C and C⇢F, never A⇢F —
unless some A→F path avoids C, and then A⇢F is truthfully kept.

OWNERSHIP mirrors the canvas (``useLayerAssignment``): a member owns itself;
any other node is owned by the NEAREST member above it on its containment
chain, if that member inherits its children. A member with
``inheritsChildren=False`` blocks — what sits beneath it (and beneath no
deeper member) belongs to nobody, exactly as it drops out of the view.

WHY RAW LINEAGE. ``:AGGREGATED`` cells roll one real flow up both endpoints'
containment chains, and chaining them invents paths ("rollup transitivity is
not leaf transitivity"). So the walk starts at the lineage-bearing nodes INSIDE
the member regions — the leaves, where lineage lives — and follows raw edges.
The engine strips the synthetic types before any callback sees them.

THE ALGORITHM has two halves.

1. EXPLORATION reads the graph from both ends at once, level by level: forward
   (downstream) from the seeds the source members own, backward (upstream) from
   the seeds the target members own, each side only THROUGH unowned nodes — a
   member-owned node is a hit, never a hop. Each level expands whichever side
   is CHEAPER by the degree sum of its frontier, so the two sides meet in the
   middle, and at a hub they meet without ever expanding it: A→Hub→C is found
   when the forward side reaches Hub from A and the backward side reaches it
   from C, and Hub's ten thousand other edges are never read. When one side is
   huge — "grow three picks upstream" against a five-hundred-member view — it
   is never the cheaper one, and the search runs one-sided. Every edge read is
   RECORDED.

2. ATTRIBUTION runs in memory over the recorded edges: a forward BFS from the
   source seeds carrying a bitmask of origins per node, stopping at owned
   nodes. The level at which an origin's bit first reaches a node owned by
   target b is the link's hop count. It costs at most ``maxHops × |edges
   recorded|`` bigint ORs and never a per-origin walk.

WHY THIS IS EXACT. When the walk stops with the forward side at depth rf and
the backward side at depth rb, rf + rb = maxHops, every edge of every
qualifying path of length h ≤ maxHops has been recorded: its first rf edges lie
inside the forward ball, its last rb inside the backward ball, and together
they cover all h. A side that runs out of frontier with nothing cut has read
everything it can reach, so the walk may stop early. Attribution then finds the
minimum exactly: every path it sees is real, and the shortest one is complete.

HONESTY. Budgets are real — hub degree, interior nodes, rows read, the
deadline — and nothing a budget skipped is presented as absent. A node whose
adjacency was not read is CUT. Every origin whose bit reaches a forward-cut node
is reported ``incomplete`` downstream, and every target whose reverse bit
reaches a backward-cut node is reported ``incomplete`` upstream, with the
reason. A member not reported has every link it has within ``maxHops``.
(Conservative by construction: a flagged member may be complete after all,
because the other side can cover what one side skipped.)

Provider-neutral: providers supply ``BridgeCallbacks`` (FalkorDB:
``backend/app/providers/falkordb_bridges.py``; anything with ``get_edges``:
``lineage_bridges_generic.py``). This module never imports provider code.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import (
    Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Protocol, Sequence, Set, Tuple,
)

from backend.common.adapters import ProviderUnavailable
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    LineageBridgeIncomplete,
    LineageBridgeLink,
    LineageBridgePathResult,
    LineageBridgesResult,
    LineageBridgesStats,
)

logger = logging.getLogger(__name__)

#: Lineage-bearing region nodes enumerated across every member before the walk.
#: Past it the regions are not fully known: the owner of a node the walk meets
#: is then read off its containment chain instead, and every inheriting member
#: is reported ``seed_cap`` — its contents may hold starts the walk never had.
SEED_CAP = int(os.getenv("LINEAGE_BRIDGES_SEED_CAP", "50000"))
#: A frontier node with more lineage than this in the walked direction is not
#: expanded; it is cut as a ``hub``. The two-sided search usually meets AT a hub
#: without needing to, which is the point of it.
HUB_DEGREE = int(os.getenv("LINEAGE_BRIDGES_HUB_DEGREE", "5000"))
#: Edges one request may read, as a multiple of its interior-node budget.
ROWS_PER_NODE = 4
#: Nodes and expected rows per expansion query — one wave's IN-list and result
#: set stay the size the closure walk already runs at.
SLICE_NODES = int(os.getenv("LINEAGE_BRIDGES_SLICE_NODES", "500"))
SLICE_ROWS = 20_000
#: Hidden steps a path answer ships (nearest the source first).
PATH_NODE_CAP = 300
#: The per-query ceiling; the walk deadline bounds every query further.
QUERY_CAP_SECS = float(os.getenv("LINEAGE_BRIDGES_QUERY_CAP_SECS", "10.0"))
#: Share of the request budget kept back for attribution and hydration.
RESERVE_FRACTION = 0.2
#: Recorded edges above which attribution runs on a worker thread, so a large
#: answer never stalls the event loop that is serving everyone else.
ATTRIBUTION_OFFLOAD_EDGES = 20_000

#: Most severe first. A FAILURE outranks a CAP, so a result that is both is
#: never cached as a complete-by-contract answer; only ``max_nodes`` and
#: ``degree_cap`` are pure functions of (graph, request).
_REASON_ORDER = (
    "timeout", "seed_failed", "expand_failed", "chains_failed", "nodes_failed",
    "max_nodes", "degree_cap",
)
#: How a member's incompleteness is reported when several causes apply.
_INCOMPLETE_PRIORITY = {"failed": 0, "seed_cap": 1, "hub": 2, "budget": 3}


class _Unknown:
    """Owner of a node whose containment chain could not be read. Attribution
    neither passes through it nor counts a hit on it; it is a cut."""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<unknown owner>"


UNKNOWN = _Unknown()


# ---------------------------------------------------------------------------
# Callback protocol
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Hop:
    """One raw lineage edge read by an expansion, oriented by data flow
    (``source`` feeds ``target``). ``other`` is the far endpoint relative to
    the node that was expanded, with its label when the provider knows it —
    so the next frontier is label-bucketed without a lookup."""
    source: str
    target: str
    other: str
    other_label: str = ""
    edge_id: str = ""
    edge_type: str = ""


@dataclass
class ExpandPage:
    """What one expansion read. ``failed`` names the nodes whose adjacency
    could NOT be read — never silently folded into ``hops``."""
    hops: List[Hop] = field(default_factory=list)
    failed: Set[str] = field(default_factory=set)


@dataclass
class RegionSeeds:
    """The lineage-bearing nodes inside member regions, and who owns each.

    A member's OWN node is always in ``owner`` when it bears lineage — the
    members are a bounded set, and ``cap`` never applies to them. ``complete``
    is about what lies BENEATH the members: it means every lineage-bearing
    descendant a member owns is in ``owner`` too, so any node the walk meets
    that is not in it belongs to nobody and no containment chain has to be
    read. ``failed`` means a query failed, and then not even the members' own
    nodes can be trusted to be listed (``complete`` is False as well)."""
    owner: Dict[str, str] = field(default_factory=dict)
    labels: Dict[str, str] = field(default_factory=dict)
    complete: bool = True
    failed: bool = False


class BridgeCallbacks(Protocol):
    """Provider-supplied reads. Every call is bounded by the ``timeout`` it is
    handed; the walker owns the request deadline. Raise ``ProviderUnavailable``
    only when the provider as a whole is gone — any other failure is reported
    in the return value (``failed``, ``None``) so the walk can cut honestly."""

    #: False when ``degrees`` cannot answer; the walker then reads in chunks
    #: and detects overflow by the limit instead of by the degree sum.
    supports_degrees: bool

    async def region_seeds(
        self, members: Mapping[str, bool], *, cap: int, timeout: float,
    ) -> RegionSeeds: ...

    async def degrees(
        self, nodes: Sequence[Tuple[str, str]], *, incoming: bool, timeout: float,
    ) -> Optional[Dict[str, int]]: ...

    async def expand(
        self, nodes: Sequence[Tuple[str, str]], *, incoming: bool, limit: int, timeout: float,
    ) -> ExpandPage: ...

    async def ancestor_chains(
        self, urns: Sequence[str], *, timeout: float,
    ) -> Optional[Dict[str, List[str]]]: ...

    async def hydrate(self, urns: Sequence[str], *, timeout: float) -> List[GraphNode]: ...


def owner_from_chain(
    urn: str, chain: Optional[Sequence[str]], members: Mapping[str, bool],
) -> Optional[str]:
    """The member that owns ``urn`` given its containment chain (parent first):
    itself if it is a member; else the nearest member above it, when that
    member inherits its children; else nobody."""
    if urn in members:
        return urn
    for ancestor in chain or ():
        if ancestor in members:
            return ancestor if members[ancestor] else None
    return None


def iter_bits(mask: int, order: Sequence[str]) -> Iterator[str]:
    """The members whose bits are set in ``mask`` (``order[i]`` is bit i)."""
    while mask:
        low = mask & -mask
        yield order[low.bit_length() - 1]
        mask ^= low


# ---------------------------------------------------------------------------
# Walk state
# ---------------------------------------------------------------------------

@dataclass
class _Side:
    """One end of the two-sided search."""
    incoming: bool                                   # True walks upstream
    frontier: List[Tuple[str, str]]                  # (urn, label), this level's
    reached: Set[str]
    depth: int = 0
    cut: Dict[str, str] = field(default_factory=dict)   # urn -> budget|hub|failed

    @property
    def naturally_exhausted(self) -> bool:
        """Nothing left to expand and nothing skipped: everything this side can
        reach has been read, so every qualifying path is already recorded."""
        return not self.frontier and not self.cut


@dataclass
class _Walk:
    members: Dict[str, bool]
    max_nodes: int
    deadline: float
    walk_deadline: float
    rows_left: int
    owner: Dict[str, object] = field(default_factory=dict)     # urn -> member | None | UNKNOWN
    seeds: Dict[str, str] = field(default_factory=dict)        # seed urn -> owning member
    labels: Dict[str, str] = field(default_factory=dict)
    seeds_complete: bool = True
    seed_issue: Optional[str] = None                           # 'seed_cap' | 'failed'
    out_adj: Dict[str, Set[str]] = field(default_factory=dict)
    in_adj: Dict[str, Set[str]] = field(default_factory=dict)
    edge_meta: Dict[Tuple[str, str], Tuple[str, str]] = field(default_factory=dict)
    degree_cache: Dict[Tuple[str, bool], int] = field(default_factory=dict)
    interior: Set[str] = field(default_factory=set)
    reasons: List[str] = field(default_factory=list)
    depth_limited: bool = False

    @classmethod
    def start(cls, members: Mapping[str, bool], max_nodes: int, deadline: float) -> "_Walk":
        now = time.monotonic()
        reserve = min(5.0, RESERVE_FRACTION * max(0.0, deadline - now))
        return cls(
            members=dict(members),
            max_nodes=max(1, int(max_nodes)),
            deadline=deadline,
            walk_deadline=deadline - reserve,
            rows_left=ROWS_PER_NODE * max(1, int(max_nodes)),
        )

    def query_timeout(self, *, final: bool = False) -> float:
        end = self.deadline if final else self.walk_deadline
        return max(0.5, min(QUERY_CAP_SECS, end - time.monotonic()))

    def out_of_time(self) -> bool:
        return time.monotonic() >= self.walk_deadline

    def fail(self, reason: str) -> None:
        if reason not in self.reasons:
            self.reasons.append(reason)

    def truncation_reason(self) -> Optional[str]:
        for candidate in _REASON_ORDER:
            if candidate in self.reasons:
                return candidate
        return None

    def record(self, hop: Hop) -> None:
        key = (hop.source, hop.target)
        if key in self.edge_meta:
            return
        self.edge_meta[key] = (hop.edge_id, hop.edge_type)
        self.out_adj.setdefault(hop.source, set()).add(hop.target)
        self.in_adj.setdefault(hop.target, set()).add(hop.source)


def _chunks(items: Sequence, size: int) -> Iterator[Sequence]:
    for i in range(0, len(items), max(1, size)):
        yield items[i:i + size]


# ---------------------------------------------------------------------------
# Exploration
# ---------------------------------------------------------------------------

async def _seed(cb: BridgeCallbacks, walk: _Walk) -> None:
    try:
        seeds = await cb.region_seeds(walk.members, cap=SEED_CAP, timeout=walk.query_timeout())
    except ProviderUnavailable:
        raise
    except Exception as exc:
        logger.warning("lineage_bridges: region seed enumeration failed: %s", exc)
        seeds = RegionSeeds(complete=False, failed=True)
    walk.seeds = dict(seeds.owner)
    walk.owner.update(seeds.owner)
    walk.labels.update(seeds.labels)
    walk.seeds_complete = bool(seeds.complete and not seeds.failed)
    if seeds.failed:
        walk.fail("seed_failed")
        walk.seed_issue = "failed"
    elif not seeds.complete:
        walk.fail("max_nodes")
        walk.seed_issue = "seed_cap"


def _side(walk: _Walk, owners: Set[str], *, incoming: bool) -> _Side:
    frontier = sorted(
        (urn, walk.labels.get(urn, "")) for urn, owner in walk.seeds.items() if owner in owners
    )
    return _Side(incoming=incoming, frontier=frontier, reached={u for u, _ in frontier})


async def _degrees(
    cb: BridgeCallbacks, walk: _Walk, nodes: Sequence[Tuple[str, str]], incoming: bool,
) -> Optional[Dict[str, int]]:
    """Degree per node in the walked direction, cached for the request (a
    node's degree does not change mid-request). None when the probe failed."""
    need = [n for n in nodes if (n[0], incoming) not in walk.degree_cache]
    for chunk in _chunks(need, SLICE_NODES):
        try:
            got = await cb.degrees(chunk, incoming=incoming, timeout=walk.query_timeout())
        except ProviderUnavailable:
            raise
        except Exception as exc:
            logger.warning("lineage_bridges: degree probe failed: %s", exc)
            got = None
        if got is None:
            return None
        for urn, _ in chunk:
            walk.degree_cache[(urn, incoming)] = int(got.get(urn, 0) or 0)
    return {urn: walk.degree_cache[(urn, incoming)] for urn, _ in nodes}


async def _cheaper(cb: BridgeCallbacks, walk: _Walk, fwd: _Side, bwd: _Side) -> _Side:
    if not fwd.frontier:
        return bwd
    if not bwd.frontier:
        return fwd
    if cb.supports_degrees:
        df = await _degrees(cb, walk, fwd.frontier, False)
        db = await _degrees(cb, walk, bwd.frontier, True)
        if df is not None and db is not None:
            return fwd if sum(df.values()) <= sum(db.values()) else bwd
    return fwd if len(fwd.frontier) <= len(bwd.frontier) else bwd


async def _read(
    cb: BridgeCallbacks, walk: _Walk, side: _Side, frontier: List[Tuple[str, str]],
) -> List[Hop]:
    """Read one level's adjacency within the budget; cut what does not fit."""
    hops: List[Hop] = []

    async def _expand(nodes: Sequence[Tuple[str, str]], limit: int) -> Optional[ExpandPage]:
        try:
            return await cb.expand(
                nodes, incoming=side.incoming, limit=limit, timeout=walk.query_timeout(),
            )
        except ProviderUnavailable:
            raise
        except Exception as exc:
            logger.warning("lineage_bridges: expansion failed for %d nodes: %s", len(nodes), exc)
            return None

    def _cut(nodes: Iterable[Tuple[str, str]], why: str, reason: str) -> None:
        cut_any = False
        for urn, _ in nodes:
            side.cut.setdefault(urn, why)
            cut_any = True
        if cut_any:
            walk.fail(reason)

    deg = await _degrees(cb, walk, frontier, side.incoming) if cb.supports_degrees else None
    if deg is not None:
        hubs = [n for n in frontier if deg[n[0]] > HUB_DEGREE]
        _cut(hubs, "hub", "degree_cap")
        candidates = sorted(
            (n for n in frontier if 0 < deg[n[0]] <= HUB_DEGREE),
            key=lambda n: (deg[n[0]], n[0]),
        )
        taken: List[Tuple[str, str]] = []
        budget = walk.rows_left
        for n in candidates:
            if deg[n[0]] > budget:
                break
            budget -= deg[n[0]]
            taken.append(n)
        _cut(candidates[len(taken):], "budget", "max_nodes")
        # Group into slices that keep both the IN-list and the result bounded.
        slices: List[List[Tuple[str, str]]] = []
        current: List[Tuple[str, str]] = []
        rows = 0
        for n in taken:
            if current and (len(current) >= SLICE_NODES or rows + deg[n[0]] > SLICE_ROWS):
                slices.append(current)
                current, rows = [], 0
            current.append(n)
            rows += deg[n[0]]
        if current:
            slices.append(current)
        for piece in slices:
            if walk.out_of_time():
                walk.fail("timeout")
                _cut(piece, "failed", "timeout")
                continue
            expected = sum(deg[n[0]] for n in piece)
            page = await _expand(piece, expected + 1)
            if page is None:
                _cut(piece, "failed", "expand_failed")
                continue
            hops.extend(page.hops)
            walk.rows_left -= len(page.hops)
            if len(page.hops) > expected:
                # More rows than the probe counted: the graph changed under the
                # read. The rows are real, but the adjacency may not be whole.
                _cut(piece, "failed", "expand_failed")
            elif page.failed:
                _cut([n for n in piece if n[0] in page.failed], "failed", "expand_failed")
        return hops

    # No degrees: read in node slices, and let the row budget itself be the
    # overflow detector — a slice that returns more than the budget allows
    # was not read whole, and is cut.
    ordered = sorted(frontier)
    for index, piece in enumerate(_chunks(ordered, SLICE_NODES)):
        if walk.rows_left <= 0:
            _cut(ordered[index * SLICE_NODES:], "budget", "max_nodes")
            break
        if walk.out_of_time():
            walk.fail("timeout")
            _cut(ordered[index * SLICE_NODES:], "failed", "timeout")
            break
        allowed = walk.rows_left
        page = await _expand(piece, allowed + 1)
        if page is None:
            _cut(piece, "failed", "expand_failed")
            continue
        hops.extend(page.hops[:allowed])
        walk.rows_left -= min(len(page.hops), allowed)
        if len(page.hops) > allowed:
            _cut(piece, "budget", "max_nodes")
        elif page.failed:
            _cut([n for n in piece if n[0] in page.failed], "failed", "expand_failed")
    return hops


async def _resolve_owners(
    cb: BridgeCallbacks, walk: _Walk, side: _Side, fresh: Sequence[str],
) -> None:
    """Decide who owns each newly met node. With a complete seed index that
    is a lookup — any lineage-bearing node inside a region is in it — and only
    otherwise are containment chains read."""
    unknown = [u for u in fresh if u not in walk.owner]
    if not unknown:
        return
    if walk.seeds_complete:
        for urn in unknown:
            walk.owner[urn] = urn if urn in walk.members else None
        return
    chains: Optional[Dict[str, List[str]]] = None
    try:
        chains = await cb.ancestor_chains(unknown, timeout=walk.query_timeout())
    except ProviderUnavailable:
        raise
    except Exception as exc:
        logger.warning("lineage_bridges: ancestor chains failed for %d nodes: %s", len(unknown), exc)
    for urn in unknown:
        if chains is None or urn not in chains:
            walk.owner[urn] = UNKNOWN
            side.cut.setdefault(urn, "failed")
            walk.fail("chains_failed")
        else:
            walk.owner[urn] = owner_from_chain(urn, chains[urn], walk.members)


async def _step(cb: BridgeCallbacks, walk: _Walk, side: _Side) -> None:
    """Expand ``side`` by one level."""
    frontier, side.frontier = side.frontier, []
    side.depth += 1
    hops = await _read(cb, walk, side, frontier)
    fresh: List[str] = []
    for hop in hops:
        walk.record(hop)
        other = hop.other
        if other in side.reached:
            continue
        side.reached.add(other)
        if hop.other_label and other not in walk.labels:
            walk.labels[other] = hop.other_label
        fresh.append(other)
    await _resolve_owners(cb, walk, side, fresh)
    interior = sorted(u for u in fresh if walk.owner.get(u) is None)
    next_frontier: List[Tuple[str, str]] = []
    for urn in interior:
        if urn not in walk.interior:
            if len(walk.interior) >= walk.max_nodes:
                side.cut.setdefault(urn, "budget")
                walk.fail("max_nodes")
                continue
            walk.interior.add(urn)
        next_frontier.append((urn, walk.labels.get(urn, "")))
    side.frontier = next_frontier


async def _explore(
    cb: BridgeCallbacks, walk: _Walk, fwd: _Side, bwd: _Side, max_hops: int,
) -> None:
    while fwd.depth + bwd.depth < max_hops:
        # An exhausted side proves every path recorded only when it STARTED
        # from every seed its members own. With a capped or failed seed index
        # the other side may still find what the unseeded starts would have.
        if walk.seeds_complete and (fwd.naturally_exhausted or bwd.naturally_exhausted):
            return
        if not fwd.frontier and not bwd.frontier:
            return
        if walk.out_of_time():
            walk.fail("timeout")
            for side in (fwd, bwd):
                for urn, _ in side.frontier:
                    side.cut.setdefault(urn, "failed")
                side.frontier = []
            return
        side = await _cheaper(cb, walk, fwd, bwd)
        await _step(cb, walk, side)
    walk.depth_limited = bool(fwd.frontier or bwd.frontier)


# ---------------------------------------------------------------------------
# Attribution (pure, in memory)
# ---------------------------------------------------------------------------

def propagate_masks(
    adj: Mapping[str, Iterable[str]],
    starts: Mapping[str, str],
    owner: Mapping[str, object],
    order: Sequence[str],
    max_hops: int,
    *,
    targets: Optional[Set[str]] = None,
) -> Tuple[Dict[Tuple[str, str], int], Dict[str, int]]:
    """Level BFS over ``adj`` from ``starts`` (node → the member it belongs to,
    only members in ``order`` count), carrying a bitmask of those members per
    node and moving only through UNOWNED nodes.

    Returns ``(links, seen)``: ``links[(start_member, hit_member)] = level`` for
    the first level each start member's bit reached a node owned by a member in
    ``targets`` (never the member itself), and ``seen[node]`` = every start
    member whose bit reached ``node`` — including the cut and unknown nodes the
    BFS stops at, so their reach can be reported."""
    bit = {member: 1 << i for i, member in enumerate(order)}
    frontier: Dict[str, int] = {}
    for node, member in starts.items():
        b = bit.get(member)
        if b:
            frontier[node] = frontier.get(node, 0) | b
    seen: Dict[str, int] = dict(frontier)
    linked: Dict[str, int] = {}
    links: Dict[Tuple[str, str], int] = {}
    for level in range(1, max_hops + 1):
        nxt: Dict[str, int] = {}
        for node, mask in frontier.items():
            for succ in adj.get(node, ()):
                who = owner.get(succ)
                if who is UNKNOWN:
                    seen[succ] = seen.get(succ, 0) | mask
                    continue
                if who is not None:
                    if targets is not None and who in targets:
                        fresh = mask & ~linked.get(who, 0) & ~bit.get(who, 0)
                        if fresh:
                            linked[who] = linked.get(who, 0) | fresh
                            for member in iter_bits(fresh, order):
                                links[(member, who)] = level
                    continue
                add = mask & ~seen.get(succ, 0)
                if add:
                    seen[succ] = seen.get(succ, 0) | add
                    nxt[succ] = nxt.get(succ, 0) | add
        frontier = nxt
        if not frontier:
            break
    return links, seen


def _incompleteness(
    walk: _Walk,
    fwd: _Side,
    bwd: _Side,
    forward_seen: Mapping[str, int],
    forward_order: Sequence[str],
    sources: Set[str],
    targets: Set[str],
    max_hops: int,
) -> List[LineageBridgeIncomplete]:
    flagged: Dict[Tuple[str, str], str] = {}

    def _flag(member: str, side: str, reason: str) -> None:
        key = (member, side)
        prior = flagged.get(key)
        if prior is None or _INCOMPLETE_PRIORITY[reason] < _INCOMPLETE_PRIORITY[prior]:
            flagged[key] = reason

    for node, why in fwd.cut.items():
        for member in iter_bits(forward_seen.get(node, 0), forward_order):
            _flag(member, "downstream", why)
    if bwd.cut:
        backward_order = sorted(targets)
        starts = {n: m for n, m in walk.seeds.items() if m in targets}
        _, backward_seen = propagate_masks(walk.in_adj, starts, walk.owner, backward_order, max_hops)
        for node, why in bwd.cut.items():
            for member in iter_bits(backward_seen.get(node, 0), backward_order):
                _flag(member, "upstream", why)
    if walk.seed_issue:
        for member in sorted(walk.members):
            if walk.seed_issue == "seed_cap" and not walk.members[member]:
                # Owns only itself, and a member's own node is never capped:
                # nothing of it went unenumerated. A FAILED enumeration can
                # have missed even that, so it flags every member.
                continue
            if member in sources:
                _flag(member, "downstream", walk.seed_issue)
            if member in targets:
                _flag(member, "upstream", walk.seed_issue)
    return [
        LineageBridgeIncomplete(urn=member, side=side, reason=reason)
        for (member, side), reason in sorted(flagged.items())
    ]


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

async def run_lineage_bridges(
    cb: BridgeCallbacks,
    *,
    members: Mapping[str, bool],
    origins: Optional[Sequence[str]],
    direction: str,
    max_hops: int,
    max_nodes: int,
    deadline: float,
) -> LineageBridgesResult:
    """Every link among ``members`` — see the module docstring.

    ``direction='downstream'`` asks from the origins toward every member;
    ``'upstream'`` from every member toward the origins. Links are always
    oriented by data flow."""
    started = time.monotonic()
    walk = _Walk.start(members, max_nodes, deadline)
    chosen = [o for o in (origins if origins else sorted(walk.members)) if o in walk.members]
    if direction == "upstream":
        sources, targets = set(walk.members), set(chosen)
    else:
        sources, targets = set(chosen), set(walk.members)

    await _seed(cb, walk)
    fwd = _side(walk, sources, incoming=False)
    bwd = _side(walk, targets, incoming=True)
    await _explore(cb, walk, fwd, bwd, max_hops)

    forward_order = sorted(sources)
    starts = {n: m for n, m in walk.seeds.items() if m in sources}

    def _attribute() -> Tuple[Dict[Tuple[str, str], int], Dict[str, int]]:
        return propagate_masks(
            walk.out_adj, starts, walk.owner, forward_order, max_hops, targets=targets,
        )

    if len(walk.edge_meta) > ATTRIBUTION_OFFLOAD_EDGES:
        links, forward_seen = await asyncio.to_thread(_attribute)
    else:
        links, forward_seen = _attribute()

    incomplete = _incompleteness(
        walk, fwd, bwd, forward_seen, forward_order, sources, targets, max_hops,
    )
    reason = walk.truncation_reason()
    if reason:
        logger.warning(
            "lineage_bridges truncated",
            extra={
                "reason": reason, "members": len(walk.members), "seeds": len(walk.seeds),
                "interior": len(walk.interior), "edges": len(walk.edge_meta),
                "incomplete": len(incomplete),
            },
        )
    return LineageBridgesResult(
        links=[
            LineageBridgeLink(source=a, target=b, hops=h)
            for (a, b), h in sorted(links.items())
        ],
        incomplete=incomplete,
        depthLimited=walk.depth_limited,
        truncated=reason is not None,
        truncationReason=reason,
        stats=LineageBridgesStats(
            seeds=len(walk.seeds),
            interiorNodes=len(walk.interior),
            edgesRead=len(walk.edge_meta),
            forwardDepth=fwd.depth,
            backwardDepth=bwd.depth,
            elapsedMs=int((time.monotonic() - started) * 1000),
        ),
    )


def _levels(
    adj: Mapping[str, Iterable[str]],
    starts: Iterable[str],
    passable: Callable[[str], bool],
    max_hops: int,
) -> Dict[str, int]:
    """Plain BFS distances from ``starts``, moving only into nodes for which
    ``passable(node)`` holds; non-passable nodes are recorded (arrival) but
    never left."""
    dist: Dict[str, int] = {s: 0 for s in starts}
    frontier = list(dist)
    for level in range(1, max_hops + 1):
        nxt: List[str] = []
        for node in frontier:
            for succ in adj.get(node, ()):
                if succ in dist:
                    continue
                dist[succ] = level
                if passable(succ):
                    nxt.append(succ)
        frontier = nxt
        if not frontier:
            break
    return dist


async def run_bridge_path(
    cb: BridgeCallbacks,
    *,
    members: Mapping[str, bool],
    source: str,
    target: str,
    max_hops: int,
    max_nodes: int,
    deadline: float,
) -> LineageBridgePathResult:
    """Every SHORTEST path from ``source`` to ``target`` through unowned nodes,
    walked with the same member set — so the steps are exactly the ones the
    link was drawn over."""
    walk = _Walk.start(members, max_nodes, deadline)
    empty = LineageBridgePathResult(source=source, target=target)
    if source not in walk.members or target not in walk.members or source == target:
        return empty

    await _seed(cb, walk)
    fwd = _side(walk, {source}, incoming=False)
    bwd = _side(walk, {target}, incoming=True)
    await _explore(cb, walk, fwd, bwd, max_hops)

    def unowned(node: str) -> bool:
        return walk.owner.get(node) is None

    source_starts = [n for n, m in walk.seeds.items() if m == source]
    target_owned = {n for n, m in walk.owner.items() if m == target}
    d_f = _levels(walk.out_adj, source_starts, unowned, max_hops)
    arrivals = [d for n, d in d_f.items() if n in target_owned]
    reason = walk.truncation_reason()
    if not arrivals:
        return LineageBridgePathResult(
            source=source, target=target, truncated=reason is not None, truncationReason=reason,
        )
    best = min(arrivals)
    d_b = _levels(walk.in_adj, sorted(target_owned), unowned, max_hops)

    on_path: List[Tuple[str, str]] = []
    for (u, v) in walk.edge_meta:
        du = d_f.get(u)
        dv = d_b.get(v)
        if du is None or dv is None:
            continue
        if not (walk.owner.get(u) == source or unowned(u)):
            continue
        if not (v in target_owned or unowned(v)):
            continue
        if du + 1 + dv == best:
            on_path.append((u, v))

    hidden = sorted(
        {n for edge in on_path for n in edge if unowned(n)},
        key=lambda n: (d_f.get(n, 0), n),
    )
    if len(hidden) > PATH_NODE_CAP:
        keep = set(hidden[:PATH_NODE_CAP])
        hidden = hidden[:PATH_NODE_CAP]
        on_path = [(u, v) for (u, v) in on_path if (not unowned(u) or u in keep) and (not unowned(v) or v in keep)]
        walk.fail("max_nodes")
        reason = walk.truncation_reason()
    endpoints = sorted({n for edge in on_path for n in edge if not unowned(n)})

    edges = [
        GraphEdge(
            id=walk.edge_meta[(u, v)][0] or f"bridge-path:{u}->{v}",
            sourceUrn=u,
            targetUrn=v,
            edgeType=walk.edge_meta[(u, v)][1] or "LINEAGE",
            properties={},
        )
        for (u, v) in sorted(on_path)
    ]

    wanted = hidden + endpoints
    nodes_by_urn: Dict[str, GraphNode] = {}
    chains: Dict[str, List[str]] = {}
    try:
        got = await cb.ancestor_chains(wanted, timeout=walk.query_timeout(final=True))
        chains = {u: list(c or []) for u, c in (got or {}).items() if u in set(wanted)}
        everyone = list(dict.fromkeys(wanted + [a for c in chains.values() for a in c]))
        for node in await cb.hydrate(everyone, timeout=walk.query_timeout(final=True)):
            if node is not None:
                nodes_by_urn[node.urn] = node
        if any(u not in nodes_by_urn for u in wanted):
            walk.fail("nodes_failed")
    except ProviderUnavailable:
        raise
    except Exception as exc:
        logger.warning("lineage_bridges path: hydration failed: %s", exc)
        walk.fail("nodes_failed")
    reason = walk.truncation_reason()

    return LineageBridgePathResult(
        source=source,
        target=target,
        hops=best,
        hiddenUrns=hidden,
        endpointUrns=endpoints,
        nodes=list(nodes_by_urn.values()),
        edges=edges,
        ancestorChains=chains,
        truncated=reason is not None,
        truncationReason=reason,
    )
