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
  persistence or cannot be read, in the order the loads were asked for. The rest wait.

**Placement** — a load seeds a fresh key, so it goes to the master of the graph's provider with the
most room under its start mark after what is held there (:func:`roomiest`), among those free to
take a load, whichever master its key was on; the loop then picks a key that hashes there. A graph
whose dedicated rollup graph is named from its key keeps the key, and loads back onto its own
master. Loads start in the order they were asked for, per provider: when the first does not fit,
the rest wait their turn.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from .residency_policy import ResidencyPolicy

#: The room of a master that sets no memory limit: more than any that does.
_UNLIMITED = 1 << 62


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

    def bytes(self, policy: ResidencyPolicy) -> int:
        if self.size_bytes is not None:
            return self.size_bytes
        return (self.entities or 0) * policy.bytes_per_entity


@dataclass(frozen=True)
class Eviction:
    graph_id: str
    endpoint: str
    bytes: int
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
    bytes: int
    reason: str                       # capacity | queued | unmeasured | the master's hold
    shortfall: Optional[int] = None   # for capacity: how much room is missing


@dataclass
class MasterPlan:
    master: Master
    reserved: int                     # the governor's, and the loads and full projections in flight
    used_after: Optional[int]         # its use once this pass's evictions are done
    seeding: bool = False             # a load or full projection is in flight on it
    evictions: List[Eviction] = field(default_factory=list)
    loads: List[Load] = field(default_factory=list)
    waits: List[Wait] = field(default_factory=list)


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


def need(graph: Graph, policy: ResidencyPolicy) -> int:
    """The room a load of ``graph`` asks for: its estimate times the headroom."""
    return -(-graph.bytes(policy) * policy.load_margin_pct // 100)


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
    not be read."""
    m = plan.master
    if m.used is None:
        return None
    mark = m.maxmemory * policy.high_water_pct // 100 if m.maxmemory > 0 else _UNLIMITED
    return mark - m.used - plan.reserved


def roomiest(plans: Sequence[MasterPlan], policy: ResidencyPolicy) -> Optional[MasterPlan]:
    """The master with the most room (the first of equals), of those that could be read."""
    readable = [p for p in plans if p.master.used is not None]
    return max(readable, key=lambda p: room(p, policy)) if readable else None


def _candidates(graphs: Sequence[Graph]) -> List[Graph]:
    return [g for g in graphs
            if g.status == "idle" and g.owned and g.evictable and not g.leased
            and g.residency in ("standard", "coldline")]


def _plan_master(policy: ResidencyPolicy, master: Master, graphs: Sequence[Graph],
                 now: datetime) -> MasterPlan:
    seeding = [g for g in graphs if g.seeding]
    reserved = master.reserved + sum(need(g, policy) for g in seeding)
    out = MasterPlan(master=master, reserved=reserved, used_after=master.used,
                     seeding=bool(seeding))
    if policy.eviction_enabled:
        idle_for = {"standard": timedelta(seconds=policy.standard_idle_secs),
                    "coldline": timedelta(seconds=policy.coldline_idle_secs)}
        left = []
        for g in _candidates(graphs):
            if g.last_read is not None and now - g.last_read > idle_for[g.residency]:
                out.evictions.append(Eviction(g.graph_id, master.endpoint, g.bytes(policy),
                                              f"idle_{g.residency}"))
            else:
                left.append(g)
        freed = sum(e.bytes for e in out.evictions)
        if master.used is not None and master.maxmemory > 0 \
                and master.used * 100 >= master.maxmemory * policy.high_water_pct:
            stop = master.maxmemory * policy.low_water_pct // 100
            # No read on record sorts as read now: its idle clock has not started.
            for g in sorted(left, key=lambda g: (g.residency != "coldline", g.last_read or now)):
                if master.used - freed <= stop:
                    break
                out.evictions.append(Eviction(g.graph_id, master.endpoint, g.bytes(policy),
                                              "pressure"))
                freed += g.bytes(policy)
        if master.used is not None:
            out.used_after = master.used - freed
    return out


def _plan_loads(policy: ResidencyPolicy, plans: Sequence[MasterPlan],
                graphs: Sequence[Graph]) -> None:
    """The loads asked for, in the order they were asked for: each onto the roomiest master free
    to take one (see the module's placement), or a wait, and once one waits for room the rest of
    its provider's wait their turn."""
    by_endpoint = {p.master.endpoint: p for p in plans}
    busy = {p.master.endpoint for p in plans if p.seeding}      # one load per master at a time
    blocked = set()
    asked = sorted((g for g in graphs
                    if g.requested_at is not None and g.status in ("evicted", "waiting_capacity")),
                   key=lambda g: g.requested_at)
    for g in asked:
        pool = ([p for p in plans if g.provider in p.master.providers] if g.placed
                else [by_endpoint[g.endpoint]])
        readable = [p for p in pool if p.master.used is not None]
        free = [p for p in readable if p.master.endpoint not in busy and not p.master.hold]
        target, reason, shortfall = roomiest(free, policy), None, None
        if g.provider in blocked:
            reason = "queued"                  # the first in line waits for room
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
            blocked.add(g.provider)
        at.waits.append(Wait(g.graph_id, at.master.endpoint, g.bytes(policy), reason,
                             shortfall if reason == "capacity" else None))


def plan(policy: ResidencyPolicy, masters: Sequence[Master], graphs: Sequence[Graph],
         now: datetime) -> Plan:
    """One pass's decisions: per master (in the order given, then any a graph names that was not
    read, which counts as unreadable), its evictions, the loads it starts and the loads that
    wait there."""
    by_master: Dict[str, List[Graph]] = {}
    for g in graphs:
        by_master.setdefault(g.endpoint, []).append(g)
    known = {m.endpoint for m in masters}
    unread = [Master(endpoint=e, used=None, maxmemory=0, providers=(gs[0].provider,))
              for e, gs in by_master.items() if e not in known]
    plans = [_plan_master(policy, m, by_master.get(m.endpoint, []), now)
             for m in [*masters, *unread]]
    _plan_loads(policy, plans, graphs)
    return Plan(masters=plans)
