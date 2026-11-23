"""merge the graph watch line and the settings line's newer head

20261119_1800_merge_graph_watch (the graph watch line joined to 20261119_1700_review_rules_store)
is this branch's head, and was pushed with those parents, so a database this branch's build
upgraded is stamped with it. The settings line went on to 20261122_1300_merge_rules_store once
main's newer head merged in. Kept with its parents, so that stamp names a revision this chain has;
this joins the two. Nothing to run.

Revision ID: 20261122_1400_merge_watch_rules
Revises: 20261119_1800_merge_graph_watch, 20261122_1300_merge_rules_store
Create Date: 2026-11-22 14:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261122_1400_merge_watch_rules'
down_revision: Union[str, None] = ('20261119_1800_merge_graph_watch', '20261122_1300_merge_rules_store')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
