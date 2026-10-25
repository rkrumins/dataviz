"""Service accounts an administrator disabled stay disabled until one enables them.

* ``service_accounts.admin_hold`` — set when someone holding
  ``system:service-accounts:manage`` disables an account; while it is set,
  the account's managers can't enable it. Accounts disabled before this
  revision were all disabled by such an administrator, so each one starts
  held.

``service_accounts`` is read whenever a service account's key is used, so the
revision bounds its wait for locks. Guarded DDL: a column with a constant
default, and an update of the few disabled accounts. Downgrade drops the
column.

Revision ID: 20261025_1200_sa_admin_hold
Revises: 20261023_1200_service_accounts
Create Date: 2026-10-25 12:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261025_1200_sa_admin_hold"
down_revision: Union[str, None] = "20261023_1200_service_accounts"
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
        "service_accounts",
        sa.Column("admin_hold", sa.Boolean(), nullable=False, server_default=sa.false()),
        if_not_exists=True,
    )
    op.execute(
        "UPDATE service_accounts SET admin_hold = true WHERE user_id IN "
        "(SELECT id FROM users WHERE status <> 'active')"
    )


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_column("service_accounts", "admin_hold")
