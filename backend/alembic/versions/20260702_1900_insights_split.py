"""Insights stats split: deep-facet freshness column + relaxed idle interval.

* ``data_source_stats.schema_updated_at`` — stamped by the new
  ``stats_deep`` job (full schema-stats scan set + ontology + graph
  schema) and read by the scheduler's deep due-check. ``updated_at``
  keeps tracking the cheap counts facet.
* Backfill ``data_source_polling_configs.interval_seconds`` 300 → 900:
  the idle default relaxes because counts freshness is now event-driven
  (app write paths enqueue a counts poll directly) and the read path
  already enqueues on stale for actively-viewed sources. Rows the
  operator tuned away from the old default are left untouched.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260702_1900_insights_split"
down_revision: Union[str, None] = "20260615_1200_branch_description"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats ADD COLUMN IF NOT EXISTS schema_updated_at text"
    ))
    bind.execute(sa.text(
        "UPDATE data_source_polling_configs SET interval_seconds = 900 "
        "WHERE interval_seconds = 300"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE data_source_stats DROP COLUMN IF EXISTS schema_updated_at"
    ))
    # interval_seconds backfill is intentionally not reverted — 900 is a
    # valid operator-tunable value either way.
