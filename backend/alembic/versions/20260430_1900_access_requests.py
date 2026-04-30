"""RBAC Phase 4.3 — access_requests table.

Revision ID: 20260430_1900_access_requests
Revises: 20260430_1700_perm_descs
Create Date: 2026-04-30 19:00

Adds the ``access_requests`` table that backs the smart-403 +
self-service request workflow shipped in Phase 4.3. Users can ask a
workspace admin for access to a workspace at a specific role; the
admin sees a per-workspace inbox and can Approve (atomically creating
a binding) or Deny.

The state machine (``pending → approved | denied``) is real domain
data, not just an event log, so it gets its own table — outbox events
are emitted on every transition for downstream SIEM relay but are
NOT the source of truth.

Two indexes back the hot read paths:

  * ``idx_access_requests_target_status`` — admin inbox query
    ``WHERE target_type=… AND target_id=… AND status='pending'``.
  * ``idx_access_requests_requester_status`` — "my pending requests"
    section on the self-service page.

Idempotent: skip-if-exists on both the table and the indexes so a
half-applied migration can be replayed safely.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260430_1900_access_requests"
down_revision: Union[str, None] = "20260430_1700_perm_descs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _has_index(inspector, table: str, index_name: str) -> bool:
    if not _has_table(inspector, table):
        return False
    return any(idx["name"] == index_name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "access_requests"):
        op.create_table(
            "access_requests",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("requester_id", sa.Text(), nullable=False),
            sa.Column("target_type", sa.Text(), nullable=False),
            sa.Column("target_id", sa.Text(), nullable=False),
            sa.Column("requested_role", sa.Text(), nullable=False),
            sa.Column("justification", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "target_type IN ('workspace')",
                name="ck_access_requests_target_type",
            ),
            sa.CheckConstraint(
                "status IN ('pending', 'approved', 'denied')",
                name="ck_access_requests_status",
            ),
            sa.CheckConstraint(
                "(status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) "
                "OR (status IN ('approved', 'denied') AND resolved_at IS NOT NULL)",
                name="ck_access_requests_state_consistency",
            ),
        )

    inspector = sa.inspect(bind)
    if not _has_index(inspector, "access_requests", "idx_access_requests_target_status"):
        op.create_index(
            "idx_access_requests_target_status",
            "access_requests",
            ["target_type", "target_id", "status"],
        )
    if not _has_index(inspector, "access_requests", "idx_access_requests_requester_status"):
        op.create_index(
            "idx_access_requests_requester_status",
            "access_requests",
            ["requester_id", "status"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_index(inspector, "access_requests", "idx_access_requests_requester_status"):
        op.drop_index("idx_access_requests_requester_status", table_name="access_requests")
    if _has_index(inspector, "access_requests", "idx_access_requests_target_status"):
        op.drop_index("idx_access_requests_target_status", table_name="access_requests")
    if _has_table(inspector, "access_requests"):
        op.drop_table("access_requests")
