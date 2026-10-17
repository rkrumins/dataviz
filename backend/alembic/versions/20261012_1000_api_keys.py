"""API keys: bearer credentials that act as their principal.

Revision ID: 20261012_1000_api_keys
Revises: 20261008_1200_import_rows_idx
Create Date: 2026-10-12 10:00

Until now the only credential was a browser session — an HttpOnly cookie
pair with a CSRF double-submit — so a script had to sign in with a person's
password, and most people sign in through SSO and have none. ``api_keys``
holds the keys people mint for themselves instead (and, later, keys for
service accounts): one row per key, the secret stored only as its SHA-256.

Fresh installs get the table from ``0001_baseline``'s ``create_all`` and
never run this file, so the DDL is guarded (docs/MIGRATIONS.md). There is
no data to move.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261012_1000_api_keys"
down_revision: Union[str, None] = "20261008_1200_import_rows_idx"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock. The key's foreign key locks
    ``users``, which every request reads: a long transaction there makes
    this revision give up, to be run again, rather than queue every later
    query on the table behind it while it waits."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id", sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("token_prefix", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("permissions", sa.Text(), nullable=False),
        sa.Column("resources", sa.Text(), nullable=False),
        sa.Column("allowed_cidrs", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.Text(), nullable=True),
        sa.Column("expiry_reminded_at", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("created_ip", sa.Text(), nullable=True),
        sa.Column("created_user_agent", sa.Text(), nullable=True),
        sa.Column("last_used_at", sa.Text(), nullable=True),
        sa.Column("last_used_ip", sa.Text(), nullable=True),
        sa.Column("last_used_user_agent", sa.Text(), nullable=True),
        sa.Column("revoked_at", sa.Text(), nullable=True),
        sa.Column("revoked_by", sa.Text(), nullable=True),
        sa.Column("revoked_reason", sa.Text(), nullable=True),
        sa.Column("rotated_from", sa.Text(), nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_api_keys_token_hash"),
        sa.CheckConstraint(
            "kind IN ('personal', 'service')", name="ck_api_keys_kind",
        ),
        if_not_exists=True,
    )
    op.create_index(
        "idx_api_keys_user", "api_keys", ["user_id"], if_not_exists=True,
    )
    op.create_index(
        "idx_api_keys_expires_at", "api_keys", ["expires_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    _bound_lock_wait()
    op.drop_index("idx_api_keys_expires_at", table_name="api_keys", if_exists=True)
    op.drop_index("idx_api_keys_user", table_name="api_keys", if_exists=True)
    op.drop_table("api_keys", if_exists=True)
