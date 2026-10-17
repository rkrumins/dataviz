"""merge the API keys and activity ledger heads

Revision ID: 20261013_1100_merge_api_keys
Revises: 20261013_1000_activity_cadence, 20261013_1000_api_key_usage
Create Date: 2026-10-13 11:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261013_1100_merge_api_keys'
down_revision: Union[str, None] = ('20261013_1000_activity_cadence', '20261013_1000_api_key_usage')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
