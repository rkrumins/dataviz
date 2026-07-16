"""
Unit tests for backend/app/ontology/resolver.py — pure functions, no I/O.
"""
import pytest

from backend.app.ontology.resolver import (
    _find_containment_cycle,
    _humanize,
    case_insensitive_type_id_collisions,
    check_coverage,
    derive_flat_lists,
    parse_entity_definitions,
    parse_relationship_definitions,
    resolve_ontology,
    validate_ontology,
)
from backend.app.ontology.models import (
    EntityTypeDefEntry,
    EntityHierarchyData,
    OntologyData,
    RelationshipTypeDefEntry,
)
from backend.app.ontology.defaults import SYSTEM_ENTITY_TYPES, SYSTEM_RELATIONSHIP_TYPES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_entity_def(name="Test", can_contain=None, can_be_contained_by=None) -> EntityTypeDefEntry:
    e = EntityTypeDefEntry(name=name)
    e.hierarchy.can_contain = can_contain or []
    e.hierarchy.can_be_contained_by = can_be_contained_by or []
    return e


def _make_rel_def(name="Edge", is_containment=False, is_lineage=False) -> RelationshipTypeDefEntry:
    r = RelationshipTypeDefEntry(name=name)
    r.is_containment = is_containment
    r.is_lineage = is_lineage
    return r


# ---------------------------------------------------------------------------
# _humanize
# ---------------------------------------------------------------------------


def test_humanize_camel_case():
    assert _humanize("dataJob") == "Data Job"


def test_humanize_upper_underscore():
    assert _humanize("FLOWS_TO") == "Flows To"


def test_humanize_single_word():
    # Single lowercase word gets its first letter capitalised
    assert _humanize("domain") == "Domain"


# ---------------------------------------------------------------------------
# parse_entity_definitions
# ---------------------------------------------------------------------------


def test_parse_system_entity_types_no_errors():
    result = parse_entity_definitions(SYSTEM_ENTITY_TYPES)
    assert "domain" in result
    assert "dataset" in result
    assert result["domain"].visual.icon == "FolderTree"
    assert result["dataset"].hierarchy.can_contain == ["schemaField", "column"]


def test_parse_relationship_definitions_no_errors():
    result = parse_relationship_definitions(SYSTEM_RELATIONSHIP_TYPES)
    assert "CONTAINS" in result
    assert result["CONTAINS"].is_containment is True
    assert result["FLOWS_TO"].is_lineage is True


# ---------------------------------------------------------------------------
# derive_flat_lists
# ---------------------------------------------------------------------------


def test_derive_flat_lists_classifies_containment_and_lineage():
    ent = {"domain": _make_entity_def("Domain", can_contain=["system"])}
    rel = {
        "CONTAINS": _make_rel_def("Contains", is_containment=True),
        "FLOWS_TO": _make_rel_def("Flows To", is_lineage=True),
    }
    flat = derive_flat_lists(ent, rel)
    assert "CONTAINS" in flat.containment_edge_types
    assert "FLOWS_TO" in flat.lineage_edge_types
    assert "domain" in flat.entity_type_hierarchy
    assert "domain" in flat.root_entity_types  # no can_be_contained_by


def test_derive_flat_lists_root_only_when_no_parent():
    ent = {
        "domain": _make_entity_def("Domain", can_be_contained_by=[]),
        "system": _make_entity_def("System", can_be_contained_by=["domain"]),
    }
    flat = derive_flat_lists(ent, {})
    assert "domain" in flat.root_entity_types
    assert "system" not in flat.root_entity_types


# ---------------------------------------------------------------------------
# resolve_ontology
# ---------------------------------------------------------------------------


def test_resolve_ontology_introspection_fills_gaps():
    resolved = resolve_ontology(
        system_default=None,
        assigned=None,
        introspected_entity_ids=["customType"],
        introspected_rel_ids=["CUSTOM_EDGE"],
    )
    assert "customType" in resolved.entity_type_definitions
    assert "CUSTOM_EDGE" in resolved.relationship_type_definitions
    assert resolved.resolution_sources.get("customType") == "introspection"


def test_resolve_ontology_assigned_overrides_system_default():
    sd = OntologyData(
        id="sd1", name="System Default", version=1,
        entity_type_definitions={"domain": {"name": "Domain (default)"}},
        relationship_type_definitions={},
    )
    assigned = OntologyData(
        id="a1", name="Assigned", version=1,
        entity_type_definitions={"domain": {"name": "Domain (override)"}},
        relationship_type_definitions={},
    )
    resolved = resolve_ontology(system_default=sd, assigned=assigned)
    assert resolved.entity_type_definitions["domain"].name == "Domain (override)"
    assert resolved.resolution_sources.get("domain") == "assigned"


def test_resolve_ontology_honors_persisted_containment_list_without_flag():
    # Regression (FalkorDB wizard flat-tree bug): a custom ontology recorded its
    # `containment_edge_types` list but the matching rel def did NOT carry
    # is_containment=True (default False). Re-deriving containment ONLY from the
    # per-rel flag drops the persisted list → empty containment → the structural
    # top-level query treats every node as parentless (flat 27-orphan tree),
    # while the cached-schema/canvas path (which reads the persisted list) nests.
    # resolve_ontology must UNION the persisted list so both agree.
    assigned = OntologyData(
        id="a1", name="Custom", version=1,
        entity_type_definitions={"layer": {"name": "Layer"}, "object": {"name": "Object"}},
        # rel def present but is_containment left at its False default — the trigger
        relationship_type_definitions={"CONTAINS": {"name": "Contains"}},
        containment_edge_types=["CONTAINS"],   # persisted list IS populated
    )
    resolved = resolve_ontology(system_default=None, assigned=assigned)
    assert "CONTAINS" in resolved.containment_edge_types


def test_resolve_ontology_honors_persisted_lineage_list_without_flag():
    assigned = OntologyData(
        id="a1", name="Custom", version=1,
        entity_type_definitions={},
        relationship_type_definitions={"FLOWS_TO": {"name": "Flows To"}},
        lineage_edge_types=["FLOWS_TO"],
    )
    resolved = resolve_ontology(system_default=None, assigned=assigned)
    assert "FLOWS_TO" in resolved.lineage_edge_types


def test_resolve_ontology_containment_from_flag_still_works():
    # The per-rel flag path must remain intact (union is additive, not a swap).
    assigned = OntologyData(
        id="a1", name="Custom", version=1,
        entity_type_definitions={},
        relationship_type_definitions={"OWNS": {"name": "Owns", "isContainment": True}},
    )
    resolved = resolve_ontology(system_default=None, assigned=assigned)
    assert "OWNS" in resolved.containment_edge_types


def test_resolve_ontology_reconciles_per_rel_flag_from_list():
    # When containment/lineage is declared via the persisted LIST only (the rel
    # def's flag left at its False default), the resolved rel def's
    # is_containment/is_lineage flag must be flipped to match — so per-edge
    # consumers (build_synthetic_schema's per-edge isContainment, the
    # Relationships panel, the commit gate's lineage check) agree with the
    # top-level list instead of diverging.
    assigned = OntologyData(
        id="a1", name="Custom", version=1,
        entity_type_definitions={"layer": {"name": "Layer"}, "object": {"name": "Object"}},
        relationship_type_definitions={
            "CONTAINS": {"name": "Contains"},   # flag defaults False
            "FLOWS_TO": {"name": "Flows To"},   # flag defaults False
        },
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS_TO"],
    )
    resolved = resolve_ontology(system_default=None, assigned=assigned)
    defs = {k.upper(): v for k, v in resolved.relationship_type_definitions.items()}
    assert defs["CONTAINS"].is_containment is True
    assert defs["CONTAINS"].is_lineage is False
    assert defs["FLOWS_TO"].is_lineage is True
    assert defs["FLOWS_TO"].is_containment is False


# ---------------------------------------------------------------------------
# validate_ontology — SHACL-lite checks
# ---------------------------------------------------------------------------


def test_validate_no_issues_for_valid_ontology():
    ent = parse_entity_definitions(SYSTEM_ENTITY_TYPES)
    rel = parse_relationship_definitions(SYSTEM_RELATIONSHIP_TYPES)
    issues = validate_ontology(ent, rel)
    errors = [i for i in issues if i.severity == "error"]
    assert not errors, f"Unexpected errors: {errors}"


def test_validate_detects_cycle():
    ent = {
        "A": _make_entity_def("A", can_contain=["B"]),
        "B": _make_entity_def("B", can_contain=["C"]),
        "C": _make_entity_def("C", can_contain=["A"]),  # cycle: A->B->C->A
    }
    issues = validate_ontology(ent, {})
    error_codes = {i.code for i in issues}
    assert "CONTAINMENT_CYCLE" in error_codes


def test_validate_detects_missing_name():
    ent = {"x": EntityTypeDefEntry(name="")}
    issues = validate_ontology(ent, {})
    assert any(i.code == "MISSING_NAME" for i in issues)


def test_validate_detects_unknown_type_ref():
    ent = {"A": _make_entity_def("A")}
    rel = {"EDGE": _make_rel_def("Edge", is_lineage=True)}
    rel["EDGE"].source_types = ["B"]  # B not in ent
    issues = validate_ontology(ent, rel)
    assert any(i.code == "UNKNOWN_TYPE" for i in issues)


# ---------------------------------------------------------------------------
# _find_containment_cycle (unit)
# ---------------------------------------------------------------------------


def test_find_cycle_returns_none_for_dag():
    graph = {"A": ["B", "C"], "B": ["D"], "C": ["D"], "D": []}
    assert _find_containment_cycle(graph) is None


def test_find_cycle_allows_self_loop():
    # Self-loops (e.g. "container can contain container") are valid recursive
    # structures in ontologies and should NOT be flagged as cycles.
    graph = {"A": ["A"]}
    cycle = _find_containment_cycle(graph)
    assert cycle is None


# ---------------------------------------------------------------------------
# check_coverage
# ---------------------------------------------------------------------------


def test_check_coverage_full_coverage():
    ent = {"A": _make_entity_def("A"), "B": _make_entity_def("B")}
    rel = {"EDGE": _make_rel_def("Edge")}
    report = check_coverage(ent, rel, ["A", "B"], ["EDGE"])
    assert report.coverage_percent == 100.0
    assert not report.uncovered_entity_types
    assert not report.uncovered_relationship_types


def test_check_coverage_partial():
    ent = {"A": _make_entity_def("A")}
    rel = {}
    report = check_coverage(ent, rel, ["A", "B"], ["EDGE"])
    assert report.uncovered_entity_types == ["B"]
    assert report.uncovered_relationship_types == ["EDGE"]
    assert 0 < report.coverage_percent < 100


def test_case_insensitive_type_id_collisions():
    # No collision when ids are distinct case-insensitively.
    assert case_insensitive_type_id_collisions(["System", "Dataset"], ["HAS", "FLOWS_TO"]) == []
    # Entity ids differing only by case → one message, WITH an explicit remedy.
    ent = case_insensitive_type_id_collisions(["Dataset", "dataset"], [])
    assert len(ent) == 1 and "Entity" in ent[0] and "case" in ent[0].lower()
    assert "rename" in ent[0] and "alias" in ent[0]
    # Edge ids (incl. containment/lineage lists folded into edge_ids by the caller) collide.
    edge = case_insensitive_type_id_collisions([], ["HAS", "has"])
    assert len(edge) == 1 and "Relationship" in edge[0]
    # Entity vs edge share a namespace boundary — an entity 'Has' and edge 'HAS' do NOT collide.
    assert case_insensitive_type_id_collisions(["Has"], ["HAS"]) == []


# ---------------------------------------------------------------------------
# suggest_*_from_stats — case-insensitive dedupe (authoring-guard safety)
# ---------------------------------------------------------------------------
from types import SimpleNamespace
from backend.app.ontology.resolver import (
    suggest_entity_defs_from_stats,
    suggest_relationship_defs_from_stats,
)


def _stat(sid, count=1, icon=None, color=None):
    return SimpleNamespace(id=sid, count=count, icon=icon, color=color)


def test_suggest_rel_defs_dedupe_prefers_defaults_casing():
    # graph carries both 'contains' and 'CONTAINS'; SYSTEM defaults declare 'CONTAINS' → ONE def.
    defs = suggest_relationship_defs_from_stats([_stat("contains", 3), _stat("CONTAINS", 1)])
    assert list(defs.keys()) == ["CONTAINS"]
    assert "also seen as: contains" in (defs["CONTAINS"].description or "")


def test_suggest_rel_defs_dedupe_by_majority_then_first_seen():
    # not in defaults → majority count wins…
    defs = suggest_relationship_defs_from_stats([_stat("knows", 2), _stat("KNOWS", 5)], base_defaults={})
    assert list(defs.keys()) == ["KNOWS"]
    assert "also seen as: knows" in defs["KNOWS"].description
    # …and a count tie falls back to first-seen.
    tie = suggest_relationship_defs_from_stats([_stat("owns", 1), _stat("OWNS", 1)], base_defaults={})
    assert list(tie.keys()) == ["owns"]


def test_suggest_rel_defs_dedupe_preserves_existing_any_case():
    existing = {"HAS": RelationshipTypeDefEntry(name="Has")}
    defs = suggest_relationship_defs_from_stats(
        [_stat("has", 9)], existing_defs=existing, base_defaults={})
    assert list(defs.keys()) == ["HAS"]     # existing kept; no lowercase variant added


def test_suggest_entity_defs_dedupe_case_insensitive():
    defs = suggest_entity_defs_from_stats([_stat("Layer", 4), _stat("layer", 1)], base_defaults={})
    assert list(defs.keys()) == ["Layer"]   # majority
    assert "also seen as: layer" in defs["Layer"].description


def test_suggest_defs_no_dedupe_when_distinct():
    defs = suggest_relationship_defs_from_stats([_stat("owns", 1), _stat("uses", 1)], base_defaults={})
    assert set(defs.keys()) == {"owns", "uses"}
    assert "also seen as" not in (defs["owns"].description or "")


def test_resolve_ontology_self_consistent_endpoint_constraints():
    """A relationship endpoint constraint referencing only entity types ABSENT from the
    ontology is unsatisfiable and must be treated as unrestricted (empty) — otherwise it
    silently blocks EVERY edge of that type (e.g. a system-default FLOWS_TO with dataset/
    dataJob endpoints on a manual ontology whose types are layer/object/group/attribute).
    Constraints that DO reference existing types keep exactly those (partial → subset),
    and self-consistent constraints are untouched."""
    assigned = OntologyData(
        id="o1", name="Manual", version=1,
        entity_type_definitions={
            "attribute": {"name": "Attribute"}, "object": {"name": "Object"},
            "layer": {"name": "Layer"}, "group": {"name": "Group"},
        },
        relationship_type_definitions={
            # all endpoints absent → relaxed to unrestricted
            "FLOWS_TO": {"name": "Flows To", "is_lineage": True,
                         "source_types": ["dataset", "dataJob", "column", "schemaField"],
                         "target_types": ["dataset", "dataJob", "column", "schemaField"]},
            # self-consistent → preserved verbatim
            "CONTAINS": {"name": "Contains", "is_containment": True,
                         "source_types": ["layer", "object"], "target_types": ["object", "attribute"]},
            # partial overlap → keep only the type that exists
            "LINKS": {"name": "Links", "is_lineage": True,
                      "source_types": ["dataset", "attribute"], "target_types": []},
        },
        containment_edge_types=["CONTAINS"], lineage_edge_types=["FLOWS_TO"],
    )
    r = resolve_ontology(None, assigned)
    ft = r.relationship_type_definitions["FLOWS_TO"]
    ct = r.relationship_type_definitions["CONTAINS"]
    lk = r.relationship_type_definitions["LINKS"]
    assert ft.source_types == [] and ft.target_types == []          # vacuous → unrestricted
    assert sorted(ct.source_types) == ["layer", "object"]           # consistent → kept
    assert sorted(ct.target_types) == ["attribute", "object"]
    assert lk.source_types == ["attribute"] and lk.target_types == []  # partial → subset


# ---------------------------------------------------------------------------
# infer_edge_classification — name heuristics for raw/introspected edges
# ---------------------------------------------------------------------------
from backend.app.ontology.resolver import infer_edge_classification


def test_infer_edge_classification_containment_tokens():
    assert infer_edge_classification("HAS") == (True, False)
    assert infer_edge_classification("has_column") == (True, False)
    assert infer_edge_classification("CONTAINS") == (True, False)
    assert infer_edge_classification("BELONGS_TO") == (True, False)
    assert infer_edge_classification("PART_OF") == (True, False)
    assert infer_edge_classification("parentOf") == (True, False)


def test_infer_edge_classification_lineage_tokens():
    assert infer_edge_classification("FLOWS_TO") == (False, True)
    assert infer_edge_classification("DERIVES_FROM") == (False, True)
    assert infer_edge_classification("feeds") == (False, True)
    assert infer_edge_classification("dataFlow") == (False, True)
    assert infer_edge_classification("DOWNSTREAM_OF") == (False, True)


def test_infer_edge_classification_whole_tokens_only():
    # Substrings must not match: HASH != HAS, INFORMS != IN.
    assert infer_edge_classification("HASH_KEY") == (False, False)
    assert infer_edge_classification("INFORMS") == (False, False)
    assert infer_edge_classification("RELATES_TO") == (False, False)


def test_infer_edge_classification_containment_wins_over_lineage():
    assert infer_edge_classification("HAS_OUTPUT") == (True, False)


def test_suggest_rel_defs_apply_name_heuristics():
    """Novel edge names (not in system defaults) are classified by name so a
    suggested ontology isn't dead-on-arrival at the resolution gate."""
    defs = suggest_relationship_defs_from_stats(
        [_stat("HAS_TABLE"), _stat("FEEDS"), _stat("RELATES_TO")], base_defaults={})
    assert defs["HAS_TABLE"].is_containment is True and defs["HAS_TABLE"].is_lineage is False
    assert defs["HAS_TABLE"].category == "structural"
    assert defs["FEEDS"].is_lineage is True and defs["FEEDS"].is_containment is False
    assert defs["FEEDS"].category == "flow"
    assert defs["RELATES_TO"].is_containment is False and defs["RELATES_TO"].is_lineage is False
    assert defs["RELATES_TO"].category == "association"
    assert "review before publishing" in (defs["FEEDS"].description or "")


def test_suggested_ontology_with_novel_edges_passes_resolution_gate():
    """suggest → gate round trip: a graph whose edge vocabulary contains a
    lineage-looking name must produce an ontology that resolves."""
    from backend.app.ontology.gate import check_resolution
    from backend.app.ontology.service import _rel_def_to_dict, _entity_def_to_dict

    ent_defs = suggest_entity_defs_from_stats([_stat("table"), _stat("job")], base_defaults={})
    rel_defs = suggest_relationship_defs_from_stats(
        [_stat("HAS_COLUMN"), _stat("FEEDS")], base_defaults={})

    report = check_resolution(
        ontology_id="bp_test", ontology_version=1, ontology_is_published=False,
        ontology_revision=0,
        entity_type_definitions_raw={k: _entity_def_to_dict(v) for k, v in ent_defs.items()},
        relationship_type_definitions_raw={k: _rel_def_to_dict(v) for k, v in rel_defs.items()},
        introspected_entity_ids=["table", "job"],
        introspected_edge_ids=["HAS_COLUMN", "FEEDS"],
    )
    assert report.has_lineage is True
    assert report.has_containment is True
    assert report.resolved is True
    assert report.blocking_reasons == []


# ---------------------------------------------------------------------------
# sync_hierarchy_from_relationships — entity hierarchy from containment rels
# ---------------------------------------------------------------------------
from backend.app.ontology.resolver import sync_hierarchy_from_relationships


def test_sync_hierarchy_adds_missing_entries():
    ents = {"table": {"name": "Table"}, "column": {"name": "Column"}}
    rels = {"HAS_COLUMN": {"name": "Has Column", "is_containment": True,
                           "source_types": ["table"], "target_types": ["column"]}}
    out = sync_hierarchy_from_relationships(ents, rels)
    assert out["table"]["hierarchy"]["can_contain"] == ["column"]
    assert out["column"]["hierarchy"]["can_be_contained_by"] == ["table"]


def test_sync_hierarchy_never_removes_user_entries():
    ents = {
        "table": {"name": "Table", "hierarchy": {"can_contain": ["partition"]}},
        "column": {"name": "Column"},
        "partition": {"name": "Partition"},
    }
    rels = {"HAS_COLUMN": {"name": "Has Column", "is_containment": True,
                           "source_types": ["table"], "target_types": ["column"]}}
    out = sync_hierarchy_from_relationships(ents, rels)
    assert set(out["table"]["hierarchy"]["can_contain"]) == {"partition", "column"}


def test_sync_hierarchy_ignores_empty_endpoints_and_non_containment():
    ents = {"table": {"name": "Table"}, "column": {"name": "Column"}}
    rels = {
        "HAS": {"name": "Has", "is_containment": True, "source_types": [], "target_types": []},
        "FLOWS": {"name": "Flows", "is_lineage": True,
                  "source_types": ["table"], "target_types": ["column"]},
    }
    out = sync_hierarchy_from_relationships(ents, rels)
    assert "hierarchy" not in out["table"] or not out["table"].get("hierarchy", {}).get("can_contain")


def test_sync_hierarchy_matches_case_insensitively_and_skips_undeclared():
    ents = {"Table": {"name": "Table"}, "Column": {"name": "Column"}}
    rels = {"HAS_COLUMN": {"name": "Has Column", "is_containment": True,
                           "source_types": ["table"], "target_types": ["column", "ghostType"]}}
    out = sync_hierarchy_from_relationships(ents, rels)
    assert out["Table"]["hierarchy"]["can_contain"] == ["Column"]
    assert out["Column"]["hierarchy"]["can_be_contained_by"] == ["Table"]


def test_sync_hierarchy_idempotent():
    ents = {"table": {"name": "Table"}, "column": {"name": "Column"}}
    rels = {"HAS_COLUMN": {"name": "Has Column", "is_containment": True,
                           "source_types": ["table"], "target_types": ["column"]}}
    once = sync_hierarchy_from_relationships(ents, rels)
    twice = sync_hierarchy_from_relationships(once, rels)
    assert twice["table"]["hierarchy"]["can_contain"] == ["column"]
