"""``users.last_login_at`` / ``last_seen_at`` / ``last_active_at``.

Admin → Users shows when each person joined, last signed in, was last
seen and was last active. Joined is ``created_at``. Nothing recorded the
other three for everyone: SSO sign-ins stamped the identity row, password
sign-ins stamped nothing at all.

``last_login_at`` is backfilled from each person's most recent identity
sign-in, so SSO users show a value at once; password-only accounts fill
in at their next sign-in. The other two start empty and fill in as people
use the platform — reconstructing them would mean scanning the telemetry
tables at deploy time, for a value that is minutes from correct anyway.

The ORM (``backend.app.db.models.UserORM``) declares the same shape for
``create_all``; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260928_1000_user_activity"
down_revision: Union[str, None] = "20260927_1000_import_indexes"
branch_labels = None
depends_on = None

_COLUMNS = ("last_login_at", "last_seen_at", "last_active_at")


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column(
            "users", sa.Column(name, sa.Text(), nullable=True),
            if_not_exists=True,
        )
    # ISO-8601 UTC text compares correctly as text, so MAX is the latest.
    op.execute(
        """
        UPDATE users SET last_login_at = latest.at
        FROM (
            SELECT user_id, MAX(last_login_at) AS at
            FROM user_identities
            WHERE last_login_at IS NOT NULL
            GROUP BY user_id
        ) AS latest
        WHERE users.id = latest.user_id AND users.last_login_at IS NULL
        """
    )


def downgrade() -> None:
    for name in _COLUMNS:
        op.execute(f"ALTER TABLE users DROP COLUMN IF EXISTS {name}")
