"""Property-alignment job kind: event-log and trigger-source constraints.

Revision ID: 20260731_1200_prop_align_kind
Revises: 20260719_1200_agg_cadence
Create Date: 2026-07-31 12:00

The alignment run — which unpacks nested property containers into native
FalkorDB fields — rides the existing job platform rather than growing its own.
Two CHECK constraints have to admit it first, and until they do every insert
dies with an IntegrityError:

* ``aggregation.job_event_log.ck_job_event_log_kind`` gains
  ``property_alignment``, matching the widened ``JobKind`` literal in
  ``backend/app/jobs/schemas.py``. Without it the terminal audit row for a
  completed run cannot be written.
* ``aggregation.aggregation_jobs.ck_agg_jobs_trigger_source`` gains
  ``property_alignment``. Purge established the pattern of reusing the
  aggregation job row with a ``trigger_source`` discriminator, which is also
  what makes an alignment mutually exclusive with an aggregation over the same
  graph — desirable, since the two would otherwise rewrite the same nodes
  concurrently.

Idempotent both ways: each DO-block re-checks the live constraint definition
before touching it, mirroring ``db_init.py``'s safety-net behaviour, and fresh
deploys get the new definitions straight from ``models.py``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260731_1200_prop_align_kind"
down_revision: Union[str, None] = "20260719_1200_agg_cadence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"

_EVENT_LOG = "job_event_log"
_EVENT_LOG_CK = "ck_job_event_log_kind"
_NEW_KINDS = "'aggregation', 'purge', 'stats', 'discovery', 'property_alignment'"
_OLD_KINDS = "'aggregation', 'purge', 'stats', 'discovery'"

_JOBS = "aggregation_jobs"
_JOBS_CK = "ck_agg_jobs_trigger_source"
_NEW_SOURCES = (
    "'onboarding', 'manual', 'schedule', 'drift', 'api', 'purge', "
    "'post_purge', 'auto', 'property_alignment'"
)
_OLD_SOURCES = (
    "'onboarding', 'manual', 'schedule', 'drift', 'api', 'purge', "
    "'post_purge', 'auto'"
)


def _swap(table: str, constraint: str, column: str, values: str,
          *, guard_like: str, guard_negate: bool) -> str:
    """Rebuild an IN-list CHECK, but only when it doesn't already say so."""
    negate = "NOT " if guard_negate else ""
    return f"""
    DO $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = '{_SCHEMA}' AND t.relname = '{table}'
              AND c.conname = '{constraint}'
              AND {negate}pg_get_constraintdef(c.oid) LIKE '%{guard_like}%'
        ) THEN
            ALTER TABLE {_SCHEMA}.{table} DROP CONSTRAINT {constraint};
            ALTER TABLE {_SCHEMA}.{table}
                ADD CONSTRAINT {constraint}
                CHECK ({column} IN ({values}));
        END IF;
    END $$
    """


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table(_EVENT_LOG, schema=_SCHEMA):
        bind.execute(sa.text(_swap(
            _EVENT_LOG, _EVENT_LOG_CK, "kind", _NEW_KINDS,
            guard_like="property_alignment", guard_negate=True,
        )))
    if inspector.has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(_swap(
            _JOBS, _JOBS_CK, "trigger_source", _NEW_SOURCES,
            guard_like="property_alignment", guard_negate=True,
        )))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table(_EVENT_LOG, schema=_SCHEMA):
        bind.execute(sa.text(_swap(
            _EVENT_LOG, _EVENT_LOG_CK, "kind", _OLD_KINDS,
            guard_like="property_alignment", guard_negate=False,
        )))
    if inspector.has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(_swap(
            _JOBS, _JOBS_CK, "trigger_source", _OLD_SOURCES,
            guard_like="property_alignment", guard_negate=False,
        )))
