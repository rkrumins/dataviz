"""Limits raised on a running job (live_overrides).

Revision ID: 20260909_1100_job_live_overrides
Revises: 20260909_1000_observed_tuning
Create Date: 2026-09-09 11:00

A running rebuild's watchdog used to read the job's stall window once, at
start, and its wall clock from the environment; the only way to give a
slow rebuild more time was to cancel it and resume with a larger value.
This column holds what an operator raised on the RUNNING job — the wall
clock and the two per-query timeouts, plus a bounded history of who raised
what, from what, to what (the stall window itself lives in ``timeout_secs``).
The worker re-reads the row every few watchdog ticks and the pipeline reads
the per-query budgets per query, so a raise takes effect within a minute
without cancelling anything.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a bare
add_column here would make a brand-new environment unbuildable while every
migrated database kept working. The Control Plane's ``init_aggregation_db``
adds the column on start as well (its additive-migrations list is mirrored
with this file), so a CP that boots before this migration has run is fine.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260909_1100_job_live_overrides"
down_revision: Union[str, None] = "20260909_1000_observed_tuning"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_TABLE = "aggregation_jobs"
_COLUMN = "live_overrides"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    if _COLUMN not in _columns(inspector, _TABLE, schema=_SCHEMA):
        op.add_column(
            _TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    if _COLUMN in _columns(inspector, _TABLE, schema=_SCHEMA):
        op.drop_column(_TABLE, _COLUMN, schema=_SCHEMA)
