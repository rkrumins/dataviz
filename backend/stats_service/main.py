import asyncio
import logging
import os
import json
from datetime import datetime, timezone
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("stats_poller")

# Ensure proper module resolution for the backend app
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.db.engine import get_session_factory
from backend.app.db.models import WorkspaceDataSourceORM, DataSourcePollingConfigORM
from backend.app.db.repositories.stats_repo import upsert_data_source_stats
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine


async def poll_data_source(ds_id: str, workspace_id: str):
    """
    Execute stats gathering for a single data source utilizing its proper Graph Provider.
    Creates its own DB session to avoid concurrent transaction errors and fetches
    its own provider within that session context.
    """
    logger.info(f"Starting stats poll for data source {ds_id}")
    session_factory = get_session_factory()
    
    try:
        async with session_factory() as session:
            # Load engine (which encapsulates the provider)
            engine = await ContextEngine.for_workspace(
                workspace_id=workspace_id,
                registry=provider_registry,
                session=session,
                data_source_id=ds_id
            )
            provider = engine.provider
            
            # Run queries concurrently if possible
            stats_task = asyncio.create_task(provider.get_stats())
            schema_task = asyncio.create_task(provider.get_schema_stats())
            ontology_task = asyncio.create_task(engine.get_ontology_metadata())
            graph_schema_task = asyncio.create_task(engine.get_graph_schema())
            
            # Await completion
            stats, schema_stats_obj, ontology_obj, schema_obj = await asyncio.gather(
                stats_task, schema_task, ontology_task, graph_schema_task
            )
            
            # Serialize schema_stats (Pydantic model)
            schema_json_str = schema_stats_obj.model_dump_json(by_alias=True)
            ontology_json_str = ontology_obj.model_dump_json(by_alias=True)
            graph_schema_json_str = schema_obj.model_dump_json(by_alias=True)

            # Upsert back to DB
            await upsert_data_source_stats(
                session=session,
                ds_id=ds_id,
                node_count=stats.get("nodeCount", 0),
                edge_count=stats.get("edgeCount", 0),
                entity_type_counts=json.dumps(stats.get("entityTypeCounts", {})),
                edge_type_counts=json.dumps(stats.get("edgeTypeCounts", {})),
                schema_stats=schema_json_str,
                ontology_metadata=ontology_json_str,
                graph_schema=graph_schema_json_str
            )
            
            # Update config success
            config = await session.get(DataSourcePollingConfigORM, ds_id)
            if config:
                config.last_polled_at = datetime.now(timezone.utc).isoformat()
                config.last_status = "success"
                config.last_error = None
                
            await session.commit()
            
        logger.info(f"Successfully polled stats for {ds_id}")
        
    except Exception as e:
        logger.error(f"Failed to poll stats for data source {ds_id}: {e}", exc_info=True)
        try:
            async with session_factory() as session:
                config = await session.get(DataSourcePollingConfigORM, ds_id)
                if config:
                    config.last_status = "error"
                    config.last_error = str(e)
                    config.last_polled_at = datetime.now(timezone.utc).isoformat()
                    await session.commit()
        except Exception as retry_e:
            logger.error(f"Failed to update error status for ds {ds_id}: {retry_e}")


async def scheduled_polling_loop():
    """
    Lightweight orchestration loop that spins indefinitely.
    Checks the management DB for pending sources that are due for polling.
    """
    logger.info("Initializing Graph Stats Poller Service...")
    session_factory = get_session_factory()
    
    # Optional graceful shutdown flags would go here

    while True:
        try:
            async with session_factory() as session:
                # 1. Fetch all enabled data sources and their polling configs
                # To do this efficiently, we join WorkspaceDataSourceORM and DataSourcePollingConfigORM
                result = await session.execute(
                    select(WorkspaceDataSourceORM, DataSourcePollingConfigORM)
                    .join(DataSourcePollingConfigORM, WorkspaceDataSourceORM.id == DataSourcePollingConfigORM.data_source_id, isouter=True)
                    .where(WorkspaceDataSourceORM.is_active == True)
                )
                
                tasks = []
                now = datetime.now(timezone.utc)
                
                for ds, config in result.all():
                    # If config is missing, auto-create one with default 5m interval
                    if not config:
                        logger.info(f"Creating default polling config for new data source {ds.id}")
                        config = DataSourcePollingConfigORM(
                            data_source_id=ds.id,
                            is_enabled=True,
                            interval_seconds=300
                        )
                        session.add(config)
                        await session.commit()
                        
                    if not config.is_enabled:
                        continue
                        
                    # Check if due for polling
                    is_due = False
                    if not config.last_polled_at:
                        is_due = True
                    else:
                        last_polled = datetime.fromisoformat(config.last_polled_at)
                        elapsed = (now - last_polled).total_seconds()
                        if elapsed >= config.interval_seconds:
                            is_due = True
                            
                    if is_due:
                        tasks.append(poll_data_source(ds.id, ds.workspace_id))
                
                # Execute due polls concurrently outside the session context block
                
            if tasks:
                logger.info(f"Executing {len(tasks)} polling tasks...")
                await asyncio.gather(*tasks)
                    
        except Exception as e:
            logger.error(f"Error in polling orchestration loop: {e}", exc_info=True)
            
        # Sleep for a short beat before checking again (prevents CPU lock)
        await asyncio.sleep(10)


def main():
    try:
        asyncio.run(scheduled_polling_loop())
    except KeyboardInterrupt:
        logger.info("Stats Poller Service shutting down.")


if __name__ == "__main__":
    main()
