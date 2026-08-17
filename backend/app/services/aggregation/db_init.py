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
                # Streaming rebuild — entity-type level map frozen at
                # trigger time so the worker can inject levels + drive
                # per-label indexing without an ontology-module dependency.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS entity_type_levels TEXT NULL",
                # Iteration 2 (2026-07) — per-job pipeline tuning (JSON),
                # durable per-phase run stats, and which worker ran the job.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS tuning_json TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS run_stats TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS worker_id TEXT NULL",
                # F9 (2026-07-19) — configurable rebuild cadence, mirrored in
                # alembic 20260719_1200_agg_cadence: a per-source cooldown
                # override on the state table and the persisted GLOBAL cadence
                # (its own column so cadence never leaks into per-job tuning).
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS rebuild_min_interval_secs INTEGER NULL",
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_settings "
                "ADD COLUMN IF NOT EXISTS cadence_json TEXT NULL",
                # Node-identity property (URN-equivalent) frozen at trigger
                # time (2026-07-21), mirrored in alembic
                # 20260721_1200_ds_identity_prop. NULL → "urn" in the
                # worker, so every legacy row keeps the canonical behaviour.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS identity_property TEXT NULL",
                # Node display-name property frozen at trigger time (2026-07-21),
                # mirrored in alembic 20260721_1500_ds_name_prop.
                f"ALTER TABLE {SCHEMA_NAME}.aggregation_jobs "
                "ADD COLUMN IF NOT EXISTS name_property TEXT NULL",
                # Job-row guards (2026-07-11), mirrored in alembic
                # 20260711_1200_agg_job_guards: the trigger-source CHECK
                # must accept the automatic callers (post_purge, auto) or
                # their INSERTs die as IntegrityErrors; the idempotency
                # unique index must only cover ACTIVE rows or a key reused
                # after the 60-min replay window 500s on a completed
                # tombstone. Both DO-blocks re-check the live definition
                # first, so they no-op on every boot after the first.
                f"""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint c
                        JOIN pg_class t ON t.oid = c.conrelid
                        JOIN pg_namespace n ON n.oid = t.relnamespace
                        WHERE n.nspname = '{SCHEMA_NAME}'
                          AND t.relname = 'aggregation_jobs'
                          AND c.conname = 'ck_agg_jobs_trigger_source'
                          AND pg_get_constraintdef(c.oid) NOT LIKE '%post_purge%'
                    ) THEN
                        ALTER TABLE {SCHEMA_NAME}.aggregation_jobs
                            DROP CONSTRAINT ck_agg_jobs_trigger_source;
                        ALTER TABLE {SCHEMA_NAME}.aggregation_jobs
                            ADD CONSTRAINT ck_agg_jobs_trigger_source
                            CHECK (trigger_source IN ('onboarding', 'manual',
                                'schedule', 'drift', 'api', 'purge',
                                'post_purge', 'auto'));
                    END IF;
                END $$
                """,
                f"""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM pg_indexes
                        WHERE schemaname = '{SCHEMA_NAME}'
                          AND tablename = 'aggregation_jobs'
                          AND indexname = 'ix_agg_jobs_idem_active'
                          AND indexdef NOT LIKE '%status%'
                    ) THEN
                        DROP INDEX {SCHEMA_NAME}.ix_agg_jobs_idem_active;
                        CREATE UNIQUE INDEX ix_agg_jobs_idem_active
                            ON {SCHEMA_NAME}.aggregation_jobs
                            (data_source_id, idempotency_key)
                            WHERE idempotency_key IS NOT NULL
                              AND status IN ('pending', 'running');
                    END IF;
                END $$
                """,
                # Automatic reconciliation (2026-08-14), mirrored in alembic
                # 20260814_1200_agg_reconcile. Per-source policy, the drift
                # baseline (AGGREGATED-excluded, so it survives a rebuild),
                # the checked/acted stamps, the stored drift verdict, and the
                # circuit-breaker counter. The CP and worker boot against this
                # table before alembic has necessarily run, so they carry the
                # same columns here.
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS reconcile_enabled BOOLEAN NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS reconcile_check_interval_secs INTEGER NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS raw_fingerprint TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS raw_node_count INTEGER NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS raw_edge_count INTEGER NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_reconcile_checked_at TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_reconciled_at TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_reconcile_reason TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_reconcile_mode TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS drift_state TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS reconcile_consecutive_actions "
                "INTEGER NULL DEFAULT 0",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_finding_at TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_finding_reason TEXT NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_finding_evidence TEXT NULL",
                f"CREATE INDEX IF NOT EXISTS ix_ds_state_recon_due "
                f"ON {SCHEMA_NAME}.data_source_state (last_reconcile_checked_at)",
                # Drift probe (2026-08-17), mirrored in alembic
                # 20260817_1200_drift_probe. Per-source probe cadence, resolved
                # by the same override → global → env chain as the two
                # reconcile settings above.
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS probe_enabled BOOLEAN NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS probe_interval_secs INTEGER NULL",
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS last_seen_counts_digest TEXT NULL",
                # Operator snooze (2026-08-17), mirrored in alembic
                # 20260817_1400_recon_pause. A time-boxed hold so a
                # known-broken source can be excluded from automation without
                # turning it off forever.
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS paused_until TEXT NULL",
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
