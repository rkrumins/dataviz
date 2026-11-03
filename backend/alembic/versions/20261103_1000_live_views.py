"""Views made from a query: their runtime state.

``view_membership_state``: how keeping one view made from a query in step with its
data is going — status, the fence (``lease_*``, ``epoch``) and the last answer. A
view is brought up to date when it is opened after its data changed: there is no
schedule to keep. Runtime state only: a view's definition lives in its
``config.membership``, and its members are its own assignment entries.

Its foreign key locks ``views``, a busy table, so the revision bounds its wait for
locks. Guarded DDL (a ``create_all`` baseline already has all of it).
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261103_1000_live_views
Revises: 20261101_1000_gv_fork_sync
Create Date: 2026-11-03 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261103_1000_live_views"
down_revision: Union[str, None] = "20261101_1000_gv_fork_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_STATUSES = (
    "'pending', 'updating', 'ok', 'partial', 'over_cap', 'held', 'failed', "
    "'source_missing', 'frozen'"
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``views`` is read on every page,
    and giving up (to be run again) beats queueing every read behind a long
    transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()

    if not sa.inspect(bind).has_table("view_membership_state"):
        op.create_table(
            "view_membership_state",
            sa.Column("view_id", sa.Text(), sa.ForeignKey("views.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("data_source_id", sa.Text(), nullable=True),
            sa.Column("resolution_hash", sa.Text(), nullable=True),
            sa.Column("applied_resolution_hash", sa.Text(), nullable=True),
            sa.Column("data_version", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("status_detail", sa.Text(), nullable=True),
            sa.Column("lease_owner", sa.Text(), nullable=True),
            sa.Column("lease_until", sa.Text(), nullable=True),
            sa.Column("epoch", sa.Integer(), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("member_count", sa.Integer(), nullable=False),
            sa.Column("key_count", sa.Integer(), nullable=False),
            sa.Column("counts", sa.Text(), nullable=True),
            sa.Column("truncated", sa.Text(), nullable=True),
            sa.Column("last_diff", sa.Text(), nullable=True),
            sa.Column("held", sa.Text(), nullable=True),
            sa.Column("last_started_at", sa.Text(), nullable=True),
            sa.Column("last_finished_at", sa.Text(), nullable=True),
            sa.Column("last_applied_at", sa.Text(), nullable=True),
            sa.Column("last_read_at", sa.Text(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.CheckConstraint(f"status IN ({_STATUSES})", name="ck_vms_status"),
        )
    op.create_index(
        "idx_vms_source", "view_membership_state", ["workspace_id", "data_source_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_index("idx_vms_source", table_name="view_membership_state", if_exists=True)
    op.drop_table("view_membership_state", if_exists=True)
