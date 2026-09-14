"""Per-source Rollup storage override.

Revision ID: 20260908_1000_rollup_storage
Revises: 20260907_1000_bytes_per_edge
Create Date: 2026-09-08 10:00

Rollup storage — full cube versus depth-diagonal — was a fleet-wide choice
(the stored Defaults row, then the env) or a per-job one (the re-trigger
dialog). The drawer's "Would not fit" guidance told an operator to set THIS
source to Auto, and no such control existed. This column is that override:
'auto' | 'true' (full detail) | 'false' (diagonal), NULL = inherit. It is
resolved into the job's frozen tuning at trigger time, so automation and
manual rebuilds honour it alike, and a per-job request still wins over it.

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


revision: str = "20260908_1000_rollup_storage"
down_revision: Union[str, None] = "20260907_1000_bytes_per_edge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"
_COLUMN = "rollup_storage"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN not in _columns(inspector, _STATE, schema=_SCHEMA):
        op.add_column(
            _STATE, sa.Column(_COLUMN, sa.Text(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN in _columns(inspector, _STATE, schema=_SCHEMA):
        op.drop_column(_STATE, _COLUMN, schema=_SCHEMA)
