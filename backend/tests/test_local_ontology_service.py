"""
Unit tests for backend.app.ontology.service.LocalOntologyService

Covers:
- resolve() three-layer merge (system + assigned + introspected)
- suggest_from_introspection()
- check_coverage()
- validate_ontology()
- seed_system_defaults() merge-not-overwrite strategy
"""
from typing import Dict, List, Optional

import pytest

from backend.app.ontology.models import (
    CoverageReport,
    EntityTypeDefEntry,
    EntityHierarchyData,
    OntologyData,
    RelationshipTypeDefEntry,
    ResolvedOntology,
    ValidationIssue,
)
from backend.app.ontology.protocols import OntologyRepositoryProtocol
from backend.app.ontology.service import LocalOntologyService
from backend.app.ontology.defaults import (
    SYSTEM_DEFAULT_ONTOLOGY_NAME,
    SYSTEM_DEFAULT_ONTOLOGY_VERSION,
    SYSTEM_ENTITY_TYPES,
    SYSTEM_RELATIONSHIP_TYPES,
)
from backend.common.models.graph import (
    EntityTypeSummary,
    EdgeTypeSummary,
    GraphSchemaStats,
    OntologyMetadata,
)


# ---------------------------------------------------------------------------
# Stub repository (matches project pattern — no unittest.mock)
# ---------------------------------------------------------------------------


class _StubOntologyRepository:
    """In-memory stub implementing OntologyRepositoryProtocol."""

    def __init__(
        self,
        system_default: Optional[OntologyData] = None,
        by_id: Optional[Dict[str, OntologyData]] = None,
        for_data_source: Optional[OntologyData] = None,
        for_data_source_error: bool = False,
    ):
        self._system_default = system_default
        self._by_id = by_id or {}
        self._for_data_source = for_data_source
        self._for_data_source_error = for_data_source_error
        self._saved: List[OntologyData] = []

    async def get_system_default(self) -> Optional[OntologyData]:
        return self._system_default

    async def get_by_id(self, ontology_id: str) -> Optional[OntologyData]:
        return self._by_id.get(ontology_id)

    async def get_for_data_source(
        self, workspace_id: str, data_source_id: Optional[str] = None,
    ) -> Optional[OntologyData]:
        if self._for_data_source_error:
            raise RuntimeError("Simulated DB error")
        return self._for_data_source

    async def save(self, data: OntologyData) -> OntologyData:
        self._saved.append(data)
        if data.is_system:
            self._system_default = data
        return data

    async def list_all(self, latest_only: bool = True) -> List[OntologyData]:
        all_data = []
        if self._system_default:
            all_data.append(self._system_default)
        all_data.extend(self._by_id.values())
        return all_data


# Compile-time protocol check
assert isinstance(_StubOntologyRepository(), OntologyRepositoryProtocol)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _minimal_system_ontology() -> OntologyData:
    return OntologyData(
        id="sys1", name="System", version=1,
        entity_type_definitions={
            "dataset": {"name": "Dataset", "plural_name": "Datasets"},
            "container": {"name": "Container", "plural_name": "Containers"},
        },
        relationship_type_definitions={
            "CONTAINS": {
                "name": "Contains",
                "is_containment": True,
                "category": "structural",
            },
        },
        is_system=True,
    )


def _make_schema_stats(
    entity_ids: List[str],
    edge_ids: List[str],
) -> GraphSchemaStats:
    return GraphSchemaStats(
        totalNodes=len(entity_ids),
        totalEdges=len(edge_ids),
        entityTypeStats=[
            EntityTypeSummary(id=eid, name=eid, count=10) for eid in entity_ids
        ],
        edgeTypeStats=[
            EdgeTypeSummary(id=eid, name=eid, count=5) for eid in edge_ids
        ],
    )


def _make_ontology_metadata() -> OntologyMetadata:
    return OntologyMetadata(
        containmentEdgeTypes=["CONTAINS"],
        lineageEdgeTypes=["TRANSFORMS"],
        edgeTypeMetadata={},
        entityTypeHierarchy={},
        rootEntityTypes=[],
    )


# ---------------------------------------------------------------------------
# Tests — resolve (three-layer merge)
# ---------------------------------------------------------------------------


class TestResolveThreeLayerMerge:
    """Test the full three-layer merge logic in resolve()."""

    async def test_resolve_system_only(self):
        """With no workspace_id, only system defaults are used."""
        repo = _StubOntologyRepository(system_default=_minimal_system_ontology())
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve()

        assert isinstance(resolved, ResolvedOntology)
        assert "dataset" in resolved.entity_type_definitions
        assert "CONTAINS" in resolved.relationship_type_definitions
        # All sources should be "system_default"
        for src in resolved.resolution_sources.values():
            assert src == "system_default"

    async def test_resolve_assigned_replaces_system_entirely(self):
        """When an assigned ontology exists, system defaults are gated
        out — the assigned ontology defines the full namespace. See
        ``LocalOntologyService.resolve`` (service.py:82-87): system
        defaults are an opt-in fallback only when ``assigned is None``,
        deliberately so they don't pollute custom workspace ontologies."""
        system = _minimal_system_ontology()
        assigned = OntologyData(
            id="ws_ont", name="WS Ontology", version=1,
            entity_type_definitions={
                "dataset": {
                    "name": "Custom Dataset",
                    "visual": {"icon": "Database", "color": "#ff0000"},
                },
            },
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(system_default=system, for_data_source=assigned)
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve(workspace_id="ws_test")

        # dataset comes from the assigned layer.
        assert resolved.entity_type_definitions["dataset"].name == "Custom Dataset"
        assert resolved.resolution_sources["dataset"] == "assigned"
        # container is NOT pulled from system_default — assigned gates it out.
        assert "container" not in resolved.entity_type_definitions

    async def test_resolve_introspection_gap_fills(self):
        """Introspected types not in system or assigned get synthetic defs."""
        system = _minimal_system_ontology()
        repo = _StubOntologyRepository(system_default=system)
        svc = LocalOntologyService(repository=repo)

        resolved = await svc.resolve(
            introspected_entity_ids=["dataset", "novelEntity"],
            introspected_rel_ids=["NOVEL_EDGE"],
        )

        # dataset already in system — should NOT be introspection
        assert resolved.resolution_sources["dataset"] == "system_default"
        # novelEntity is new — gap-filled from introspection
        assert "novelEntity" in resolved.entity_type_definitions
        assert resolved.resolution_sources["novelEntity"] == "introspection"
        # NOVEL_EDGE is new
        assert "NOVEL_EDGE" in resolved.relationship_type_definitions
        assert resolved.resolution_sources["NOVEL_EDGE"] == "introspection"

    async def test_resolve_no_data_returns_empty(self):
        """No system default and no workspace — empty ResolvedOntology."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve()

        assert isinstance(resolved, ResolvedOntology)
        assert len(resolved.entity_type_definitions) == 0

    async def test_resolve_data_source_error_falls_back_to_system(self):
        """When get_for_data_source raises, resolve gracefully falls back to system."""
        system = _minimal_system_ontology()
        repo = _StubOntologyRepository(
            system_default=system,
            for_data_source_error=True,
        )
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve(workspace_id="ws_broken")

        # Should still have system defaults
        assert "dataset" in resolved.entity_type_definitions
        assert resolved.resolution_sources["dataset"] == "system_default"

    async def test_resolve_without_workspace_skips_assigned_lookup(self):
        """If no workspace_id, get_for_data_source should NOT be called."""
        assigned = OntologyData(
            id="assigned_1", name="Assigned", version=1,
            entity_type_definitions={"customType": {"name": "Custom"}},
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(
            system_default=_minimal_system_ontology(),
            for_data_source=assigned,
        )
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve()  # no workspace_id

        # customType should NOT appear because workspace_id was not provided
        assert "customType" not in resolved.entity_type_definitions

    async def test_resolve_derived_lists_populated(self):
        """Derived flat lists (containment, lineage, etc.) should be computed."""
        system = _minimal_system_ontology()
        repo = _StubOntologyRepository(system_default=system)
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve()

        assert "CONTAINS" in resolved.containment_edge_types
        assert "dataset" in resolved.root_entity_types or "container" in resolved.root_entity_types


# ---------------------------------------------------------------------------
# Tests — suggest_from_introspection
# ---------------------------------------------------------------------------


class TestSuggestFromIntrospection:

    async def test_suggest_builds_create_request(self):
        """suggest_from_introspection produces a valid OntologyCreateRequest."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(
            entity_ids=["dataset", "pipeline"],
            edge_ids=["CONTAINS", "TRANSFORMS"],
        )
        metadata = _make_ontology_metadata()

        result = await svc.suggest_from_introspection(stats, metadata)

        assert result.name == "Suggested Ontology (from graph introspection)"
        assert result.scope == "workspace"
        assert "dataset" in result.entity_type_definitions or "pipeline" in result.entity_type_definitions

    async def test_suggest_preserves_base_ontology_defs(self):
        """When base_ontology_id is given, existing defs are preserved."""
        base = OntologyData(
            id="base_1", name="Base", version=1,
            entity_type_definitions={
                "dataset": {
                    "name": "My Custom Dataset",
                    "visual": {"icon": "Star", "color": "#00ff00"},
                },
            },
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(by_id={"base_1": base})
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(
            entity_ids=["dataset", "newType"],
            edge_ids=[],
        )
        metadata = _make_ontology_metadata()

        result = await svc.suggest_from_introspection(stats, metadata, base_ontology_id="base_1")

        # Both types should be present
        assert "dataset" in result.entity_type_definitions
        assert "newType" in result.entity_type_definitions

    async def test_suggest_with_nonexistent_base_id(self):
        """Missing base_ontology_id is handled gracefully."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(entity_ids=["typeA"], edge_ids=[])
        metadata = _make_ontology_metadata()

        result = await svc.suggest_from_introspection(stats, metadata, base_ontology_id="nonexistent")
        assert "typeA" in result.entity_type_definitions

    async def test_suggest_with_empty_stats(self):
        """Empty graph schema stats produce a valid but minimal request."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(entity_ids=[], edge_ids=[])
        metadata = _make_ontology_metadata()

        result = await svc.suggest_from_introspection(stats, metadata)
        assert result.name == "Suggested Ontology (from graph introspection)"


# ---------------------------------------------------------------------------
# Tests — check_coverage
# ---------------------------------------------------------------------------


class TestCheckCoverage:

    async def test_full_coverage(self):
        """All graph types are in the ontology -> 100% coverage."""
        ontology = OntologyData(
            id="ont_1", name="Full", version=1,
            entity_type_definitions={
                "dataset": {"name": "Dataset"},
                "pipeline": {"name": "Pipeline"},
            },
            relationship_type_definitions={
                "CONTAINS": {"name": "Contains"},
            },
        )
        repo = _StubOntologyRepository(by_id={"ont_1": ontology})
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(
            entity_ids=["dataset", "pipeline"],
            edge_ids=["CONTAINS"],
        )
        report = await svc.check_coverage("ont_1", stats)

        assert isinstance(report, CoverageReport)
        assert report.coverage_percent == 100.0
        assert len(report.uncovered_entity_types) == 0
        assert len(report.uncovered_relationship_types) == 0

    async def test_partial_coverage(self):
        """Only some graph types are in the ontology."""
        ontology = OntologyData(
            id="ont_2", name="Partial", version=1,
            entity_type_definitions={"dataset": {"name": "Dataset"}},
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(by_id={"ont_2": ontology})
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(
            entity_ids=["dataset", "unknown_type"],
            edge_ids=["UNKNOWN_EDGE"],
        )
        report = await svc.check_coverage("ont_2", stats)

        assert report.coverage_percent < 100.0
        assert "unknown_type" in report.uncovered_entity_types
        assert "UNKNOWN_EDGE" in report.uncovered_relationship_types

    async def test_coverage_with_nonexistent_ontology_returns_zero(self):
        """If ontology_id doesn't exist, return 0% coverage."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(entity_ids=["dataset"], edge_ids=[])
        report = await svc.check_coverage("nonexistent", stats)

        assert report.coverage_percent == 0.0

    async def test_coverage_extra_types_tracked(self):
        """Types in ontology but not in graph are extra_entity_types."""
        ontology = OntologyData(
            id="ont_3", name="Extra", version=1,
            entity_type_definitions={
                "dataset": {"name": "Dataset"},
                "obsolete_type": {"name": "Obsolete"},
            },
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(by_id={"ont_3": ontology})
        svc = LocalOntologyService(repository=repo)

        stats = _make_schema_stats(entity_ids=["dataset"], edge_ids=[])
        report = await svc.check_coverage("ont_3", stats)

        assert "obsolete_type" in report.extra_entity_types


# ---------------------------------------------------------------------------
# Tests — validate_ontology
# ---------------------------------------------------------------------------


class TestValidateOntology:

    def test_valid_ontology_returns_no_issues(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        entity_defs = {
            "dataset": EntityTypeDefEntry(name="Dataset", plural_name="Datasets"),
        }
        rel_defs = {
            "CONTAINS": RelationshipTypeDefEntry(
                name="Contains",
                source_types=["dataset"],
                target_types=["dataset"],
            ),
        }
        issues = svc.validate_ontology(entity_defs, rel_defs)
        assert isinstance(issues, list)
        # No errors expected
        errors = [i for i in issues if i.severity == "error"]
        assert len(errors) == 0

    def test_missing_name_flagged(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        entity_defs = {"noname": EntityTypeDefEntry()}  # name defaults to ""
        issues = svc.validate_ontology(entity_defs, {})

        name_issues = [i for i in issues if i.code == "MISSING_NAME"]
        assert len(name_issues) >= 1

    def test_containment_cycle_detected(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        entity_a = EntityTypeDefEntry(name="TypeA")
        entity_a.hierarchy.can_contain = ["typeB"]
        entity_b = EntityTypeDefEntry(name="TypeB")
        entity_b.hierarchy.can_contain = ["typeA"]

        issues = svc.validate_ontology({"typeA": entity_a, "typeB": entity_b}, {})

        cycle_issues = [i for i in issues if i.code == "CONTAINMENT_CYCLE"]
        assert len(cycle_issues) == 1
        assert cycle_issues[0].severity == "error"

    def test_unknown_source_type_flagged(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        rel_defs = {
            "LINKS": RelationshipTypeDefEntry(
                name="Links",
                source_types=["nonexistent"],
                target_types=[],
            ),
        }
        issues = svc.validate_ontology({}, rel_defs)

        unknown_issues = [i for i in issues if i.code == "UNKNOWN_TYPE"]
        assert len(unknown_issues) >= 1

    def test_self_containment_is_not_a_cycle(self):
        """Self-loops (A can_contain A) are intentional and not flagged as cycles."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        entity_a = EntityTypeDefEntry(name="Folder")
        entity_a.hierarchy.can_contain = ["folder"]

        issues = svc.validate_ontology({"folder": entity_a}, {})

        cycle_issues = [i for i in issues if i.code == "CONTAINMENT_CYCLE"]
        assert len(cycle_issues) == 0


# ---------------------------------------------------------------------------
# Tests — seed_system_defaults
# ---------------------------------------------------------------------------


class TestSeedSystemDefaults:

    async def test_seed_creates_when_missing(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        await svc.seed_system_defaults()

        assert len(repo._saved) == 1
        saved = repo._saved[0]
        assert saved.is_system is True
        assert saved.name == SYSTEM_DEFAULT_ONTOLOGY_NAME
        assert saved.id.startswith("bp_")

    async def test_seed_merges_new_types(self):
        """If system default exists but is missing new keys, they get merged."""
        existing = OntologyData(
            id="sys_old", name=SYSTEM_DEFAULT_ONTOLOGY_NAME,
            version=SYSTEM_DEFAULT_ONTOLOGY_VERSION,
            entity_type_definitions={"dataset": {"name": "Dataset"}},
            relationship_type_definitions={},
            is_system=True,
        )
        repo = _StubOntologyRepository(system_default=existing)
        svc = LocalOntologyService(repository=repo)

        await svc.seed_system_defaults()

        # Should have saved a merged version (system defaults have more types than just "dataset")
        if len(SYSTEM_ENTITY_TYPES) > 1 or len(SYSTEM_RELATIONSHIP_TYPES) > 0:
            assert len(repo._saved) == 1
            saved = repo._saved[0]
            assert saved.id == "sys_old"  # Same ID, updated in place

    async def test_seed_does_not_overwrite_existing_complete(self):
        """If system default already has all types, no save is issued."""
        existing = OntologyData(
            id="sys_complete", name=SYSTEM_DEFAULT_ONTOLOGY_NAME,
            version=SYSTEM_DEFAULT_ONTOLOGY_VERSION,
            entity_type_definitions=dict(SYSTEM_ENTITY_TYPES),
            relationship_type_definitions=dict(SYSTEM_RELATIONSHIP_TYPES),
            is_system=True,
        )
        repo = _StubOntologyRepository(system_default=existing)
        svc = LocalOntologyService(repository=repo)

        await svc.seed_system_defaults()

        assert len(repo._saved) == 0
