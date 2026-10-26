"""Who may create a service account for themselves, and how many each.

* ``platform_settings.sa_who_may_create`` — ``central`` (the administrators of
  service accounts only), ``granters`` (anyone who lets people into a
  workspace) or ``everyone`` (any active person). Unset is ``central``: as
  before this revision, only the administrators create them.
* ``platform_settings.sa_per_person_limit`` — how many live service accounts
  one person may have created for themselves. Unset is 10.
* ``platform_settings.sa_require_team_manager`` — whether an account someone
  creates for themselves is managed by a team they are in, rather than by
  them. Unset is no.

``platform_settings`` is a single row the app reads often, so the revision
bounds its wait for locks. Guarded DDL: nullable columns. Downgrade drops
them.

Revision ID: 20261026_1000_sa_policy
Revises: 20261025_1600_sa_purge
Create Date: 2026-10-26 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261026_1000_sa_policy"
down_revision: Union[str, None] = "20261025_1600_sa_purge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("sa_who_may_create", sa.Text()),
    ("sa_per_person_limit", sa.Integer()),
    ("sa_require_team_manager", sa.Boolean()),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again)
    beats queueing everything that reads the platform's settings behind a
    long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    for name, kind in _COLUMNS:
        op.add_column("platform_settings", sa.Column(name, kind, nullable=True), if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    for name, _kind in reversed(_COLUMNS):
        op.drop_column("platform_settings", name)
