"""Task-6 data-migration merge helper: fold a context-model instance's layer
state into a view's config, producing the canonical layout shape.

Pure dict logic (no DB / ORM / SQLAlchemy) so it is safe to import from the
alembic revision ``20260707_1200_view_layout_merge`` and unit-testable in
isolation (see backend/tests/test_view_layout_merge.py).

Canonical output shape, per view config:
  config["layout"]["referenceLayout"] = {"layers": [...], "assignments": {...}}
  config["content"]["entityScope"]    = "all" | "curated"
with every legacy per-layer ``entityAssignments`` stripped, every exact-urn
``rules`` entry converted to an assignment and removed (glob rules kept), and
any legacy top-level ``config["referenceLayout"]`` migrated into the nested
canonical location.

The step-1 assignment normalization reuses ``parse_reference_layout`` from
``backend.app.services.layout_config`` (the single source of truth for the
entityAssignments/rules up-convert semantics, kept in sync with the frontend
normalizer). This module adds only what the migration needs on top of that:
removing converted rules from the layers, merging the context-model instance
state in (cm wins), pinning entityScope, and canonicalizing the location.
"""
from __future__ import annotations

import copy
from typing import Any, Optional

from backend.app.services.layout_config import parse_reference_layout


def _is_exact_urn(pattern: Any) -> bool:
    """Mirror ``layout_config._is_exact_urn_pattern`` — an exact-urn rule is a
    non-empty string with no glob wildcards. Exact-urn rules are converted to
    assignments and removed; glob rules are left in place."""
    return isinstance(pattern, str) and bool(pattern) and "*" not in pattern and "?" not in pattern


def _keep_glob_rules(rules: Any) -> list:
    """Return only the non-exact (glob) rules from a ``rules`` list."""
    return [
        r for r in (rules if isinstance(rules, list) else [])
        if not (isinstance(r, dict) and _is_exact_urn(r.get("urnPattern")))
    ]


def _clean_logical_nodes(nodes: Any) -> list:
    """Depth-first copy of a logicalNodes tree with converted (exact-urn) rules
    removed at every nesting depth; glob rules kept. Mirrors the recursion in
    layout_config so the same rules that become assignments are the ones
    stripped here."""
    out: list = []
    for node in (nodes if isinstance(nodes, list) else []):
        if not isinstance(node, dict):
            out.append(node)
            continue
        cleaned = dict(node)
        if "rules" in cleaned:
            kept = _keep_glob_rules(cleaned.get("rules"))
            if kept:
                cleaned["rules"] = kept
            else:
                cleaned.pop("rules", None)
        if "children" in cleaned:
            cleaned["children"] = _clean_logical_nodes(cleaned.get("children"))
        out.append(cleaned)
    return out


def _clean_layer(layer: Any) -> Any:
    """Return a copy of a layer with legacy ``entityAssignments`` removed,
    converted exact-urn ``rules`` removed (glob kept), and its ``logicalNodes``
    cleaned recursively. Layers that are not dicts pass through untouched."""
    if not isinstance(layer, dict):
        return layer
    cleaned = {k: v for k, v in layer.items() if k != "entityAssignments"}
    if "rules" in cleaned:
        kept = _keep_glob_rules(cleaned.get("rules"))
        if kept:
            cleaned["rules"] = kept
        else:
            cleaned.pop("rules", None)
    if "logicalNodes" in cleaned:
        cleaned["logicalNodes"] = _clean_logical_nodes(cleaned.get("logicalNodes"))
    return cleaned


def _merge_layers(view_layers: list, cm_layers: list) -> list:
    """Merge context-model layers into (already-cleaned) view layers.

    cm holds the canvas's latest edits, so it is authoritative: the result is
    the cm layers in cm order (each merged with its view twin by id, cm fields
    winning), followed by any view-only layers in view order. ``order`` is
    renumbered 0..n-1 by final position.

    NOTE: the brief's phrasing ("cm-only layers appended; order renumbered
    0..n-1 preserving cm order first") is slightly ambiguous for divergent
    layer sets; this cm-authoritative reading was chosen to match the repeated
    "cm holds the canvas's latest edits — cm wins" user decision. On live data
    the view and cm layer sets are identical (same ids, same order), so every
    reasonable reading yields the same result.
    """
    view_by_id = {
        l.get("id"): l for l in view_layers if isinstance(l, dict) and l.get("id") is not None
    }
    merged: list = []
    seen: set = set()
    for cm_layer in cm_layers:
        if not isinstance(cm_layer, dict):
            continue
        cid = cm_layer.get("id")
        base = view_by_id.get(cid)
        combined = {**base, **cm_layer} if isinstance(base, dict) else cm_layer
        merged.append(_clean_layer(combined))
        if cid is not None:
            seen.add(cid)
    for layer in view_layers:
        lid = layer.get("id") if isinstance(layer, dict) else None
        if lid not in seen:
            merged.append(layer)  # already cleaned
            if lid is not None:
                seen.add(lid)
    for index, layer in enumerate(merged):
        if isinstance(layer, dict):
            layer["order"] = index
    return merged


def _locate_reference_layout(config: dict) -> tuple[dict, str]:
    """Return (raw_layout, location) where location is 'nested' | 'legacy' |
    'none'. Nested ``layout.referenceLayout`` wins over the legacy top-level
    ``referenceLayout`` spelling (matches layout_config._resolve_raw_layout)."""
    layout = config.get("layout")
    if isinstance(layout, dict):
        nested = layout.get("referenceLayout")
        if isinstance(nested, dict):
            return nested, "nested"
    legacy = config.get("referenceLayout")
    if isinstance(legacy, dict):
        return legacy, "legacy"
    return {}, "none"


def merge_view_layout(
    view_config: dict,
    cm_layers: Optional[list],
    cm_assignments: Optional[dict],
) -> dict:
    """Fold context-model instance state into a view config -> canonical shape.

    ``view_config`` is the FULL view config dict (json.loads of ViewORM.config).
    ``cm_layers`` / ``cm_assignments`` are the linked instance context-model's
    ``layers_config`` / ``instance_assignments`` (already json-decoded), or
    ``None`` when the view has no instance context-model.

    Rows without any referenceLayout (nested or legacy) are returned unchanged
    (the SAME object) and the cm inputs are ignored — matching the migration's
    "leave rows without any referenceLayout untouched" contract. Never mutates
    its inputs.
    """
    if not isinstance(view_config, dict):
        return view_config

    raw_layout, location = _locate_reference_layout(view_config)
    if location == "none":
        return view_config  # untouched

    # Step 1: normalize existing config -> assignment map (reuse the shared
    # parser so entityAssignments/exact-rule up-convert semantics stay in one
    # place). Own the dicts (shallow copy) so we never alias the input.
    parsed = parse_reference_layout(view_config)
    assignments: dict = {
        key: dict(value) for key, value in parsed.assignments.items() if isinstance(value, dict)
    }

    # Step 2 (assignments): cm instance_assignments win per urn.
    if isinstance(cm_assignments, dict):
        for urn, assignment in cm_assignments.items():
            if isinstance(assignment, dict):
                assignments[urn] = dict(assignment)

    # Layers: clean view layers (strip entityAssignments + converted rules),
    # then merge cm layers in when present.
    raw_view_layers = raw_layout.get("layers")
    cleaned_view_layers = [
        _clean_layer(l) for l in (raw_view_layers if isinstance(raw_view_layers, list) else [])
    ]
    if isinstance(cm_layers, list):
        final_layers = _merge_layers(cleaned_view_layers, cm_layers)
    else:
        final_layers = cleaned_view_layers

    # Assemble output (deep copy so all other config keys are preserved + owned).
    out = copy.deepcopy(view_config)
    if location == "legacy":
        out.pop("referenceLayout", None)  # canonicalize to nested location

    layout = out.get("layout")
    if not isinstance(layout, dict):
        layout = {}
        out["layout"] = layout
    ref = layout.get("referenceLayout")
    ref = dict(ref) if isinstance(ref, dict) else {}
    ref["layers"] = final_layers
    ref["assignments"] = assignments
    layout["referenceLayout"] = ref

    # Step 3: pin entityScope explicitly (sticky-scope) — preserve an explicit
    # 'all'/'curated', else derive from whether assignments exist.
    content = out.get("content")
    if not isinstance(content, dict):
        content = {}
        out["content"] = content
    explicit = content.get("entityScope")
    content["entityScope"] = explicit if explicit in ("all", "curated") else (
        "curated" if assignments else "all"
    )

    return out
