"""Rename view visibility value ``public`` → ``enterprise``.

Revision ID: 0006_view_visibility_enterprise
Revises: 0005_rm_primary_conn
Create Date: 2026-04-15

Naming drift between layers: the frontend + backend query helpers treat
"enterprise" as the third visibility tier (shared beyond workspace), but
the Postgres check constraint on ``views`` and ``context_models`` still
whitelists the older ``"public"`` value. POSTs with ``visibility =
"enterprise"`` therefore fail with::

    new row for relation "views" violates check constraint
    "ck_views_visibility"

This migration:

1. Backfills any legacy rows with ``visibility='public'`` to
   ``'enterprise'`` (dev DBs today have zero; included for safety across
   environments).
2. Drops the old check constraints on both tables.
3. Recreates them against the new whitelist
   ``{'private', 'workspace', 'enterprise'}``.

Idempotent (``DROP ... IF EXISTS``) so re-running against a partially-
migrated DB is safe.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0006_view_visibility_enterprise"
down_revision: Union[str, None] = "0005_rm_primary_conn"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Backfill any legacy 'public' rows.
    op.execute("UPDATE views SET visibility = 'enterprise' WHERE visibility = 'public'")
    op.execute(
        "UPDATE context_models SET visibility = 'enterprise' WHERE visibility = 'public'"
    )

    # 2. Drop old check constraints.
    op.execute("ALTER TABLE views DROP CONSTRAINT IF EXISTS ck_views_visibility")
    op.execute(
        "ALTER TABLE context_models DROP CONSTRAINT IF EXISTS ck_context_models_visibility"
    )

    # 3. Recreate with the new whitelist.
    op.execute(
        "ALTER TABLE views ADD CONSTRAINT ck_views_visibility "
        "CHECK (visibility IN ('private', 'workspace', 'enterprise'))"
    )
    op.execute(
        "ALTER TABLE context_models ADD CONSTRAINT ck_context_models_visibility "
        "CHECK (visibility IN ('private', 'workspace', 'enterprise'))"
    )


def downgrade() -> None:
    # Reverse: flip 'enterprise' rows back to 'public' and restore the
    # original constraint.
    op.execute("UPDATE views SET visibility = 'public' WHERE visibility = 'enterprise'")
    op.execute(
        "UPDATE context_models SET visibility = 'public' WHERE visibility = 'enterprise'"
    )
    op.execute("ALTER TABLE views DROP CONSTRAINT IF EXISTS ck_views_visibility")
    op.execute(
        "ALTER TABLE context_models DROP CONSTRAINT IF EXISTS ck_context_models_visibility"
    )
    op.execute(
        "ALTER TABLE views ADD CONSTRAINT ck_views_visibility "
        "CHECK (visibility IN ('private', 'workspace', 'public'))"
    )
    op.execute(
        "ALTER TABLE context_models ADD CONSTRAINT ck_context_models_visibility "
        "CHECK (visibility IN ('private', 'workspace', 'public'))"
    )
