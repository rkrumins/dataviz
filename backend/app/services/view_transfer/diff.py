"""What changed between two definitions of a view, in the terms a person reviews them in.

Used by version compare ("what changed between v6 and v8") and by the update-import preview
("what this file will change here"). Layers are matched by id and assignments by URN, the same
keys the 3-way merge uses. Everything outside layers and assignments is reported as the paths
that changed, which is enough to say "filters changed" without dumping both sides.

Pure and deterministic. Sample lists are capped so a diff of a 50,000-assignment view stays a
small response; the counts are always exact.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from backend.app.services.view_transfer.references import reference_layout

SAMPLE_LIMIT = 200
MAX_SETTING_PATHS = 100
_LABEL_FIELDS = ("name", "description", "icon", "tags", "viewType")


def _layers_by_id(definition: Any) -> Dict[str, dict]:
    rl = reference_layout(definition) or {}
    out: Dict[str, dict] = {}
    for layer in rl.get("layers") or []:
        if isinstance(layer, dict) and isinstance(layer.get("id"), str):
            out.setdefault(layer["id"], layer)
    return out


def _assignments(definition: Any) -> Dict[str, dict]:
    rl = reference_layout(definition) or {}
    raw = rl.get("assignments")
    return {k: v for k, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}


def _without_layers_and_assignments(definition: Any) -> dict:
    if not isinstance(definition, dict):
        return {}
    out = dict(definition)
    layout = out.get("layout")
    if isinstance(layout, dict):
        layout = dict(layout)
        rl = layout.get("referenceLayout")
        if isinstance(rl, dict):
            layout["referenceLayout"] = {k: v for k, v in rl.items() if k not in ("layers", "assignments")}
        out["layout"] = layout
    return out


def _changed_paths(a: Any, b: Any, prefix: str, out: List[str]) -> None:
    if len(out) >= MAX_SETTING_PATHS or a == b:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b), key=str):
            _changed_paths(a.get(key), b.get(key), f"{prefix}.{key}" if prefix else str(key), out)
        return
    out.append(prefix or "(root)")


def _layer_label(layer: dict) -> Dict[str, Any]:
    return {"id": layer.get("id"), "name": layer.get("name")}


def diff_definitions(
    a: Any,
    b: Any,
    *,
    label_a: Optional[Dict[str, Any]] = None,
    label_b: Optional[Dict[str, Any]] = None,
    sample_limit: int = SAMPLE_LIMIT,
) -> Dict[str, Any]:
    """Changes from ``a`` (before) to ``b`` (after)."""
    layers_a, layers_b = _layers_by_id(a), _layers_by_id(b)
    added_layers = [_layer_label(layers_b[i]) for i in layers_b if i not in layers_a]
    removed_layers = [_layer_label(layers_a[i]) for i in layers_a if i not in layers_b]
    changed_layers = []
    for layer_id in layers_a:
        if layer_id not in layers_b:
            continue
        before, after = layers_a[layer_id], layers_b[layer_id]
        fields = sorted(k for k in set(before) | set(after)
                        if k != "order" and before.get(k) != after.get(k))
        if fields:
            changed_layers.append({**_layer_label(after), "fields": fields})
    common_order_a = [i for i in layers_a if i in layers_b]
    common_order_b = [i for i in layers_b if i in layers_a]

    assign_a, assign_b = _assignments(a), _assignments(b)
    added = sorted(u for u in assign_b if u not in assign_a)
    removed = sorted(u for u in assign_a if u not in assign_b)
    moved: List[Dict[str, Any]] = []
    modified: List[str] = []
    for urn in sorted(u for u in assign_a if u in assign_b):
        before, after = assign_a[urn], assign_b[urn]
        if before == after:
            continue
        if before.get("layerId") != after.get("layerId"):
            moved.append({"urn": urn, "from": before.get("layerId"), "to": after.get("layerId")})
        else:
            modified.append(urn)

    settings: List[str] = []
    _changed_paths(_without_layers_and_assignments(a), _without_layers_and_assignments(b), "", settings)

    metadata = []
    if label_a is not None and label_b is not None:
        for key in _LABEL_FIELDS:
            if label_a.get(key) != label_b.get(key):
                metadata.append({"field": key, "from": label_a.get(key), "to": label_b.get(key)})

    truncated = any(len(x) > sample_limit for x in (added, removed, moved, modified))
    result = {
        "metadata": metadata,
        "layers": {
            "added": added_layers,
            "removed": removed_layers,
            "changed": changed_layers,
            "reordered": common_order_a != common_order_b,
            # Every layer on either side by name (the later name where both have it), so a
            # placement that moved can say from which layer to which.
            "names": {i: layer.get("name") or i for i, layer in {**layers_a, **layers_b}.items()},
        },
        "assignments": {
            "added": len(added),
            "removed": len(removed),
            "moved": len(moved),
            "modified": len(modified),
            "samples": {
                "added": added[:sample_limit],
                "removed": removed[:sample_limit],
                "moved": moved[:sample_limit],
                "modified": modified[:sample_limit],
            },
            "truncated": truncated,
        },
        "settings": settings,
    }
    result["identical"] = not (
        metadata or added_layers or removed_layers or changed_layers
        or result["layers"]["reordered"] or added or removed or moved or modified or settings
    )
    return result
