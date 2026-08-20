"""Historical entity counts: append-only per-source count snapshots.

Revision ID: 20260820_1200_count_history
Revises: 20260817_1400_recon_pause
Create Date: 2026-08-20 12:00

``data_source_stats`` is a single row per data source, upserted in place —
every previous value is destroyed on write. That makes the current size of a
graph knowable and its history unknowable: nobody can answer "did an external
loader delete half of this on Tuesday", or see a label appear or vanish.

This adds the append-only twin. ``data_source_count_snapshots`` records what a
source looked like at a point in time, per label, with the delta against the
observation it replaced. Rows are written by the same repo function that writes
the current-state row, so every collection lane (60s drift probe, counts poll,
deep profile, reconcile sweep, app write paths) feeds one consistent series.

Capture is change-gated on ``counts_digest`` plus a heartbeat, so the 60s probe
does not produce 1,440 identical rows a day. Two supporting columns carry that:

  * ``data_source_stats.last_snapshot_at`` — the history lane's own cadence
    marker, so the heartbeat decision costs nothing (the row is already loaded
    by the upsert that would capture). Deliberately separate from
    ``last_probed_at``, which belongs to the probe lane.
  * ``platform_settings.history_{retention_days,max_rows_per_source,
    heartbeat_secs}`` — operator overrides above the INSIGHTS_HISTORY_* env
    defaults. NULL means unset, exactly like the identity columns beside them;
    retention is the kind of knob someone changes in response to something, and
    a row carries ``updated_by``.

Inspector-guarded in both directions: ``0001_baseline`` create_all()s the
CURRENT ORM, so a bare ``create_table``/``add_column`` here would make a
brand-new environment unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260820_1200_count_history"
down_revision: Union[str, None] = "20260817_1400_recon_pause"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SNAPSHOTS = "data_source_count_snapshots"
_STATS = "data_source_stats"
_SETTINGS = "platform_settings"

_STATS_COLUMNS = (("last_snapshot_at", sa.Text()),)

_SETTINGS_COLUMNS = (
    ("history_retention_days", sa.Integer()),
    ("history_max_rows_per_source", sa.Integer()),
    ("history_heartbeat_secs", sa.Integer()),
)

# (name, columns) — created only when absent, dropped only when present.
_SNAPSHOT_INDEXES = (
    ("ix_dscs_ds_captured", ["data_source_id", "captured_at"]),
    ("ix_dscs_captured", ["captured_at"]),
    ("ix_dscs_provider_captured", ["provider_id", "captured_at"]),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_SNAPSHOTS):
        op.create_table(
            _SNAPSHOTS,
            sa.Column("id", sa.Text(), primary_key=True),
            # No FK to workspace_data_sources, unlike data_source_stats: this
            # is an audit trail, and the history of a source that was removed
            # is exactly the history someone comes looking for. Logical
            # reference, same convention as refresh_events.
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("captured_at", sa.Text(), nullable=False),
            # Denormalised so the per-provider rollup reads this table alone
            # instead of JOINing out of the stats domain, and so a row still
            # names what it described after its source row is gone.
            sa.Column("workspace_id", sa.Text(), nullable=True),
            sa.Column("provider_id", sa.Text(), nullable=True),
            sa.Column("graph_name", sa.Text(), nullable=True),
            sa.Column("node_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("edge_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "entity_type_counts", sa.Text(), nullable=False, server_default="{}",
            ),
            sa.Column(
                "edge_type_counts", sa.Text(), nullable=False, server_default="{}",
            ),
            sa.Column("counts_digest", sa.Text(), nullable=False, server_default=""),
            sa.Column("lane", sa.Text(), nullable=False, server_default="poll"),
            sa.Column(
                "capture_reason", sa.Text(), nullable=False, server_default="changed",
            ),
            sa.Column("prev_captured_at", sa.Text(), nullable=True),
            sa.Column("node_delta", sa.Integer(), nullable=True),
            sa.Column("edge_delta", sa.Integer(), nullable=True),
            sa.Column("type_deltas", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "lane IN ('probe', 'poll', 'deep', 'sweep', 'write')",
                name="ck_dscs_lane",
            ),
            sa.CheckConstraint(
                "capture_reason IN ('first', 'changed', 'heartbeat')",
                name="ck_dscs_reason",
            ),
        )
        inspector = sa.inspect(bind)

    if inspector.has_table(_SNAPSHOTS):
        present = _index_names(inspector, _SNAPSHOTS)
        for name, cols in _SNAPSHOT_INDEXES:
            if name not in present:
                op.create_index(name, _SNAPSHOTS, cols)

    if inspector.has_table(_STATS):
        present = _columns(inspector, _STATS)
        for name, col_type in _STATS_COLUMNS:
            if name not in present:
                op.add_column(_STATS, sa.Column(name, col_type, nullable=True))

    if inspector.has_table(_SETTINGS):
        present = _columns(inspector, _SETTINGS)
        for name, col_type in _SETTINGS_COLUMNS:
            if name not in present:
                op.add_column(_SETTINGS, sa.Column(name, col_type, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table(_SETTINGS):
        present = _columns(inspector, _SETTINGS)
        for name, _col_type in reversed(_SETTINGS_COLUMNS):
            if name in present:
                op.drop_column(_SETTINGS, name)

    if inspector.has_table(_STATS):
        present = _columns(inspector, _STATS)
        for name, _col_type in reversed(_STATS_COLUMNS):
            if name in present:
                op.drop_column(_STATS, name)

    if inspector.has_table(_SNAPSHOTS):
        present = _index_names(inspector, _SNAPSHOTS)
        for name, _cols in reversed(_SNAPSHOT_INDEXES):
            if name in present:
                op.drop_index(name, _SNAPSHOTS)
        op.drop_table(_SNAPSHOTS)
