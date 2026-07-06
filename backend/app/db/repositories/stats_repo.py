import logging
from datetime import datetime, timezone
from typing import List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import DataSourceStatsORM

logger = logging.getLogger(__name__)

async def get_data_source_stats(session: AsyncSession, ds_id: str) -> Optional[DataSourceStatsORM]:
    result = await session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id == ds_id)
    )
    return result.scalar_one_or_none()

async def list_data_source_stats(
    session: AsyncSession, ds_ids: Sequence[str]
) -> List[DataSourceStatsORM]:
    """Bulk read backing /datasources/cached-stats — one SELECT for a
    whole dashboard instead of one query per data source."""
    if not ds_ids:
        return []
    result = await session.execute(
        select(DataSourceStatsORM).where(DataSourceStatsORM.data_source_id.in_(ds_ids))
    )
    return list(result.scalars().all())

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


async def set_top_level_nodes(session: AsyncSession, ds_id: str, payload_json: str) -> None:
    """Stamp the materialized top-level-nodes payload onto an existing row.

    Counts-lane helper: called right after ``upsert_data_source_stats_counts``
    in the same session, so the row is expected to already exist. No-ops if
    it's somehow missing (mirrors ``touch_schema_freshness``) rather than
    creating a bare row here.

    NOTE: the deep-lane ``upsert_data_source_stats`` intentionally never
    touches ``top_level_nodes``/``top_level_updated_at`` — these two columns
    are owned exclusively by the counts-lane materialization.
    """
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.top_level_nodes = payload_json
    existing.top_level_updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()


async def touch_top_level_freshness(session: AsyncSession, ds_id: str) -> None:
    """Advance the top-level freshness marker WITHOUT rewriting the payload —
    used when the counts lane verifies the materialized ``top_level_nodes``
    payload is still current (fingerprint + digest match, not dirty), so the
    1-3MB payload is left untouched but its ``top_level_updated_at`` timestamp
    advances (the deep lane's ``touch_schema_freshness`` analog). No-ops if the
    row is missing (mirrors ``set_top_level_nodes``)."""
    existing = await get_data_source_stats(session, ds_id)
    if existing is None:
        return
    existing.top_level_updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
