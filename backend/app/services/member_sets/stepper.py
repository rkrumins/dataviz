"""Moving a member set on — a step at a time, by whichever request holds its lease.

A set is resolved in the order a Narrow resolves (``view_membership.resolve_membership``),
so every member joins for the same first reason (``via``):

    seeds → inside → upstream → downstream → partnerInside → done

* **seeds** — URN seeds checked to exist, ``READ_BATCH`` a step; a query seed's every
  match, a search page a step (``view_membership_search.make_seed_pages``) — no seed
  cap. A cursor that no longer reads starts the seeds again, which is safe: a member
  is added once however often it is found.
* **inside** / **partnerInside** — what is inside the seeds (then the sources and
  consumers found): up to ``ROOTS_PER_STEP`` members a step, one page of
  ``DESCENDANTS_PAGE`` each, ``DESCENDANTS_CONCURRENCY`` at once; a member with more
  continues on the next step. A member the graph counts nothing inside is never read
  (one count per ``READ_BATCH`` members, a step of its own). "Everything inside" is
  never listed (``whole``).
* **upstream** / **downstream** — the lineage walk (``walk``), a closure step a step:
  a hub's page and a container seed's page of contents are each a step of their own,
  so a set has no page caps (a Narrow's ``HUB_PAGES_MAX`` / ``SEED_PAGES_MAX``). With
  ``partnerHosts``, the tables the partners sit in join as partners too (and, with
  ``partnerLineage``, are walked).

Each step is at most one graph call (a stage's few pages in one batch) and one short
transaction, committed through the fence (``store.commit_step``). Limits are said,
never silent: ``member_cap`` and ``edge_cap`` past ``MEMBER_SET_MAX_MEMBERS`` /
``MEMBER_SET_MAX_EDGES``, ``deadline`` past ``MEMBER_SET_MAX_DURATION_S`` since the
set started, ``incomplete`` where a step gave up.

A request that finds the lease held waits on the holder's steps holding nothing
(``graph_waits.waiting``), takes the set over if the holder lets go or its lease
runs out, and answers with how far the set has got when its own wait is spent.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import MemberSetORM
from backend.app.db.repositories.view_membership_repo import later_iso, now_iso
from backend.app.services import graph_waits
from backend.app.services.member_sets import store as sets
from backend.app.services.member_sets import walk
from backend.common.models.graph import NodeQuery
from backend.common.models.view_membership import MembershipCounts, MembershipSpec

#: Members one set may hold; past it the set is complete and says ``member_cap``.
MEMBER_SET_MAX_MEMBERS: int = int(os.getenv("MEMBER_SET_MAX_MEMBERS", "1000000"))
#: Lineage relationships one set keeps; past it its members go on, and it says ``edge_cap``.
MEMBER_SET_MAX_EDGES: int = int(os.getenv("MEMBER_SET_MAX_EDGES", "2000000"))
#: How long one set may take, from its first step; past it the set is complete and says ``deadline``.
MEMBER_SET_MAX_DURATION_S: float = float(os.getenv("MEMBER_SET_MAX_DURATION_S", "7200"))
#: How long a complete set is kept to be read and downloaded.
MEMBER_SET_TTL_HOURS: float = float(os.getenv("MEMBER_SET_TTL_HOURS", "24"))

#: URNs one existence check reads.
READ_BATCH = 1_000
#: Descendants per page; members whose insides one step reads, and how many at once.
DESCENDANTS_PAGE = 1_000
ROOTS_PER_STEP = 32
DESCENDANTS_CONCURRENCY = 4
#: Times a query seed's search may start again (its cursor stopped reading) before it is refused.
SEARCH_RESTARTS = 3
#: How often a request waiting on another's steps looks at the set.
POLL_S = 0.25

_ORDER = ("seeds", "inside", "upstream", "downstream", "partnerInside", "done")

Admit = Optional[Callable[[], Any]]
#: A query seed's search, a page a call: (cursor, session id) → ``SeedPage``.
SeedPages = Callable[[Optional[str], Optional[str]], Awaitable[Any]]


class _Step:
    """One step's view of the set: what it read, and what it will record."""

    def __init__(self, session: AsyncSession, ms: MemberSetORM, engine, admit: Admit,
                 seed_pages: Optional[SeedPages]):
        self.session = session
        self.ms = ms
        self.engine = engine
        self.admit = admit
        self.seed_pages = seed_pages
        self.spec = MembershipSpec.model_validate(json.loads(ms.spec))
        self.state: Dict[str, Any] = sets.loads(ms.state, {})
        self.counts = MembershipCounts.model_validate(sets.loads(ms.counts, {}))
        self.truncated: Dict[str, dict] = {t["reason"]: t for t in sets.loads(ms.truncated, [])}
        self.store = sets.SqlWalkStore(session, ms, member_cap=MEMBER_SET_MAX_MEMBERS,
                                       edge_cap=MEMBER_SET_MAX_EDGES)
        self.stage = ms.stage

    def slot(self):
        return self.admit() if self.admit is not None else nullcontext()

    async def unhold(self) -> None:
        """End the read transaction before a graph call: nothing is held across it."""
        await self.session.commit()

    def truncate(self, reason: str, seen: int, limit: int) -> None:
        # One entry per reason, keeping the largest count seen.
        prior = self.truncated.get(reason)
        if prior is None or seen > prior["seen"]:
            self.truncated[reason] = {"reason": reason, "seen": seen, "limit": limit}

    def next_stage(self) -> None:
        self.stage = _ORDER[_ORDER.index(self.stage) + 1]
        for part in ("desc", "walk"):
            self.state.pop(part, None)


async def drive(session: AsyncSession, set_id: str, engine, *, owner: str, wait_s: float,
                admit: Admit = None, seed_pages: Optional[SeedPages] = None) -> None:
    """Move the set on for up to ``wait_s``: step it while this request holds its lease,
    wait on the holder's steps (holding nothing) while another does."""
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        outcome = await advance(session, set_id, engine, owner=owner,
                                wait_s=deadline - time.monotonic(), admit=admit, seed_pages=seed_pages)
        if outcome in ("done", "spent"):
            return
        if not await _wait_for_turn(session, set_id, deadline):
            return


async def advance(session: AsyncSession, set_id: str, engine, *, owner: str, wait_s: float,
                  admit: Admit = None, seed_pages: Optional[SeedPages] = None) -> str:
    """Take the set's next steps until ``wait_s`` is spent: ``done`` (it is no longer
    running), ``spent``, ``held`` (another request holds it) or ``lost`` (another
    took it over mid-step: that step was rolled back). A step is started only while
    one as long as they have taken, and half again, still fits: the request answers
    inside its wait, not a step past it."""
    deadline = time.monotonic() + wait_s
    if not await sets.take_lease(session, set_id, owner):
        ms = await sets.get(session, set_id)
        await session.commit()
        return "done" if ms is None or ms.status != "running" else "held"
    took = 0.0
    try:
        while True:
            ms = await sets.get(session, set_id)
            if ms is None or ms.status != "running":
                return "done"
            started = time.monotonic()
            if started + 1.5 * took >= deadline:
                return "spent"
            if not await _one_step(session, ms, engine, owner, admit, seed_pages):
                return "lost"
            step_s = time.monotonic() - started
            took = step_s if not took else 0.7 * took + 0.3 * step_s
    finally:
        await sets.release_lease(session, set_id, owner)


async def _wait_for_turn(session: AsyncSession, set_id: str, deadline: float) -> bool:
    """Wait while another request steps the set — its admission and connection given
    back — until it lets go or its lease runs out (True: take a turn), or the set is
    finished or this request's wait spent (False: answer)."""
    async with graph_waits.waiting():
        while time.monotonic() < deadline:
            await asyncio.sleep(min(POLL_S, max(0.0, deadline - time.monotonic())))
            ms = await sets.get(session, set_id)
            await session.commit()
            if ms is None or ms.status != "running":
                return False
            if ms.lease_owner is None or (ms.lease_until or "") < now_iso():
                return True
    return False


async def _one_step(session: AsyncSession, ms: MemberSetORM, engine, owner: str, admit: Admit,
                    seed_pages: Optional[SeedPages]) -> bool:
    """One step, recorded through the fence. False when the fence refused it."""
    step = _Step(session, ms, engine, admit, seed_pages)
    expected = ms.step
    try:
        if _elapsed_s(ms) > MEMBER_SET_MAX_DURATION_S:
            step.truncate("deadline", step.store.member_count, step.store.member_count)
            step.stage = "done"
        else:
            await _STAGES[step.stage](step)
        if step.store.full:
            step.truncate("member_cap", step.store.member_count + step.store.refused, MEMBER_SET_MAX_MEMBERS)
            step.stage = "done"
        if step.store.edges_seen:
            step.truncate("edge_cap", step.store.edges_seen, MEMBER_SET_MAX_EDGES)
        step.counts.total = step.store.member_count
        values: Dict[str, Any] = dict(
            stage=step.stage, state=json.dumps(step.state),
            counts=json.dumps(step.counts.model_dump(by_alias=True)),
            truncated=json.dumps(sorted(step.truncated.values(), key=lambda t: t["reason"])),
            member_count=step.store.member_count, edge_count=step.store.edge_count,
            next_seq=step.store.next_seq, expires_at=later_iso(sets.IDLE_S),
        )
        if step.stage == "done":
            values.update(status="complete", completed_at=now_iso(),
                          expires_at=later_iso(MEMBER_SET_TTL_HOURS * 3600))
        if not await sets.commit_step(session, ms.id, owner, expected, **values):
            await session.rollback()
            return False
        await session.commit()
        return True
    except (NotImplementedError, ValueError) as exc:
        # The graph cannot answer this question (a provider without the walk, a query
        # it refuses): asking again will not help. Said on the set, then raised for
        # the route to answer.
        await session.rollback()
        await _fail(session, ms.id, owner, expected, str(exc) or type(exc).__name__)
        raise
    except BaseException:
        await session.rollback()
        raise


async def _fail(session: AsyncSession, set_id: str, owner: str, expected: int, error: str) -> None:
    if await sets.commit_step(session, set_id, owner, expected, status="failed", error=error[:2000],
                              expires_at=later_iso(sets.IDLE_S)):
        await session.commit()
    else:
        await session.rollback()


def _elapsed_s(ms: MemberSetORM) -> float:
    try:
        started = datetime.fromisoformat(ms.created_at)
    except (TypeError, ValueError):
        return 0.0
    return (datetime.now(timezone.utc) - started).total_seconds()


# ── Stages ──────────────────────────────────────────────────────────────────


async def _seeds(step: _Step) -> None:
    if step.spec.seeds.urns is not None:
        await _urn_seeds(step)
    else:
        await _query_seeds(step)
    step.counts.seeds = step.store.member_count


async def _urn_seeds(step: _Step) -> None:
    """The next ``READ_BATCH`` seeds, checked to exist: a seed that names nothing is
    counted (``missing``), not walked."""
    urns = step.spec.canonical().seeds.urns or []
    offset = int(step.state.get("offset") or 0)
    batch = urns[offset:offset + READ_BATCH]
    if batch:
        await step.unhold()
        async with step.slot():
            nodes = await step.engine.get_nodes_query(
                NodeQuery(urns=batch, limit=len(batch), include_child_count=False))
        by_urn = {n.urn: n for n in nodes}
        await step.store.add_members("seed", [(u, u, by_urn[u]) for u in batch if u in by_urn])
        step.state["missing"] = int(step.state.get("missing") or 0) + sum(1 for u in batch if u not in by_urn)
    step.state["offset"] = offset + len(batch)
    if step.state["offset"] >= len(urns):
        step.next_stage()


async def _query_seeds(step: _Step) -> None:
    """One page of the query's matches. A search still running is moved on; a
    cursor that no longer reads starts the seeds again."""
    if step.seed_pages is None:
        raise ValueError("a query seed needs a search to run it")
    search = step.state.get("search") or {}
    await step.unhold()
    page = await step.seed_pages(search.get("cursor"), search.get("session"))
    if page.restart:
        restarts = int(search.get("restarts") or 0) + 1
        if restarts > SEARCH_RESTARTS:
            raise ValueError("the query's results kept changing while its seeds were read")
        step.state["search"] = {"restarts": restarts}
        return
    if page.nodes is None:
        step.state["search"] = {**search, "session": page.session_id}
        return
    await step.store.add_members("seed", [(n.urn, n.urn, n) for n in page.nodes])
    if page.cursor:
        step.state["search"] = {"cursor": page.cursor, "restarts": search.get("restarts") or 0}
        return
    if page.truncated:
        seeds = step.store.member_count
        step.truncate("seed_cap", seeds + 1, seeds)
    step.next_stage()


async def _inside(step: _Step) -> None:
    children = step.spec.expand.children
    if children == "all":
        await step.store.mark_whole(["seed"])
        step.counts.inside = None
        step.next_stage()
    elif not children:
        step.next_stage()
    elif await _descendants(step, ["seed"], int(children), "inside"):
        step.next_stage()


async def _partner_inside(step: _Step) -> None:
    children = step.spec.expand.partner_children
    if children == "all":
        await step.store.mark_whole(["upstream", "downstream"])
        step.counts.partner_inside = None
        step.next_stage()
    elif not children:
        step.next_stage()
    elif await _descendants(step, ["upstream", "downstream"], int(children), "partnerInside"):
        step.next_stage()


async def _descendants(step: _Step, roots_via: List[str], depth: int, via: str) -> bool:
    """One page of what is inside up to ``ROOTS_PER_STEP`` members. True when there
    is nothing left to read. Members are taken ``READ_BATCH`` at a time, and those
    the graph counts nothing inside (a trace's columns) are never read: that count
    is a step of its own."""
    progress = step.state.setdefault("desc", {"after": -1, "open": []})
    open_roots: List[list] = progress["open"]
    if len(open_roots) < ROOTS_PER_STEP:
        more = await step.store.roots(roots_via, progress["after"], READ_BATCH)
        if more:
            progress["after"] = more[-1][1]
            open_roots += await _holding(step, more)
            return False
    if not open_roots:
        return True
    reading, rest = open_roots[:ROOTS_PER_STEP], open_roots[ROOTS_PER_STEP:]
    await step.unhold()
    gate = asyncio.Semaphore(DESCENDANTS_CONCURRENCY)

    async def page(root: str, offset: int):
        async with gate:
            async with step.slot():
                return await step.engine.get_descendants(root, depth=depth, limit=DESCENDANTS_PAGE,
                                                         offset=offset)

    # Every read settles before an error is raised: none is left running unobserved.
    pages = await asyncio.gather(*(page(r, o) for r, o, _ in reading), return_exceptions=True)
    for got in pages:
        if isinstance(got, BaseException):
            raise got
    found, still = [], []
    for (root, offset, origin), nodes in zip(reading, pages):
        found += [(n.urn, origin or root, n) for n in nodes]
        if len(nodes) >= DESCENDANTS_PAGE:
            still.append([root, offset + DESCENDANTS_PAGE, origin])
    joined = await step.store.add_members(via, found)
    if via == "inside":
        step.counts.inside = (step.counts.inside or 0) + joined
    else:
        step.counts.partner_inside = (step.counts.partner_inside or 0) + joined
    progress["open"] = still + rest
    return False


async def _holding(step: _Step, roots: List[tuple]) -> List[list]:
    """Of ``roots`` (``(urn, seq, origin)``), as open roots, those the graph does not
    count empty: a count of 0 is skipped, no count is read anyway."""
    await step.unhold()
    async with step.slot():
        nodes = await step.engine.get_nodes_query(
            NodeQuery(urns=[u for u, _, _ in roots], limit=len(roots), include_child_count=True))
    empty = {n.urn for n in nodes if n.child_count == 0}
    return [[urn, 0, origin] for urn, _seq, origin in roots if urn not in empty]


def _lineage(direction: str):
    async def stage(step: _Step) -> None:
        depth = getattr(step.spec.expand, direction)
        if not depth:
            step.next_stage()
            return
        state = step.state.get("walk")
        if state is None:
            await step.store.start_walk(direction)
            step.state["walk"] = walk.new_state()
            return
        target = walk.ALL if depth == "all" else int(depth)
        expand = step.spec.expand
        is_leaf = await walk.leaf_rule(step.engine) if expand.partner_hosts else None

        async def call(request):
            await step.unhold()
            async with step.slot():
                return await step.engine.trace_closure(request)

        stepped = await walk.step(step.store, state, direction, target, call, edges=step.store.include_edges,
                                  is_leaf=is_leaf, walk_hosts=bool(expand.partner_lineage))
        if stepped is None:
            step.next_stage()
            return
        setattr(step.counts, direction, getattr(step.counts, direction) + stepped.joined)
        if stepped.gave_up:
            step.truncate("incomplete", step.store.member_count, step.store.member_count)
    return stage


async def _done(step: _Step) -> None:
    return None


_STAGES = {
    "seeds": _seeds,
    "inside": _inside,
    "upstream": _lineage("upstream"),
    "downstream": _lineage("downstream"),
    "partnerInside": _partner_inside,
    "done": _done,
}
