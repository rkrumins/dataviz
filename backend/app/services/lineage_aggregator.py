import logging
from typing import List, Optional, Set, Dict, Any
from ..providers.falkordb_provider import FalkorDBProvider

logger = logging.getLogger(__name__)

class LineageAggregator:
    def __init__(self, provider: FalkorDBProvider):
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

def get_aggregator(provider: Optional[FalkorDBProvider]):
    """Return an aggregator for an explicit FalkorDB provider instance."""
    if isinstance(provider, FalkorDBProvider):
        return LineageAggregator(provider)
    return None
