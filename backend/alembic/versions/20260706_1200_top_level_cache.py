"""Top-level nodes materialization cache columns on ``data_source_stats``.

* ``top_level_nodes`` — JSON payload of the materialized top-level/orphan
  nodes result for large graphs (NULL = never materialized).
* ``top_level_updated_at`` — ISO timestamp freshness marker for that
  payload, independent of the counts (``updated_at``) and deep
  (``schema_updated_at``) facets.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260706_1200_top_level_cache"
down_revision: Union[str, None] = "20260704_1400_import_export"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats ADD COLUMN IF NOT EXISTS top_level_nodes text"
    ))
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats ADD COLUMN IF NOT EXISTS top_level_updated_at text"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats DROP COLUMN IF EXISTS top_level_nodes"
    ))
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats DROP COLUMN IF EXISTS top_level_updated_at"
    ))
