"""Import/Export (bulk CRUD) schema — extend graphver.jobs + new graphver.import_rows.

Plan Phase 0.2/0.3. Additive and idempotent (safe to re-run):
* ``jobs`` gains the import/export metadata columns (full ws/data-source/provider/graph
  traceability + pipeline params + artifact URIs + summary), and its ``ck_jobs_type`` check is
  widened to allow ``'export'``; a new ``ix_jobs_ds`` indexes jobs by data source.
* new ``import_rows`` staging table (parsed-once, cursor-ordered, GC'd by job).

The ORM (``versioning/models.py``) declares the same columns/table so ``create_all`` covers
fresh/test databases; this migration covers existing ones.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260704_1400_import_export"
down_revision: Union[str, None] = "20260704_1300_view_data_updated"
branch_labels = None
depends_on = None


# column name -> SQL type, added to graphver.jobs
_JOB_COLS = {
    "data_source_id": "text",
    "provider_id": "text",
    "scope_view_id": "text",
    "branch_id": "text",
    "reconcile_mode": "text",
    "identity_strategy": "text",
    "on_invalid": "text",
    "import_format": "text",
    "field_scope": "jsonb",
    "auto_publish": "boolean NOT NULL DEFAULT false",
    "source_uri": "text",
    "preview_uri": "text",
    "report_uri": "text",
    "result_uri": "text",
    "base_commit_seq": "bigint",
    "preview_digest": "text",
    "as_of_seq": "bigint",
    "summary": "jsonb",
}


def _schema() -> str:
    return gv_config.graphver_schema()


def upgrade() -> None:
    bind = op.get_bind()
    schema = _schema()
    jobs = f'"{schema}"."jobs"'
    rows = f'"{schema}"."import_rows"'

    for col, typ in _JOB_COLS.items():
        bind.execute(sa.text(f"ALTER TABLE {jobs} ADD COLUMN IF NOT EXISTS {col} {typ}"))

    # Widen the job_type check to include 'export'.
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type "
        f"CHECK (job_type IN ('ingest','projection','rebuild','export'))"
    ))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_jobs_ds ON {jobs} (data_source_id, status)'
    ))

    # Staging table for async imports.
    bind.execute(sa.text(f"""
        CREATE TABLE IF NOT EXISTS {rows} (
            job_id            text   NOT NULL,
            row_index         bigint NOT NULL,
            kind              text   NOT NULL,
            raw               jsonb  NOT NULL,
            match_key         text,
            matched_entity_id text,
            resolved_op       text,
            status            text,
            reasons           jsonb,
            content_hash      text,
            base_content_hash text,
            CONSTRAINT pk_import_rows PRIMARY KEY (job_id, row_index),
            CONSTRAINT ck_import_rows_kind CHECK (kind IN ('node','edge'))
        )
    """))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_import_rows_match ON {rows} (job_id, kind, match_key)'
    ))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_import_rows_status ON {rows} (job_id, status)'
    ))


def downgrade() -> None:
    bind = op.get_bind()
    schema = _schema()
    jobs = f'"{schema}"."jobs"'
    rows = f'"{schema}"."import_rows"'

    bind.execute(sa.text(f"DROP TABLE IF EXISTS {rows}"))
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type "
        f"CHECK (job_type IN ('ingest','projection','rebuild'))"
    ))
    bind.execute(sa.text(f'DROP INDEX IF EXISTS "{schema}".ix_jobs_ds'))
    for col in _JOB_COLS:
        bind.execute(sa.text(f"ALTER TABLE {jobs} DROP COLUMN IF EXISTS {col}"))
