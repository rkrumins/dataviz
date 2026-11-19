"""Where a view the server places draws each entity — what a trace's cards are placed by.

The browser places an ordinary view's entities itself, from its stored layout. Two kinds of
view it can't: one made from a query keeps its members in their own table (its stored
config holds no assignments), and a subset view finds its matches by search. For each URN
asked about, in order:

* **A view made from a query** — its member row, where a person put it on top (``member``);
  else an entry a person placed themselves (``entry``); else the layer of the nearest
  container kept whole — a member, or an entry, whose insides come with it (``whole``);
  else where the view's layout places it — its source view's placement, the view it
  follows, its types or its own rules (``layout``: a lineage-stage layout places nothing it
  doesn't hold); else the layer what nothing places waits in (``fallback``); else nowhere.
* **A subset view** — following its base, where the base's canvas places it, among the
  layers the subset shows (``layout``), what the base places nowhere in "Other matches"
  (``fallback``); placed by type, the layer that owns its type (``layout``), else the shown
  layer for every other type (``fallback``).

A layer the view doesn't show is nowhere (``none``). Each answer reads the graph in at most
two statements (the entities' containers, then what placing them reads), each admitted on
its own, and the member table in one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import view_members_repo
from backend.app.services.live_views import layouts
from backend.app.services.live_views.pipeline import (
    Inputs,
    PipelineError,
    _sha,
    fallback_of,
    inputs_of,
    make_placer,
    read_chains,
    read_facts,
    source_config,
)
from backend.app.services.live_views.plan import Candidate, _parents, _universe
from backend.app.services.view_placement import place_all
from backend.common.models.view_membership import MembershipDefinition
from backend.common.search_semantics import fold_case

#: A URN's layer and why it is there (``search_view.PlacementSource``).
Where = Tuple[Optional[str], str]


class BaseMissing(Exception):
    """The view a view follows is gone, or out of reach: it shows no layers to place in."""


@dataclass
class ListView:
    """What placing reads of a view made from a query, before the graph: its inputs (as a
    run reads them), the view it copies or follows, and its members' answer."""
    inputs: Inputs
    base: Optional[dict]
    epoch: Optional[int]

    @property
    def digest(self) -> str:
        return self.inputs.digest


async def list_view(session: AsyncSession, row: ViewORM, config: dict,
                    definition: MembershipDefinition) -> ListView:
    """``row``'s inputs. Raises ``BaseMissing`` for one that follows a view no longer there."""
    base = await source_config(session, definition, row.workspace_id)
    try:
        inputs = inputs_of(config, definition, base)
    except PipelineError as exc:
        raise BaseMissing(str(exc)) from exc
    epoch = await view_members_repo.members_epoch(session, row.id)
    await session.commit()
    return ListView(inputs=inputs, base=base, epoch=epoch)


async def place_in_list(session: AsyncSession, engine: Any, view_id: str, view: ListView,
                        urns: Sequence[str], *, admit: Any = None) -> Dict[str, Where]:
    """Where a view made from a query draws each of ``urns`` (see the module docstring)."""
    inputs = view.inputs
    definition = inputs.definition
    ids = set(layouts.layer_ids(inputs.layers))

    def valid(layer_id: Any) -> Optional[str]:
        return layer_id if isinstance(layer_id, str) and layer_id in ids else None

    fallback = valid(fallback_of(definition, inputs.layers))
    chains = await read_chains(engine, urns, admit=admit)
    every = sorted(set(urns) | {a for u in urns for a in chains.get(u, ())})
    rows = await view_members_repo.placements(session, view_id, view.epoch, every)
    await session.commit()

    def cascades(urn: str) -> Optional[str]:
        """The layer of ``urn`` when what is inside it comes with it."""
        if urn in rows:
            return valid(rows[urn]["layerId"]) if rows[urn]["inheritsChildren"] else None
        entry = inputs.user.get(urn)
        return valid(entry.get("layerId")) if entry and entry.get("inheritsChildren") is not False else None

    out: Dict[str, Where] = {}
    left: List[str] = []
    for urn in urns:
        if urn in rows:
            moved = inputs.overrides.get(urn) or {}
            layer = valid(moved.get("layerId")) or valid(rows[urn]["layerId"]) or fallback
            out[urn] = (layer, "member")
            continue
        entry = valid((inputs.user.get(urn) or {}).get("layerId"))
        if entry:
            out[urn] = (entry, "entry")
            continue
        around = next((layer for a in chains.get(urn, ()) for layer in [cascades(a)] if layer), None)
        if around:
            out[urn] = (around, "whole")
            continue
        left.append(urn)
    placed: Dict[str, Optional[str]] = {}
    if left and definition.layout.kind != "stages":
        cands = {u: Candidate(u, False, chain=tuple(chains.get(u, ()))) for u in left}
        facts = await read_facts(engine, sorted(_universe(cands, {})), admit=admit)
        placed = make_placer(definition, layers=inputs.layers, source_config=view.base, facts=facts)(cands)
    for urn in left:
        layer = valid(placed.get(urn))
        out[urn] = (layer, "layout") if layer else (fallback, "fallback") if fallback else (None, "none")
    return {urn: out[urn] for urn in urns}


def subset_digest(eff: Any) -> str:
    """What decides where a subset view draws entities: the scope its matches are found in,
    how its base places them, and its layers as it shows them."""
    placement = eff.subset_placement
    return _sha([eff.scope_hash, placement.digest if placement is not None else None,
                 [layer.model_dump(mode="json") for layer in eff.subset_layers]])


async def place_in_subset(engine: Any, eff: Any, urns: Sequence[str], *, admit: Any = None) -> Dict[str, Where]:
    """Where a subset view draws each of ``urns``, from its resolved scope (``eff``: its
    ``subset_layers`` and ``subset_placement``)."""
    shown = list(eff.subset_layers)
    ids = {layer.id for layer in shown}
    rest = next((layer for layer in shown if layer.rest), None)
    placement = eff.subset_placement
    out: Dict[str, Where] = {}
    if placement is not None:
        chains = await read_chains(engine, urns, admit=admit)
        cands = {u: Candidate(u, False, chain=tuple(chains.get(u, ()))) for u in urns}
        every = sorted(_universe(cands, {}))
        facts = await read_facts(engine, every, admit=admit)
        placed = place_all(placement.spec, _universe(cands, facts), _parents(cands))
        other = rest is not None and rest.id not in placement.spec.layer_ids
        for urn in urns:
            p = placed[urn]
            if p.member:
                out[urn] = (p.layer_id, "layout") if p.layer_id in ids else (None, "none")
            elif p.source == "fallback" and p.layer_id in ids:
                out[urn] = (p.layer_id, "fallback")
            else:
                out[urn] = (rest.id, "fallback") if other else (None, "none")
        return out
    facts = await read_facts(engine, urns, admit=admit)
    for urn in urns:
        kind = fold_case(facts[urn].entity_type if urn in facts else "")
        owner = next((layer for layer in shown
                      if kind in {fold_case(t) for t in layer.entity_types}), None)
        if owner is not None:
            out[urn] = (owner.id, "layout")
        elif rest is not None and kind not in {fold_case(t) for t in rest.excluded_types}:
            out[urn] = (rest.id, "fallback")
        else:
            out[urn] = (None, "none")
    return out
