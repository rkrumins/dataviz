"""Operator snooze for automatic reconciliation.

Revision ID: 20260817_1400_recon_pause
Revises: 20260817_1200_drift_probe
Create Date: 2026-08-17 14:00

Turning automation off was the only way to stop a known-broken source from
churning, and it is never turned back on. ``paused_until`` is the missing
middle: a time-boxed hold that expires by itself.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a bare
add_column here would make a brand-new environment unbuildable while every
migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260817_1400_recon_pause"
down_revision: Union[str, None] = "20260817_1200_drift_probe"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if "paused_until" not in _columns(inspector, _STATE, schema=_SCHEMA):
        op.add_column(
            _STATE, sa.Column("paused_until", sa.Text(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if "paused_until" in _columns(inspector, _STATE, schema=_SCHEMA):
        op.drop_column(_STATE, "paused_until", schema=_SCHEMA)
