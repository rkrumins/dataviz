import asyncio
import logging
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def verify_scenarios():
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    await provider._ensure_connected()
    
    # helper to print results
    def log_results(title, res):
        logger.info(f"\n--- {title} ---")
        if not res.result_set:
            logger.info("No results found.")
            return
        for row in res.result_set[:5]:
            logger.info(f"  {row}")
        if len(res.result_set) > 5:
            logger.info(f"  ... and {len(res.result_set) - 5} more.")

    # 1. Which of all the datasets that a given column has lineage to?
    # Strategy: Column -> (Lineage) -> Column -> (Parent) -> Table
    # Optimized: We use the fine-grained lineage for the column, then hop up to table.
    # We find a random column that has lineage first.
    logger.info("Finding a sample column with lineage...")
    s_col_res = await provider._graph.query(
        "MATCH (s)-[:TRANSFORMS]->(t) RETURN s.urn LIMIT 1"
    )
    if s_col_res.result_set:
        sample_col_urn = s_col_res.result_set[0][0]
        logger.info(f"Testing Column: {sample_col_urn}")
        
        # Query 1: Column -> Target Datasets
        # Note: This relies on granular lineage edges existing, OR we can use AGGREGATED if we start from the parent table?
        # User asked "given column". 
        query_1 = (
            "MATCH (s {urn: $urn})-[:TRANSFORMS*]->(t_col) "
            "MATCH (t_table)-[:CONTAINS]->(t_col) "
            "RETURN DISTINCT t_table.urn, t_table.entityType"
        )
        res_1 = await provider._graph.query(query_1, params={"urn": sample_col_urn})
        log_results(f"1. Target Datasets for Column {sample_col_urn}", res_1)
    else:
        logger.warning("Skipping Scenaro 1 - no columns with lineage found.")

    # 2. Which datasets within a given domain have a lineage to other datasets?
    # Strategy: Domain -> (Contains) -> Dataset -> (AGGREGATED) -> Dataset
    # Find a domain
    dom_res = await provider._graph.query("MATCH (d:domain) RETURN d.urn LIMIT 1")
    if dom_res.result_set:
        sample_dom_urn = dom_res.result_set[0][0]
        # Query 2: Datasets in Domain X that have lineage
        # Use ':dataset' label
        query_2 = (
            "MATCH (d {urn: $urn})-[:CONTAINS*]->(t_source:dataset) "
            "MATCH (t_source)-[r:AGGREGATED]->(t_target:dataset) "
            "RETURN DISTINCT t_source.urn, t_target.urn, r.weight"
        )
        res_2 = await provider._graph.query(query_2, params={"urn": sample_dom_urn})
        log_results(f"2. Datasets in Domain {sample_dom_urn} with Lineage", res_2)
    else:
        logger.warning("No domain found.")

    # 3. Which tables in one container have lineage to other containers (same or other domain)
    # Strategy: Container -> (Contains) -> Dataset -> (AGGREGATED) -> Dataset
    cont_res = await provider._graph.query("MATCH (c:container) RETURN c.urn LIMIT 1")
    if cont_res.result_set:
        sample_cont_urn = cont_res.result_set[0][0]
        # Query 3
        # Use ':dataset' label
        # Use * for deep contains (Platform -> DB -> Schema -> Table)
        query_3 = (
            "MATCH (c {urn: $urn})-[:CONTAINS*]->(t_source:dataset) "
            "MATCH (t_source)-[r:AGGREGATED]->(t_target:dataset) "
            "MATCH (t_target)<-[:CONTAINS*]-(c_target:container) " 
            "RETURN DISTINCT t_source.urn, t_target.urn, c_target.urn, r.weight"
        )
        res_3 = await provider._graph.query(query_3, params={"urn": sample_cont_urn})
        log_results(f"3. Lineage from Tables in Container {sample_cont_urn}", res_3)

if __name__ == "__main__":
    asyncio.run(verify_scenarios())
