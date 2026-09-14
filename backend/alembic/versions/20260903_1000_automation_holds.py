"""Provider- and fleet-scope holds on automatic rebuilds.

Revision ID: 20260903_1000_automation_holds
Revises: 20260902_1000_derived_artifacts
Create Date: 2026-09-03 10:00

A pause or stop existed at exactly one scope — the source
(``data_source_state.paused_until`` for the timed pause, and
``data_source_state.reconcile_enabled = false`` for the indefinite stop). An
operator who needed to hold a whole provider, or the whole fleet, had to visit
every source. This table carries the two wider scopes, one row per held scope,
with the same two nullable columns the source row has. ``aggregation/holds.py``
resolves them, most restrictive wins, across fleet → provider → source.

Not a column on ``public.providers`` (viz-owned; every aggregation touch of
``public`` is a read), and not a scope-keyed ``aggregation_settings`` row (its
cadence chain is most-SPECIFIC-wins — the opposite rule).

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a bare
create_table here would fail on a brand-new environment while every migrated
database kept working. The Control Plane's ``init_aggregation_db`` creates it
on start as well (it creates every ``aggregation``-schema table), so a CP that
boots before this migration has run is fine too.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_1000_automation_holds"
down_revision: Union[str, None] = "20260902_1000_derived_artifacts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_TABLE = "automation_holds"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table(_TABLE, schema=_SCHEMA):
        return
    op.create_table(
        _TABLE,
        sa.Column("scope", sa.Text(), primary_key=True),
        sa.Column("scope_id", sa.Text(), primary_key=True),
        sa.Column("paused_until", sa.Text(), nullable=True),
        sa.Column("stopped_at", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "scope IN ('fleet', 'provider')", name="ck_automation_holds_scope",
        ),
        schema=_SCHEMA,
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table(_TABLE, schema=_SCHEMA):
        op.drop_table(_TABLE, schema=_SCHEMA)
