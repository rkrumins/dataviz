"""A person's saved Explorer filters, on the server.

Additive, schema-only. Creates ``saved_view_filters``: one row per named filter
set a person keeps in the Explorer, in their own order — on the server, so the
filters follow the person to any browser. ``query`` is the Explorer's address
query as the client wrote it, never parsed here.
``user_id`` has no FK: users belong to the identity domain
(DOMAIN_OWNERSHIP.md), and a filter set is only ever read by its owner's id.

Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).
The ORM (``SavedViewFilterORM``) declares the same table, so a database
installed at head already has it from 0001_baseline's create_all — hence the
guarded DDL; this migration covers existing Postgres.

Revision ID: 20261013_0116_saved_filters
Revises: 20261008_1200_import_rows_idx
Create Date: 2026-10-13 01:16:12.676178+00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261013_0116_saved_filters"
down_revision: Union[str, None] = "20261008_1200_import_rows_idx"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saved_view_filters",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_saved_view_filters_user_name"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_saved_view_filters_user_pos", "saved_view_filters", ["user_id", "position"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_saved_view_filters_user_pos", table_name="saved_view_filters", if_exists=True,
    )
    op.drop_table("saved_view_filters", if_exists=True)
