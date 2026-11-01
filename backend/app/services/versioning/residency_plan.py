"""The capacity planner (doc 17): what one pass of the capacity loop does, decided from what the
pass read. Pure — no I/O — so the loop (``residency.CapacityLoop``) and the policy preview make
the same decisions from the same inputs.

Per cluster master:

* **idle eviction** — a Standard graph unread for longer than the Standard idle time, a Coldline
  graph for longer than the Coldline idle time;
* **pressure eviction** — a master at or above the start mark evicts the idle-longest Coldline
  graphs, then Standard by oldest read, until its use once they are gone is at or under the stop
  mark;
* never an Always graph, a key the platform did not mint, a graph with a read lease or a pass in
  flight, or one that is not evictable at all (trashed, at genesis, still being enabled); with
  automatic eviction off, nothing;
* **admission** — a load starts when the master has room for its estimate times the headroom
  under the start mark, after what the aggregation write governor and the loads and full
  projections already in flight on it hold; one at a time per master, none while it forks for
  persistence or cannot be read, in the order the loads were asked for. The rest wait;
* **room for a load** — for the first load of a provider that does not fit on the master it would
  go to, nor by room alone on one that holds or takes a load now, room is made on the master it
  would go to, where it falls shortest: its graphs as pressure picks them — Coldline before
  Standard, by oldest read — but none read within the Coldline idle time (it would come straight
  back; so in practice Standard, a Coldline graph unread that long being idle-evicted already), and
  only as many as make the room it lacks beyond what the pass frees there already. That master is
  then the load's: no other load goes there in the pass (``MasterPlan.claimed``). When they could
  not make the room, nothing is evicted, nothing is claimed, and the next such load may have room
  made instead. A pass that could not read sizes makes none.

**Placement** — a load seeds a fresh key, so it goes to the master of the graph's provider with the
most room under its start mark after what is held there (:func:`roomiest`), among those free to
take a load, whichever master its key was on; the loop then picks a key that hashes there. One
that sets no limit ranks after every master whose room is known: it takes a load only when none of
those is free, and a load short of room on one of those waits there, and has room made there. A
graph whose dedicated rollup graph is named from its key keeps the key, and loads back onto its own
master. Loads start in the order they were asked for, per provider: one that does not fit keeps its
place, and a later one that fits elsewhere goes ahead.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from .residency_policy import ResidencyPolicy

@dataclass(frozen=True)
class Master:
    """One cluster master, as the pass read it."""
    endpoint: str
    used: Optional[int]               # used_memory; None when it could not be read
    maxmemory: int                    # 0: the master sets no limit
    hold: Optional[str] = None        # why no load may start on it now ("fork", "loading", ...)
    reserved: int = 0                 # what the aggregation write governor holds on it
    providers: Tuple[str, ...] = ("default",)   # the FalkorDB providers it is reached through


@dataclass(frozen=True)
class Graph:
    """One versioned graph with a key of its own."""
    graph_id: str
    endpoint: str                     # the master its key hashes to
    residency: str
    status: str
    owned: bool = True
    evictable: bool = True            # live, past genesis, its enable finished
    leased: bool = False
    last_read: Optional[datetime] = None      # its last read, else its last projection
    size_bytes: Optional[int] = None          # measured
    entities: Optional[int] = None            # for the estimate, when never measured
    seeding: bool = False             # a load or full projection is writing it into its key
    requested_at: Optional[float] = None      # when its load was first asked for
    provider: str = "default"
    placed: bool = True               # its load goes onto a fresh key on the roomiest master;
                                      # False: back onto its key (a rollup graph is named from it)

    def bytes(self, policy: ResidencyPolicy) -> Optional[int]:
        """Its measured size, else its entities times the bytes per entity; None: unknown."""
        if self.size_bytes is not None:
            return self.size_bytes
        return None if self.entities is None else self.entities * policy.bytes_per_entity


@dataclass(frozen=True)
class Eviction:
    graph_id: str
    endpoint: str
    bytes: Optional[int]              # None: unknown (an idle eviction needs no size)
    reason: str                       # idle_standard | idle_coldline | pressure


@dataclass(frozen=True)
class Load:
    graph_id: str
    endpoint: str
    bytes: int


@dataclass(frozen=True)
class Wait:
    graph_id: str
    endpoint: str
    bytes: Optional[int]
    reason: str                       # capacity | queued | unmeasured | unsized | the master's hold
    shortfall: Optional[int] = None   # for capacity: how much room is missing


@dataclass
class MasterPlan:
    master: Master
    reserved: int                     # the governor's, and the loads and full projections in flight
    used_after: Optional[int]         # its use once this pass's evictions are done
    seeding: bool = False             # a load or full projection is in flight on it
    to_free: int = 0                  # what pressure eviction must free to reach the stop mark
    spare: List[Eviction] = field(default_factory=list)   # the next pressure candidates, in order
    evictions: List[Eviction] = field(default_factory=list)
    loads: List[Load] = field(default_factory=list)
    waits: List[Wait] = field(default_factory=list)
    claimed: bool = False             # room is made here for a waiting load: no other load comes


@dataclass
class Plan:
    masters: List[MasterPlan]

    @property
    def evictions(self) -> List[Eviction]:
        return [e for m in self.masters for e in m.evictions]

    @property
    def loads(self) -> List[Load]:
        return [x for m in self.masters for x in m.loads]

    @property
    def waits(self) -> List[Wait]:
        return [w for m in self.masters for w in m.waits]


def need(graph: Graph, policy: ResidencyPolicy) -> Optional[int]:
    """The room a load of ``graph`` asks for: its estimate times the headroom; None when its size
    is unknown."""
    size = graph.bytes(policy)
    return None if size is None else -(-size * policy.load_margin_pct // 100)


def admit(master: Master, needed: int, policy: ResidencyPolicy,
          reserved: int) -> Tuple[bool, Optional[int]]:
    """Whether ``needed`` bytes fit on ``master`` under its start mark after ``reserved``:
    ``(fits, shortfall)``. A master that sets no limit has nothing to measure against, and fits;
    one that could not be read never does (shortfall None)."""
    if master.used is None:
        return False, None
    if master.maxmemory <= 0:
        return True, 0
    shortfall = master.used + reserved + needed - master.maxmemory * policy.high_water_pct // 100
    return shortfall <= 0, max(0, shortfall)


def room(plan: MasterPlan, policy: ResidencyPolicy) -> Optional[int]:
    """What a master has left under its start mark after what is held there; None when it could
    not be read, or sets no memory limit (its room is unknown)."""
    m = plan.master
    if m.used is None or m.maxmemory <= 0:
        return None
    return m.maxmemory * policy.high_water_pct // 100 - m.used - plan.reserved


def rank(plan: MasterPlan, policy: ResidencyPolicy) -> Tuple[bool, int]:
    """How a read master ranks for a new key or a load, highest first: by its room; one that sets
    no memory limit, whose room is unknown, after every master whose room is known, the least
    used first."""
    r = room(plan, policy)
    return (True, r) if r is not None else (False, -plan.master.used)


def roomiest(plans: Sequence[MasterPlan], policy: ResidencyPolicy) -> Optional[MasterPlan]:
    """The master that ranks highest (the first of equals), of those that could be read."""
    readable = [p for p in plans if p.master.used is not None]
    return max(readable, key=lambda p: rank(p, policy)) if readable else None


def _candidates(graphs: Sequence[Graph]) -> List[Graph]:
    return [g for g in graphs
            if g.status == "idle" and g.owned and g.evictable and not g.leased
            and g.residency in ("standard", "coldline")]


def _plan_master(policy: ResidencyPolicy, master: Master, graphs: Sequence[Graph],
                 now: datetime, sized: bool) -> MasterPlan:
    seeding = [g for g in graphs if g.seeding]
    reserved = master.reserved + sum(need(g, policy) or 0 for g in seeding)
    out = MasterPlan(master=master, reserved=reserved, used_after=master.used,
                     seeding=bool(seeding))
    # A master that cannot be read, or is replaying its dataset, would fail the drop and keep the
    # key in memory while its graph reads evicted: nothing is evicted there.
    if policy.eviction_enabled and master.used is not None and master.hold != "loading":
        idle_for = {"standard": timedelta(seconds=policy.standard_idle_secs),
                    "coldline": timedelta(seconds=policy.coldline_idle_secs)}
        left = []
        for g in _candidates(graphs):
            if g.last_read is not None and now - g.last_read > idle_for[g.residency]:
                out.evictions.append(Eviction(g.graph_id, master.endpoint, g.bytes(policy),
                                              f"idle_{g.residency}"))
            else:
                left.append(g)
        freed = sum(e.bytes or 0 for e in out.evictions)
        if sized and master.used is not None and master.maxmemory > 0 \
                and master.used * 100 >= master.maxmemory * policy.high_water_pct:
            stop = master.maxmemory * policy.low_water_pct // 100
            out.to_free = max(0, master.used - stop)
            # No read on record sorts as read now: its idle clock has not started. A graph of
            # unknown size is no candidate: its eviction would count as freeing nothing. Those
            # past the stop mark are kept, in order, for the pass to make up a refusal with.
            for g in sorted((g for g in left if g.bytes(policy) is not None),
                            key=lambda g: (g.residency != "coldline", g.last_read or now)):
                e = Eviction(g.graph_id, master.endpoint, g.bytes(policy), "pressure")
                if master.used - freed <= stop:
                    out.spare.append(e)
                    continue
                out.evictions.append(e)
                freed += g.bytes(policy)
        if master.used is not None:
            out.used_after = master.used - freed
    return out


def _make_room(policy: ResidencyPolicy, at: MasterPlan, graphs: Sequence[Graph], shortfall: int,
               now: datetime) -> bool:
    """Room on ``at`` for a load that lacks ``shortfall`` bytes there (see the module's room for a
    load): pressure evictions of its own, added to the master's. Whether the room is made — by
    them, or by what the pass frees there already; False, evicting nothing, when they could not."""
    m = at.master
    if not policy.eviction_enabled or m.used is None or m.hold == "loading":
        return False
    lacking = shortfall - (m.used - (at.used_after if at.used_after is not None else m.used))
    if lacking <= 0:
        return True                            # this pass's evictions there make it already
    planned = {e.graph_id for e in at.evictions}
    quiet = timedelta(seconds=policy.coldline_idle_secs)
    picks: List[Eviction] = []
    for g in sorted((g for g in _candidates(graphs)
                     if g.graph_id not in planned and g.bytes(policy) is not None
                     and g.last_read is not None and now - g.last_read > quiet),
                    key=lambda g: (g.residency != "coldline", g.last_read)):
        if lacking <= 0:
            break
        picks.append(Eviction(g.graph_id, m.endpoint, g.bytes(policy), "pressure"))
        lacking -= g.bytes(policy)
    if lacking > 0:
        return False
    taken = {e.graph_id for e in picks}
    at.spare = [e for e in at.spare if e.graph_id not in taken]
    at.evictions.extend(picks)
    at.used_after = (at.used_after if at.used_after is not None else m.used) - sum(
        e.bytes for e in picks)
    return True


def _plan_loads(policy: ResidencyPolicy, plans: Sequence[MasterPlan],
                graphs: Sequence[Graph], now: datetime, sized: bool) -> None:
    """The loads asked for, in the order they were asked for: each onto the roomiest master free
    to take one (see the module's placement), or a wait. One that fits on a master by room alone,
    which holds or takes a load now, waits for it. For the first of a provider's that fits on
    neither, room is made on the roomiest free one (:func:`_make_room`), which it then keeps: no
    later load goes there in this pass. Later loads that fit elsewhere go ahead."""
    by_endpoint = {p.master.endpoint: p for p in plans}
    on: Dict[str, List[Graph]] = {}
    for g in graphs:
        on.setdefault(g.endpoint, []).append(g)
    busy = {p.master.endpoint for p in plans if p.seeding}      # one load per master at a time
    heads = set()                              # the providers whose first load waits for room
    asked = sorted((g for g in graphs
                    if g.requested_at is not None and g.status in ("evicted", "waiting_capacity")),
                   key=lambda g: g.requested_at)
    for g in asked:
        pool = ([p for p in plans if g.provider in p.master.providers] if g.placed
                else [by_endpoint[g.endpoint]])
        readable = [p for p in pool if p.master.used is not None]
        free = [p for p in readable if p.master.endpoint not in busy and not p.master.hold]
        target, reason, shortfall = roomiest(free, policy), None, None
        if need(g, policy) is None:
            reason = "unsized"                 # admitted only with a size or an estimate
        elif not readable:
            reason = "unmeasured"
        elif target is None:
            held = [p.master.hold for p in readable if p.master.endpoint not in busy]
            reason = held[0] if held else "queued"
        else:
            fits, shortfall = admit(target.master, need(g, policy), policy, target.reserved)
            reason = None if fits else "capacity"
        at = target or roomiest(readable, policy) or by_endpoint[g.endpoint]
        if reason is None:
            at.loads.append(Load(g.graph_id, at.master.endpoint, g.bytes(policy)))
            busy.add(at.master.endpoint)
            continue
        if reason == "capacity":
            # Room alone would let it in on a master that holds or takes a load now: it waits for
            # that one, and nothing is evicted for it elsewhere. (A free master it fits on ranks
            # below the target only when it sets no limit: that one is not waited for.)
            later = roomiest([p for p in readable if p not in free
                              and admit(p.master, need(g, policy), policy, p.reserved)[0]], policy)
            if later is not None:
                at, reason = later, later.master.hold or "queued"
            elif (sized and g.provider not in heads
                  and _make_room(policy, target, on.get(target.master.endpoint, []), shortfall,
                                 now)):
                heads.add(g.provider)
                target.claimed = True
                busy.add(target.master.endpoint)
        at.waits.append(Wait(g.graph_id, at.master.endpoint, g.bytes(policy), reason,
                             shortfall if reason == "capacity" else None))


def plan(policy: ResidencyPolicy, masters: Sequence[Master], graphs: Sequence[Graph],
         now: datetime, *, sized: bool = True) -> Plan:
    """One pass's decisions: per master (in the order given, then any a graph names that was not
    read, which counts as unreadable), its evictions, the loads it starts and the loads that
    wait there. ``sized`` False — the pass could not read the graphs' sizes — plans no pressure
    eviction."""
    by_master: Dict[str, List[Graph]] = {}
    for g in graphs:
        by_master.setdefault(g.endpoint, []).append(g)
    known = {m.endpoint for m in masters}
    unread = [Master(endpoint=e, used=None, maxmemory=0, providers=(gs[0].provider,))
              for e, gs in by_master.items() if e not in known]
    plans = [_plan_master(policy, m, by_master.get(m.endpoint, []), now, sized)
             for m in [*masters, *unread]]
    _plan_loads(policy, plans, graphs, now, sized)
    return Plan(masters=plans)
