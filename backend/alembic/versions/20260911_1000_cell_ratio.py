"""Measured cell ratio per data source (observed_cell_ratio).

Revision ID: 20260911_1000_cell_ratio
Revises: 20260909_1100_job_live_overrides
Create Date: 2026-09-11 10:00

The column the ORM has declared since the cube-estimate calibration work,
that nothing ever added to an existing database.

``0001_baseline`` create_all()s the CURRENT ORM, so a brand-new environment
had it and every migrated one did not — the exact split the schema guard
exists to catch, and it caught it. The Control Plane's
``init_aggregation_db`` was meant to be the other half of the mirror, but
its statement had lost its ``ALTER TABLE`` prefix and was therefore invalid
SQL, swallowed by the per-statement try/except that keeps one bad additive
migration from failing start-up. So the write path in
``worker._update_ds_state`` would have issued an UPDATE naming a column
that does not exist, on every deployment that was not built from scratch.

Inspector-guarded like its siblings, so the baseline path stays buildable.

``DOUBLE PRECISION`` deliberately, matching the ORM: SQLAlchemy's ``Float``
compiles to ``FLOAT``, Postgres stores that as double precision, and
reflection reads it back as ``DOUBLE PRECISION`` — a ``Float`` on either
side can never compare equal to the live column.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import DOUBLE_PRECISION


revision: str = "20260911_1000_cell_ratio"
down_revision: Union[str, None] = "20260909_1100_job_live_overrides"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"
_COLUMN = "observed_cell_ratio"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN not in _columns(inspector, _STATE, schema=_SCHEMA):
        op.add_column(
            _STATE, sa.Column(_COLUMN, DOUBLE_PRECISION(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if _COLUMN in _columns(inspector, _STATE, schema=_SCHEMA):
        op.drop_column(_STATE, _COLUMN, schema=_SCHEMA)
