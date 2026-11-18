"""``graphver.change_sets``: change lists built once and kept, for every process to read — a
draft's changes as of its head, a window of ``main``'s revisions, the containment tree of either,
and each revision's own changes, which any two revisions compared are composed from
(``services/versioning/change_sets.py``). A new, empty table with no foreign key: creating it
locks nothing in use. Dropping it loses only what can be built again.

Revision ID: 20261119_1100_gv_change_sets
Revises: 20261118_1100_review_rules
Create Date: 2026-11-19 11:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261119_1100_gv_change_sets"
down_revision: Union[str, None] = "20261118_1100_review_rules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    if not sa.inspect(bind).has_schema(sch):
        return                              # create_schema_and_partitions builds it
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{sch}"."change_sets" ('
        "graph_id text NOT NULL, key text NOT NULL, origin text NOT NULL, built_at text NOT NULL, "
        "size integer NOT NULL, body bytea NOT NULL, PRIMARY KEY (graph_id, key))"))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_cs_origin ON "{sch}"."change_sets" (graph_id, origin, built_at)'))


def downgrade() -> None:
    sch = gv_config.graphver_schema()
    op.get_bind().execute(sa.text(f'DROP TABLE IF EXISTS "{sch}"."change_sets"'))
