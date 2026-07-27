"""Invite token rotation: ``invites.token_version``.

Additive, schema-only. Adds a version counter so a link can be
REGENERATED — issued a fresh URL — without discarding the row.

Without it, rotation was impossible: the token's ``jti`` is the row id,
so a re-minted token was indistinguishable from the one it replaced and
the old URL kept working. The alternative was creating a second invite,
which split one invitation across two rows and stranded the redemption
history on the dead one.

The token now carries the version it was minted at; the resolver refuses
anything older than the row. Tokens minted before this column existed
carry no version and are read as version 1, so every outstanding link
keeps working.

The ORM (``backend.app.db.models.InviteORM``) declares the same column so
``create_all`` covers fresh and test databases; this migration covers
existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260727_1400_invite_token_version"
down_revision: Union[str, None] = "20260727_1200_invites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "invites",
        sa.Column(
            "token_version", sa.Integer(), nullable=False, server_default="1",
        ),
    )


def downgrade() -> None:
    op.drop_column("invites", "token_version")
