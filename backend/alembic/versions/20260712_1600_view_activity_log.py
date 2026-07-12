"""Per-view activity log: durable timeline of view changes.

Additive, schema-only. Creates ``view_activity_log`` — one immutable row per
view mutation (created, updated, visibility_changed, shared, unshared,
favourited, unfavourited, deleted, restored) with the actor and a human
summary / JSON diff. This is the source of truth for the per-view activity
timeline UI; each mutation ALSO emits a ``visualization.view.<action>`` outbox
event, but the timeline reads only this table (decoupled from the relay).

The ORM (``backend.app.db.models.ViewActivityLogORM``) declares the same table
so ``create_all`` covers fresh/test databases; this migration covers existing
Postgres. No backfill — legacy views synthesize a 'created' anchor at read
time from their own stamps. ``downgrade`` drops the table.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260712_1600_view_activity_log"
down_revision: Union[str, None] = "20260711_1200_agg_job_guards"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_activity_log",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("view_id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("actor", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("changes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "action IN ('created', 'updated', 'visibility_changed', 'shared', "
            "'unshared', 'favourited', 'unfavourited', 'deleted', 'restored')",
            name="ck_val_action_enum",
        ),
        if_not_exists=True,
    )
    op.create_index("idx_val_view", "view_activity_log", ["view_id"], if_not_exists=True)
    op.create_index("idx_val_view_created", "view_activity_log", ["view_id", "created_at"], if_not_exists=True)
    op.create_index("idx_val_created", "view_activity_log", ["created_at"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index("idx_val_created", table_name="view_activity_log", if_exists=True)
    op.drop_index("idx_val_view_created", table_name="view_activity_log", if_exists=True)
    op.drop_index("idx_val_view", table_name="view_activity_log", if_exists=True)
    op.drop_table("view_activity_log", if_exists=True)
