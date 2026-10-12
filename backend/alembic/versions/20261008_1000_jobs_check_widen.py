"""Allow jobs.job_type = 'purge' (again) and 'package_inspect'.

Two types the code writes that ``ck_jobs_type`` may refuse:

* ``purge`` — added by ``20260714_1000_graph_lifecycle``, then DROPPED by
  ``20260928_1000_jobs_publish`` on every database that held no purge row at the time: that
  migration rebuilt the check from a required list that forgot it. A fresh database built from the
  models never had it either. Deleting a data source permanently then failed at the INSERT.
* ``package_inspect`` — a view package upload is checked by a job on the transfer lane's
  dedicated inspect slot, not inside the request.

WIDEN-ONLY, as ``20260713_1400_jobs_bootstrap_type`` explains: the domain becomes
``required ∪ (SELECT DISTINCT job_type FROM jobs)``, and the downgrade widens too and deletes
nothing. The helper is shared with ``models._ensure_schema_upgrades``, which applies the same
widening to a separate ``GRAPHVER_DB_URL`` that alembic never reaches.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from backend.app.services.versioning.models import widen_job_type_check

revision: str = "20261008_1000_jobs_check_widen"
down_revision: Union[str, None] = "20260930_1000_outbox_type_time"
branch_labels = None
depends_on = None

# What the CODE needs to be able to write, on each side of this migration.
_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap", "publish",
                            "purge", "package_inspect")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap",
                                   "publish")


def upgrade() -> None:
    widen_job_type_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    widen_job_type_check(op.get_bind(), _REQUIRED_BEFORE)
