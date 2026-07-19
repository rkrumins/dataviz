"""Product telemetry events: an append-only usage-signal store.

Additive, schema-only. Creates ``product_events`` — one immutable row per
product signal the app chooses to record (docs 'was this helpful?', a search
that returned nothing, a tour completed/skipped, an onboarding step). It is
deliberately SEPARATE from ``outbox_events`` (which is a transient domain-event
relay drained by consumers): these rows persist so they can be aggregated for
the Admin telemetry view — which pages help, and, most usefully, which searches
find nothing (content gaps).

The ORM (``backend.app.db.models.ProductEventORM``) declares the same table so
``create_all`` covers fresh/test databases; this migration covers existing
Postgres. ``downgrade`` drops the table.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260719_1400_product_events"
down_revision: Union[str, None] = "20260719_1200_rebrand_default_branding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("payload", sa.Text(), nullable=True),  # JSON string
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_product_events_type_created",
        "product_events",
        ["event_type", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_product_events_created",
        "product_events",
        ["created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_product_events_created", table_name="product_events", if_exists=True)
    op.drop_index("idx_product_events_type_created", table_name="product_events", if_exists=True)
    op.drop_table("product_events", if_exists=True)
