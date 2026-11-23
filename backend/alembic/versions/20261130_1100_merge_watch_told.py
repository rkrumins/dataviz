"""merge main's graph-watch line and the collaboration line

#668 and #670 put a line on main that ends at 20261123_0100_graph_watch_told (review rules as
settings, the settings store, graph watches and the digest), grown from 20261122_1200_gv_job_notices,
which this branch had already joined to its own line with 20261130_1000_merge_job_notices. Both keep
their parents, so a database stamped on either still names a revision this build has; this joins
them. Nothing to run.

Revision ID: 20261130_1100_merge_watch_told
Revises: 20261123_0100_graph_watch_told, 20261130_1000_merge_job_notices
Create Date: 2026-11-30 11:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261130_1100_merge_watch_told'
down_revision: Union[str, None] = ('20261123_0100_graph_watch_told', '20261130_1000_merge_job_notices')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
