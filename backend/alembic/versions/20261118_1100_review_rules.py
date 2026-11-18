"""Reviews policy: how many approvals a review needs, and whether open threads hold its merge.

On both ``workspaces`` and ``workspace_data_sources``, two nullable columns:

* ``review_required_approvals`` — 0 to 10: 0, everyone asked must approve (a review asking no one
  needs no approval); N, at least N approvals that stand, from anyone who may approve;
* ``review_threads_hold`` — whether a review with open threads waits for them to be resolved.

NULL is "not set": a data source falls through to its workspace, and a workspace to the built-in
default (0, no), resolved by ``backend.app.services.drafts_policy``. Both tables are read by most
requests, so the revision bounds its wait for locks. Downgrade drops the checks and the columns.

Revision ID: 20261118_1100_review_rules
Revises: 20261118_1000_gv_review_records
Create Date: 2026-11-18 11:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261118_1100_review_rules"
down_revision: Union[str, None] = "20261118_1000_gv_review_records"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = (("workspaces", "workspaces"), ("workspace_data_sources", "ds"))
_COLUMNS = (("review_required_approvals", sa.Integer()), ("review_threads_hold", sa.Boolean()))
_CHECK = "review_required_approvals IS NULL OR review_required_approvals BETWEEN 0 AND 10"


def _bound_lock_wait() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    for table, prefix in _TABLES:
        for name, kind in _COLUMNS:
            op.add_column(table, sa.Column(name, kind, nullable=True), if_not_exists=True)
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{prefix}_required_approvals")
        op.create_check_constraint(f"ck_{prefix}_required_approvals", table, _CHECK)


def downgrade() -> None:
    _bound_lock_wait()
    for table, prefix in _TABLES:
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{prefix}_required_approvals")
        for name, _kind in reversed(_COLUMNS):
            op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {name}")
