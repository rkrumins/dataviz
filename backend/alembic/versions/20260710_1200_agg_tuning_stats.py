"""Aggregation Iteration-2 columns + settings table.

Revision ID: 20260710_1200_agg_tuning_stats
Revises: 20260707_1400_view_layout_overlays
Create Date: 2026-07-10 12:00

Adds the ``aggregation.aggregation_jobs`` columns introduced by the
self-tuning pipeline and worker fleet work, plus the global-defaults
table, to the Alembic-managed migration path:

* ``entity_type_levels`` — entity-type → hierarchy-level map frozen at
  trigger time (drives the materialization boundary + per-label
  indexing without an ontology-module dependency in the worker).
* ``tuning_json``        — per-job pipeline knob overrides, frozen at
  trigger so workers stay stateless.
* ``run_stats``          — per-phase durations + writes/deletes,
  persisted on completion for the job-detail phase stepper.
* ``worker_id``          — which worker executed the job (fleet
  attribution in the UI).
* ``aggregation.aggregation_settings`` — single-row global tuning
  defaults edited via GET/PUT /aggregation/settings.

These previously existed only in the Control-Plane/Worker safety-net
init (``backend/app/services/aggregation/db_init.py`` additive
``ADD COLUMN IF NOT EXISTS`` list). Deployments whose schema is managed
solely by the upgrade service therefore failed with
``UndefinedColumnError: column aggregation_jobs.tuning_json does not
exist`` as soon as the viz-service ORM SELECTed the model.

Idempotent both ways: fresh deploys get every column from the
baseline's ``create_all``; databases already touched by ``db_init.py``
have some or all pieces — every step is inspector-guarded.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260710_1200_agg_tuning_stats"
down_revision: Union[str, None] = "20260707_1400_view_layout_overlays"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SCHEMA = "aggregation"
_JOBS = "aggregation_jobs"
_SETTINGS = "aggregation_settings"

_JOB_COLUMNS = (
    "entity_type_levels",
    "tuning_json",
    "run_stats",
    "worker_id",
)


def _existing_columns(inspector: sa.engine.reflection.Inspector) -> set:
    return {c["name"] for c in inspector.get_columns(_JOBS, schema=_SCHEMA)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_JOBS, schema=_SCHEMA):
        present = _existing_columns(inspector)
        for name in _JOB_COLUMNS:
            if name not in present:
                op.add_column(
                    _JOBS,
                    sa.Column(name, sa.Text(), nullable=True),
                    schema=_SCHEMA,
                )

    if not inspector.has_table(_SETTINGS, schema=_SCHEMA):
        op.create_table(
            _SETTINGS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("tuning_json", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=True),
            sa.Column("updated_by", sa.Text(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_JOBS, schema=_SCHEMA):
        present = _existing_columns(inspector)
        for name in _JOB_COLUMNS:
            if name in present:
                op.drop_column(_JOBS, name, schema=_SCHEMA)

    if inspector.has_table(_SETTINGS, schema=_SCHEMA):
        op.drop_table(_SETTINGS, schema=_SCHEMA)
