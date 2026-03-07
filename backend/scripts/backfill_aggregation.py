"""
Backfill script: materializes AGGREGATED edges for all existing lineage edges.

Uses the batched server-side materialization which runs the full
ancestor-pair MERGE in a single Cypher per batch (much faster than the
previous per-edge approach).

Usage:
    python -m backend.scripts.backfill_aggregation

Environment variables:
    FALKORDB_HOST          (default: localhost)
    FALKORDB_PORT          (default: 6379)
    FALKORDB_GRAPH_NAME    (default: nexus_lineage)
    LINEAGE_EDGE_TYPES     (optional, comma-separated whitelist)
    CONTAINMENT_EDGE_TYPES (optional, comma-separated)
    BATCH_SIZE             (default: 1000)
"""

import asyncio
import logging
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def backfill():
    provider_name = os.getenv("GRAPH_PROVIDER", "falkordb").lower()
    if provider_name != "falkordb":
        logger.error("Backfill only supported for FalkorDB")
        return

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage"),
    )

    # Optional: whitelist lineage edge types
    lineage_config = os.getenv("LINEAGE_EDGE_TYPES", "").strip()
    lineage_types = [t.strip() for t in lineage_config.split(",") if t.strip()] if lineage_config else None

    containment_config = os.getenv("CONTAINMENT_EDGE_TYPES", "").strip()
    containment_types = [t.strip() for t in containment_config.split(",") if t.strip()] if containment_config else None

    batch_size = int(os.getenv("BATCH_SIZE", "1000"))

    logger.info("Starting batch backfill of AGGREGATED edges...")

    stats = await provider.materialize_aggregated_edges_batch(
        batch_size=batch_size,
        containment_edge_types=containment_types,
        lineage_edge_types=lineage_types,
    )

    logger.info(f"Backfill complete: {stats}")


if __name__ == "__main__":
    asyncio.run(backfill())
