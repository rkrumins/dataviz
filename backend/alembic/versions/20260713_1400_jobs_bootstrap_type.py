"""Allow jobs.job_type = 'bootstrap' ("enable version control" jobs).

The bootstrap job MUST NOT share a job_type with anything else: its worker claims
work with ``WHERE job_type = ... AND status IN ('pending', 'running')``, so any job
row it can see, it will run through the bootstrap phase machine. ``'ingest'`` was
already taken by the file-import worker (``import_export/service.py``), which would
have had its jobs hijacked and corrupted. A distinct type makes the two claim sets
disjoint by construction.

The ``ck_jobs_type`` CHECK is swapped in place; the ORM constraint
(``versioning/models.py``) carries the same set for fresh DBs.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260713_1400_jobs_bootstrap"
down_revision: Union[str, None] = "20260713_1200_restore_kind"
branch_labels = None
depends_on = None

_WITH = "'ingest','projection','rebuild','export','bootstrap'"
_WITHOUT = "'ingest','projection','rebuild','export'"


def upgrade() -> None:
    bind = op.get_bind()
    jobs = f'"{gv_config.graphver_schema()}"."jobs"'
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type CHECK (job_type IN ({_WITH}))"))


def downgrade() -> None:
    bind = op.get_bind()
    jobs = f'"{gv_config.graphver_schema()}"."jobs"'
    bind.execute(sa.text(
        f"DELETE FROM {jobs} WHERE job_type = 'bootstrap'"))       # else the CHECK fails
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type CHECK (job_type IN ({_WITHOUT}))"))
