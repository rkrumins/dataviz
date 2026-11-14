"""``projection_state``'s build columns: a new version built beside the key that serves.

A graph whose read mode is ``beside`` (Keep serving, switch when ready) has a large change built in
a second key while the current one keeps serving its version whole, then switches its readers in
one step:

* ``candidate_graph_name`` / ``candidate_provider`` — the build's key, on the serving key's node;
* ``candidate_seq`` — the version that key holds whole (NULL until written);
* ``candidate_state`` — where the build is: its id, why it was asked for, its step, attempts, last
  error and when it may try again.

All NULL, every existing graph: no build, and every pass behaves as before. Nullable with no
default: a catalog change, with no rewrite, bounded like the others and safe to re-run;
``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL``. The
downgrade drops them; a build in flight is then forgotten, and its key is left for the operator.

Revision ID: 20261113_1400_gv_ps_candidate
Revises: 20261113_1300_gv_ps_read_mode
Create Date: 2026-11-13 14:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_candidate_columns

revision: str = "20261113_1400_gv_ps_candidate"
down_revision: Union[str, None] = "20261113_1300_gv_ps_read_mode"
branch_labels = None
depends_on = None

_COLUMNS = ("candidate_state", "candidate_seq", "candidate_provider", "candidate_graph_name")


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
    ensure_ps_candidate_columns(bind)


def downgrade() -> None:
    _bound_lock_wait()
    ps = f'"{gv_config.graphver_schema()}"."projection_state"'
    for column in _COLUMNS:
        op.get_bind().execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS {column}"))
