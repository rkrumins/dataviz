"""Index questions and replies by when they were posted, for Analytics' Collaboration tab.

Revision ID: 20261126_1000_disc_analytics
Revises: 20261125_1000_req_reminders
Create Date: 2026-11-26 10:00

The Collaboration document reads the questions asked in a window (``discussions.created_at``)
and the replies posted in it (``discussion_messages`` where ``kind = 'reply'``), platform-wide.
The existing indexes all lead with a subject, a thread or a person, so both reads would scan
their table. ``idx_discussions_created`` serves the window; ``idx_discussion_messages_replies``
is partial — questions are one row per thread and never counted as replies.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a brand-new environment
already has both when this runs. The wait for each table's lock is bounded.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261126_1000_disc_analytics"
down_revision: Union[str, None] = "20261125_1000_req_reminders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_REPLIES = "kind = 'reply'"
_INDEXES = (
    ("discussions", "idx_discussions_created", ["created_at"], None),
    ("discussion_messages", "idx_discussion_messages_replies", ["created_at"], _REPLIES),
)


def _bound_lock_wait() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _indexes(bind, table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    for table, name, columns, where in _INDEXES:
        if name in _indexes(bind, table):
            continue
        partial = {"postgresql_where": sa.text(where), "sqlite_where": sa.text(where)} if where else {}
        op.create_index(name, table, columns, **partial)


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    for table, name, _columns, _where in _INDEXES:
        if name in _indexes(bind, table):
            op.drop_index(name, table_name=table)
