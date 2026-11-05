"""``graphver.import_results`` — what each staged row of an import resolved to.

An import used to record each row's outcome (the entity it matched, its op, its status and
reasons) by updating the staged row in ``import_rows``. That rewrote the whole row — its raw JSON
is inline, and ``matched_entity_id`` is indexed, so no update was HOT — with three new index
entries, and left a dead copy for autovacuum, for every row of the file. The outcomes now go to
this table, written once with the window that resolved them; ``import_rows`` is written once, at
staging. ``ix_import_rows_matched`` stays for a release, for the jobs a worker of the release
before staged and this one resumes (it copies their outcomes across first).

The ORM (``versioning/models.ImportResultORM``) declares the same table, so ``create_all``
covers fresh databases and a separate ``GRAPHVER_DB_URL``; this migration covers existing ones.

Revision ID: 20261105_1000_import_results
Revises: 20261103_1200_subset_views
Create Date: 2026-11-05 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from backend.app.services.versioning import config as gv_config

revision: str = "20261105_1000_import_results"
down_revision: Union[str, None] = "20261103_1200_subset_views"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    # A database installed at head has no graphver schema until the versioning worker's bootstrap
    # (create_schema_and_partitions) creates it, and that builds this table from the models.
    if not sa.inspect(bind).has_table("jobs", schema=schema):
        return
    table = f'"{schema}"."import_results"'
    bind.execute(sa.text(
        f"CREATE TABLE IF NOT EXISTS {table} ("
        "job_id text NOT NULL, row_index bigint NOT NULL, kind text NOT NULL, "
        "matched_entity_id text, resolved_op text NOT NULL, reasons jsonb, "
        "CONSTRAINT pk_import_results PRIMARY KEY (job_id, row_index))"))
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_import_results_matched ON {table} (job_id, matched_entity_id)"))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP TABLE IF EXISTS "{schema}"."import_results"'))
