"""Per-source learned pressure state (observed_tuning).

Revision ID: 20260909_1000_observed_tuning
Revises: 20260908_1000_rollup_storage
Create Date: 2026-09-09 10:00

A rebuild under the graph store's per-query pressure (the memory ceiling,
query timeouts) narrows its scans, reads serially, switches the reconcile
to keys-only and shrinks its write batches until every query fits. Without
memory of that, the NEXT rebuild of the same source rediscovers it all from
scratch. This column is that memory: a JSON object the worker writes on
success — the narrowest scan width the run needed, whether it read
serially, the reconcile strategy, the write batch and delete chunk it
settled on — and hands the next run as capacity hints that only ever make
a knob stricter. ``"{}"`` means the last run needed nothing.

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


revision: str = "20260909_1000_observed_tuning"
down_revision: Union[str, None] = "20260908_1000_rollup_storage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"
_COLUMN = "observed_tuning"


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
