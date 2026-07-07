"""
Pure functions for ontology resolution, merging, validation, and suggestion.

Design constraints:
- No I/O: no DB access, no HTTP calls, no logging side effects.
- Fully testable in isolation.
- Input and output types are from models.py or the standard library.
"""
from collections import deque
from dataclasses import replace
from typing import Any, Dict, List, Optional, Set

from .models import (
    CoverageReport,
    EntityTypeDefEntry,
    EntityVisualData,
    EntityHierarchyData,
    EntityBehaviorData,
    FieldData,
    OntologyData,
    RelationshipTypeDefEntry,
    RelationshipVisualData,
    DerivedLists,
    ResolvedOntology,
    ValidationIssue,
)


# ---------------------------------------------------------------------------
# Deserialization helpers (dict -> domain model)
# ---------------------------------------------------------------------------


def _entity_def_from_dict(data: Dict[str, Any]) -> EntityTypeDefEntry:
    vis = data.get("visual", {})
    hier = data.get("hierarchy", {})
    beh = data.get("behavior", {})
    raw_fields = data.get("fields", [])
    return EntityTypeDefEntry(
        name=data.get("name", ""),
        plural_name=data.get("plural_name", data.get("pluralName", "")),
        description=data.get("description"),
        visual=EntityVisualData(
            icon=vis.get("icon", "Box"),
            color=vis.get("color", "#6366f1"),
            color_secondary=vis.get("color_secondary", vis.get("colorSecondary")),
            shape=vis.get("shape", "rounded"),
            size=vis.get("size", "md"),
            border_style=vis.get("border_style", vis.get("borderStyle", "solid")),
            show_in_minimap=vis.get("show_in_minimap", vis.get("showInMinimap", True)),
        ),
        hierarchy=EntityHierarchyData(
            level=hier.get("level", 0),
            can_contain=hier.get("can_contain", hier.get("canContain", [])),
            can_be_contained_by=hier.get("can_be_contained_by", hier.get("canBeContainedBy", [])),
            default_expanded=hier.get("default_expanded", hier.get("defaultExpanded", False)),
            roll_up_fields=hier.get("roll_up_fields", hier.get("rollUpFields", [])),
        ),
        behavior=EntityBehaviorData(
            selectable=beh.get("selectable", True),
            draggable=beh.get("draggable", True),
            expandable=beh.get("expandable", True),
            traceable=beh.get("traceable", True),
            click_action=beh.get("click_action", beh.get("clickAction", "select")),
            double_click_action=beh.get("double_click_action", beh.get("doubleClickAction", "expand")),
            expansion_mode=beh.get("expansion_mode", beh.get("expansionMode", "graph")),
        ),
        fields=[
            FieldData(
                id=f.get("id", ""),
                name=f.get("name", ""),
                type=f.get("type", "text"),
                required=f.get("required", False),
                show_in_node=f.get("show_in_node", f.get("showInNode", True)),
                show_in_panel=f.get("show_in_panel", f.get("showInPanel", True)),
                show_in_tooltip=f.get("show_in_tooltip", f.get("showInTooltip", False)),
                display_order=f.get("display_order", f.get("displayOrder", 0)),
                format=f.get("format"),
            )
            for f in raw_fields
        ],
    )


def _rel_def_from_dict(data: Dict[str, Any]) -> RelationshipTypeDefEntry:
    vis = data.get("visual", {})
    return RelationshipTypeDefEntry(
        name=data.get("name", ""),
        description=data.get("description"),
        category=data.get("category", "association"),
        is_containment=data.get("is_containment", data.get("isContainment", False)),
        is_lineage=data.get("is_lineage", data.get("isLineage", False)),
        direction=data.get("direction", "source-to-target"),
        visual=RelationshipVisualData(
            stroke_color=vis.get("stroke_color", vis.get("strokeColor", "#6366f1")),
            stroke_width=vis.get("stroke_width", vis.get("strokeWidth", 2)),
            stroke_style=vis.get("stroke_style", vis.get("strokeStyle", "solid")),
            animated=vis.get("animated", True),
            animation_speed=vis.get("animation_speed", vis.get("animationSpeed", "normal")),
            arrow_type=vis.get("arrow_type", vis.get("arrowType", "arrow")),
            curve_type=vis.get("curve_type", vis.get("curveType", "bezier")),
        ),
        source_types=data.get("source_types", data.get("sourceTypes", [])),
        target_types=data.get("target_types", data.get("targetTypes", [])),
        bidirectional=data.get("bidirectional", False),
        show_label=data.get("show_label", data.get("showLabel", False)),
        label_field=data.get("label_field", data.get("labelField")),
    )


def parse_entity_definitions(raw: Dict[str, Any]) -> Dict[str, EntityTypeDefEntry]:
    return {k: _entity_def_from_dict(v) for k, v in raw.items()}


def parse_relationship_definitions(raw: Dict[str, Any]) -> Dict[str, RelationshipTypeDefEntry]:
    return {k: _rel_def_from_dict(v) for k, v in raw.items()}


# ---------------------------------------------------------------------------
# Derive flat lists from rich definitions
# ---------------------------------------------------------------------------


def derive_flat_lists(
    entity_defs: Dict[str, EntityTypeDefEntry],
    rel_defs: Dict[str, RelationshipTypeDefEntry],
) -> DerivedLists:
    """
    Compute the legacy flat lists that ContextEngine and graph traversal use.
    Called whenever an ontology is resolved so callers get backward-compat data.
    """
    containment_edge_types: List[str] = []
    lineage_edge_types: List[str] = []
    edge_type_metadata: Dict[str, Dict] = {}
    entity_type_hierarchy: Dict[str, Dict] = {}
    root_entity_types: List[str] = []

    for rel_id, rel_def in rel_defs.items():
        key = rel_id.upper()
        if rel_def.is_containment and rel_id not in containment_edge_types:
            containment_edge_types.append(rel_id)
        if rel_def.is_lineage and rel_id not in lineage_edge_types:
            lineage_edge_types.append(rel_id)
        edge_type_metadata[key] = {
            "isContainment": rel_def.is_containment,
            "isLineage": rel_def.is_lineage,
            "category": rel_def.category,
            "direction": rel_def.direction,
            "color": rel_def.visual.stroke_color,
            "strokeStyle": rel_def.visual.stroke_style,
            "animated": rel_def.visual.animated,
        }

    for ent_id, ent_def in entity_defs.items():
        entity_type_hierarchy[ent_id] = {
            "level": ent_def.hierarchy.level,
            "canContain": ent_def.hierarchy.can_contain,
            "canBeContainedBy": ent_def.hierarchy.can_be_contained_by,
            "defaultExpanded": ent_def.hierarchy.default_expanded,
        }
        if not ent_def.hierarchy.can_be_contained_by:
            root_entity_types.append(ent_id)

    return DerivedLists(
        containment_edge_types=containment_edge_types,
        lineage_edge_types=lineage_edge_types,
        edge_type_metadata=edge_type_metadata,
        entity_type_hierarchy=entity_type_hierarchy,
        root_entity_types=root_entity_types,
    )


# ---------------------------------------------------------------------------
# Merge strategy: base layer + override layer (non-destructive)
# ---------------------------------------------------------------------------


def merge_entity_definitions(
    base: Dict[str, EntityTypeDefEntry],
    override: Dict[str, EntityTypeDefEntry],
) -> Dict[str, EntityTypeDefEntry]:
    """
    Merge override on top of base.
    Types present in override take precedence; types only in base are kept.
    """
    merged = dict(base)
    merged.update(override)
    return merged


def merge_relationship_definitions(
    base: Dict[str, RelationshipTypeDefEntry],
    override: Dict[str, RelationshipTypeDefEntry],
) -> Dict[str, RelationshipTypeDefEntry]:
    merged = dict(base)
    merged.update(override)
    return merged


def resolve_ontology(
    system_default: Optional[OntologyData],
    assigned: Optional[OntologyData],
    introspected_entity_ids: Optional[List[str]] = None,
    introspected_rel_ids: Optional[List[str]] = None,
) -> ResolvedOntology:
    """
    Two-layer merge: assigned <- introspection.

    Layer 1 (assigned): ontology explicitly assigned to the data source.
    Layer 2 (introspection): types observed in the graph but not yet defined.
               These get a synthetic fallback definition so the UI still
               renders unmapped types in exploration views.

    The legacy ``system_default`` parameter is accepted for call-site
    stability but ignored. Aggregation paths must read only the
    assigned ontology, and other read paths get the same behaviour for
    consistency — silently merging system defaults on top of an
    assigned ontology produced unclassified-edge bugs that the
    ``backend.app.ontology.gate`` resolution gate now refuses to allow
    through.
    """
    del system_default  # unused; see docstring

    entity_defs: Dict[str, EntityTypeDefEntry] = {}
    rel_defs: Dict[str, RelationshipTypeDefEntry] = {}
    sources: Dict[str, str] = {}

    # Layer 1 — assigned ontology
    if assigned:
        asgn_ent = parse_entity_definitions(assigned.entity_type_definitions)
        asgn_rel = parse_relationship_definitions(assigned.relationship_type_definitions)
        entity_defs.update(asgn_ent)
        rel_defs.update(asgn_rel)
        for k in asgn_ent:
            sources[k] = "assigned"
        for k in asgn_rel:
            sources[k] = "assigned"

    # Layer 3 — introspection: synthesize definitions for unknown types
    # Use case-insensitive matching to avoid duplicates (e.g. "HAS" from FalkorDB
    # vs "has" from ontology definition)
    if introspected_entity_ids:
        existing_upper = {k.upper() for k in entity_defs}
        for eid in introspected_entity_ids:
            if eid.upper() not in existing_upper:
                entity_defs[eid] = EntityTypeDefEntry(name=_humanize(eid), plural_name=_humanize(eid) + "s")
                sources[eid] = "introspection"
                existing_upper.add(eid.upper())
    if introspected_rel_ids:
        existing_upper = {k.upper() for k in rel_defs}
        for rid in introspected_rel_ids:
            if rid.upper() not in existing_upper:
                rel_defs[rid] = RelationshipTypeDefEntry(name=_humanize(rid))
                sources[rid] = "introspection"
                existing_upper.add(rid.upper())

    flat = derive_flat_lists(entity_defs, rel_defs)

    # Honor the ontology's PERSISTED containment/lineage lists, not ONLY the
    # per-relationship `is_containment`/`is_lineage` flags. The stored top-level
    # lists are authoritative — they are exactly what the ontologies API and the
    # cached-schema (hence the frontend/canvas) surface. Re-deriving containment
    # solely from per-rel flags silently drops the persisted list whenever the
    # flag wasn't round-tripped onto the matching rel def (e.g. a custom/blank
    # ontology that recorded `containment_edge_types` but left the rel def's
    # `is_containment` at its False default). That empties the structural
    # top-level query and flattens the wizard tree — while the canvas, which
    # reads the persisted list, still nests. Union so BOTH sources are honored
    # (additive: can only add declared containment types, never remove derived).
    containment = list(flat.containment_edge_types)
    lineage = list(flat.lineage_edge_types)
    if assigned:
        for t in (assigned.containment_edge_types or []):
            if t not in containment:
                containment.append(t)
        for t in (assigned.lineage_edge_types or []):
            if t not in lineage:
                lineage.append(t)

    # Self-consistent endpoint constraints. A relationship's source/target type list is only
    # meaningful for entity types that actually exist in THIS ontology. A constraint that
    # references ONLY absent types — e.g. a system-default FLOWS_TO carrying
    # dataset/dataJob/column/schemaField endpoints bolted onto a manual ontology whose entity
    # types are layer/object/group/attribute — is unsatisfiable and would block EVERY edge of
    # that type, even though the ontology clearly intends the relationship to be usable. Filter
    # each constraint to the ontology's own entity types (case-insensitive); a now-empty list is
    # "unrestricted" (both the commit gate and the frontend already treat empty as "any → any"),
    # so drawn lineage between the ontology's real types is permitted. Genuinely self-consistent
    # constraints (ingested ontologies, whose entity types ARE the endpoint types) keep every
    # existing type and enforce exactly as before — this only ever removes references to types
    # that don't exist, never adds a constraint, so it can only relax, never break.
    entity_ids_lower = {k.lower() for k in entity_defs}

    def _self_consistent_endpoints(types: List[str]) -> List[str]:
        if not types:
            return types
        return [t for t in types if str(t).lower() in entity_ids_lower]

    rel_defs = {
        rid: replace(
            rd,
            source_types=_self_consistent_endpoints(rd.source_types),
            target_types=_self_consistent_endpoints(rd.target_types),
        )
        for rid, rd in rel_defs.items()
    }

    return ResolvedOntology(
        entity_type_definitions=entity_defs,
        relationship_type_definitions=rel_defs,
        containment_edge_types=containment,
        lineage_edge_types=lineage,
        edge_type_metadata=flat.edge_type_metadata,
        entity_type_hierarchy=flat.entity_type_hierarchy,
        root_entity_types=flat.root_entity_types,
        resolution_sources=sources,
    )


# ---------------------------------------------------------------------------
# Validation (SHACL-lite)
# ---------------------------------------------------------------------------


def case_insensitive_type_id_collisions(
    entity_ids: List[str], edge_ids: List[str]
) -> List[str]:
    """Type ids that collide only by case, one message per collision.

    Case-insensitive normalization of authored data (``Has``/``HAS``/``has`` → the
    declared casing) is only well-defined when a case-folded id maps to exactly one
    declared id. Declaring both ``HAS`` and ``has`` would make that ambiguous, so the
    save path rejects it. Entity ids and edge ids are separate namespaces (a payload's
    ``entityType`` vs ``edgeType`` disambiguates), so they are checked independently."""
    def _collisions(names: List[str], kind: str) -> List[str]:
        seen: Dict[str, str] = {}
        out: List[str] = []
        for n in names:
            if not n:
                continue
            key = str(n).lower()
            first = seen.get(key)
            if first is not None and first != n:
                out.append(
                    f"{kind} types '{first}' and '{n}' differ only by case; type ids must be "
                    f"unique case-insensitively — rename or remove one so they differ by more than "
                    f"case (if the vocabulary is genuinely case-distinct, keep one id here and alias "
                    f"the other at mapping time)."
                )
            else:
                seen.setdefault(key, str(n))
        return out

    return _collisions(entity_ids, "Entity") + _collisions(edge_ids, "Relationship")


def validate_ontology(
    entity_defs: Dict[str, EntityTypeDefEntry],
    relationship_defs: Dict[str, RelationshipTypeDefEntry],
) -> List[ValidationIssue]:
    """
    Validate ontology definitions and return a list of issues.
    Checks:
    1. Containment cycle detection (DFS).
    2. Unknown source/target entity types referenced in relationships.
    3. Missing name on any type.
    """
    issues: List[ValidationIssue] = []

    # Check 1: missing names
    for eid, edef in entity_defs.items():
        if not edef.name:
            issues.append(ValidationIssue("warning", "MISSING_NAME", f"Entity type '{eid}' has no name.", eid))
    for rid, rdef in relationship_defs.items():
        if not rdef.name:
            issues.append(ValidationIssue("warning", "MISSING_NAME", f"Relationship type '{rid}' has no name.", rid))

    # Check 2: unknown source/target types
    for rid, rdef in relationship_defs.items():
        for st in rdef.source_types:
            if st and st not in entity_defs:
                issues.append(ValidationIssue("warning", "UNKNOWN_TYPE",
                    f"Relationship '{rid}' references unknown source type '{st}'.", rid))
        for tt in rdef.target_types:
            if tt and tt not in entity_defs:
                issues.append(ValidationIssue("warning", "UNKNOWN_TYPE",
                    f"Relationship '{rid}' references unknown target type '{tt}'.", rid))

    # Check 3: containment cycle detection
    can_contain: Dict[str, List[str]] = {
        eid: edef.hierarchy.can_contain
        for eid, edef in entity_defs.items()
    }
    cycle = _find_containment_cycle(can_contain)
    if cycle:
        issues.append(ValidationIssue(
            "error", "CONTAINMENT_CYCLE",
            f"Containment cycle detected: {' -> '.join(cycle)}",
        ))

    return issues


def _find_containment_cycle(graph: Dict[str, List[str]]) -> Optional[List[str]]:
    """DFS-based cycle detection; returns the cycle path or None."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color: Dict[str, int] = {n: WHITE for n in graph}
    parent: Dict[str, Optional[str]] = {n: None for n in graph}

    def dfs(node: str) -> Optional[List[str]]:
        color[node] = GRAY
        for neighbor in graph.get(node, []):
            # Self-loops (e.g. container can_contain container) are intentional
            # in ontologies (recursive structures) and are NOT considered cycles.
            if neighbor == node:
                continue
            if neighbor not in color:
                color[neighbor] = WHITE
                parent[neighbor] = None
            if color[neighbor] == GRAY:
                # Reconstruct cycle
                path = [neighbor, node]
                cur = node
                while parent.get(cur) and parent[cur] != neighbor:
                    cur = parent[cur]  # type: ignore[assignment]
                    path.append(cur)
                return list(reversed(path)) + [neighbor]
            if color[neighbor] == WHITE:
                parent[neighbor] = node
                result = dfs(neighbor)
                if result:
                    return result
        color[node] = BLACK
        return None

    for node in list(graph.keys()):
        if color[node] == WHITE:
            cycle = dfs(node)
            if cycle:
                return cycle
    return None


# ---------------------------------------------------------------------------
# Coverage analysis
# ---------------------------------------------------------------------------


def check_coverage(
    entity_defs: Dict[str, EntityTypeDefEntry],
    relationship_defs: Dict[str, RelationshipTypeDefEntry],
    graph_entity_ids: List[str],
    graph_rel_ids: List[str],
) -> CoverageReport:
    ont_entities: Set[str] = set(entity_defs.keys())
    ont_rels: Set[str] = set(relationship_defs.keys())
    graph_ents: Set[str] = set(graph_entity_ids)
    graph_rels: Set[str] = set(graph_rel_ids)

    covered_ent = list(ont_entities & graph_ents)
    uncovered_ent = list(graph_ents - ont_entities)
    extra_ent = list(ont_entities - graph_ents)

    covered_rel = list(ont_rels & graph_rels)
    uncovered_rel = list(graph_rels - ont_rels)

    total = len(graph_ents) + len(graph_rels)
    covered = len(covered_ent) + len(covered_rel)
    pct = round((covered / total) * 100, 1) if total > 0 else 100.0

    return CoverageReport(
        coverage_percent=pct,
        covered_entity_types=covered_ent,
        uncovered_entity_types=uncovered_ent,
        extra_entity_types=extra_ent,
        covered_relationship_types=covered_rel,
        uncovered_relationship_types=uncovered_rel,
    )


# ---------------------------------------------------------------------------
# Suggest ontology from introspection
# ---------------------------------------------------------------------------


def _group_stats_by_casefold(stats: List[Any]) -> Dict[str, List[Any]]:
    """``{casefolded id: [stat, …]}`` preserving first-seen order. A source graph carrying both
    ``has`` and ``HAS`` yields one group — suggesting BOTH would collide with the authoring guard
    (case-insensitive-unique type ids) the moment the user saves the suggested ontology."""
    groups: Dict[str, List[Any]] = {}
    for st in stats:
        groups.setdefault(str(st.id).lower(), []).append(st)
    return groups


def _canonical_stat_id(casefold: str, variants: List[Any], defaults: Dict[str, Dict]) -> str:
    """Canonical spelling for a case-collision group: (a) the defaults' spelling if a default type
    matches case-insensitively (e.g. ``HAS`` from SYSTEM_RELATIONSHIP_TYPES), else (b) the
    highest-instance-count variant, else (c) the first seen (``variants`` order breaks count ties)."""
    for k in defaults:                         # (a) defaults casing wins
        if k.lower() == casefold:
            return k
    best_id, best_count = None, -1             # (b) majority count, (c) first-seen tiebreak
    for st in variants:
        c = int(getattr(st, "count", 0) or 0)
        if c > best_count:
            best_id, best_count = st.id, c
    return best_id if best_id is not None else casefold


def _also_seen_note(variants: List[Any], canonical: str) -> str:
    """"also seen as: …" for the merged case variants (empty when nothing was merged)."""
    others = [st.id for st in variants if st.id != canonical]
    seen = list(dict.fromkeys(others))         # dedupe, preserve order
    return ("also seen as: " + ", ".join(seen)) if seen else ""


def _with_note(description: Optional[str], note: str) -> Optional[str]:
    if not note:
        return description
    return f"{description} ({note})" if description else note


def suggest_entity_defs_from_stats(
    entity_type_stats: List[Any],
    existing_defs: Optional[Dict[str, EntityTypeDefEntry]] = None,
    base_defaults: Optional[Dict[str, Dict]] = None,
) -> Dict[str, EntityTypeDefEntry]:
    """
    Build suggested entity definitions from graph introspection stats.

    Case-collision variants (``layer``/``Layer``) are merged into ONE def keyed by the canonical
    spelling (see :func:`_canonical_stat_id`); the merged variants are noted in the description.
    For each remaining entity type:
    - If already in existing_defs (any case) → keep as-is (do not overwrite user customisation).
    - If in base_defaults → hydrate from defaults.
    - Otherwise → generate a generic fallback.
    """
    from .defaults import SYSTEM_ENTITY_TYPES  # local import to avoid circular
    defaults = base_defaults or SYSTEM_ENTITY_TYPES
    existing = existing_defs or {}
    result: Dict[str, EntityTypeDefEntry] = dict(existing)
    existing_lc = {k.lower() for k in result}

    for casefold, variants in _group_stats_by_casefold(entity_type_stats).items():
        if casefold in existing_lc:
            continue  # preserve user customisation (any case)
        eid = _canonical_stat_id(casefold, variants, defaults)
        if eid in defaults:
            edef = _entity_def_from_dict(defaults[eid])
        else:
            st0 = variants[0]
            icon = getattr(st0, "icon", None) or "Box"
            color = getattr(st0, "color", None) or "#6366f1"
            edef = EntityTypeDefEntry(
                name=_humanize(eid),
                plural_name=_humanize(eid) + "s",
                description=f"Entity type discovered in graph: {eid}",
                visual=EntityVisualData(icon=icon, color=color),
            )
        edef.description = _with_note(edef.description, _also_seen_note(variants, eid))
        result[eid] = edef

    return result


def suggest_relationship_defs_from_stats(
    edge_type_stats: List[Any],
    existing_defs: Optional[Dict[str, RelationshipTypeDefEntry]] = None,
    base_defaults: Optional[Dict[str, Dict]] = None,
) -> Dict[str, RelationshipTypeDefEntry]:
    from .defaults import SYSTEM_RELATIONSHIP_TYPES  # local import
    defaults = base_defaults or SYSTEM_RELATIONSHIP_TYPES
    existing = existing_defs or {}
    result: Dict[str, RelationshipTypeDefEntry] = dict(existing)
    existing_lc = {k.lower() for k in result}

    for casefold, variants in _group_stats_by_casefold(edge_type_stats).items():
        if casefold in existing_lc:
            continue  # preserve user customisation (any case)
        rid = _canonical_stat_id(casefold, variants, defaults)
        if rid in defaults:
            rdef = _rel_def_from_dict(defaults[rid])
        else:
            rdef = RelationshipTypeDefEntry(
                name=_humanize(rid),
                description=f"Relationship type discovered in graph: {rid}",
            )
        rdef.description = _with_note(rdef.description, _also_seen_note(variants, rid))
        result[rid] = rdef

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def collect_merged_variants(
    stats: List[Any], defaults: Optional[Dict[str, Dict]] = None,
) -> Dict[str, List[dict]]:
    """Per canonical type id, the source spellings folded into it — ONLY for types the
    source spelled more than one way (Task E §1c). Mirrors the dedupe in
    :func:`suggest_relationship_defs_from_stats`, so the review UI can show each merge
    inline (``{canonical_id: [{"spelling", "count"}, …]}``) instead of only in prose."""
    out: Dict[str, List[dict]] = {}
    for casefold, variants in _group_stats_by_casefold(stats).items():
        if len(variants) < 2:
            continue
        cid = _canonical_stat_id(casefold, variants, defaults or {})
        out[cid] = [{"spelling": str(st.id), "count": int(getattr(st, "count", 0) or 0)}
                    for st in variants]
    return out


def _humanize(type_id: str) -> str:
    """Convert camelCase or UPPER_CASE type IDs to human-readable names."""
    import re
    # UPPER_CASE with underscores → Title Case
    if "_" in type_id:
        return type_id.replace("_", " ").title()
    # camelCase → insert spaces before uppercase letters
    spaced = re.sub(r"([A-Z])", r" \1", type_id).strip()
    return spaced[0].upper() + spaced[1:] if spaced else type_id
