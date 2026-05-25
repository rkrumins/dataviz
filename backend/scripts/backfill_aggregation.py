"""
Backfill script: materialises AGGREGATED edges for an existing
data source and stamps the aggregation lifecycle state so subsequent
drift detection works correctly.

PREFER THE API. When the Control Plane is running, the canonical
trigger path is::

    POST /aggregation/data-sources/{id}/trigger {"forceRebuild": true}

It writes a proper aggregation_jobs row, checkpoint-protects the
materialise loop, and is observable in the UI. This script exists for
the cases where that's unavailable: a fresh-install bootstrap, a
cluster where the API is down, or a one-off manual recovery.

What this script does that the previous version did NOT do:

  * Stamps ``aggregation.data_source_state`` with the new
    ``graph_fingerprint`` + ``aggregation_status='ready'`` after a
    successful materialise. Without this, the scheduler's drift
    detector immediately flags the data source on its next tick
    because the stored fingerprint is NULL.
  * Records a synthetic ``aggregation_jobs`` row with
    ``trigger_source='backfill_script'`` so operators have an audit
    trail (the prior version left no record at all).

Usage:
    python -m backend.scripts.backfill_aggregation \\
        [--workspace-id W] [--data-source-id D] [--batch-size N]
"""

import argparse
import asyncio
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional

sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.db.engine import get_async_session
from backend.app.db.repositories import workspace_repo
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.aggregation.fingerprint import compute_graph_fingerprint
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
)
from backend.app.services.context_engine import ContextEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def backfill(
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    batch_size: int = 1000,
) -> None:
    async with get_async_session() as session:
        if not workspace_id and not data_source_id:
            ws = await workspace_repo.get_default_workspace(session)
            if not ws:
                logger.error(
                    "No workspace or data source specified and no default "
                    "workspace exists. Pass --workspace-id or "
                    "--data-source-id."
                )
                return
            workspace_id = ws.id
            logger.info("Using default workspace: %s (%s)", ws.name, ws.id)

        try:
            engine = await ContextEngine.for_workspace(
                workspace_id=workspace_id,
                registry=provider_registry,
                session=session,
                data_source_id=data_source_id,
            )
        except Exception as exc:
            logger.error("Failed to initialise context engine: %s", exc)
            return

        from backend.app.providers.falkordb_provider import FalkorDBProvider
        if not isinstance(engine.provider, FalkorDBProvider):
            logger.error(
                "Backfill only supported for FalkorDB (current: %s)",
                type(engine.provider).__name__,
            )
            return

        ontology = await engine.get_ontology_metadata()
        containment_types = list(ontology.containment_edge_types)
        lineage_types = list(ontology.lineage_edge_types)
        resolved_ds_id = data_source_id or engine.data_source_id

        logger.info("Backfill target graph: %s", engine.provider._graph_name)
        logger.info("Containment types: %s", containment_types)
        logger.info("Lineage types: %s", lineage_types)
        logger.info("Batch size: %d", batch_size)

        started_at = datetime.now(tz=timezone.utc)
        stats = await engine.provider.materialize_aggregated_edges_batch(
            batch_size=batch_size,
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
        )
        completed_at = datetime.now(tz=timezone.utc)
        logger.info("Materialise complete: %s", stats)

        # Stamp the lifecycle state so the scheduler doesn't immediately
        # flag drift on its next tick. Without this the data source
        # appears un-aggregated to drift detection even though the
        # AGGREGATED edges are physically present.
        fingerprint = await compute_graph_fingerprint(engine.provider)
        edge_count = int(stats.get("edges_created", 0) or 0) if isinstance(stats, dict) else 0

        await _stamp_lifecycle_state(
            session,
            data_source_id=resolved_ds_id,
            workspace_id=workspace_id,
            fingerprint=fingerprint,
            edge_count=edge_count,
            started_at=started_at,
            completed_at=completed_at,
            containment_types=containment_types,
            lineage_types=lineage_types,
        )
        logger.info(
            "Backfill stamped data_source_state for %s (fingerprint=%s, "
            "edges=%d). Drift detection will now compare against this baseline.",
            resolved_ds_id, fingerprint, edge_count,
        )


async def _stamp_lifecycle_state(
    session,
    *,
    data_source_id: str,
    workspace_id: str,
    fingerprint: str,
    edge_count: int,
    started_at: datetime,
    completed_at: datetime,
    containment_types: list,
    lineage_types: list,
) -> None:
    """Write the state + audit-job rows that the canonical trigger
    path would have written. Idempotent on the DS-state row (upsert);
    appends a fresh job row each invocation (the script doesn't
    pretend to be a re-trigger)."""
    import json

    state = await session.get(AggregationDataSourceStateORM, data_source_id)
    completed_iso = completed_at.isoformat()
    if state is None:
        state = AggregationDataSourceStateORM(
            data_source_id=data_source_id,
            workspace_id=workspace_id,
            aggregation_status="ready",
            last_aggregated_at=completed_iso,
            aggregation_edge_count=edge_count,
            graph_fingerprint=fingerprint,
        )
        session.add(state)
    else:
        state.aggregation_status = "ready"
        state.last_aggregated_at = completed_iso
        state.aggregation_edge_count = edge_count
        state.graph_fingerprint = fingerprint

    # trigger_source is CHECK-constrained to a fixed set; use 'manual'
    # (the script is operator-driven) and let force_rebuild=True
    # distinguish it from a UI-triggered run.
    job_row = AggregationJobORM(
        id=f"agg_{uuid.uuid4().hex[:12]}",
        data_source_id=data_source_id,
        workspace_id=workspace_id,
        status="completed",
        trigger_source="manual",
        force_rebuild=True,
        containment_edge_types=json.dumps(containment_types),
        lineage_edge_types=json.dumps(lineage_types),
        graph_fingerprint_after=fingerprint,
        created_edges=edge_count,
        created_at=started_at.isoformat(),
        updated_at=completed_iso,
        completed_at=completed_iso,
    )
    session.add(job_row)
    await session.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Backfill AGGREGATED edges for a workspace.",
    )
    parser.add_argument("--workspace-id", help="Target workspace ID")
    parser.add_argument(
        "--data-source-id",
        help="Target data source ID (uses primary if omitted)",
    )
    parser.add_argument(
        "--batch-size", type=int, default=1000,
        help="Batch size for materialisation (default: 1000)",
    )
    args = parser.parse_args()
    asyncio.run(backfill(
        workspace_id=args.workspace_id,
        data_source_id=args.data_source_id,
        batch_size=args.batch_size,
    ))
