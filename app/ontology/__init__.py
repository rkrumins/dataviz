"""
Ontology service package — manages versioned ontology definitions.

Architecture: Hexagonal (Ports & Adapters)
  - protocols.py: Service and repository ports (interfaces)
  - service.py: LocalOntologyService (concrete implementation)
  - resolver.py: Pure merge/derive/validate/suggest functions (no I/O)
  - defaults.py: System default entity/relationship definitions
  - models.py: Domain data classes
  - adapters/sqlalchemy_repo.py: SQLAlchemy repository implementation
"""

from .protocols import OntologyServiceProtocol, OntologyRepositoryProtocol
from .service import LocalOntologyService

__all__ = [
    "OntologyServiceProtocol",
    "OntologyRepositoryProtocol",
    "LocalOntologyService",
]
