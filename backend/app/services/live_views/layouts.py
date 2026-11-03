"""The layers a view made from a query starts with.

* ``source``   — the layers of the view it was made from, as a layout template
  keeps them (``strip_placements``: no entity of that view's graph), each with a
  new id and ``linkLayerId`` naming the layer it was copied from;
* ``stages``   — one layer per lineage distance the query reaches;
* ``auto``     — one layer per top-level type of what it holds;
* ``template`` / ``custom`` — the layers the client sent.

After creation the layers are the view's own, like any view's: people rename,
reorder, recolour and delete them, and the planner places members in whatever
layers there are.
"""
from __future__ import annotations

import uuid
from typing import Dict, Iterable, List, Mapping, Optional

from backend.app.services.layout_config import strip_placements
from backend.common.models.view_membership import MembershipExpand

#: The frontend's layer palette (``ViewWizard/layerColors.ts``), so a new view's
#: layers look like any other's.
PALETTE = ("#3b82f6", "#8b5cf6", "#f59e0b", "#22c55e", "#ef4444", "#06b6d4", "#ec4899", "#6366f1")

#: Lineage stages, upstream to downstream: (id, name, colour).
STAGES = (
    ("stage-up2", "Sources", "#06b6d4"),
    ("stage-up1", "Feeds", "#3b82f6"),
    ("stage-seed", "Starting points", "#6366f1"),
    ("stage-down1", "Consumers", "#f59e0b"),
    ("stage-down2", "Impact", "#ef4444"),
)
STAGE_IDS = frozenset(s[0] for s in STAGES)

#: Top-level types that get a layer of their own in an ``auto`` layout.
AUTO_LAYERS_MAX = 12
OTHER = "Other"


def _id() -> str:
    return f"layer-{uuid.uuid4().hex[:10]}"


def layers_like(source_layers: Iterable[dict]) -> List[dict]:
    """The source view's layers as the new view's own: structure kept, placements
    stripped, a new id each, and ``linkLayerId`` naming the layer it came from."""
    out: List[dict] = []
    for layer in strip_placements(list(source_layers)):
        if isinstance(layer, dict) and isinstance(layer.get("id"), str) and layer["id"]:
            out.append({**layer, "id": _id(), "linkLayerId": layer["id"]})
    return out


def stage_layers(expand: MembershipExpand) -> List[dict]:
    """A layer per lineage distance the query can reach: starting points always,
    sources and feeds only upstream, consumers and impact only downstream."""
    wanted = {"stage-seed"}
    if expand.upstream:
        wanted |= {"stage-up1"} | ({"stage-up2"} if expand.upstream == "all" or expand.upstream > 1 else set())
    if expand.downstream:
        wanted |= {"stage-down1"} | ({"stage-down2"} if expand.downstream == "all" or expand.downstream > 1 else set())
    return [
        {"id": sid, "name": name, "color": color, "order": i, "entityTypes": []}
        for i, (sid, name, color) in enumerate(s for s in STAGES if s[0] in wanted)
    ]


def auto_layers(top_type_counts: Mapping[str, int]) -> List[dict]:
    """A layer per top-level type, the most populous first; past the limit the rest
    share one "Other" layer. Each layer names its type, so it also places by rule."""
    ranked = sorted(top_type_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    own = ranked[:AUTO_LAYERS_MAX]
    layers: List[dict] = []
    for i, (entity_type, _count) in enumerate(own):
        layers.append({
            "id": _id(), "name": _title(entity_type), "color": PALETTE[i % len(PALETTE)],
            "order": i, "entityTypes": [entity_type],
        })
    if len(ranked) > AUTO_LAYERS_MAX:
        layers.append({"id": _id(), "name": OTHER, "color": "#64748b", "order": len(layers), "entityTypes": []})
    return layers


def fallback_layer(layers: List[dict]) -> dict:
    """A layer for members nothing else places — added only when one is needed."""
    return {"id": _id(), "name": OTHER, "color": "#64748b", "order": len(layers), "entityTypes": []}


def type_layer_map(layers: Iterable[dict]) -> Dict[str, str]:
    """For an ``auto`` layout: each top-level type → the layer that holds it."""
    out: Dict[str, str] = {}
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        for t in layer.get("entityTypes") or []:
            if isinstance(t, str):
                out.setdefault(t.lower(), layer["id"])
    return out


def link_map(layers: Iterable[dict]) -> Dict[str, str]:
    """For a ``source`` layout: the source view's layer id → this view's layer."""
    return {
        layer["linkLayerId"]: layer["id"]
        for layer in layers
        if isinstance(layer, dict) and isinstance(layer.get("linkLayerId"), str)
    }


def _title(entity_type: str) -> str:
    words = entity_type.replace("_", " ").replace("-", " ").split()
    name = " ".join(w[:1].upper() + w[1:] for w in words) or entity_type
    return name if name.endswith("s") else f"{name}s"


def layer_ids(layers: Iterable[dict]) -> List[str]:
    return [layer["id"] for layer in layers if isinstance(layer, dict) and isinstance(layer.get("id"), str)]


def first_layer_id(layers: Iterable[dict]) -> Optional[str]:
    ids = layer_ids(layers)
    return ids[0] if ids else None
