"""Drafts and reviews policy: a workspace's, and a data source's override of it.

On both ``workspaces`` and ``workspace_data_sources``, four nullable columns:

* ``draft_default_visibility`` — ``public`` or ``private``: the level a new draft starts at;
* ``draft_levels`` — ``any``, ``public_only`` or ``private_only``: the levels a new draft may have
  (drafts that already exist keep theirs);
* ``review_self_approval`` — whether the person who opened a review may approve it;
* ``review_self_merge`` — whether they may merge it, and publish a draft without one.

NULL is "not set": a data source falls through to its workspace, and a workspace to the built-in
default (public, any, allowed, allowed), resolved by ``backend.app.services.drafts_policy``. Both
tables are read by most requests, so the revision bounds its wait for locks. Guarded DDL; the
checks are swapped in. Downgrade drops the checks and the columns.

Revision ID: 20261029_1100_drafts_policy
Revises: 20261029_1000_gv_branch_vis
Create Date: 2026-10-29 11:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261029_1100_drafts_policy"
down_revision: Union[str, None] = "20261029_1000_gv_branch_vis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: (table, the prefix its check constraints carry)
_TABLES = (("workspaces", "workspaces"), ("workspace_data_sources", "ds"))
_COLUMNS = (
    ("draft_default_visibility", sa.Text()),
    ("draft_levels", sa.Text()),
    ("review_self_approval", sa.Boolean()),
    ("review_self_merge", sa.Boolean()),
)
_CHECKS = {
    "draft_visibility":
        "draft_default_visibility IS NULL OR draft_default_visibility IN ('public', 'private')",
    "draft_levels":
        "draft_levels IS NULL OR draft_levels IN ('any', 'public_only', 'private_only')",
}


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    request that reads a workspace or a data source behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _swap_check(table: str, name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.create_check_constraint(name, table, condition)


def upgrade() -> None:
    _bound_lock_wait()
    for table, prefix in _TABLES:
        for name, kind in _COLUMNS:
            op.add_column(table, sa.Column(name, kind, nullable=True), if_not_exists=True)
        for suffix, condition in _CHECKS.items():
            _swap_check(table, f"ck_{prefix}_{suffix}", condition)


def downgrade() -> None:
    _bound_lock_wait()
    for table, prefix in _TABLES:
        for suffix in _CHECKS:
            op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{prefix}_{suffix}")
        for name, _kind in reversed(_COLUMNS):
            op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {name}")
