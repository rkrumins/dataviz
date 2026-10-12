"""Measured bytes per rolled-up edge, per data source.

Revision ID: 20260907_1000_bytes_per_edge
Revises: 20260903_1000_automation_holds
Create Date: 2026-09-07 10:00

The write budget used to be a static edge count that never read the graph
store, so an operator who added memory to every shard still saw "writing this
would risk exhausting the FalkorDB instance's memory". A rebuild now measures
the shard that owns the graph and budgets by its real headroom — at a
bytes-per-edge figure that was only ever a planning constant (~0.5KB). This
column is where a successful rebuild records what an edge ACTUALLY cost on
that shard, so the next rebuild of the same graph budgets from evidence.
NULL until a fresh run with material growth has calibrated it; see
``backend/app/providers/shard_capacity.py``.

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


revision: str = "20260907_1000_bytes_per_edge"
down_revision: Union[str, None] = "20260903_1000_automation_holds"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"
_COLUMN = "observed_bytes_per_edge"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN not in _columns(inspector, _STATE, schema=_SCHEMA):
        op.add_column(
            _STATE, sa.Column(_COLUMN, sa.Integer(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN in _columns(inspector, _STATE, schema=_SCHEMA):
        op.drop_column(_STATE, _COLUMN, schema=_SCHEMA)
