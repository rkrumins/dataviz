"""Allow jobs.job_type = 'bootstrap' ("enable version control" jobs).

The bootstrap job MUST NOT share a job_type with anything else: its worker claims
work with ``WHERE job_type = ... AND status IN ('pending', 'running')``, so any job
row it can see, it will run through the bootstrap phase machine. ``'ingest'`` was
already taken by the file-import worker (``import_export/service.py``), which would
have had its jobs hijacked and corrupted. A distinct type makes the two claim sets
disjoint by construction.

WIDEN-ONLY, and deliberately so. ``graphver.jobs`` is a SHARED, multi-producer table
(the file importer, the exporter, this bootstrap worker — and whatever a concurrent
branch is adding right now). A CHECK rebuilt from a hard-coded allow-list is a landmine:
the moment a row exists whose type is not on this migration's list, ``ADD CONSTRAINT``
raises ``CheckViolation`` and wedges alembic — not just here, but for every migration
queued behind it. That has already happened once on this table. So the new domain is
``required ∪ (SELECT DISTINCT job_type FROM jobs)``: it can only ever grow, and it can
never fail on data that is already there. A fresh DB's table is empty, so the union adds
nothing and the schema is not permanently loosened.

The downgrade widens too, and does NOT delete rows. A migration that destroys a user's
job history to satisfy its own CHECK is a worse outcome than a domain that stays a little
wider than the code strictly needs.

The ORM constraint (``versioning/models.py``) carries the required set for fresh DBs,
where ``create_all`` — which never ALTERs — is the only DDL that runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260713_1400_jobs_bootstrap"
down_revision: Union[str, None] = "20260713_1200_restore_kind"
branch_labels = None
depends_on = None

# What the CODE needs to be able to write, on each side of this migration.
_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export")


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
    # Widen-only in reverse as well: keep every type that exists, drop nothing. A downgrade
    # that cannot run — or that has to delete rows to run — is worse than one that leaves the
    # domain slightly wider than the pre-bootstrap code would have written.
    _widen_job_type_check(op.get_bind(), _REQUIRED_BEFORE)
