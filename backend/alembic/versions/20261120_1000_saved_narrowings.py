"""A view's saved narrowings, on the server.

Additive, schema-only. Creates ``view_saved_narrowings``: one row per
narrowing saved with a view — its seeds and reach, and the URNs it held when
saved (gzip) — for everyone who can open the view. The FK CASCADE drops a
deleted view's narrowings with it.

A new table only, so nothing busy is locked; the wait for locks is bounded
all the same. Guarded DDL (a ``create_all`` baseline already has all of it).
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).
The ORM (``ViewSavedNarrowingORM``) declares the same table.

Revision ID: 20261120_1000_saved_narrowings
Revises: 20261119_1500_merge_view_members
Create Date: 2026-11-20 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261120_1000_saved_narrowings"
down_revision: Union[str, None] = "20261119_1500_merge_view_members"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats
    queueing reads behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.create_table(
        "view_saved_narrowings",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("view_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("spec", sa.Text(), nullable=False),
        sa.Column("seeds_label", sa.Text(), nullable=True),
        sa.Column("seed_names", sa.Text(), nullable=True),
        sa.Column("counts", sa.Text(), nullable=True),
        sa.Column("truncated", sa.Text(), nullable=True),
        sa.Column("data_version", sa.Text(), nullable=True),
        sa.Column("held_count", sa.Integer(), nullable=False),
        sa.Column("held_complete", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("held", sa.LargeBinary(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["view_id"], ["views.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        if_not_exists=True,
    )
    op.create_index("idx_vsn_view", "view_saved_narrowings", ["view_id", "created_at"],
                    if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_index("idx_vsn_view", table_name="view_saved_narrowings", if_exists=True)
    op.drop_table("view_saved_narrowings", if_exists=True)
