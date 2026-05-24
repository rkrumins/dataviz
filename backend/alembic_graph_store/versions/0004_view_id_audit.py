"""Graph Store: add view_id to graph_change_event for per-view audit.

Revision ID: 0004_view_id_audit
Revises: 0003_pr_id_audit
Create Date: 2026-05-22

Additive nullable text column + composite index so per-view audit is
a single indexed query, not a branch→view JOIN. Captured at commit
time from the CommitRequest's view_id field (passed through by the
endpoint → engine → persist_commit). NULL for commits made outside a
view context (direct API edits, system actors).

See plan section "View-as-branch model — per-source AND per-view
audit" decision 19.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0004_view_id_audit"
down_revision: Union[str, None] = "0003_pr_id_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE graph_change_event "
        "ADD COLUMN IF NOT EXISTS view_id text"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gce_view "
        "ON graph_change_event (graph_id, view_id, created_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_gce_view")
    op.execute("ALTER TABLE graph_change_event DROP COLUMN IF EXISTS view_id")
