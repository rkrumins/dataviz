"""Remove legacy global-primary connection state from graph_connections.

Revision ID: 0005_rm_primary_conn
Revises: 0004_aggregation_idempotency
Create Date: 2026-04-14

The old `graph_connections.is_primary` column represented a single global
"default" graph provider. Provider resolution is now explicit and scoped to
workspaces/data sources, so the column and its supporting index are removed.

Postgres-first and idempotent (`DROP ... IF EXISTS`, `ADD COLUMN IF NOT EXISTS`)
to match the rest of the Synodic Alembic stack.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0005_rm_primary_conn"
down_revision: Union[str, None] = "0004_aggregation_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_connections_is_primary")
    op.execute(
        "ALTER TABLE graph_connections DROP COLUMN IF EXISTS is_primary"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE graph_connections ADD COLUMN IF NOT EXISTS is_primary BOOLEAN"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_connections_is_primary "
        "ON graph_connections (is_primary)"
    )
