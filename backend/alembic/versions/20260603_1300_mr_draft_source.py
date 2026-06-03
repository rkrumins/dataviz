"""Add merge_requests.source_graph_id (draft->main MR vs fork PR discriminator).

A same-graph draft->main merge request sets ``source_graph_id == target_graph_id``;
a legacy fork PR leaves it NULL. This lets one ``merge_requests`` table and one set of
merge endpoints serve both the reviewed draft-publish gate and fork PRs (``merge_mr``
dispatches on the equality).
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260603_1300_mr_draft_source"
down_revision: Union[str, None] = "20260603_1200_falkor_budget"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    mr = f'"{schema}"."merge_requests"'
    bind.execute(sa.text(f"ALTER TABLE {mr} ADD COLUMN IF NOT EXISTS source_graph_id text"))
    bind.execute(sa.text(f"CREATE INDEX IF NOT EXISTS ix_mr_source ON {mr} (source_graph_id)"))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_mr_source"'))
    bind.execute(sa.text(
        f'ALTER TABLE "{schema}"."merge_requests" DROP COLUMN IF EXISTS source_graph_id'
    ))
