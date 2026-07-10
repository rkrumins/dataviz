"""Aggregation job-row guards: trigger sources + active-only idem index.

Revision ID: 20260711_1200_agg_job_guards
Revises: 20260710_1200_agg_tuning_stats
Create Date: 2026-07-11 12:00

Two guards on ``aggregation.aggregation_jobs``:

* ``ck_agg_jobs_trigger_source`` gains ``post_purge`` (the re-aggregation
  the purge worker fires after a purge completes) and ``auto`` (the
  read-path backfill). Both automatic callers already send these values;
  without the constraint change every such INSERT died with an
  IntegrityError, so a purged graph silently never got its rollups back.
* ``ix_agg_jobs_idem_active`` is narrowed to rows with
  ``status IN ('pending','running')`` — the replay window is 60 minutes,
  so an idempotency key reused after that must mint a fresh job instead
  of colliding with a completed row's forever-unique tombstone (500).

Idempotent both ways: the DO-blocks re-check the live definition before
touching anything, mirroring ``db_init.py``'s safety-net behavior, and
fresh deploys get the new definitions straight from ``models.py``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260711_1200_agg_job_guards"
down_revision: Union[str, None] = "20260710_1200_agg_tuning_stats"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_JOBS = "aggregation_jobs"

_NEW_SOURCES = "'onboarding', 'manual', 'schedule', 'drift', 'api', 'purge', 'post_purge', 'auto'"
_OLD_SOURCES = "'onboarding', 'manual', 'schedule', 'drift', 'api', 'purge'"

_NEW_IDEM_WHERE = (
    "idempotency_key IS NOT NULL AND status IN ('pending', 'running')"
)
_OLD_IDEM_WHERE = "idempotency_key IS NOT NULL"


def _swap_constraint(sources: str, *, guard_like: str, guard_negate: bool) -> str:
    negate = "NOT " if guard_negate else ""
    return f"""
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = '{_SCHEMA}' AND t.relname = '{_JOBS}'
              AND c.conname = 'ck_agg_jobs_trigger_source'
              AND {negate}pg_get_constraintdef(c.oid) LIKE '%{guard_like}%'
        ) THEN
            ALTER TABLE {_SCHEMA}.{_JOBS}
                DROP CONSTRAINT ck_agg_jobs_trigger_source;
            ALTER TABLE {_SCHEMA}.{_JOBS}
                ADD CONSTRAINT ck_agg_jobs_trigger_source
                CHECK (trigger_source IN ({sources}));
        END IF;
    END $$
    """


def _swap_idem_index(where: str, *, guard_like: str, guard_negate: bool) -> str:
    negate = "NOT " if guard_negate else ""
    return f"""
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = '{_SCHEMA}' AND tablename = '{_JOBS}'
              AND indexname = 'ix_agg_jobs_idem_active'
              AND {negate}indexdef LIKE '%{guard_like}%'
        ) THEN
            DROP INDEX {_SCHEMA}.ix_agg_jobs_idem_active;
            CREATE UNIQUE INDEX ix_agg_jobs_idem_active
                ON {_SCHEMA}.{_JOBS} (data_source_id, idempotency_key)
                WHERE {where};
        END IF;
    END $$
    """


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        return
    bind.execute(sa.text(_swap_constraint(
        _NEW_SOURCES, guard_like="post_purge", guard_negate=True,
    )))
    bind.execute(sa.text(_swap_idem_index(
        _NEW_IDEM_WHERE, guard_like="status", guard_negate=True,
    )))


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        return
    bind.execute(sa.text(_swap_constraint(
        _OLD_SOURCES, guard_like="post_purge", guard_negate=False,
    )))
    bind.execute(sa.text(_swap_idem_index(
        _OLD_IDEM_WHERE, guard_like="status", guard_negate=False,
    )))
