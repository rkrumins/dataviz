"""``projection_state.read_mode``: what a graph's readers get while its next version lands.

Availability against consistency, chosen by a system administrator, for the platform (New-version
builds' ``readMode``, on ``platform_settings.gv_build_policy``) and, here, for one graph:

* ``latest`` — always the newest published version: reads of main go to Postgres until FalkorDB
  holds it (the behaviour before reads were kept on FalkorDB while it caught up);
* ``in_place`` — the version FalkorDB last finished, while the next is written into the same key;
* ``beside`` — exactly that version, while the next is built in a second key, then one switch.

NULL, every existing graph, takes the platform's, ``in_place`` by default: nothing changes until an
administrator chooses. Nullable TEXT with a check (``ck_ps_read_mode``), no default: a catalog
change, with no rewrite, bounded like the others and safe to re-run;
``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL``. The
downgrade drops it, and every graph reads by the platform's mode.

Revision ID: 20261113_1300_gv_ps_read_mode
Revises: 20261113_1200_gv_ps_window_rows
Create Date: 2026-11-13 13:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_read_mode_column

revision: str = "20261113_1300_gv_ps_read_mode"
down_revision: Union[str, None] = "20261113_1200_gv_ps_window_rows"
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
    ensure_ps_read_mode_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    ps = f'"{gv_config.graphver_schema()}"."projection_state"'
    op.get_bind().execute(sa.text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_ps_read_mode"))
    op.get_bind().execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS read_mode"))
