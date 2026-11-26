"""``projection_state.property_names``: how many property names a graph uses.

FalkorDB numbers a graph's property names in one map that items and relationships share, and never
frees one. The projector already stops its own writes at ``FALKORDB_NATIVE_PROPERTY_BUDGET`` and
stores the keys past it as values; each pass now records what it found (names registered, the
platform's share, the budget, the ceiling, and the keys stored as values), so graph health can
show how close a graph is before it gets there.

The ORM declares the same column, so ``create_all`` covers fresh databases; ``models.
_ensure_schema_upgrades`` covers a separate ``GRAPHVER_DB_URL``; this migration covers existing ones.

Revision ID: 20261203_1000_gv_ps_prop_names
Revises: 20261202_1000_bootstrap_review
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_ps_property_names_column

revision: str = "20261203_1000_gv_ps_prop_names"
down_revision: Union[str, None] = "20261202_1000_bootstrap_review"
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
    ensure_ps_property_names_column(op.get_bind())


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("projection_state", schema=schema):
        return
    bind.execute(sa.text(
        f'ALTER TABLE "{schema}"."projection_state" DROP COLUMN IF EXISTS property_names'))
