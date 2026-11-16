"""What changed since you last looked, and watching a versioned graph or an entity in it.

Two tables of a person's own (``endpoints/graph_digest.py``):

* ``graph_seen`` — how far each person has looked at each versioned graph: the version of its
  published line they marked seen (``seen_seq``) and when. Keyed by the data source, one versioned
  graph each. The marker only moves forward.
* ``graph_watches`` — the graphs, and the entities in them (by urn), a person watches: a publish
  that changes one tells them in their Inbox. ``entity_urn`` NULL watches the whole graph; NULLs
  are distinct to ``uq_graph_watches``, so the partial index ``uq_graph_watches_graph`` keeps that
  to one row too. ``ix_graph_watches_ds`` finds who to tell when a graph is published.

New tables only, nothing read today depends on them. Guarded DDL (a ``create_all`` baseline
already has all of it), waiting at most five seconds for a lock like the revisions before it. The
downgrade drops them: every marker and every watch goes.

Revision ID: 20261116_1200_graph_watch
Revises: 20261116_1100_settings_import
Create Date: 2026-11-16 12:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261116_1200_graph_watch"
down_revision: Union[str, None] = "20261116_1100_settings_import"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_GRAPH_ONLY = "entity_urn IS NULL"
_INDEXES = (
    ("uq_graph_watches_graph", "graph_watches", ["user_id", "data_source_id"],
     {"unique": True, "postgresql_where": sa.text(_GRAPH_ONLY), "sqlite_where": sa.text(_GRAPH_ONLY)}),
    ("ix_graph_watches_ds", "graph_watches", ["data_source_id", "entity_urn"], {}),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock, like the revisions before it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("graph_seen"):
        op.create_table(
            "graph_seen",
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("seen_seq", sa.BigInteger(), nullable=False),
            sa.Column("seen_at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("user_id", "data_source_id", name="pk_graph_seen"),
        )
    if not inspector.has_table("graph_watches"):
        op.create_table(
            "graph_watches",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("entity_urn", sa.Text(), nullable=True),
            sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("user_id", "data_source_id", "entity_urn", name="uq_graph_watches"),
        )
    for name, table, columns, kw in _INDEXES:
        op.create_index(name, table, columns, if_not_exists=True, **kw)


def downgrade() -> None:
    _bound_lock_wait()
    for name, table, _columns, _kw in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
    for table in ("graph_watches", "graph_seen"):
        op.drop_table(table, if_exists=True)
