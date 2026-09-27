"""Allow jobs.job_type = 'publish' (a large draft's publish, run as a job).

A draft that changes more entities than a request can publish (``SYNC_PUBLISH_MAX_CHANGES``) is
published — or has its review merged — by a job the versioning worker's transfer runner claims,
beside imports and exports.

WIDEN-ONLY, as ``20260713_1400_jobs_bootstrap_type`` explains: ``graphver.jobs`` is shared by
several producers, so the new domain is ``required ∪ (SELECT DISTINCT job_type FROM jobs)`` — it
can only grow, and can never fail on rows already there. The downgrade widens too and deletes
nothing. The ORM constraint (``versioning/models.py``) carries the required set for fresh DBs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260928_1000_jobs_publish"
down_revision: Union[str, None] = "20260925_1000_view_saved_queries"
branch_labels = None
depends_on = None

# What the CODE needs to be able to write, on each side of this migration.
_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap", "publish")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap")


def _widen_job_type_check(bind, required: Sequence[str]) -> None:
    """Rebuild ck_jobs_type over `required` ∪ whatever is already in the table."""
    jobs = f'"{gv_config.graphver_schema()}"."jobs"'
    present = {
        row[0] for row in bind.execute(sa.text(f"SELECT DISTINCT job_type FROM {jobs}"))
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + t.replace("'", "''") + "'" for t in allowed)
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type CHECK (job_type IN ({values}))"))


def upgrade() -> None:
    _widen_job_type_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    _widen_job_type_check(op.get_bind(), _REQUIRED_BEFORE)
