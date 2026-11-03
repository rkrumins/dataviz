"""Resolved sources → the entries of a view made from a query.

A curated view admits an entity only through its own assignment entry, or from a
parent whose entry cascades (``inheritsChildren``). So the view holds exactly its
members:

* each member gets an entry — ``inheritsChildren: true`` when its whole inside is
  in scope, else ``false``, so its other children stay out;
* with ``nest``, the containers on a member's path get entries too (cascading
  nothing), so the canvas draws the member where it lives, not loose in a column.

Where each entry goes is decided, in order, by: where a person put it
(``overrides``) > the layer its source names > where it already is (unless the
layout re-stages) > the layout's own rule (the placer) > for a member, its nearest
drawn container's layer, then the fallback layer. A container nothing places is
left out — its members are drawn without it.

Pure and deterministic: the same inputs give the same entries, and planning again
over its own answer changes nothing. Entries people placed themselves ("Always
include") are never touched; an entry the server owns is marked
``assignedBy: "query"``.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from backend.app.services.view_placement import NodeFacts, PlacementSpec, place_all
from backend.common.models.view_membership import MACHINE, MembershipResult, MembershipSource


@dataclass(frozen=True)
class Candidate:
    """An entity the view should hold: a member, or a container drawn around one."""
    urn: str
    member: bool
    whole: bool = False
    via: Optional[str] = None
    hops: Optional[int] = None
    source_layer: Optional[str] = None
    chain: Tuple[str, ...] = ()       # containers, parent first


def candidates(
    results: Sequence[Tuple[MembershipSource, MembershipResult]],
    *,
    nest: bool,
    exclude: Iterable[str] = (),
) -> Dict[str, Candidate]:
    """The members of every source (the first source to name one gives its reason;
    a member is whole when any source says so), less what is excluded, plus — with
    ``nest`` — the containers on each member's path."""
    out: Dict[str, Candidate] = {}
    left_out = set(exclude)
    for source, result in results:
        whole = set(result.whole_subtree)
        for m in result.members:
            if m.urn in left_out:
                continue
            prev = out.get(m.urn)
            if prev is None:
                out[m.urn] = Candidate(m.urn, True, m.urn in whole, m.via, m.hops, source.layer_id,
                                       tuple(result.chains.get(m.urn, ())))
            elif m.urn in whole and not prev.whole:
                out[m.urn] = replace(prev, whole=True)
    if nest:
        for c in [c for c in out.values() if c.member]:
            for i, a in enumerate(c.chain):
                if a in left_out:
                    break       # an excluded container: what is inside it is drawn without it
                if a not in out:
                    out[a] = Candidate(a, False, chain=c.chain[i + 1:])
    return out


# ── Placers: candidate → the layer the layout puts it in (None: no opinion) ──

Placer = Callable[[Mapping[str, Candidate]], Dict[str, Optional[str]]]


def _parents(cands: Mapping[str, Candidate]) -> Dict[str, List[str]]:
    parents: Dict[str, Set[str]] = {}
    for c in cands.values():
        path = (c.urn, *c.chain)
        for child, parent in zip(path, path[1:]):
            parents.setdefault(child, set()).add(parent)
    return {u: sorted(ps) for u, ps in parents.items()}


def _universe(cands: Mapping[str, Candidate], facts: Mapping[str, NodeFacts]) -> Dict[str, NodeFacts]:
    """Facts for every candidate and every container above one — the containers
    carry the placement the candidates inherit."""
    urns: Set[str] = set()
    for c in cands.values():
        urns.add(c.urn)
        urns.update(c.chain)
    return {u: facts.get(u) or NodeFacts(urn=u) for u in urns}


def source_placer(source_config: dict, link: Mapping[str, str], facts: Mapping[str, NodeFacts]) -> Placer:
    """Where the view it was made from places each entity, in this view's copy of
    that layer. Outside that view's own placements (a curated view stops at what
    it holds) its layers' rules decide, as in an open view."""
    spec = PlacementSpec.from_config(source_config)

    def place(cands: Mapping[str, Candidate]) -> Dict[str, Optional[str]]:
        universe, parents = _universe(cands, facts), _parents(cands)
        placed = place_all(spec, universe, parents)
        if spec.scope == "curated" and any(not placed[u].member for u in cands):
            opened = place_all(spec.with_scope("all"), universe, parents)
            placed = {u: (p if p.member else opened[u]) for u, p in placed.items()}
        return {u: link.get(placed[u].layer_id) if placed[u].member else None for u in cands}

    return place


def rules_placer(layers: List[dict], facts: Mapping[str, NodeFacts]) -> Placer:
    """Where this view's own layer rules place each entity, as in an open view."""
    spec = PlacementSpec.from_config(
        {"layout": {"referenceLayout": {"layers": layers}}, "content": {"entityScope": "all"}})

    def place(cands: Mapping[str, Candidate]) -> Dict[str, Optional[str]]:
        placed = place_all(spec, _universe(cands, facts), _parents(cands))
        return {u: placed[u].layer_id if placed[u].member else None for u in cands}

    return place


def auto_placer(type_layers: Mapping[str, str], facts: Mapping[str, NodeFacts]) -> Placer:
    """By top-level type: each entity in the layer of the type at the top of its path."""
    def place(cands: Mapping[str, Candidate]) -> Dict[str, Optional[str]]:
        out: Dict[str, Optional[str]] = {}
        for u, c in cands.items():
            top = facts.get(c.chain[-1] if c.chain else u)
            out[u] = type_layers.get((top.entity_type if top else "").lower())
        return out

    return place


def _stage(c: Candidate, cands: Mapping[str, Candidate]) -> Optional[str]:
    if c.via in ("seed", "inside"):
        return "stage-seed"
    if c.via in ("upstream", "downstream"):
        side = "up" if c.via == "upstream" else "down"
        return f"stage-{side}{1 if (c.hops or 1) <= 1 else 2}"
    if c.via == "partnerInside":
        # In the stage of the source or consumer it sits inside.
        for a in c.chain:
            p = cands.get(a)
            if p is not None and p.member and p.via in ("upstream", "downstream"):
                return _stage(p, cands)
    return None


def stage_placer() -> Placer:
    """By lineage distance. A container is drawn only when everything of the view
    inside it shares one stage — a path split across stages is drawn without it."""
    def place(cands: Mapping[str, Candidate]) -> Dict[str, Optional[str]]:
        of_member = {u: _stage(c, cands) for u, c in cands.items() if c.member}
        below: Dict[str, Set[Optional[str]]] = {}
        for u, c in cands.items():
            if c.member:
                for a in c.chain:
                    below.setdefault(a, set()).add(of_member[u])
        out: Dict[str, Optional[str]] = {}
        for u, c in cands.items():
            if c.member:
                out[u] = of_member[u]
            else:
                stages = below.get(u, set())
                out[u] = next(iter(stages)) if len(stages) == 1 else None
        return out

    return place


# ── The plan ─────────────────────────────────────────────────────────────────

@dataclass
class Plan:
    assignments: Dict[str, dict]
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)
    moved: List[str] = field(default_factory=list)
    members: int = 0
    containers: int = 0
    included: int = 0
    per_layer: Dict[str, int] = field(default_factory=dict)
    fallback: int = 0
    limit: int = 0

    @property
    def keys(self) -> int:
        return len(self.assignments)

    @property
    def over_cap(self) -> bool:
        return self.keys > self.limit

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed or self.moved)

    def diff(self, sample: int = 50) -> dict:
        """What changed, for the record: counts and a sample of each."""
        return {
            "added": len(self.added), "removed": len(self.removed), "moved": len(self.moved),
            "addedSample": self.added[:sample], "removedSample": self.removed[:sample],
        }


def _valid(layer_id: Optional[str], layers: Set[str]) -> Optional[str]:
    return layer_id if isinstance(layer_id, str) and layer_id in layers else None


def plan(
    cands: Mapping[str, Candidate],
    *,
    assignments: Mapping[str, dict],
    layer_ids: Sequence[str],
    overrides: Mapping[str, dict],
    placer: Placer,
    fallback_layer_id: Optional[str],
    limit: int,
    restage: bool = False,
    now: str = "",
) -> Plan:
    """The view's entries: the ones people placed, unchanged, and the server's,
    placed (see the module docstring). ``restage`` re-places entries the server
    already holds (a stages layout, whose distances move with the data)."""
    layers = set(layer_ids)
    user = {u: e for u, e in assignments.items() if e.get("assignedBy") != MACHINE}
    old = {u: e for u, e in assignments.items() if e.get("assignedBy") == MACHINE}
    placed = placer(cands)
    fallback_layer = _valid(fallback_layer_id, layers) or (layer_ids[0] if layer_ids else None)

    machine: Dict[str, dict] = {}
    fallback = 0
    # Parents before children: a member can take its nearest drawn container's layer,
    # and one inside a whole member it shares a layer with need not be listed at all.
    for urn in sorted(cands, key=lambda u: (len(cands[u].chain), u)):
        c = cands[urn]
        if urn in user:
            continue
        prev = old.get(urn)
        override = overrides.get(urn) or {}
        layer = _valid(override.get("layerId"), layers) or _valid(c.source_layer, layers)
        if layer is None and prev is not None and not restage:
            layer = _valid(prev.get("layerId"), layers)
        if layer is None:
            layer = _valid(placed.get(urn), layers)
        if layer is None:
            if not c.member:
                continue
            drawn = (machine.get(a) or user.get(a) for a in c.chain)
            layer = next((e["layerId"] for e in drawn if e and e.get("layerId") in layers), None)
            if layer is None:
                if fallback_layer is None:
                    continue        # a view with no layers holds nothing
                layer, fallback = fallback_layer, fallback + 1
        if c.member and any(
            cands.get(a) is not None and cands[a].whole and (machine.get(a) or {}).get("layerId") == layer
            for a in c.chain
        ):
            continue                # inside a whole member, in its layer: it comes with it

        entry = {"layerId": layer, "inheritsChildren": c.whole, "assignedBy": MACHINE}
        if prev is not None:
            entry["assignedAt"] = prev.get("assignedAt") or now
            if prev.get("layerId") == layer:
                for key in ("orderKey", "logicalNodeId"):
                    if prev.get(key) is not None:
                        entry[key] = prev[key]
        else:
            entry["assignedAt"] = now
        for key in ("orderKey", "logicalNodeId"):
            if override.get(key):
                entry[key] = override[key]
        machine[urn] = entry

    out = Plan(assignments={**user, **dict(sorted(machine.items()))}, limit=limit, fallback=fallback)
    out.added = sorted(u for u in machine if u not in old)
    out.removed = sorted(u for u in old if u not in machine and u not in user)
    out.moved = sorted(u for u in machine if u in old and old[u].get("layerId") != machine[u]["layerId"])
    out.members = sum(1 for u in machine if cands[u].member)
    out.containers = len(machine) - out.members
    out.included = len(user)
    for e in out.assignments.values():
        lid = e.get("layerId")
        if isinstance(lid, str):
            out.per_layer[lid] = out.per_layer.get(lid, 0) + 1
    return out


def top_type_counts(cands: Mapping[str, Candidate], facts: Mapping[str, NodeFacts]) -> Dict[str, int]:
    """For an ``auto`` layout's layers: how many members sit under each top-level type."""
    counts: Dict[str, int] = {}
    for u, c in cands.items():
        if not c.member:
            continue
        top = facts.get(c.chain[-1] if c.chain else u)
        t = (top.entity_type if top else "") or "entity"
        counts[t] = counts.get(t, 0) + 1
    return counts


def fact_urns(cands: Mapping[str, Candidate]) -> List[str]:
    """Every entity whose facts placing these candidates reads."""
    urns: Set[str] = set()
    for c in cands.values():
        urns.add(c.urn)
        urns.update(c.chain)
    return sorted(urns)
