"""New-version builds settings, on ``platform_settings``.

``gv_build_policy`` holds, as JSON, the values a system administrator saved under Admin →
Infrastructure → New-version builds (``versioning.build_policy``): when a graph's next version is
built beside the key that serves it, how much room a copy needs, what happens with no room, how
long the previous key stays, how the projector paces its writes, and the limits on reads from
Postgres — with who saved them and when. A value not in it takes the environment's default, so
nothing changes until an administrator saves one.

One nullable column, no rewrite. ``platform_settings`` is a single row the app reads often, so the
revision bounds its wait for locks. Guarded DDL, safe to re-run; the downgrade drops it, and every
value falls back to its default.

Revision ID: 20261113_1100_build_policy
Revises: 20261113_1000_gv_ps_served_fill
Create Date: 2026-11-13 11:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261113_1100_build_policy"
down_revision: Union[str, None] = "20261113_1000_gv_ps_served_fill"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "platform_settings"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing everything
    that reads the platform's settings behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.add_column(_TABLE, sa.Column("gv_build_policy", sa.Text(), nullable=True), if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS gv_build_policy")
