"""Add 'data_changed' to the view_activity_log action enum.

Graph-versioning publish/merge now records a 'data_changed' timeline event on
every affected view (the Data channel). Widen the CHECK constraint to allow it.
SQLite/tests get the updated constraint via the ORM's create_all.
"""
from __future__ import annotations

from typing import Union

from alembic import op

revision: str = "20260712_1730_val_data_changed"
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


def _swap_constraint(actions: str) -> None:
    """Drop-then-recreate the CHECK, tolerating an absent constraint.

    ``op.drop_constraint`` has no ``if_exists``, so a database where the
    constraint is missing — a fresh one built by ``create_all``, or one whose
    pointer was replayed — died here on ``ConstraintDoesNotExist``. Same
    ``DROP … IF EXISTS`` idiom as ``20260703_1200_graph_kind_blank``.
    """
    op.execute(
        "ALTER TABLE view_activity_log "
        "DROP CONSTRAINT IF EXISTS ck_val_action_enum"
    )
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({actions})",
    )


def upgrade() -> None:
    _swap_constraint(_ACTIONS_NEW)


def downgrade() -> None:
    _swap_constraint(_ACTIONS_OLD)
