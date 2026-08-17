"""Node-identity mapping at provider, workspace and platform scope.

Revision ID: 20260817_1200_node_identity_scopes
Revises: 20260802_1000_open_publishing
Create Date: 2026-08-17 12:00

``identity_property`` / ``name_property`` already exist on
``workspace_data_sources`` (20260721_1200, 20260721_1500) but ONLY there, so an
operator onboarding many graphs off one connection had to repeat the same
mapping per source, and a platform-wide preference could not be expressed at
all. This adds the other three levels of the resolution chain
(``backend/app/services/node_identity.py``):

    data source → provider → workspace → platform default → code default

Two nullable columns per level, no backfill and no server default: NULL means
"unset, fall through", which is exactly what every existing row should mean, so
this migration cannot change how any current data source resolves.

``platform_settings`` is the bottom of the chain — a single row (``id = 1``,
CHECK-constrained like ``management_db_config``) carrying ``updated_by`` so a
platform-wide mapping is attributable. Deliberately a row rather than an env
var: the previous global ``AGGREGATION_NODE_IDENTITY_PROPERTY`` was removed
because an env var applied everywhere invisibly and could not be audited.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260817_1200_node_identity_scopes"
down_revision: Union[str, None] = "20260802_1000_open_publishing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCOPED_TABLES = ("providers", "workspaces")
_PLATFORM = "platform_settings"


def upgrade() -> None:
    bind = op.get_bind()
    for table in _SCOPED_TABLES:
        bind.execute(sa.text(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS identity_property TEXT"
        ))
        bind.execute(sa.text(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS name_property TEXT"
        ))

    if not sa.inspect(bind).has_table(_PLATFORM):
        op.create_table(
            _PLATFORM,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("identity_property", sa.Text(), nullable=True),
            sa.Column("name_property", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=True),
            sa.Column("updated_by", sa.Text(), nullable=True),
            sa.CheckConstraint("id = 1", name="ck_platform_settings_single_row"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(_PLATFORM):
        op.drop_table(_PLATFORM)
    for table in _SCOPED_TABLES:
        bind.execute(sa.text(
            f"ALTER TABLE {table} DROP COLUMN IF EXISTS name_property"
        ))
        bind.execute(sa.text(
            f"ALTER TABLE {table} DROP COLUMN IF EXISTS identity_property"
        ))
