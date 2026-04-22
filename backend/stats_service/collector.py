"""Per-data-source stats collection.

Runs the four provider queries (stats, schema stats, ontology metadata,
graph schema) concurrently inside a single DB transaction, serialises
the Pydantic results, and upserts into ``data_source_stats``. The
caller owns timeout wrapping (``asyncio.wait_for``) and session
lifecycle so this function can be unit-tested with a mocked session.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import DataSourcePollingConfigORM
from backend.app.db.repositories.stats_repo import upsert_data_source_stats
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine

from .schemas import StatsJobEnvelope

logger = logging.getLogger(__name__)


async def collect(session: AsyncSession, envelope: StatsJobEnvelope) -> None:
    """Run one poll cycle for a single data source.

    Commits on success, marks the polling config ``last_status=success``
    and clears ``last_error``. On failure: raises — the caller is
    responsible for persisting the error message (so failure handling
    can differ between "retry" and "give up" paths).
    """
    engine = await ContextEngine.for_workspace(
        workspace_id=envelope.workspace_id,
        registry=provider_registry,
        session=session,
        data_source_id=envelope.data_source_id,
    )
    provider = engine.provider

    stats, schema_stats, ontology_meta, graph_schema = await asyncio.gather(
        provider.get_stats(),
        provider.get_schema_stats(),
        engine.get_ontology_metadata(),
        engine.get_graph_schema(),
    )

    await upsert_data_source_stats(
        session=session,
        ds_id=envelope.data_source_id,
        node_count=stats.get("nodeCount", 0),
        edge_count=stats.get("edgeCount", 0),
        entity_type_counts=json.dumps(stats.get("entityTypeCounts", {})),
        edge_type_counts=json.dumps(stats.get("edgeTypeCounts", {})),
        schema_stats=schema_stats.model_dump_json(by_alias=True),
        ontology_metadata=ontology_meta.model_dump_json(by_alias=True),
        graph_schema=graph_schema.model_dump_json(by_alias=True),
    )

    config = await session.get(DataSourcePollingConfigORM, envelope.data_source_id)
    if config is not None:
        config.last_polled_at = datetime.now(timezone.utc).isoformat()
        config.last_status = "success"
        config.last_error = None


async def record_failure(
    session: AsyncSession,
    data_source_id: str,
    error: str,
) -> None:
    """Write an error into the polling config — used by the worker after
    a failed poll (per-source, not crash-level)."""
    config = await session.get(DataSourcePollingConfigORM, data_source_id)
    if config is None:
        return
    config.last_status = "error"
    config.last_error = error[:2000]
    config.last_polled_at = datetime.now(timezone.utc).isoformat()
