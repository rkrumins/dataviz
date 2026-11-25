"""Watching a relationship, as an entity is watched: ``graph_watches.entity_kind``.

A relationship has no urn, so it is watched by its id, in ``entity_urn`` like an entity's urn, and
``entity_kind`` says which it is: ``node`` (an entity, by its urn) or ``edge`` (a relationship, by
its id). Every watch there already is an entity's (or the whole graph's), so the column defaults
to ``node``; a writer from before it leaves ``node`` too.

One column with a constant default: on Postgres a change to the catalogue only, no table rewrite.
Guarded DDL (a ``create_all`` baseline already has it), waiting at most five seconds for a lock like
the revisions before it. The downgrade drops the column and, with it, the relationship watches:
left behind, each would read as an entity's urn that names nothing, held against the limit.

Revision ID: 20261203_1000_watch_edges
Revises: 20261202_1000_bootstrap_review
Create Date: 2026-12-03 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261203_1000_watch_edges"
down_revision: Union[str, None] = "20261202_1000_bootstrap_review"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock, like the revisions before it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _has_kind() -> bool:
    columns = sa.inspect(op.get_bind()).get_columns("graph_watches")
    return "entity_kind" in {c["name"] for c in columns}


def upgrade() -> None:
    _bound_lock_wait()
    if not _has_kind():
        op.add_column("graph_watches", sa.Column("entity_kind", sa.Text(), nullable=False,
                                                 server_default="node"))


def downgrade() -> None:
    _bound_lock_wait()
    if _has_kind():
        op.execute("DELETE FROM graph_watches WHERE entity_kind = 'edge'")
        op.drop_column("graph_watches", "entity_kind")
