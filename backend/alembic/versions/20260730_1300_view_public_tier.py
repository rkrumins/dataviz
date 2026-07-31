"""Add the 'public' visibility tier to views; drop the dead one on context_models.

The visibility CHECK constraints were never written in DDL — 0001_baseline
creates every table from ORM metadata via ``create_all``, so editing
``db/models.py`` alone would silently diverge from any already-migrated
database. This revision changes both tables explicitly.

``views`` — widen the constraint to four tiers, strictly widening:

    private   -> creator + explicit grants + workspace admins
    workspace -> + anyone with workspace:view:read in that workspace
    enterprise-> + anyone with a binding in any workspace
    public    -> + any authenticated account, binding or not

``public`` is authenticated-only; there is no anonymous access.

Note on the name: ``public`` was once an *alias* for what is now called
``enterprise``, renamed by a migration that predates the squashed
baseline. It is reintroduced here with a genuinely different and wider
meaning — ``enterprise`` reaches accounts with a workspace binding,
``public`` reaches every signed-in account. No legacy rows can hold the
old value: the three-tier CHECK has forbidden it since 0001_baseline.

``context_models`` — drop ``visibility`` entirely. It carried the same
CHECK as ``views`` but had no reader and no writer anywhere in the
backend: every endpoint on that table is templates-only, and templates
are global rows meant to be broadly readable. A column that looks like
enforced policy but isn't is worse than no column.

SQLite (tests + quickstart) picks both changes up from ``create_all``,
matching how 20260712_1730_val_data_changed handled the same shape of
change on view_activity_log. The column DDL is guarded with IF EXISTS /
IF NOT EXISTS so a database built fresh from the current ORM (which no
longer declares the column) can still run the chain in both directions.
"""
from __future__ import annotations

from typing import Union

from alembic import op

revision: str = "20260730_1300_view_public_tier"
down_revision: Union[str, None] = "20260730_1200_refresh_records"
branch_labels = None
depends_on = None

_NEW = "'private', 'workspace', 'enterprise', 'public'"
_OLD = "'private', 'workspace', 'enterprise'"


def upgrade() -> None:
    # ``if_exists`` so the drop cannot fail on a database where the constraint
    # was never created (or was already replaced). Drop-then-create is then
    # idempotent whatever the starting state: the CHECK ends up with this
    # revision's definition either way.
    op.drop_constraint(
        "ck_views_visibility", "views", type_="check", if_exists=True,
    )
    op.create_check_constraint(
        "ck_views_visibility", "views", f"visibility IN ({_NEW})",
    )

    op.execute(
        "ALTER TABLE context_models DROP CONSTRAINT IF EXISTS "
        "ck_context_models_visibility"
    )
    op.execute("ALTER TABLE context_models DROP COLUMN IF EXISTS visibility")


def downgrade() -> None:
    op.execute(
        "ALTER TABLE context_models ADD COLUMN IF NOT EXISTS visibility "
        "TEXT NOT NULL DEFAULT 'private'"
    )
    op.execute(
        "ALTER TABLE context_models ADD CONSTRAINT ck_context_models_visibility "
        f"CHECK (visibility IN ({_OLD}))"
    )

    # Rows already on the new tier would violate the narrowed constraint.
    # Demote them to 'enterprise' — the widest surviving tier, and a
    # narrowing of access rather than a widening, so a rollback can never
    # expose a view to more people than it reached before.
    op.execute("UPDATE views SET visibility = 'enterprise' WHERE visibility = 'public'")
    op.drop_constraint("ck_views_visibility", "views", type_="check")
    op.create_check_constraint(
        "ck_views_visibility", "views", f"visibility IN ({_OLD})",
    )
