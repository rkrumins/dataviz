"""Node-identity property (URN-equivalent) on data sources + aggregation jobs.

Revision ID: 20260721_1200_ds_identity_prop
Revises: 20260719_1400_product_events
Create Date: 2026-07-21 12:00

The platform keys every node on a canonical ``urn``, but an ONBOARDED
third-party FalkorDB graph identifies its nodes by a differently-named
property (``id``, ``name``, …) and carries no ``urn``. ``identity_property``
records, per data source, which physical property plays the ``urn`` role so
the read/aggregation stack can resolve endpoints as
``coalesce(n.urn, n[identity_property])`` — leaving conforming graphs (which
have ``urn``) unchanged.

Two columns, both nullable, both defaulting to ``urn`` in application code
when NULL — so every EXISTING row keeps the canonical behaviour with no
backfill:

* ``workspace_data_sources.identity_property`` — the source of truth, editable
  across the data source's whole lifecycle in Data Source settings.
* ``aggregation.aggregation_jobs.identity_property`` — the value FROZEN at
  trigger time, so a mid-lifecycle change to the data source is picked up on
  the NEXT run while an in-flight job keeps its own frozen value.

Mirrors ``models.WorkspaceDataSourceORM`` and ``aggregation.models.
AggregationJobORM`` (and the idempotent startup ALTER in
``aggregation/db_init.py``); this migration is what brings existing databases
in line, since ``create_all`` never alters a live table.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260721_1200_ds_identity_prop"
down_revision: Union[str, None] = "20260719_1400_product_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DS = "workspace_data_sources"
_SCHEMA = "aggregation"
_JOBS = "aggregation_jobs"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        f"ALTER TABLE {_DS} ADD COLUMN IF NOT EXISTS identity_property TEXT"
    ))
    # The aggregation schema/table is created lazily by db_init; only alter it
    # when it already exists so this migration is safe on a public-only DB.
    if sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(
            f"ALTER TABLE {_SCHEMA}.{_JOBS} "
            "ADD COLUMN IF NOT EXISTS identity_property TEXT"
        ))


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(_JOBS, schema=_SCHEMA):
        bind.execute(sa.text(
            f"ALTER TABLE {_SCHEMA}.{_JOBS} DROP COLUMN IF EXISTS identity_property"
        ))
    bind.execute(sa.text(
        f"ALTER TABLE {_DS} DROP COLUMN IF EXISTS identity_property"
    ))
