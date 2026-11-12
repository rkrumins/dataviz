"""``projection_state.served_commit_seq``: the version of main a graph's FalkorDB key holds whole.

While the projection caught up after a publish or an import, or rebuilt the key, reads of main
went to Postgres, which composes the graph without its lineage summaries: the canvas drew the
items and almost none of the connections between them. Reads now stay on the key, at the version
it last published, while it catches up or rebuilds in place, and the view says it is being
updated. A rebuild resets the watermark to 0, so the version the key holds is kept here: set by
every pass that publishes, kept by a rebuild, cleared when the key is replaced, lost or evicted.

Nullable BIGINT with no default: a catalog change, with no rewrite. Every existing graph starts
NULL, and a key behind its head serves at its watermark until its next pass publishes. The ALTER
is bounded like the others (``_bound_lock_wait``) and safe to re-run;
``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL``
alembic never reaches. The downgrade drops it: reads then go to Postgres during a rebuild again.

Revision ID: 20261112_1700_gv_ps_served
Revises: 20261112_1600_import_settings
Create Date: 2026-11-12 17:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_served_column

revision: str = "20261112_1700_gv_ps_served"
down_revision: Union[str, None] = "20261112_1600_import_settings"
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
    ensure_ps_served_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."projection_state" '
                                  "DROP COLUMN IF EXISTS served_commit_seq"))
