"""Drift probe: cheap counts fingerprint + per-source probe cadence.

Revision ID: 20260817_1200_drift_probe
Revises: 20260815_1200_recon_ops
Create Date: 2026-08-17 12:00

Drift detection used to be chained to the stats service's full-graph scan,
so a source that changed could stay wrong for the better part of an hour.
The probe lane replaces that scan with constant-time counts, and these
columns are what let the sweeper notice the result without doing any work
of its own:

  * ``data_source_stats.counts_digest`` — a digest of every count the probe
    just read, AGGREGATED included, paired with
    ``data_source_state.last_seen_counts_digest`` which the sweep stamps at
    each evaluation. ``IS DISTINCT FROM`` between the two turns "did anything
    move since we last looked" into a pure-SQL predicate, so the sweep does
    work proportional to what actually changed rather than to how often we
    probe. AGGREGATED is included on purpose: excluding it (as the drift
    BASELINE must) would blind the tripwire to a wiped overlay sitting on
    unchanged raw data, which is the exact failure this exists to catch.
  * ``data_source_stats.last_probed_at`` — the probe scheduler's own
    cadence marker. Deliberately NOT ``data_source_polling_configs.
    last_polled_at``, which belongs to the (much slower) stats poll; the two
    lanes must be able to run at completely different frequencies.
  * ``data_source_state.probe_{enabled,interval_secs}`` — the per-source
    overrides the Freshness drawer writes, resolved override → global →
    env by the same chain as every other reconcile setting.

Inspector-guarded in both directions: ``0001_baseline`` create_all()s the
CURRENT ORM, so a bare ``add_column`` here would make a brand-new
environment unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260817_1200_drift_probe"
down_revision: Union[str, None] = "20260815_1200_recon_ops"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_AGG_SCHEMA = "aggregation"
_STATE = "data_source_state"
_STATS = "data_source_stats"

_STATS_COLUMNS = (
    ("counts_digest", sa.Text()),
    ("last_probed_at", sa.Text()),
)

_STATE_COLUMNS = (
    ("probe_enabled", sa.Boolean()),
    ("probe_interval_secs", sa.Integer()),
    ("last_seen_counts_digest", sa.Text()),
)

_PROBE_DUE_INDEX = "ix_ds_stats_probe_due"


def _columns(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str, *, schema: str | None = None) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table, schema=schema)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_STATS):
        present = _columns(inspector, _STATS)
        for name, col_type in _STATS_COLUMNS:
            if name not in present:
                op.add_column(_STATS, sa.Column(name, col_type, nullable=True))
        # Oldest-probed-first is the scheduler's whole selection strategy, so
        # without this it degrades to a fleet-wide sort on every tick.
        if _PROBE_DUE_INDEX not in _index_names(inspector, _STATS):
            op.create_index(_PROBE_DUE_INDEX, _STATS, ["last_probed_at"])

    if inspector.has_table(_STATE, schema=_AGG_SCHEMA):
        present = _columns(inspector, _STATE, schema=_AGG_SCHEMA)
        for name, col_type in _STATE_COLUMNS:
            if name not in present:
                op.add_column(
                    _STATE,
                    sa.Column(name, col_type, nullable=True),
                    schema=_AGG_SCHEMA,
                )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_STATE, schema=_AGG_SCHEMA):
        present = _columns(inspector, _STATE, schema=_AGG_SCHEMA)
        for name, _col_type in reversed(_STATE_COLUMNS):
            if name in present:
                op.drop_column(_STATE, name, schema=_AGG_SCHEMA)

    if inspector.has_table(_STATS):
        if _PROBE_DUE_INDEX in _index_names(inspector, _STATS):
            op.drop_index(_PROBE_DUE_INDEX, _STATS)
        present = _columns(inspector, _STATS)
        for name, _col_type in reversed(_STATS_COLUMNS):
            if name in present:
                op.drop_column(_STATS, name)
