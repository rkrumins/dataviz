"""``graphver.bootstrap_nodes`` — what an "enable version control" pre-flight saw.

Duplicate identifiers (two source nodes sharing a ``urn``) used to be found only by the copy
itself, and only failed the job at validation — after the whole graph had been copied, with no
list of which identifiers collided. The pre-flight now reads every node's internal id, label,
``urn`` and ``lastSyncedAt`` into this table before anything is copied, ranks the copies of each
duplicated urn (``copy_rank``: NULL = unique, 1 = kept, >1 = collapsed) and pauses the job for a
decision with the full list. ``last_synced_at`` is TIMESTAMPTZ so the ranking is chronological.

The ORM (``versioning/models.BootstrapNodeORM``) declares the same table, so ``create_all``
covers fresh databases and a separate ``GRAPHVER_DB_URL``; this migration covers existing ones.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261008_1100_bootstrap_nodes"
down_revision: Union[str, None] = "20261008_1000_jobs_check_widen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    # A database installed at head has no graphver schema until the versioning worker's bootstrap
    # (create_schema_and_partitions) creates it, and that builds this table from the models.
    if not sa.inspect(bind).has_table("jobs", schema=schema):
        return
    table = f'"{schema}"."bootstrap_nodes"'
    bind.execute(sa.text(
        f"CREATE TABLE IF NOT EXISTS {table} ("
        "graph_id text NOT NULL, falkor_id bigint NOT NULL, urn text NOT NULL, label text, "
        "last_synced_at timestamptz, copy_rank integer, "
        "CONSTRAINT pk_bootstrap_nodes PRIMARY KEY (graph_id, falkor_id))"))
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_bootstrap_nodes_urn ON {table} (graph_id, urn)"))
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_bootstrap_nodes_dupes ON {table} "
        "(graph_id, urn, copy_rank) WHERE copy_rank IS NOT NULL"))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."bootstrap_nodes"'))
