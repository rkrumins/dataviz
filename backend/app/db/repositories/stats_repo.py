import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.sqlite import insert as sqlite_upsert # Assume sqlite for now, but better use standard means or generic merge

from ..models import DataSourceStatsORM

logger = logging.getLogger(__name__)

async def get_data_source_stats(session: AsyncSession, ds_id: str) -> Optional[DataSourceStatsORM]:
    result = await session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id == ds_id)
    )
    return result.scalar_one_or_none()

async def upsert_data_source_stats(
    session: AsyncSession, 
    ds_id: str, 
    node_count: int, 
    edge_count: int, 
    entity_type_counts: str, 
    edge_type_counts: str, 
    schema_stats: str,
    ontology_metadata: str,
    graph_schema: str
) -> DataSourceStatsORM:
    # First see if it exists
    existing = await get_data_source_stats(session, ds_id)
    if existing:
        existing.node_count = node_count
        existing.edge_count = edge_count
        existing.entity_type_counts = entity_type_counts
        existing.edge_type_counts = edge_type_counts
        existing.schema_stats = schema_stats
        existing.ontology_metadata = ontology_metadata
        existing.graph_schema = graph_schema
        existing.updated_at = datetime.now(timezone.utc).isoformat()
        return existing
        
    # Create new
    new_stats = DataSourceStatsORM(
        data_source_id=ds_id,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
        schema_stats=schema_stats,
        ontology_metadata=ontology_metadata,
        graph_schema=graph_schema
    )
    session.add(new_stats)
    return new_stats
