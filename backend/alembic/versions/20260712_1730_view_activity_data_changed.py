"""Add 'data_changed' to the view_activity_log action enum.

Graph-versioning publish/merge now records a 'data_changed' timeline event on
every affected view (the Data channel). Widen the CHECK constraint to allow it.
SQLite/tests get the updated constraint via the ORM's create_all.
"""
from __future__ import annotations

from typing import Union

from alembic import op

revision: str = "20260712_1730_view_activity_data_changed"
down_revision: Union[str, None] = "20260712_1600_view_activity_log"
branch_labels = None
depends_on = None

_ACTIONS_NEW = (
    "'created', 'updated', 'visibility_changed', 'shared', 'unshared', "
    "'favourited', 'unfavourited', 'deleted', 'restored', 'data_changed'"
)
_ACTIONS_OLD = (
    "'created', 'updated', 'visibility_changed', 'shared', 'unshared', "
    "'favourited', 'unfavourited', 'deleted', 'restored'"
)


def upgrade() -> None:
    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_NEW})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_OLD})",
    )
