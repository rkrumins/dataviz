"""Merge the freshness-cockpit and product-events migration heads.

Revision ID: 20260720_1200_merge_heads
Revises: 20260719_1200_agg_cadence, 20260719_1400_product_events
Create Date: 2026-07-20 12:00

Both chains fork from ``20260714_1600_feature_changes``:

* freshness cockpit → ``20260718_1200_refresh_events`` → ``20260719_1200_agg_cadence``
* product events    → ``20260719_1200_rebrand_default_branding`` → ``20260719_1400_product_events``

They touch disjoint tables (``aggregation.refresh_events`` /
``aggregation.data_source_state`` / ``aggregation.aggregation_settings`` vs.
the branding/product-events tables), so no reconciliation work is needed —
this is a no-op merge revision that rejoins the two heads into one so
``alembic upgrade head`` resolves to a single head again.
"""
from __future__ import annotations

from typing import Sequence, Union


revision: str = "20260720_1200_merge_heads"
down_revision: Union[str, Sequence[str], None] = (
    "20260719_1200_agg_cadence",
    "20260719_1400_product_events",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op: the two merged chains touch disjoint tables."""
    pass


def downgrade() -> None:
    """No-op: splitting back into two heads is a metadata-only operation."""
    pass
