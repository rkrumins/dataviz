"""Per-user view visits — server-side "Continue where you left off".

Additive, schema-only. Creates ``view_visits``: one row per (user, view) whose
``visited_at`` is upserted on each open. Replaces a browser-local localStorage
list that didn't follow the user across devices, wasn't user-scoped (a second
user on a shared browser inherited the first user's recents), and cached stale
name snapshots. The FK CASCADE means a deleted view drops out of everyone's
recents for free.

Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).
The ORM (``ViewVisitORM``) declares the same table so create_all covers
fresh/test DBs; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260713_1000_view_visits"
down_revision: Union[str, None] = "20260712_1730_val_data_changed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "view_visits",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("view_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("visited_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["view_id"], ["views.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("view_id", "user_id", name="uq_view_user_visit"),
        if_not_exists=True,
    )
    op.create_index("idx_visits_user_time", "view_visits", ["user_id", "visited_at"], if_not_exists=True)
    op.create_index("idx_visits_view", "view_visits", ["view_id"], if_not_exists=True)


def downgrade() -> None:
    op.drop_index("idx_visits_view", table_name="view_visits", if_exists=True)
    op.drop_index("idx_visits_user_time", table_name="view_visits", if_exists=True)
    op.drop_table("view_visits", if_exists=True)
