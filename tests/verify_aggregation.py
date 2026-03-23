import asyncio
import logging
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def verify():
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    await provider._ensure_connected()
    
    logger.info("Verifying Aggregated Edges...")
    
    # Check if ANY aggregated edges exist
    res = await provider._graph.query(
        "MATCH ()-[r:AGGREGATED]->() RETURN count(r)"
    )
    count = res.result_set[0][0]
    logger.info(f"Total AGGREGATED edges: {count}")
    
    if count == 0:
        logger.error("No AGGREGATED edges found! Backfill failed or no structural matching happened.")
        return

    # Check a specific expected aggregation if possible
    # Check Table -> Table (most common)
    res = await provider._graph.query(
        "MATCH (s)-[r:AGGREGATED]->(t) WHERE labels(s) <> labels(t) RETURN count(r)"
    )
    mismatch_count = res.result_set[0][0]
    if mismatch_count > 0:
        logger.warning(f"Found {mismatch_count} AGGREGATED edges between mismatched types!")

    # Check valid Table-Table
    res = await provider._graph.query(
        "MATCH (s)-[r:AGGREGATED]->(t) WHERE labels(s) = labels(t) RETURN count(r)"
    )
    valid_count = res.result_set[0][0]
    logger.info(f"Same-Label AGGREGATED edges: {valid_count}")
    
    # Check properties
    res = await provider._graph.query(
        "MATCH ()-[r:AGGREGATED]->() RETURN r.weight, r.sourceEdgeTypes LIMIT 5"
    )
    logger.info("Sample edge properties:")
    for row in res.result_set:
        logger.info(f"Weight: {row[0]}, Types: {row[1]}")

if __name__ == "__main__":
    asyncio.run(verify())
