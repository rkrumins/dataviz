"""Access requests for service accounts: who asked for one.

* ``access_requests.requested_by`` — on a request for a service account, the
  person who asked for it, one of its managers. ``requester_id`` stays the
  one the request grants to — the account — so lists, answers, end dates and
  notices work as they do for a person.

``access_requests`` is read while people answer requests, so the revision
bounds its wait for locks. Guarded DDL: a nullable column. Downgrade drops it.

Revision ID: 20261025_1400_sa_requests
Revises: 20261025_1200_sa_admin_hold
Create Date: 2026-10-25 14:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261025_1400_sa_requests"
down_revision: Union[str, None] = "20261025_1200_sa_admin_hold"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again)
    beats queueing the requests people are answering behind a long
    transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.add_column(
        "access_requests", sa.Column("requested_by", sa.Text(), nullable=True), if_not_exists=True,
    )


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_column("access_requests", "requested_by")
