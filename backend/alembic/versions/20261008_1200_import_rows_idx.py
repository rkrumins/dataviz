"""``import_rows``: index what an import window reads, drop what nothing reads.

A windowed import reads one kind's staged rows in parse order — ``WHERE job_id = :j AND kind = :k
AND row_index > :cursor ORDER BY row_index`` — which the ``(job_id, row_index)`` primary key can
only answer by walking the other kind's rows too. ``ix_import_rows_kind_row`` answers it directly.
``ix_import_rows_match`` (job, kind, match_key) and ``ix_import_rows_status`` (job, status) serve
no query and only slow every staged batch down.

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20261008_1200_import_rows_idx"
down_revision: Union[str, None] = "20261008_1100_bootstrap_nodes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    # A database installed at head has no graphver schema until the versioning worker's bootstrap
    # (create_schema_and_partitions) creates it, and that builds the indexes from the models.
    if not sa.inspect(bind).has_table("import_rows", schema=schema):
        return
    rows = f'"{schema}"."import_rows"'
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_import_rows_kind_row ON {rows} (job_id, kind, row_index)"))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_import_rows_match"'))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_import_rows_status"'))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    if not sa.inspect(bind).has_table("import_rows", schema=schema):
        return
    rows = f'"{schema}"."import_rows"'
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_import_rows_match ON {rows} (job_id, kind, match_key)"))
    bind.execute(sa.text(
        f"CREATE INDEX IF NOT EXISTS ix_import_rows_status ON {rows} (job_id, status)"))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_import_rows_kind_row"'))
