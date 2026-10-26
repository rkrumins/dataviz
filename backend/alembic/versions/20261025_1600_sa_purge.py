"""Deleted service accounts are purged after 30 days.

* ``service_accounts.purged_at`` — when the hourly pass purged an account
  deleted 30 days before: its keys revoked, its roles and managers removed.
  The account's rows stay, so the activity log still names it. Until then a
  deleted account can be restored with everything as it was.

``service_accounts`` is read whenever a service account's key is used, so the
revision bounds its wait for locks. Guarded DDL: a nullable column. Downgrade
drops it.

Revision ID: 20261025_1600_sa_purge
Revises: 20261025_1400_sa_requests
Create Date: 2026-10-25 16:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261025_1600_sa_purge"
down_revision: Union[str, None] = "20261025_1400_sa_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``service_accounts`` is read on
    every request a service account's key makes, and giving up (to be run
    again) beats queueing them behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.add_column(
        "service_accounts", sa.Column("purged_at", sa.Text(), nullable=True), if_not_exists=True,
    )


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_column("service_accounts", "purged_at")
