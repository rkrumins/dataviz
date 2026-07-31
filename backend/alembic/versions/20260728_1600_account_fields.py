"""Self-service account fields on ``users``.

Additive, schema-only. Four columns, none of which change the meaning of
an existing row:

``display_name``
    A chosen name. Until now the display name was derived as
    ``first last`` in four separate places and could not be edited at
    all. NULL keeps the derivation, so every existing row renders
    exactly as it did before and no backfill is needed.

``must_change_password``
    Forces a rotation on the next request. Set on the bootstrap admin
    when it is seeded with a shipped default password — a log line
    saying "change it" was previously the only control.

``avatar_id``
    The avatar was a browser-local preference, so it silently reset on a
    new machine and nobody else ever saw it.

``sessions_valid_from``
    ISO timestamp. Refresh tokens issued before this instant are
    refused. Session revocation previously tombstoned access-token
    ``sid``s only, and ``refresh()`` neither consults that set nor
    reuses the ``sid`` — it mints a fresh random one — so any client
    that silently refreshed on a 401 walked straight back in. This
    column is what makes a revocation stick.

The ORM (``backend.app.db.models.UserORM``) declares the same columns so
``create_all`` covers fresh and test databases; this migration covers
existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260728_1600_account_fields"
down_revision: Union[str, None] = "20260728_1500_idp_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("display_name", sa.Text(), nullable=True),
        if_not_exists=True,
    )
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        if_not_exists=True,
    )
    op.add_column(
        "users",
        sa.Column("avatar_id", sa.Text(), nullable=True),
        if_not_exists=True,
    )
    op.add_column(
        "users",
        sa.Column("sessions_valid_from", sa.Text(), nullable=True),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_column("users", "sessions_valid_from")
    op.drop_column("users", "avatar_id")
    op.drop_column("users", "must_change_password")
    op.drop_column("users", "display_name")
