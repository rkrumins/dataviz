"""Subset views: remember which view a view was made from.

* ``views.derived_from_view_id`` — the view a subset was carved out of by
  ``POST /views/{id}/subsets``. NULL on every view made any other way.

  A foreign key to ``views`` with ON DELETE SET NULL: a subset outlives its
  source, and hard-deleting the source only forgets where the subset came
  from (a soft delete keeps the link; the API says the source is gone).

  Indexed, because the source view's "Subsets of this view" list reads it
  (``GET /views?derivedFrom=``).

One guarded statement per object, so a replayed chain over a ``create_all``
baseline no-ops, and a forward-migrated database ends with exactly what
``create_all`` makes — including the foreign key's default name,
``views_derived_from_view_id_fkey`` (the ORM declares no naming convention).
The column is also declared on ``ViewORM``.
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260924_1000_view_derived_from"
down_revision: Union[str, None] = "20260920_1200_view_entity_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE views ADD COLUMN IF NOT EXISTS derived_from_view_id text "
        "REFERENCES views(id) ON DELETE SET NULL"
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_view_derived_from ON views (derived_from_view_id)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP INDEX IF EXISTS idx_view_derived_from"))
    bind.execute(sa.text("ALTER TABLE views DROP COLUMN IF EXISTS derived_from_view_id"))
