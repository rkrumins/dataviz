import logging
from typing import List, Optional, Set, Dict, Any

from backend.common.interfaces.provider import (
    GraphDataProvider, ProviderFeature, supports_feature,
)

logger = logging.getLogger(__name__)

class LineageAggregator:
    def __init__(self, provider: GraphDataProvider):
        self.provider = provider
        
    async def materialize_lineage(self, source_urn: str, target_urn: str, lineage_edge_type: str = "TRANSFORMS"):
        """
        Triggered when a granular lineage edge is created (e.g., Column -> Column).
        Ascends the containment hierarchy and creates AGGREGATED edges between structural parents.
        
        Args:
            source_urn: The URN of the source granular entity (e.g., Column A)
            target_urn: The URN of the target granular entity (e.g., Column B)
            lineage_edge_type: The type of the underlying lineage edge (e.g. TRANSFORMS)
        """
        # We delegate the heavy lifting to the provider which executes the optimized Cypher
        # This keeps the service layer clean and the database logic encapsulated
        await self.provider.materialize_lineage_for_edge(source_urn, target_urn, lineage_edge_type)

    async def backfill_all_lineage(self):
        """
        Utility to re-scan all lineage edges and re-materialize aggregation.
        Useful for migration or repair.
        """
        logger.info("Starting aggregation backfill...")
        # This would likely need batching in a real scenario
        # We will implement this in the provider or a script
        pass

def get_aggregator(provider: Optional[GraphDataProvider]):
    """Return an aggregator for a provider capable of materializing
    AGGREGATED edges itself, or None.

    Was ``isinstance(provider, FalkorDBProvider)`` — a name-based check that
    could never recognize a second provider with the same capability (PR 3's
    ArcadeDB). Replaced with the catalog's own feature check, the same one
    ``ContextEngine.materialize_aggregated_edges`` gates on. No production
    caller today (grep confirms); kept for scripts / future callers.
    """
    if supports_feature(provider, ProviderFeature.AGGREGATION_MATERIALIZATION):
        return LineageAggregator(provider)
    return None
