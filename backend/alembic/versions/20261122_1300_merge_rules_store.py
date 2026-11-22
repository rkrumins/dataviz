"""merge the versioned-graph settings line and main's newer head

20261119_1700_review_rules_store (main's review rules copied into the settings store) is this
branch's head, off 20261119_1600_merge_settings, and was pushed with that parent, so a database this
branch's build upgraded is stamped with it. main went on from 20261119_1500_merge_view_members to
20261122_1200_gv_job_notices meanwhile. Kept with its parent, so that stamp names a revision this
chain has; this joins the two. Nothing to run.

This branch's head is named first: the upgrade Job's guess at where an unrecorded stamp parted
(schema_plan.parting_point) walks the chain from its head, and in this order the walk takes main's
line before this branch's older-dated settings revisions, so a stamp from a branch of main is
guessed on main's line.

Revision ID: 20261122_1300_merge_rules_store
Revises: 20261119_1700_review_rules_store, 20261122_1200_gv_job_notices
Create Date: 2026-11-22 13:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261122_1300_merge_rules_store'
down_revision: Union[str, None] = ('20261119_1700_review_rules_store', '20261122_1200_gv_job_notices')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
