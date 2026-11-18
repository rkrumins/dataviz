"""Fill ``projection_state.served_commit_seq`` for graphs that last published before it existed.

The column records the version of main a graph's FalkorDB key holds whole, so reads stay on the key
while it rebuilds. It was added NULL for every existing graph, and a rebuild of one of those (its
watermark at 0) sent reads of main to Postgres for the whole rebuild: on a large graph, no reads at
all. Each pinned key whose status serves a version takes its watermark, the version its last pass
published. A row already at 0 is restored by the projector from the key's marker.

One UPDATE, bounded like the others (``_bound_lock_wait``) and safe to re-run;
``models._ensure_schema_upgrades`` repeats it at start-up for a separate ``GRAPHVER_DB_URL`` alembic
never reaches. The downgrade changes nothing: the values are true either way.

Revision ID: 20261113_1000_gv_ps_served_fill
Revises: 20261113_0900_gv_import_mentions
Create Date: 2026-11-13 10:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import backfill_ps_served

revision: str = "20261113_1000_gv_ps_served_fill"
down_revision: Union[str, None] = "20261113_0900_gv_import_mentions"
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
    backfill_ps_served(bind)


def downgrade() -> None:
    pass
