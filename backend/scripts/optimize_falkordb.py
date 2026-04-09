#!/usr/bin/env python3
"""
Utility script to optimize FalkorDB by creating indices.
Labels: domain, dataPlatform, container, dataset, schemaField
Properties: urn, displayName, qualifiedName
"""

import asyncio
import logging
import os
import sys

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

async def optimize():
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    await provider._ensure_connected()
    
    # Define labels and properties to index
    labels = [
        "domain",
        "dataPlatform",
        "container",
        "dataset",
        "schemaField",
    ]
    
    properties = ["urn", "displayName", "qualifiedName"]
    
    logger.info(f"Optimizing FalkorDB graph '{provider._graph_name}' with indices...")
    
    for label in labels:
        for prop in properties:
            try:
                # FalkorDB CREATE INDEX is idempotent if the index already exists in newer versions,
                # but we can also just catch the error if it's already there.
                # Syntax: CREATE INDEX FOR (n:Label) ON (n.property)
                query = f"CREATE INDEX FOR (n:{label}) ON (n.{prop})"
                await provider._graph.query(query)
                logger.info(f"Created index on :{label}({prop})")
            except Exception as e:
                # Often fails if index already exists, which is fine
                if "Index already exists" in str(e):
                    logger.debug(f"Index on :{label}({prop}) already exists.")
                else:
                    logger.warning(f"Could not create index on :{label}({prop}): {e}")

    # Verify indices
    try:
        res = await provider._graph.query("CALL db.indexes()")
        logger.info("Current indices in database:")
        for row in res.result_set:
            logger.info(f"- {row}")
    except Exception as e:
        logger.warning(f"Could not list indices: {e}")

    logger.info("Optimization complete!")

if __name__ == "__main__":
    try:
        asyncio.run(optimize())
    except KeyboardInterrupt:
        logger.info("Optimization interrupted.")
    except Exception as e:
        logger.error(f"Optimization failed: {e}")
        sys.exit(1)
