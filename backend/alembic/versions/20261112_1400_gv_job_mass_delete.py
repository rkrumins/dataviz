"""``jobs.allow_mass_delete``: a replace import sent with ``allowMassDelete``.

A replace import deletes whatever its file leaves out of its scope. One that would delete most of
a scope and make most of it again — a file whose rows name their entities by another key — is now
refused before it deletes anything (``IMPORT_REPLACE_GUARD``). A replace sent with
``allowMassDelete=true`` deletes all the same; the job keeps that, so a resumed one does too.

Nullable boolean with no default: a catalog change, with no rewrite. The ALTER waits at most five
seconds for the table's lock and is safe to re-run; ``models._ensure_schema_upgrades`` mirrors it
at start-up for a separate ``GRAPHVER_DB_URL`` alembic never reaches. The downgrade drops it: a job
then runs as though sent without it.

Revision ID: 20261112_1400_gv_job_mass_delete
Revises: 20261112_1300_gv_import_row_code
Create Date: 2026-11-12 14:00
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.models import ensure_jobs_mass_delete_column

revision: str = "20261112_1400_gv_job_mass_delete"
down_revision: Union[str, None] = "20261112_1300_gv_import_row_code"
branch_labels = None
depends_on = None


def _bound_lock_wait() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_schema(gv_config.graphver_schema()):
        return                              # create_schema_and_partitions builds it
    _bound_lock_wait()
    ensure_jobs_mass_delete_column(bind)


def downgrade() -> None:
    _bound_lock_wait()
    op.get_bind().execute(sa.text(f'ALTER TABLE "{gv_config.graphver_schema()}"."jobs" '
                                  "DROP COLUMN IF EXISTS allow_mass_delete"))
