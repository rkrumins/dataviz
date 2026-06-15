"""Add branches.description (optional, user-editable draft description).

A draft branch already carries a ``name``; this adds an optional ``description`` so users can
annotate what a branch is for (surfaced + edited via the branch-settings UI and the
``PATCH /graphs/{gid}/branches/{bid}`` endpoint). Added to the ORM + ``create_all`` (fresh DBs)
and applied idempotently here for DBs already past the base schema revision.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260615_1200_branch_description"
down_revision: Union[str, None] = "20260608_2359_merge_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    branches = f'"{gv_config.graphver_schema()}"."branches"'
    bind.execute(sa.text(f"ALTER TABLE {branches} ADD COLUMN IF NOT EXISTS description text"))


def downgrade() -> None:
    bind = op.get_bind()
    branches = f'"{gv_config.graphver_schema()}"."branches"'
    bind.execute(sa.text(f"ALTER TABLE {branches} DROP COLUMN IF EXISTS description"))
