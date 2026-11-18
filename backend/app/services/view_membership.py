"""Resolve a membership spec into the entities it names.

The one resolver behind every surface that asks "what is in scope" — the Context
View's Narrow filter today; saving a view from a query, keeping it live, exporting a
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
import time
from contextlib import nullcontext
from typing import Awaitable, Callable, Dict, Iterable, List, Optional, Set, Tuple

from backend.app.services.graph_cache import ENDPOINT_MEMBERS
from backend.app.services.member_sets import walk
from backend.common.models.graph import NodeQuery
from backend.common.models.search import Predicate
from backend.common.models.view_membership import (
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
#: Pages read from one hub (a node with more lineage than a hop can carry).
HUB_PAGES_MAX = 20
#: Seed-cursor pages for one batch of container seeds.
SEED_PAGES_MAX = 50

Admit = Optional[Callable[[], object]]
#: A query seed's search: the predicate → (the URNs it finds, up to SEEDS_MAX; more existed).
SeedSearch = Callable[[Predicate], Awaitable[Tuple[List[str], bool]]]


class _Deadline(Exception):
    """The time budget ran out: stop where the resolution is."""


class _Members:
    """The scope as it grows: each entity once, with the first reason it joined and
    the nearest distance it is found at for that reason."""

    def __init__(self, cap: int):
        self.cap = cap
        self.entries: Dict[str, MemberEntry] = {}
        self.seq: Dict[str, int] = {}  # the order each joined
        self.full = False
        self.over = 0  # entities seen past the cap

    def add(self, urn: str, via: Via, hops: Optional[int] = None) -> bool:
        """True when ``urn`` is (now) in scope; False only when the cap refused it."""
        entry = self.entries.get(urn)
        if entry is not None:
            # Found again, nearer, for the same reason: a walk can reach a node by a
            # longer path first (another anchor's step), and the first distance it
            # was found at is not its distance.
            if hops is not None and entry.via == via and (entry.hops is None or hops < entry.hops):
                entry.hops = hops
            return True
        if len(self.entries) >= self.cap:
            self.full = True
            self.over += 1
            return False
        self.seq[urn] = len(self.entries)
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


async def resolve_cached(
    engine,
    spec: MembershipSpec,
    *,
    scope,
    cache,
    read_in: Optional[str],
    boundary: str = "",
    search: Optional[SeedSearch] = None,
    admit: Admit = None,
    budget_s: float = 30.0,
    include_members: bool = True,
    data_version: str = "",
    on_stale: Optional[Callable[[], None]] = None,
) -> MembershipResult:
    """``resolve_membership`` through the graph cache — one walk per question, shared
    by every caller asking it on the same graph data.

    The key is the spec's hash, whether members are listed, and — for query seeds
    only — the view the query is read in and that view's boundary (``boundary``,
    the search's scope hash), because a query's answer depends on them. URN seeds
    are what they are wherever they are read, so a narrowing in one view and the
    refresh of a saved view share one entry. ``scope`` None (no workspace) skips
    the cache.
    """
    async def compute() -> MembershipResult:
        return await resolve_membership(
            engine, spec, search=search, admit=admit, budget_s=budget_s,
            include_members=include_members, data_version=data_version,
        )

    if scope is None:
        return await compute()
    query_seeded = spec.seeds.query is not None
    return await cache.get_or_compute(
        scope=scope,
        endpoint=ENDPOINT_MEMBERS,
        params={
            "spec": spec.spec_hash(),
            "viewId": read_in if query_seeded else None,
            "boundary": boundary if query_seeded else "",
            "members": include_members,
        },
        compute=compute,
        model_cls=MembershipResult,
        on_stale=on_stale,
        expected_compute_s=budget_s,
    )


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

    The walk is ``member_sets.walk`` — the one a member set takes too, here over
    this request's members: each step walks the nearest unfinished nodes as far as
    the remaining depth allows (25 at most), reads every partner's distance off the
    edges it shipped, and queues whatever the step left unfinished — a node the
    budget cut, the depth boundary, a hub's next page, a container's next page of
    seeds — so the walk completes rather than stopping at the first step's horizon.
    A Narrow answers inside one request, so it pages one hub at most
    ``HUB_PAGES_MAX`` times and one batch's seeds ``SEED_PAGES_MAX`` times, and
    says so (``trace_cap``).
    """
    target = walk.ALL if depth == "all" else int(depth)
    store = walk.DictStore(members, seeds)
    state = walk.new_state()
    hub_pages: Dict[str, int] = {}
    added = 0

    async def call(request):
        run.check()
        async with run.slot():
            return await run.engine.trace_closure(request)

    while not members.full:
        stepped = await walk.step(store, state, direction, target, call)
        if stepped is None:
            break
        added += stepped.joined
        if stepped.gave_up:
            # A step that gave up left lineage unwalked: the answer is incomplete, and says so.
            run.truncate("incomplete", len(store.hops), len(store.hops))
        if stepped.work.kind == "hub":
            hub = stepped.work.anchors[0]
            hub_pages[hub] = hub_pages.get(hub, 0) + 1
            if store.cursors.get(hub) and hub_pages[hub] >= HUB_PAGES_MAX:
                store.cursors[hub] = ""
                run.truncate("trace_cap", len(store.hops), len(store.hops))
        pending = state.get("pending")
        if pending and pending["pages"] >= SEED_PAGES_MAX:
            state["pending"] = None
            run.truncate("trace_cap", len(store.hops), len(store.hops))
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
