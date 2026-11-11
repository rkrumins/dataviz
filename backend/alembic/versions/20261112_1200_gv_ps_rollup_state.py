"""``projection_state.rollup_state``: a lineage-summaries build the projector asked for and did not
get.

When a publish leaves the lineage summaries for the aggregation job to rebuild, the projector asks
for a job. One already running turned the ask away, and it was dropped: that job may have read the
graph before the publish, so the summaries could stay wrong until something else asked. The ask is
now kept here (``{pending, since, asked}``), and the projection worker's liveness loop asks again
until a job is queued.

Nullable JSONB with no default: a catalog change, with no rewrite. The ALTER is bounded like the
others (``_bound_lock_wait``) and safe to re-run; ``models._ensure_schema_upgrades`` mirrors it at
start-up for a separate ``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops it: an ask
still owed is made again by the next publish that hands the summaries over.

Revision ID: 20261112_1200_gv_ps_rollup_state
Revises: 20261112_1100_gv_rollup_deltas
Create Date: 2026-11-12 12:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_rollup_state_column

revision: str = "20261112_1200_gv_ps_rollup_state"
down_revision: Union[str, None] = "20261112_1100_gv_rollup_deltas"
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
    ensure_ps_rollup_state_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."projection_state" '
                                  "DROP COLUMN IF EXISTS rollup_state"))
