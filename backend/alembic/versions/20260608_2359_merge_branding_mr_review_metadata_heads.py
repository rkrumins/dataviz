"""merge branding + mr_review_metadata heads

Revision ID: 20260608_2359_merge_heads
Revises: 20260608_1200_branding, 20260608_1200_mr_review_metadata
Create Date: 2026-06-08 23:59:16.370946+00:00

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260608_2359_merge_heads'
down_revision: Union[str, None] = ('20260608_1200_branding', '20260608_1200_mr_review_metadata')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
