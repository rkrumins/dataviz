"""
Port definitions (interfaces) for the ontology service.
Follows Hexagonal Architecture: these protocols separate domain from infrastructure.

OntologyRepositoryProtocol: driven port (persistence)
OntologyServiceProtocol: driving port (consumed by ContextEngine and API endpoints)
"""
from typing import Dict, List, Optional, Protocol, runtime_checkable

from .models import (
    CoverageReport,
    EntityTypeDefEntry,
    OntologyData,
    RelationshipTypeDefEntry,
    ResolvedOntology,
    ValidationIssue,
)
from backend.common.models.graph import GraphSchemaStats, OntologyMetadata
from backend.common.models.management import OntologyCreateRequest


@runtime_checkable
class OntologyRepositoryProtocol(Protocol):
    """
    Driven port for ontology persistence.
    Implemented by SQLAlchemyOntologyRepository now;
    can be implemented by an HTTP client adapter when the service is extracted.
    """

    async def get_system_default(self) -> Optional[OntologyData]: ...

    async def get_by_id(self, ontology_id: str) -> Optional[OntologyData]: ...

    async def get_for_data_source(
        self,
        workspace_id: str,
        data_source_id: Optional[str] = None,
    ) -> Optional[OntologyData]: ...

    async def save(self, data: OntologyData) -> OntologyData: ...

    async def list_all(self, latest_only: bool = True) -> List[OntologyData]: ...


@runtime_checkable
class OntologyServiceProtocol(Protocol):
    """
    Driving port consumed by ContextEngine and API endpoints.
    LocalOntologyService implements this; a future RemoteOntologyService (HTTP) would too.

    Design note: resolve() takes pre-fetched introspected data, NOT a provider.
    The caller is responsible for fetching graph introspection data.
    This keeps the ontology service completely decoupled from graph infrastructure.
    """

    async def resolve(
        self,
        workspace_id: Optional[str] = None,
        data_source_id: Optional[str] = None,
        introspected: Optional[OntologyMetadata] = None,
    ) -> ResolvedOntology: ...

    async def suggest_from_introspection(
        self,
        introspected_stats: GraphSchemaStats,
        introspected_ontology: OntologyMetadata,
        base_ontology_id: Optional[str] = None,
    ) -> OntologyCreateRequest: ...

    async def check_coverage(
        self,
        ontology_id: str,
        introspected_stats: GraphSchemaStats,
    ) -> CoverageReport: ...

    def validate_ontology(
        self,
        entity_defs: Dict[str, EntityTypeDefEntry],
        relationship_defs: Dict[str, RelationshipTypeDefEntry],
    ) -> List[ValidationIssue]: ...

    async def seed_system_defaults(self) -> None:
        """
        Ensure the system default ontology exists in DB.
        Uses merge-not-overwrite strategy: new types are added, existing types are kept.
        """
        ...
