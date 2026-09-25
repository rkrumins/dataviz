"""Indexes an import that works a window at a time looks up by.

``node_versions (graph_id, qualified_name)``: a window finds the nodes its rows name by
qualifiedName (a hand-made file's edges usually name their endpoints that way), as it already does
by urn through ``ix_nv_urn``. ``import_rows (job_id, matched_entity_id)``: a replace import asks
which of a page of entities some row of the file matched. Without them each lookup scans every
version row of the graph, or every row of the job.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260927_1000_import_indexes"
down_revision: Union[str, None] = "20260926_1000_object_store"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    inspector = sa.inspect(bind)
    # A database installed at head has no graphver schema until the versioning worker's bootstrap
    # (create_schema_and_partitions) creates it, and that builds both indexes from the models.
    if inspector.has_table("node_versions", schema=schema):
        bind.execute(sa.text(
            f'CREATE INDEX IF NOT EXISTS ix_nv_qname ON "{schema}"."node_versions" (graph_id, qualified_name)'
        ))
    if inspector.has_table("import_rows", schema=schema):
        bind.execute(sa.text(
            f'CREATE INDEX IF NOT EXISTS ix_import_rows_matched ON "{schema}"."import_rows" '
            f"(job_id, matched_entity_id)"
        ))


def downgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_import_rows_matched"'))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}"."ix_nv_qname"'))
