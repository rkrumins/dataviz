"""Where an asked-about entity sits, and what it is: ``discussions.entity_path`` and ``entity_type``.

A question about one entity kept only its id and its name, so two entities with the same name read
the same. It now also keeps the containers the entity sits in, top first, as a JSON list of names
(``entity_path``), and its type (``entity_type``), both as they were when it was asked. A question
asked before them has neither, and reads as its name and id.

Two nullable columns: on Postgres a change to the catalogue only, no table rewrite. Guarded DDL (a
``create_all`` baseline already has them), waiting at most five seconds for a lock like the
revisions before it. The downgrade drops them.

Revision ID: 20261204_1000_discussion_path
Revises: 20261203_1100_watch_edges
Create Date: 2026-12-04 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261204_1000_discussion_path"
down_revision: Union[str, None] = "20261203_1100_watch_edges"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = ("entity_path", "entity_type")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock, like the revisions before it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _present() -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("discussions")}


def upgrade() -> None:
    _bound_lock_wait()
    present = _present()
    for name in _COLUMNS:
        if name not in present:
            op.add_column("discussions", sa.Column(name, sa.Text(), nullable=True))


def downgrade() -> None:
    _bound_lock_wait()
    present = _present()
    for name in _COLUMNS:
        if name in present:
            op.drop_column("discussions", name)
