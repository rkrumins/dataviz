"""Moving a data source, with its views, to another workspace.

* ``data_source_transfers`` — one row per relocation: a direct move, born
  ``completed``, or a request the destination's admins accept or decline,
  born ``pending``. It keeps what the mover decided (``plan``) and exactly
  what the move changed (``manifest``), which is what undo replays, and it
  is the history of where a source has lived. No foreign keys: a workspace
  is hard-deleted and a source is eventually purged, and the record must
  outlive both. One open request per source, held by a partial unique index.
* ``view_activity_log``'s action CHECK gains ``moved``: each moved view's
  own timeline says where it went, and that it came back on an undo.

``view_activity_log`` is written on every change to a view, so the revision
bounds its wait for that table's lock.

Fresh installs get the table from ``0001_baseline``'s create_all and never run
this file, so the DDL is guarded (docs/MIGRATIONS.md, "Guard the DDL; never
guard the data"). Revision id is kept <=32 chars (alembic_version.version_num
is VARCHAR(32)).

Revision ID: 20261019_1400_ds_transfers
Revises: 20261019_1000_ws_access
Create Date: 2026-10-19 14:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261019_1400_ds_transfers"
down_revision: Union[str, None] = "20261019_1000_ws_access"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ACTIONS_OLD = (
    "'created', 'updated', 'visibility_changed', 'shared', 'unshared', "
    "'favourited', 'unfavourited', 'deleted', 'restored', 'data_changed', "
    "'publish_requested', 'publish_denied', 'admin_viewed', 'imported', "
    "'exported', 'version_saved', 'version_restored'"
)
_ACTIONS_NEW = _ACTIONS_OLD + ", 'moved'"

_PENDING = "status = 'pending'"
_STATE = (
    "(status = 'pending' AND kind = 'request' AND expires_at IS NOT NULL "
    "AND resolved_at IS NULL AND completed_at IS NULL) "
    "OR (status IN ('declined', 'cancelled', 'expired') AND kind = 'request' "
    "AND resolved_at IS NOT NULL AND completed_at IS NULL) "
    "OR (status = 'completed' AND completed_at IS NOT NULL AND undone_at IS NULL) "
    "OR (status = 'undone' AND completed_at IS NOT NULL AND undone_at IS NOT NULL)"
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``view_activity_log`` is written
    on every change to a view, and giving up (to be run again) beats queueing
    those writes behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _swap_check(table: str, name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.create_check_constraint(name, table, condition)


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()

    if not sa.inspect(bind).has_table("data_source_transfers"):
        op.create_table(
            "data_source_transfers",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("data_source_id", sa.Text(), nullable=False),
            sa.Column("data_source_label", sa.Text(), nullable=True),
            sa.Column("from_workspace_id", sa.Text(), nullable=False),
            sa.Column("to_workspace_id", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("plan", sa.Text(), nullable=False),
            sa.Column("manifest", sa.Text(), nullable=True),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.Column("completed_at", sa.Text(), nullable=True),
            sa.Column("undone_by", sa.Text(), nullable=True),
            sa.Column("undone_at", sa.Text(), nullable=True),
            sa.CheckConstraint("kind IN ('move', 'request')", name="ck_dsx_kind"),
            sa.CheckConstraint(
                "status IN ('pending', 'completed', 'declined', 'cancelled', 'expired', 'undone')",
                name="ck_dsx_status",
            ),
            sa.CheckConstraint(
                "from_workspace_id <> to_workspace_id", name="ck_dsx_distinct_workspaces",
            ),
            sa.CheckConstraint(_STATE, name="ck_dsx_state_consistency"),
        )
    op.create_index(
        "idx_dsx_ds_created", "data_source_transfers", ["data_source_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_dsx_to_status", "data_source_transfers", ["to_workspace_id", "status"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_dsx_from_status", "data_source_transfers", ["from_workspace_id", "status"],
        if_not_exists=True,
    )
    op.create_index(
        "uq_dsx_one_pending", "data_source_transfers", ["data_source_id"],
        unique=True,
        postgresql_where=sa.text(_PENDING),
        sqlite_where=sa.text(_PENDING),
        if_not_exists=True,
    )

    _swap_check("view_activity_log", "ck_val_action_enum", f"action IN ({_ACTIONS_NEW})")


def downgrade() -> None:
    _bound_lock_wait()
    op.execute("ALTER TABLE view_activity_log DROP CONSTRAINT IF EXISTS ck_val_action_enum")
    # Rows carrying the widened verb would violate the narrower constraint.
    op.execute("DELETE FROM view_activity_log WHERE action = 'moved'")
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_OLD})",
    )

    op.drop_index("uq_dsx_one_pending", table_name="data_source_transfers", if_exists=True)
    op.drop_index("idx_dsx_from_status", table_name="data_source_transfers", if_exists=True)
    op.drop_index("idx_dsx_to_status", table_name="data_source_transfers", if_exists=True)
    op.drop_index("idx_dsx_ds_created", table_name="data_source_transfers", if_exists=True)
    op.drop_table("data_source_transfers")
