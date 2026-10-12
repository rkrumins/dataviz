"""The remaining profiling knobs an operator can set without a redeploy.

Revision ID: 20260824_1400_profiling_policy
Revises: 20260824_1300_alert_finding
Create Date: 2026-08-24 14:00

``platform_settings`` already carried the hourly window (under its original
name ``history_retention_days``), the raw row cap and the heartbeat. It did not
carry the raw or daily windows — so ``PUT /profiling/policy`` accepted
``rawRetentionDays`` and ``dailyRetentionDays``, answered 200, and dropped
them. An API that accepts a setting and ignores it is worse than one that
refuses it: the operator has no way to tell.

``profiling_silent_after_secs`` joins them because how patient to be before
calling a source silent is a product judgement, not a deployment one.

The tier CADENCES stay environment-only on purpose. Compaction interval,
retention interval and alert interval decide how hard the service works, and a
live-editable compaction interval is a way to wedge retention from a settings
page — the purge cannot delete raw beyond the compaction watermark.

Inspector-guarded in both directions: ``0001_baseline`` create_all()s the
CURRENT ORM, so a bare ``add_column`` here would make a brand-new environment
unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_1400_profiling_policy"
down_revision: Union[str, None] = "20260824_1300_alert_finding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SETTINGS = "platform_settings"

_COLUMNS = (
    ("profiling_raw_retention_days", sa.Integer()),
    ("profiling_daily_retention_days", sa.Integer()),
    ("profiling_silent_after_secs", sa.Integer()),
)


def _columns(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    present = _columns(inspector, _SETTINGS)
    for name, col_type in _COLUMNS:
        if name not in present:
            # Nullable with no default: NULL means "nobody has set this", which
            # is a different state from any value an operator could choose.
            op.add_column(_SETTINGS, sa.Column(name, col_type, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    present = _columns(inspector, _SETTINGS)
    for name, _col_type in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_SETTINGS, name)
