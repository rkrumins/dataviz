"""``graphver.review_seen``: when each person last looked at a review, so what others did on it
since reads as unread to them; and ``ix_mr_target_status`` on ``merge_requests`` (target graph,
status), which the review inbox reads a workspace's live reviews by. A new, empty table with no
foreign key, and an index on a table of one row per review: neither locks anything for long.

Revision ID: 20261119_1200_gv_review_seen
Revises: 20261119_1100_gv_change_sets
Create Date: 2026-11-19 12:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_mr_target_status_index

revision: str = "20261119_1200_gv_review_seen"
down_revision: Union[str, None] = "20261119_1100_gv_change_sets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(sch):
        return                              # create_schema_and_partitions builds them
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."review_seen" ('
        "pr_id text NOT NULL, user_id text NOT NULL, graph_id text NOT NULL, seen_at text NOT NULL, "
        "PRIMARY KEY (pr_id, user_id))"))
    bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS ix_rs_graph ON "{sch}"."review_seen" (graph_id)'))
    ensure_mr_target_status_index(bind)


def downgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{sch}"."ix_mr_target_status"'))
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{sch}"."review_seen"'))
