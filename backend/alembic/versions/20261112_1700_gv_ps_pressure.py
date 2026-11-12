"""``projection_state.pressure_failures``: the passes in a row that failed under pressure.

A graph whose window fails three passes in a row on a timeout or memory refusal the statement ladder
could not absorb is rebuilt in place on its own. That count was ``failed_attempts``, which every
failed or held-back pass raises, whatever stopped it, so two connection failures and one timeout
rebuilt the whole graph. It is now counted here: a pass that fails under pressure adds one, and a
pass that ends any other way sets it back to 0. ``failed_attempts`` still spaces out the retries.

An INTEGER with a constant default of 0: Postgres keeps the default in the catalog, so nothing is
rewritten. The ALTER is bounded like the others (``_bound_lock_wait``) and safe to re-run;
``models._ensure_schema_upgrades`` mirrors it at start-up for a separate ``GRAPHVER_DB_URL``
alembic never reaches. The downgrade drops it: a graph then counts its pressure failures from 0.

Revision ID: 20261112_1700_gv_ps_pressure
Revises: 20261112_1600_import_settings
Create Date: 2026-11-12 17:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_pressure_failures_column

revision: str = "20261112_1700_gv_ps_pressure"
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
    ensure_ps_pressure_failures_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."projection_state" '
                                  "DROP COLUMN IF EXISTS pressure_failures"))
