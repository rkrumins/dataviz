"""Drift found in a data source's own graph under version control (projection_state.drift).

When version control is on for an external graph, the graph stays the customer's and something
other than the platform can still write to it. Each projection pass counts what it holds that the
history doesn't track (written outside the history; nodes without an identifier) and records it
here, so it can be reported instead of holding reads back. NULL for a graph the platform owns.
The ORM (``versioning/models.py``) carries the same column for fresh DBs, and
``_ensure_schema_upgrades`` adds it to a separately hosted store.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261027_1200_projection_drift"
down_revision: Union[str, None] = "20261024_1000_native_query"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``projection_state`` is read on every versioned
    read, and giving up (to be run again) beats queueing them."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    tbl = f'"{gv_config.graphver_schema()}"."projection_state"'
    bind.execute(sa.text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS drift jsonb"))


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    tbl = f'"{gv_config.graphver_schema()}"."projection_state"'
    bind.execute(sa.text(f"ALTER TABLE {tbl} DROP COLUMN IF EXISTS drift"))
