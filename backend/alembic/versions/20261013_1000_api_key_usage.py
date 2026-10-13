"""API keys, round two: usage per day, an administrator's note, two indexes.

Revision ID: 20261013_1000_api_key_usage
Revises: 20261012_1000_api_keys
Create Date: 2026-10-13 10:00

* ``api_key_usage`` — requests made with each key per day, added to in
  batches by every API process (never written per request), kept 90 days.
* ``api_keys.revoked_note`` — what an administrator told the owner when
  revoking their key.
* ``idx_api_keys_created_at`` orders the administrators' inventory, and
  ``idx_api_keys_live_last_used`` (partial on keys not revoked) serves its
  "unused for 90 days" filter.

Fresh installs get all of it from ``0001_baseline``'s ``create_all`` and never
run this file, so the DDL is guarded (docs/MIGRATIONS.md). No data to move.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261013_1000_api_key_usage"
down_revision: Union[str, None] = "20261012_1000_api_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    op.create_table(
        "api_key_usage",
        sa.Column("key_id", sa.Text(), primary_key=True),
        sa.Column("day", sa.Text(), primary_key=True),
        sa.Column("requests", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("writes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("refused", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer(), nullable=False, server_default="0"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_api_key_usage_day", "api_key_usage", ["day"], if_not_exists=True,
    )
    op.add_column(
        "api_keys", sa.Column("revoked_note", sa.Text(), nullable=True),
        if_not_exists=True,
    )
    op.create_index(
        "idx_api_keys_created_at", "api_keys", ["created_at"], if_not_exists=True,
    )
    live = {"postgresql_where": sa.text("revoked_at IS NULL")} if (
        bind.dialect.name == "postgresql"
    ) else {"sqlite_where": sa.text("revoked_at IS NULL")}
    op.create_index(
        "idx_api_keys_live_last_used", "api_keys", ["last_used_at"],
        if_not_exists=True, **live,
    )


def downgrade() -> None:
    op.drop_index("idx_api_keys_live_last_used", table_name="api_keys", if_exists=True)
    op.drop_index("idx_api_keys_created_at", table_name="api_keys", if_exists=True)
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("api_keys")}
    if "revoked_note" in columns:
        op.drop_column("api_keys", "revoked_note")
    op.drop_index("idx_api_key_usage_day", table_name="api_key_usage", if_exists=True)
    op.drop_table("api_key_usage", if_exists=True)
