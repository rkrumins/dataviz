"""refresh_events: append-only audit trail for freshness/refresh operations.

Additive, schema-only. Creates ``refresh_events`` — one immutable row per
refresh/audit event across every origin (script, connector, api, drift,
reconcile) and scope (auto, read-caches, rollups, full, batch-item). This
is the foundation for the OPS Freshness Cockpit: per-source history and
"when did this last refresh, what happened" reads.

The ORM (``backend.app.db.models.RefreshEventORM``) declares the same
table so ``create_all`` covers fresh/test databases; this migration
covers existing Postgres. No backfill. ``downgrade`` drops the table.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260718_1200_refresh_events"
down_revision: Union[str, None] = "20260714_1600_feature_changes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "refresh_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("ts", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=True),
        sa.Column("data_source_id", sa.Text(), nullable=False),
        sa.Column("provider_id", sa.Text(), nullable=True),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("gate", sa.Text(), nullable=False),
        sa.Column("actions", sa.Text(), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "origin IN ('script', 'connector', 'api', 'drift', 'reconcile')",
            name="ck_refresh_events_origin",
        ),
        sa.CheckConstraint(
            "scope IN ('auto', 'read-caches', 'rollups', 'full', 'batch-item')",
            name="ck_refresh_events_scope",
        ),
        sa.CheckConstraint(
            "gate IN ('changed', 'unchanged', 'forced', 'n/a')",
            name="ck_refresh_events_gate",
        ),
        sa.CheckConstraint(
            "outcome IN ('accepted', 'deferred', 'noop', 'conflict', 'error', "
            "'completed', 'failed')",
            name="ck_refresh_events_outcome",
        ),
        if_not_exists=True,
    )
    op.create_index("idx_refresh_events_ts", "refresh_events", ["ts"], if_not_exists=True)
    op.create_index(
        "idx_refresh_events_ds_ts", "refresh_events",
        ["data_source_id", "ts"], if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_refresh_events_ds_ts", table_name="refresh_events", if_exists=True)
    op.drop_index("idx_refresh_events_ts", table_name="refresh_events", if_exists=True)
    op.drop_table("refresh_events", if_exists=True)
