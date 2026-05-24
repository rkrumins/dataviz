"""Extend ViewORM with version-control binding columns.

Revision ID: 20260522_1200_view_binding
Revises: 20260521_1200_basic_lineage_ontology
Create Date: 2026-05-22

Additive nullable columns + defaults so legacy views continue to work
unchanged (NULL source_graph_id = "provider-driven, today's
behaviour"). New columns:

- source_graph_id    soft ref to user_graphs.id (cross-DB; no FK)
- source_branch      the branch this view renders + commits to
- branching_policy   shared_main | per_view (default) | per_user_per_view
- merge_target_branch destination for "Publish" PRs (default 'main')

Plan section "View-as-branch model — per-source AND per-view audit"
decisions 16-18 + data model additions.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260522_1200_view_binding"
down_revision: Union[str, None] = "20260521_1200_basic_lineage_ontology"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "views"):
        return

    op.execute(
        "ALTER TABLE views "
        "ADD COLUMN IF NOT EXISTS source_graph_id text"
    )
    op.execute(
        "ALTER TABLE views "
        "ADD COLUMN IF NOT EXISTS source_branch text"
    )
    op.execute(
        "ALTER TABLE views "
        "ADD COLUMN IF NOT EXISTS branching_policy text "
        "NOT NULL DEFAULT 'per_view'"
    )
    op.execute(
        "ALTER TABLE views "
        "ADD COLUMN IF NOT EXISTS merge_target_branch text "
        "NOT NULL DEFAULT 'main'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_view_source_graph "
        "ON views (source_graph_id)"
    )
    # CHECK constraint guarded for re-runs.
    op.execute(
        "ALTER TABLE views DROP CONSTRAINT IF EXISTS ck_views_branching_policy"
    )
    op.execute(
        "ALTER TABLE views ADD CONSTRAINT ck_views_branching_policy "
        "CHECK (branching_policy IN ('shared_main', 'per_view', 'per_user_per_view'))"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "views"):
        return
    op.execute(
        "ALTER TABLE views DROP CONSTRAINT IF EXISTS ck_views_branching_policy"
    )
    op.execute("DROP INDEX IF EXISTS idx_view_source_graph")
    op.execute("ALTER TABLE views DROP COLUMN IF EXISTS merge_target_branch")
    op.execute("ALTER TABLE views DROP COLUMN IF EXISTS branching_policy")
    op.execute("ALTER TABLE views DROP COLUMN IF EXISTS source_branch")
    op.execute("ALTER TABLE views DROP COLUMN IF EXISTS source_graph_id")
