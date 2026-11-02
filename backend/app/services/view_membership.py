"""Resolve a membership spec into the entities it names.

The one resolver behind every surface that asks "what is in scope" — the Context
View's Focus filter today; saving a view from a query, keeping it live, exporting a
chosen subset and the API next (see ``backend/common/models/view_membership.py``).

It reads the graph only through the ``ContextEngine`` — and, for a query seed, a
search the caller hands in — ONE STATEMENT PER ADMISSION: ``admit`` is the
per-(provider, graph) slot pair the search route uses, so a resolution queues
behind the same bulkheads as every other read and never holds a slot while it
waits for another. Its result is a pure function of the spec and the graph, so the
route caches it under the spec's hash: a hundred people asking the same question
cost one walk.

Lineage is walked exactly as the trace walks it — ``trace_closure``: raw lineage
at the finest grain, a container seed through the entities inside it that carry
lineage, never a rollup and never containment as a hop. A closure step is bounded
(25 hops, a node budget, a hub paged by cursor), so the walk re-roots what one
step leaves unfinished until the depth asked for is reached, or a limit is: every
limit is a truncation the result names, never a silent short answer.
"""
from __future__ import annotations

import asyncio
import heapq
import math
import time
from contextlib import nullcontext
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Set, Tuple

from backend.common.models.graph import NodeQuery, TraceClosureRequest, TraceClosureResult
from backend.common.models.search import Predicate
from backend.common.models.view_membership import (
    LINEAGE_DEPTH_MAX,
    SEEDS_MAX,
    MemberEntry,
    MembershipCounts,
    MembershipResult,
    MembershipSpec,
    MembershipTruncation,
    Via,
)

#: Entities one resolution may hold. Past it the answer is truncated, and says so.
MEMBERS_MAX = 50_000
#: Members whose containment chain is read (the canvas shows and opens their containers).
CHAINS_MAX = 5_000
#: URNs per read: entity existence checks and ancestor chains.
READ_BATCH = 1_000
#: Descendants per page, and roots read at once.
DESCENDANTS_PAGE = 1_000
DESCENDANTS_CONCURRENCY = 4
#: A closure step's limits (TraceClosureRequest): seeds per request, URNs it may skip.
CLOSURE_SEEDS = 500
CLOSURE_EXCLUDE = 2_000
#: Pages read from one hub (a node with more lineage than a hop can carry).
HUB_PAGES_MAX = 20
#: Seed-cursor pages for one batch of container seeds.
SEED_PAGES_MAX = 50
#: A closure step's reasons that mean it gave up rather than hit a cap — the walk ranks
#: them ahead of ``max_nodes`` so the two are told apart. (``ancestors_failed`` is not one:
#: the containers it nests partners in are no part of a membership.)
_STEP_FAILURES = frozenset({"timeout", "seed_failed", "nodes_failed"})

Admit = Optional[Callable[[], object]]
#: A query seed's search: the predicate → (the URNs it finds, up to SEEDS_MAX; more existed).
SeedSearch = Callable[[Predicate], Awaitable[Tuple[List[str], bool]]]


class _Deadline(Exception):
    """The time budget ran out: stop where the resolution is."""


class _Members:
    """The scope as it grows: each entity once, with the first reason it joined."""

    def __init__(self, cap: int):
        self.cap = cap
        self.entries: Dict[str, MemberEntry] = {}
        self.full = False
        self.over = 0  # entities seen past the cap

    def add(self, urn: str, via: Via, hops: Optional[int] = None) -> bool:
        """True when ``urn`` is (now) in scope; False only when the cap refused it."""
        if urn in self.entries:
            return True
        if len(self.entries) >= self.cap:
            self.full = True
            self.over += 1
            return False
        self.entries[urn] = MemberEntry(urn=urn, via=via, hops=hops)
        return True

    def __contains__(self, urn: str) -> bool:
        return urn in self.entries

    def urns(self, *vias: Via) -> List[str]:
        return [u for u, e in self.entries.items() if not vias or e.via in vias]


class _Run:
    """One resolution's clock, slots and truncations."""

    def __init__(self, engine, admit: Admit, budget_s: float):
        self.engine = engine
        self.admit = admit
        self.deadline = time.monotonic() + budget_s
        self.truncated: Dict[str, MembershipTruncation] = {}

    def slot(self):
        return self.admit() if self.admit is not None else nullcontext()

    def check(self) -> None:
        if time.monotonic() >= self.deadline:
            raise _Deadline()

    def truncate(self, reason: str, seen: int, limit: int) -> None:
        # One entry per reason, keeping the largest count seen.
        prior = self.truncated.get(reason)
        if prior is None or seen > prior.seen:
            self.truncated[reason] = MembershipTruncation(reason=reason, seen=seen, limit=limit)


async def resolve_membership(
    engine,
    spec: MembershipSpec,
    *,
    search: Optional[SeedSearch] = None,
    admit: Admit = None,
    budget_s: float = 30.0,
    include_members: bool = True,
    data_version: str = "",
    max_members: int = MEMBERS_MAX,
) -> MembershipResult:
    """Resolve ``spec`` on ``engine``'s graph. Never raises for a limit — a limit
    is a truncation in the result — only for a request the graph cannot answer
    (a provider without the closure walk raises ``NotImplementedError``)."""
    started = time.monotonic()
    spec = spec.canonical()
    run = _Run(engine, admit, budget_s)
    members = _Members(max_members)
    expand = spec.expand
    whole: Set[str] = set()
    counts = MembershipCounts()
    missing = 0
    chains: Dict[str, List[str]] = {}

    try:
        # ── 1. Seeds ─────────────────────────────────────────────────────────
        if spec.seeds.urns is not None:
            found = await _existing(run, spec.seeds.urns)
            seeds = [u for u in spec.seeds.urns if u in found]
            missing = len(spec.seeds.urns) - len(seeds)
        else:
            if search is None:
                raise ValueError("a query seed needs a search to run it")
            run.check()
            seeds, more = await search(spec.seeds.query)
            seeds = list(dict.fromkeys(seeds))[:SEEDS_MAX]
            if more:
                run.truncate("seed_cap", len(seeds) + 1, SEEDS_MAX)
        for urn in seeds:
            members.add(urn, "seed")
        counts.seeds = len(members.entries)

        # ── 2. What is inside the seeds ──────────────────────────────────────
        if expand.children == "all":
            whole.update(seeds)
            counts.inside = None
        elif expand.children:
            counts.inside = await _descendants(run, members, seeds, int(expand.children), "inside")

        # ── 3. Their sources and consumers ───────────────────────────────────
        if expand.upstream:
            counts.upstream = await _lineage(run, members, seeds, "upstream", expand.upstream)
        if expand.downstream:
            counts.downstream = await _lineage(run, members, seeds, "downstream", expand.downstream)

        # ── 4. What is inside those ──────────────────────────────────────────
        partners = members.urns("upstream", "downstream")
        if expand.partner_children == "all":
            whole.update(partners)
            counts.partner_inside = None
        elif expand.partner_children and partners:
            counts.partner_inside = await _descendants(
                run, members, partners, int(expand.partner_children), "partnerInside")

        # ── 5. Where the members sit ─────────────────────────────────────────
        if include_members and members.entries:
            listed = list(members.entries)
            if len(listed) > CHAINS_MAX:
                run.truncate("chains_cap", len(listed), CHAINS_MAX)
            chains = await _chains(run, listed[:CHAINS_MAX])
    except _Deadline:
        run.truncate("deadline", len(members.entries), len(members.entries))

    if members.full:
        run.truncate("member_cap", len(members.entries) + members.over, members.cap)
    counts.total = len(members.entries)
    return MembershipResult(
        spec_hash=spec.spec_hash(),
        members=list(members.entries.values()) if include_members else [],
        whole_subtree=sorted(u for u in whole if u in members),
        chains=chains,
        counts=counts,
        missing_seeds=missing,
        truncated=sorted(run.truncated.values(), key=lambda t: t.reason),
        data_version=data_version,
        elapsed_ms=int((time.monotonic() - started) * 1000),
    )


def _batches(items: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


async def _existing(run: _Run, urns: List[str]) -> Set[str]:
    """Which of ``urns`` name an entity — a seed that names none is reported, not walked."""
    found: Set[str] = set()
    for batch in _batches(urns, READ_BATCH):
        run.check()
        async with run.slot():
            nodes = await run.engine.get_nodes_query(
                NodeQuery(urns=batch, limit=len(batch), include_child_count=False))
        found.update(n.urn for n in nodes)
    return found


async def _descendants(run: _Run, members: _Members, roots: List[str], depth: int, via: Via) -> int:
    """Add what is inside ``roots``, ``depth`` levels down. Returns how many joined."""
    added = 0
    gate = asyncio.Semaphore(DESCENDANTS_CONCURRENCY)

    async def one(root: str) -> List[str]:
        out: List[str] = []
        offset = 0
        while True:
            run.check()
            async with gate:
                async with run.slot():
                    page = await run.engine.get_descendants(
                        root, depth=depth, limit=DESCENDANTS_PAGE, offset=offset)
            out.extend(n.urn for n in page)
            if len(page) < DESCENDANTS_PAGE or len(out) + len(members.entries) > members.cap:
                return out
            offset += DESCENDANTS_PAGE

    for batch in _batches(roots, DESCENDANTS_CONCURRENCY * 8):
        # Every read in the batch settles before an error (the deadline) is raised —
        # none is left running unobserved after the answer has gone.
        results = await asyncio.gather(*(one(r) for r in batch), return_exceptions=True)
        for urns in results:
            if isinstance(urns, BaseException):
                raise urns
            for urn in urns:
                was = urn in members
                if members.add(urn, via) and not was:
                    added += 1
        if members.full:
            break
    return added


async def _lineage(run: _Run, members: _Members, seeds: List[str], direction: str, depth) -> int:
    """Add the seeds' sources (``upstream``) or consumers (``downstream``), ``depth``
    hops out, or the whole way for ``"all"``. Returns how many joined.

    A work queue of (absolute hops from the seeds, node): each step walks a batch
    of nodes as far as the remaining depth allows (25 at most), reads every
    partner's distance off the edges it shipped, and queues whatever the step
    left unfinished — a node the budget cut, the depth boundary, a hub's next
    page, a container's next page of seeds — so the walk completes rather than
    stopping at the first step's horizon.
    """
    target = math.inf if depth == "all" else int(depth)
    dist: Dict[str, int] = {s: 0 for s in seeds}
    walked: Dict[str, float] = {}       # node → the depth it has been walked to
    queue: List[Tuple[int, str]] = [(0, s) for s in seeds]
    heapq.heapify(queue)
    added = 0
    up = direction == "upstream"

    def follow(frontier) -> None:
        # What a step left unfinished, at its distance, while there is depth left.
        for entry in frontier:
            hops = dist.get(entry.urn)
            if hops is not None and hops < target:
                heapq.heappush(queue, (hops, entry.urn))

    while queue and not members.full:
        # The nearest unfinished nodes first, in one batch at one remaining depth.
        d0, first = heapq.heappop(queue)
        remaining = target - d0
        batch = [first]
        rest: List[Tuple[int, str]] = []
        while queue and len(batch) < CLOSURE_SEEDS:
            d, urn = heapq.heappop(queue)
            if target - d == remaining:
                batch.append(urn)
            else:
                rest.append((d, urn))
        for item in rest:
            heapq.heappush(queue, item)
        batch = sorted({u for u in batch if walked.get(u, -1) < remaining})
        if not batch or remaining <= 0:
            continue
        step = int(min(remaining, LINEAGE_DEPTH_MAX))
        for urn in batch:
            walked[urn] = remaining
        in_batch = set(batch)

        seed_cursor: Optional[str] = None
        for _page in range(SEED_PAGES_MAX):
            run.check()
            exclude = [u for u in dist if u not in in_batch][-CLOSURE_EXCLUDE:]
            request = TraceClosureRequest(
                urn=batch[0],
                direction=direction,
                upstream_depth=step if up else 0,
                downstream_depth=0 if up else step,
                seed_urns=batch,
                exclude_urns=exclude or None,
                seed_cursor=seed_cursor,
            )
            async with run.slot():
                result = await run.engine.trace_closure(request)
            _note_failure(run, result, dist)
            added += _take(result, members, dist, batch, direction)
            frontier = result.frontier_up if up else result.frontier_down
            for entry in frontier:
                if entry.next_cursor and entry.urn in dist:
                    added += await _page_hub(run, members, dist, entry.urn, entry.next_cursor,
                                             direction, follow)
            follow(frontier)
            seed_cursor = result.seed_cursor
            if not seed_cursor or members.full:
                break
        else:
            run.truncate("trace_cap", len(dist), len(dist))
    return added


def _note_failure(run: _Run, result: TraceClosureResult, dist: Dict[str, int]) -> None:
    """A step that gave up (timed out, a read failed) may have left lineage unwalked
    with nothing on its frontier to say so: the answer is incomplete, and says so."""
    if result.truncated and result.truncation_reason in _STEP_FAILURES:
        run.truncate("incomplete", len(dist), len(dist))


def _take(result: TraceClosureResult, members: _Members, dist: Dict[str, int],
          anchors: List[str], direction: str) -> int:
    """Add a closure step's partners, each at its distance from the seeds. Returns
    how many joined.

    The step's anchors — ``anchors``, and the lineage-bearing entities inside them
    that the closure walked from — sit at their known distance; every partner is
    then one hop further than the nearest node that reaches it through an edge the
    step shipped (a multi-source walk over those edges, nearest first).
    """
    up = direction == "upstream"
    side = result.upstream_urns if up else result.downstream_urns
    other = result.downstream_urns if up else result.upstream_urns
    start: Dict[str, int] = {a: dist[a] for a in anchors if a in dist}
    base = min(start.values(), default=0)
    for node in result.nodes:
        # The focus side: the anchors and what inside them carries lineage.
        if node.urn not in side and node.urn not in other and node.urn not in start:
            start[node.urn] = base
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
                heapq.heappush(heap, (d + 1, v))
    added = 0
    for urn in side:
        hops = best.get(urn)
        if hops is None:
            # Shipped on this side with no edge to place it by: one step out.
            hops = base + 1
        if hops < dist.get(urn, math.inf):
            dist[urn] = hops
        was = urn in members
        if members.add(urn, direction, dist[urn]) and not was:
            added += 1
    return added


async def _page_hub(run: _Run, members: _Members, dist: Dict[str, int], hub: str,
                    cursor: str, direction: str, follow) -> int:
    """Read a hub's lineage page by page — more than one closure step can carry —
    handing what each page leaves unfinished to ``follow``."""
    added = 0
    up = direction == "upstream"
    for _page in range(HUB_PAGES_MAX):
        run.check()
        async with run.slot():
            result = await run.engine.trace_closure(TraceClosureRequest(
                urn=hub, direction=direction,
                upstream_depth=1 if up else 0, downstream_depth=0 if up else 1,
                after_cursor=cursor,
            ))
        _note_failure(run, result, dist)
        added += _take(result, members, dist, [hub], direction)
        frontier = result.frontier_up if up else result.frontier_down
        follow([f for f in frontier if f.urn != hub])
        nxt = next((f.next_cursor for f in frontier if f.urn == hub and f.next_cursor), None)
        if not nxt or members.full:
            return added
        cursor = nxt
    run.truncate("trace_cap", len(dist), len(dist))
    return added


async def _chains(run: _Run, urns: List[str]) -> Dict[str, List[str]]:
    """Each member's containment ancestors (parent first). A provider that keeps no
    containment walk (a draft or versioned reader) answers none — the canvas then
    shows the members it has, without opening the way to the rest."""
    out: Dict[str, List[str]] = {}
    for batch in _batches(urns, READ_BATCH):
        run.check()
        try:
            async with run.slot():
                out.update(await run.engine.get_ancestor_chains(batch))
        except NotImplementedError:
            return out
    return out
