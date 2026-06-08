"""Add merge_requests review metadata (title/description + merge/close who & when).

The PR review center stores a human ``title`` + ``description`` on a merge request and
records full lifecycle metadata: who merged it and when (``merged_by``/``merged_at``) and
who closed it and when (``closed_by``/``closed_at``). These columns were added to the ORM
and to ``create_all`` (fresh DBs) and patched into the graphver schema migration, but a DB
that had already applied that revision never picked them up — so this dedicated revision
adds them idempotently on ``alembic upgrade head``.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260608_1200_mr_review_metadata"
down_revision: Union[str, None] = "20260603_1500_nv_urn_index"
branch_labels = None
depends_on = None

_COLS = ("title", "description", "merged_at", "merged_by", "closed_at", "closed_by")


def upgrade() -> None:
    bind = op.get_bind()
    mr = f'"{gv_config.graphver_schema()}"."merge_requests"'
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE {mr} ADD COLUMN IF NOT EXISTS {col} text"))


def downgrade() -> None:
    bind = op.get_bind()
    mr = f'"{gv_config.graphver_schema()}"."merge_requests"'
    for col in _COLS:
        bind.execute(sa.text(f"ALTER TABLE {mr} DROP COLUMN IF EXISTS {col}"))
