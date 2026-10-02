"""Index ``outbox_events`` by kind of event and time.

Revision ID: 20260930_1000_outbox_type_time
Revises: 20260929_1000_user_activity
Create Date: 2026-09-30 10:00

Reads of the audit trail ask for particular kinds of event over a window,
newest first — the sign-in failure digest on every visit to the SSO
diagnostics page, for one. ``idx_outbox_event_type`` finds the kind but
leaves the window to a scan of every such row ever written, and nothing
prunes this table. ``(event_type, created_at)`` makes each kind a range
read that stops at the window's edge.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a
brand-new environment already has the index when this runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260930_1000_outbox_type_time"
down_revision: Union[str, None] = "20260929_1000_user_activity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "outbox_events"
_INDEX = "idx_outbox_event_type_created"


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    if _INDEX not in _indexes(bind):
        op.create_index(_INDEX, _TABLE, ["event_type", "created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    if _INDEX in _indexes(bind):
        op.drop_index(_INDEX, table_name=_TABLE)
