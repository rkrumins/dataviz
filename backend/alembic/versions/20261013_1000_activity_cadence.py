"""Index the ledger's manual operations on a source by time alone.

Revision ID: 20261013_1000_activity_cadence
Revises: 20261011_1000_activity_pulse
Create Date: 2026-10-13 10:00

Every activity summary reads the newest manual operations on a source in its
window, as rows, for how often each source is operated by hand — and every
zoom is a new window. ``idx_aal_category_occurred`` found them, then the read
fetched every operation in the window from the table to keep the newest ten
thousand: a fortnight of a ten-million-event ledger took 250 ms. This one
leads with the time and carries what the read selects and filters on, so it
walks back from the window's end and stops at the cap without touching the
table: 4.6 ms. Partial, so it costs a write only for operations on a source.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a
brand-new environment already has the index when this runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261013_1000_activity_cadence"
down_revision: Union[str, None] = "20261011_1000_activity_pulse"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"
_INDEX = "idx_aal_cadence"
_WHERE = "category = 'operations' AND data_source_id IS NOT NULL"


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    if _INDEX not in _indexes(bind):
        op.create_index(
            _INDEX, _TABLE, ["occurred_at"],
            postgresql_include=["data_source_id", "workspace_id", "actor_id", "event_type", "audience"],
            postgresql_where=sa.text(_WHERE), sqlite_where=sa.text(_WHERE),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_TABLE)
