"""
Unit tests for backend/app/ontology/resolver.py — pure functions, no I/O.
"""
import pytest

from backend.app.ontology.resolver import (
    _find_containment_cycle,
    _humanize,
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
