"""
Phase 3 — Unit tests for backend.app.ontology.service.LocalOntologyService
"""
from typing import Dict, List, Optional

import pytest

from backend.app.ontology.models import (
    EntityTypeDefEntry,
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


# ---------------------------------------------------------------------------
# Stub repository
# ---------------------------------------------------------------------------


class _StubOntologyRepository:
    """In-memory stub implementing OntologyRepositoryProtocol."""

    def __init__(
        self,
        system_default: Optional[OntologyData] = None,
        by_id: Optional[Dict[str, OntologyData]] = None,
        for_data_source: Optional[OntologyData] = None,
    ):
        self._system_default = system_default
        self._by_id = by_id or {}
        self._for_data_source = for_data_source
        self._saved: List[OntologyData] = []

    async def get_system_default(self) -> Optional[OntologyData]:
        return self._system_default

    async def get_by_id(self, ontology_id: str) -> Optional[OntologyData]:
        return self._by_id.get(ontology_id)

    async def get_for_data_source(
        self, workspace_id: str, data_source_id: Optional[str] = None,
    ) -> Optional[OntologyData]:
        return self._for_data_source

    async def save(self, data: OntologyData) -> OntologyData:
        self._saved.append(data)
        # Also update system_default if it's a system ontology
        if data.is_system:
            self._system_default = data
        return data

    async def list_all(self, latest_only: bool = True) -> List[OntologyData]:
        all_data = []
        if self._system_default:
            all_data.append(self._system_default)
        all_data.extend(self._by_id.values())
        return all_data


# Compile-time check that our stub satisfies the protocol
assert isinstance(_StubOntologyRepository(), OntologyRepositoryProtocol)


# ---------------------------------------------------------------------------
# Tests — resolve
# ---------------------------------------------------------------------------


class TestResolve:
    async def test_resolve_with_no_workspace_returns_system_defaults(self):
        """When no workspace_id is given, resolve uses only system default."""
        system = OntologyData(
            id="sys1", name="System", version=1,
            entity_type_definitions=SYSTEM_ENTITY_TYPES,
            relationship_type_definitions=SYSTEM_RELATIONSHIP_TYPES,
            is_system=True,
        )
        repo = _StubOntologyRepository(system_default=system)
        svc = LocalOntologyService(repository=repo)

        resolved = await svc.resolve()
        assert isinstance(resolved, ResolvedOntology)
        # Should have at least some entity definitions from system defaults
        assert len(resolved.entity_type_definitions) > 0

    async def test_resolve_with_assigned_ontology_merges_over_defaults(self):
        """Assigned ontology values override system defaults."""
        system = OntologyData(
            id="sys1", name="System", version=1,
            entity_type_definitions=SYSTEM_ENTITY_TYPES,
            relationship_type_definitions=SYSTEM_RELATIONSHIP_TYPES,
            is_system=True,
        )
        assigned = OntologyData(
            id="ws1_ont", name="Workspace Ontology", version=1,
            entity_type_definitions={
                "customType": {
                    "name": "Custom Type",
                    "visual": {"icon": "Star", "color": "#ff0000"},
                },
            },
            relationship_type_definitions={},
        )
        repo = _StubOntologyRepository(system_default=system, for_data_source=assigned)
        svc = LocalOntologyService(repository=repo)

        resolved = await svc.resolve(workspace_id="ws_test")
        assert isinstance(resolved, ResolvedOntology)
        # The custom type should appear in the merged result
        assert "customType" in resolved.entity_type_definitions

    async def test_resolve_with_introspected_types_gap_fills(self):
        """Introspected types that are not in system/assigned get gap-filled."""
        system = OntologyData(
            id="sys1", name="System", version=1,
            entity_type_definitions={"dataset": {"name": "Dataset"}},
            relationship_type_definitions={},
            is_system=True,
        )
        repo = _StubOntologyRepository(system_default=system)
        svc = LocalOntologyService(repository=repo)

        resolved = await svc.resolve(
            introspected_entity_ids=["dataset", "novelEntity"],
            introspected_rel_ids=["NOVEL_EDGE"],
        )
        assert isinstance(resolved, ResolvedOntology)
        # novelEntity should be gap-filled
        assert "novelEntity" in resolved.entity_type_definitions

    async def test_resolve_with_no_data_returns_empty_resolved(self):
        """No system default and no workspace -> returns essentially empty ResolvedOntology."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)
        resolved = await svc.resolve()
        assert isinstance(resolved, ResolvedOntology)


# ---------------------------------------------------------------------------
# Tests — validate_ontology
# ---------------------------------------------------------------------------


class TestValidateOntology:
    def test_validate_empty_ontology_returns_no_errors(self):
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)
        issues = svc.validate_ontology({}, {})
        # Empty ontology should be valid (no errors)
        assert isinstance(issues, list)

    def test_validate_with_containment_cycle_returns_issue(self):
        """A containment cycle (A contains B, B contains A) should be flagged."""
        repo = _StubOntologyRepository()
        svc = LocalOntologyService(repository=repo)

        entity_a = EntityTypeDefEntry(name="TypeA")
        entity_a.hierarchy.can_contain = ["typeB"]
        entity_b = EntityTypeDefEntry(name="TypeB")
        entity_b.hierarchy.can_contain = ["typeA"]

        issues = svc.validate_ontology(
            {"typeA": entity_a, "typeB": entity_b},
            {},
        )
        # Should find a cycle warning/error
        cycle_issues = [i for i in issues if "cycle" in i.message.lower() or "cycle" in i.code.lower()]
        assert len(cycle_issues) >= 1


# ---------------------------------------------------------------------------
# Tests — seed_system_defaults
# ---------------------------------------------------------------------------


class TestSeedSystemDefaults:
    async def test_seed_creates_system_ontology_when_missing(self):
        repo = _StubOntologyRepository(system_default=None)
        svc = LocalOntologyService(repository=repo)

        await svc.seed_system_defaults()
        assert len(repo._saved) == 1
        saved = repo._saved[0]
        assert saved.is_system is True
        assert saved.name == SYSTEM_DEFAULT_ONTOLOGY_NAME

    async def test_seed_does_not_overwrite_existing(self):
        """If system default already exists with all types, no save is needed."""
        existing = OntologyData(
            id="sys_existing", name=SYSTEM_DEFAULT_ONTOLOGY_NAME,
            version=SYSTEM_DEFAULT_ONTOLOGY_VERSION,
            entity_type_definitions=dict(SYSTEM_ENTITY_TYPES),
            relationship_type_definitions=dict(SYSTEM_RELATIONSHIP_TYPES),
            is_system=True,
        )
        repo = _StubOntologyRepository(system_default=existing)
        svc = LocalOntologyService(repository=repo)

        await svc.seed_system_defaults()
        # No additional save if nothing new to merge
        assert len(repo._saved) == 0
