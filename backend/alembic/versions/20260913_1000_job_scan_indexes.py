"""Indexes for the three queries that run on every tick and every page.

Revision ID: 20260913_1000_job_scan_indexes
Revises: 20260911_1000_cell_ratio
Create Date: 2026-09-13 10:00

``aggregation_jobs`` only grows — one row per rebuild, and with hundreds of
data sources on a schedule (plus drift, the reconcile sweep and the read
path's own backfill) that is 10²-10³ rows a day. Three hot queries had no
index that could serve them, so each one got slower in proportion to a
history it has no interest in:

* the stuck-job reconciler's ``WHERE status IN ('pending','running')``, every
  30 seconds, forever. ``ix_agg_jobs_ds_status`` leads with
  ``data_source_id``, so it cannot answer this at all — the sweep was a
  sequential scan of the whole table, hydrating full ORM entities with
  ``run_stats`` (tens of KB a row) attached. Partial, because active rows are
  a vanishing fraction of the table and the index should be the size of the
  working set, not the archive.
* "the last COMPLETED run of this source", the per-stage ETA baseline, once
  per source per page of Job History.
* "the last FAILURE of this source", the freshness reason, once per source
  per page of the fleet view.

Both of the latter sort an unindexed TEXT column (``completed_at`` /
``updated_at``) across every historical row of the source.

Inspector-guarded like its siblings: ``0001_baseline`` create_all()s the
current ORM, so a brand-new environment already has these and a migrated one
does not.

CONCURRENTLY is deliberately NOT used. It cannot run inside a transaction,
and the migration runner wraps each revision in one; on the row counts this
table reaches in its first year the plain build is seconds, and the
alternative is a bespoke out-of-transaction path for a table that small.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260913_1000_job_scan_indexes"
down_revision: Union[str, None] = "20260911_1000_cell_ratio"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_TABLE = "aggregation_jobs"

_ACTIVE = "ix_agg_jobs_active"
_DS_COMPLETED = "ix_agg_jobs_ds_completed"
_DS_UPDATED = "ix_agg_jobs_ds_updated"


def _index_names(inspector) -> set:
    return {i["name"] for i in inspector.get_indexes(_TABLE, schema=_SCHEMA)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    have = _index_names(inspector)

    if _ACTIVE not in have:
        # The partial predicate is Postgres-only; SQLite (the quickstart)
        # takes the same index unqualified, which is correct there because
        # the table never reaches a size where the distinction matters.
        kwargs = {}
        if bind.dialect.name == "postgresql":
            kwargs["postgresql_where"] = sa.text(
                "status IN ('pending', 'running')"
            )
        op.create_index(_ACTIVE, _TABLE, ["status"], schema=_SCHEMA, **kwargs)

    if _DS_COMPLETED not in have:
        op.create_index(
            _DS_COMPLETED, _TABLE, ["data_source_id", "completed_at"],
            schema=_SCHEMA,
        )

    if _DS_UPDATED not in have:
        op.create_index(
            _DS_UPDATED, _TABLE, ["data_source_id", "updated_at"],
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    have = _index_names(inspector)
    for name in (_DS_UPDATED, _DS_COMPLETED, _ACTIVE):
        if name in have:
            op.drop_index(name, table_name=_TABLE, schema=_SCHEMA)
