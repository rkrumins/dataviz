"""merge the view members line and the main head

20261118_1100_view_members came after #675 took this branch's member sets into main, on top of
20261118_1000_member_sets, and environments deployed from the branch may have run it. Kept with
its parent, so their alembic_version names a revision main has; this joins that line with main's.
Nothing to run.

Revision ID: 20261119_1500_merge_view_members
Revises: 20261119_1400_merge_ps_build, 20261118_1100_view_members
Create Date: 2026-11-19 15:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261119_1500_merge_view_members'
down_revision: Union[str, None] = ('20261119_1400_merge_ps_build', '20261118_1100_view_members')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
