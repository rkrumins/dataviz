"""
AggregationWorker — stateless batch materializer.

Executes aggregation jobs. Fully stateless and crash-recoverable.
This class has NO dependency on FastAPI, HTTP, the API layer,
or the ontology module. It is a pure executor.

CRASH RECOVERY CONTRACT:
- Progress state is checkpointed to DB on a coalesced cadence: commit
  whenever ≥2s has elapsed since the last commit OR ≥5 batches have
  accumulated, whichever comes first. The outer run()'s finally block
  always commits on completion/failure, so no progress is ever lost
  beyond the ≤2s window.
- Worker reads `last_cursor` on start — resumes from checkpoint
- MERGE-based writes are idempotent — replaying the ≤2s gap is safe
- Recovery is handled by AggregationService (not this class)

WHY COALESCED COMMITS: previously committed per batch, which under
SQLite with 1000+ batches created sustained write pressure that blocked
readiness polling. Coalescing cuts write volume ~5× without weakening
recovery (MERGE idempotency absorbs the replay window).

CURSOR-BASED PAGINATION (CRIT-2):
- Uses stable cursor on sorted edge identifiers, NOT SKIP/OFFSET
- Eliminates O(n²) performance degradation for multi-million edge graphs
- Safe under concurrent graph mutations
"""
import asyncio
import json
import logging
import os
import random
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.adapters import ProviderUnavailable

from .models import AggregationJobORM
from .fingerprint import compute_graph_fingerprint

logger = logging.getLogger(__name__)

_CHECKPOINT_MAX_INTERVAL_SECS: float = 2.0
_CHECKPOINT_MAX_BATCHES: int = 5
_JOB_TIMEOUT_SECS: int = int(os.getenv("AGGREGATION_JOB_TIMEOUT_SECS", "7200"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AggregationWorker:
    """Pure executor — no Dispatcher reference, no orchestration.

    Args:
        session_factory: Async context manager yielding AsyncSession
        registry: ProviderRegistry to look up graph providers
        event_publisher: Optional AggregationEventPublisher for status events
    """

    def __init__(
        self,
        session_factory: Any,
        registry: Any,
        event_publisher: Any = None,
    ) -> None:
        self._session_factory = session_factory
        self._registry = registry
        self._events = event_publisher

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

                # Configure projection mode from the job record.  The provider
                # is cached and shared, so we set this per-job to route
                # AGGREGATED edges to the correct graph (source or dedicated).
                await provider.set_projection_mode(job.projection_mode or "in_source")

                # Configure the provider with the data source's specific structural mapping
                # so physical queries can correctly differentiate lineage vs containment
                provider.set_containment_edge_types(containment_types)

                # Compute fingerprint before aggregation
                job.graph_fingerprint_before = await compute_graph_fingerprint(provider)
                await session.commit()

                # Run cursor-based batch materialization with retry + timeout.
                # On transient provider failures (AggregationBatchAbort, connection
                # errors), retry up to max_retries times with exponential backoff.
                # The overall job is wrapped in a timeout to catch hung queries.
                # Use per-job timeout if set, otherwise global default
                job_timeout = job.timeout_secs or _JOB_TIMEOUT_SECS

                result = await asyncio.wait_for(
                    self._materialize_with_retries(
                        session=session,
                        job=job,
                        provider=provider,
                        containment_types=containment_types,
                        lineage_types=lineage_types,
                    ),
                    timeout=job_timeout,
                )

                # Success
                job.status = "completed"
                job.progress = 100
                job.completed_at = _now()
                job.created_edges = result.get("aggregated_edges_affected", 0)
                job.graph_fingerprint_after = await compute_graph_fingerprint(provider)

                # Update aggregation-owned data source state
                await self._update_ds_state(
                    session,
                    job.data_source_id,
                    aggregation_status="ready",
                    last_aggregated_at=job.completed_at,
                    aggregation_edge_count=job.created_edges,
                    graph_fingerprint=job.graph_fingerprint_after,
                )

                # Publish event for viz-service to sync its own tables
                if self._events:
                    await self._events.job_completed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        edge_count=job.created_edges,
                        fingerprint=job.graph_fingerprint_after,
                        completed_at=job.completed_at,
                    )

                logger.info(
                    "Aggregation job %s completed: %d edges processed, %d AGGREGATED created",
                    job_id, job.processed_edges, job.created_edges,
                )

            except asyncio.TimeoutError:
                timeout = job.timeout_secs or _JOB_TIMEOUT_SECS
                job.status = "failed"
                job.error_message = (
                    f"Job timed out after {timeout}s. "
                    f"Progress: {job.processed_edges}/{job.total_edges} edges. "
                    f"Resume from last_cursor is possible."
                )
                logger.error("Aggregation job %s timed out after %ds", job_id, timeout)

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            except Exception as e:
                job.status = "failed"
                job.error_message = str(e)[:2000]
                logger.error("Aggregation job %s failed: %s", job_id, e, exc_info=True)

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            finally:
                job.updated_at = _now()
                await session.commit()

    async def _update_ds_state(
        self,
        session: AsyncSession,
        data_source_id: str,
        **fields: Any,
    ) -> None:
        """Update the aggregation-owned data source state table.

        Uses AggregationDataSourceStateORM (in the aggregation schema)
        instead of WorkspaceDataSourceORM (in the public schema).
        Creates the row if it doesn't exist (upsert).
        """
        from .models import AggregationDataSourceStateORM

        try:
            state = await session.get(AggregationDataSourceStateORM, data_source_id)
            if state is None:
                state = AggregationDataSourceStateORM(data_source_id=data_source_id)
                # workspace_id is required — try to read from the job
                state.workspace_id = fields.pop("workspace_id", "")
                session.add(state)
            for key, value in fields.items():
                if value is not None and hasattr(state, key):
                    setattr(state, key, value)
        except Exception as e:
            logger.warning("Failed to update data source state for %s: %s", data_source_id, e)

    async def _materialize_with_retries(
        self,
        session: AsyncSession,
        job: AggregationJobORM,
        provider: Any,
        containment_types: list[str],
        lineage_types: list[str],
    ) -> dict:
        """Retry wrapper around _materialize_with_checkpoints.

        On transient failures (provider timeout, connection error,
        AggregationBatchAbort), retries up to ``job.max_retries`` times
        with exponential backoff + jitter.  Each retry resumes from
        ``job.last_cursor`` (set by the checkpoint callback), so no
        work is repeated beyond the ≤2s coalescing window.

        The retry count and error message are persisted to the job
        record on each attempt so the frontend can display progress.
        """
        max_attempts = (job.max_retries or 3) + 1
        last_error: Exception | None = None
        provider_unavailable_count = 0

        for attempt in range(max_attempts):
            try:
                return await self._materialize_with_checkpoints(
                    session=session,
                    job=job,
                    provider=provider,
                    containment_types=containment_types,
                    lineage_types=lineage_types,
                )
            except ProviderUnavailable as e:
                last_error = e
                provider_unavailable_count += 1
                job.retry_count = attempt + 1

                # Second occurrence whose reason is "Circuit open" — fail fast.
                # Retrying further is pointless: the breaker has already
                # decided the downstream is sick.
                if (
                    provider_unavailable_count >= 2
                    and "circuit open" in (e.reason or "").lower()
                ):
                    job.error_message = (
                        f"Provider {e.provider_name} unavailable after "
                        f"{attempt + 1} attempts; circuit breaker open"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: aborting — provider %s circuit "
                        "open after %d attempts",
                        job.id, e.provider_name, attempt + 1,
                    )
                    raise

                if attempt < max_attempts - 1:
                    exp_backoff = min(5.0 * (2 ** attempt), 120.0) + random.uniform(0, 2)
                    # Breaker is open for at least retry_after_seconds; sleep
                    # at least that long (plus jitter) so the next attempt
                    # arrives after the probe window has elapsed rather than
                    # fast-failing against an OPEN breaker.
                    breaker_delay = (e.retry_after_seconds or 0) + random.uniform(0, 2)
                    delay = max(exp_backoff, breaker_delay)
                    job.error_message = (
                        f"Retry {attempt + 1}/{job.max_retries}: {e}"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: retry %d/%d after %.0fs (provider unavailable) — %s",
                        job.id, attempt + 1, job.max_retries, delay, e,
                    )
                    await asyncio.sleep(delay)
                else:
                    # Final attempt exhausted — let the caller handle it
                    raise
            except Exception as e:
                last_error = e
                job.retry_count = attempt + 1

                if attempt < max_attempts - 1:
                    delay = min(5.0 * (2 ** attempt), 120.0) + random.uniform(0, 2)
                    job.error_message = (
                        f"Retry {attempt + 1}/{job.max_retries}: {e}"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: retry %d/%d after %.0fs — %s",
                        job.id, attempt + 1, job.max_retries, delay, e,
                    )
                    await asyncio.sleep(delay)
                else:
                    # Final attempt exhausted — let the caller handle it
                    raise

        # Unreachable, but satisfies the type checker
        raise last_error  # type: ignore[misc]

    async def _materialize_with_checkpoints(
        self,
        session: AsyncSession,
        job: AggregationJobORM,
        provider: Any,
        containment_types: list[str],
        lineage_types: list[str],
    ) -> dict:
        """Run batch materialization with coalesced DB checkpointing.

        Delegates the actual graph work to the provider's
        materialize_aggregated_edges_batch() method, passing a
        progress_callback that updates ORM state every batch and commits
        on a coalesced cadence (see module docstring). The outer run()'s
        finally block performs the definitive final commit.
        """
        last_commit_monotonic = time.monotonic()
        batches_since_commit = 0
        # Force the first checkpoint to commit no matter how fast the
        # first batch was. Without this, a fast first batch (under the
        # _CHECKPOINT_MAX_INTERVAL_SECS=2.0 threshold and below the
        # 5-batch count) would not commit, leaving the UI showing
        # ``processed_edges = 0`` for up to 5 batches × batch_duration.
        # The first commit is what flips the UI off "0" — make it
        # happen immediately.
        is_first_checkpoint = True

        async def checkpoint(
            processed: int, total: int, cursor: Optional[str], aggregated: int = 0,
        ) -> None:
            nonlocal last_commit_monotonic, batches_since_commit, is_first_checkpoint
            job.processed_edges = processed
            job.total_edges = total
            job.last_cursor = cursor
            if aggregated > 0:
                job.created_edges = aggregated
            job.progress = int((processed / total) * 100) if total > 0 else 0
            job.updated_at = _now()
            job.last_checkpoint_at = _now()
            batches_since_commit += 1
            elapsed = time.monotonic() - last_commit_monotonic
            should_commit = (
                is_first_checkpoint
                or elapsed >= _CHECKPOINT_MAX_INTERVAL_SECS
                or batches_since_commit >= _CHECKPOINT_MAX_BATCHES
            )
            if not should_commit:
                return

            # Wrap commit in a recover-from-failure block. If a single
            # commit fails (transient DB blip, conflicting transaction,
            # etc.) without rolling back, the SQLAlchemy session enters
            # an invalid state and EVERY subsequent operation raises —
            # silently swallowed by the FalkorDB provider's
            # ``progress_callback`` try/except, leaving the UI stuck on
            # ``processed_edges = 0`` for the full duration of the
            # aggregation while FalkorDB happily keeps materialising
            # edges. Rollback restores the session so the next batch
            # can re-attempt the checkpoint with the latest in-memory
            # mutations on ``job`` (preserved across rollback because
            # the JOBS sessionmaker uses ``expire_on_commit=False``).
            try:
                await session.commit()
                last_commit_monotonic = time.monotonic()
                batches_since_commit = 0
                is_first_checkpoint = False
                logger.info(
                    "Aggregation job %s checkpoint: %d/%d edges (%d%%, %d materialized) [committed]",
                    job.id, processed, total, job.progress, job.created_edges,
                )
            except Exception as commit_exc:
                logger.error(
                    "Aggregation job %s checkpoint commit failed (rolling back to "
                    "recover session for next batch): %s",
                    job.id, commit_exc, exc_info=True,
                )
                try:
                    await session.rollback()
                except Exception as rb_exc:
                    logger.error(
                        "Aggregation job %s session rollback after checkpoint commit failure also failed: %s",
                        job.id, rb_exc, exc_info=True,
                    )
                # Reset the cadence counters so the next batch tries
                # to commit again immediately. ``is_first_checkpoint``
                # stays True until a successful commit lands.
                last_commit_monotonic = time.monotonic()
                batches_since_commit = 0

        last_intra_commit_monotonic = time.monotonic()

        async def intra_batch_heartbeat(running_aggregated: int) -> None:
            """Called after every Cypher MERGE sub-batch within an
            outer batch. A single outer batch fans out to 100+ sub-
            batches and runs for several minutes; without this hook
            the operator UI freezes between checkpoint() calls even
            though FalkorDB is steadily writing AGGREGATED edges.

            Updates ``created_edges`` (cumulative, monotonically rising)
            and ``last_checkpoint_at`` (so the UI's "Checkpoint Xm ago"
            badge keeps refreshing — that badge is the operator's "is
            this thing alive?" signal). Deliberately does NOT touch
            ``processed_edges``, ``total_edges``, or ``last_cursor``:
            those advance only at the boundary between outer batches.
            Coalesces commits on the same 2s cadence as the outer
            checkpoint to avoid hammering the JOBS pool.
            """
            nonlocal last_intra_commit_monotonic
            elapsed = time.monotonic() - last_intra_commit_monotonic
            if elapsed < _CHECKPOINT_MAX_INTERVAL_SECS:
                # Update the in-memory counters every sub-batch so
                # the next coalesced commit captures the latest value;
                # skip the commit itself until the cadence threshold.
                job.created_edges = running_aggregated
                job.last_checkpoint_at = _now()
                job.updated_at = _now()
                return

            job.created_edges = running_aggregated
            job.last_checkpoint_at = _now()
            job.updated_at = _now()
            try:
                await session.commit()
                last_intra_commit_monotonic = time.monotonic()
                logger.info(
                    "Aggregation job %s heartbeat: %d aggregated edges materialised so far [committed]",
                    job.id, running_aggregated,
                )
            except Exception as commit_exc:
                logger.error(
                    "Aggregation job %s heartbeat commit failed (rolling back): %s",
                    job.id, commit_exc, exc_info=True,
                )
                try:
                    await session.rollback()
                except Exception as rb_exc:
                    logger.error(
                        "Aggregation job %s session rollback after heartbeat failure also failed: %s",
                        job.id, rb_exc, exc_info=True,
                    )
                last_intra_commit_monotonic = time.monotonic()

        result = await provider.materialize_aggregated_edges_batch(
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
            batch_size=job.batch_size,
            last_cursor=job.last_cursor,
            progress_callback=checkpoint,
            intra_batch_callback=intra_batch_heartbeat,
        )

        return result
