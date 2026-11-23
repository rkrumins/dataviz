"""merge the graph watch line and the settings line's head

20261116_1200_graph_watch (how far each person has looked at a versioned graph, and what they
watch in it) came off
20261116_1100_settings_import, and environments deployed from this branch ran it. Kept with its
parent, so their alembic_version names a revision this chain has; this joins it with the head the
settings line reached once main merged in (20261119_1700_review_rules_store). Nothing to run.

Revision ID: 20261119_1800_merge_graph_watch
Revises: 20261119_1700_review_rules_store, 20261116_1200_graph_watch
Create Date: 2026-11-19 18:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261119_1800_merge_graph_watch'
down_revision: Union[str, None] = ('20261119_1700_review_rules_store', '20261116_1200_graph_watch')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
