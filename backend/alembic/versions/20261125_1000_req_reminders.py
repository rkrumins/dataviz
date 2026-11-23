"""Data requests and identity-provider link requests left waiting are brought up again.

On ``data_requests`` and ``idp_link_requests``, two nullable columns each: ``reminded_at``
and ``escalated_at``, when a request still waiting was brought up again and then taken
further (``access_housekeeping``). NULL is "not yet". Each is set once.

No new index: the sweep reads open requests oldest first, which
``idx_data_requests_status_created`` and ``idx_idp_link_requests_status`` already serve.

Both tables are read on request paths, so the revision bounds its wait for locks. Guarded
DDL (``if_not_exists``; a brand-new environment's ``0001_baseline`` create_all()s the current
ORM). Downgrade drops the columns.

Revision ID: 20261125_1000_req_reminders
Revises: 20261124_1100_aal_ds_type
Create Date: 2026-11-25 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261125_1000_req_reminders"
down_revision: Union[str, None] = "20261124_1100_aal_ds_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("data_requests", "idp_link_requests")
_COLUMNS = ("reminded_at", "escalated_at")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing every
    request that reads these tables behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    for table in _TABLES:
        for name in _COLUMNS:
            op.add_column(table, sa.Column(name, sa.Text(), nullable=True), if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    for table in _TABLES:
        for name in reversed(_COLUMNS):
            op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {name}")
