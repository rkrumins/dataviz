"""Refresh tokens become allow-by-record: one row per issued token.

Additive. Creates ``refresh_tokens``; touches nothing that exists.

``revoked_refresh_jti`` is a denylist — a refresh token is valid *unless*
a row says otherwise. That makes correctness depend on the denylist being
complete and durable forever, and ``purge_expired`` deletes from it. Any
row lost to an early prune, a failed write, or a restore from backup
makes a consumed or revoked token valid again.

This table inverts it. A token is refused unless an active row says
otherwise, so every storage failure points the safe way: a missing row
signs someone out instead of reviving a credential, and deleting an
expired row can only reject a token that had already expired.

Three things move onto the row and off the token or the sentinel:

``auth_time``
    Was a claim the refresh JWT asserted about itself. A token with the
    claim missing read as a local password session and skipped the 24h
    SSO re-auth ceiling altogether — a bug fixed earlier in this work by
    other means. A server-side value cannot be absent or stale.

``consumed_at`` / ``successor_jti``
    Were the existence of a denylist row plus three denormalised columns
    describing what it rotated into. The successor now has its own row,
    so the grace window follows a pointer instead of a copy.

``revoked_at``
    Replaces the ``family-revoked:<id>`` sentinel, whose lifetime had to
    be hand-sized (refresh TTL + a grace day) to outlive every token it
    guarded. Revocation now marks the rows themselves; there is nothing
    left to outlive.

**No backfill, and no flag day.** Sessions already live at deploy hold
refresh tokens with no row here. ``REFRESH_ADOPT_RECORDLESS`` (default
on) accepts such a token once and writes its row, which is exactly the
status quo — those tokens are accepted today with no row anywhere — so
the deploy signs nobody out. Every adoption logs. Turn the flag off one
refresh lifetime after deploying, at which point allow-by-record is
unconditional and the old table is dead.

**Rollback note.** ``revoked_refresh_jti`` is deliberately left in place
and is not dropped here, but rolling the code back after tokens have
rotated under this revision means those rotations were never written to
it — so replay detection would not see them. Prefer rolling forward.

Nothing *writes* that table from this revision onward, and the hourly
sweep no longer touches it. One reader remains: the adoption ramp asks it
whether a record-less token's family, or the token's own ``jti``, was
revoked or consumed before this revision — questions ``refresh_tokens``
cannot answer, because a pre-deploy family has no rows in it at all.
Dropping the table while ``REFRESH_ADOPT_RECORDLESS`` is on would silently
re-admit every pre-deploy revoked session and every superseded pre-deploy
cookie. Once the ramp is off it is genuinely dead; dropping it belongs in
a later revision, deliberately, not here.

The ORM (``backend.app.db.models.RefreshTokenORM``) declares the same
table so ``create_all`` covers fresh and test databases; this migration
covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260730_1200_refresh_records"
down_revision: Union[str, None] = "20260728_1700_rotation_grace"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    op.create_table(
        "refresh_tokens",
        sa.Column("jti", sa.Text(), primary_key=True),
        sa.Column("family_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("auth_time", sa.Integer(), nullable=True),
        # Epoch milliseconds overflows int4 — this must be int8.
        sa.Column("mint_ms", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("consumed_at", sa.Text(), nullable=True),
        sa.Column("successor_jti", sa.Text(), nullable=True),
        sa.Column("revoked_at", sa.Text(), nullable=True),
    )
    op.create_index("idx_refresh_tokens_family", "refresh_tokens", ["family_id"])
    op.create_index("idx_refresh_tokens_user", "refresh_tokens", ["user_id"])
    op.create_index("idx_refresh_tokens_expires", "refresh_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_index("idx_refresh_tokens_expires", table_name="refresh_tokens")
    op.drop_index("idx_refresh_tokens_user", table_name="refresh_tokens")
    op.drop_index("idx_refresh_tokens_family", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
