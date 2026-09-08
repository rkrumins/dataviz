"""Record when a discovery refresh was last ATTEMPTED, not just when it succeeded.

``asset_discovery_cache.computed_at`` only moves when a scan produced a payload.
``discovery.record_failure`` deliberately leaves it alone — the counts it is
still serving really are that old, and advancing the timestamp would be a lie.
But nothing recorded the attempt either, so a provider that has been refusing
for days looked exactly like a sweep that stopped running: the Data Sources tab
showed metrics from Tuesday with no sign anything was still trying.

This adds the missing half. ``last_attempt_at`` is stamped on every completed
attempt, success or failure, so the read envelope can say "updated 3d ago,
checked 4m ago" and an operator can tell a broken provider from a broken
pipeline without reading logs.

Nullable with no backfill: NULL means "not attempted since this shipped", which
the scheduler's due-check already reads as due.

``downgrade`` drops the column — it carries no information that is not
reproducible on the next sweep.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260908_1000_discovery_attempt"
down_revision: Union[str, None] = "20260902_1000_derived_artifacts"
branch_labels = None
depends_on = None

_TABLE = "asset_discovery_cache"


def _columns(bind, table: str) -> set:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    cols = _columns(bind, _TABLE)
    if not cols or "last_attempt_at" in cols:
        return
    op.add_column(_TABLE, sa.Column("last_attempt_at", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if "last_attempt_at" not in _columns(bind, _TABLE):
        return
    op.drop_column(_TABLE, "last_attempt_at")
