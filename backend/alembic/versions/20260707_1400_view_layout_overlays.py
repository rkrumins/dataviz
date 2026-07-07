"""Branch-scoped view layout: per-(view, branch) overlay storage.

Additive, schema-only. Creates ``view_layout_overlays`` — one row per
(view_id, branch_id) holding a draft branch's effective bare referenceLayout +
entityScope, plus a fork-point snapshot of the published base — so a draft's
layout edits stay off the published ``views.config`` until they are promoted
(merge/publish). No data backfill: existing ``views.config.layout`` remains the
published base; overlay rows are created lazily when a draft first edits layout.

The ORM (``backend.app.db.models.ViewLayoutOverlayORM``) declares the same table
so ``create_all`` covers fresh/test databases; this migration covers existing
Postgres. ``downgrade`` drops the table.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260707_1400_view_layout_overlays"
down_revision: Union[str, None] = "20260707_1200_view_layout_merge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_layout_overlays",
        sa.Column("view_id", sa.Text(), nullable=False),
        sa.Column("branch_id", sa.Text(), nullable=False),
        sa.Column("reference_layout", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("entity_scope", sa.Text(), nullable=True),
        sa.Column("fork_base_layout", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("fork_base_entity_scope", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["view_id"], ["views.id"], ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("view_id", "branch_id"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_vlo_branch",
        "view_layout_overlays",
        ["branch_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_vlo_branch", table_name="view_layout_overlays", if_exists=True,
    )
    op.drop_table("view_layout_overlays", if_exists=True)
