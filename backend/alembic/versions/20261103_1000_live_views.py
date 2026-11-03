"""Views made from a query: their runtime state, and the ``link`` version source.

* ``view_membership_state``: how keeping one view made from a query in step with
  its data is going — status, the fence (``lease_*``, ``epoch``), scheduling
  (``due_at``) and the last answer. Runtime state only: a view's definition lives
  in its ``config.membership``, and its members are its own assignment entries.
* ``view_versions.source`` accepts ``'link'``: taking a linked layout's update into
  a view records a version of the view, as applying a template's update does.

``views`` and ``view_versions`` are busy tables, so the revision bounds its wait
for locks. Guarded DDL (a ``create_all`` baseline already has all of it).
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

_SOURCES = (
    "'baseline', 'create', 'wizard', 'import', 'restore', 'promote', 'export', "
    "'manual', 'snapshot', 'template'"
)
_STATUSES = (
    "'pending', 'updating', 'ok', 'partial', 'over_cap', 'held', 'failed', "
    "'paused', 'source_missing', 'frozen'"
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
            sa.Column("seen_signal", sa.Text(), nullable=True),
            sa.Column("read_in_token", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("status_detail", sa.Text(), nullable=True),
            sa.Column("dirty_since", sa.Text(), nullable=True),
            sa.Column("due_at", sa.Text(), nullable=True),
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
            sa.Column("pending_activity", sa.Text(), nullable=True),
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
        "idx_vms_due", "view_membership_state", ["due_at"],
        postgresql_where=sa.text("due_at IS NOT NULL"), sqlite_where=sa.text("due_at IS NOT NULL"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_vms_source", "view_membership_state", ["workspace_id", "data_source_id"],
        if_not_exists=True,
    )

    op.execute("ALTER TABLE view_versions DROP CONSTRAINT IF EXISTS ck_view_versions_source")
    op.create_check_constraint(
        "ck_view_versions_source", "view_versions", f"source IN ({_SOURCES}, 'link')",
    )


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    # Keep the history: a version taken from a linked layout reads as a wizard save.
    conn.execute(sa.text("UPDATE view_versions SET source = 'wizard' WHERE source = 'link'"))
    op.execute("ALTER TABLE view_versions DROP CONSTRAINT IF EXISTS ck_view_versions_source")
    op.create_check_constraint("ck_view_versions_source", "view_versions", f"source IN ({_SOURCES})")

    op.drop_index("idx_vms_source", table_name="view_membership_state", if_exists=True)
    op.drop_index("idx_vms_due", table_name="view_membership_state", if_exists=True)
    op.drop_table("view_membership_state", if_exists=True)
