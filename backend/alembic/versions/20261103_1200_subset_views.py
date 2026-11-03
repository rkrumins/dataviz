"""Subset views: which view each one is a subset of.

A subset view (``config.search``) shows the matches of a search inside another
view, its base. ``views.subset_of`` names that base, set when the subset is made
and never by a client: it is how a base finds its subsets — to list them, and to
say how many a change to its layers or its deletion reaches — without reading
every view's config. A logical reference, like ``draft_branch_id``: a base is
soft-deleted and may be restored, and its subsets wait for it meanwhile.

Fresh installs get the column from ``0001_baseline``'s create_all, so the DDL is
guarded (docs/MIGRATIONS.md). ``views`` is read on every page, so the revision
bounds its wait for locks. Every existing view is a subset of nothing: no data
to move.

Revision ID: 20261103_1200_subset_views
Revises: 20261103_1000_live_views
Create Date: 2026-11-03 12:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261103_1200_subset_views"
down_revision: Union[str, None] = "20261103_1000_live_views"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    bind.execute(sa.text("ALTER TABLE views ADD COLUMN IF NOT EXISTS subset_of TEXT"))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_view_subset_of ON views (subset_of) WHERE subset_of IS NOT NULL"))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    # The views stay subset views (their config says so); only the index of them goes.
    op.drop_index("idx_view_subset_of", table_name="views", if_exists=True)
    op.drop_column("views", "subset_of")
