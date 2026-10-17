"""``projection_state``: the projection fencing token and the retry backoff.

``epoch`` fences a projection pass: the pass claims the row by bumping it and writes its watermark
only while the epoch is still its own, and evict, rebuild, repin and the bootstrap head flip bump
it, so a pass they overtook cannot write over them. ``failed_attempts`` and ``next_retry_at`` back
off the poll's retries of a pass that failed. Three ``ADD COLUMN IF NOT EXISTS`` with constant
defaults: catalog-only, no rewrite, on a table with one row per graph; the wait for its lock is
bounded (``_bound_lock_wait``), and the upgrade is safe to re-run.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_fencing_columns

revision: str = "20261017_1550_gv_ps_fencing"
down_revision: Union[str, None] = "20261017_1500_gv_ps_keys"
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
    ensure_ps_fencing_columns(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("projection_state", schema=schema):
        return
    for column in ("next_retry_at", "failed_attempts", "epoch"):
        bind.execute(sa.text(
            f'ALTER TABLE "{schema}"."projection_state" DROP COLUMN IF EXISTS {column}'))
