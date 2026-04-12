"""
AggregationWorker — stateless batch materializer.

Executes aggregation jobs. Fully stateless and crash-recoverable.
This class has NO dependency on FastAPI, HTTP, the API layer,
or the ontology module. It is a pure executor.

CRASH RECOVERY CONTRACT:
- All progress state is checkpointed to DB after each batch
- Worker reads `last_cursor` on start — resumes from checkpoint
- MERGE-based writes are idempotent — replaying a partial batch is safe
- Recovery is handled by AggregationService (not this class)

CURSOR-BASED PAGINATION (CRIT-2):
- Uses stable cursor on sorted edge identifiers, NOT SKIP/OFFSET
- Eliminates O(n²) performance degradation for multi-million edge graphs
- Safe under concurrent graph mutations
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AggregationJobORM
from .fingerprint import compute_graph_fingerprint

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AggregationWorker:
    """Pure executor — no Dispatcher reference, no orchestration.

    Args:
        session_factory: Async context manager yielding AsyncSession
        registry: ProviderRegistry to look up graph providers
    """

    def __init__(self, session_factory: Any, registry: Any) -> None:
        self._session_factory = session_factory
        self._registry = registry

    async def run(self, job_id: str) -> None:
        """Full materialization pipeline.

        All parameters are read from AggregationJobORM — truly stateless.

        Cursor-based batch loop:
        1. Read job record from DB (includes last_cursor, frozen edge types)
        2. Parse containment/lineage types from job record
        3. Count total lineage edges (if not already counted)
        4. Resume from last_cursor (null = beginning)
        5. For each batch:
           a. Fetch next batch WHERE cursor > last_cursor ORDER BY cursor
           b. Compute ancestor chains for source+target
           c. MERGE AGGREGATED edges (idempotent)
           d. UPDATE job: processed_edges, last_cursor, updated_at, progress
           e. COMMIT checkpoint to DB
        6. On completion: update status='completed', compute fingerprint
        7. On failure: update status='failed', preserve checkpoint for resume
        """
        async with self._session_factory() as session:
            job = await session.get(AggregationJobORM, job_id)
            if not job:
                logger.error("Aggregation job %s not found", job_id)
                return

            # Transition to running
            job.status = "running"
            job.started_at = job.started_at or _now()
            job.updated_at = _now()
            await session.commit()

            logger.info(
                "Aggregation job %s started for data source %s (resume from: %s)",
                job_id, job.data_source_id, job.last_cursor or "beginning",
            )

            try:
                # Read frozen edge types from job record
                containment_types = json.loads(job.containment_edge_types or "[]")
                lineage_types = json.loads(job.lineage_edge_types or "[]")

                if not lineage_types:
                    raise ValueError("No lineage edge types configured — cannot aggregate")

                # Get provider for this data source
                provider = await self._registry.get_provider_for_workspace(
                    "", session, data_source_id=job.data_source_id
                )

                # Configure the provider with the data source's specific structural mapping
                # so physical queries can correctly differentiate lineage vs containment
                provider.set_containment_edge_types(containment_types)

                # Compute fingerprint before aggregation
                job.graph_fingerprint_before = await compute_graph_fingerprint(provider)
                await session.commit()

                # Run cursor-based batch materialization
                result = await self._materialize_with_checkpoints(
                    session=session,
                    job=job,
                    provider=provider,
                    containment_types=containment_types,
                    lineage_types=lineage_types,
                )

                # Success
                job.status = "completed"
                job.progress = 100
                job.completed_at = _now()
                job.created_edges = result.get("aggregated_edges_affected", 0)
                job.graph_fingerprint_after = await compute_graph_fingerprint(provider)

                # Update parent data source
                from backend.app.db.models import WorkspaceDataSourceORM
                ds = await session.get(WorkspaceDataSourceORM, job.data_source_id)
                if ds:
                    ds.aggregation_status = "ready"
                    ds.last_aggregated_at = job.completed_at
                    ds.aggregation_edge_count = job.created_edges
                    ds.graph_fingerprint = job.graph_fingerprint_after

                logger.info(
                    "Aggregation job %s completed: %d edges processed, %d AGGREGATED created",
                    job_id, job.processed_edges, job.created_edges,
                )

            except Exception as e:
                job.status = "failed"
                job.error_message = str(e)[:2000]
                logger.error("Aggregation job %s failed: %s", job_id, e, exc_info=True)

                # Update parent data source status
                try:
                    from backend.app.db.models import WorkspaceDataSourceORM
                    ds = await session.get(WorkspaceDataSourceORM, job.data_source_id)
                    if ds:
                        ds.aggregation_status = "failed"
                except Exception:
                    pass

            finally:
                job.updated_at = _now()
                await session.commit()

    async def _materialize_with_checkpoints(
        self,
        session: AsyncSession,
        job: AggregationJobORM,
        provider: Any,
        containment_types: list[str],
        lineage_types: list[str],
    ) -> dict:
        """Run batch materialization with DB checkpointing after each batch.

        Delegates the actual graph work to the provider's
        materialize_aggregated_edges_batch() method, passing a
        progress_callback that writes checkpoints to the DB.
        """

        async def checkpoint(processed: int, total: int, cursor: Optional[str]) -> None:
            """Write progress to DB after each batch — the crash recovery point."""
            job.processed_edges = processed
            job.total_edges = total
            job.last_cursor = cursor
            job.progress = int((processed / total) * 100) if total > 0 else 0
            job.updated_at = _now()
            job.last_checkpoint_at = _now()
            await session.commit()
            logger.debug(
                "Aggregation job %s: %d/%d edges (%d%%)",
                job.id, processed, total, job.progress,
            )

        result = await provider.materialize_aggregated_edges_batch(
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
            batch_size=job.batch_size,
            last_cursor=job.last_cursor,
            progress_callback=checkpoint,
        )

        return result
