"""Phase 1.5 §1.5.6 — outbox payload contract columns.

Revision ID: 0003_extraction_readiness
Revises: 0002_revoked_refresh_jti
Create Date: 2026-04-14

Adds the canonical event-payload contract fields to `outbox_events`:
`event_version`, `aggregate_type`, `aggregate_id`. Indexed for the
typical "give me all events for entity X" replay query.

Originally this revision also added `version` optimistic-concurrency
columns to seven mutable tables and a `workspace_id` denormalisation
to four transactional tables. The cleanup pass removed both: neither
had a single repo or query consuming them, so they were YAGNI-grade
debt. They will be re-introduced — in their own targeted revisions —
the day a real call site needs them.

Idempotency: written with `ADD COLUMN IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` so it cooperates with the 0001 baseline
that uses `Base.metadata.create_all` — see the FIXME in 0001_baseline.py.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0003_extraction_readiness"
down_revision: Union[str, None] = "0002_revoked_refresh_jti"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS event_version "
        "INTEGER NOT NULL DEFAULT 1"
    )
    op.execute(
        "ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS aggregate_type TEXT"
    )
    op.execute(
        "ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS aggregate_id TEXT"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_outbox_aggregate "
        "ON outbox_events (aggregate_type, aggregate_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_outbox_event_type "
        "ON outbox_events (event_type)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_outbox_event_type")
    op.execute("DROP INDEX IF EXISTS idx_outbox_aggregate")
    for column in ("aggregate_id", "aggregate_type", "event_version"):
        op.execute(f'ALTER TABLE outbox_events DROP COLUMN IF EXISTS {column}')
