"""Rotation grace window: record the successor a rotation issued.

Additive, schema-only. Three nullable columns on ``revoked_refresh_jti``.

Refresh-token rotation treats a re-presented ``jti`` as a stolen-chain
replay and revokes the whole family. That is the right answer for an
attacker and the wrong one for the far more common causes: two tabs
refreshing on the same cookie within milliseconds, a retried POST, a tab
restored from bfcache, or a rotation whose ``Set-Cookie`` never reached
the browser. Any of those signed the user out of every tab at once.

Recording which token a rotation issued — in the same transaction as the
row that consumes the presented ``jti`` — lets a concurrent refresh that
loses the race read the successor back and re-mint it, so both racers
converge on one token instead of one being mistaken for a thief.

``successor_jti`` / ``successor_exp`` / ``successor_mint_ms``
    The successor's identity, not the successor itself. A signed JWT at
    rest here would be a live credential; these three fields are
    worthless without the signing key.

NULL on family-revoked sentinels, and on every row written before this
migration — those fall through to reuse detection exactly as before, so
the rollout needs no backfill and no flag day.

The ORM (``backend.app.db.models.RevokedRefreshJtiORM``) declares the
same columns so ``create_all`` covers fresh and test databases; this
migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260728_1700_rotation_grace"
down_revision: Union[str, None] = "20260728_1600_account_fields"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    op.add_column(
        "revoked_refresh_jti",
        sa.Column("successor_jti", sa.Text(), nullable=True),
        if_not_exists=True,
    )
    op.add_column(
        "revoked_refresh_jti",
        sa.Column("successor_exp", sa.Integer(), nullable=True),
        if_not_exists=True,
    )
    op.add_column(
        "revoked_refresh_jti",
        # Epoch milliseconds overflows int4 — this must be int8.
        sa.Column("successor_mint_ms", sa.BigInteger(), nullable=True),
        if_not_exists=True,
    )


def downgrade() -> None:
    # ``op.drop_column`` has no ``if_exists`` (alembic 1.18); raw DDL instead.
    for column in ("successor_mint_ms", "successor_exp", "successor_jti"):
        op.execute(
            f"ALTER TABLE revoked_refresh_jti DROP COLUMN IF EXISTS {column}"
        )
