"""Where a view the server places draws each entity — what a trace's cards, search hits and a
subset's layers are placed by.

The browser places an ordinary view's entities itself, from its stored layout. Two kinds of
view it can't: one made from a query keeps its members in their own table (its stored
config holds no assignments), and a subset view finds its matches by search. For each URN
asked about, in order:

* **A view made from a query** — its member row, where a person put it on top (``member``);
  else an entry a person placed themselves (``entry``); else the layer of the nearest
  container kept whole — a member, or an entry, whose insides come with it (``whole``);
  else the layer of the nearest member it sits in, drawn under it (``inside``: never for
  one kept out); else where the view's layout places it — its source view's placement, the
  view it follows, its types or its own rules (``layout``: a lineage-stage layout places
  nothing it doesn't hold); else the layer what nothing places waits in (``fallback``);
  else nowhere.
* **A subset view** — following its base, where the base's canvas places it, among the
  layers the subset shows (``layout``), what the base places nowhere in "Other matches"
  (``fallback``); placed by type, the layer that owns its type (``layout``), else the shown
  layer for every other type (``fallback``). A subset of a view made from a query is placed
  by its base's member rows: what the base draws as a member, an entry, or inside one keeps
  its layer and its reason; the rest is in "Other matches" (``fallback``).

A layer the view doesn't show is nowhere (``none``). With each answer, how many of the
entity's nearest containers are drawn in its layer too (``in_layer``): the canvas draws it
inside them — a member as its row says, anything else counted from where the view draws
each container. Each answer reads the graph in at most two statements (the entities'
containers, then what placing them reads), each admitted on its own, and the member table
in one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, view_is_live
from backend.app.db.repositories import view_members_repo
from backend.app.services.live_views import layouts
from backend.app.services.live_views.pipeline import (
    Inputs,
    PipelineError,
    _sha,
    config_of,
    fallback_of,
    inputs_of,
    make_placer,
    read_chains,
    read_facts,
    source_config,
)
from backend.app.services.live_views.plan import Candidate, _parents, _universe
from backend.app.services.view_placement import place_all
from backend.common.models.view_membership import MembershipDefinition, read_definition
from backend.common.search_semantics import fold_case

#: A URN's layer, why it is there (``search_view.PlacementSource``), and how many of its
#: nearest containers are drawn in that layer too (None where it is drawn nowhere).
Where = Tuple[Optional[str], str, Optional[int]]

#: The reasons a view made from a query draws an entity itself, not by its layout.
DRAWN = ("member", "entry", "whole", "inside")


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


def _nested(chain: Sequence[str], layer: Optional[str], layer_of: Callable[[int], Optional[str]]) -> Optional[int]:
    """How many of the nearest containers in ``chain`` (parent first) are drawn in
    ``layer`` — ``layer_of(k)`` the layer ``chain[k]`` is drawn in — up to the first that
    isn't. None for an entity drawn nowhere."""
    if layer is None:
        return None
    n = 0
    while n < len(chain) and layer_of(n) == layer:
        n += 1
    return n


async def place_in_list(session: AsyncSession, engine: Any, view_id: str, view: ListView,
                        urns: Sequence[str], *, admit: Any = None) -> Dict[str, Where]:
    """Where a view made from a query draws each of ``urns`` (see the module docstring)."""
    inputs = view.inputs
    definition = inputs.definition
    ids = set(layouts.layer_ids(inputs.layers))
    left_out = set(definition.exclude)

    def valid(layer_id: Any) -> Optional[str]:
        return layer_id if isinstance(layer_id, str) and layer_id in ids else None

    fallback = valid(fallback_of(definition, inputs.layers))
    chains = await read_chains(engine, urns, admit=admit)
    every = sorted(set(urns) | {a for u in urns for a in chains.get(u, ())})
    rows = await view_members_repo.placements(session, view_id, view.epoch, every)
    await session.commit()

    def member(urn: str) -> Optional[str]:
        """A member's layer: where a person moved it, else its row's."""
        moved = inputs.overrides.get(urn) or {}
        return valid(moved.get("layerId")) or valid(rows[urn]["layerId"]) or fallback

    def cascades(urn: str) -> Optional[str]:
        """The layer of ``urn`` when what is inside it comes with it."""
        if urn in rows:
            return valid(rows[urn]["layerId"]) if rows[urn]["inheritsChildren"] else None
        entry = inputs.user.get(urn)
        return valid(entry.get("layerId")) if entry and entry.get("inheritsChildren") is not False else None

    def own(urn: str, chain: Sequence[str]) -> Tuple[Optional[str], Optional[str]]:
        """Where the view itself draws ``urn``, inside ``chain`` (parent first), and why —
        ``(None, None)`` for one only its layout can place."""
        if urn in rows:
            return member(urn), "member"
        entry = valid((inputs.user.get(urn) or {}).get("layerId"))
        if entry:
            return entry, "entry"
        around = next((layer for a in chain for layer in [cascades(a)] if layer), None)
        if around:
            return around, "whole"
        if urn not in left_out:
            under = next((layer for a in chain if a in rows for layer in [member(a)] if layer), None)
            if under:
                return under, "inside"
        return None, None

    def nested(chain: Sequence[str], layer: Optional[str]) -> Optional[int]:
        return _nested(chain, layer, lambda k: own(chain[k], chain[k + 1:])[0])

    out: Dict[str, Where] = {}
    left: List[str] = []
    for urn in urns:
        chain = chains.get(urn, ())
        layer, source = own(urn, chain)
        if source is None:
            left.append(urn)
        elif source == "member" and layer is not None and layer == valid(rows[urn]["layerId"]):
            out[urn] = (layer, source, rows[urn]["inLayer"])
        else:
            out[urn] = (layer, source, nested(chain, layer))
    placed: Dict[str, Optional[str]] = {}
    if left and definition.layout.kind != "stages":
        cands = {u: Candidate(u, False, chain=tuple(chains.get(u, ()))) for u in left}
        facts = await read_facts(engine, sorted(_universe(cands, {})), admit=admit)
        placed = make_placer(definition, layers=inputs.layers, source_config=view.base, facts=facts)(cands)
    for urn in left:
        layer = valid(placed.get(urn))
        layer, source = (layer, "layout") if layer else (fallback, "fallback") if fallback else (None, "none")
        out[urn] = (layer, source, nested(chains.get(urn, ()), layer))
    return {urn: out[urn] for urn in urns}


def subset_digest(eff: Any) -> str:
    """What decides where a subset view draws entities: the scope its matches are found in,
    how its base places them, and its layers as it shows them — and, its base a view made
    from a query, that view's answer and entries."""
    placement = eff.subset_placement
    members = getattr(eff, "subset_members", None)
    parts = [eff.scope_hash, placement.digest if placement is not None else None,
             [layer.model_dump(mode="json") for layer in eff.subset_layers]]
    if members is not None:
        parts.append([members.view_id, members.epoch, sorted(members.entries.items())])
    return _sha(parts)


async def _in_list_base(session: Optional[AsyncSession], engine: Any, eff: Any, urns: Sequence[str],
                        admit: Any) -> Dict[str, Where]:
    """A subset of a view made from a query: where its base draws each entity itself, in
    a layer the subset shows; the rest in "Other matches"."""
    if session is None:
        raise ValueError("A subset of a view made from a query is placed from its base's member "
                         "rows: pass the request's session.")
    shown = list(eff.subset_layers)
    ids = {layer.id for layer in shown}
    rest = next((layer for layer in shown if layer.rest), None)
    row = (await session.execute(select(ViewORM).where(
        ViewORM.id == eff.subset_members.view_id, view_is_live()))).scalar_one_or_none()
    config = config_of(row) if row is not None else {}
    definition = read_definition(config)
    if row is None or definition is None:
        raise BaseMissing("The base view is no longer a view made from a query.")
    placed = await place_in_list(session, engine, row.id, await list_view(session, row, config, definition),
                                 urns, admit=admit)
    out: Dict[str, Where] = {}
    for urn, (layer, source, in_layer) in placed.items():
        if source in DRAWN and layer in ids:
            out[urn] = (layer, source, in_layer)
        elif source in DRAWN and layer is not None:
            out[urn] = (None, "none", None)     # in a layer the subset hides
        else:
            out[urn] = (rest.id, "fallback", 0) if rest is not None else (None, "none", None)
    return out


async def place_in_subset(engine: Any, eff: Any, urns: Sequence[str], *, admit: Any = None,
                          session: Optional[AsyncSession] = None) -> Dict[str, Where]:
    """Where a subset view draws each of ``urns``, from its resolved scope (``eff``: its
    ``subset_layers``, ``subset_placement`` and ``subset_members``). ``session``: required
    for a subset of a view made from a query, whose base's member rows place it."""
    if getattr(eff, "subset_members", None) is not None:
        return await _in_list_base(session, engine, eff, urns, admit)
    shown = list(eff.subset_layers)
    ids = {layer.id for layer in shown}
    rest = next((layer for layer in shown if layer.rest), None)
    placement = eff.subset_placement
    chains = await read_chains(engine, urns, admit=admit)
    cands = {u: Candidate(u, False, chain=tuple(chains.get(u, ()))) for u in urns}
    facts = await read_facts(engine, sorted(_universe(cands, {})), admit=admit)
    out: Dict[str, Where] = {}
    if placement is not None:
        placed = place_all(placement.spec, _universe(cands, facts), _parents(cands))
        other = rest is not None and rest.id not in placement.spec.layer_ids

        def where(urn: str) -> Tuple[Optional[str], str]:
            p = placed[urn]
            if p.member:
                return (p.layer_id, "layout") if p.layer_id in ids else (None, "none")
            if p.source == "fallback" and p.layer_id in ids:
                return p.layer_id, "fallback"
            return (rest.id, "fallback") if other else (None, "none")
    else:
        def where(urn: str) -> Tuple[Optional[str], str]:
            kind = fold_case(facts[urn].entity_type if urn in facts else "")
            owner = next((layer for layer in shown
                          if kind in {fold_case(t) for t in layer.entity_types}), None)
            if owner is not None:
                return owner.id, "layout"
            if rest is not None and kind not in {fold_case(t) for t in rest.excluded_types}:
                return rest.id, "fallback"
            return None, "none"
    for urn in urns:
        chain = chains.get(urn, ())
        layer, source = where(urn)
        out[urn] = (layer, source, _nested(chain, layer, lambda k: where(chain[k])[0]))
    return out
