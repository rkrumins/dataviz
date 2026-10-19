"""``graphs.lifecycle_state``, ``lifecycle_rev`` and ``lifecycle_changed_at``: a graph's freeze.

``lifecycle_state`` is live or frozen (``ck_graphs_lifecycle_state``); trashed and purging stay
derived from ``deleted_at``. ``lifecycle_rev`` is what a freeze or unfreeze compares and bumps, and
``lifecycle_changed_at`` restarts the idle-draft TTL at unfreeze. No graph was frozen before, so
every existing one reads live at rev 0 from the column defaults: no UPDATE, no rewrite. Each
``ADD COLUMN IF NOT EXISTS`` has a constant default, so it is catalog-only; the check reads one row
per graph. The wait for the table's lock is bounded (``_bound_lock_wait``), and the upgrade is safe
to re-run.

The downgrade drops the columns, and with them every freeze: each graph is editable again. It
logs how many graphs that resumes; a later upgrade does not pause them again.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

import logging
from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_graph_lifecycle_columns

revision: str = "20261018_1200_gv_lifecycle"
down_revision: Union[str, None] = "20261018_1100_gv_ps_retired"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the table's lock: every main commit writes ``graphs``, so a
    long holder makes the upgrade give up, to be run again, rather than queue those writes
    behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_graph_lifecycle_columns(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    inspector = sa.inspect(bind)
    if not inspector.has_table("graphs", schema=schema):
        return
    graphs = f'"{schema}"."graphs"'
    if "lifecycle_state" in {c["name"] for c in inspector.get_columns("graphs", schema=schema)}:
        frozen = bind.execute(sa.text(
            f"SELECT count(*) FROM {graphs} WHERE lifecycle_state = 'frozen'")).scalar()
        if frozen:
            logger.warning("%d graph(s) had editing paused; the downgrade resumes editing on all of "
                           "them, and a later upgrade does not pause them again", frozen)
    bind.execute(sa.text(f"ALTER TABLE {graphs} DROP CONSTRAINT IF EXISTS ck_graphs_lifecycle_state"))
    for column in ("lifecycle_state", "lifecycle_rev", "lifecycle_changed_at"):
        bind.execute(sa.text(f"ALTER TABLE {graphs} DROP COLUMN IF EXISTS {column}"))
