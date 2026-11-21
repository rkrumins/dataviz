"""merge main's bulk-editing line and the collaboration line

#685 put 20261121_1000_gv_property_jobs and 20261122_1000_view_bulk_recipes on main, on top of
20261119_1500_merge_view_members; this branch's Playground, requests, conversations, data source
details and analytics revisions grew from the same parent. Both lines keep their parents, so a
database stamped on either still names a revision this build has; this joins them. Nothing to run.

Revision ID: 20261127_1000_merge_bulk_recipes
Revises: 20261122_1000_view_bulk_recipes, 20261126_1000_disc_analytics
Create Date: 2026-11-27 10:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261127_1000_merge_bulk_recipes'
down_revision: Union[str, None] = ('20261122_1000_view_bulk_recipes', '20261126_1000_disc_analytics')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
