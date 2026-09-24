"""A view's saved queries, on the server — its library's second half.

Additive, schema-only. Creates ``view_saved_queries``: one row per search kept
under a name in a view's library, for everyone who can open the view. Saved
queries lived only in one browser's localStorage, so a teammate never saw
them and a new device lost them. The FK CASCADE drops a deleted view's
queries with it. (The library's display rules stay in the view's
``referenceLayout`` and in its drafts' layout overlays — branch-scoped as the
layout is — so they need no table.)

Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).
The ORM (``ViewSavedQueryORM``) declares the same table so create_all covers
fresh/test DBs; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260925_1000_view_saved_queries"
down_revision: Union[str, None] = "20260920_1200_view_entity_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_saved_queries",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("view_id", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("predicate", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["view_id"], ["views.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        if_not_exists=True,
    )
    op.create_index("idx_vsq_view", "view_saved_queries", ["view_id", "position"],
                    if_not_exists=True)


def downgrade() -> None:
    op.drop_index("idx_vsq_view", table_name="view_saved_queries", if_exists=True)
    op.drop_table("view_saved_queries", if_exists=True)
