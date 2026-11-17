"""``graphver.review_comments``: comments on a review — on a change, one field or property of it, or
the review as a whole — threaded, resolvable, mentioning people.

A new, empty table with no foreign key, so creating it locks nothing in use; the upgrade is safe to
re-run. ``create_schema_and_partitions`` builds it for a separate ``GRAPHVER_DB_URL`` alembic never
reaches. The downgrade drops it, and the comments with it.

Revision ID: 20261117_1200_gv_review_comments
Revises: 20261113_0900_gv_import_mentions
Create Date: 2026-11-17 12:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261117_1200_gv_review_comments"
down_revision: Union[str, None] = "20261113_0900_gv_import_mentions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(sch):
        return                              # create_schema_and_partitions builds it
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."review_comments" ('
        "id text PRIMARY KEY, pr_id text NOT NULL, graph_id text NOT NULL, thread_id text NOT NULL, "
        "entity_id text, path text, body text NOT NULL, mentions jsonb, author text NOT NULL, "
        "entity_hash text, created_at text NOT NULL, edited_at text, deleted_at text, "
        "resolved_at text, resolved_by text)"))
    for name, cols in (("ix_rc_pr_entity", "pr_id, entity_id"), ("ix_rc_thread", "thread_id"),
                       ("ix_rc_graph", "graph_id")):
        bind.execute(sa.text(f'CREATE INDEX IF NOT EXISTS {name} ON "{sch}"."review_comments" ({cols})'))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        f'DROP TABLE IF EXISTS "{gv_config.graphver_schema()}"."review_comments"'))
