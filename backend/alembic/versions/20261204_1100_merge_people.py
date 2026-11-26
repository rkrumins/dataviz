"""merge the people analytics line and the main head

20261202_1000_pev_actor_ws, 20261202_1100_people_index and 20261203_1000_people_rollup were
pushed on claude/vigilant-cori-fdi0nj off 20261201_1000_ontology_create, the parent main's
20261202_1000_bootstrap_review took too, and environments deployed from the branch may have run
them. Kept with their parents, so their alembic_version names a revision main has; this joins
that line with main's. Nothing to run.

Revision ID: 20261204_1100_merge_people
Revises: 20261204_1000_discussion_path, 20261203_1000_people_rollup
Create Date: 2026-12-04 11:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261204_1100_merge_people'
down_revision: Union[str, None] = ('20261204_1000_discussion_path', '20261203_1000_people_rollup')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
