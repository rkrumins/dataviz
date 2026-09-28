"""Every place a view definition points at the graph.

A definition is portable exactly as far as the things it names exist in the target: entity
URNs, entity types, and relationship types. This module is the ONLY code that knows where a
definition keeps them. Reconciliation reads them through :func:`collect`, and applying a
person's choices ("drop this entity", "this type is called Table here") goes through
:func:`rewrite`. A new place that holds a URN or a type gets added here once, and the golden
fixture test (``tests/test_view_transfer_references.py``) fails until it is.

Locations (``RL`` = ``layout.referenceLayout``):

* URNs: ``RL.assignments`` keys; ``RL.layers[].anchorUrn``; exact ``urnPattern`` on layer and
  logical-node rules; ``content.rootUrns``; display-rule predicate URN lists (``urns``,
  ``sourceUrns``, ``targetUrns``).
* Entity types: ``RL.layers[].entityTypes``; ``rules[].entityTypes``;
  ``content.visibleEntityTypes`` and ``rootEntityTypes``; ``filters.entityTypeFilters``;
  ``layout.lod.levels[].visibleEntityTypes``; ``layout.projection.targetGranularityType`` and
  ``containerTypes``; ``entityOverrides`` keys; ``entityType`` predicate ``values``.
* Relationship types: ``content.visibleRelationshipTypes``; ``RL.layers[].scopeEdges``
  ``edgeTypes`` and ``excludeEdgeTypes``; ``layout.projection.containmentEdgeTypes``;
  predicate ``edgeTypes``.
* Glob ``urnPattern`` rules name no single entity, so they are listed but never checked.

Display-rule predicates are remapped but never pruned: every predicate URN or type list has a
minimum length of one, so emptying one would turn a rule that matches nothing into a rule that
fails validation.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set

URN_KIND_ASSIGNMENT = "assignment"
URN_KIND_ANCHOR = "anchor"
URN_KIND_RULE = "rule"
URN_KIND_ROOT = "root"
URN_KIND_PREDICATE = "predicate"

_PREDICATE_URN_KEYS = ("urns", "sourceUrns", "source_urns", "targetUrns", "target_urns")
_PREDICATE_EDGE_TYPE_KEYS = ("edgeTypes", "edge_types")
_RULE_CRITERIA = ("entityTypes", "tags", "propertyMatch", "conditions")


def _is_exact_urn(pattern: Any) -> bool:
    return isinstance(pattern, str) and bool(pattern) and "*" not in pattern and "?" not in pattern


@dataclass
class References:
    """What a definition names. ``urns`` maps each URN to the kinds of place it appears in."""
    urns: Dict[str, Set[str]] = field(default_factory=dict)
    urn_patterns: Set[str] = field(default_factory=set)
    entity_types: Set[str] = field(default_factory=set)
    relationship_types: Set[str] = field(default_factory=set)

    def add_urn(self, urn: Any, kind: str) -> None:
        if isinstance(urn, str) and urn:
            self.urns.setdefault(urn, set()).add(kind)


@dataclass
class Rewrite:
    """Changes to apply to a definition's references. Empty means "change nothing"."""
    urn_map: Dict[str, str] = field(default_factory=dict)
    drop_urns: Set[str] = field(default_factory=set)
    type_map: Dict[str, str] = field(default_factory=dict)
    drop_types: Set[str] = field(default_factory=set)
    rel_type_map: Dict[str, str] = field(default_factory=dict)
    drop_rel_types: Set[str] = field(default_factory=set)

    def is_empty(self) -> bool:
        return not (self.urn_map or self.drop_urns or self.type_map or self.drop_types
                    or self.rel_type_map or self.drop_rel_types)


# ── Navigation ──────────────────────────────────────────────────────────────


def _dict(value: Any) -> Optional[dict]:
    return value if isinstance(value, dict) else None


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def reference_layout(definition: Any) -> Optional[dict]:
    layout = _dict(_dict(definition).get("layout") if _dict(definition) else None)
    return _dict(layout.get("referenceLayout")) if layout else None


def _layers(definition: Any) -> List[dict]:
    rl = reference_layout(definition)
    return [layer for layer in _list(rl.get("layers") if rl else None) if isinstance(layer, dict)]


def _each_rule(layers: Iterable[dict]) -> Iterable[dict]:
    """Every rule dict on every layer and, depth-first, every logical node."""
    def _nodes(nodes: Any) -> Iterable[dict]:
        for node in _list(nodes):
            if isinstance(node, dict):
                for rule in _list(node.get("rules")):
                    if isinstance(rule, dict):
                        yield rule
                yield from _nodes(node.get("children"))

    for layer in layers:
        for rule in _list(layer.get("rules")):
            if isinstance(rule, dict):
                yield rule
        yield from _nodes(layer.get("logicalNodes"))


def _count_logical_nodes(nodes: Any) -> int:
    return sum(1 + _count_logical_nodes(n.get("children")) for n in _list(nodes) if isinstance(n, dict))


def _each_predicate_node(definition: Any) -> Iterable[dict]:
    """Every dict node in every display rule's predicate tree."""
    rl = reference_layout(definition)
    stack = [r.get("predicate") for r in _list(rl.get("displayRules") if rl else None) if isinstance(r, dict)]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            yield node
            stack.extend(_list(node.get("children")))
        elif isinstance(node, list):
            stack.extend(node)


# ── collect ─────────────────────────────────────────────────────────────────


def collect(definition: Any) -> References:
    """Everything ``definition`` names in the graph."""
    refs = References()
    d = _dict(definition) or {}
    rl = reference_layout(d)
    layers = _layers(d)

    for urn in (_dict(rl.get("assignments")) or {}) if rl else {}:
        refs.add_urn(urn, URN_KIND_ASSIGNMENT)
    for layer in layers:
        refs.add_urn(layer.get("anchorUrn"), URN_KIND_ANCHOR)
        refs.entity_types.update(t for t in _list(layer.get("entityTypes")) if isinstance(t, str) and t)
        scope_edges = _dict(layer.get("scopeEdges")) or {}
        for key in ("edgeTypes", "excludeEdgeTypes"):
            refs.relationship_types.update(t for t in _list(scope_edges.get(key)) if isinstance(t, str) and t)
    for rule in _each_rule(layers):
        pattern = rule.get("urnPattern")
        if _is_exact_urn(pattern):
            refs.add_urn(pattern, URN_KIND_RULE)
        elif isinstance(pattern, str) and pattern:
            refs.urn_patterns.add(pattern)
        refs.entity_types.update(t for t in _list(rule.get("entityTypes")) if isinstance(t, str) and t)

    content = _dict(d.get("content")) or {}
    for urn in _list(content.get("rootUrns")):
        refs.add_urn(urn, URN_KIND_ROOT)
    for key in ("visibleEntityTypes", "rootEntityTypes"):
        refs.entity_types.update(t for t in _list(content.get(key)) if isinstance(t, str) and t)
    refs.relationship_types.update(
        t for t in _list(content.get("visibleRelationshipTypes")) if isinstance(t, str) and t)

    filters = _dict(d.get("filters")) or {}
    refs.entity_types.update(t for t in _list(filters.get("entityTypeFilters")) if isinstance(t, str) and t)

    layout = _dict(d.get("layout")) or {}
    for level in _list((_dict(layout.get("lod")) or {}).get("levels")):
        if isinstance(level, dict):
            refs.entity_types.update(t for t in _list(level.get("visibleEntityTypes")) if isinstance(t, str) and t)
    projection = _dict(layout.get("projection")) or {}
    granularity = projection.get("targetGranularityType")
    if isinstance(granularity, str) and granularity:
        refs.entity_types.add(granularity)
    refs.entity_types.update(t for t in _list(projection.get("containerTypes")) if isinstance(t, str) and t)
    refs.relationship_types.update(
        t for t in _list(projection.get("containmentEdgeTypes")) if isinstance(t, str) and t)

    refs.entity_types.update(k for k in (_dict(d.get("entityOverrides")) or {}) if isinstance(k, str) and k)

    for node in _each_predicate_node(d):
        for key in _PREDICATE_URN_KEYS:
            for urn in _list(node.get(key)):
                refs.add_urn(urn, URN_KIND_PREDICATE)
        if node.get("kind") == "entityType":
            refs.entity_types.update(t for t in _list(node.get("values")) if isinstance(t, str) and t)
        for key in _PREDICATE_EDGE_TYPE_KEYS:
            refs.relationship_types.update(t for t in _list(node.get(key)) if isinstance(t, str) and t)
    return refs


# ── rewrite ─────────────────────────────────────────────────────────────────


def _map_list(values: Any, mapping: Dict[str, str], drop: Set[str]) -> list:
    """Map each string, drop the dropped, de-duplicate, keep order. Non-strings pass through."""
    out: list = []
    seen: Set[str] = set()
    for value in _list(values):
        if isinstance(value, str):
            if value in drop:
                continue
            value = mapping.get(value, value)
            if value in seen:
                continue
            seen.add(value)
        out.append(value)
    return out


def _map_in_place(container: Optional[dict], key: str, mapping: Dict[str, str], drop: Set[str]) -> None:
    if container is not None and isinstance(container.get(key), list):
        container[key] = _map_list(container[key], mapping, drop)


def _rewrite_assignments(assignments: dict, rw: Rewrite) -> dict:
    """Rename and drop assignment keys. A remap never overwrites an entity's own placement:
    when the new URN is already assigned, that assignment wins and the remapped one is dropped."""
    kept = {urn: entry for urn, entry in assignments.items()
            if urn not in rw.drop_urns and urn not in rw.urn_map}
    for urn, entry in assignments.items():
        if urn in rw.drop_urns or urn not in rw.urn_map:
            continue
        new_urn = rw.urn_map[urn]
        if new_urn not in kept:
            kept[new_urn] = entry
    return kept


def _rewrite_rules(rules: Any, rw: Rewrite) -> list:
    out = []
    for rule in _list(rules):
        if not isinstance(rule, dict):
            out.append(rule)
            continue
        pattern = rule.get("urnPattern")
        if _is_exact_urn(pattern):
            if pattern in rw.drop_urns:
                rule.pop("urnPattern", None)
                # The URN was the rule's only criterion: without it the rule would match every
                # entity of any type, which is the opposite of what dropping it asked for.
                if not any(rule.get(c) for c in _RULE_CRITERIA):
                    continue
            else:
                rule["urnPattern"] = rw.urn_map.get(pattern, pattern)
        _map_in_place(rule, "entityTypes", rw.type_map, rw.drop_types)
        out.append(rule)
    return out


def _rewrite_logical_nodes(nodes: Any, rw: Rewrite) -> None:
    for node in _list(nodes):
        if isinstance(node, dict):
            if "rules" in node:
                node["rules"] = _rewrite_rules(node["rules"], rw)
            _rewrite_logical_nodes(node.get("children"), rw)


def _map_predicate_list(node: dict, key: str, mapping: Dict[str, str]) -> None:
    if isinstance(node.get(key), list) and mapping:
        node[key] = _map_list(node[key], mapping, set())


def rewrite(definition: Any, rw: Rewrite) -> dict:
    """A copy of ``definition`` with ``rw`` applied. Never mutates its input."""
    d = copy.deepcopy(_dict(definition) or {})
    if rw.is_empty():
        return d

    rl = reference_layout(d)
    if rl is not None:
        if isinstance(rl.get("assignments"), dict):
            rl["assignments"] = _rewrite_assignments(rl["assignments"], rw)
        for layer in _layers(d):
            anchor = layer.get("anchorUrn")
            if isinstance(anchor, str) and anchor:
                if anchor in rw.drop_urns:
                    layer.pop("anchorUrn", None)
                else:
                    layer["anchorUrn"] = rw.urn_map.get(anchor, anchor)
            _map_in_place(layer, "entityTypes", rw.type_map, rw.drop_types)
            scope_edges = _dict(layer.get("scopeEdges"))
            _map_in_place(scope_edges, "edgeTypes", rw.rel_type_map, rw.drop_rel_types)
            _map_in_place(scope_edges, "excludeEdgeTypes", rw.rel_type_map, rw.drop_rel_types)
            if "rules" in layer:
                layer["rules"] = _rewrite_rules(layer["rules"], rw)
            _rewrite_logical_nodes(layer.get("logicalNodes"), rw)

    content = _dict(d.get("content"))
    _map_in_place(content, "rootUrns", rw.urn_map, rw.drop_urns)
    _map_in_place(content, "visibleEntityTypes", rw.type_map, rw.drop_types)
    _map_in_place(content, "rootEntityTypes", rw.type_map, rw.drop_types)
    _map_in_place(content, "visibleRelationshipTypes", rw.rel_type_map, rw.drop_rel_types)

    _map_in_place(_dict(d.get("filters")), "entityTypeFilters", rw.type_map, rw.drop_types)

    layout = _dict(d.get("layout"))
    if layout is not None:
        for level in _list((_dict(layout.get("lod")) or {}).get("levels")):
            _map_in_place(_dict(level), "visibleEntityTypes", rw.type_map, rw.drop_types)
        projection = _dict(layout.get("projection"))
        if projection is not None:
            granularity = projection.get("targetGranularityType")
            if isinstance(granularity, str) and granularity:
                projection["targetGranularityType"] = (
                    None if granularity in rw.drop_types else rw.type_map.get(granularity, granularity))
            _map_in_place(projection, "containerTypes", rw.type_map, rw.drop_types)
            _map_in_place(projection, "containmentEdgeTypes", rw.rel_type_map, rw.drop_rel_types)

    overrides = _dict(d.get("entityOverrides"))
    if overrides is not None and (rw.type_map or rw.drop_types):
        remapped: Dict[str, Any] = {k: v for k, v in overrides.items()
                                    if k not in rw.drop_types and k not in rw.type_map}
        for key, value in overrides.items():
            if key in rw.type_map and key not in rw.drop_types:
                remapped.setdefault(rw.type_map[key], value)
        d["entityOverrides"] = remapped

    for node in _each_predicate_node(d):
        for key in _PREDICATE_URN_KEYS:
            _map_predicate_list(node, key, rw.urn_map)
        if node.get("kind") == "entityType":
            _map_predicate_list(node, "values", rw.type_map)
        for key in _PREDICATE_EDGE_TYPE_KEYS:
            _map_predicate_list(node, key, rw.rel_type_map)
    return d


# ── stats ───────────────────────────────────────────────────────────────────


def definition_stats(definition: Any) -> Dict[str, int]:
    """Headline counts for a definition: what a version row and a file manifest record."""
    refs = collect(definition)
    rl = reference_layout(definition)
    layers = _layers(definition)
    return {
        "layers": len(layers),
        "assignments": len(_dict(rl.get("assignments")) or {}) if rl else 0,
        "anchors": sum(1 for layer in layers if isinstance(layer.get("anchorUrn"), str) and layer["anchorUrn"]),
        "rules": sum(1 for _ in _each_rule(layers)),
        "logicalNodes": sum(_count_logical_nodes(layer.get("logicalNodes")) for layer in layers),
        "displayRules": len(_list(rl.get("displayRules"))) if rl else 0,
        "entityTypes": len(refs.entity_types),
        "relationshipTypes": len(refs.relationship_types),
    }


def urns_of_kind(refs: References, *kinds: str) -> List[str]:
    """URNs that appear in any of ``kinds``, sorted for determinism."""
    wanted = set(kinds)
    return sorted(urn for urn, found in refs.urns.items() if found & wanted)


__all__: List[str] = [
    "References", "Rewrite", "collect", "rewrite", "definition_stats", "reference_layout",
    "urns_of_kind", "URN_KIND_ASSIGNMENT", "URN_KIND_ANCHOR", "URN_KIND_RULE", "URN_KIND_ROOT",
    "URN_KIND_PREDICATE",
]

