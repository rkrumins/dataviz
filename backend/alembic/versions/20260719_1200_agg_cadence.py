"""Configurable rebuild cadence (F9) — per-source override + global cadence.

Revision ID: 20260719_1200_agg_cadence
Revises: 20260718_1200_refresh_events
Create Date: 2026-07-19 12:00

Two additive columns on the ``aggregation`` schema, making the env-only
cooldown/drift knobs overridable at runtime:

* ``data_source_state.rebuild_min_interval_secs`` (INTEGER NULL) — the
  per-source rebuild-cooldown override. NULL = fall through to the
  persisted global, then the env default.
* ``aggregation_settings.cadence_json`` (TEXT NULL) — the persisted GLOBAL
  cadence (``rebuild_min_interval_secs`` + ``drift_auto_rebuild``), kept as
  its own column so cadence never leaks into per-job frozen ``tuning_json``.

Mirrors the ``db_init.py`` additive ``ADD COLUMN IF NOT EXISTS`` safety-net
(CP/Worker). Fresh deploys get both columns from the baseline's
``create_all``; existing DBs get them here. Every step is inspector-guarded,
so it is idempotent both ways.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260719_1200_agg_cadence"
down_revision: Union[str, None] = "20260718_1200_refresh_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SCHEMA = "aggregation"
_STATE = "data_source_state"
_SETTINGS = "aggregation_settings"


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=_SCHEMA)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_STATE, schema=_SCHEMA):
        if "rebuild_min_interval_secs" not in _columns(inspector, _STATE):
            op.add_column(
                _STATE,
                sa.Column("rebuild_min_interval_secs", sa.Integer(), nullable=True),
                schema=_SCHEMA,
            )

    if inspector.has_table(_SETTINGS, schema=_SCHEMA):
        if "cadence_json" not in _columns(inspector, _SETTINGS):
            op.add_column(
                _SETTINGS,
                sa.Column("cadence_json", sa.Text(), nullable=True),
                schema=_SCHEMA,
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_SETTINGS, schema=_SCHEMA):
        if "cadence_json" in _columns(inspector, _SETTINGS):
            op.drop_column(_SETTINGS, "cadence_json", schema=_SCHEMA)

    if inspector.has_table(_STATE, schema=_SCHEMA):
        if "rebuild_min_interval_secs" in _columns(inspector, _STATE):
            op.drop_column(_STATE, "rebuild_min_interval_secs", schema=_SCHEMA)
