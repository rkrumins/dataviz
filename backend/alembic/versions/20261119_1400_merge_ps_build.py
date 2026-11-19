"""merge the projection-state build line and the main head

20261113_1000_gv_ps_served_fill … 20261113_1400_gv_ps_candidate came with #670's versioned-graph
builds, off 20261113_0900_gv_import_mentions, and were run by environments deployed from it.
Taken into main as they are, so those environments' alembic_version names a revision main has;
this joins that line with main's. Nothing to run.

Revision ID: 20261119_1400_merge_ps_build
Revises: 20261119_1300_merge_member_sets, 20261113_1400_gv_ps_candidate
Create Date: 2026-11-19 14:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261119_1400_merge_ps_build'
down_revision: Union[str, None] = ('20261119_1300_merge_member_sets', '20261113_1400_gv_ps_candidate')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
