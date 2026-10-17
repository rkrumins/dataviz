"""Who triggered an aggregation job, and why.

Revision ID: 20261010_1100_job_provenance
Revises: 20261010_1000_activity_ledger
Create Date: 2026-10-10 11:00

A job row said HOW it started (``trigger_source``: manual, schedule,
drift…) but never WHO started it: the web tier never passed the person to
the service, and in proxy mode never forwarded them to the control plane.
``triggered_by`` is the person (NULL for automation and for every run before
this), ``stated_reason`` the "why" they gave, if any — the same values the
``aggregation.job.triggered`` event records in the activity ledger, kept on
the row so Job History can show and filter by them without a join.

Inspector-guarded, like its siblings — 0001_baseline create_all()s the
current ORM — and mirrored in ``init_aggregation_db``'s additive list, so a
Control Plane that boots before this migration runs gets the columns too.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261010_1100_job_provenance"
down_revision: Union[str, None] = "20261010_1000_activity_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_TABLE = "aggregation_jobs"
_COLUMNS = ("triggered_by", "stated_reason")
_INDEX = "ix_agg_jobs_triggered_by"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    have = {c["name"] for c in inspector.get_columns(_TABLE, schema=_SCHEMA)}
    for column in _COLUMNS:
        if column not in have:
            op.add_column(
                _TABLE, sa.Column(column, sa.Text(), nullable=True), schema=_SCHEMA,
            )
    if _INDEX not in {i["name"] for i in inspector.get_indexes(_TABLE, schema=_SCHEMA)}:
        op.create_index(_INDEX, _TABLE, ["triggered_by", "created_at"], schema=_SCHEMA)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    if _INDEX in {i["name"] for i in inspector.get_indexes(_TABLE, schema=_SCHEMA)}:
        op.drop_index(_INDEX, table_name=_TABLE, schema=_SCHEMA)
    have = {c["name"] for c in inspector.get_columns(_TABLE, schema=_SCHEMA)}
    for column in _COLUMNS:
        if column in have:
            op.drop_column(_TABLE, column, schema=_SCHEMA)
