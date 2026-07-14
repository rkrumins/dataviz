"""feature_flag_changes — who turned it off, and when

Revision ID: 20260714_1600_feature_changes
Revises: 20260714_1600_pull_kind
Create Date: 2026-07-14

The Features page could tell an admin that a flag was off. It could not tell them who turned it
off, when, or what it was before: `feature_flags` holds a value and a version, and nothing else.

On a surface where any admin can silently remove a capability from every user of the deployment,
that is the wrong thing to be missing. The first question when someone reports "I can't import
layers any more" is *who turned it off, and did they mean to* — and the product had no way to
answer it.

No FK to `users`. See the model docstring: a foreign key would either forbid deleting a user who
once flipped a switch, or delete the history along with them, and an audit trail that vanishes
with the person is not an audit trail. `actor_name` is a snapshot of who they were when they acted.

Revision id is 29 chars — `alembic_version.version_num` is VARCHAR(32).
"""
import sqlalchemy as sa
from alembic import op

revision = "20260714_1600_feature_changes"
down_revision = "20260714_1600_pull_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feature_flag_changes",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("feature_key", sa.Text(), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("actor_name", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index("idx_ffc_key_created", "feature_flag_changes", ["feature_key", "created_at"])
    op.create_index("idx_ffc_created", "feature_flag_changes", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_ffc_created", table_name="feature_flag_changes")
    op.drop_index("idx_ffc_key_created", table_name="feature_flag_changes")
    op.drop_table("feature_flag_changes")
