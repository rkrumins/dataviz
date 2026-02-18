import asyncio
import logging
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.services.lineage_aggregator import LineageAggregator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def backfill():
    # define provider
    provider_name = os.getenv("GRAPH_PROVIDER", "falkordb").lower()
    if provider_name != "falkordb":
        logger.error("Backfill only supported for FalkorDB")
        return

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    aggregator = LineageAggregator(provider)
    
    logger.info("Starting Backfill...")
    
    # Ensure connection
    await provider._ensure_connected()
    
    # Get all lineage edges
    # We query for edges that are NOT CONTAINS and NOT AGGREGATED
    # Using raw cypher for efficiency
    
    # 1. Get total count
    count_res = await provider._graph.query(
        "MATCH ()-[r]->() WHERE NOT type(r) IN ['CONTAINS', 'BELONGS_TO', 'AGGREGATED'] RETURN count(r)"
    )
    total = count_res.result_set[0][0]
    logger.info(f"Found {total} granular lineage edges to process.")
    
    # 2. Iterate and materialize
    # Note: For massive graphs, we should use pagination (SKIP/LIMIT)
    # Fetching in batches of 1000
    
    batch_size = 1000
    processed = 0
    
    while processed < total:
        res = await provider._graph.query(
            f"MATCH (s)-[r]->(t) WHERE NOT type(r) IN ['CONTAINS', 'BELONGS_TO', 'AGGREGATED'] "
            f"RETURN s.urn, t.urn, type(r) SKIP {processed} LIMIT {batch_size}"
        )
        
        edges = res.result_set
        if not edges:
            break
            
        for row in edges:
            s_urn, t_urn, edge_type = row[0], row[1], row[2]
            success = await provider.materialize_lineage_for_edge(s_urn, t_urn, edge_type)
            if not success:
                logger.warning(f"Failed to aggregate {s_urn} -> {t_urn}")
        
        processed += len(edges)
        logger.info(f"Processed {processed}/{total} edges...")
        
    logger.info("Backfill complete!")

if __name__ == "__main__":
    asyncio.run(backfill())
