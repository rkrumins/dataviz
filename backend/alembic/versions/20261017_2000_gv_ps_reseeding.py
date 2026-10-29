"""``projection_state``: the ``reseeding`` status.

The operator's watermark reset (``POST /admin/versioning/watermarks/reset``, after a FalkorDB
restore) used to mark each graph it reset with a ``last_error`` sentinel, so every reset graph read
as failed until the projector reseeded it. It now sets ``status = 'reseeding'`` instead, and
``ck_proj_status`` must allow it. The check is rebuilt once, on a table with one row per graph; the
wait for its lock is bounded (``_bound_lock_wait``), and the upgrade is safe to re-run.

The downgrade turns ``reseeding`` rows back to ``idle``: their watermark is 0, so the poll still
reseeds them.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_reseeding_status

revision: str = "20261017_2000_gv_ps_reseeding"
down_revision: Union[str, None] = "20261017_1950_gv_ingest_active"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every projection pass writes
    ``projection_state``, so a long holder makes the upgrade give up, to be run again, rather
    than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ps_reseeding_status(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("projection_state", schema=schema):
        return
    ps = f'"{schema}"."projection_state"'
    bind.execute(sa.text(f"UPDATE {ps} SET status = 'idle' WHERE status = 'reseeding'"))
    bind.execute(sa.text(f"ALTER TABLE {ps} DROP CONSTRAINT IF EXISTS ck_proj_status"))
    bind.execute(sa.text(
        f"ALTER TABLE {ps} ADD CONSTRAINT ck_proj_status "
        "CHECK (status IN ('idle','projecting','rebuilding','evicted'))"))
