"""Add expires_at to resource_grants.

Role bindings have been time-boundable since 20260430_1200 (Phase 7 added
the API and the members-UI duration picker on top). Per-view shares —
``resource_grants`` — had no equivalent, so every view ever shared with a
person or group was shared permanently. That made it the one access path
on the platform that could not lapse.

Nullable, NULL = permanent, evaluated by the same
``binding_repo.is_expired`` the bindings use, so the two tables cannot
drift on what "expired" means. Existing rows become permanent, which is
what they already were.
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

from backend.common.schema_drift import has_column

revision: str = "20260730_1400_grant_expiry"
down_revision: Union[str, None] = "20260730_1300_view_public_tier"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Guarded by introspection, not ``if_not_exists``: Postgres accepts
    # ALTER TABLE … ADD COLUMN IF NOT EXISTS, SQLite does not, and the
    # migration chain is replayed against SQLite by the test suite.
    bind = op.get_bind()
    if not has_column(bind, "resource_grants", "expires_at"):
        op.add_column(
            "resource_grants", sa.Column("expires_at", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    # Dropping the column makes every time-bound share permanent again.
    # That is a widening, so warn loudly rather than doing it silently.
    conn = op.get_bind()
    bound = conn.execute(sa.text(
        "SELECT COUNT(*) FROM resource_grants WHERE expires_at IS NOT NULL"
    )).scalar() or 0
    if bound:
        print(
            f"WARNING: {bound} time-bound view share(s) become PERMANENT — "
            "expires_at is being dropped. Review resource_grants."
        )
    op.drop_column("resource_grants", "expires_at")
