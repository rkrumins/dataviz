"""``projection_state.window_rows``: the size of a window a pass stopped part-way through.

A large window (more than GRAPHVER_PROJECTION_PAGED_ABOVE version rows) is written a page at a
time, over passes of GRAPHVER_PROJECTION_PASS_MAX_SECS each. Between two of them the graph sat
idle, so with Graph residency on the capacity loop could evict it: its key lost the pages already
written and the version it served, and its reads went to Postgres until a load reseeded it, which
for such a graph takes hours. The pass that stops part-way now records the window's version rows
here and the pass that publishes clears it: eviction leaves the graph alone meanwhile, and the
planner keeps room on its master for what the rest of the window may add.

Nullable BIGINT with no default: a catalog change, with no rewrite. Every existing graph starts
NULL (no window in flight); a window in flight at the upgrade is marked when its next pass stops.
The ALTER is bounded like the others (``_bound_lock_wait``) and safe to re-run;
``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL``
alembic never reaches. The downgrade drops it: eviction may again take a graph between passes.

Revision ID: 20261113_1200_gv_ps_window_rows
Revises: 20261113_1100_build_policy
Create Date: 2026-11-13 12:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_window_rows_column

revision: str = "20261113_1200_gv_ps_window_rows"
down_revision: Union[str, None] = "20261113_1100_build_policy"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for ``projection_state``'s lock: every projection pass writes it,
    so a long holder makes the upgrade give up, to be run again, rather than queue them."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        return                              # create_schema_and_partitions builds it
    _bound_lock_wait()
    ensure_ps_window_rows_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."projection_state" '
                                  "DROP COLUMN IF EXISTS window_rows"))
