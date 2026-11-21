"""merge main's reusable changes and the collaboration line

#686 put 20261122_1100_reusable_changes on main, on top of 20261122_1000_view_bulk_recipes, which
this branch had already joined to its own line with 20261127_1000_merge_bulk_recipes. Both keep
their parents, so a database stamped on either still names a revision this build has; this joins
them. Nothing to run.

Revision ID: 20261128_1000_merge_reusable
Revises: 20261122_1100_reusable_changes, 20261127_1000_merge_bulk_recipes
Create Date: 2026-11-28 10:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261128_1000_merge_reusable'
down_revision: Union[str, None] = ('20261122_1100_reusable_changes', '20261127_1000_merge_bulk_recipes')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
