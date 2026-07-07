"""Add node_versions.ix_nv_urn (graph_id, urn) — bounded seed-node resolution.

The O(neighborhood) versioned neighbor read resolves a seed urn to its entity_id; this
index keeps that lookup bounded instead of scanning a graph's partitions.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260603_1500_nv_urn_index"
down_revision: Union[str, None] = "20260603_1400_ds_source_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_nv_urn ON "{schema}"."node_versions" (graph_id, urn)'
    ))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_nv_urn"'))
