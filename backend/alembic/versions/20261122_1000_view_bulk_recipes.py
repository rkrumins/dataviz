"""A view's bulk recipes: bulk property changes kept under a name in its library.

Additive, schema-only. Creates ``view_bulk_recipes``: one row per recipe — an operation and the
entities it reaches, named as the bulk dialog names them (the view, a key, a layer, a
predicate), never by id — for everyone who can open the view, to run again. The FK CASCADE
drops a deleted view's recipes with it.

The foreign key locks ``views``, read on every page, so the wait for it is bounded. Guarded DDL:
a ``create_all`` baseline already has the table, and running this again changes nothing.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)). The ORM
(``ViewBulkRecipeORM``) declares the same table so create_all covers fresh/test DBs; this
migration covers existing Postgres.

Revision ID: 20261122_1000_view_bulk_recipes
Revises: 20261121_1000_gv_property_jobs
Create Date: 2026-11-22 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261122_1000_view_bulk_recipes"
down_revision: Union[str, None] = "20261121_1000_gv_property_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    if not sa.inspect(op.get_bind()).has_table("view_bulk_recipes"):
        op.create_table(
            "view_bulk_recipes",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("view_id", sa.Text(), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("recipe", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_by", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.ForeignKeyConstraint(["view_id"], ["views.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
    op.create_index("idx_vbr_view", "view_bulk_recipes", ["view_id", "position"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index("idx_vbr_view", table_name="view_bulk_recipes", if_exists=True)
    op.drop_table("view_bulk_recipes", if_exists=True)
