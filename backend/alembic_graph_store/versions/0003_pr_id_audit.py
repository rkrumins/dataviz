"""Graph Store: add pr_id to graph_change_event for merge attribution.

Revision ID: 0003_pr_id_audit
Revises: 0002_fork_and_pr
Create Date: 2026-05-21

Additive nullable text column + index so blame queries can render
"merged via PR #N" for change events produced by a PR merge commit
(Phase 1 closeout item B.4). Service-layer use of the column waits
on the cross-graph merge orchestrator (Phase 2.5 item B.3); this
migration is the safe schema-only foundation.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0003_pr_id_audit"
down_revision: Union[str, None] = "0002_fork_and_pr"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE graph_change_event "
        "ADD COLUMN IF NOT EXISTS pr_id text"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gce_pr "
        "ON graph_change_event (pr_id, created_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_gce_pr")
    op.execute("ALTER TABLE graph_change_event DROP COLUMN IF EXISTS pr_id")
