"""How far each watched graph's watchers have been told: telling them leaves the publish.

One table, ``graph_watch_told``: a row for each versioned graph someone watches, by its data
source like ``graph_watches``. The versioning worker tells a graph's watchers of the versions its
published line gained since ``told_seq`` (``digest.tell_pending``), in rounds: ``round_to`` is the
version a round in progress tells up to, ``round_through`` the last watcher it has told, by user
id. Both are saved with each batch of notifications, so a round that a restart cut short carries
on where it stopped and tells nobody twice. ``told_seq`` NULL: not read yet; the worker starts it
at the graph's head, telling nobody of what came before.

A new table: nothing read today depends on it. A row for each graph watched already, with
``told_seq`` NULL (unconditional, like any data a migration writes). Guarded DDL, as a
``create_all`` baseline already has the table, waiting at most five seconds for a lock like the
revisions before it. The downgrade drops it; a later upgrade starts each graph at its head again.

Revision ID: 20261123_0100_graph_watch_told
Revises: 20261122_1400_merge_watch_rules
Create Date: 2026-11-23 01:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261123_0100_graph_watch_told"
down_revision: Union[str, None] = "20261122_1400_merge_watch_rules"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock, like the revisions before it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    if not sa.inspect(op.get_bind()).has_table("graph_watch_told"):
        op.create_table(
            "graph_watch_told",
            sa.Column("data_source_id", sa.Text(), primary_key=True),
            sa.Column("told_seq", sa.BigInteger(), nullable=True),
            sa.Column("round_to", sa.BigInteger(), nullable=True),
            sa.Column("round_through", sa.Text(), nullable=True),
            sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.func.now()),
        )
    op.execute("INSERT INTO graph_watch_told (data_source_id) "
               "SELECT DISTINCT w.data_source_id FROM graph_watches w WHERE NOT EXISTS "
               "(SELECT 1 FROM graph_watch_told t WHERE t.data_source_id = w.data_source_id)")


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_table("graph_watch_told", if_exists=True)
