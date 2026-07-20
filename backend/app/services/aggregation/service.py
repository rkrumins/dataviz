"""
AggregationService — REST API-driven aggregation orchestrator.

Owns: job lifecycle, concurrent job guards, ontology resolution,
      crash recovery, scheduling.
Does NOT own: batch materialization (that's the Worker).

This class has NO FastAPI imports. No HTTP concepts. Pure domain logic.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .dispatcher import AggregationDispatcher
from .models import AggregationJobORM
from .reservation import claim_exclusive
from .schemas import (
    AggregationCadence,
    AggregationJobResponse,
    AggregationSettingsResponse,
    AggregationSkipRequest,
    AggregationTriggerRequest,
    AggregationTuning,
    DataSourceReadinessResponse,
    DriftCheckResponse,
    FreshnessDoc,
    FreshnessFleetResponse,
    FreshnessRow,
    FreshnessSummary,
    PaginatedJobsResponse,
    ProviderFreshnessSummary,
    RefreshEventSummary,
    RefreshResponse,
    ResumeOverrides,
    SourceChangedResponse,
)
from .fingerprint import compute_graph_fingerprint, fingerprints_match
from backend.app.ontology import gate as ontology_gate
from backend.app.ontology import runtime as ontology_runtime

logger = logging.getLogger(__name__)

# Rebuild cooldown (eventual-consistency throttle). A confirmed source
# change ALWAYS invalidates caches + marks the source stale, but the
# aggregation REBUILD it queues is throttled to at most one per window per
# source: a connector syncing every few minutes must not fire a full
# rebuild of a multi-million-entity graph each time. Within the window the
# rebuild is deferred (the source stays honestly stale via the marker /
# read-path overlay) and the scheduler reconciler picks it up once the
# window elapses. 0 disables the throttle (always rebuild); ``force=True``
# bypasses it. Read once at import, mirroring the package's env-const style.
AGGREGATION_REBUILD_MIN_INTERVAL_SECS = int(
    __import__("os").getenv("AGGREGATION_REBUILD_MIN_INTERVAL_SECS", "900")
)

# Env default for drift auto-rebuild — the fallback when the persisted global
# cadence leaves ``drift_auto_rebuild`` unset. Canonical here (next to the
# rebuild-interval default) so ``get_settings`` reports EXACTLY the value the
# scheduler falls back to (scheduler imports this as ``_DRIFT_AUTO_REBUILD``).
AGGREGATION_DRIFT_AUTO_REBUILD = (
    __import__("os").getenv("AGGREGATION_DRIFT_AUTO_REBUILD", "true")
    .strip().lower() in ("1", "true", "yes", "on")
)


# ── F9: configurable rebuild cadence ─────────────────────────────────────
# The env-only cooldown/drift knobs are now overridable by a persisted
# GLOBAL (aggregation_settings.cadence_json) and a per-source override
# (data_source_state.rebuild_min_interval_secs). ONE resolution chain —
# ``resolve_rebuild_interval`` — is used by every consumer (the cooldown
# gate, the scheduler reconciler pre-check, and the web-tier badge
# derivation) so the "Next rebuild in Xm" badge never disagrees with the
# behavior. The persisted global is read through a small in-process cache
# (≤ _SETTINGS_CACHE_TTL_S) so the 60s scheduler tick and the fleet read
# never hammer the settings row; put_settings busts it for same-process
# immediacy, and the cache TTL bounds cross-process (web ⇄ CP) propagation.
_SETTINGS_CACHE_TTL_S = 30.0
_GLOBAL_CADENCE_CACHE: dict = {"cadence": None, "at": 0.0}


def resolve_rebuild_interval(
    override_secs: Optional[int], global_secs: Optional[int],
) -> int:
    """Per-source override → persisted global → env default (900).

    ``None`` at a level means "unset, fall through"; 0 is a real value
    (throttle disabled) and is honored, not treated as unset."""
    if override_secs is not None:
        return override_secs
    if global_secs is not None:
        return global_secs
    return AGGREGATION_REBUILD_MIN_INTERVAL_SECS


def invalidate_global_cadence_cache() -> None:
    """Drop the cached global cadence so the next read reflects a just-written
    value in THIS process (put_settings calls this). Cross-process staleness
    is bounded by the cache TTL, not this."""
    _GLOBAL_CADENCE_CACHE["at"] = 0.0


async def read_global_cadence(session: AsyncSession) -> AggregationCadence:
    """Persisted global cadence (aggregation_settings.cadence_json), cached
    in-process for ≤ _SETTINGS_CACHE_TTL_S. NEVER raises — any DB/parse
    failure degrades to an empty cadence (⇒ callers fall through to env),
    mirroring the never-raise convention of the freshness read path."""
    import time as _time
    from .models import AggregationSettingsORM

    now = _time.monotonic()
    cached = _GLOBAL_CADENCE_CACHE
    if cached["cadence"] is not None and (now - cached["at"]) < _SETTINGS_CACHE_TTL_S:
        return cached["cadence"]

    cadence = AggregationCadence()
    try:
        row = await session.get(AggregationSettingsORM, "global")
        raw = getattr(row, "cadence_json", None) if row is not None else None
        if raw:
            cadence = AggregationCadence(**json.loads(raw))
    except Exception as exc:  # pragma: no cover - defensive, never fail a read
        logger.warning(
            "Global cadence read failed (using env defaults): %s", exc,
        )
        return cadence
    cached["cadence"] = cadence
    cached["at"] = now
    return cadence

# Bounds for ``refresh_source(wait="complete")`` — it polls a queued rebuild
# to a terminal status before returning, so an operator can refresh-then-read
# synchronously. Kept short: the caller is holding a request open. Read at
# call time (module-global lookup) so tests can shrink the window.
_REFRESH_WAIT_TIMEOUT_S = 60
_REFRESH_WAIT_INTERVAL_S = 2

# Process-wide handle to the wired AggregationService (set at startup by
# main.py in direct mode / controlplane.py on the CP). Lets non-HTTP
# callers (e.g. the read path's empty-result backfill) create REAL
# aggregation jobs — visible in the UI, executed by the worker fleet —
# instead of running shadow work in-process.
_ACTIVE_SERVICE: Optional["AggregationService"] = None


def set_active_service(svc: "AggregationService") -> None:
    global _ACTIVE_SERVICE
    _ACTIVE_SERVICE = svc


def get_active_service() -> Optional["AggregationService"]:
    return _ACTIVE_SERVICE


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    import uuid
    return f"agg_{uuid.uuid4().hex[:12]}"


def _estimate_completion(job) -> Optional[str]:
    """ETA extrapolated from PHASE-WEIGHTED progress (0-100, monotonic
    across EXTRACT→COMPUTE→RECONCILE→APPLY). The previous
    processed/total extrapolation saturated the moment the extract scan
    finished (~45%% of real work) and promised completion 'now' while
    reconcile/apply were still running."""
    if job.status != "running" or not job.started_at:
        return None
    pct = job.progress or 0
    if pct <= 0:
        return None
    try:
        started = datetime.fromisoformat(job.started_at)
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        if elapsed < 5:
            return None
        pct = min(99, max(1, int(pct)))
        remaining = elapsed * (100 - pct) / pct
        return (
            datetime.now(timezone.utc) + timedelta(seconds=remaining)
        ).isoformat()
    except Exception:
        return None


def _is_resumable(job) -> bool:
    """Whether a job can be MANUALLY resumed/restarted from its checkpoint.

    A user restart is always allowed for a failed or cancelled job — the
    ``max_retries`` cap bounds only AUTOMATED retries (crash recovery /
    delivery attempts), never the user. (Drives the UI's resume affordance.)
    """
    return job.status in ("failed", "cancelled")


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
        from .models import API_TRIGGER_SOURCES, AggregationDataSourceStateORM

        # Reject unknown sources HERE (ValueError → 422 at both endpoints)
        # instead of letting the jobs-table CHECK constraint raise an
        # IntegrityError 500 — that failure mode silently broke both
        # automatic callers (post_purge from the purge worker, auto from
        # the read-path backfill). 'purge' is valid in the table but not
        # mintable through trigger(): those rows mark the purge lifecycle
        # itself and are excluded from the reconciler/recovery/resume.
        if trigger_source not in API_TRIGGER_SOURCES:
            raise ValueError(
                f"invalid trigger_source {trigger_source!r}; expected one of "
                f"{', '.join(API_TRIGGER_SOURCES)}"
            )

        # An EXPLICIT (non-auto) trigger clears the terminal-failure
        # backoff key: the user is deliberately retrying (typically after
        # raising the budget in the tuning dialog), so the read path's
        # self-heal suppression must not outlive their intent.
        if trigger_source != "auto":
            try:
                from backend.app.services.aggregation.redis_client import get_redis
                await get_redis().delete(f"materialize:terminal:{ds_id}")
            except Exception as exc:
                logger.debug("terminal-backoff clear failed for %s: %s", ds_id, exc)

        # ── Phase 2.2 — idempotency early-return (read-only fast path) ──
        # Two POSTs sharing a key for the same data source within 60 min
        # collapse to the original job (200 with the existing job ID).
        # Done outside the transaction so non-key-bearing callers don't
        # pay a lookup cost.
        #
        # The replay is ontology-aware. The prior job freezes
        # ``containment_edge_types`` / ``lineage_edge_types`` at trigger
        # time, so an unconditional replay would mask edits the user made
        # to the ontology between runs (the original "edits not picked
        # up on re-run" bug). Replay only short-circuits when the prior
        # job's ``ontology_fingerprint`` matches the current ontology —
        # otherwise the prior job is treated as stale and we fall
        # through to a fresh resolve.
        idem_key = request.idempotency_key
        cutoff_iso = (
            datetime.now(timezone.utc) - timedelta(minutes=60)
        ).isoformat()
        if idem_key:
            existing_idem = (
                await session.execute(
                    select(AggregationJobORM)
                    .where(AggregationJobORM.data_source_id == ds_id)
                    .where(AggregationJobORM.idempotency_key == idem_key)
                    .where(AggregationJobORM.created_at >= cutoff_iso)
                    .order_by(AggregationJobORM.created_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if existing_idem is not None:
                if await self._replay_fingerprint_matches(
                    existing_idem, ds_id, session,
                ):
                    logger.info(
                        "Idempotent replay for data source %s — returning job %s "
                        "(idempotency_key=%s)",
                        ds_id, existing_idem.id, idem_key,
                    )
                    return self._to_response(existing_idem)
                logger.info(
                    "Skipping idempotent replay for data source %s job %s — "
                    "ontology fingerprint changed since first trigger; "
                    "running a fresh resolve",
                    ds_id, existing_idem.id,
                )

        # ── Atomic claim (Phase 2 §2.1) ────────────────────────────
        # `claim_exclusive` combines a pg_try_advisory_xact_lock with
        # SELECT ... FOR UPDATE SKIP LOCKED so concurrent triggers across
        # uvicorn workers / replicas serialize cleanly: at most one caller
        # ever observes "no active job" for a given data_source_id.
        #
        # A read earlier in this request — the permission dependency loading
        # the data source, or the idempotency lookup above — autobegins a
        # transaction on this shared WEB session (``_session_scope`` commits
        # on success but does not open the transaction itself). ``session.
        # begin()`` requires that none be active, so roll back the empty
        # read transaction first. Safe: nothing has been written before this
        # point — the block below performs the first writes.
        if session.in_transaction():
            await session.rollback()
        try:
            job, lineage_types = await self._trigger_insert(
                ds_id, request, trigger_source, session, idem_key, cutoff_iso,
            )
        except IntegrityError:
            # Unique-index race on (data_source_id, idempotency_key): a
            # concurrent trigger inserted the same key between our replay
            # lookup and this commit. Return THAT job as the replay —
            # surfacing the constraint as a 500 broke retrying callers.
            await session.rollback()
            if idem_key:
                replay = (
                    await session.execute(
                        select(AggregationJobORM)
                        .where(AggregationJobORM.data_source_id == ds_id)
                        .where(AggregationJobORM.idempotency_key == idem_key)
                        .order_by(AggregationJobORM.created_at.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if replay is not None:
                    logger.warning(
                        "Idempotency unique-index race for data source %s "
                        "(key=%s) — returning existing job %s",
                        ds_id, idem_key, replay.id,
                    )
                    return self._to_response(replay)
            raise

        # Dispatch AFTER commit so the worker sees the persisted row
        await self._dispatcher.dispatch(job.id)

        logger.info(
            "Aggregation job %s created for data source %s (trigger: %s, edges: %s)",
            job.id, ds_id, trigger_source, lineage_types,
        )

        return self._to_response(job)

    async def _trigger_insert(
        self,
        ds_id: str,
        request: AggregationTriggerRequest,
        trigger_source: str,
        session: AsyncSession,
        idem_key: Optional[str],
        cutoff_iso: str,
    ):
        """The claim + resolve + INSERT transaction body of ``trigger``."""
        async with session.begin():
            if not await claim_exclusive(session, ds_id):
                if idem_key:
                    replay = (
                        await session.execute(
                            select(AggregationJobORM)
                            .where(AggregationJobORM.data_source_id == ds_id)
                            .where(AggregationJobORM.idempotency_key == idem_key)
                            .where(AggregationJobORM.created_at >= cutoff_iso)
                            .order_by(AggregationJobORM.created_at.desc())
                            .limit(1)
                        )
                    ).scalar_one_or_none()
                    if replay is not None and await self._replay_fingerprint_matches(
                        replay, ds_id, session,
                    ):
                        return self._to_response(replay)
                raise ConflictError(
                    "An aggregation job is already active for this data source"
                )

            # Resolve ontology via direct service call (CRIT-5)
            ontology_data = await self._resolve_ontology(ds_id, session)

            # ── Graph-level guard ──────────────────────────────────
            # Multiple data sources can point to the same FalkorDB graph.
            # Running parallel jobs on the same graph is wasteful: the
            # Redis idempotency sets (keyed by graph_name) mean only the
            # first job creates AGGREGATED edges — subsequent jobs process
            # edges but produce nothing because SADD returns 0.
            # Block the trigger if another data source on the same graph
            # already has an active job.
            graph_name = ontology_data.get("graph_name")
            if graph_name:
                conflicting_job = (
                    await session.execute(
                        select(AggregationJobORM)
                        .where(AggregationJobORM.graph_name == graph_name)
                        .where(AggregationJobORM.data_source_id != ds_id)
                        .where(AggregationJobORM.status.in_(["pending", "running"]))
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if conflicting_job:
                    raise ConflictError(
                        f"Another aggregation job ({conflicting_job.id}) is already "
                        f"active on graph '{graph_name}' via data source "
                        f"{conflicting_job.data_source_id}. Wait for it to complete "
                        f"or cancel it first."
                    )
            containment_types = ontology_data.get("containment_edge_types", [])
            lineage_types = ontology_data.get("lineage_edge_types", [])
            # Empty-lineage is no longer possible here — the gate's
            # ``no_lineage`` blocking reason already raised
            # OntologyResolutionError inside ``_resolve_ontology``. The
            # frozen list still gets persisted for the worker.

            # Create job with frozen edge types + denormalized graph metadata
            job_kwargs = dict(
                id=_generate_id(),
                data_source_id=ds_id,
                workspace_id=ontology_data.get("workspace_id"),
                provider_id=ontology_data.get("provider_id"),
                graph_name=ontology_data.get("graph_name"),
                data_source_label=ontology_data.get("data_source_label"),
                ontology_id=ontology_data.get("ontology_id"),
                ontology_fingerprint=ontology_data.get("ontology_fingerprint"),
                projection_mode=request.projection_mode,
                containment_edge_types=json.dumps(containment_types),
                lineage_edge_types=json.dumps(lineage_types),
                entity_type_levels=json.dumps(
                    ontology_data.get("entity_type_levels") or {}
                ),
                status="pending",
                trigger_source=trigger_source,
                batch_size=request.batch_size,
                idempotency_key=idem_key,
                # Per-job overrides: when None, the worker / ORM defaults
                # apply (timeout_secs → stall-timeout env, max_retries → 3).
                timeout_secs=request.timeout_secs,
                # Pipeline tuning: request overrides layered over the stored
                # global defaults, frozen here so the worker stays stateless.
                tuning_json=(lambda t: json.dumps(t) if t else None)(
                    await self._effective_tuning(session, getattr(request, "tuning", None))
                ),
                created_at=_now(),
            )
            # Only set max_retries when caller supplied one, so the ORM
            # column default (3) is honoured for backwards-compat callers.
            if request.max_retries is not None:
                job_kwargs["max_retries"] = request.max_retries
            job = AggregationJobORM(**job_kwargs)
            session.add(job)

            # Update aggregation-owned state table
            await self._upsert_ds_state(session, ds_id, aggregation_status="pending")
            # session.begin() commits on context exit

        return job, lineage_types

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

        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            raise NotFoundError(f"Data source {ds_id} not found in aggregation state")

        state.aggregation_status = "skipped"
        await session.commit()

        logger.info("Aggregation skipped for data source %s", ds_id)

        # Skipping aggregation means the worker's ensure_indices call never
        # runs for this source — without this, the graph's per-label indexes
        # only materialize on the first read that triggers a full ontology
        # resolution, and that first user query pays the DDL + cold-scan
        # cost. Ensure them now, best-effort: a failure must never turn a
        # confirmed skip into an error.
        try:
            await self._ensure_indices_for_skip(ds_id, state.workspace_id, session)
        except Exception as exc:
            logger.warning(
                "post-skip ensure_indices failed for data source %s: %s", ds_id, exc
            )

        return await self.get_readiness(ds_id, session)

    async def _ensure_indices_for_skip(
        self, ds_id: str, workspace_id: Optional[str], session: AsyncSession
    ) -> None:
        """Best-effort label-index creation for a source whose aggregation was skipped."""
        provider = await self._registry.get_provider_for_workspace(
            workspace_id, session, data_source_id=ds_id,
        )
        ensure = getattr(provider, "ensure_indices", None)
        if ensure is None:
            return

        entity_type_ids: list[str] = []
        from backend.app.db.models import OntologyORM, WorkspaceDataSourceORM

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if ds is not None and ds.ontology_id:
            ontology = await session.get(OntologyORM, ds.ontology_id)
            if ontology is not None:
                entity_type_ids = list(
                    json.loads(ontology.entity_type_definitions or "{}").keys()
                )

        await ensure(entity_type_ids)
        logger.info(
            "ensured %d ontology label indexes for skipped data source %s",
            len(entity_type_ids), ds_id,
        )

    # ── Status ────────────────────────────────────────────────────────

    async def get_readiness(
        self, ds_id: str, session: AsyncSession
    ) -> DataSourceReadinessResponse:
        """Get the aggregation readiness status for a data source."""
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            # No state row yet — data source exists but aggregation never configured
            return DataSourceReadinessResponse(
                data_source_id=ds_id,
                is_ready=False,
                aggregation_status="none",
                can_create_views=False,
                active_job=None,
                drift_detected=False,
                last_aggregated_at=None,
                aggregation_edge_count=0,
                message="Aggregation has not been configured. Aggregate or skip to create views.",
            )

        # Find active job (if any)
        active_result = await session.execute(
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .where(AggregationJobORM.status.in_(["pending", "running"]))
            .order_by(AggregationJobORM.created_at.desc())
        )
        active_job = active_result.scalar_one_or_none()

        status = state.aggregation_status or "none"

        can_create = status in ("ready", "skipped")
        is_ready = status == "ready"

        # Check for drift using the aggregation-owned fingerprint
        drift = False
        _DRIFT_TIMEOUT = float(__import__("os").getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5"))
        if is_ready and state.graph_fingerprint:
            try:
                provider = await asyncio.wait_for(
                    self._registry.get_provider_for_workspace(
                        state.workspace_id, session, data_source_id=ds_id,
                    ),
                    timeout=_DRIFT_TIMEOUT,
                )
                current_fp = await asyncio.wait_for(
                    compute_graph_fingerprint(provider),
                    timeout=_DRIFT_TIMEOUT,
                )
                drift = not fingerprints_match(state.graph_fingerprint, current_fp)
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
            last_aggregated_at=state.last_aggregated_at,
            aggregation_edge_count=state.aggregation_edge_count or 0,
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

    # ── Global summary (KPI stats) ─────────────────────────────────

    async def get_jobs_summary(self, session: AsyncSession) -> dict:
        """Return aggregate KPI stats across all aggregation jobs."""
        # Count by status
        status_q = (
            select(
                AggregationJobORM.status,
                func.count(AggregationJobORM.id),
            )
            .group_by(AggregationJobORM.status)
        )
        status_rows = (await session.execute(status_q)).all()
        by_status = {row[0]: row[1] for row in status_rows}
        total = sum(by_status.values())

        completed = by_status.get("completed", 0)
        failed = by_status.get("failed", 0)
        denominator = completed + failed
        success_rate = round(completed / denominator * 100, 1) if denominator > 0 else None

        # Average duration for completed jobs (from started_at to completed_at)
        dur_q = (
            select(
                AggregationJobORM.started_at,
                AggregationJobORM.completed_at,
            )
            .where(AggregationJobORM.status == "completed")
            .where(AggregationJobORM.started_at.isnot(None))
            .where(AggregationJobORM.completed_at.isnot(None))
            .order_by(AggregationJobORM.created_at.desc())
            .limit(50)  # last 50 completed jobs
        )
        dur_rows = (await session.execute(dur_q)).all()
        durations = []
        for started_at, completed_at in dur_rows:
            try:
                s = datetime.fromisoformat(started_at)
                e = datetime.fromisoformat(completed_at)
                durations.append((e - s).total_seconds())
            except Exception:
                pass
        avg_duration = round(sum(durations) / len(durations), 1) if durations else None

        return {
            "total": total,
            "byStatus": by_status,
            "successRate": success_rate,
            "avgDurationSeconds": avg_duration,
        }

    # ── Global listing (cross-workspace) ─────────────────────────────

    async def list_jobs_global(
        self,
        session: AsyncSession,
        *,
        status: Optional[List[str]] = None,
        workspace_id: Optional[str] = None,
        data_source_ids: Optional[List[str]] = None,
        projection_mode: Optional[str] = None,
        trigger_source: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 25,
        offset: int = 0,
    ) -> PaginatedJobsResponse:
        """List aggregation jobs across all data sources and workspaces.

        Uses denormalized columns on AggregationJobORM (workspace_id,
        data_source_label) instead of JOINing to the public schema.
        No cross-schema dependency.
        """
        # Base query: AggregationJobORM only (denormalized columns)
        base = select(AggregationJobORM)

        # Apply filters conditionally
        if status:
            base = base.where(AggregationJobORM.status.in_(status))
        if workspace_id:
            base = base.where(AggregationJobORM.workspace_id == workspace_id)
        if data_source_ids:
            base = base.where(AggregationJobORM.data_source_id.in_(data_source_ids))
        if projection_mode:
            base = base.where(AggregationJobORM.projection_mode == projection_mode)
        if trigger_source:
            base = base.where(AggregationJobORM.trigger_source == trigger_source)
        if date_from:
            base = base.where(AggregationJobORM.created_at >= date_from)
        if date_to:
            base = base.where(AggregationJobORM.created_at <= date_to + "T23:59:59.999999")
        if search:
            pattern = f"%{search}%"
            base = base.where(or_(
                AggregationJobORM.id.ilike(pattern),
                AggregationJobORM.error_message.ilike(pattern),
                AggregationJobORM.data_source_label.ilike(pattern),
            ))

        # Count total matching rows
        count_q = select(func.count()).select_from(base.subquery())
        total = (await session.execute(count_q)).scalar() or 0

        # Fetch paginated results
        rows_q = (
            base
            .order_by(AggregationJobORM.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await session.execute(rows_q)
        jobs = result.scalars().all()

        items = [
            self._to_global_response(job, job.workspace_id, None, job.data_source_label)
            for job in jobs
        ]

        return PaginatedJobsResponse(items=items, total=total, limit=limit, offset=offset)

    @staticmethod
    def _to_global_response(
        job: AggregationJobORM,
        workspace_id: str,
        workspace_name: str,
        data_source_label: Optional[str],
    ) -> AggregationJobResponse:
        """Convert ORM to enriched response for the global listing."""
        # Compute duration
        duration = None
        if job.started_at:
            try:
                started = datetime.fromisoformat(job.started_at)
                if job.completed_at:
                    ended = datetime.fromisoformat(job.completed_at)
                else:
                    ended = datetime.now(timezone.utc)
                duration = round((ended - started).total_seconds(), 1)
            except Exception:
                pass

        # Compute coverage
        coverage = None
        if job.total_edges and job.total_edges > 0:
            coverage = round(job.processed_edges / job.total_edges * 100, 1)

        # Estimate completion (same logic as _to_response)
        estimated = _estimate_completion(job)

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
            resumable=_is_resumable(job),
            retry_count=job.retry_count,
            error_message=job.error_message,
            estimated_completion_at=estimated,
            started_at=job.started_at,
            completed_at=job.completed_at,
            updated_at=job.updated_at,
            created_at=job.created_at,
            workspace_id=workspace_id,
            workspace_name=workspace_name,
            data_source_label=data_source_label,
            projection_mode=job.projection_mode,
            duration_seconds=duration,
            edge_coverage_pct=coverage,
            last_cursor=job.last_cursor,
            max_retries=job.max_retries,
            timeout_secs=job.timeout_secs,
            # Phase 1.7 — UI phase visibility. May be NULL on legacy
            # rows (column didn't exist) and on paths that don't emit
            # phase signals; getattr with default keeps this backward-
            # compatible against any ORM instance that pre-dates the
            # column.
            current_phase=getattr(job, "current_phase", None),
            tuning=AggregationService._job_tuning_dict(job),
            run_stats=AggregationService._job_run_stats_dict(job),
            worker_id=getattr(job, "worker_id", None),
        )


    # ── Global tuning defaults (settings) ─────────────────────────────

    async def _effective_tuning(
        self, session: AsyncSession, request_tuning: Optional[AggregationTuning],
    ) -> dict:
        """Request tuning layered over the stored global defaults. The
        merged dict is frozen onto the job row so the worker never reads
        the settings table (stateless jobs; consistent with the frozen
        edge-type pattern)."""
        from .models import AggregationSettingsORM

        defaults: dict = {}
        try:
            row = await session.get(AggregationSettingsORM, "global")
            if row is not None and row.tuning_json:
                defaults = json.loads(row.tuning_json) or {}
        except Exception as exc:
            logger.warning(
                "Aggregation settings read failed (using env defaults): %s", exc,
            )
        if request_tuning is None:
            return defaults
        return request_tuning.merged_over(defaults)

    async def get_settings(self, session: AsyncSession) -> AggregationSettingsResponse:
        from .models import AggregationSettingsORM

        # Always report the effective ENV defaults so the editor seeds from
        # ``persisted ?? envDefault`` (present whether or not a row exists).
        env_kwargs = dict(
            env_rebuild_min_interval_secs=AGGREGATION_REBUILD_MIN_INTERVAL_SECS,
            env_drift_auto_rebuild=AGGREGATION_DRIFT_AUTO_REBUILD,
        )
        row = await session.get(AggregationSettingsORM, "global")
        if row is None:
            return AggregationSettingsResponse(tuning=None, **env_kwargs)
        try:
            tuning = (
                AggregationTuning(**json.loads(row.tuning_json))
                if row.tuning_json else None
            )
        except Exception:
            tuning = None
        try:
            cadence = (
                AggregationCadence(**json.loads(row.cadence_json))
                if getattr(row, "cadence_json", None) else None
            )
        except Exception:
            cadence = None
        return AggregationSettingsResponse(
            tuning=tuning,
            cadence=cadence,
            updated_at=row.updated_at,
            updated_by=row.updated_by,
            **env_kwargs,
        )

    async def put_settings(
        self,
        session: AsyncSession,
        tuning: Optional[AggregationTuning] = None,
        updated_by: Optional[str] = None,
        cadence: Optional[AggregationCadence] = None,
    ) -> AggregationSettingsResponse:
        """Persist the global aggregation defaults. ``tuning`` and ``cadence``
        are independent columns on the single settings row: each is written
        only when supplied, so the pipeline-tuning editor and the cadence
        editor never clobber each other. Busts the in-process cadence cache
        so a same-process consumer sees the change immediately."""
        from .models import AggregationSettingsORM

        row = await session.get(AggregationSettingsORM, "global")
        if row is None:
            row = AggregationSettingsORM(id="global")
            session.add(row)
        if tuning is not None:
            row.tuning_json = json.dumps(tuning.model_dump(exclude_none=True))
        if cadence is not None:
            row.cadence_json = json.dumps(cadence.model_dump(exclude_none=True))
        row.updated_at = _now()
        row.updated_by = updated_by
        await session.commit()
        invalidate_global_cadence_cache()
        # Echo the stored state (re-parse the columns rather than only the
        # request, so a tuning-only PUT still returns the persisted cadence).
        return await self.get_settings(session)

    # ── Resume ────────────────────────────────────────────────────────

    async def resume(
        self,
        ds_id: str,
        job_id: str,
        session: AsyncSession,
        overrides: Optional[ResumeOverrides] = None,
    ) -> AggregationJobResponse:
        """Resume a failed aggregation job from its last checkpoint.

        Optional `overrides` lets the caller bump per-job parameters
        (timeout_secs, batch_size, projection_mode, max_retries) before
        the worker picks the job back up. The checkpoint (`last_cursor`)
        is intentionally preserved — that's the whole point of resume.
        """
        job = await session.get(AggregationJobORM, job_id)
        if not job or job.data_source_id != ds_id:
            raise NotFoundError(f"Aggregation job {job_id} not found")

        if job.status not in ("failed", "cancelled"):
            raise ValueError(
                f"Job {job_id} is not resumable (current status: {job.status}; "
                f"resume requires 'failed' or 'cancelled')"
            )
        if job.trigger_source == "purge":
            raise ValueError(
                f"Job {job_id} is a purge job — it cannot be resumed as an "
                "aggregation run. Re-run the purge from the data source "
                "actions instead."
            )

        # Apply optional per-job overrides (e.g. a larger timeout / batch).
        if overrides is not None:
            if overrides.timeout_secs is not None:
                job.timeout_secs = overrides.timeout_secs
            if overrides.batch_size is not None:
                job.batch_size = overrides.batch_size
            if overrides.projection_mode is not None:
                job.projection_mode = overrides.projection_mode
            if overrides.max_retries is not None:
                job.max_retries = overrides.max_retries
            if overrides.tuning is not None:
                # Layer the new tuning over whatever the job carries so a
                # partial override (e.g. just writePacingRatio) keeps the
                # rest of the frozen tuning intact.
                try:
                    current = json.loads(job.tuning_json or "{}")
                except (TypeError, ValueError):
                    current = {}
                job.tuning_json = json.dumps(
                    overrides.tuning.merged_over(current)
                )

        # A manual resume/restart is ALWAYS allowed for a failed/cancelled job —
        # the max_retries cap bounds only AUTOMATED retries (crash recovery /
        # delivery attempts), never the user. We RESET the automated retry
        # budget so the restarted run gets a fresh set of auto-retries for
        # transient provider blips (e.g. FalkorDB "BusyLoadingError: Redis is
        # loading the dataset in memory"). The checkpoint (last_cursor) is
        # preserved, so it resumes from where it stopped — not from zero.
        job.status = "pending"
        job.retry_count = 0
        job.error_message = None
        job.updated_at = _now()
        await session.commit()

        await self._dispatcher.dispatch(job.id)

        logger.info(
            "Aggregation job %s manually resumed (automated retry budget reset; "
            "max_retries=%d)", job_id, job.max_retries,
        )

        return self._to_response(job)

    # ── Cancel ────────────────────────────────────────────────────────

    async def cancel(
        self, ds_id: str, job_id: str, session: AsyncSession
    ) -> AggregationJobResponse:
        """Cancel a pending or running aggregation job.

        Cooperative-first: requests the worker to exit at the next safe
        boundary (between MERGE sub-batches or at an outer-batch
        commit), so the in-flight FalkorDB MERGE completes cleanly and
        ``last_cursor`` reflects durably-committed work. The worker
        itself flips status='cancelled' when it observes the request,
        emits the ``job_cancelled`` event, and unregisters.

        For pending jobs (no worker is running), we mark cancelled
        directly and emit the event — there's nothing to coordinate
        with. For running jobs we keep the dispatcher's
        ``cancel_task`` as a hard fallback that fires after a grace
        period, but the cooperative path should win in practice.
        """
        from .cancel import request_cancel as request_cooperative_cancel

        job = await session.get(AggregationJobORM, job_id)
        if not job or job.data_source_id != ds_id:
            raise NotFoundError(f"Aggregation job {job_id} not found")

        if job.status not in ("pending", "running"):
            raise ValueError(f"Job {job_id} cannot be cancelled (status: {job.status})")

        # Cooperative cancel — fire on TWO paths in parallel:
        #
        #   1. Local CancelRegistry (in-process). Immediate effect for
        #      jobs hosted in this same process (web tier under
        #      InProcessDispatcher, or — when this code runs in the
        #      worker process via a callback — for jobs that worker
        #      owns). No Redis round-trip; the event flips
        #      synchronously.
        #
        #   2. Redis Pub/Sub broadcast. Reaches every other process
        #      that has a CancelListener subscribed (aggregation
        #      worker process, insights worker process, additional
        #      web-tier replicas). Each listener forwards to its own
        #      local registry, so the worker hosting the job sees its
        #      event get set even though the request landed somewhere
        #      else.
        #
        # We always publish to Redis even when the local registry
        # claims the job — broadcasts are cheap, and the alternative
        # (skip publish on local hit) breaks if a duplicate
        # registration ever happens cross-process. The listener's
        # local-registry check is idempotent.
        if job.status == "running":
            local_hit = request_cooperative_cancel(job_id)
            try:
                from .redis_client import get_redis
                from .cancel import publish_cancel
                await publish_cancel(get_redis(), job_id)
            except Exception as exc:
                # Pub/Sub publish failed; fall back to direct DB write
                # below. Not fatal — local cancel may still have
                # landed, and the dispatcher's hard task.cancel()
                # remains as the last-resort escape hatch.
                logger.warning(
                    "Aggregation job %s: cross-process cancel publish failed "
                    "(falling back to local + direct DB write): %s",
                    job_id, exc,
                )
                local_hit = local_hit  # no change; DB-write path follows

            if local_hit:
                logger.info(
                    "Aggregation job %s: cooperative cancel requested locally "
                    "+ broadcast; worker will transition at next safe boundary",
                    job_id,
                )
                await session.refresh(job)
                return self._to_response(job)
            # No local hit — the worker is in another process. The
            # broadcast we just fired should reach it; flip the DB
            # row to ``cancelled`` now so the UI reflects the user's
            # intent immediately, and the dispatcher's hard
            # task.cancel() fallback fires below as a belt-and-braces
            # path for the very unlikely case where pub/sub silently
            # dropped the message AND the worker keeps running.
            logger.info(
                "Aggregation job %s: no local registry hit; cross-process "
                "cancel broadcast + direct DB write",
                job_id,
            )

        # Pending job, or no worker registered (e.g. the worker process
        # crashed and the row is orphaned). Mark cancelled directly.
        job.status = "cancelled"
        job.completed_at = _now()
        job.updated_at = _now()
        await session.commit()

        # Hard fallback for the orphaned-row case where there's no
        # cooperative consumer to honour the event.
        if hasattr(self._dispatcher, "cancel_task"):
            self._dispatcher.cancel_task(job_id)

        logger.info("Aggregation job %s cancelled (direct path)", job_id)

        return self._to_response(job)

    # ── Delete job record ───────────────────────────────────────────

    async def delete_job(self, job_id: str, session: AsyncSession) -> None:
        """Delete a terminal aggregation job record from history."""
        job = await session.get(AggregationJobORM, job_id)
        if not job:
            raise NotFoundError(f"Aggregation job {job_id} not found")

        if job.status in ("pending", "running"):
            raise ValueError(
                f"Cannot delete job {job_id} while it is {job.status}. Cancel it first."
            )

        await session.delete(job)
        await session.commit()
        logger.info("Aggregation job %s deleted from history", job_id)

    # ── Purge ─────────────────────────────────────────────────────────
    #
    # Purge is a long-running provider operation (``MATCH ... DELETE``
    # against millions of aggregated edges) that runs as a regular
    # insights-service Redis Streams job — see
    # ``backend/insights_service/purge.py``. The web tier only claims a
    # ``pending`` row in ``aggregation_jobs`` and hands the job off; it
    # never blocks on the provider DELETE.
    #
    # That gets us, for free: retry on transient errors via
    # delivery-count + DLQ; crash recovery via XAUTOCLAIM at worker
    # startup; the soft-retry path when the provider is throttled
    # (no DLQ cascade); the per-graph asyncio.Semaphore so concurrent
    # purges of the same graph serialise.

    async def claim_purge_job(
        self, ds_id: str, session: AsyncSession,
        *, skip_reaggregate: bool = False,
    ) -> AggregationJobORM:
        """Reserve a ``pending`` purge slot in ``aggregation_jobs``.

        Raises ``NotFoundError`` if the data source has no aggregation
        state, ``ConflictError`` if another aggregation/purge job is
        already in flight for this data source. The caller hands the
        returned ``job.id`` to the insights-service worker via
        ``enqueue_purge_job_safe`` — see ``aggregation.py`` /
        ``controlplane.py`` purge endpoints.
        """
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            raise NotFoundError(f"Data source {ds_id} not found in aggregation state")

        # Resolve the canonical workspace_id from the source-of-truth
        # row (``workspace_data_sources.workspace_id`` is nullable=False)
        # so we can backfill the aggregation state cache when it has
        # drifted. Without this fall-back, a state row that was written
        # before workspace_id was being set would block every purge
        # forever, and the insights enqueue layer's envelope guard
        # would silently swallow the request anyway.
        from backend.app.db.models import WorkspaceDataSourceORM
        ds_orm = await session.get(WorkspaceDataSourceORM, ds_id)
        if ds_orm is not None and ds_orm.deleted_at is not None:
            ds_orm = None  # a tombstone is not a source of truth — take the missing-row paths
        if not state.workspace_id:
            canonical_ws = ds_orm.workspace_id if ds_orm else None
            if not canonical_ws:
                raise NotFoundError(
                    f"Data source {ds_id} has no workspace assignment in "
                    "either aggregation_data_source_state or "
                    "workspace_data_sources. Assign the data source to a "
                    "workspace before purging."
                )
            logger.warning(
                "claim_purge_job: backfilling empty workspace_id for ds=%s "
                "from workspace_data_sources (canonical_ws=%s)",
                ds_id, canonical_ws,
            )
            state.workspace_id = canonical_ws

        active = (
            await session.execute(
                select(AggregationJobORM)
                .where(AggregationJobORM.data_source_id == ds_id)
                .where(AggregationJobORM.status.in_(["pending", "running"]))
            )
        ).scalars().first()
        if active:
            raise ConflictError(
                f"Cannot purge while aggregation job {active.id} is active"
            )

        actual_mode = (ds_orm.projection_mode if ds_orm else None) or "in_source"

        now = _now()
        # Purge jobs don't use ``batch_size`` semantically — DELETE
        # queries don't iterate in batches the way aggregation INSERTs
        # do — but the field is non-null on the ORM model and the
        # ``AggregationTriggerRequest`` schema enforces ``ge=100``.
        # Storing 0 broke any downstream code that read the row back
        # through that schema (e.g. the Retrigger dialog reading
        # ``job.batchSize`` from history). Use the same default as
        # ``AggregationTriggerRequest.batch_size`` so a re-read always
        # validates.
        purge_job = AggregationJobORM(
            id=_generate_id(),
            data_source_id=ds_id,
            workspace_id=state.workspace_id,
            status="pending",
            trigger_source="purge",
            projection_mode=actual_mode,
            progress=0,
            total_edges=0,
            processed_edges=0,
            created_edges=0,
            batch_size=5000,
            retry_count=0,
            max_retries=0,
            # Post-purge behavior rides the row so redelivery keeps it:
            # by default the purge worker triggers a fresh aggregation
            # job on completion (container-level lineage is blind until
            # the canonical cells are rebuilt); the UI can opt out.
            tuning_json=(
                json.dumps({"skip_reaggregate": True})
                if skip_reaggregate else None
            ),
            created_at=now,
            updated_at=now,
        )
        session.add(purge_job)
        await session.commit()
        await session.refresh(purge_job)

        logger.info(
            "Purge job %s claimed for ds=%s (mode=%s) — handing off to insights worker",
            purge_job.id, ds_id, actual_mode,
        )
        return purge_job

    # ── Schedule ──────────────────────────────────────────────────────

    async def set_schedule(
        self, ds_id: str, cron: Optional[str], session: AsyncSession
    ) -> None:
        """Set or clear the aggregation schedule for a data source."""
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            raise NotFoundError(f"Data source {ds_id} not found in aggregation state")

        state.aggregation_schedule = cron
        await session.commit()

        logger.info("Aggregation schedule %s for data source %s", cron or "cleared", ds_id)

    async def set_source_rebuild_interval(
        self, ds_id: str, secs: Optional[int], session: AsyncSession
    ) -> Optional[int]:
        """Set or clear the per-source rebuild-interval override. ``None``
        clears it (the source resolves the global/env default). Requires the
        aggregation state row to exist (mirrors ``set_schedule``): the
        override only bites once a source has been aggregated, which is when
        the state row exists. Returns the stored value."""
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            raise NotFoundError(f"Data source {ds_id} not found in aggregation state")

        state.rebuild_min_interval_secs = secs
        await session.commit()
        logger.info(
            "Rebuild interval override %s for data source %s",
            f"{secs}s" if secs is not None else "cleared", ds_id,
        )
        return secs

    # ── Change Detection ──────────────────────────────────────────────

    async def check_drift(
        self, ds_id: str, session: AsyncSession
    ) -> DriftCheckResponse:
        """Check if the underlying graph has changed since last aggregation."""
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if not state:
            raise NotFoundError(f"Data source {ds_id} not found in aggregation state")

        _DRIFT_TIMEOUT = float(__import__("os").getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5"))
        try:
            provider = await asyncio.wait_for(
                self._registry.get_provider_for_workspace(
                    state.workspace_id, session, data_source_id=ds_id,
                ),
                timeout=_DRIFT_TIMEOUT,
            )
            current_fp = await asyncio.wait_for(
                compute_graph_fingerprint(provider),
                timeout=_DRIFT_TIMEOUT,
            )
        except Exception as e:
            logger.warning("Failed to compute fingerprint for drift check: %s", e)
            return DriftCheckResponse(
                drift_detected=False,
                current_fingerprint=None,
                stored_fingerprint=state.graph_fingerprint,
                last_checked_at=_now(),
            )

        drift = not fingerprints_match(state.graph_fingerprint, current_fp)

        return DriftCheckResponse(
            drift_detected=drift,
            current_fingerprint=current_fp,
            stored_fingerprint=state.graph_fingerprint,
            last_checked_at=_now(),
        )

    # Statuses where aggregation doesn't apply — the source was never
    # configured ("none", including the no-state-row case) or the user
    # opted out ("skipped"). The source-changed signal still invalidates
    # caches for these but skips queuing a rebuild.
    _AGG_NOT_APPLICABLE = frozenset({"none", "skipped"})

    async def signal_source_changed(
        self, ds_id: str, session: AsyncSession, *,
        reason: str = "external_load", force: bool = False,
        origin: str = "api", actor: str = "internal",
    ) -> SourceChangedResponse:
        """Convergence entry point after a DIRECT write to a source's graph.

        External loaders (seed/import scripts, connectors) write FalkorDB
        without going through the app's write paths, so read caches and the
        :AGGREGATED overlay go stale silently. This signal, once a real
        change is confirmed via the graph fingerprint, marks the source
        stale, clears content caches, invalidates hierarchy read caches,
        nudges stats, and queues an idempotency-keyed rebuild.

        Change-gated: unless ``force``, a fingerprint that matches the last
        aggregated fingerprint is a no-op — NOTHING after the gate runs.
        An empty/unknown current fingerprint (compute failure or timeout)
        is treated as a mismatch (fails open toward "changed").

        Best-effort convergence: steps 4-7 use helpers that never raise; a
        trigger failure after invalidation (job already active, or ontology
        resolution failing) yields ``changed=True, job_id=None`` rather than
        failing the signal — the invalidation already happened and must not
        be undone.

        The stored ``graph_fingerprint`` is deliberately NOT updated here —
        the event listener writes it on ``job.completed``. A repeat signal
        before the rebuild completes re-invalidates harmlessly and the
        idempotency key collapses the duplicate job; if the rebuild fails,
        the stored fingerprint stays old so the next signal retries.
        """
        from .models import AggregationDataSourceStateORM

        # 1. Resolve workspace_id + state row. Fall back to the public
        # data-source row for workspace_id when no state row exists (same
        # pattern as the event listener / claim_purge_job).
        state = await session.get(AggregationDataSourceStateORM, ds_id)
        stored_fp = state.graph_fingerprint if state else None
        workspace_id = state.workspace_id if state else None
        if not workspace_id:
            from backend.app.db.models import WorkspaceDataSourceORM
            ds_orm = await session.get(WorkspaceDataSourceORM, ds_id)
            if ds_orm is not None and ds_orm.deleted_at is None:
                workspace_id = ds_orm.workspace_id

        # 2. Resolve the provider and fingerprint the live graph (same
        # bounded pattern as check_drift / the scheduler). A resolution
        # failure leaves provider=None (content-cache clear is skipped); a
        # fingerprint timeout leaves current_fp="" (a mismatch).
        _DRIFT_TIMEOUT = float(
            __import__("os").getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5")
        )
        provider = None
        current_fp = ""
        try:
            provider = await asyncio.wait_for(
                self._registry.get_provider_for_workspace(
                    workspace_id, session, data_source_id=ds_id,
                ),
                timeout=_DRIFT_TIMEOUT,
            )
        except Exception as exc:
            logger.warning(
                "signal_source_changed: provider resolution failed for %s: %s",
                ds_id, exc,
            )
        if provider is not None:
            try:
                current_fp = await asyncio.wait_for(
                    compute_graph_fingerprint(provider),
                    timeout=_DRIFT_TIMEOUT,
                )
            except Exception:
                # Timeout, or a contract-violating raise from
                # compute_graph_fingerprint — treat as unknown (a mismatch,
                # fails open toward "changed") rather than 500 the signal.
                current_fp = ""

        # 3. Change gate. A matching fingerprint (and no force) is a no-op —
        # nothing below runs.
        if not force and fingerprints_match(stored_fp, current_fp):
            event_id = await self._emit_signal_event(
                workspace_id=workspace_id, ds_id=ds_id, origin=origin,
                actor=actor, gate="unchanged", actions={}, outcome="noop",
            )
            return SourceChangedResponse(
                changed=False,
                job_id=None,
                reason=reason,
                current_fingerprint=current_fp,
                stored_fingerprint=stored_fp,
                event_id=event_id,
            )

        # Applicability, decided BEFORE marking (C2). Aggregation applies
        # only to a source whose state row carries a materializing status;
        # a never-aggregated / skipped source (incl. no state row → "none")
        # still gets hierarchy convergence but must NOT be marked stale —
        # nothing would ever clear the marker (no rebuild job), so the gate
        # keeps evaluating changed=True and the reconciler re-signals every
        # tick forever. Any marker a prior (then-applicable) signal left is
        # cleared here instead.
        status = (state.aggregation_status if state else None) or "none"
        applicable = status not in self._AGG_NOT_APPLICABLE

        # 4-7. Best-effort convergence (sequential awaits; the helpers never
        # raise). workspace-scoped helpers only fire once a workspace is
        # known; content-cache clear needs a resolved provider.
        from backend.app.services.graph_cache import (
            clear_source_stale,
            invalidate_hierarchy_reads,
            mark_source_stale,
        )

        # Audit spec §1b: booleans/counts of what actually ran here, for
        # the actions dict on the eventual emit below.
        marker_set = False
        content_cleared = False
        gen_bumped = False
        lkg_purged = 0
        stats_nudged = False

        if workspace_id:
            if applicable:
                # The literal the read-path overlay + FE banner contract on
                # (backend/common/models/graph.py, ContextViewCanvas.tsx) —
                # NOT the signal reason, which stays for the response + logs.
                await mark_source_stale(workspace_id, ds_id, "source_changed")
                marker_set = True
            else:
                await clear_source_stale(workspace_id, ds_id)
        if provider is not None:
            await provider.clear_content_caches()
            content_cleared = True
        if workspace_id:
            purge_count = await invalidate_hierarchy_reads(workspace_id, ds_id)
            gen_bumped = purge_count is not None
            lkg_purged = purge_count or 0
        if workspace_id:
            stats_nudged = True
            try:
                from backend.insights_service.enqueue import mark_stats_changed
                await mark_stats_changed(ds_id, workspace_id)
            except Exception as exc:
                logger.warning(
                    "signal_source_changed: stats nudge failed for %s: %s",
                    ds_id, exc,
                )

        # 8. Queue the rebuild unless aggregation doesn't apply to this
        # source, or the rebuild cooldown is still in effect. Steps 4-7
        # already ran — only the REBUILD is throttled. A deferred rebuild
        # stays honestly stale (marker + read-path overlay) until the Task 4
        # scheduler reconciler fires it once the window elapses; ``force``
        # bypasses the cooldown. Trigger failures after invalidation must
        # NOT fail the signal — a benign ConflictError (job already active)
        # or an ontology-resolution failure both leave changed=True/job=None.
        job_id = None
        deferred = False
        trigger_outcome = None
        trigger_detail = None
        if applicable:
            cadence = await read_global_cadence(session)
            interval_secs = resolve_rebuild_interval(
                getattr(state, "rebuild_min_interval_secs", None),
                cadence.rebuild_min_interval_secs,
            )
            if not force and self._within_rebuild_cooldown(state, interval_secs):
                deferred = True
                logger.info(
                    "signal_source_changed: rebuild deferred (cooldown) for "
                    "%s — reconciler will pick it up", ds_id,
                )
            else:
                from uuid import uuid4
                try:
                    job = await self.trigger(
                        ds_id,
                        AggregationTriggerRequest(
                            idempotency_key=f"source-changed:{current_fp or uuid4().hex}",
                        ),
                        "api",
                        session,
                    )
                    job_id = job.id
                    trigger_outcome = "accepted"
                except ConflictError:
                    logger.info(
                        "signal_source_changed: rebuild for %s already active — "
                        "idempotency key collapses the duplicate", ds_id,
                    )
                    trigger_outcome = "conflict"
                except (OntologyResolutionError, ValueError, NotFoundError) as exc:
                    logger.warning(
                        "signal_source_changed: rebuild trigger for %s could not "
                        "resolve (%s) — caches invalidated, no job queued",
                        ds_id, exc,
                    )
                    trigger_outcome = "error"
                    trigger_detail = type(exc).__name__
                except Exception as exc:
                    # Any other trigger failure (DB/provider blip) must not fail
                    # the signal — the invalidation above already happened.
                    logger.warning(
                        "signal_source_changed: rebuild trigger for %s failed "
                        "unexpectedly (%s) — caches invalidated, no job queued",
                        ds_id, exc,
                    )
                    trigger_outcome = "error"
                    trigger_detail = type(exc).__name__
        else:
            # Distinguishes this noop from the unchanged-gate noop above —
            # the cockpit needs to tell "nothing changed" apart from
            # "changed, but aggregation doesn't apply to this source".
            trigger_detail = "not_applicable"

        # Audit outcome: not-applicable and the unchanged-gate no-op above
        # both leave nothing queued ("noop"); otherwise deferred/accepted/
        # conflict/error come straight from the trigger attempt above.
        outcome = "deferred" if deferred else (trigger_outcome or "noop")
        # Spec §1b: the changed path always records what ran, even when
        # every field is False/0/None (e.g. no workspace_id at all).
        actions: dict = {
            "marker_set": marker_set,
            "gen_bumped": gen_bumped,
            "lkg_purged": lkg_purged,
            "content_cleared": content_cleared,
            "stats_nudged": stats_nudged,
            "job_id": job_id,
            "deferred": deferred,
        }
        if force:
            actions["force"] = True
        event_id = await self._emit_signal_event(
            workspace_id=workspace_id, ds_id=ds_id, origin=origin,
            actor=actor, gate=("forced" if force else "changed"),
            actions=actions, outcome=outcome, detail=trigger_detail,
        )

        return SourceChangedResponse(
            changed=True,
            job_id=job_id,
            reason=reason,
            current_fingerprint=current_fp,
            stored_fingerprint=stored_fp,
            deferred=deferred,
            event_id=event_id,
        )

    async def _emit_signal_event(
        self, *, workspace_id, ds_id, origin, actor, gate, actions, outcome,
        detail=None,
    ) -> Optional[str]:
        """Best-effort audit emit for one ``signal_source_changed`` outcome.

        ``emit_refresh_event`` already never raises on its own, but this
        wraps the call anyway — audit writes must never break the signal
        they record, including if that contract is ever violated."""
        from backend.app.db.repositories.refresh_events_repo import (
            emit_refresh_event,
        )
        try:
            return await emit_refresh_event(
                self._session_factory,
                workspace_id=workspace_id,
                data_source_id=ds_id,
                origin=origin,
                actor=actor,
                scope="auto",
                gate=gate,
                actions=actions,
                outcome=outcome,
                detail=detail,
            )
        except Exception as exc:
            logger.warning(
                "signal_source_changed: audit emit failed for %s: %s",
                ds_id, exc,
            )
            return None

    def _within_rebuild_cooldown(self, state, interval_secs: int) -> bool:
        """True when a rebuild for ``state`` falls inside the throttle
        window and should be deferred to the reconciler.

        ``interval_secs`` is the RESOLVED window (per-source override →
        persisted global → env default; see ``resolve_rebuild_interval``) —
        this stays a pure function of ``(state, interval_secs)`` so the
        signal gate and the scheduler reconciler pre-check share it exactly.
        Reference time is the state row's ``last_aggregated_at`` — the only
        "when did we last rebuild" timestamp on the aggregation state row.
        Returns False (⇒ trigger now) when the throttle is disabled, no
        reference time exists (never aggregated), the timestamp is
        unparseable, or the window has already elapsed."""
        if interval_secs <= 0:
            return False
        ref = state.last_aggregated_at if state is not None else None
        if not ref:
            return False
        try:
            ref_dt = datetime.fromisoformat(ref)
        except (TypeError, ValueError):
            return False
        if ref_dt.tzinfo is None:
            ref_dt = ref_dt.replace(tzinfo=timezone.utc)
        elapsed = (datetime.now(timezone.utc) - ref_dt).total_seconds()
        return elapsed < interval_secs

    # ── Unified refresh verb (operator-facing) ──────────────────────

    _JOB_TERMINAL = ("completed", "failed", "cancelled")

    async def refresh_source(
        self, ds_id: str, session: AsyncSession, *,
        scope: str = "auto", force: bool = False, reason: Optional[str] = None,
        actor: str = "internal", origin: str = "api", wait: str = "none",
    ) -> RefreshResponse:
        """One operator-facing refresh verb over the convergence primitives.

        Five scopes, one dispatch, NO new mechanisms:

          * ``auto``        — delegate verbatim to :meth:`signal_source_changed`
            (the change-gated signal). It owns both the gate AND its own audit
            event; this verb reuses that event id and NEVER emits a second one.
          * ``read-caches`` — no gate, no marker, no rebuild: clear content
            caches, invalidate hierarchy reads, purge the aggregated LKG too
            (an explicit operator refresh drops the degraded-read fallback the
            signal deliberately keeps), and nudge stats.
          * ``rollups``     — mark the source stale and queue a rebuild with a
            FRESH idempotency key every call, bypassing the cooldown / dedup
            gate by construction (an explicit refresh must always do work).
          * ``full``        — the read-caches steps, then the rollups steps.
          * ``clear``       — the read-caches steps, THEN clear the stale
            marker (:func:`clear_source_stale`). No gate, no cooldown, no
            rebuild — the operator's un-stick for a source whose rebuild
            keeps failing (e.g. provider OOM) and is stuck "recomputing".

        Exactly ONE audit event per call. An unknown ``ds_id`` (neither an
        aggregation state row nor a workspace data-source row) raises
        ``NotFoundError`` BEFORE any side effect. Best-effort throughout: once
        invalidation has begun nothing raises back to the caller — a rebuild
        conflict or resolution failure is recorded, not propagated.
        """
        from .models import AggregationDataSourceStateORM
        from backend.app.db.models import WorkspaceDataSourceORM

        # 0. Existence gate + workspace resolution (mirrors the signal's
        # state-row load + public-row fallback). A ds that matches neither
        # row 404s here, BEFORE any cache/marker/trigger side effect.
        state = await session.get(AggregationDataSourceStateORM, ds_id)
        workspace_id = state.workspace_id if state else None
        ds_orm = None
        if not workspace_id:
            ds_orm = await session.get(WorkspaceDataSourceORM, ds_id)
            if ds_orm is not None and ds_orm.deleted_at is None:
                workspace_id = ds_orm.workspace_id
        if state is None and ds_orm is None:
            raise NotFoundError(f"Data source {ds_id} not found")

        # 1. auto — delegate to the signal, which owns the change gate and
        # emits its own event; reuse that event id, never emit a second.
        if scope == "auto":
            signal = await self.signal_source_changed(
                ds_id, session, force=force, origin=origin, actor=actor,
                **({"reason": reason} if reason else {}),
            )
            gate = "forced" if force else (
                "changed" if signal.changed else "unchanged"
            )
            actions: List[str] = []
            if signal.job_id:
                actions.append("rebuild_queued")
            elif signal.deferred:
                actions.append("rebuild_deferred")
            elif signal.changed:
                actions.append("invalidated")
            if wait == "complete" and signal.job_id:
                actions.append(
                    await self._wait_for_job(ds_id, signal.job_id, session)
                )
            return RefreshResponse(
                scope="auto", gate=gate, changed=signal.changed,
                actions=actions, job_id=signal.job_id,
                deferred=signal.deferred, event_id=signal.event_id,
            )

        # Non-auto scopes own their single audit event. ``audit`` mirrors the
        # signal's §1b actions-dict keys for what actually ran here.
        actions = []
        audit: dict = {
            "marker_set": False, "gen_bumped": False, "lkg_purged": 0,
            "content_cleared": False, "stats_nudged": False,
            "marker_cleared": False, "job_id": None, "deferred": False,
        }

        # 2. read-caches steps (also the first half of ``full``, and
        # ``clear``'s first step — reused verbatim, not duplicated). No gate.
        if scope in ("read-caches", "full", "clear"):
            from backend.app.services.graph_cache import (
                CacheScope,
                ENDPOINT_AGGREGATED,
                get_graph_cache,
                invalidate_hierarchy_reads,
            )
            provider = None
            _timeout = float(
                __import__("os").getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5")
            )
            try:
                provider = await asyncio.wait_for(
                    self._registry.get_provider_for_workspace(
                        workspace_id, session, data_source_id=ds_id,
                    ),
                    timeout=_timeout,
                )
            except Exception as exc:
                logger.warning(
                    "refresh_source: provider resolution failed for %s: %s",
                    ds_id, exc,
                )
            if provider is not None:
                await provider.clear_content_caches()
                audit["content_cleared"] = True
                actions.append("content_cleared")
            if workspace_id:
                purge_count = await invalidate_hierarchy_reads(workspace_id, ds_id)
                audit["gen_bumped"] = purge_count is not None
                audit["lkg_purged"] = purge_count or 0
                actions.append("hierarchy_invalidated")
                # The aggregated LKG goes too — the signal keeps it as the
                # degraded-read fallback until its own rebuild lands, but an
                # explicit operator refresh drops it (operator override).
                agg_purged = await get_graph_cache().purge_lkg(
                    CacheScope(
                        workspace_id=str(workspace_id),
                        data_source_id=str(ds_id), branch_id="",
                    ),
                    ENDPOINT_AGGREGATED,
                )
                audit["aggregated_lkg_purged"] = agg_purged
                actions.append("aggregated_lkg_purged")
                audit["stats_nudged"] = True
                actions.append("stats_nudged")
                try:
                    from backend.insights_service.enqueue import mark_stats_changed
                    await mark_stats_changed(ds_id, workspace_id)
                except Exception as exc:
                    logger.warning(
                        "refresh_source: stats nudge failed for %s: %s",
                        ds_id, exc,
                    )

        # 2b. clear-only: un-stick the stale marker. No gate, no cooldown,
        # no rebuild — safe even when the store is out of memory.
        if scope == "clear" and workspace_id:
            from backend.app.services.graph_cache import clear_source_stale
            await clear_source_stale(workspace_id, ds_id)
            audit["marker_cleared"] = True
            actions.append("marker_cleared")

        # 3. rollups steps (also the second half of ``full``). Marker + a
        # rebuild with a fresh idempotency key — cooldown / dedup gate bypass
        # by construction. A trigger failure after the marker was set must
        # NOT propagate (the marker already happened); it is recorded instead.
        job_id = None
        outcome = "accepted"
        detail = None
        if scope in ("rollups", "full"):
            if workspace_id:
                from backend.app.services.graph_cache import mark_source_stale
                await mark_source_stale(workspace_id, ds_id, "source_changed")
                audit["marker_set"] = True
                actions.append("marker_set")
            from uuid import uuid4
            try:
                job = await self.trigger(
                    ds_id,
                    AggregationTriggerRequest(
                        idempotency_key=f"refresh-rollups:{uuid4().hex}",
                    ),
                    "api",
                    session,
                )
                job_id = job.id
                actions.append("rebuild_queued")
            except ConflictError:
                logger.info(
                    "refresh_source: rollups rebuild for %s already active — "
                    "idempotency collapses the duplicate", ds_id,
                )
                outcome = "conflict"
                actions.append("rebuild_conflict")
            except (OntologyResolutionError, ValueError, NotFoundError) as exc:
                logger.warning(
                    "refresh_source: rollups rebuild for %s could not resolve "
                    "(%s) — caches invalidated, no job queued", ds_id, exc,
                )
                outcome = "error"
                detail = type(exc).__name__
                actions.append("rebuild_error")
            except Exception as exc:
                logger.warning(
                    "refresh_source: rollups rebuild for %s failed unexpectedly "
                    "(%s) — no job queued", ds_id, exc,
                )
                outcome = "error"
                detail = type(exc).__name__
                actions.append("rebuild_error")
            audit["job_id"] = job_id

        # One audit event per call (the wait status below is response-only,
        # never recorded — the audit records the operation, not the poll).
        event_id = await self._emit_scope_event(
            workspace_id=workspace_id, ds_id=ds_id, origin=origin, actor=actor,
            scope=scope, gate="n/a", actions=audit, outcome=outcome,
            detail=detail,
        )

        # 4. Optional synchronous wait for a queued rebuild.
        if wait == "complete" and job_id:
            actions.append(await self._wait_for_job(ds_id, job_id, session))

        return RefreshResponse(
            scope=scope, gate="n/a", changed=True, actions=actions,
            job_id=job_id, deferred=False, event_id=event_id,
        )

    async def _wait_for_job(
        self, ds_id: str, job_id: str, session: AsyncSession,
    ) -> str:
        """Poll a queued rebuild to a terminal status, bounded by
        ``_REFRESH_WAIT_TIMEOUT_S``. Returns ``job:<status>`` on a terminal
        job or ``job:timeout`` if the window elapses first. Best-effort: a
        transient job-lookup failure is retried, never raised."""
        interval = _REFRESH_WAIT_INTERVAL_S
        polls = max(1, _REFRESH_WAIT_TIMEOUT_S // interval)
        for _ in range(polls):
            try:
                job = await self.get_job(ds_id, job_id, session)
            except Exception:
                job = None
            if job is not None and job.status in self._JOB_TERMINAL:
                return f"job:{job.status}"
            await asyncio.sleep(interval)
        return "job:timeout"

    async def _emit_scope_event(
        self, *, workspace_id, ds_id, origin, actor, scope, gate, actions,
        outcome, detail=None,
    ) -> Optional[str]:
        """Best-effort audit emit for one ``refresh_source`` outcome — the
        non-auto twin of :meth:`_emit_signal_event`, carrying the caller's
        scope/gate (the signal's is always ``auto``). Audit writes must never
        break the refresh they record."""
        from backend.app.db.repositories.refresh_events_repo import (
            emit_refresh_event,
        )
        try:
            return await emit_refresh_event(
                self._session_factory,
                workspace_id=workspace_id,
                data_source_id=ds_id,
                origin=origin,
                actor=actor,
                scope=scope,
                gate=gate,
                actions=actions,
                outcome=outcome,
                detail=detail,
            )
        except Exception as exc:
            logger.warning(
                "refresh_source: audit emit failed for %s: %s", ds_id, exc,
            )
            return None

    # ── Freshness cockpit: per-source detail ────────────────────────

    async def assemble_source_freshness(
        self, ds_id: str, session: AsyncSession, *, probe: bool = False,
    ) -> Optional[FreshnessDoc]:
        """Full freshness detail for one source. Reads the same SQL row +
        cache signals as a fleet row, plus a bounded LKG SCAN and the last
        five refresh events. Only when ``probe`` is True does it make ONE
        ``get_schema_stats`` call (bounded by ``SCHEDULER_DRIFT_CHECK_TIMEOUT``)
        to derive the live fingerprint / node+edge counts and the drift
        verdict. Returns ``None`` when the data source does not exist (the
        route maps that to 404). Never raises for a cache/provider hiccup —
        those degrade the affected fields to ``None``."""
        from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM
        from backend.app.services import graph_cache as _gc
        from backend.app.db.repositories.refresh_events_repo import (
            list_refresh_events,
        )

        row = (await session.execute(
            select(WorkspaceDataSourceORM, ProviderORM.name)
            .join(
                ProviderORM,
                ProviderORM.id == WorkspaceDataSourceORM.provider_id,
                isouter=True,
            )
            .where(WorkspaceDataSourceORM.id == ds_id)
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )).first()
        if row is None:
            return None
        ds, provider_name = row[0], row[1]

        signals = (await _gc.read_freshness_signals(
            [(ds.workspace_id, ds.id)]
        )).get((str(ds.workspace_id), str(ds.id)), (None, None, None))
        running = await _running_job_map(session, [ds.id])
        # Resolved rebuild window for this source (per-source override →
        # persisted global → env), so the badge matches the cooldown gate.
        cadence = await read_global_cadence(session)
        overrides = await _rebuild_override_map(session, [ds.id])
        override_secs = overrides.get(ds.id)
        cooldown_interval_secs = resolve_rebuild_interval(
            override_secs, cadence.rebuild_min_interval_secs,
        )
        rebuild_interval_source = (
            "custom" if override_secs is not None
            else "global" if cadence.rebuild_min_interval_secs is not None
            else "default"
        )
        events = await list_refresh_events(session, ds.id, limit=5)
        last_event = events[0] if events else None
        lkg_count, lkg_oldest_age = await _gc.read_lkg_stats(
            ds.workspace_id, ds.id,
        )
        cache_key_count_by_endpoint = await _gc.count_cache_keys_by_endpoint(
            ds.workspace_id, ds.id,
        )
        cache_key_count = (
            sum(cache_key_count_by_endpoint.values())
            if cache_key_count_by_endpoint is not None else None
        )

        # Failure surfacing (spec §9c): ONE bounded query for the latest job
        # of this source. Populated only when it's ``failed``; doc-only,
        # best-effort — a query error degrades to None fields, never raises.
        last_failure_reason = last_failure_category = retry_count = None
        try:
            job_row = (await session.execute(
                select(
                    AggregationJobORM.status,
                    AggregationJobORM.error_message,
                    AggregationJobORM.retry_count,
                )
                .where(AggregationJobORM.data_source_id == ds.id)
                # NULLS LAST: a pending job (updated_at=NULL) must not outrank
                # the latest terminal row on Postgres DESC (SQLite already does).
                .order_by(AggregationJobORM.updated_at.desc().nullslast())
                .limit(1)
            )).first()
        except Exception as exc:
            logger.warning(
                "assemble_source_freshness: latest-job query failed for %s: %s",
                ds.id, exc,
            )
            job_row = None
        if job_row is not None:
            job_status, job_error, job_retry = job_row
            if job_status == "failed":
                last_failure_reason = job_error
                last_failure_category = classify_failure(job_error)
                retry_count = job_retry

        live_fingerprint = live_node_count = live_edge_count = None
        drifted = None
        if probe:
            live_fingerprint, live_node_count, live_edge_count = (
                await self._probe_live_stats(ds.workspace_id, ds.id, session)
            )
            # Drift is only meaningful against a stored baseline; without
            # one (never aggregated) the verdict stays unknown (None).
            if live_fingerprint and ds.graph_fingerprint:
                drifted = not fingerprints_match(
                    ds.graph_fingerprint, live_fingerprint,
                )

        return FreshnessDoc(
            **_freshness_row_kwargs(
                ds, provider_name=provider_name, signals=signals,
                running_job_id=running.get(ds.id), last_event=last_event,
                drifted=drifted,
                cooldown_interval_secs=cooldown_interval_secs,
            ),
            lkg_count=lkg_count,
            lkg_oldest_age_secs=lkg_oldest_age,
            cache_key_count=cache_key_count,
            cache_key_count_by_endpoint=cache_key_count_by_endpoint,
            last_failure_reason=last_failure_reason,
            last_failure_category=last_failure_category,
            retry_count=retry_count,
            live_fingerprint=live_fingerprint,
            live_node_count=live_node_count,
            live_edge_count=live_edge_count,
            events=[_event_summary(e) for e in events],
            rebuild_override_secs=override_secs,
            resolved_rebuild_interval_secs=cooldown_interval_secs,
            rebuild_interval_source=rebuild_interval_source,
        )

    async def _probe_live_stats(
        self, workspace_id, ds_id, session: AsyncSession,
    ) -> tuple[Optional[str], Optional[int], Optional[int]]:
        """ONE ``get_schema_stats`` probe → ``(live_fingerprint,
        node_count, edge_count)``. Bounded by ``SCHEDULER_DRIFT_CHECK_TIMEOUT``;
        any failure or timeout degrades to ``(None, None, None)`` — the
        freshness read must never fail because a provider is slow or down."""
        from .fingerprint import fingerprint_from_stats

        timeout = float(
            __import__("os").getenv("SCHEDULER_DRIFT_CHECK_TIMEOUT", "5")
        )
        try:
            provider = await asyncio.wait_for(
                self._registry.get_provider_for_workspace(
                    workspace_id, session, data_source_id=ds_id,
                ),
                timeout=timeout,
            )
            stats = await asyncio.wait_for(
                provider.get_schema_stats(), timeout=timeout,
            )
        except Exception as exc:
            logger.warning(
                "assemble_source_freshness: probe failed for %s: %s",
                ds_id, exc,
            )
            return (None, None, None)
        return (
            fingerprint_from_stats(stats),
            getattr(stats, "total_nodes", None),
            getattr(stats, "total_edges", None),
        )

    # ── Startup Recovery (CRIT-4: lives here, NOT on Worker) ─────────

    async def recover_interrupted_jobs(self) -> int:
        """Called once on application startup.

        Scans for jobs stuck in 'pending' or 'running' (interrupted by crash).
        Re-dispatches via the configured dispatcher.
        The worker resumes from the stored last_cursor checkpoint.

        Recovery distinguishes two cases:
        - A *running* job with a checkpoint (last_cursor) was actively making
          progress when the process died.  This is a clean crash recovery —
          re-dispatch from the checkpoint **without** incrementing retry_count.
        - A job with no checkpoint (never ran, or stuck in pending) counts as
          a genuine retry and increments retry_count.
        """
        async with self._session_factory() as session:
            stale_jobs = await session.execute(
                select(AggregationJobORM).where(
                    AggregationJobORM.status.in_(["pending", "running"])
                )
            )
            count = 0
            for job in stale_jobs.scalars():
                # Purge jobs are recovered by the insights-service worker
                # via XAUTOCLAIM on the ``insights.jobs.purge`` stream —
                # the message stays in PEL across restarts and gets
                # redelivered on the next worker boot. No action needed
                # here. We don't even mark them failed: the worker will
                # do that on real failure (e.g. provider permanently
                # gone) via the standard delivery-attempt path.
                if job.trigger_source == "purge":
                    continue

                was_making_progress = (
                    job.status == "running"
                    and job.last_cursor is not None
                )

                if was_making_progress:
                    # Clean crash recovery — resume from checkpoint, no penalty
                    job.status = "pending"
                    job.error_message = None
                    job.updated_at = _now()
                    await session.commit()
                    # Before dispatching, add delay based on retry count to prevent rapid-fire
                    # re-dispatch when the provider is still down
                    if job.retry_count and job.retry_count > 0:
                        delay = min(5.0 * (2 ** (job.retry_count - 1)), 120.0)
                        logger.info("Delaying recovery dispatch for job %s by %.0fs (retry_count=%d)", job.id, delay, job.retry_count)
                        await asyncio.sleep(delay)
                    await self._dispatcher.dispatch(job.id)
                    count += 1
                    logger.info(
                        "Crash-recovered aggregation job %s from checkpoint "
                        "(cursor: %s, retry_count unchanged at %d)",
                        job.id, job.last_cursor, job.retry_count,
                    )
                elif job.retry_count < job.max_retries:
                    # No progress checkpoint — count as a genuine retry
                    job.retry_count += 1
                    job.status = "pending"
                    job.updated_at = _now()
                    await session.commit()
                    # Before dispatching, add delay based on retry count to prevent rapid-fire
                    # re-dispatch when the provider is still down
                    if job.retry_count and job.retry_count > 0:
                        delay = min(5.0 * (2 ** (job.retry_count - 1)), 120.0)
                        logger.info("Delaying recovery dispatch for job %s by %.0fs (retry_count=%d)", job.id, delay, job.retry_count)
                        await asyncio.sleep(delay)
                    await self._dispatcher.dispatch(job.id)
                    count += 1
                    logger.info(
                        "Retried aggregation job %s (retry %d/%d)",
                        job.id, job.retry_count, job.max_retries,
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
        """Resolve ontology edge types for a data source and run the
        ontology-resolution gate.

        Delegates to ``ontology_runtime.build_resolution_report`` for
        the load + gate evaluation; translates its typed exceptions
        into the service's domain errors so the endpoint adapter can
        keep its existing exception → HTTP mapping. Raises:

            - NotFoundError  — DS row or ontology row missing
            - ValueError     — DS exists but ontology_id is null
            - OntologyResolutionError — gate failed (no_lineage; partial
              coverage and unclassified relationships are advisory-only
              and no longer block)

        Returns dict with:
            ontology_id, ontology_fingerprint, workspace_id, provider_id,
            graph_name, data_source_label, containment_edge_types,
            lineage_edge_types
        """
        try:
            report = await ontology_runtime.build_resolution_report(session, ds_id)
        except ontology_runtime.DataSourceMissing:
            raise NotFoundError(f"Data source {ds_id} not found")
        except ontology_runtime.OntologyNotAssigned:
            raise ValueError(
                "Aggregation requires an assigned ontology. "
                "Please configure an ontology for this data source first."
            )
        except ontology_runtime.OntologyMissing as exc:
            raise NotFoundError(f"Ontology {str(exc)} not found")

        if not report.resolved:
            raise OntologyResolutionError(report)

        # Gate passed — derive the flat edge-type lists from the same
        # ontology row the runtime helper just used. We re-load the row
        # here only to avoid threading it back through the helper API;
        # one extra ORM lookup is cheap relative to the gate eval.
        from backend.app.db.models import OntologyORM, WorkspaceDataSourceORM
        from backend.app.ontology.resolver import (
            parse_entity_definitions,
            parse_relationship_definitions,
            derive_flat_lists,
        )

        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if ds is None or ds.deleted_at is not None:
            raise NotFoundError(f"Data source {ds_id} not found")
        ontology_orm = await session.get(OntologyORM, ds.ontology_id)
        entity_defs = parse_entity_definitions(
            json.loads(ontology_orm.entity_type_definitions or "{}")
        )
        rel_defs = parse_relationship_definitions(
            json.loads(ontology_orm.relationship_type_definitions or "{}")
        )
        flat = derive_flat_lists(entity_defs, rel_defs)

        # Entity-type → hierarchy level map. Frozen onto the job so the
        # worker can inject it into the provider (set_entity_type_levels)
        # and drive per-label indexing (ensure_indices) without importing
        # the ontology module. ``derive_level_map`` reads ``.entity_type_
        # definitions``; we pass a thin shim exposing the parsed defs.
        from types import SimpleNamespace
        from backend.app.services.ontology_levels import derive_level_map
        entity_type_levels = derive_level_map(
            SimpleNamespace(entity_type_definitions=entity_defs)
        )

        return {
            "ontology_id": ds.ontology_id,
            "ontology_fingerprint": report.fingerprint,
            "workspace_id": ds.workspace_id,
            "provider_id": ds.provider_id,
            "graph_name": ds.graph_name,
            "data_source_label": getattr(ds, "label", None),
            "containment_edge_types": flat.containment_edge_types,
            "lineage_edge_types": flat.lineage_edge_types,
            "entity_type_levels": entity_type_levels,
        }

    async def _replay_fingerprint_matches(
        self,
        existing_job: AggregationJobORM,
        ds_id: str,
        session: AsyncSession,
    ) -> bool:
        """Return True if it's safe to replay ``existing_job`` for the
        current trigger.

        The replay is only safe when the ontology hasn't materially
        changed since ``existing_job`` was created. We compare the
        prior job's frozen ``ontology_fingerprint`` to a freshly
        computed fingerprint over the current OntologyORM row. Any
        mismatch (including either side being NULL) returns False so
        the caller falls through to a fresh resolve.

        Tolerates missing data sources / ontologies (returns False) so
        a stale prior job never wins by accident; the surrounding
        gate-fail path will produce a clearer 422 below.
        """
        if not existing_job.ontology_fingerprint:
            return False
        try:
            from backend.app.db.models import WorkspaceDataSourceORM, OntologyORM
        except ImportError:
            return False
        ds = await session.get(WorkspaceDataSourceORM, ds_id)
        if ds is None or ds.deleted_at is not None or not ds.ontology_id:
            return False
        # If the assigned ontology changed entirely, the prior fingerprint
        # belongs to a different ontology — never safe to replay.
        if ds.ontology_id != existing_job.ontology_id:
            return False
        ontology_orm = await session.get(OntologyORM, ds.ontology_id)
        if ontology_orm is None:
            return False
        current_fp = ontology_gate.compute_fingerprint_from_ontology_orm(ontology_orm)
        return current_fp == existing_job.ontology_fingerprint

    # ── State Management Helpers ────────────────────────────────────────

    async def _upsert_ds_state(
        self, session: AsyncSession, ds_id: str, **fields,
    ) -> None:
        """Create or update the aggregation-owned data source state row.

        Uses AggregationDataSourceStateORM in the aggregation schema.
        Creates the row if it doesn't exist (e.g., first trigger for a DS).
        """
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if state is None:
            state = AggregationDataSourceStateORM(
                data_source_id=ds_id,
                workspace_id=fields.pop("workspace_id", ""),
            )
            session.add(state)
        for key, value in fields.items():
            if hasattr(state, key):
                setattr(state, key, value)

    # ── Response Helpers ─────────────────────────────────────────────


    @staticmethod
    def _job_tuning_dict(job) -> dict | None:
        try:
            raw = getattr(job, "tuning_json", None)
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _job_run_stats_dict(job) -> dict | None:
        try:
            raw = getattr(job, "run_stats", None)
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_response(job: AggregationJobORM) -> AggregationJobResponse:
        """Convert ORM to response model."""
        # Estimate completion time
        estimated = _estimate_completion(job)

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
            resumable=_is_resumable(job),
            retry_count=job.retry_count,
            error_message=job.error_message,
            estimated_completion_at=estimated,
            started_at=job.started_at,
            completed_at=job.completed_at,
            updated_at=job.updated_at,
            created_at=job.created_at,
            edge_coverage_pct=(
                round(job.processed_edges / job.total_edges * 100, 1)
                if job.total_edges and job.total_edges > 0 else None
            ),
            last_cursor=job.last_cursor,
            max_retries=job.max_retries,
            timeout_secs=job.timeout_secs,
            projection_mode=job.projection_mode,
            tuning=AggregationService._job_tuning_dict(job),
            run_stats=AggregationService._job_run_stats_dict(job),
            worker_id=getattr(job, "worker_id", None),
        )


# ── Freshness cockpit: fleet assembly + shared row builder ──────────
#
# These are module-level (not AggregationService methods) on purpose: the
# fleet view is a pure read of the web tier's own synced state
# (public.workspace_data_sources) + the cache Redis, so it must work in
# proxy mode too, where the web tier holds no AggregationService instance.
# The per-source doc, which needs the provider registry for its probe,
# lives on the service (see ``assemble_source_freshness``).


def _event_summary(row) -> Optional[RefreshEventSummary]:
    """RefreshEventORM → the trimmed summary the freshness views render."""
    if row is None:
        return None
    return RefreshEventSummary(origin=row.origin, outcome=row.outcome, ts=row.ts)


def classify_failure(error_message: Optional[str]) -> Optional[str]:
    """Classify a job's ``error_message`` into a coarse, UI-facing category
    for resolution guidance (spec §9c). ``None`` when there is no error.

    Order matters: ``out_of_memory`` is checked BEFORE
    ``provider_unavailable`` because a FalkorDB OOM error is often wrapped
    in connection/availability language (e.g. "provider unavailable: OOM
    command not allowed..."), which would otherwise misclassify the more
    actionable OOM case as a generic provider outage."""
    if not error_message:
        return None
    if (
        "OutOfMemoryError" in error_message
        or "used memory > 'maxmemory'" in error_message
        or "OOM" in error_message
    ):
        return "out_of_memory"
    if "timeout" in error_message or "TimeoutError" in error_message:
        return "timeout"
    if "ontology" in error_message or "OntologyResolution" in error_message:
        return "ontology"
    if "conflict" in error_message or "ConflictError" in error_message:
        return "conflict"
    if (
        "unavailable" in error_message
        or "unreachable" in error_message
        or "connection" in error_message
    ):
        return "provider_unavailable"
    return "unknown"


def _rebuild_cooldown_until(
    last_aggregated_at: Optional[str], interval_secs: int,
) -> Optional[str]:
    """``cooldown_until = last_aggregated_at + interval_secs``, but only while
    that instant is still in the future — once the window has elapsed there is
    no cooldown to report, so return ``None``. ``interval_secs`` is the
    RESOLVED window (``resolve_rebuild_interval``), so this badge derivation
    matches the actual cooldown-gate behavior for the source."""
    if not last_aggregated_at or interval_secs <= 0:
        return None
    try:
        ref = datetime.fromisoformat(last_aggregated_at)
    except (TypeError, ValueError):
        return None
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)
    until = ref + timedelta(seconds=interval_secs)
    if until <= datetime.now(timezone.utc):
        return None
    return until.isoformat()


def _freshness_row_kwargs(
    ds, *, provider_name, signals, running_job_id, last_event, drifted=None,
    cooldown_interval_secs: int = AGGREGATION_REBUILD_MIN_INTERVAL_SECS,
) -> dict:
    """Map one workspace_data_sources row + its cache signals into the
    snake_case kwargs shared by ``FreshnessRow`` and ``FreshnessDoc``.
    ``signals`` is ``(generation, cache_as_of, stale_reason)`` from
    :func:`graph_cache.read_freshness_signals`. ``cooldown_interval_secs`` is
    the resolved per-source rebuild window (default = env), so the
    ``cooldownUntil`` the badge reads reflects any global/per-source override."""
    generation, cache_as_of, stale_reason = signals
    return dict(
        data_source_id=ds.id,
        workspace_id=ds.workspace_id,
        provider_id=ds.provider_id,
        name=ds.label,
        provider_name=provider_name,
        aggregation_status=ds.aggregation_status,
        last_aggregated_at=ds.last_aggregated_at,
        # Sourced from the provider's cache namespace (requires provider
        # resolution) — deliberately left None on the no-provider-work
        # freshness paths.
        last_materialized_at=None,
        cache_as_of=cache_as_of,
        generation=generation,
        stale_reason=stale_reason,
        stale_since=None,
        cooldown_until=_rebuild_cooldown_until(
            ds.last_aggregated_at, cooldown_interval_secs,
        ),
        stored_fingerprint=ds.graph_fingerprint,
        drifted=drifted,
        running_job_id=running_job_id,
        last_event=_event_summary(last_event),
    )


async def _running_job_map(
    session: AsyncSession, ds_ids: List[str],
) -> dict[str, str]:
    """Newest pending/running aggregation job id per data source, in ONE
    query (no per-row lookups). Empty dict for sources with no active job."""
    if not ds_ids:
        return {}
    rows = (await session.execute(
        select(
            AggregationJobORM.data_source_id,
            AggregationJobORM.id,
        )
        .where(AggregationJobORM.data_source_id.in_(ds_ids))
        .where(AggregationJobORM.status.in_(["pending", "running"]))
        .order_by(
            AggregationJobORM.data_source_id,
            AggregationJobORM.created_at.desc(),
        )
    )).all()
    out: dict[str, str] = {}
    for ds_id, job_id in rows:
        out.setdefault(ds_id, job_id)  # first per ds = newest (ordered)
    return out


async def _rebuild_override_map(
    session: AsyncSession, ds_ids: List[str],
) -> dict[str, Optional[int]]:
    """Per-source rebuild-interval override (``data_source_state``) for a set
    of data sources, in ONE query (batched like ``_running_job_map`` — no
    per-row reads). Sources without a state row or without an override are
    simply absent from the map (⇒ resolve to global/env). Never raises: a
    failure degrades to an empty map so the freshness read still assembles."""
    if not ds_ids:
        return {}
    from .models import AggregationDataSourceStateORM

    try:
        rows = (await session.execute(
            select(
                AggregationDataSourceStateORM.data_source_id,
                AggregationDataSourceStateORM.rebuild_min_interval_secs,
            ).where(AggregationDataSourceStateORM.data_source_id.in_(ds_ids))
        )).all()
    except Exception as exc:  # pragma: no cover - defensive, never fail a read
        logger.warning("Rebuild-override map read failed (using defaults): %s", exc)
        return {}
    return {ds_id: secs for ds_id, secs in rows if secs is not None}


# Fleet summary is skipped (returned as None) once the workspace/provider-
# filtered set exceeds this many sources — bounds the widened Redis pipeline
# read to a fixed cost regardless of fleet size. See ``_assemble_fleet_summary``.
_SUMMARY_MAX_SOURCES = 1000


async def assemble_fleet_freshness(
    session: AsyncSession,
    *,
    workspace_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    stale_only: bool = False,
    page: int = 1,
    page_size: int = 50,
) -> FreshnessFleetResponse:
    """Fleet freshness: ONE SQL pass (workspace_data_sources ⋈ providers,
    filtered + paged) then ONE Redis pipeline for the cache signals, plus
    batched refresh-event and running-job lookups. Never touches a provider
    or FalkorDB. ``stale_only`` filters on the Redis stale marker via a
    bounded SCAN of stale sources applied as a SQL id filter, so paging and
    ``total`` stay exact."""
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM
    from backend.app.services import graph_cache as _gc
    from backend.app.db.repositories.refresh_events_repo import (
        latest_refresh_event_map,
    )

    page = max(1, page)
    page_size = max(1, min(page_size, 200))

    stale_ids: Optional[set[str]] = None
    if stale_only:
        stale_ids = {ds for _ws, ds in await _gc.list_stale_sources()}
        if not stale_ids:
            # No source anywhere is marked stale, so summary can't be
            # computed without a query — this short-circuit's whole point
            # is to make ZERO SQL calls, so summary is omitted (None) here
            # rather than widened for. Vanishingly rare in practice (it
            # requires no source system-wide to have ever gone stale).
            return FreshnessFleetResponse(rows=[], total=0)

    base = (
        select(WorkspaceDataSourceORM, ProviderORM.name)
        .join(
            ProviderORM,
            ProviderORM.id == WorkspaceDataSourceORM.provider_id,
            isouter=True,
        )
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )
    if workspace_id:
        base = base.where(WorkspaceDataSourceORM.workspace_id == workspace_id)
    if provider_id:
        base = base.where(WorkspaceDataSourceORM.provider_id == provider_id)
    if stale_ids is not None:
        base = base.where(WorkspaceDataSourceORM.id.in_(stale_ids))

    total = (await session.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0

    ds_rows = (await session.execute(
        base
        .order_by(
            WorkspaceDataSourceORM.updated_at.desc(),
            WorkspaceDataSourceORM.id,
        )
        .limit(page_size)
        .offset((page - 1) * page_size)
    )).all()

    ds_list = [row[0] for row in ds_rows]
    provider_names = {row[0].id: row[1] for row in ds_rows}
    ds_ids = [ds.id for ds in ds_list]

    signals = await _gc.read_freshness_signals(
        [(ds.workspace_id, ds.id) for ds in ds_list]
    )
    events = await latest_refresh_event_map(session, ds_ids)
    running = await _running_job_map(session, ds_ids)
    # Resolved rebuild window per source: ONE settings read (cached) for the
    # global + ONE batched query for the per-source overrides, so the
    # ``cooldownUntil`` badge honors both without any per-row reads.
    cadence = await read_global_cadence(session)
    overrides = await _rebuild_override_map(session, ds_ids)

    rows = [
        FreshnessRow(**_freshness_row_kwargs(
            ds,
            provider_name=provider_names.get(ds.id),
            signals=signals.get(
                (str(ds.workspace_id), str(ds.id)), (None, None, None),
            ),
            running_job_id=running.get(ds.id),
            last_event=events.get(ds.id),
            cooldown_interval_secs=resolve_rebuild_interval(
                overrides.get(ds.id), cadence.rebuild_min_interval_secs,
            ),
        ))
        for ds in ds_list
    ]
    summary, provider_summaries = await _assemble_fleet_summary(
        session,
        workspace_id=workspace_id,
        provider_id=provider_id,
        stale_only=stale_only,
        ds_list=ds_list,
        total=total,
        signals=signals,
        running=running,
        provider_names=provider_names,
    )
    return FreshnessFleetResponse(
        rows=rows, total=total, summary=summary,
        provider_summaries=provider_summaries,
    )


async def _assemble_fleet_summary(
    session: AsyncSession,
    *,
    workspace_id: Optional[str],
    provider_id: Optional[str],
    stale_only: bool,
    ds_list: list,
    total: int,
    signals: dict,
    running: dict,
    provider_names: dict,
) -> tuple[Optional[FreshnessSummary], Optional[list[ProviderFreshnessSummary]]]:
    """Fleet stat-tile counts over the workspace/provider-filtered set,
    BEFORE the ``staleOnly`` facet and pagination — so the tiles describe
    the whole filtered fleet, not the visible page. ``(None, None)`` once
    that set exceeds ``_SUMMARY_MAX_SOURCES`` (bounded work; zero
    provider/FalkorDB access, same structural guarantee as the rest of
    fleet assembly). The per-provider breakdown (spec §8a) is reduced from
    the SAME rows in the SAME pass — no extra query.

    Reuses the page's already-fetched rows + the single Redis pipeline +
    running-job map already read for it when the page already IS the full
    filtered set (no ``stale_only`` narrowing and the page covers every
    matching row) — never a second SQL pass or pipeline round-trip in that
    common case.

    ``pending`` (the "rebuild in flight" bucket) is derived from the SAME
    signal ``FreshnessRow.running_job_id`` uses — a live ``AggregationJobORM``
    row in ``pending``/``running`` status — rather than
    ``aggregation_status == "pending"``: the mirror column's pending/running
    writes are dead code (nothing ever calls ``job_pending``/``job_started``),
    so that literal check would always read zero.
    """
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM
    from backend.app.services import graph_cache as _gc

    page_is_full_set = (not stale_only) and (len(ds_list) == total)
    if page_is_full_set:
        full_rows = [
            (ds.id, ds.workspace_id, ds.aggregation_status, ds.provider_id,
             provider_names.get(ds.id))
            for ds in ds_list
        ]
        full_signals = signals
        full_running = running
    else:
        # staleOnly narrows the paged/`total` query, or pagination doesn't
        # cover the full set — the summary basis differs, so a dedicated
        # (bounded) query is unavoidable here. When we already have an
        # exact unfiltered-by-stale count (non-staleOnly requests), skip
        # even that query once it alone proves the set is over the cutoff.
        if not stale_only and total > _SUMMARY_MAX_SOURCES:
            return None, None

        query = (
            select(
                WorkspaceDataSourceORM.id,
                WorkspaceDataSourceORM.workspace_id,
                WorkspaceDataSourceORM.aggregation_status,
                WorkspaceDataSourceORM.provider_id,
                ProviderORM.name,
            )
            .join(
                ProviderORM,
                ProviderORM.id == WorkspaceDataSourceORM.provider_id,
                isouter=True,
            )
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )
        if workspace_id:
            query = query.where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        if provider_id:
            query = query.where(WorkspaceDataSourceORM.provider_id == provider_id)
        query = query.limit(_SUMMARY_MAX_SOURCES + 1)

        full_rows = (await session.execute(query)).all()
        if len(full_rows) > _SUMMARY_MAX_SOURCES:
            return None, None

        full_ids = [row[0] for row in full_rows]
        page_ids = [ds.id for ds in ds_list]
        if set(full_ids) == set(page_ids):
            full_running = running
        else:
            full_running = await _running_job_map(session, full_ids)

        full_pairs = [(str(row[1]), str(row[0])) for row in full_rows]
        page_pairs = [(str(ds.workspace_id), str(ds.id)) for ds in ds_list]
        if set(full_pairs) == set(page_pairs):
            full_signals = signals
        else:
            full_signals = await _gc.read_freshness_signals(full_pairs)

    summary = _summarize_freshness(full_rows, full_signals, full_running)
    provider_summaries = _summarize_by_provider(full_rows, full_signals, full_running)
    return summary, provider_summaries


def _summarize_freshness(
    full_rows: list, signals: dict, running: dict,
) -> FreshnessSummary:
    """Reduce ``(ds_id, workspace_id, aggregation_status, ...)`` rows +
    their Redis signals + running-job map into the fleet summary counts
    (only the first 3 columns are read here; trailing provider columns,
    when present, are for ``_summarize_by_provider``).
    ``needs_attention`` is a per-row OR (marker present or failed), not a
    sum of the two buckets — a row that is both failed and marked stale
    counts once. ``pending`` counts rows with a live job (see
    ``_assemble_fleet_summary`` docstring), independent of
    ``aggregation_status`` — a row can be both ``ready`` (from its last
    completed run) and ``pending`` (a new rebuild already in flight)."""
    ready = pending = failed = not_built = 0
    recomputing = needs_attention = cache_stamped = 0
    for row in full_rows:
        ds_id, ws_id, status = row[0], row[1], row[2]
        if status == "ready":
            ready += 1
        elif status == "failed":
            failed += 1
        if ds_id in running:
            pending += 1
        if status in (None, "none", "skipped"):
            not_built += 1
        _gen, cache_as_of, stale_reason = signals.get(
            (str(ws_id), str(ds_id)), (None, None, None),
        )
        marker = bool(stale_reason)
        if marker:
            recomputing += 1
        if marker or status == "failed":
            needs_attention += 1
        if cache_as_of:
            cache_stamped += 1
    return FreshnessSummary(
        total=len(full_rows),
        ready=ready,
        pending=pending,
        failed=failed,
        not_built=not_built,
        recomputing=recomputing,
        needs_attention=needs_attention,
        cache_stamped=cache_stamped,
    )


def _summarize_by_provider(
    full_rows: list, signals: dict, running: dict,
) -> list[ProviderFreshnessSummary]:
    """Per-provider breakdown of the SAME rows ``_summarize_freshness``
    reduces, grouped by ``(provider_id, provider_name)`` (row columns 4
    and 5) — identical bucket semantics via the same reducer, zero extra
    queries/Redis reads. Sorted by provider_name; the no-provider group
    (``None``) sorts last."""
    groups: dict[tuple, list] = {}
    for row in full_rows:
        groups.setdefault((row[3], row[4]), []).append(row)

    result = []
    for (provider_id, provider_name), rows in groups.items():
        s = _summarize_freshness(rows, signals, running)
        result.append(ProviderFreshnessSummary(
            provider_id=provider_id,
            provider_name=provider_name,
            total=s.total, ready=s.ready, pending=s.pending, failed=s.failed,
            not_built=s.not_built, needs_attention=s.needs_attention,
            cache_stamped=s.cache_stamped,
        ))
    result.sort(key=lambda ps: (ps.provider_name is None, ps.provider_name or ""))
    return result


# ── Custom Exception Classes ────────────────────────────────────────


class ConflictError(Exception):
    """409 — resource conflict (e.g., duplicate active job)."""
    pass


class NotFoundError(Exception):
    """404 — resource not found."""
    pass


class OntologyResolutionError(Exception):
    """422 — the assigned ontology fails the resolution gate.

    Carries the full ``ResolutionReport`` so the endpoint can surface
    blocking_reasons + per-relationship gaps to the wizard without
    re-running the gate. Distinct from a generic ``ValueError`` so
    the trigger endpoint can attach the structured detail body
    cleanly.
    """

    def __init__(self, report):
        self.report = report
        super().__init__(
            "Ontology resolution gate failed: " + ", ".join(report.blocking_reasons)
        )
