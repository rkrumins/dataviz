"""Publication workflow — request-to-publish + per-workspace policy.

Revision ID: 20260801_1200_publish_flow
Revises: 20260731_1300_view_publish
Create Date: 2026-08-01 12:00

``workspace:view:publish`` correctly gates exposing a view (and
read-only access to its data source) to the whole platform — but a
plain member who wanted that had nowhere to go: the option was greyed
out and the tooltip said "ask an admin". A permission without a path
around it is a dead end, and the product goal is the opposite: any
member should be able to share their work with the wider world.

Two additions, no new tables:

  * ``views.publish_requested_by / _at / _note`` — a pending request to
    publish. The request is a fact about the view, lives and dies with
    it, and its presence IS the admin queue (the workspace Views
    cockpit already lists views; pending ones sort to the top).
  * ``workspaces.publish_policy`` — ``'request'`` (default: members ask,
    a publish-permission holder answers) or ``'open'`` (anyone who may
    change a view's visibility may publish it directly). The permission
    remains the enforcement primitive; the policy only decides whether
    a member's own request satisfies it.

The activity CHECK gains ``publish_requested`` / ``publish_denied``
(approval is recorded as the ``visibility_changed`` that actually
happened) and ``admin_viewed``, which records a platform admin opening
a private view they neither created nor were shared on — break-glass
access stays available and stops being invisible to the owner.

Fresh installs get these columns from ``0001_baseline``'s create_all and
never run this file, so the DDL below is guarded (docs/MIGRATIONS.md,
"Guard the DDL; never guard the data") — the chain-replay route does run
it on top of a baseline that already holds them. The ``alter_column``
that drops the server default stays outside the guard so both routes
end up with the same column.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260801_1200_publish_flow"
down_revision: Union[str, None] = "20260731_1300_view_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ACTIONS_OLD = (
    "'created', 'updated', 'visibility_changed', 'shared', 'unshared', "
    "'favourited', 'unfavourited', 'deleted', 'restored', 'data_changed'"
)
_ACTIONS_NEW = (
    _ACTIONS_OLD + ", 'publish_requested', 'publish_denied', 'admin_viewed'"
)


def upgrade() -> None:
    # Guarded because ``0001_baseline`` is create_all against the live ORM:
    # a database built from baseline already holds these columns, and the
    # chain-replay route then re-applies this file on top of them.
    bind = op.get_bind()
    for _column in (
        "publish_requested_by", "publish_requested_at", "publish_request_note",
    ):
        bind.execute(sa.text(
            f"ALTER TABLE views ADD COLUMN IF NOT EXISTS {_column} TEXT"
        ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS idx_view_publish_requested "
        "ON views (publish_requested_at)"
    ))

    bind.execute(sa.text(
        "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS publish_policy TEXT "
        "NOT NULL DEFAULT 'request'"
    ))
    # The ORM default is Python-side; a lingering server default would
    # read as permanent autogenerate drift (same reasoning as the
    # ctxmodel_vis migration).
    op.alter_column("workspaces", "publish_policy", server_default=None)

    # Widen the activity verb set.
    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_NEW})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_val_action_enum", "view_activity_log", type_="check")
    # Rows carrying a widened verb would violate the narrower constraint.
    op.execute(
        "DELETE FROM view_activity_log WHERE action IN "
        "('publish_requested', 'publish_denied', 'admin_viewed')"
    )
    op.create_check_constraint(
        "ck_val_action_enum", "view_activity_log", f"action IN ({_ACTIONS_OLD})",
    )

    op.drop_column("workspaces", "publish_policy")
    op.drop_index("idx_view_publish_requested", table_name="views")
    op.drop_column("views", "publish_request_note")
    op.drop_column("views", "publish_requested_at")
    op.drop_column("views", "publish_requested_by")
