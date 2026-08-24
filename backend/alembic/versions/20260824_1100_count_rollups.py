"""Compacted profile tiers: one row per source per time bucket.

Revision ID: 20260824_1100_count_rollups
Revises: 20260823_1500_alert_identity
Create Date: 2026-08-24 11:00

Raw snapshots record what was OBSERVED; this records what a PERIOD looked
like. Both are needed because they age differently — raw resolution matters
for days and is ruinous to keep for months, while a 30-day trend is cheap
forever.

Retention was previously an age cutoff plus a per-source row cap, and the cap
could evict a thrashing source below the 30-day floor the product promises.
That is exactly backwards: the source moving hardest is the one whose history
someone will come looking for. Compacting raw into hour buckets before raw is
purged, and hour into day, makes coverage outlive resolution — a day bucket is
one row however violently the source moved inside it.

Per source only. Workspace, provider and platform series are sums of these
rows at read time. Materialising those scopes would be four things to keep in
agreement plus a membership ledger, which is how :AGGREGATED weights got
silently double-counted once already.

Inspector-guarded in both directions: ``0001_baseline`` create_all()s the
CURRENT ORM, so a bare ``create_table`` here would make a brand-new
environment unbuildable while every migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_1100_count_rollups"
down_revision: Union[str, None] = "20260823_1500_alert_identity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ROLLUPS = "data_source_count_rollups"

# (name, columns) — created only when absent, dropped only when present.
_ROLLUP_INDEXES = (
    ("ix_dscr_ds_grain_bucket", ["data_source_id", "grain", "bucket_start"]),
    ("ix_dscr_grain_bucket", ["grain", "bucket_start"]),
    ("ix_dscr_provider_grain_bucket", ["provider_id", "grain", "bucket_start"]),
    ("ix_dscr_ws_grain_bucket", ["workspace_id", "grain", "bucket_start"]),
)


def _index_names(inspector: sa.engine.reflection.Inspector, table: str) -> set:
    return {ix["name"] for ix in inspector.get_indexes(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_ROLLUPS):
        op.create_table(
            _ROLLUPS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("grain", sa.Text(), nullable=False),
            sa.Column("bucket_start", sa.Text(), nullable=False),
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
            sa.Column("node_min", sa.Integer(), nullable=True),
            sa.Column("node_max", sa.Integer(), nullable=True),
            sa.Column("edge_min", sa.Integer(), nullable=True),
            sa.Column("edge_max", sa.Integer(), nullable=True),
            sa.Column("node_delta", sa.Integer(), nullable=True),
            sa.Column("edge_delta", sa.Integer(), nullable=True),
            sa.Column("observations", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "changed_observations", sa.Integer(), nullable=False, server_default="0",
            ),
            sa.Column("compacted_at", sa.Text(), nullable=False),
            # The compactor upserts on this, so re-running over a trailing
            # bucket refines it instead of duplicating it. That is what makes
            # compaction safe to retry after a kill.
            sa.UniqueConstraint(
                "data_source_id", "grain", "bucket_start", name="uq_dscr_bucket",
            ),
            sa.CheckConstraint("grain IN ('hour', 'day')", name="ck_dscr_grain"),
        )

    existing = _index_names(inspector, _ROLLUPS) if inspector.has_table(_ROLLUPS) else set()
    for name, columns in _ROLLUP_INDEXES:
        if name not in existing:
            op.create_index(name, _ROLLUPS, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table(_ROLLUPS):
        return

    existing = _index_names(inspector, _ROLLUPS)
    for name, _columns in reversed(_ROLLUP_INDEXES):
        if name in existing:
            op.drop_index(name, table_name=_ROLLUPS)

    op.drop_table(_ROLLUPS)
