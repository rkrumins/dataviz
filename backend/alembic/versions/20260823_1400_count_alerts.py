"""Counts anomalies: recorded alerts plus the policy behind them.

Revision ID: 20260823_1400_count_alerts
Revises: 20260823_1300_count_history
Create Date: 2026-08-21 12:00

``data_source_count_snapshots`` records what happened to a graph. This records
what was worth telling someone about, and it is a separate table rather than a
flag on the snapshot for two reasons:

  * They age differently. Snapshots are a dense series purged on a retention
    window; an alert is sparse, is acknowledged by a person, and has to still
    be there when someone follows a notification days later — after the
    snapshot that produced it may well have been purged. Everything needed to
    explain the alert is therefore frozen on the alert row itself.
  * The verdict is not reproducible after the fact. Significance is measured
    against the baseline of the window it was evaluated in, and that window
    moves. Recomputing an old alert against today's baseline could quietly
    downgrade it to "normal", so the classification and its evidence are
    written once and never derived again.

``platform_settings`` gains the policy: whether alerting is on, the severity
floor, and a per-source cooldown. Same NULL-means-inherit semantics as the
retention columns beside them. ``history_alerts_enabled`` is a NULLABLE boolean
on purpose — "an operator turned this off" and "nobody has ever touched it" are
different states, and only the first should override the deployment default.

Inspector-guarded in both directions: ``0001_baseline`` create_all()s the
CURRENT ORM, so unguarded DDL here would make a brand-new environment
unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260823_1400_count_alerts"
down_revision: Union[str, None] = "20260823_1300_count_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ALERTS = "data_source_count_alerts"
_SETTINGS = "platform_settings"

_SETTINGS_COLUMNS = (
    ("history_alerts_enabled", sa.Boolean()),
    ("history_alert_min_severity", sa.Text()),
    ("history_alert_cooldown_secs", sa.Integer()),
)

_ALERT_INDEXES = (
    ("ix_dsca_ds_detected", ["data_source_id", "detected_at"]),
    ("ix_dsca_open", ["acknowledged_at", "detected_at"]),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def _index_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_ALERTS):
        op.create_table(
            _ALERTS,
            sa.Column("id", sa.Text(), primary_key=True),
            # No FK, same reasoning as the snapshots: an alert about a source
            # someone then deleted is precisely the one worth keeping.
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("snapshot_id", sa.Text(), nullable=True),
            sa.Column("detected_at", sa.Text(), nullable=False),
            # NOT the same instant as detected_at: evaluation runs on a tick,
            # so the movement precedes its detection by up to one interval.
            sa.Column("observed_at", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.Text(), nullable=True),
            sa.Column("provider_id", sa.Text(), nullable=True),
            sa.Column("graph_name", sa.Text(), nullable=True),
            # Resolved at alert time so the notification can deep-link into
            # the history view, which is routed by catalog id.
            sa.Column("catalog_item_id", sa.Text(), nullable=True),
            sa.Column("severity", sa.Text(), nullable=False),
            sa.Column("direction", sa.Text(), nullable=False),
            sa.Column("node_delta", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("node_count", sa.Integer(), nullable=False, server_default="0"),
            # Frozen so the UI can say "unusual compared to WHAT".
            sa.Column("baseline", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("evidence", sa.Text(), nullable=True),
            sa.Column("acknowledged_at", sa.Text(), nullable=True),
            sa.Column("acknowledged_by", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "severity IN ('notable', 'severe')", name="ck_dsca_severity",
            ),
            sa.CheckConstraint(
                "direction IN ('drop', 'rise')", name="ck_dsca_direction",
            ),
        )
        inspector = sa.inspect(bind)

    if inspector.has_table(_ALERTS):
        present = _index_names(inspector, _ALERTS)
        for name, cols in _ALERT_INDEXES:
            if name not in present:
                op.create_index(name, _ALERTS, cols)

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

    if inspector.has_table(_ALERTS):
        present = _index_names(inspector, _ALERTS)
        for name, _cols in reversed(_ALERT_INDEXES):
            if name in present:
                op.drop_index(name, _ALERTS)
        op.drop_table(_ALERTS)
