"""Subset views, worked out from their definition and their base — no database,
no graph.

A subset view (``config.search``) shows the matches of one search, split into
layers by entity type: a layer holds the matches of the types it claims, and
the "Other matches" layer every match whose type no layer claims. A type has
one owner — the first layer, in board order, to list it, as the canvas's own
placement gives it (``view_placement.PlacementSpec``) — so the layers never
overlap, and each one is a search of its own (``feed_predicate``) that reads
only its types' entities.

A subset that follows its base (``layout: inherit``) takes its layers from the
base view as it is now: the base's layers, by type. Rules on tags or
properties, groups, anchors and entities placed by hand have no part in that
— a subset places by type alone (``placed_by_type`` says when the base does
more).
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple

from backend.app.services.layout_config import _resolve_raw_layout, parse_reference_layout
from backend.common.models.search import (
    EdgesPredicate,
    EntityTypePredicate,
    GroupPredicate,
    LayerPredicate,
    MatchAllPredicate,
    PathPredicate,
    RelatedPredicate,
    unwrap_edges,
)
from backend.common.models.search_view import (
    LAYER_TYPES_MAX,
    LAYERS_MAX,
    REST_LAYER_ID,
    REST_LAYER_NAME,
    SearchViewDefinition,
    SubsetLayer,
)
from backend.common.search_semantics import fold_case

#: A predicate nothing meets.
NOTHING = GroupPredicate(op="not", children=[MatchAllPredicate()])

#: What a subset's layer keeps of its base's: how it looks, never what it holds.
_DISPLAY_KEYS = ("id", "name", "description", "icon", "color", "order", "sequence", "width",
                 "nodeSortMode")


class SubsetError(Exception):
    """A request a subset view refuses: ``status`` is the HTTP answer."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def is_subset(config: Optional[Dict[str, Any]]) -> bool:
    return isinstance(config, dict) and isinstance(config.get("search"), dict)


# ---------------------------------------------------------------------------
# The search a subset keeps
# ---------------------------------------------------------------------------

def check_predicate(raw: Any):
    """``raw`` as a subset view may keep it, or a 422 saying why not: a search's
    shape and caps, held to a display rule's limits (it is asked of one entity
    at a time, so it describes no route through the graph), never a
    Connections search (it finds edges, not entities), and with no layer filter
    (a subset's layers are its base's)."""
    from backend.app.services.view_library import LibraryError, _check_predicate
    try:
        model = unwrap_edges(_check_predicate(raw, rule=True))
    except LibraryError as exc:
        raise SubsetError(exc.status, exc.detail) from exc
    if isinstance(model, EdgesPredicate):
        raise SubsetError(422, "A subset view shows entities, and a Connections search finds "
                               "edges. Search for the entities instead.")
    if has_layer(model):
        raise SubsetError(422, "A subset view's layers come from its base, so its search can't "
                               "filter by layer. Filter by type, tag or container instead.")
    return model


def has_layer(predicate) -> bool:
    if isinstance(predicate, LayerPredicate):
        return True
    if isinstance(predicate, GroupPredicate):
        return any(has_layer(c) for c in predicate.children)
    if isinstance(predicate, RelatedPredicate):
        return predicate.where is not None and has_layer(predicate.where)
    if isinstance(predicate, (PathPredicate, EdgesPredicate)):
        return any(w is not None and has_layer(w)
                   for w in (predicate.source_where, predicate.target_where))
    return False


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------

def _ordered_layers(config: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The layers of a full view config in board order, as placement orders them."""
    layout = parse_reference_layout(config)
    ordered = sorted(
        ((_order(layer.get("order")), position, layer) for position, layer in enumerate(layout.layers)
         if isinstance(layer, dict) and isinstance(layer.get("id"), str) and layer["id"]),
        key=lambda item: (item[0], item[1]),
    )
    return [layer for _, _, layer in ordered]


def _order(v: Any) -> Any:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0


def _types_of(layer: Dict[str, Any]) -> List[str]:
    raw = layer.get("entityTypes")
    return list(dict.fromkeys(t for t in raw if isinstance(t, str) and t)) if isinstance(raw, list) else []


def layers_of(config: Optional[Dict[str, Any]], *, add_rest: bool) -> List[SubsetLayer]:
    """The layers ``config``'s board shows, as a subset shows them: each with the
    types it owns (claimed first, in board order), and the fallback layer — the
    first with ``showUnassigned``, or with ``add_rest`` an "Other matches" layer
    when there is none — with every type no other layer owns."""
    layers = _ordered_layers(config)
    owner: Dict[str, str] = {}
    for layer in layers:
        for t in _types_of(layer):
            owner.setdefault(fold_case(t), layer["id"])
    rest_id = next((layer["id"] for layer in layers if layer.get("showUnassigned") is True), None)
    out: List[SubsetLayer] = []
    for layer in layers:
        own = [t for t in _types_of(layer) if owner.get(fold_case(t)) == layer["id"]]
        name = layer.get("name") if isinstance(layer.get("name"), str) and layer["name"] else layer["id"]
        color = layer.get("color") if isinstance(layer.get("color"), str) else None
        out.append(SubsetLayer(id=layer["id"], name=name, color=color, entity_types=own,
                               rest=layer["id"] == rest_id))
    if rest_id is None and add_rest:
        out.append(SubsetLayer(id=REST_LAYER_ID, name=REST_LAYER_NAME, rest=True))
    claimed = _claimed(out)
    return [layer.model_copy(update={"excluded_types": [
        t for t in claimed if fold_case(t) not in {fold_case(o) for o in layer.entity_types}]})
        if layer.rest else layer for layer in out]


def _claimed(layers: Sequence[SubsetLayer]) -> List[str]:
    seen: Dict[str, str] = {}
    for layer in layers:
        for t in layer.entity_types:
            seen.setdefault(fold_case(t), t)
    return list(seen.values())


def places_by_more_than_type(config: Optional[Dict[str, Any]]) -> bool:
    """Whether ``config``'s board places entities by more than their type — rules
    on tags, properties or URNs, groups, anchors, entities placed by hand — which
    a subset of it can't follow."""
    layout = parse_reference_layout(config)
    if any(isinstance(e, dict) and e.get("layerId") for e in layout.assignments.values()):
        return True
    for layer in layout.layers:
        if not isinstance(layer, dict):
            continue
        if any(isinstance(r, dict) for r in layer.get("rules") or []):
            return True
        if layer.get("logicalNodes") or layer.get("anchorUrn"):
            return True
    return False


def subset_layers(definition: SearchViewDefinition, config: Dict[str, Any],
                  base_config: Optional[Dict[str, Any]]) -> List[SubsetLayer]:
    """The layers of a subset view: its base's when it follows it, else its own —
    each marked ``hidden`` when the subset leaves it out (``hiddenLayers``)."""
    if definition.layout == "inherit":
        if base_config is None:
            return []
        hidden = set(definition.hidden_layers)
        return [layer.model_copy(update={"hidden": True}) if layer.id in hidden else layer
                for layer in layers_of(base_config, add_rest=True)]
    return layers_of(config, add_rest=False)


def shown_layers(layers: Sequence[SubsetLayer]) -> List[SubsetLayer]:
    return [layer for layer in layers if not layer.hidden]


def shown_search(search, layers: Sequence[SubsetLayer]):
    """What a subset's entities are found by, held to what its columns show: a
    hidden layer's types are left out, and with no column for every other type
    (no shown fallback layer), only the types the shown columns hold. So a search
    inside the view finds what it shows, and nothing it hides."""
    shown = shown_layers(layers)
    if any(layer.rest for layer in shown):
        left_out = _claimed([layer for layer in layers if layer.hidden and not layer.rest])
        return _and(search, types_not_in(left_out)) if left_out else search
    kept = _claimed(shown)
    return _and(search, types_in(kept)) if kept else NOTHING


def search_hash(search) -> str:
    """The identity of what a subset finds: two subsets of one base that find the
    same share their scans."""
    blob = json.dumps(search.model_dump(mode="json", by_alias=True, exclude_none=True),
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


def hidden_layer_problems(hidden: Sequence[str], layers: Sequence[SubsetLayer]) -> Optional[str]:
    """Why ``hidden`` can't be left out of a subset whose layers are ``layers``
    (all of them, hidden or not), or None."""
    ids = {layer.id for layer in layers}
    unknown = [h for h in hidden if h not in ids]
    if unknown:
        return f"Its base view has no layer {unknown[0]!r} to leave out."
    shown = [layer for layer in layers if layer.id not in set(hidden)]
    if not any(layer.rest or layer.entity_types for layer in shown):
        return "Keep at least one layer that can hold matches."
    return None


def find_layer(layers: Sequence[SubsetLayer], value: str) -> Optional[SubsetLayer]:
    """The layer ``value`` names by id, else the one layer with that name, ignoring
    case; None for none (or for a name two layers share)."""
    for layer in layers:
        if layer.id == value:
            return layer
    wanted = value.strip().casefold()
    named = [layer for layer in layers if layer.name.strip().casefold() == wanted]
    return named[0] if len(named) == 1 else None


def own_layers(layers: Sequence[SubsetLayer]) -> List[Dict[str, Any]]:
    """``layers`` as a subset view's own layout stores them: type layers, the
    fallback one marked ``showUnassigned``."""
    out: List[Dict[str, Any]] = []
    for order, layer in enumerate(layers):
        stored: Dict[str, Any] = {"id": layer.id, "name": layer.name, "order": order,
                                  "entityTypes": list(layer.entity_types)}
        if layer.color:
            stored["color"] = layer.color
        if layer.rest:
            stored["showUnassigned"] = True
        out.append(stored)
    return out


def followed_reference_layout(base_config: Dict[str, Any],
                              hidden: Iterable[str] = ()) -> Dict[str, Any]:
    """The ``referenceLayout`` a subset that follows ``base_config`` is served
    with: the base's layers as they look, holding the types they own, plus
    "Other matches" — less the ``hidden`` ones — and the base's tag overlays and
    default order. Never stored: the subset is served it on every read, so it is
    always the base's as it is now."""
    left_out = set(hidden)
    owned = {layer.id: layer for layer in layers_of(base_config, add_rest=True)
             if layer.id not in left_out}
    layers: List[Dict[str, Any]] = []
    for layer in _ordered_layers(base_config):
        shown = owned.get(layer["id"])
        if shown is None:
            continue
        kept = {k: layer[k] for k in _DISPLAY_KEYS if k in layer}
        if kept.get("nodeSortMode") == "custom":
            kept.pop("nodeSortMode")
        kept["entityTypes"] = list(shown.entity_types)
        if shown.rest:
            kept["showUnassigned"] = True
        layers.append(kept)
    if REST_LAYER_ID in owned:
        last = max((_order(layer.get("order")) for layer in layers), default=-1)
        layers.append({"id": REST_LAYER_ID, "name": REST_LAYER_NAME, "entityTypes": [],
                       "order": last + 1, "showUnassigned": True})
    raw = _resolve_raw_layout(base_config)
    out: Dict[str, Any] = {"layers": layers, "assignments": {}}
    for key in ("displayRules", "defaultNodeSortMode"):
        if key in raw:
            out[key] = raw[key]
    return out


def served_config(config: Dict[str, Any], base_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """A subset view's config as it is read: one that follows its base gets the
    base's layers (``followed_reference_layout``), its entity styles and the
    relationships it draws. Without a base to follow (deleted, or out of
    reach), its layers are empty — never anything widened."""
    definition = SearchViewDefinition.model_validate(config["search"])
    if definition.layout != "inherit":
        return config
    out = dict(config)
    layout = dict(out.get("layout") or {})
    layout["referenceLayout"] = (followed_reference_layout(base_config, definition.hidden_layers)
                                 if base_config is not None else {"layers": [], "assignments": {}})
    out["layout"] = layout
    out.pop("referenceLayout", None)
    if base_config is not None:
        if isinstance(base_config.get("entityOverrides"), dict):
            out["entityOverrides"] = base_config["entityOverrides"]
        base_content = base_config.get("content") if isinstance(base_config.get("content"), dict) else {}
        if "visibleRelationshipTypes" in base_content:
            content = dict(out.get("content") or {})
            content["visibleRelationshipTypes"] = base_content["visibleRelationshipTypes"]
            out["content"] = content
    return out


def layout_problems(config: Dict[str, Any]) -> Optional[str]:
    """Why ``config`` can't be a subset view's layout, else None. One that follows
    its base stores no layers; an own layout holds type layers alone — no rules,
    groups, anchors, custom order or entities placed by hand — at most
    ``LAYERS_MAX`` of them typed and one for the rest."""
    definition = SearchViewDefinition.model_validate(config["search"])
    layout = parse_reference_layout(config)
    if definition.layout == "inherit":
        return ("Its layers come from its base view: change them there, or give it a layout "
                "of its own first.") if layout.layers else None
    if any(isinstance(e, dict) and e.get("layerId") for e in layout.assignments.values()):
        return "A subset view shows what its search finds, so nothing in it can be placed by hand."
    typed = rests = 0
    for layer in layout.layers:
        if not isinstance(layer, dict):
            continue
        name = layer.get("name") or layer.get("id") or "A layer"
        if any(isinstance(r, dict) for r in layer.get("rules") or []):
            return f"“{name}” places by a rule; a subset view's layers place by type alone."
        if layer.get("logicalNodes"):
            return f"“{name}” has groups; a subset view's layers list matches by type."
        if layer.get("anchorUrn"):
            return f"“{name}” is anchored to an entity; a subset view's layers list matches by type."
        if layer.get("nodeSortMode") == "custom":
            return f"“{name}” is in a custom order; a subset view's layers are sorted by name."
        types = _types_of(layer)
        if len(types) > LAYER_TYPES_MAX:
            return f"“{name}” names {len(types)} types; a layer may name {LAYER_TYPES_MAX}."
        if layer.get("showUnassigned") is True:
            rests += 1
        if types:
            typed += 1
    if typed > LAYERS_MAX:
        return f"A subset view has at most {LAYERS_MAX} layers of types; this has {typed}."
    if rests > 1:
        return "A subset view has one layer for its other matches."
    return None


# ---------------------------------------------------------------------------
# Searches
# ---------------------------------------------------------------------------

def types_in(types: Sequence[str]):
    """An entity-type leaf for ``types`` — an OR of leaves past one leaf's cap."""
    chunks = [list(types[i:i + LAYER_TYPES_MAX]) for i in range(0, len(types), LAYER_TYPES_MAX)]
    leaves = [EntityTypePredicate(op="in", values=c) for c in chunks]
    return leaves[0] if len(leaves) == 1 else GroupPredicate(op="or", children=leaves)


def types_not_in(types: Sequence[str]):
    chunks = [list(types[i:i + LAYER_TYPES_MAX]) for i in range(0, len(types), LAYER_TYPES_MAX)]
    leaves = [EntityTypePredicate(op="notIn", values=c) for c in chunks]
    return leaves[0] if len(leaves) == 1 else GroupPredicate(op="and", children=leaves)


def _and(*parts):
    kept = [p for p in parts if p is not None and not isinstance(p, MatchAllPredicate)]
    if not kept:
        return MatchAllPredicate()
    return kept[0] if len(kept) == 1 else GroupPredicate(op="and", children=kept)


def layer_condition(layer: SubsetLayer):
    """What a match must also meet to be in ``layer``: one of its types — or, for
    the fallback layer, none of the types the others own. None: the layer can
    hold nothing."""
    if layer.rest:
        return types_not_in(layer.excluded_types) if layer.excluded_types else MatchAllPredicate()
    return types_in(layer.entity_types) if layer.entity_types else None


def feed_predicate(predicate, layer: SubsetLayer):
    """The search that fills ``layer``: the subset's search and the layer's types.
    None when the layer can hold nothing — answered without searching."""
    condition = layer_condition(layer)
    return None if condition is None else _and(predicate, condition)


def scope_types(layer: SubsetLayer, boundary_types: FrozenSet[str]) -> Optional[List[str]]:
    """The entity types a search for ``layer`` reads (what the engine prunes its
    labels to): the layer's types, inside the boundary's when it has some — or,
    for the fallback layer, the boundary's less the others'. None: every type
    (an unbounded boundary's fallback layer). ``[]``: nothing to read."""
    folded = {fold_case(t): t for t in boundary_types}
    if layer.rest:
        if not folded:
            return None
        excluded = {fold_case(t) for t in layer.excluded_types}
        return sorted(t for key, t in folded.items() if key not in excluded)
    if not folded:
        return list(layer.entity_types)
    return [t for t in layer.entity_types if fold_case(t) in folded]


def with_boundary(predicate, boundary):
    """A search inside a subset view: the caller's predicate and the subset's
    search. A path or a Connections search is the whole query, so the subset's
    search bounds both its ends."""
    if isinstance(predicate, (EdgesPredicate, PathPredicate)):
        return predicate.model_copy(update={
            "source_where": _and(predicate.source_where, boundary),
            "target_where": _and(predicate.target_where, boundary),
        })
    return _and(predicate, boundary)


def layer_filter_as_types(predicate, layers: Sequence[SubsetLayer]):
    """``predicate`` with each layer filter written as the types the layer holds —
    a subset's layers hold matches by type alone. A layer no layer of the
    subset is called matches nothing."""
    if isinstance(predicate, LayerPredicate):
        layer = find_layer(layers, predicate.layer_assignment)
        condition = layer_condition(layer) if layer is not None else None
        return NOTHING if condition is None else condition
    if isinstance(predicate, GroupPredicate):
        return predicate.model_copy(update={"children": [
            layer_filter_as_types(c, layers) for c in predicate.children]})
    if isinstance(predicate, RelatedPredicate) and predicate.where is not None:
        return predicate.model_copy(update={"where": layer_filter_as_types(predicate.where, layers)})
    if isinstance(predicate, (PathPredicate, EdgesPredicate)):
        return predicate.model_copy(update={
            f"{side}_where": layer_filter_as_types(where, layers)
            for side, where in (("source", predicate.source_where),
                                ("target", predicate.target_where)) if where is not None})
    return predicate


def boundary_hash(*, view_id: Optional[str], data_source_id: Optional[str],
                  root_urns: Iterable[str], entity_types: Iterable[str], max_depth: int,
                  predicate_hash: str) -> str:
    """The identity of where a subset's matches are looked for, and of what they
    must meet: its base's scope as that scope reads — never when the base was
    last saved, so renaming it or recolouring a layer keeps every scan — and
    its search. Two subsets of one base with one search share their scans."""
    payload = {
        "base": view_id or "", "ds": data_source_id or "",
        "roots": sorted(set(root_urns)), "types": sorted({fold_case(t) for t in entity_types}),
        "depth": max_depth, "p": predicate_hash,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "sv" + hashlib.sha1(blob.encode()).hexdigest()[:12]


def claimed_types(layers: Sequence[SubsetLayer]) -> Tuple[str, ...]:
    return tuple(_claimed(layers))
