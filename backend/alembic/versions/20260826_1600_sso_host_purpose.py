"""A ``purpose`` on ``sso_backchannel_hosts``: gateway vs avatar rows.

The table so far held one kind of entry — internal gateway hosts the
back-channel legs may call. External avatar images get their own
allowlist (the list is the on-switch: with it empty, external avatar
hosts are refused), and rather than a second table with the same
normalisation, attribution and revocation story, the rows gain a
``purpose`` column: ``gateway`` (every existing row) or ``avatar``.

The unique key widens from ``(host, port)`` to ``(purpose, host, port)``
so the same destination can sit on both lists.

The ORM (``backend.app.db.models.SsoBackchannelHostORM``) declares the
same shape for ``create_all``; this migration covers existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260826_1600_sso_host_purpose"
down_revision: Union[str, None] = "20260826_1200_user_avatar_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sso_backchannel_hosts",
        sa.Column("purpose", sa.Text(), nullable=False,
                  server_default="gateway"),
        if_not_exists=True,
    )
    op.execute(
        "ALTER TABLE sso_backchannel_hosts "
        "DROP CONSTRAINT IF EXISTS uq_sso_backchannel_host_port"
    )
    op.execute(
        "ALTER TABLE sso_backchannel_hosts "
        "DROP CONSTRAINT IF EXISTS uq_sso_backchannel_purpose_host_port"
    )
    op.create_unique_constraint(
        "uq_sso_backchannel_purpose_host_port",
        "sso_backchannel_hosts",
        ["purpose", "host", "port"],
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE sso_backchannel_hosts "
        "DROP CONSTRAINT IF EXISTS uq_sso_backchannel_purpose_host_port"
    )
    # Avatar rows would collide under the narrower key; they belong to
    # the feature being removed anyway.
    op.execute("DELETE FROM sso_backchannel_hosts WHERE purpose != 'gateway'")
    op.execute(
        "ALTER TABLE sso_backchannel_hosts DROP COLUMN IF EXISTS purpose"
    )
    op.create_unique_constraint(
        "uq_sso_backchannel_host_port",
        "sso_backchannel_hosts",
        ["host", "port"],
    )
