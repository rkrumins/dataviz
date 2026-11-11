"""``graphver.rollup_deltas``: a projection window's net lineage-summary deltas, while it is too large
to net in memory.

A window's lineage summaries (``:AGGREGATED`` cells) are moved by delta whatever its size: the
pass reads its edges a page at a time and nets their contributions by cell, in memory up to
``GRAPHVER_ROLLUP_NET_MAX_CELLS`` cells and in this table, one row per cell, above it; then it
applies them a page at a time. Before, a window of more than 50,000 edge changes handed the
summaries to the whole-graph aggregation job.

A new, empty table with no foreign key: creating it locks nothing in use, and the upgrade is safe
to re-run. ``create_schema_and_partitions`` creates it from the model for a separate
``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops it: a window being netted there is
netted again by its next pass.

Revision ID: 20261112_1100_gv_rollup_deltas
Revises: 20261112_1000_gv_proj_quarantine
Create Date: 2026-11-12 11:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261112_1100_gv_rollup_deltas"
down_revision: Union[str, None] = "20261112_1000_gv_proj_quarantine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(schema):
        return                              # create_schema_and_partitions builds it
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{schema}"."rollup_deltas" ('
        "graph_id text NOT NULL, to_seq bigint NOT NULL, s text NOT NULL, t text NOT NULL, "
        "dw bigint NOT NULL, dwc bigint, types jsonb NOT NULL, sd integer, td integer, "
        "sl integer, tl integer, slb text, tlb text, dg text, "
        "CONSTRAINT pk_rollup_deltas PRIMARY KEY (graph_id, to_seq, s, t))"))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        f'DROP TABLE IF EXISTS "{gv_config.graphver_schema()}"."rollup_deltas"'))
