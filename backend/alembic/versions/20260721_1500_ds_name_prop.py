"""Node display-name property on data sources + aggregation jobs.

Revision ID: 20260721_1500_ds_name_prop
Revises: 20260721_1200_ds_identity_prop
Create Date: 2026-07-21 15:00

Symmetric to ``identity_property`` (20260721_1200_ds_identity_prop). An onboarded
graph may hold its human node name under a property other than the platform's
``displayName`` (e.g. ``name``/``title``), which would render a blank label.
``name_property`` records that property per data source; the aggregation run
stamps it onto ``displayName``, and the read serializer falls back through
``name``/``title``/``label`` meanwhile.

Two nullable columns, both defaulting to ``name`` in application code when NULL
(no backfill): ``workspace_data_sources.name_property`` (source of truth,
editable in Data Source settings) and ``aggregation.aggregation_jobs.name_property``
(frozen at trigger time). Mirrors the ORM + the idempotent startup ALTER in
``aggregation/db_init.py``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260721_1500_ds_name_prop"
down_revision: Union[str, None] = "20260721_1200_ds_identity_prop"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DS = "workspace_data_sources"
_SCHEMA = "aggregation"
_JOBS = "aggregation_jobs"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        f"ALTER TABLE {_DS} ADD COLUMN IF NOT EXISTS name_property TEXT"
    ))
    if sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(
            f"ALTER TABLE {_SCHEMA}.{_JOBS} "
            "ADD COLUMN IF NOT EXISTS name_property TEXT"
        ))


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(
            f"ALTER TABLE {_SCHEMA}.{_JOBS} DROP COLUMN IF EXISTS name_property"
        ))
    bind.execute(sa.text(
        f"ALTER TABLE {_DS} DROP COLUMN IF EXISTS name_property"
    ))
