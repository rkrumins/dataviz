"""Add providers.falkor_max_resident (per-provider FalkorDB cache-eviction budget).

The versioning eviction daemon reads each provider's max resident FalkorDB
main-cache graph count from this column (registry-backed budget resolver), so
operators tune eviction through the provider registry/API instead of env vars.
NULL ⇒ unset ⇒ the daemon falls back to the GRAPHVER_FALKOR_* env defaults.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260603_1200_falkor_budget"
down_revision: Union[str, None] = "20260601_1200_graphver_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(sa.text(
        "ALTER TABLE providers ADD COLUMN IF NOT EXISTS falkor_max_resident integer"
    ))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "ALTER TABLE providers DROP COLUMN IF EXISTS falkor_max_resident"
    ))
