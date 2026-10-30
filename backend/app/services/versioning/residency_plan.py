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


def _candidates(graphs: Sequence[Graph]) -> List[Graph]:
    return [g for g in graphs
            if g.status == "idle" and g.owned and g.evictable and not g.leased
            and g.residency in ("standard", "coldline")]


def _plan_master(policy: ResidencyPolicy, master: Master, graphs: Sequence[Graph],
                 now: datetime) -> MasterPlan:
    seeding = [g for g in graphs if g.seeding]
    reserved = master.reserved + sum(need(g, policy) for g in seeding)
    out = MasterPlan(master=master, reserved=reserved, used_after=master.used)
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
            oldest = datetime.min.replace(tzinfo=now.tzinfo)
            for g in sorted(left, key=lambda g: (g.residency != "coldline", g.last_read or oldest)):
                if master.used - freed <= stop:
                    break
                out.evictions.append(Eviction(g.graph_id, master.endpoint, g.bytes(policy),
                                              "pressure"))
                freed += g.bytes(policy)
        if master.used is not None:
            out.used_after = master.used - freed
    asked = sorted((g for g in graphs
                    if g.requested_at is not None and g.status in ("evicted", "waiting_capacity")),
                   key=lambda g: g.requested_at)
    for i, g in enumerate(asked):
        reason, shortfall = None, None
        if i > 0 or seeding:
            reason = "queued"                  # one load per master at a time
        elif master.used is None:
            reason = "unmeasured"
        elif master.hold:
            reason = master.hold
        else:
            fits, shortfall = admit(master, need(g, policy), policy, reserved)
            reason = None if fits else "capacity"
        if reason is None:
            out.loads.append(Load(g.graph_id, master.endpoint, g.bytes(policy)))
        else:
            out.waits.append(Wait(g.graph_id, master.endpoint, g.bytes(policy), reason,
                                  shortfall if reason == "capacity" else None))
    return out


def plan(policy: ResidencyPolicy, masters: Sequence[Master], graphs: Sequence[Graph],
         now: datetime) -> Plan:
    """One pass's decisions: per master (in the order given, then any a graph names that was not
    read, which counts as unreadable), its evictions, the load it starts and the loads that
    wait."""
    by_master: Dict[str, List[Graph]] = {}
    for g in graphs:
        by_master.setdefault(g.endpoint, []).append(g)
    known = {m.endpoint for m in masters}
    unread = [Master(endpoint=e, used=None, maxmemory=0) for e in by_master if e not in known]
    return Plan(masters=[_plan_master(policy, m, by_master.get(m.endpoint, []), now)
                         for m in [*masters, *unread]])
