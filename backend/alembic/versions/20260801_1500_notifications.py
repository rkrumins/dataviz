"""In-app notifications.

Revision ID: 20260801_1500_notifications
Revises: 20260801_1200_publish_flow
Create Date: 2026-08-01 15:00

Every sharing flow in this product ended in silence. A view is shared
with you, your publication request is approved, an admin is waiting on
your answer — each was recorded faithfully on a timeline nobody thinks
to open. Sharing is only as good as the moment someone learns they were
shared with, so those moments get a table and a bell.

Rows are written in the same transaction as the event they describe
(see ``notification_repo.notify``), not derived by a relay: an
eventually-consistent fan-out that can lag or drop turns "you have
access" into "you have access and nobody told you". The outbox keeps
carrying the same events for external consumers.

Plain forward DDL per docs/MIGRATIONS.md.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260801_1500_notifications"
down_revision: Union[str, None] = "20260801_1200_publish_flow"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("link", sa.Text(), nullable=True),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("resource_type", sa.Text(), nullable=True),
        sa.Column("resource_id", sa.Text(), nullable=True),
        sa.Column("read_at", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_notifications_user_created", "notifications", ["user_id", "created_at"],
    )
    op.create_index(
        "idx_notifications_unread", "notifications", ["user_id", "read_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_notifications_unread", table_name="notifications")
    op.drop_index("idx_notifications_user_created", table_name="notifications")
    op.drop_table("notifications")
