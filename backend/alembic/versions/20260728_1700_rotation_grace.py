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

from backend.common.schema_drift import has_column
import sqlalchemy as sa

revision: str = "20260728_1700_rotation_grace"
down_revision: Union[str, None] = "20260728_1600_account_fields"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    # Guarded by introspection, not ``if_not_exists``: Postgres accepts
    # ALTER TABLE … ADD COLUMN IF NOT EXISTS, SQLite does not, and the
    # migration chain is replayed against SQLite by the test suite.
    bind = op.get_bind()
    # This revision has met databases whose physical schema was already ahead
    # of ``alembic_version``, where a bare ADD COLUMN dies on DuplicateColumn
    # and — DDL being transactional — takes the whole upgrade chain with it.
    for name, col in (
        ("successor_jti", sa.Column("successor_jti", sa.Text(), nullable=True)),
        ("successor_exp", sa.Column("successor_exp", sa.Integer(), nullable=True)),
        # Epoch milliseconds overflows int4 — this must be int8.
        ("successor_mint_ms",
         sa.Column("successor_mint_ms", sa.BigInteger(), nullable=True)),
    ):
        if not has_column(bind, "revoked_refresh_jti", name):
            op.add_column("revoked_refresh_jti", col)


def downgrade() -> None:
    op.drop_column("revoked_refresh_jti", "successor_mint_ms")
    op.drop_column("revoked_refresh_jti", "successor_exp")
    op.drop_column("revoked_refresh_jti", "successor_jti")
