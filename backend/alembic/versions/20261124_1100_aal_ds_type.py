"""Index the ledger by source and event type, for a data source's history.

Revision ID: 20261124_1100_aal_ds_type
Revises: 20261124_1000_ds_metadata
Create Date: 2026-11-24 11:00

A data source's Activity tab lists its events of a short allow-list of types (added, renamed,
moved, certified…), newest first, a page at a time. ``idx_aal_ds_occurred`` finds the source's
events, but a busy source's ledger is mostly aggregation and operations rows the history leaves
out, so the read would walk past all of them for each page. This one leads with the source and
the type, so each allowed type is a range scan in time order. Partial: rows about no source cost
nothing.

A separate revision from ``20261124_1000_ds_metadata`` because it builds an index over the whole
ledger: run on its own, its lock is held only for this build. The wait for the lock is bounded.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a brand-new environment
already has the index when this runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261124_1100_aal_ds_type"
down_revision: Union[str, None] = "20261124_1000_ds_metadata"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"
_INDEX = "idx_aal_ds_type_occurred"
_WHERE = "data_source_id IS NOT NULL"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for the ledger's lock: a long reader — an activity export
    streaming for minutes — makes the upgrade give up, to be run again, rather than queue every
    later query on the table behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    if _INDEX not in _indexes(bind):
        op.create_index(
            _INDEX, _TABLE, ["data_source_id", "event_type", "occurred_at"],
            postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE),
        )


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_TABLE)
