"""``graphver.import_mentions``: what an import's rows name without a node row matching it.

A replace deletes whatever its file leaves out. A row it refused protected nothing, so with
``maxRefusedRows`` a replace deleted the very node a refused row named by its urn, and an edge row
whose end had no node row of its own lost its end, and with it the edge it had just written. Each
import now records the entities its rows name besides what they matched (an edge's ends; what a
refused row names by a key it carries), and its replace keeps them.

A new, empty table with no foreign key, so creating it locks nothing in use; the upgrade is safe to
re-run. It is mirrored at start-up (``create_schema_and_partitions``) for a separate
``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops it: a replace then keeps only what
its rows matched, as before.

Revision ID: 20261113_0900_gv_import_mentions
Revises: 20261112_1800_gv_ps_served
Create Date: 2026-11-13 09:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261113_0900_gv_import_mentions"
down_revision: Union[str, None] = "20261112_1800_gv_ps_served"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        return                              # create_schema_and_partitions builds it
    bind.execute(sa.text(
        f'CREATE TABLE IF NOT EXISTS "{gv_config.graphver_schema()}"."import_mentions" ('
        "job_id text NOT NULL, entity_id text NOT NULL, "
        "CONSTRAINT pk_import_mentions PRIMARY KEY (job_id, entity_id))"))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        f'DROP TABLE IF EXISTS "{gv_config.graphver_schema()}"."import_mentions"'))
