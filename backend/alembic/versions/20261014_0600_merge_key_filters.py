"""merge the API keys and saved view filters heads

Revision ID: 20261014_0600_merge_key_filters
Revises: 20261013_0116_saved_filters, 20261013_1300_api_key_scale
Create Date: 2026-10-14 06:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261014_0600_merge_key_filters'
down_revision: Union[str, None] = ('20261013_0116_saved_filters', '20261013_1300_api_key_scale')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
