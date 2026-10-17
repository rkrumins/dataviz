"""merge the API keys and SSO fallback heads

Revision ID: 20261014_1100_merge_sso_keys
Revises: 20261014_1000_sso_fallback, 20261014_0600_merge_key_filters
Create Date: 2026-10-14 11:00:00+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = '20261014_1100_merge_sso_keys'
down_revision: Union[str, None] = ('20261014_1000_sso_fallback', '20261014_0600_merge_key_filters')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
