"""View provenance: record who last modified a view.

* ``views.updated_by`` — stamped by the ``PUT /views/{id}`` edit path and
  the visibility-change path with the acting principal id (same value
  convention as ``created_by``: the auth user id, ``"anonymous"`` when
  unauthenticated). NULL on legacy rows and until the first post-migration
  edit; the API resolves it to a display name in the same batched user
  lookup that already resolves ``created_by``. The column is also declared
  on ``ViewORM`` so ``create_all`` covers fresh/test databases.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260703_0010_view_updated_by"
down_revision: Union[str, None] = "20260702_1900_insights_split"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE views ADD COLUMN IF NOT EXISTS updated_by text"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE views DROP COLUMN IF EXISTS updated_by"
    ))
