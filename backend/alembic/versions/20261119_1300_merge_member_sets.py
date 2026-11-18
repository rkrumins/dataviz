"""merge the member sets and review heads

#675 (member sets) and #674 (change lists and reviews) each added revisions on top of
20261117_1500_gv_mr_sendback, leaving main with two heads — and the upgrade Job refusing
every deploy ("Multiple heads are present"). Nothing to run: it joins them.

Revision ID: 20261119_1300_merge_member_sets
Revises: 20261119_1200_gv_review_seen, 20261118_1000_member_sets
Create Date: 2026-11-19 13:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261119_1300_merge_member_sets'
down_revision: Union[str, None] = ('20261119_1200_gv_review_seen', '20261118_1000_member_sets')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
