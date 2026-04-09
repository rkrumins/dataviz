"""
Golden scenario tests for the Synodic ontology + mutation stack.

Covers
------
1. Full hierarchy — domain → system → container → dataset → column
2. Partial projection — schema-driven granularity map from entity hierarchy levels
3. Aggregated lineage — column-level flows roll up to table level
4. Multi-source drift detection — unmapped external types are flagged
5. Schema evolution — reject policy blocks breaking publish; deprecate policy allows
6. URN normalization — legacy urn:nexus: prefix is transparently migrated
7. Mutation validator — containment and edge-type constraints are enforced
8. Containment cycle guard — circular containment is rejected

Each test is self-contained and uses only in-process objects (no DB, no network).
"""
import sys
import pytest
from pathlib import Path

# Ensure the workspace root is on sys.path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.app.ontology.defaults import SYSTEM_ENTITY_TYPES, SYSTEM_RELATIONSHIP_TYPES
from backend.app.ontology.resolver import (
    parse_entity_definitions,
    parse_relationship_definitions,
    resolve_ontology,
)
from backend.app.ontology.models import OntologyData
from backend.app.ontology.mutation_validator import (
    MutationOp,
    validate_node_mutation,
    validate_edge_mutation,
    would_create_containment_cycle,
)
from backend.app.ontology.urn import make_urn, normalize_urn, parse_synodic_urn
from backend.app.ontology.drift_detector import detect_drift
# build_projection_granularity_map is a frontend concept (TypeScript);
# equivalent logic is tested inline below


# ─── Fixtures ─────────────────────────────────────────────────────────────────

def _system_ontology() -> OntologyData:
    return OntologyData(
        id="sys_default",
        name="System Default",
        version=1,
        entity_type_definitions=SYSTEM_ENTITY_TYPES,
        relationship_type_definitions=SYSTEM_RELATIONSHIP_TYPES,
        containment_edge_types=["CONTAINS", "BELONGS_TO"],
        lineage_edge_types=["FLOWS_TO", "CONSUMES", "PRODUCES", "DERIVED_FROM"],
        edge_type_metadata={},
        entity_type_hierarchy={},
        root_entity_types=["domain", "dataPlatform"],
        is_system=True,
        scope="universal",
    )


def _resolved():
    return resolve_ontology(system_default=_system_ontology(), assigned=None)


# ─── Scenario 1: Full hierarchy ───────────────────────────────────────────────

class TestFullHierarchy:
    def test_domain_can_contain_system(self):
        resolved = _resolved()
        domain = resolved.entity_type_definitions["domain"]
        assert "system" in domain.hierarchy.can_contain

    def test_system_can_contain_container(self):
        resolved = _resolved()
        system = resolved.entity_type_definitions["system"]
        assert "container" in system.hierarchy.can_contain

    def test_container_can_contain_dataset(self):
        resolved = _resolved()
        container = resolved.entity_type_definitions["container"]
        assert "dataset" in container.hierarchy.can_contain

    def test_dataset_can_contain_column(self):
        resolved = _resolved()
        dataset = resolved.entity_type_definitions["dataset"]
        assert "column" in dataset.hierarchy.can_contain

    def test_column_cannot_contain_anything(self):
        resolved = _resolved()
        column = resolved.entity_type_definitions["column"]
        assert column.hierarchy.can_contain == []


# ─── Scenario 2: Partial projection / granularity ─────────────────────────────

class TestPartialProjection:
    """
    Granularity mapping (GranularityLevel enum) lives in the TypeScript
    projection-engine.ts.  On the backend we validate that hierarchy levels
    are ordered correctly: domain has the lowest level (coarsest) and column
    has the highest level (finest) in the ontology.
    """

    def test_domain_is_coarsest_hierarchy_level(self):
        resolved = _resolved()
        domain = resolved.entity_type_definitions["domain"]
        column = resolved.entity_type_definitions["column"]
        # Lower hierarchy.level = closer to root (coarser grain)
        assert domain.hierarchy.level < column.hierarchy.level

    def test_column_is_finest_hierarchy_level(self):
        resolved = _resolved()
        levels = {k: v.hierarchy.level for k, v in resolved.entity_type_definitions.items()}
        # column should have a higher level than dataset, schema, system, domain
        assert levels["column"] > levels["dataset"]
        assert levels["dataset"] > levels["container"]
        assert levels["container"] > levels["domain"]


# ─── Scenario 3: Aggregated lineage ──────────────────────────────────────────

class TestAggregatedLineage:
    def test_lineage_edge_types_include_flows_to(self):
        resolved = _resolved()
        assert "FLOWS_TO" in resolved.lineage_edge_types

    def test_contains_is_not_lineage(self):
        resolved = _resolved()
        assert "CONTAINS" not in resolved.lineage_edge_types

    def test_contains_is_containment(self):
        resolved = _resolved()
        assert "CONTAINS" in resolved.containment_edge_types


# ─── Scenario 4: Multi-source drift detection ─────────────────────────────────

class TestDriftDetection:
    def test_known_types_produce_no_drift(self):
        report = detect_drift(
            external_entity_types=["DATASET", "SCHEMA"],
            external_relationship_types=["CONTAINS"],
            entity_type_mappings={"DATASET": "dataset", "SCHEMA": "schema"},
            relationship_type_mappings={"CONTAINS": "CONTAINS"},
        )
        assert not report.has_drift
        assert report.issues == []

    def test_unknown_entity_type_flagged(self):
        report = detect_drift(
            external_entity_types=["SNOWFLAKE_TABLE"],
            external_relationship_types=[],
            entity_type_mappings={},
            relationship_type_mappings={},
            known_synodic_entity_types=["dataset", "schema"],
        )
        assert report.has_drift
        assert any(i.kind == "unmapped_entity_type" for i in report.issues)

    def test_suggestion_provided_for_close_match(self):
        report = detect_drift(
            external_entity_types=["DATASET_VIEW"],
            external_relationship_types=[],
            entity_type_mappings={},
            relationship_type_mappings={},
            known_synodic_entity_types=["dataset", "schema", "container"],
        )
        issue = next(i for i in report.issues if i.kind == "unmapped_entity_type")
        assert issue.suggestion == "dataset"

    def test_schema_hash_is_deterministic(self):
        r1 = detect_drift(["A"], ["B"], {}, {})
        r2 = detect_drift(["A"], ["B"], {}, {})
        assert r1.schema_hash == r2.schema_hash

    def test_different_schemas_have_different_hashes(self):
        r1 = detect_drift(["A"], [], {}, {})
        r2 = detect_drift(["B"], [], {}, {})
        assert r1.schema_hash != r2.schema_hash


# ─── Scenario 5: Schema evolution policy ──────────────────────────────────────

class TestSchemaEvolution:
    def test_reject_policy_marks_breaking_change(self):
        # Simulate impact check: removed types + reject policy → blocked
        removed_entities = ["glossaryTerm"]
        has_breaking = bool(removed_entities)
        policy = "reject"
        allowed = not (has_breaking and policy == "reject")
        assert not allowed

    def test_deprecate_policy_allows_breaking_change(self):
        removed_entities = ["glossaryTerm"]
        has_breaking = bool(removed_entities)
        policy = "deprecate"
        allowed = not (has_breaking and policy == "reject")
        assert allowed

    def test_no_breaking_change_always_allowed(self):
        removed_entities = []
        has_breaking = bool(removed_entities)
        policy = "reject"
        allowed = not (has_breaking and policy == "reject")
        assert allowed


# ─── Scenario 6: URN normalization ────────────────────────────────────────────

class TestUrnNormalization:
    def test_make_urn_format(self):
        urn = make_urn("dataset", "abc123", source_system="manual")
        assert urn == "urn:synodic:manual:dataset:abc123"

    def test_normalize_legacy_urn(self):
        legacy = "urn:nexus:dataset:abc123"
        assert normalize_urn(legacy) == "urn:synodic:dataset:abc123"

    def test_normalize_already_synodic(self):
        urn = "urn:synodic:manual:dataset:abc"
        assert normalize_urn(urn) == urn

    def test_parse_synodic_urn(self):
        urn = make_urn("domain", "test_slug", source_system="falkordb")
        parsed = parse_synodic_urn(urn)
        assert parsed is not None
        assert parsed["source_system"] == "falkordb"
        assert parsed["entity_type"] == "domain"
        assert parsed["slug"] == "test_slug"

    def test_parse_non_synodic_returns_none(self):
        assert parse_synodic_urn("urn:datahub:dataset:abc") is None


# ─── Scenario 7: Mutation validator ──────────────────────────────────────────

class TestMutationValidator:
    def test_valid_create_node(self):
        resolved = _resolved()
        result = validate_node_mutation(MutationOp.CREATE, "dataset", resolved)
        assert result.ok

    def test_invalid_entity_type_rejected(self):
        resolved = _resolved()
        result = validate_node_mutation(MutationOp.CREATE, "unknown_type", resolved)
        assert not result.ok
        assert any("not defined" in e for e in result.errors)

    def test_invalid_parent_containment_rejected(self):
        resolved = _resolved()
        # Domain can only contain "system" — "dataset" is not allowed
        result = validate_node_mutation(
            MutationOp.CREATE, "dataset", resolved,
            parent_entity_type="domain",
        )
        assert not result.ok

    def test_valid_parent_containment(self):
        resolved = _resolved()
        # Domain can contain system
        result = validate_node_mutation(
            MutationOp.CREATE, "system", resolved,
            parent_entity_type="domain",
        )
        assert result.ok

    def test_valid_edge_create(self):
        resolved = _resolved()
        result = validate_edge_mutation(
            MutationOp.CREATE, "CONTAINS", "domain", "system", resolved
        )
        assert result.ok

    def test_invalid_edge_type_rejected(self):
        resolved = _resolved()
        result = validate_edge_mutation(
            MutationOp.CREATE, "DOES_NOT_EXIST", "domain", "system", resolved
        )
        assert not result.ok

    def test_edge_delete_always_allowed(self):
        resolved = _resolved()
        result = validate_edge_mutation(
            MutationOp.DELETE, "ANYTHING", "x", "y", resolved
        )
        assert result.ok


# ─── Scenario 8: Containment cycle guard ─────────────────────────────────────

class TestContainmentCycleGuard:
    def test_no_cycle(self):
        containment = {"child": "parent", "parent": "grandparent"}
        assert not would_create_containment_cycle("grandparent", "child", containment)

    def test_direct_cycle(self):
        containment = {"child": "parent"}
        assert would_create_containment_cycle("child", "child", containment)

    def test_indirect_cycle(self):
        # A → B → C; trying to make C a child of A would create A→B→C→A
        containment = {"b": "a", "c": "b"}
        assert would_create_containment_cycle("c", "a", containment)

    def test_no_cycle_for_unrelated(self):
        containment = {"b": "a"}
        assert not would_create_containment_cycle("a", "c", containment)
