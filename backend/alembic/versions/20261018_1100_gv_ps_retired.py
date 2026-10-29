"""``projection_state.retired_keys``: a moved graph's old keys.

``[{name, provider, retireAfter, afterSeq, movedBy}]``. Moving a versioned graph's projection to
another platform key (doc 14 §6 KeyMigration, phase 1) leaves the old key in place until the new one
has caught up and a grace period has passed, so a move back can reconcile into it in place. One
nullable ``ADD COLUMN IF NOT EXISTS``: catalog-only, no rewrite; the wait for the table's lock is
bounded (``_bound_lock_wait``), and the upgrade is safe to re-run.

The downgrade drops the column, and with it the keys still waiting: they are no longer dropped
for you, so it logs how many graphs had any.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

import logging
from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_retired_keys_column

revision: str = "20261018_1100_gv_ps_retired"
down_revision: Union[str, None] = "20261018_1000_gv_mr_approvals"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every projection pass writes
    ``projection_state``, so a long holder makes the upgrade give up, to be run again, rather
    than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_ps_retired_keys_column(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    inspector = sa.inspect(bind)
    if not inspector.has_table("projection_state", schema=schema):
        return
    ps = f'"{schema}"."projection_state"'
    if "retired_keys" in {c["name"] for c in inspector.get_columns("projection_state", schema=schema)}:
        waiting = bind.execute(sa.text(
            f"SELECT count(*) FROM {ps} WHERE retired_keys IS NOT NULL")).scalar()
        if waiting:
            logger.warning("%d moved graph(s) still have an old FalkorDB key waiting to be dropped; "
                           "those keys will no longer be dropped", waiting)
    bind.execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS retired_keys"))
