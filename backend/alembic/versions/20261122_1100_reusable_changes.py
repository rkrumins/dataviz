"""A view's bulk recipes become reusable changes, renamed in place.

The Search panel's built-in Recipes keep their name, so the bulk changes a view keeps take a new
one: ``view_bulk_recipes`` becomes ``view_reusable_changes``, its ``recipe`` column ``change``,
its index ``idx_vrc_view`` and its keys ``view_reusable_changes_pkey`` and
``view_reusable_changes_view_id_fkey``, as a database built from the models names them. Every
row stays where it is.

Guarded both ways: it renames only while the old table is there. A database built from the
models (the baseline's ``create_all``) already has the new table, and the revision before this
one then created the old one beside it; the new one is empty there, so it goes and the old one
is renamed. A new table that holds rows is never dropped: both are left as they are. The
downgrade takes the same steps back.

Dropping a table locks ``views`` through its foreign key, so the wait for it is bounded.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261122_1100_reusable_changes
Revises: 20261122_1000_view_bulk_recipes
Create Date: 2026-11-22 11:00
"""
from __future__ import annotations

from typing import Sequence, Tuple, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261122_1100_reusable_changes"
down_revision: Union[str, None] = "20261122_1000_view_bulk_recipes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: Each name as a (table, JSON column, index).
_OLD = ("view_bulk_recipes", "recipe", "idx_vbr_view")
_NEW = ("view_reusable_changes", "change", "idx_vrc_view")


def _rename(source: Tuple[str, str, str], target: Tuple[str, str, str]) -> None:
    (table, column, index), (to_table, to_column, to_index) = source, target
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return
    if inspector.has_table(to_table):
        if bind.execute(sa.text(f"SELECT 1 FROM {to_table} LIMIT 1")).first() is not None:
            return
        op.drop_table(to_table)
    op.drop_index(index, table_name=table, if_exists=True)
    op.rename_table(table, to_table)
    op.alter_column(to_table, column, new_column_name=to_column)
    op.create_index(to_index, to_table, ["view_id", "position"], if_not_exists=True)
    # Postgres named the keys after the table; they take its new name, as the models would give them.
    inspector = sa.inspect(bind)
    keys = [inspector.get_pk_constraint(to_table).get("name"),
            *(fk.get("name") for fk in inspector.get_foreign_keys(to_table))]
    for name in keys:
        if name and name.startswith(f"{table}_"):
            op.execute(f"ALTER TABLE {to_table} RENAME CONSTRAINT {name} TO {to_table}{name[len(table):]}")


def upgrade() -> None:
    _rename(_OLD, _NEW)


def downgrade() -> None:
    _rename(_NEW, _OLD)
