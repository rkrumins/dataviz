"""
Reference-layout parser: up-converts a view's stored `referenceLayout`
config (canonical or legacy) into the canonical shape — layer definitions
+ a flattened physical-root-urn -> layer assignment map. The layer config
is a pure virtual overlay of the physical graph: it stores no graph data;
descendants/nesting resolve live via ontology containment elsewhere.

Mirrors frontend/src/utils/referenceLayout.ts — keep the two in sync.

Calling convention: both ``parse_reference_layout`` and
``derive_entity_scope`` take the FULL view config dict, i.e. whatever
``json.loads(ViewORM.config)`` returns (``{"content": {...}, "layout":
{"referenceLayout": {...}}, "filters": {...}, ...}``) — NOT a bare
referenceLayout dict. The canonical location is
``config["layout"]["referenceLayout"]``; when absent, we fall back to the
legacy top-level ``config["referenceLayout"]`` spelling that
``view_scope.py``'s ``_CONFIG_KEY_LAYOUT`` still reads.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class ReferenceLayout:
    layers: list[dict]
    assignments: dict[str, dict]  # urn -> {layerId, logicalNodeId?, inheritsChildren, assignedBy?, assignedAt?}


def _is_exact_urn_pattern(pattern: Any) -> bool:
    return isinstance(pattern, str) and bool(pattern) and "*" not in pattern and "?" not in pattern


def _collect_logical_node_rule_assignments(
    nodes: Any, layer_id: Any, assignments: dict[str, dict],
) -> None:
    """Depth-first, pre-order walk of a logicalNodes tree (arbitrary nesting
    via `children`): converts each node's own exact-urn rules before
    descending into its children, so a collision between a parent's rule
    and a descendant's rule leaves the parent's entry in place
    (first-claimed wins). Mirrors collectLogicalNodeRuleAssignments in
    frontend/src/utils/referenceLayout.ts.
    """
    for node in (nodes if isinstance(nodes, list) else []):
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        for rule in node.get("rules") or []:
            if not isinstance(rule, dict):
                continue
            pattern = rule.get("urnPattern")
            if _is_exact_urn_pattern(pattern) and pattern not in assignments:
                assignments[pattern] = {
                    "layerId": layer_id,
                    "logicalNodeId": node_id,
                    "inheritsChildren": True,
                    "assignedBy": "rule",
                }
        _collect_logical_node_rule_assignments(node.get("children"), layer_id, assignments)


def _resolve_raw_layout(config: Optional[dict]) -> dict:
    """Find the stored referenceLayout dict inside a full view config."""
    if not isinstance(config, dict):
        return {}
    layout = config.get("layout")
    if isinstance(layout, dict):
        nested = layout.get("referenceLayout")
        if isinstance(nested, dict):
            return nested
    legacy = config.get("referenceLayout")
    if isinstance(legacy, dict):
        return legacy
    return {}


def _normalize(raw_layout: dict) -> ReferenceLayout:
    """Up-convert rules (earlier wins on key collision):
    1. existing top-level `assignments` entries
    2. per-layer `entityAssignments[]` (keyed by urn, falling back to
       entityId; priority dropped)
    3. exact-urn (non-glob) layer/logicalNode `rules[]` — logicalNodes are
       walked depth-first, pre-order (a node's own rules before its
       `children`, at any nesting depth), layers in list order.

    Glob rules are left in place, untouched, wherever they sit.
    `entityAssignments` is stripped from returned layers — it is legacy
    input only, never canonical output.
    """
    assignments: dict[str, dict] = {}
    raw_assignments = raw_layout.get("assignments")
    if isinstance(raw_assignments, dict):
        for key, value in raw_assignments.items():
            if isinstance(value, dict):
                assignments[key] = value

    raw_layers = raw_layout.get("layers")
    layers: list[dict] = []
    for raw_layer in (raw_layers if isinstance(raw_layers, list) else []):
        if not isinstance(raw_layer, dict):
            layers.append(raw_layer)
            continue
        layer = {k: v for k, v in raw_layer.items() if k != "entityAssignments"}
        layer_id = raw_layer.get("id")

        for entry in raw_layer.get("entityAssignments") or []:
            if not isinstance(entry, dict):
                continue
            key = entry.get("urn") or entry.get("entityId")
            if not key or key in assignments:
                continue
            inherits = entry.get("inheritsChildren")
            assignments[key] = {
                "layerId": layer_id,
                "logicalNodeId": entry.get("logicalNodeId"),
                "inheritsChildren": True if inherits is None else inherits,
                "assignedBy": entry.get("assignedBy"),
                "assignedAt": entry.get("assignedAt"),
            }

        for rule in raw_layer.get("rules") or []:
            if not isinstance(rule, dict):
                continue
            pattern = rule.get("urnPattern")
            if _is_exact_urn_pattern(pattern) and pattern not in assignments:
                assignments[pattern] = {
                    "layerId": layer_id,
                    "inheritsChildren": True,
                    "assignedBy": "rule",
                }

        _collect_logical_node_rule_assignments(raw_layer.get("logicalNodes"), layer_id, assignments)

        layers.append(layer)

    return ReferenceLayout(layers=layers, assignments=assignments)


def parse_reference_layout(config: Optional[dict]) -> ReferenceLayout:
    """Parse a view's stored config into the canonical ReferenceLayout shape.

    ``config`` is the FULL view config dict (see module docstring for the
    calling convention) — not a bare referenceLayout dict.
    """
    return _normalize(_resolve_raw_layout(config))


def derive_entity_scope(config: Optional[dict]) -> str:
    """'all' | 'curated'. Explicit `content.entityScope` wins; otherwise
    derived from whether any assignments exist."""
    content = config.get("content") if isinstance(config, dict) else None
    explicit = content.get("entityScope") if isinstance(content, dict) else None
    if explicit in ("all", "curated"):
        return explicit
    layout = parse_reference_layout(config)
    return "curated" if layout.assignments else "all"
