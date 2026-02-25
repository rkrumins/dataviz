import asyncio
import logging
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def debug():
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    await provider._ensure_connected()
    
    # Check if ANY lineage edge exists
    # Find one sample edge to test with
    res = await provider._graph.query(
        "MATCH (s)-[r]->(t) WHERE NOT type(r) IN ['CONTAINS', 'BELONGS_TO', 'AGGREGATED'] RETURN s.urn, t.urn, type(r) LIMIT 1"
    )
    
    if not res.result_set:
        logger.error("No lineage edges found at all!")
        return
        
    s_urn, t_urn, edge_type = res.result_set[0]
    logger.info(f"Debugging Edge: {s_urn} -[{edge_type}]-> {t_urn}")
    
    # 1. Inspect Source Ancestors
    logger.info("--- Source Ancestors ---")
    res_s = await provider._graph.query(
        "MATCH (a)-[:CONTAINS*0..5]->(leaf {urn: $urn}) RETURN a.urn, a.entityType, labels(a)",
        params={"urn": s_urn}
    )
    for row in res_s.result_set:
        logger.info(f"  URN: {row[0]}, Type: {row[1]}, Labels: {row[2]}")
        
    # 2. Inspect Target Ancestors
    logger.info("--- Target Ancestors ---")
    res_t = await provider._graph.query(
        "MATCH (a)-[:CONTAINS*0..5]->(leaf {urn: $urn}) RETURN a.urn, a.entityType, labels(a)",
        params={"urn": t_urn}
    )
    for row in res_t.result_set:
        logger.info(f"  URN: {row[0]}, Type: {row[1]}, Labels: {row[2]}")
        
    # 3. Test Match Logic manually
    # Does s_anc.entityType = t_anc.entityType work?
    logger.info("--- Testing Match Logic ---")
    test_cypher = (
        "MATCH (s_leaf {urn: $sourceUrn}) "
        "MATCH (t_leaf {urn: $targetUrn}) "
        "MATCH (s_anc)-[:CONTAINS*0..5]->(s_leaf) "
        "MATCH (t_anc)-[:CONTAINS*0..5]->(t_leaf) "
        "WHERE s_anc.urn <> t_anc.urn "
        "AND s_anc.entityType = t_anc.entityType " 
        "RETURN s_anc.urn, t_anc.urn, s_anc.entityType"
    )
    
    res_match = await provider._graph.query(
        test_cypher,
        params={"sourceUrn": s_urn, "targetUrn": t_urn}
    )
    
    logger.info(f"MATCH found {len(res_match.result_set)} pairs:")
    for row in res_match.result_set:
        logger.info(f"  {row[0]} -> {row[1]} ({row[2]})")

if __name__ == "__main__":
    asyncio.run(debug())
