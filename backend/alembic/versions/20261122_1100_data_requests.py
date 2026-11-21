"""Data requests: asking for data to be connected to a workspace.

* ``data_requests`` — one row per ask: the workspace it is for, who asked, where the
  data lives (``system``), what of it (``details``), why (``purpose``), by when
  (``urgency``) and who knows it (``contact_ids``, a JSON list); where it stands
  (``pending``, ``in_progress`` once someone takes it, ``connected``, ``declined``,
  ``withdrawn``) and, once connected, the data source it became. No foreign keys:
  the workspace, people and the source are named by id.

Fresh installs get the table from ``0001_baseline``'s create_all and never run this
file, so the DDL is guarded. Revision id is kept <=32 chars
(alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261122_1100_data_requests
Revises: 20261122_1000_workspace_groups
Create Date: 2026-11-22 11:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261122_1100_data_requests"
down_revision: Union[str, None] = "20261122_1000_workspace_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STATE = (
    "(status = 'pending' AND resolved_at IS NULL) "
    "OR (status = 'in_progress' AND resolved_at IS NULL AND assignee_id IS NOT NULL) "
    "OR (status IN ('connected', 'declined', 'withdrawn') AND resolved_at IS NOT NULL)"
)


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")

    if not sa.inspect(bind).has_table("data_requests"):
        op.create_table(
            "data_requests",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("requested_by", sa.Text(), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("system", sa.Text(), nullable=False),
            sa.Column("details", sa.Text(), nullable=True),
            sa.Column("purpose", sa.Text(), nullable=True),
            sa.Column("urgency", sa.Text(), nullable=False),
            sa.Column("contact_ids", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("assignee_id", sa.Text(), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.Column("data_source_id", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "system IN ('snowflake', 'databricks', 'bigquery', 'postgres', 'dbt', 'datahub', "
                "'neo4j', 'file', 'other')",
                name="ck_data_requests_system",
            ),
            sa.CheckConstraint(
                "urgency IN ('no_rush', 'this_month', 'this_week')",
                name="ck_data_requests_urgency",
            ),
            sa.CheckConstraint(
                "status IN ('pending', 'in_progress', 'connected', 'declined', 'withdrawn')",
                name="ck_data_requests_status",
            ),
            sa.CheckConstraint(_STATE, name="ck_data_requests_state_consistency"),
        )
    op.create_index(
        "idx_data_requests_workspace_created", "data_requests", ["workspace_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_data_requests_status_created", "data_requests", ["status", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_data_requests_requester", "data_requests", ["requested_by", "created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_data_requests_requester", table_name="data_requests", if_exists=True)
    op.drop_index("idx_data_requests_status_created", table_name="data_requests", if_exists=True)
    op.drop_index("idx_data_requests_workspace_created", table_name="data_requests", if_exists=True)
    op.drop_table("data_requests")
