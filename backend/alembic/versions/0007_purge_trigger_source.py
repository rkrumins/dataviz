"""Add ``purge`` to aggregation_jobs trigger_source constraint.

Revision ID: 0007_purge_trigger_source
Revises: 0006_view_visibility_enterprise
Create Date: 2026-04-16

Purge operations now create a completed job record in aggregation_jobs
for audit trail purposes.  The existing check constraint only allows
``('onboarding', 'manual', 'schedule', 'drift', 'api')`` — this
migration widens it to also accept ``'purge'``.

Idempotent (``DROP ... IF EXISTS``) so re-running is safe.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0007_purge_trigger_source"
down_revision: Union[str, None] = "0006_view_visibility_enterprise"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE aggregation_jobs DROP CONSTRAINT IF EXISTS ck_agg_jobs_trigger_source")
    op.execute(
        "ALTER TABLE aggregation_jobs ADD CONSTRAINT ck_agg_jobs_trigger_source "
        "CHECK (trigger_source IN ('onboarding', 'manual', 'schedule', 'drift', 'api', 'purge'))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE aggregation_jobs DROP CONSTRAINT IF EXISTS ck_agg_jobs_trigger_source")
    op.execute(
        "ALTER TABLE aggregation_jobs ADD CONSTRAINT ck_agg_jobs_trigger_source "
        "CHECK (trigger_source IN ('onboarding', 'manual', 'schedule', 'drift', 'api'))"
    )
