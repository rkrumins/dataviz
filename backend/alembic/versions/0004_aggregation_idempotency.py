"""Phase 2 §2.2 — aggregation_jobs.idempotency_key + partial unique index.

Revision ID: 0004_aggregation_idempotency
Revises: 0003_extraction_readiness
Create Date: 2026-04-14

Adds caller-supplied idempotency keys to aggregation triggers. Two
POSTs sharing a key for the same data source collapse to the original
job (returns 200, not 409). The partial unique index enforces "at most
one active job per (data_source_id, idempotency_key) when a key is
supplied" without blocking the common case where no key is provided.

Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
to cooperate with the 0001 baseline that uses `Base.metadata.create_all`
— see the FIXME in 0001_baseline.py.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0004_aggregation_idempotency"
down_revision: Union[str, None] = "0003_extraction_readiness"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE aggregation_jobs "
        "ADD COLUMN IF NOT EXISTS idempotency_key TEXT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_agg_jobs_idem_active "
        "ON aggregation_jobs (data_source_id, idempotency_key) "
        "WHERE idempotency_key IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_agg_jobs_idem_active")
    op.execute(
        "ALTER TABLE aggregation_jobs DROP COLUMN IF EXISTS idempotency_key"
    )
