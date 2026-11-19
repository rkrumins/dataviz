"""``graphver.review_decisions``: a reviewer's verdict on each change of a draft's review —
accepted or rejected, bound to the change's content hash — what *Merge accepted* lands.

A new, empty table with no foreign key, so creating it locks nothing in use; the upgrade is safe to
re-run. ``create_schema_and_partitions`` builds it for a separate ``GRAPHVER_DB_URL`` alembic never
reaches. The downgrade drops it, and the decisions with it.

Revision ID: 20261117_1300_gv_decisions
Revises: 20261117_1200_gv_review_comments
Create Date: 2026-11-17 13:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261117_1300_gv_decisions"
down_revision: Union[str, None] = "20261117_1200_gv_review_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(sch):
        return                              # create_schema_and_partitions builds it
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."review_decisions" ('
        "pr_id text NOT NULL, entity_id text NOT NULL, graph_id text NOT NULL, verdict text NOT NULL, "
        "reason text, content_hash text, implied_by text, actor text NOT NULL, decided_at text NOT NULL, "
        "PRIMARY KEY (pr_id, entity_id), "
        "CONSTRAINT ck_rd_verdict CHECK (verdict IN ('accepted', 'rejected')))"))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_rd_graph ON "{sch}"."review_decisions" (graph_id)'))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        f'DROP TABLE IF EXISTS "{gv_config.graphver_schema()}"."review_decisions"'))
