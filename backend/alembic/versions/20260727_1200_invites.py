"""Invite ledger: make signup links revocable, cappable and auditable.

Additive, schema-only. Creates two tables:

``invites`` — one row per signup link. Until now an invite was a bare
signed JWT with no server-side record, which meant a link could not be
revoked, could not be limited to a number of people, and left no trace
of having been used. A link pasted into the wrong channel worked for
every reader until it expired, up to 90 days later, and nobody could
tell it had happened. The row is the source of truth: the token's
``jti`` points at it, and redemption reads the grant from here rather
than from the payload, so revoking a row kills a token that is still
cryptographically valid.

``invite_redemptions`` — one row per successful signup through a link.
The "who used this" ledger. ``user_id`` deliberately carries no foreign
key so the history survives the user being deleted, matching
``role_bindings.subject_id``; ``email`` is denormalised for that case.

No data migration. Tokens minted before this existed carry no ``jti``
and keep their old self-contained behaviour until they age out — invite
lifetimes are capped at 90 days, so that path retires itself.

The ORM (``backend.app.db.models.InviteORM`` /
``InviteRedemptionORM``) declares the same tables so ``create_all``
covers fresh and test databases; this migration covers existing
Postgres. ``downgrade`` drops both.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260727_1200_invites"
down_revision: Union[str, None] = "20260722_0900_merge_jobvis"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "invites",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("role", sa.Text(), nullable=True),
        sa.Column("workspace_id", sa.Text(), nullable=True),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("email_domain", sa.Text(), nullable=True),
        sa.Column("group_ids", sa.Text(), nullable=False, server_default="[]"),
        sa.Column(
            "shareable_groups_override",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("use_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.Text(), nullable=True),
        sa.Column("revoked_by", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "max_uses IS NULL OR max_uses > 0", name="ck_invites_max_uses",
        ),
        sa.CheckConstraint("use_count >= 0", name="ck_invites_use_count"),
        sa.CheckConstraint(
            "revoked_by IS NULL OR revoked_at IS NOT NULL",
            name="ck_invites_revocation_consistency",
        ),
    )
    op.create_index("idx_invites_created_by", "invites", ["created_by", "created_at"])
    op.create_index("idx_invites_expires_at", "invites", ["expires_at"])

    op.create_table(
        "invite_redemptions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "invite_id",
            sa.Text(),
            sa.ForeignKey("invites.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("redeemed_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("invite_id", "user_id", name="uq_invite_redemption"),
    )
    op.create_index(
        "idx_invite_redemptions_invite",
        "invite_redemptions",
        ["invite_id", "redeemed_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_invite_redemptions_invite", table_name="invite_redemptions")
    op.drop_table("invite_redemptions")
    op.drop_index("idx_invites_expires_at", table_name="invites")
    op.drop_index("idx_invites_created_by", table_name="invites")
    op.drop_table("invites")
