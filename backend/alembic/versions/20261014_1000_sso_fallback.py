"""Emergency password access + IdP reachability.

Two additive changes, so single sign-on can be enforced without an IdP
outage locking everyone out:

  * ``app_auth_config.password_fallback_until`` / ``_by`` / ``_reason`` —
    the emergency window an admin opens for everyone while SSO is down. A
    deadline rather than a switch, so it closes itself; NULL is closed.
  * ``idp_provider_reachability`` — one row per connection, written every
    minute by the scheduler-role prober and read with the posture snapshot.
    Which rows add up to a confirmed outage is decided in
    ``services/idp_reachability.py``.

Every column is nullable or defaulted, so this is safe on a live table.
Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a
brand-new environment already has both when this runs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261014_1000_sso_fallback"
down_revision: Union[str, None] = "20261013_0116_saved_filters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CONFIG = "app_auth_config"
_ADDITIONS: tuple[str, ...] = (
    "password_fallback_until",
    "password_fallback_by",
    "password_fallback_reason",
)
_REACHABILITY = "idp_provider_reachability"


def _columns(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    cols = _columns(bind, _CONFIG)
    for name in _ADDITIONS:
        # Empty set = the table isn't there yet; ``in cols`` = a fresh DB
        # where create_all already laid the column down.
        if cols and name not in cols:
            op.add_column(_CONFIG, sa.Column(name, sa.Text(), nullable=True))

    if not sa.inspect(bind).has_table(_REACHABILITY):
        op.create_table(
            _REACHABILITY,
            sa.Column(
                "provider_id", sa.Text(),
                sa.ForeignKey("idp_providers.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("last_ok_at", sa.Text(), nullable=True),
            sa.Column("unreachable_since", sa.Text(), nullable=True),
            sa.Column("recovering_since", sa.Text(), nullable=True),
            sa.Column("checked_at", sa.Text(), nullable=False),
            sa.Column("detail", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table(_REACHABILITY):
        op.drop_table(_REACHABILITY)
    cols = _columns(bind, _CONFIG)
    for name in reversed(_ADDITIONS):
        if name in cols:
            op.drop_column(_CONFIG, name)
