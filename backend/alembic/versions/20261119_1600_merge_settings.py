"""merge the versioned-graph settings line and the main head

20261116_1000_setting_values and 20261116_1100_settings_import (the settings store and the copy of
every value saved before it) came off 20261113_1400_gv_ps_candidate while main took that line in
on its own, and environments deployed from this branch ran them. Kept with their parents, so their
alembic_version names revisions main has; this joins that line with main's. Nothing to run.

Revision ID: 20261119_1600_merge_settings
Revises: 20261119_1500_merge_view_members, 20261116_1100_settings_import
Create Date: 2026-11-19 16:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261119_1600_merge_settings'
down_revision: Union[str, None] = ('20261119_1500_merge_view_members', '20261116_1100_settings_import')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
