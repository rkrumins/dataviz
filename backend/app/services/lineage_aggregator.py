import logging
from typing import List, Optional, Set, Dict, Any
from ..providers.falkordb_provider import FalkorDBProvider
# Avoid circular import if possible, but context_engine is in same package
from .context_engine import context_engine
from ..models.graph import EdgeType, EntityType

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

# Singleton instance
# Dependency injection: we need the specific FalkorDB provider instance
# For now, we assume context_engine has it, or we instantiate it here.
# Since ContextEngine initializes the provider, we should probably access it via ContextEngine or separate DI.
# For simplicity in this codebase, we'll instantiate if needed or grab from a registry if available.

def get_aggregator():
    # Helper to get aggregator with the active provider
    if isinstance(context_engine.provider, FalkorDBProvider):
        return LineageAggregator(context_engine.provider)
    else:
        # If mock provider, return a dummy or the mock provider wrapper if it supports it
        # The user specifically asked for FalkorDB implementation
        return None
