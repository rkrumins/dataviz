"""``users.is_system_account`` — the break-glass flag.

Enforcing SSO (``allow_local_login=false``) needs one account that the
enforcement does not apply to: it keeps password sign-in, forced
sign-out sweeps skip it, and the admin-lockout guard does not count it —
otherwise a deployment whose only local admin is the seeded bootstrap
account can never turn enforcement on, and an IdP outage has no way
back in.

Nothing is backfilled: an operator marks their operational account in
Admin → Users. Fresh installs flag the seeded bootstrap admin at
creation time.

The ORM (``backend.app.db.models.UserORM``) declares the same shape for
``create_all``; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260827_1000_system_account"
down_revision: Union[str, None] = "20260826_1600_sso_host_purpose"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_system_account", sa.Boolean(), nullable=False,
                  server_default="false"),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS is_system_account")
