"""Insights service refactor — discovery cache + admission control tables.

Revision ID: 20260425_1300_insights_refactor
Revises: 0001_baseline
Create Date: 2026-04-25 13:00

Adds three tables that back the insights_service refactor:

* ``asset_discovery_cache`` — pre-registration asset list / stats cache.
  No data_source_id available yet at onboarding time, so we key on
  (provider_id, asset_name). The empty-string asset_name is the
  sentinel for "list all assets on this provider" payloads.

* ``provider_admission_config`` — admin-tunable token-bucket + circuit
  parameters per provider. Read by insights_service workers; absence of
  a row falls back to module defaults.

* ``provider_health_window`` — worker-maintained rolling success window
  for admission control; ``throttle_until`` defers enqueues when a
  provider's rolling success rate has collapsed.

Idempotent: the baseline migration uses ``Base.metadata.create_all`` so
on fresh deploys these tables already exist by the time this migration
runs. We check ``inspector.get_table_names`` before each create.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260425_1300_insights_refactor"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    existing = _existing_tables(bind)

    if "asset_discovery_cache" not in existing:
        op.create_table(
            "asset_discovery_cache",
            sa.Column(
                "provider_id",
                sa.Text(),
                sa.ForeignKey("providers.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("asset_name", sa.Text(), nullable=False, server_default=""),
            sa.Column("payload", sa.Text(), nullable=False, server_default="{}"),
            sa.Column("status", sa.Text(), nullable=False, server_default="fresh"),
            sa.Column("computed_at", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.Text(), nullable=False),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("provider_id", "asset_name"),
            sa.CheckConstraint(
                "status IN ('fresh', 'stale', 'partial')",
                name="ck_adc_status",
            ),
        )
        op.create_index(
            "idx_adc_expires", "asset_discovery_cache", ["expires_at"]
        )

    if "provider_admission_config" not in existing:
        op.create_table(
            "provider_admission_config",
            sa.Column(
                "provider_id",
                sa.Text(),
                sa.ForeignKey("providers.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("bucket_capacity", sa.Integer(), nullable=False, server_default="8"),
            sa.Column("refill_per_sec", sa.Integer(), nullable=False, server_default="2"),
            sa.Column("circuit_fail_max", sa.Integer(), nullable=False, server_default="5"),
            sa.Column("circuit_window_secs", sa.Integer(), nullable=False, server_default="30"),
            sa.Column("half_open_after_secs", sa.Integer(), nullable=False, server_default="60"),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )

    if "provider_health_window" not in existing:
        op.create_table(
            "provider_health_window",
            sa.Column(
                "provider_id",
                sa.Text(),
                sa.ForeignKey("providers.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("success_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("window_start", sa.Text(), nullable=False),
            sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("throttle_until", sa.Text(), nullable=True),
            sa.Column("last_p99_ms", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    existing = _existing_tables(bind)

    if "provider_health_window" in existing:
        op.drop_table("provider_health_window")

    if "provider_admission_config" in existing:
        op.drop_table("provider_admission_config")

    if "asset_discovery_cache" in existing:
        op.drop_index("idx_adc_expires", table_name="asset_discovery_cache")
        op.drop_table("asset_discovery_cache")
