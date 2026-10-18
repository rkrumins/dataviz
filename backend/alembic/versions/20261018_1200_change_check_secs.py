"""Let an admin set how often browsers check the change feed.

The seven always-on surfaces (announcements, notifications, permissions,
feature flags, invite activity, provider health and provider status) all
update through one manifest check now, so one interval governs all of them.
It used to be a constant in the frontend. This column makes it an admin
setting (Administration → Features → Live updates), returned with every
manifest so a change applies at each browser's next check.

NULL means unset, which resolves to 60 seconds.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261018_1200_change_check_secs"
down_revision: Union[str, None] = "20260815_1200_announce_poll_60s"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SETTINGS = "platform_settings"
_COLUMN = "change_check_interval_secs"


def _columns(inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    if _COLUMN not in _columns(inspector, _SETTINGS):
        # Nullable with no server default: NULL means "nobody has set this",
        # which resolves to the code default rather than freezing today's.
        op.add_column(_SETTINGS, sa.Column(_COLUMN, sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    if _COLUMN in _columns(inspector, _SETTINGS):
        op.drop_column(_SETTINGS, _COLUMN)
