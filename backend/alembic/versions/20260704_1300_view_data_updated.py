"""View data freshness: record when a view's UNDERLYING DATA last changed.

* ``views.data_updated_at`` / ``views.data_updated_by`` — stamped on every view
  of a data source when a publish / merge-request merge / fork-PR merge /
  revert advances the versioned graph's ``main``. Deliberately SEPARATE from
  ``updated_at``/``updated_by`` (who last edited the view's settings) so a
  publisher never clobbers settings-edit attribution and Explorer sorting
  semantics stay stable. NULL on legacy rows and until the first
  post-migration publish; the API resolves ``data_updated_by`` to a display
  name in the same batched user lookup as ``created_by``/``updated_by``. The
  columns are also declared on ``ViewORM`` so ``create_all`` covers fresh/test
  databases.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260704_1300_view_data_updated"
down_revision: Union[str, None] = "20260704_1200_projection_progress"
branch_labels = None
depends_on = None

_COLS = ("data_updated_at", "data_updated_by")


def upgrade() -> None:
    bind = op.get_bind()
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE views ADD COLUMN IF NOT EXISTS {col} text"))


def downgrade() -> None:
    bind = op.get_bind()
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE views DROP COLUMN IF EXISTS {col}"))
