"""Workspace requests: asking for a workspace of your own.

* ``workspace_requests`` — one row per request: what the person asked for (a name,
  what it is for, teammates to add, Playground graphs to bring along), where it
  stands (``pending``, ``changes_requested`` while an approver's question waits,
  ``approved``, ``declined``, ``withdrawn``) and, once approved, the workspace it
  made and what that did (``outcome``). No foreign keys: people, workspaces and
  sources are named by id. One open request per person, held by a partial unique
  index.

Fresh installs get the table from ``0001_baseline``'s create_all and never run this
file, so the DDL is guarded. Revision id is kept <=32 chars
(alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261121_1000_workspace_requests
Revises: 20261120_1000_playground
Create Date: 2026-11-21 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261121_1000_workspace_requests"
down_revision: Union[str, None] = "20261120_1000_playground"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_OPEN = "status IN ('pending', 'changes_requested')"
_STATE = (
    "(status = 'pending' AND resolved_at IS NULL) "
    "OR (status = 'changes_requested' AND resolved_at IS NULL AND question IS NOT NULL) "
    "OR (status = 'approved' AND resolved_at IS NOT NULL AND workspace_id IS NOT NULL) "
    "OR (status IN ('declined', 'withdrawn') AND resolved_at IS NOT NULL)"
)


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")

    if not sa.inspect(bind).has_table("workspace_requests"):
        op.create_table(
            "workspace_requests",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("requester_id", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("purpose", sa.Text(), nullable=False),
            sa.Column("team_name", sa.Text(), nullable=True),
            sa.Column("teammate_ids", sa.Text(), nullable=False),
            sa.Column("playground_source_ids", sa.Text(), nullable=False),
            sa.Column("proposed_groups", sa.Text(), nullable=False),
            sa.Column("data_needs", sa.Text(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("question", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.Column("workspace_id", sa.Text(), nullable=True),
            sa.Column("outcome", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "purpose IN ('team', 'project', 'poc', 'reporting', 'other')",
                name="ck_workspace_requests_purpose",
            ),
            sa.CheckConstraint(
                "status IN ('pending', 'changes_requested', 'approved', 'declined', 'withdrawn')",
                name="ck_workspace_requests_status",
            ),
            sa.CheckConstraint(_STATE, name="ck_workspace_requests_state_consistency"),
        )
    op.create_index(
        "idx_workspace_requests_status_created", "workspace_requests", ["status", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_workspace_requests_requester", "workspace_requests", ["requester_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "uq_workspace_requests_one_open", "workspace_requests", ["requester_id"],
        unique=True,
        postgresql_where=sa.text(_OPEN),
        sqlite_where=sa.text(_OPEN),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("uq_workspace_requests_one_open", table_name="workspace_requests", if_exists=True)
    op.drop_index("idx_workspace_requests_requester", table_name="workspace_requests", if_exists=True)
    op.drop_index("idx_workspace_requests_status_created", table_name="workspace_requests", if_exists=True)
    op.drop_table("workspace_requests")
