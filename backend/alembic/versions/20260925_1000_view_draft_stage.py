"""Views imported into a draft: staged for review before they go live.

Revision ID: 20260925_1000_view_draft_stage
Revises: 20260923_1000_view_versions
Create Date: 2026-09-25 10:00

An import can land on a draft of a version-controlled data source instead of going live at
once, and go live only when that draft is published or its review merges:

  * ``views.draft_branch_id``: a NEW view imported into a draft exists only there until then.
    Lists, counts and metrics leave such views out; abandoning the draft discards them.
  * ``view_layout_overlays`` gains what an imported UPDATE proposes beyond a layout: the rest of
    the design (``definition``) and the label (``label``: name, description, icon, tags, view
    type), each with the published value it replaces (``fork_base_*``) for the 3-way merge on
    publish, and ``staged_provenance``, the import's record for the view's history.

Fresh installs get all of it from ``0001_baseline``'s create_all and never run this file, so
the DDL is guarded (docs/MIGRATIONS.md). There is no data to move: every existing view is live
and every existing overlay only carries a layout.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260925_1000_view_draft_stage"
down_revision: Union[str, None] = "20260923_1000_view_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OVERLAY_COLUMNS = ("definition", "fork_base_definition", "label", "fork_base_label", "staged_provenance")


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE views ADD COLUMN IF NOT EXISTS draft_branch_id TEXT"))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS idx_view_draft_branch ON views (draft_branch_id)"))
    for column in _OVERLAY_COLUMNS:
        bind.execute(sa.text(f"ALTER TABLE view_layout_overlays ADD COLUMN IF NOT EXISTS {column} TEXT"))


def downgrade() -> None:
    bind = op.get_bind()
    # Without the column, a view still waiting in a draft would go live unreviewed. It goes to
    # the trash instead, where it can still be restored by hand.
    bind.execute(
        sa.text("UPDATE views SET deleted_at = :now WHERE draft_branch_id IS NOT NULL AND deleted_at IS NULL"),
        {"now": datetime.now(timezone.utc).isoformat()},
    )
    for column in _OVERLAY_COLUMNS:
        op.drop_column("view_layout_overlays", column)
    op.drop_index("idx_view_draft_branch", table_name="views")
    op.drop_column("views", "draft_branch_id")
