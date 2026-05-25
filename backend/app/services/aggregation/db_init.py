"""
Aggregation-owned database initialization.

Standalone init for the Control Plane and Worker processes.  Does NOT
depend on Alembic — creates the ``aggregation`` schema and its tables
directly via SQLAlchemy ``create_all``.

This is the correct entry point for microservice processes.  The
Schema migrations are owned by the synodic-upgrade service
(``backend/scripts/upgrade.py``) — this function only ensures the
aggregation schema + tables exist for Control Plane / Worker processes
booting before the upgrade Job has applied Alembic changes. With the
``wait-for-schema`` initContainer in place this is mostly safety net.

Idempotent — safe to call on every startup from any process.
"""
import asyncio
import logging
import time

from sqlalchemy import text

logger = logging.getLogger(__name__)

SCHEMA_NAME = "aggregation"

# Retry config for transient Postgres connection failures (container
# startup ordering, network init, etc.)
_RETRY_BUDGET_SECS = 60
_RETRY_INITIAL_DELAY = 1.0
_RETRY_MAX_DELAY = 10.0


async def init_aggregation_db() -> None:
    """Full standalone DB init for Control Plane / Worker processes.

    1. Creates the ``aggregation`` Postgres schema (IF NOT EXISTS)
    2. Creates aggregation-owned tables via ``create_all(checkfirst=True)``
    3. Retries transient connection errors with exponential backoff
    4. Does NOT run Alembic migrations (that's the viz-service's job)
    5. Does NOT touch public-schema tables

    Uses the existing engine factory from ``backend.app.db.engine``
    (shared pool config, connection parameters, etc.) rather than
    creating a standalone engine.
    """
    from backend.app.db.engine import get_engine, PoolRole, Base

    # Import models to register them with Base.metadata
    from .models import AggregationJobORM, AggregationDataSourceStateORM  # noqa: F401

    engine = get_engine(PoolRole.ADMIN)
    deadline = time.monotonic() + _RETRY_BUDGET_SECS
    delay = _RETRY_INITIAL_DELAY
    attempt = 0

    while True:
        attempt += 1
        try:
            # 1. Create the schema
            async with engine.begin() as conn:
                await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA_NAME}"))
            logger.info("Aggregation schema '%s' ready", SCHEMA_NAME)

            # 2. Create aggregation-owned tables (checkfirst=True = IF NOT EXISTS)
            async with engine.begin() as conn:
                aggregation_tables = [
                    table for table in Base.metadata.tables.values()
                    if getattr(table, "schema", None) == SCHEMA_NAME
                ]
                for table in aggregation_tables:
                    await conn.run_sync(
                        lambda sync_conn, t=table: t.create(sync_conn, checkfirst=True)
                    )
                    logger.debug("Table '%s.%s' ready", SCHEMA_NAME, table.name)

            # 3. Apply column-level migrations idempotently.
            #
            # ``create_all(checkfirst=True)`` creates missing tables but
            # does NOT alter existing tables to add new columns. Each
            # column added to the ORM after the table was first
            # created needs an explicit idempotent ALTER here.
            # Postgres ``ADD COLUMN IF NOT EXISTS`` (Postgres ≥9.6)
            # makes each statement safe to run on every startup,
            # whether or not the column already exists.
            #
            # Migrations list — append-only, in chronological order:
            _additive_migrations = (
                # Phase 1.7 (2026-05-12) — phase visibility for UI
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS current_phase TEXT NULL",
                # 2026-05-21 — cache last successful lineage edge count so
                # the next job can skip the full-edge count(r) scan that
                # added 30s+ of pre-flight overhead per job start on
                # multi-million-edge graphs.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS lineage_edge_count BIGINT NULL",
                # 2026-05-25 — composite index backing the skip-path
                # lookup in worker._maybe_skip_unchanged. Without it
                # the ORDER BY completed_at DESC sorts every completed
                # row for the data source on every job.
                f"CREATE INDEX IF NOT EXISTS ix_agg_jobs_ds_status_completed_desc "
                f"ON {SCHEMA_NAME}.aggregation_jobs "
                f"(data_source_id, status, completed_at DESC)",
                # 2026-05-25 — flag indicating the job short-circuited
                # via the skip-unchanged path (worker._maybe_skip_unchanged).
                # Surfaced in AggregationJobResponse so the UI can render
                # a "Reused" badge. NULL on legacy rows = treat as False.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS last_run_was_skipped BOOLEAN DEFAULT FALSE",
                # 2026-05-25 — per-job override that forces a real
                # rebuild even when the fingerprint matches. Lets
                # non-UI callers force a rebuild while preserving the
                # original ``trigger_source`` for audit.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS force_rebuild BOOLEAN DEFAULT FALSE",
            )
            async with engine.begin() as conn:
                for stmt in _additive_migrations:
                    try:
                        await conn.execute(text(stmt))
                    except Exception as exc:
                        # Don't fail init on a single migration — log
                        # and continue. Worst case the affected feature
                        # degrades gracefully (e.g. UI phase label
                        # stays NULL).
                        logger.warning(
                            "Aggregation additive migration failed "
                            "(continuing init): %s — %s",
                            stmt, exc,
                        )

            if attempt > 1:
                logger.info(
                    "Aggregation DB init succeeded on attempt %d (Postgres became reachable)",
                    attempt,
                )
            logger.info(
                "Aggregation DB init complete (%d tables in '%s' schema, "
                "%d additive migrations applied)",
                len(aggregation_tables), SCHEMA_NAME,
                len(_additive_migrations),
            )
            return

        except Exception as exc:
            remaining = deadline - time.monotonic()
            # Check if this looks like a transient connection error
            is_transient = _is_transient(exc)
            if not is_transient or remaining <= 0:
                if remaining <= 0:
                    logger.error(
                        "Giving up on aggregation DB init after %.0fs / %d attempts. "
                        "Last error: %s",
                        _RETRY_BUDGET_SECS, attempt, str(exc)[:300],
                    )
                raise

            sleep_for = min(delay, remaining)
            logger.warning(
                "Aggregation DB init attempt %d failed (%.0fs budget left, "
                "retrying in %.1fs): %s",
                attempt, remaining, sleep_for, str(exc)[:200],
            )
            await asyncio.sleep(sleep_for)
            delay = min(delay * 2, _RETRY_MAX_DELAY)


def _is_transient(exc: Exception) -> bool:
    """Check if an exception looks like a transient connection error."""
    transient_markers = (
        "connection refused",
        "could not connect",
        "connection reset",
        "timeout",
        "no route to host",
        "name or service not known",
        "temporary failure in name resolution",
    )
    msg = str(exc).lower()
    return any(marker in msg for marker in transient_markers)
