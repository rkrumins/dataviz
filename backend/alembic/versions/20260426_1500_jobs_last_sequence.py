"""Add ``last_sequence`` column to ``aggregation.aggregation_jobs``.

Revision ID: 20260426_1500_jobs_last_sequence
Revises: 20260425_1300_insights_refactor
Create Date: 2026-04-26 15:00

Backs the per-emit sequence counter the platform ``JobEmitter`` uses
as the ``(job_id, sequence)`` idempotency key for events. Strictly
monotonic per job_id; the worker increments it on every event
published and persists the high-water-mark at outer-batch boundaries
so that on crash + resume the recovered worker can continue numbering
without producing duplicates that downstream SSE consumers / the
audit log would otherwise have to dedup.

Nullable + default 0 so back-compat with existing rows is trivial:
treat NULL the same as 0, no backfill required.

Idempotent: the baseline migration uses ``Base.metadata.create_all``
so on fresh deploys the column already exists. Inspector check before
add_column.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260426_1500_jobs_last_sequence"
down_revision: Union[str, None] = "20260425_1300_insights_refactor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "aggregation_jobs"
_SCHEMA = "aggregation"
_COLUMN = "last_sequence"


def _has_column(inspector: sa.engine.reflection.Inspector) -> bool:
    columns = inspector.get_columns(_TABLE, schema=_SCHEMA)
    return any(c["name"] == _COLUMN for c in columns)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector):
        return
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.Integer(), nullable=True, server_default="0"),
        schema=_SCHEMA,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_column(inspector):
        return
    op.drop_column(_TABLE, _COLUMN, schema=_SCHEMA)
