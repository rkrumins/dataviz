"""Provider-agnostic contract for advanced search.

The service layer (``advanced_search_service.py``) and the HTTP layer
(``api/v1/endpoints/graph.py``) bind against this Protocol — never
against the FalkorDB implementation module directly. New providers
(Neo4j, Spanner, in-memory stub) implement the same three async
methods and slot in via the existing ``GraphDataProvider`` DI.

The Cypher dialect itself stays in each provider module; abstracting
it would be over-engineering (per the project CLAUDE.md). What the
service needs is a stable surface for the three operations search
performs:

  * ``deep_search``           — execute a SearchQuery, return a page
  * ``deep_search_explain``   — compile-only, return Cypher + params
  * ``deep_search_discover``  — sample the graph, return queryable
                                property/tag/edge metadata

``CompileError`` lives here so the service layer can ``except`` it
without importing from any provider module. Each provider re-exports
the same symbol.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Protocol, runtime_checkable

from backend.common.models.search import SearchQuery, SearchResultPage


class CompileError(ValueError):
    """Raised when a predicate cannot be compiled in v1.

    Provider-agnostic: any deep-search backend may raise this when it
    encounters an unsupported predicate shape. Service layer translates
    to HTTP 400 with the message intact — the message is user-facing
    and tells the caller which feature to use instead.
    """


@runtime_checkable
class DeepSearchProvider(Protocol):
    """Minimal contract for hosting ``/search/advanced``.

    Implementations live alongside their graph adapter (FalkorDB:
    ``backend/app/providers/falkordb_provider.py``; stub:
    ``backend/graph/adapters/stub_provider.py``). The service layer
    treats every provider through this Protocol — no FalkorDB-specific
    imports leak past ``advanced_search_service``.
    """

    async def deep_search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> SearchResultPage:
        """Execute a SearchQuery and return the page."""
        ...

    async def deep_search_explain(self, query: SearchQuery) -> Dict[str, Any]:
        """Compile-only path. Returns ``{cypher, hits_cypher, params,
        candidate_cap, hoisted_root_urns, effective_root_urns, notes}``.
        Used by ``POST /search/explain`` and the FE dev panel.
        """
        ...

    async def deep_search_discover(
        self,
        *,
        sample_per_label: int = 200,
    ) -> Dict[str, Any]:
        """Schema discovery. Returns ``{labels, blobOnlyLabels,
        missingContainment, tagValues, edges, elapsedMs}``. Powers the
        FE's property / value / tag / edge pickers.
        """
        ...
