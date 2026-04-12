"""
AggregationService — REST API-driven aggregation orchestrator.

Owns: job lifecycle, concurrent job guards, ontology resolution,
      crash recovery, scheduling.
Does NOT own: batch materialization (that's the Worker).

This class has NO FastAPI imports. No HTTP concepts. Pure domain logic.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .dispatcher import AggregationDispatcher
from .models import AggregationJobORM
from .schemas import (
    AggregationJobResponse,
    AggregationSkipRequest,
    AggregationTriggerRequest,
    DataSourceReadinessResponse,
    DriftCheckResponse,
)
from .fingerprint import compute_graph_fingerprint, fingerprints_match

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    import uuid
    return f"agg_{uuid.uuid4().hex[:12]}"


class AggregationService:
    """REST API-driven aggregation orchestrator.

    Dependency injection: accepts Dispatcher and ProviderRegistry protocols.
    No FastAPI imports. No HTTP concepts. Pure domain logic.

    Args:
        dispatcher: Dispatches job_id to a worker (in-process or message queue)
        registry: ProviderRegistry to look up graph providers
        session_factory: Async session context manager
        ontology_service: Direct reference to ontology service (monolith mode)
    """

    def __init__(
        self,
        dispatcher: AggregationDispatcher,
        registry: Any,
        session_factory: Any,
        ontology_service: Any = None,
    ) -> None:
        self._dispatcher = dispatcher
        self._registry = registry
        self._session_factory = session_factory
        self._ontology_service = ontology_service

    # ── Trigger (with concurrent job guard + ontology resolution) ──────

    async def trigger(
        self,
        ds_id: str,
        request: AggregationTriggerRequest,
        trigger_source: str,
        session: AsyncSession,
    ) -> AggregationJobResponse:
        """Create and dispatch an aggregation job.

        1. CHECK: Is there already an active job for this data source?
           → If yes: raise ConflictError (409)
        2. RESOLVE: Call ontology service to get containment/lineage edge types
           → If no ontology assigned: raise ValueError (422)
        3. CREATE: AggregationJobORM with frozen edge types
        4. DISPATCH: dispatcher.dispatch(job_id)
        5. RETURN: AggregationJobResponse
        """
        from backend.app.db.models import WorkspaceDataSourceORM

        # ── Concurrent job guard (CRIT-1) ──────────────────────────
        existing = await session.execute(
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .where(AggregationJobORM.status.in_(["pending", "running"]))
        )
        if existing.scalar_one_or_none():
            raise ConflictError(
                "An aggregation job is already active for this data source"
            )

        # ── Resolve ontology via direct service call (CRIT-5) ──────
        ontology_data = await self._resolve_ontology(ds_id, session)
        containment_types = ontology_data.get("containment_edge_types", [])
        lineage_types = ontology_data.get("lineage_edge_types", [])

        if not lineage_types:
            raise ValueError(
                "Aggregation requires an assigned ontology with lineage edge types. "
                "Please configure an ontology for this data source first."
            )

        # ── Create job with frozen edge types ──────────────────────
        job = AggregationJobORM(
            id=_generate_id(),
            data_source_id=ds_id,
            ontology_id=ontology_data.get("ontology_id"),
            projection_mode=request.projection_mode,
            containment_edge_types=json.dumps(containment_types),
            lineage_edge_types=json.dumps(lineage_types),
            status="pending",
            trigger_source=trigger_source,
            batch_size=request.batch_size,
            created_at=_now(),
        )
        session.add(job)

        # Update data source status
        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if ds:
            ds.aggregation_status = "pending"
        await session.commit()

        # Dispatch to worker
        await self._dispatcher.dispatch(job.id)

        logger.info(
            "Aggregation job %s created for data source %s (trigger: %s, edges: %s)",
            job.id, ds_id, trigger_source, lineage_types,
        )

        return self._to_response(job)

    # ── Skip (user opts out with double confirmation) ─────────────────

    async def skip(
        self,
        ds_id: str,
        request: AggregationSkipRequest,
        session: AsyncSession,
    ) -> DataSourceReadinessResponse:
        """Mark data source as 'skipped' — views can be created but without aggregated edges."""
        if not request.confirmed:
            raise ValueError(
                "You must confirm skipping aggregation by setting confirmed=true"
            )

        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if not ds:
            raise NotFoundError(f"Data source {ds_id} not found")

        ds.aggregation_status = "skipped"
        await session.commit()

        logger.info("Aggregation skipped for data source %s", ds_id)

        return await self.get_readiness(ds_id, session)

    # ── Status ────────────────────────────────────────────────────────

    async def get_readiness(
        self, ds_id: str, session: AsyncSession
    ) -> DataSourceReadinessResponse:
        """Get the aggregation readiness status for a data source."""
        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if not ds:
            raise NotFoundError(f"Data source {ds_id} not found")

        # Find active job (if any)
        active_result = await session.execute(
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .where(AggregationJobORM.status.in_(["pending", "running"]))
            .order_by(AggregationJobORM.created_at.desc())
        )
        active_job = active_result.scalar_one_or_none()

        status = ds.aggregation_status or "none"

        # canCreateViews logic:
        # - none: no (must aggregate or skip first)
        # - pending/running: no (in progress)
        # - ready/skipped: yes
        # - failed: no (must retry or skip)
        can_create = status in ("ready", "skipped")

        # Ready means aggregation completed successfully
        is_ready = status == "ready"

        # Check for drift
        drift = False
        if is_ready and ds.graph_fingerprint:
            try:
                provider = await self._registry.get_provider_for_data_source(ds_id)
                current_fp = await compute_graph_fingerprint(provider)
                drift = not fingerprints_match(ds.graph_fingerprint, current_fp)
            except Exception:
                pass  # Can't check drift — don't block

        messages = {
            "none": "Aggregation has not been configured. Aggregate or skip to create views.",
            "pending": "Aggregation is queued and will start shortly.",
            "running": "Aggregation is in progress.",
            "ready": "Aggregation complete. Views can be created.",
            "failed": "Aggregation failed. You can retry or skip.",
            "skipped": "Aggregation was skipped. Views can be created without aggregated edges.",
        }

        return DataSourceReadinessResponse(
            data_source_id=ds_id,
            is_ready=is_ready,
            aggregation_status=status,
            can_create_views=can_create,
            active_job=self._to_response(active_job) if active_job else None,
            drift_detected=drift,
            last_aggregated_at=ds.last_aggregated_at,
            aggregation_edge_count=ds.aggregation_edge_count or 0,
            message=messages.get(status, "Unknown status."),
        )

    async def get_job(
        self, ds_id: str, job_id: str, session: AsyncSession
    ) -> AggregationJobResponse:
        """Get a specific aggregation job."""
        job = await session.get(AggregationJobORM, job_id)
        if not job or job.data_source_id != ds_id:
            raise NotFoundError(f"Aggregation job {job_id} not found")
        return self._to_response(job)

    async def list_jobs(
        self,
        ds_id: str,
        session: AsyncSession,
        status: Optional[str] = None,
        limit: int = 20,
    ) -> List[AggregationJobResponse]:
        """List aggregation jobs for a data source."""
        query = (
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .order_by(AggregationJobORM.created_at.desc())
            .limit(limit)
        )
        if status:
            query = query.where(AggregationJobORM.status == status)

        result = await session.execute(query)
        return [self._to_response(j) for j in result.scalars()]

    # ── Resume ────────────────────────────────────────────────────────

    async def resume(
        self, ds_id: str, job_id: str, session: AsyncSession
    ) -> AggregationJobResponse:
        """Resume a failed aggregation job from its last checkpoint."""
        job = await session.get(AggregationJobORM, job_id)
        if not job or job.data_source_id != ds_id:
            raise NotFoundError(f"Aggregation job {job_id} not found")

        if job.status != "failed":
            raise ValueError(f"Job {job_id} is not in 'failed' status (current: {job.status})")

        if job.retry_count >= job.max_retries:
            raise ValueError(f"Job {job_id} has exceeded max retries ({job.max_retries})")

        job.status = "pending"
        job.retry_count += 1
        job.error_message = None
        job.updated_at = _now()
        await session.commit()

        await self._dispatcher.dispatch(job.id)

        logger.info("Aggregation job %s resumed (retry %d/%d)", job_id, job.retry_count, job.max_retries)

        return self._to_response(job)

    # ── Cancel ────────────────────────────────────────────────────────

    async def cancel(
        self, ds_id: str, job_id: str, session: AsyncSession
    ) -> AggregationJobResponse:
        """Cancel a pending or running aggregation job."""
        job = await session.get(AggregationJobORM, job_id)
        if not job or job.data_source_id != ds_id:
            raise NotFoundError(f"Aggregation job {job_id} not found")

        if job.status not in ("pending", "running"):
            raise ValueError(f"Job {job_id} cannot be cancelled (status: {job.status})")

        job.status = "cancelled"
        job.completed_at = _now()
        job.updated_at = _now()
        await session.commit()

        logger.info("Aggregation job %s cancelled", job_id)

        return self._to_response(job)

    # ── Schedule ──────────────────────────────────────────────────────

    async def set_schedule(
        self, ds_id: str, cron: Optional[str], session: AsyncSession
    ) -> None:
        """Set or clear the aggregation schedule for a data source."""
        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if not ds:
            raise NotFoundError(f"Data source {ds_id} not found")

        ds.aggregation_schedule = cron
        await session.commit()

        logger.info("Aggregation schedule %s for data source %s", cron or "cleared", ds_id)

    # ── Change Detection ──────────────────────────────────────────────

    async def check_drift(
        self, ds_id: str, session: AsyncSession
    ) -> DriftCheckResponse:
        """Check if the underlying graph has changed since last aggregation."""
        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if not ds:
            raise NotFoundError(f"Data source {ds_id} not found")

        try:
            provider = await self._registry.get_provider_for_data_source(ds_id)
            current_fp = await compute_graph_fingerprint(provider)
        except Exception as e:
            logger.warning("Failed to compute fingerprint for drift check: %s", e)
            return DriftCheckResponse(
                drift_detected=False,
                current_fingerprint=None,
                stored_fingerprint=ds.graph_fingerprint,
                last_checked_at=_now(),
            )

        drift = not fingerprints_match(ds.graph_fingerprint, current_fp)

        return DriftCheckResponse(
            drift_detected=drift,
            current_fingerprint=current_fp,
            stored_fingerprint=ds.graph_fingerprint,
            last_checked_at=_now(),
        )

    # ── Startup Recovery (CRIT-4: lives here, NOT on Worker) ─────────

    async def recover_interrupted_jobs(self) -> int:
        """Called once on application startup.

        Scans for jobs stuck in 'pending' or 'running' (interrupted by crash).
        Re-dispatches via the configured dispatcher.
        The worker resumes from the stored last_cursor checkpoint.
        """
        async with self._session_factory() as session:
            stale_jobs = await session.execute(
                select(AggregationJobORM).where(
                    AggregationJobORM.status.in_(["pending", "running"])
                )
            )
            count = 0
            for job in stale_jobs.scalars():
                if job.retry_count < job.max_retries:
                    job.retry_count += 1
                    job.updated_at = _now()
                    await session.commit()
                    await self._dispatcher.dispatch(job.id)
                    count += 1
                    logger.info(
                        "Recovered aggregation job %s (retry %d/%d, cursor: %s)",
                        job.id, job.retry_count, job.max_retries, job.last_cursor,
                    )
                else:
                    job.status = "failed"
                    job.error_message = "Max retries exceeded after crash recovery"
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s permanently failed after %d retries",
                        job.id, job.max_retries,
                    )
            return count

    # ── Ontology Resolution ──────────────────────────────────────────

    async def _resolve_ontology(self, ds_id: str, session: AsyncSession) -> dict:
        """Resolve ontology edge types for a data source.

        In monolith mode: uses direct service reference.
        In microservice mode: would use HTTP API call.

        Returns dict with:
            ontology_id, containment_edge_types, lineage_edge_types
        """
        from backend.app.db.models import WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if not ds:
            raise NotFoundError(f"Data source {ds_id} not found")

        if not ds.ontology_id:
            raise ValueError(
                "Aggregation requires an assigned ontology. "
                "Please configure an ontology for this data source first."
            )

        # Use the ontology service if available (monolith direct call)
        if self._ontology_service:
            try:
                ontology = await self._ontology_service.resolve_for_data_source(
                    workspace_id=ds.workspace_id,
                    data_source_id=ds_id,
                )
                return {
                    "ontology_id": ds.ontology_id,
                    "containment_edge_types": ontology.containment_edge_types,
                    "lineage_edge_types": ontology.lineage_edge_types,
                }
            except Exception as e:
                logger.warning(
                    "Ontology resolution via service failed, falling back to DB: %s", e
                )

        # Fallback: read ontology definitions directly from DB
        from backend.app.db.models import OntologyORM
        ontology_orm = await session.get(OntologyORM, ds.ontology_id)
        if not ontology_orm:
            raise NotFoundError(f"Ontology {ds.ontology_id} not found")

        # Parse relationship definitions to extract edge type classifications
        from backend.app.ontology.resolver import parse_relationship_definitions, derive_flat_lists, parse_entity_definitions
        try:
            entity_defs = parse_entity_definitions(
                json.loads(ontology_orm.entity_type_definitions or "{}")
            )
            rel_defs = parse_relationship_definitions(
                json.loads(ontology_orm.relationship_type_definitions or "{}")
            )
            flat = derive_flat_lists(entity_defs, rel_defs)
            return {
                "ontology_id": ds.ontology_id,
                "containment_edge_types": flat.containment_edge_types,
                "lineage_edge_types": flat.lineage_edge_types,
            }
        except Exception as e:
            raise ValueError(f"Failed to parse ontology definitions: {e}") from e

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _to_response(job: AggregationJobORM) -> AggregationJobResponse:
        """Convert ORM to response model."""
        # Estimate completion time
        estimated = None
        if job.status == "running" and job.processed_edges > 0 and job.total_edges > 0:
            if job.started_at:
                try:
                    started = datetime.fromisoformat(job.started_at)
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    rate = job.processed_edges / elapsed if elapsed > 0 else 0
                    remaining = job.total_edges - job.processed_edges
                    if rate > 0:
                        eta_seconds = remaining / rate
                        eta = datetime.now(timezone.utc) + __import__("datetime").timedelta(seconds=eta_seconds)
                        estimated = eta.isoformat()
                except Exception:
                    pass

        return AggregationJobResponse(
            id=job.id,
            data_source_id=job.data_source_id,
            status=job.status,
            trigger_source=job.trigger_source,
            progress=job.progress,
            total_edges=job.total_edges,
            processed_edges=job.processed_edges,
            created_edges=job.created_edges,
            batch_size=job.batch_size,
            last_checkpoint_at=job.last_checkpoint_at,
            resumable=job.status == "failed" and job.retry_count < job.max_retries,
            retry_count=job.retry_count,
            error_message=job.error_message,
            estimated_completion_at=estimated,
            started_at=job.started_at,
            completed_at=job.completed_at,
            updated_at=job.updated_at,
            created_at=job.created_at,
        )


# ── Custom Exception Classes ────────────────────────────────────────


class ConflictError(Exception):
    """409 — resource conflict (e.g., duplicate active job)."""
    pass


class NotFoundError(Exception):
    """404 — resource not found."""
    pass
