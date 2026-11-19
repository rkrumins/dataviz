"""Allow jobs.job_type = 'save': a draft save too large for one request, sent in parts and written
as one commit by the transfer lane.

WIDEN-ONLY, as ``20260713_1400_jobs_bootstrap_type`` explains: the domain becomes
``required ∪ (SELECT DISTINCT job_type FROM jobs)``, and the downgrade widens too and deletes
nothing. ``models._ensure_schema_upgrades`` applies the same widening to a separate
``GRAPHVER_DB_URL`` that alembic never reaches.

Revision ID: 20261117_1400_gv_save_jobs
Revises: 20261117_1300_gv_decisions
Create Date: 2026-11-17 14:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from backend.app.services.versioning.models import widen_job_type_check

revision: str = "20261117_1400_gv_save_jobs"
down_revision: Union[str, None] = "20261117_1300_gv_decisions"
branch_labels = None
depends_on = None

_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap", "publish",
                            "purge", "package_inspect", "fork_update", "fork_merge", "save")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap",
                                   "publish", "purge", "package_inspect", "fork_update", "fork_merge")


def upgrade() -> None:
    widen_job_type_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    widen_job_type_check(op.get_bind(), _REQUIRED_BEFORE)
