"""merge main's job-notices index and the collaboration line

#689 put 20261122_1200_gv_job_notices on main, on top of 20261122_1100_reusable_changes, which
this branch had already joined to its own line with 20261128_1000_merge_reusable and built on
(20261129_1000_ontology_owner, 20261129_1100_oal_imported). Both keep their parents, so a
database stamped on either still names a revision this build has; this joins them. Nothing to run.

Revision ID: 20261130_1000_merge_job_notices
Revises: 20261122_1200_gv_job_notices, 20261129_1100_oal_imported
Create Date: 2026-11-30 10:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261130_1000_merge_job_notices'
down_revision: Union[str, None] = ('20261122_1200_gv_job_notices', '20261129_1100_oal_imported')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
