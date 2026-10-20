"""Access after it is granted: reminders, extensions, request policy, access reviews.

* ``workspaces.request_policy`` — how a workspace takes requests: ``approval``
  (its approvers decide; the default), ``open`` (anyone may join as a Viewer
  at once, and anything more still needs approval) or ``closed`` (no
  requests; its admins add people).
* ``role_bindings.expiry_reminded_at`` — when the person was told their
  time-limited access is about to end, so they hear once per end date.
* ``access_requests.binding_id`` — a request to keep access that is about to
  end: it extends that grant. ``reminded_at`` / ``escalated_at`` — when the
  approvers were reminded of a request still waiting, and when it went to the
  Org Admins.
* ``access_reviews`` / ``access_review_items`` — a workspace admin's review of
  who holds access there: each grant kept or removed, by whom and when. One
  open review per workspace.

``role_bindings`` is read on every sign-in, so the revision bounds its wait
for locks. Guarded DDL: nullable columns, constant defaults and two empty
tables. Downgrade drops what this adds.

Revision ID: 20261019_1600_access_life
Revises: 20261019_1000_ws_access
Create Date: 2026-10-19 16:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261019_1600_access_life"
down_revision: Union[str, None] = "20261019_1000_ws_access"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_REQUEST_COLUMNS = ("binding_id", "reminded_at", "escalated_at")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``role_bindings`` is read on
    every sign-in, and giving up (to be run again) beats queueing sign-ins
    behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _swap_check(table: str, name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.create_check_constraint(name, table, condition)


def upgrade() -> None:
    _bound_lock_wait()

    op.add_column(
        "workspaces",
        sa.Column("request_policy", sa.Text(), nullable=False, server_default="approval"),
        if_not_exists=True,
    )
    _swap_check(
        "workspaces", "ck_workspaces_request_policy",
        "request_policy IN ('approval', 'open', 'closed')",
    )
    op.add_column(
        "role_bindings", sa.Column("expiry_reminded_at", sa.Text(), nullable=True), if_not_exists=True,
    )
    for column in _REQUEST_COLUMNS:
        op.add_column("access_requests", sa.Column(column, sa.Text(), nullable=True), if_not_exists=True)

    op.create_table(
        "access_reviews",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("started_by", sa.Text(), nullable=True),
        sa.Column("started_at", sa.Text(), nullable=False),
        sa.Column("due_at", sa.Text(), nullable=False),
        sa.Column("completed_at", sa.Text(), nullable=True),
        sa.Column("completed_by", sa.Text(), nullable=True),
        sa.Column("overdue_notified_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('open', 'completed', 'cancelled')", name="ck_access_reviews_status",
        ),
        if_not_exists=True,
    )
    op.create_index(
        "idx_access_reviews_workspace", "access_reviews", ["workspace_id", "started_at"],
        if_not_exists=True,
    )
    op.create_index(
        "uq_access_reviews_one_open", "access_reviews", ["workspace_id"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
        sqlite_where=sa.text("status = 'open'"),
        if_not_exists=True,
    )
    op.create_table(
        "access_review_items",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "review_id", sa.Text(),
            sa.ForeignKey("access_reviews.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("subject_type", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Text(), nullable=False),
        sa.Column("role_name", sa.Text(), nullable=False),
        sa.Column("binding_id", sa.Text(), nullable=True),
        sa.Column("origin", sa.Text(), nullable=True),
        sa.Column("granted_at", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.Text(), nullable=True),
        sa.Column("decision", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.Text(), nullable=True),
        sa.Column("decided_at", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "subject_type IN ('user', 'group')", name="ck_access_review_items_subject_type",
        ),
        sa.CheckConstraint(
            "decision IS NULL OR decision IN ('keep', 'remove')", name="ck_access_review_items_decision",
        ),
        if_not_exists=True,
    )
    op.create_index(
        "idx_access_review_items_review", "access_review_items", ["review_id"], if_not_exists=True,
    )


def downgrade() -> None:
    _bound_lock_wait()

    op.drop_index("idx_access_review_items_review", table_name="access_review_items", if_exists=True)
    op.drop_table("access_review_items", if_exists=True)
    op.drop_index("uq_access_reviews_one_open", table_name="access_reviews", if_exists=True)
    op.drop_index("idx_access_reviews_workspace", table_name="access_reviews", if_exists=True)
    op.drop_table("access_reviews", if_exists=True)
    for column in reversed(_REQUEST_COLUMNS):
        op.drop_column("access_requests", column)
    op.drop_column("role_bindings", "expiry_reminded_at")
    op.execute("ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS ck_workspaces_request_policy")
    op.drop_column("workspaces", "request_policy")
