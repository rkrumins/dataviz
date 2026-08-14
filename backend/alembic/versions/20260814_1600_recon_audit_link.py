"""Connect the reconciliation audit trail to Job History.

Revision ID: 20260814_1600_recon_audit_link
Revises: 20260814_1200_agg_reconcile
Create Date: 2026-08-14 16:00

The reconciliation sweep audited its decisions and Job History audited the
rebuilds, and the two halves never met.

  * Every rebuild the sweep queued went through ``signal_source_changed``,
    which hardcoded ``trigger_source='api'``. So an hourly automatic
    reconciliation was indistinguishable in Job History from a person
    clicking Rebuild — the exact question the audit trail exists to answer.
    ``reconcile`` becomes its own trigger source. (The first-build path used
    ``schedule``, which collides with the cron-driven scheduler; it moves to
    ``reconcile`` too, so all four detectors report consistently.)
  * ``refresh_events`` recorded WHY a rebuild was decided on but never which
    job resulted, so nothing could navigate from a finding to its rebuild or
    back. ``job_id`` is a logical reference — no FK, different domain.

Both CHECK constraints are dropped and recreated under their unchanged names,
which is what keeps this safe in all three schema-CI paths: a fresh install
never replays the chain (``create_all`` already emits the new expression), a
forward migration replaces the old one (the real gate), and a chain replay
drops the ``create_all``-produced constraint by name and recreates it
identically.

Plain forward DDL per docs/MIGRATIONS.md.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260814_1600_recon_audit_link"
down_revision: Union[str, None] = "20260814_1200_agg_reconcile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TRIGGERS_BEFORE = (
    "trigger_source IN ('onboarding', 'manual', 'schedule', 'drift', 'api', "
    "'purge', 'post_purge', 'auto')"
)
_TRIGGERS_AFTER = (
    "trigger_source IN ('onboarding', 'manual', 'schedule', 'drift', 'api', "
    "'purge', 'post_purge', 'auto', 'reconcile')"
)


def upgrade() -> None:
    # ── 1. Reconciliation-driven jobs are identifiable ───────────────
    op.drop_constraint(
        "ck_agg_jobs_trigger_source", "jobs",
        type_="check", schema="aggregation",
    )
    op.create_check_constraint(
        "ck_agg_jobs_trigger_source", "jobs", _TRIGGERS_AFTER,
        schema="aggregation",
    )

    # ── 2. The audit event names the job it produced ─────────────────
    op.add_column(
        "refresh_events", sa.Column("job_id", sa.Text(), nullable=True),
    )
    # Job History looks up "why was this job queued" for a page of jobs at a
    # time, so the lookup is by job_id and must not scan.
    op.create_index(
        "idx_refresh_events_job", "refresh_events", ["job_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_refresh_events_job", "refresh_events")
    op.drop_column("refresh_events", "job_id")

    # Any 'reconcile' jobs would violate the restored constraint, so relabel
    # them onto the nearest pre-existing trigger first.
    op.execute(
        "UPDATE aggregation.jobs SET trigger_source = 'api' "
        "WHERE trigger_source = 'reconcile'"
    )
    op.drop_constraint(
        "ck_agg_jobs_trigger_source", "jobs",
        type_="check", schema="aggregation",
    )
    op.create_check_constraint(
        "ck_agg_jobs_trigger_source", "jobs", _TRIGGERS_BEFORE,
        schema="aggregation",
    )
