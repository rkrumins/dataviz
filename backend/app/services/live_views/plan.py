"""A page of a view's members → where each one is placed.

A view made from a query holds its members as rows of ``view_members`` (up to a
quarter of a million), worked out a page at a time from its member sets: the
members of each page, the containers on their paths (``context``), where each sat
at the last answer (``previous``) and the entries people placed themselves
(``user``) go in; each member's row comes out. Containers are not rows — the canvas
draws them from each member's path.

Where a member goes is decided, in order, by: where a person put it
(``overrides``) > the layer its source names > where it already is (unless the
layout re-stages, or it waits in the fallback layer) > the layout's own rule (the
placer) > its nearest drawn container's layer (a person's entry, a member, or —
with ``nest`` — a container the layout places), then the fallback layer. The
fallback layer is a waiting room: a member there (one whose layer was deleted, or
that nothing could place) is offered to the placer again at every update. A member
inside a whole member (``inheritsChildren``) in its layer comes with it, and is
not a row; inside one in another layer it is, and is ``covered``.

Pure and deterministic, and a member's row depends on nothing but itself and its
path: any page size gives the same rows, and planning again over its own answer
changes nothing. Entries people placed themselves ("Always include") are never
members.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from backend.app.services.view_placement import NodeFacts, PlacementSpec, place_all


@dataclass(frozen=True)
class Candidate:
    """An entity on a page: a member, or a container on a member's path."""
    urn: str
    member: bool
    whole: bool = False
    via: Optional[str] = None
    hops: Optional[int] = None
    source_layer: Optional[str] = None
    chain: Tuple[str, ...] = ()       # containers, parent first


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


# ── A page ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Placed:
    """One member's row, as placing its page decides it."""
    urn: str
    layer_id: str
    whole: bool
    covered: bool
    assigned_at: str
    order_key: Optional[str] = None
    logical_node_id: Optional[str] = None


def _valid(layer_id: Optional[str], layers: Set[str]) -> Optional[str]:
    return layer_id if isinstance(layer_id, str) and layer_id in layers else None


def plan_page(
    members: Sequence[Candidate],
    *,
    context: Mapping[str, Candidate],
    previous: Mapping[str, Mapping],
    user: Mapping[str, Mapping],
    layer_ids: Sequence[str],
    overrides: Mapping[str, Mapping],
    placer: Placer,
    fallback_layer_id: Optional[str],
    exclude: Iterable[str] = (),
    restage: bool = False,
    place_containers: bool = True,
    now: str = "",
) -> Tuple[List[Placed], int]:
    """The rows of a page of members, in their order, and how many of them wait in
    the fallback layer (see the module docstring). ``context`` holds the containers on
    their paths, each with its own path — a member among them as a member;
    ``previous`` where each sat at the last answer (assignment-shaped: ``layerId``,
    ``assignedAt``, ``orderKey``, ``logicalNodeId``). ``restage`` re-places members the
    view already holds (a stages layout, whose distances move with the data);
    ``place_containers`` lets a container the layout places draw its members in
    (``nest``, outside a stages layout, whose containers follow what is inside)."""
    layers = set(layer_ids)
    left_out = set(exclude)
    fallback_layer = _valid(fallback_layer_id, layers) or (layer_ids[0] if layer_ids else None)
    cands: Dict[str, Candidate] = {**context, **{c.urn: c for c in members}}
    placed = placer(cands)
    known: Dict[str, Tuple[Optional[str], bool]] = {}

    def own(c: Candidate) -> Optional[str]:
        override = overrides.get(c.urn) or {}
        layer = _valid(override.get("layerId"), layers) or _valid(c.source_layer, layers)
        prev = previous.get(c.urn)
        if layer is None and prev is not None and not restage:
            layer = _valid(prev.get("layerId"), layers)
            if layer == fallback_layer:
                layer = None        # waiting to be placed: the placer has another go
        return layer or _valid(placed.get(c.urn), layers)

    def drawn(urn: str) -> Optional[str]:
        """The layer a container on a path is drawn in, if any."""
        if urn in left_out:
            return None             # kept out: what is inside it is drawn without it
        if urn in user:
            return _valid(user[urn].get("layerId"), layers)
        c = cands.get(urn)
        if c is None:
            return None
        if c.member:
            return layer_of(c)[0]
        return _valid(placed.get(urn), layers) if place_containers else None

    def layer_of(c: Candidate) -> Tuple[Optional[str], bool]:
        """A member's layer, and whether it is the fallback's for want of another."""
        if c.urn not in known:
            known[c.urn] = (None, False)    # a containment cycle reads as unplaced
            layer = own(c) or next((l for a in c.chain for l in [drawn(a)] if l), None)
            known[c.urn] = (layer or fallback_layer, layer is None and fallback_layer is not None)
        return known[c.urn]

    rows: List[Placed] = []
    fallback = 0
    for c in members:
        if c.urn in user or c.urn in left_out:
            continue
        layer, waiting = layer_of(c)
        if layer is None:
            continue                # a view with no layers holds nothing
        around = [layer_of(w)[0] for w in (cands.get(a) for a in c.chain if a not in left_out and a not in user)
                  if w is not None and w.member and w.whole]
        if layer in around:
            continue                # inside a whole member, in its layer: it comes with it
        fallback += waiting
        prev = previous.get(c.urn)
        override = overrides.get(c.urn) or {}
        order_key = logical = None
        if prev is not None and prev.get("layerId") == layer:
            order_key, logical = prev.get("orderKey"), prev.get("logicalNodeId")
        rows.append(Placed(
            urn=c.urn, layer_id=layer, whole=c.whole, covered=bool(around),
            assigned_at=(prev.get("assignedAt") or now) if prev is not None else now,
            order_key=override.get("orderKey") or order_key,
            logical_node_id=override.get("logicalNodeId") or logical,
        ))
    return rows, fallback


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
