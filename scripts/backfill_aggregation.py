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

import argparse
import asyncio
import logging
import os
import sys
from typing import Optional, List, Any

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.db.engine import get_async_session
from backend.app.services.context_engine import ContextEngine
from backend.app.registry.provider_registry import provider_registry
from backend.app.db.repositories import workspace_repo

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def backfill(workspace_id: Optional[str] = None, data_source_id: Optional[str] = None, batch_size: int = 1000):
    async with get_async_session() as session:
        # 1. Resolve Workspace/Data Source
        if not workspace_id and not data_source_id:
            logger.info("No workspace/data-source specified, attempting to find default workspace...")
            ws = await workspace_repo.get_default_workspace(session)
            if not ws:
                logger.error("No default workspace found. Please provide --workspace-id or --data-source-id")
                return
            workspace_id = ws.id
            logger.info(f"Using default workspace: {ws.name} ({ws.id})")

        # 2. Initialize ContextEngine (handles provider registration, graph name, etc.)
        try:
            engine = await ContextEngine.for_workspace(
                workspace_id=workspace_id,
                registry=provider_registry,
                session=session,
                data_source_id=data_source_id
            )
        except Exception as e:
            logger.error(f"Failed to initialize context engine: {e}")
            return

        from backend.app.providers.falkordb_provider import FalkorDBProvider
        if not isinstance(engine.provider, FalkorDBProvider):
            logger.error(f"Backfill only supported for FalkorDB (current: {type(engine.provider).__name__})")
            return

        # 3. Fetch Ontology Metadata (blueprint-aware)
        logger.info("Fetching ontology metadata...")
        ontology = await engine.get_ontology_metadata()
        
        containment_types = list(ontology.containment_edge_types)
        lineage_types = list(ontology.lineage_edge_types)

        logger.info(f"Starting batch backfill on graph: {engine.provider._graph_name}")
        logger.info(f"Containment types: {containment_types}")
        logger.info(f"Lineage types: {lineage_types}")
        logger.info(f"Batch size: {batch_size}")

        # 4. Execute materialization
        stats = await engine.provider.materialize_aggregated_edges_batch(
            batch_size=batch_size,
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
        )

        logger.info(f"Backfill complete: {stats}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill AGGREGATED edges for a workspace.")
    parser.add_argument("--workspace-id", help="Target workspace ID")
    parser.add_argument("--data-source-id", help="Target data source ID (optional, uses primary if omitted)")
    parser.add_argument("--batch-size", type=int, default=1000, help="Batch size for materialization (default: 1000)")
    
    args = parser.parse_args()
    
    asyncio.run(backfill(
        workspace_id=args.workspace_id,
        data_source_id=args.data_source_id,
        batch_size=args.batch_size
    ))
