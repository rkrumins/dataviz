import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    """Full-row upsert — the deep stats facet. Stamps both freshness
    markers: ``updated_at`` (counts) and ``schema_updated_at`` (schema/
    ontology/graph_schema columns, read by the scheduler's deep due-check)."""
    now_iso = datetime.now(timezone.utc).isoformat()
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
        existing.updated_at = now_iso
        existing.schema_updated_at = now_iso
        await session.flush()
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
        graph_schema=graph_schema,
        schema_updated_at=now_iso,
    )
    session.add(new_stats)
    await session.flush()
    return new_stats


async def touch_schema_freshness(session: AsyncSession, ds_id: str) -> None:
    """Advance both freshness markers WITHOUT rewriting any data —
    used when a deep poll's cheap probe shows the graph is unchanged,
    so the expensive scans (and a pointless row rewrite) are skipped."""
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    existing.updated_at = now_iso
    existing.schema_updated_at = now_iso
    await session.flush()


async def upsert_data_source_stats_counts(
    session: AsyncSession,
    ds_id: str,
    node_count: int,
    edge_count: int,
    entity_type_counts: str,
    edge_type_counts: str,
) -> DataSourceStatsORM:
    """Partial upsert — the cheap counts facet.

    Touches only the count columns + ``updated_at`` so a counts poll
    never clobbers (or waits on) the expensive schema/ontology/graph
    columns owned by the deep facet. On first contact (no row yet) the
    JSON columns fall back to their ``{}`` defaults until the first
    deep poll fills them.
    """
    existing = await get_data_source_stats(session, ds_id)
    if existing:
        existing.node_count = node_count
        existing.edge_count = edge_count
        existing.entity_type_counts = entity_type_counts
        existing.edge_type_counts = edge_type_counts
        existing.updated_at = datetime.now(timezone.utc).isoformat()
        await session.flush()
        return existing

    new_stats = DataSourceStatsORM(
        data_source_id=ds_id,
        node_count=node_count,
        edge_count=edge_count,
        entity_type_counts=entity_type_counts,
        edge_type_counts=edge_type_counts,
    )
    session.add(new_stats)
    await session.flush()
    return new_stats
