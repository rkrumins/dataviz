"""feature_definitions.impact_when_off — what an admin loses by turning a flag off

Revision ID: 20260714_1300_feature_impact
Revises: 20260714_1200_ds_soft_delete
Create Date: 2026-07-14

The Admin → Features page asks people to flip switches that affect every user, and told them
only what each switch was CALLED. The one question that decides whether you flip it — "what
breaks if I turn this off?" — had nowhere to live.

Nullable, no backfill here: `seed_feature_registry` fills it on the next startup for every row
that is still empty (and leaves alone any an admin has since reworded). That keeps this
migration trivially safe on a live database and keeps the copy in code, where it is reviewable.

NOTE the revision id length: `alembic_version.version_num` is VARCHAR(32) and a longer id makes
a brand-new environment unbuildable. This one is 28.
"""
import sqlalchemy as sa
from alembic import op

revision = "20260714_1300_feature_impact"
down_revision = "20260714_1200_ds_soft_delete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "feature_definitions",
        sa.Column("impact_when_off", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("feature_definitions", "impact_when_off")
