"""Add revoked_refresh_jti table for refresh-token rotation tracking.

Revision ID: 0002_revoked_refresh_jti
Revises: 0001_baseline
Create Date: 2026-04-14

Backs the auth service's reuse-detection logic. Each row marks a refresh
token's jti as consumed (rotated forward) or revoked (logout, or the
whole family killed after a reuse attempt). Looked up on every /refresh
call; entries past expires_at can be garbage-collected without affecting
correctness.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0002_revoked_refresh_jti"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "revoked_refresh_jti",
        sa.Column("jti", sa.Text(), nullable=False, primary_key=True),
        sa.Column("family_id", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_revoked_refresh_family",
        "revoked_refresh_jti",
        ["family_id"],
    )
    op.create_index(
        "idx_revoked_refresh_expires",
        "revoked_refresh_jti",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_revoked_refresh_expires", table_name="revoked_refresh_jti")
    op.drop_index("idx_revoked_refresh_family", table_name="revoked_refresh_jti")
    op.drop_table("revoked_refresh_jti")
