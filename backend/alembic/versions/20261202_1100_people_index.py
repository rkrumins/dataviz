"""People analytics' index: when each person joined each workspace, and was first and last
active in it — and where the indexer that keeps it has got to.

Revision ID: 20261202_1100_people_index
Revises: 20261202_1000_pev_actor_ws
Create Date: 2026-12-02 11:00

``person_workspace_activity`` holds one row per (person, workspace), plus one per person with
``workspace_id = ''`` for the platform as a whole. It answers "when did they join, when did
they first do anything here, when did they last" for a whole workspace's membership in one
indexed read, where the raw tables would need a scan of the workspace's entire history — and
it keeps the answer after ``product_events`` retention has deleted the rows it came from.

``people_index_cursors`` is how far the indexer (``services/people_activity_indexer``) has got
through each source, so a restart resumes rather than starting again, and so the page can say
how much of history has been indexed while a backfill is under way.

Both are new and empty, so no build needs to be concurrent. Inspector-guarded:
``0001_baseline`` create_all()s the current ORM.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261202_1100_people_index"
down_revision: Union[str, None] = "20261202_1000_pev_actor_ws"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIVITY = "person_workspace_activity"
_CURSORS = "people_index_cursors"
_WS_INDEX = "idx_pwa_workspace_last"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_ACTIVITY):
        op.create_table(
            _ACTIVITY,
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("joined_at", sa.Text(), nullable=True),
            sa.Column("first_active_at", sa.Text(), nullable=True),
            sa.Column("last_active_at", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("user_id", "workspace_id"),
        )
        op.create_index(_WS_INDEX, _ACTIVITY, ["workspace_id", "last_active_at"])
    if not inspector.has_table(_CURSORS):
        op.create_table(
            _CURSORS,
            sa.Column("name", sa.Text(), primary_key=True),
            sa.Column("through", sa.Text(), nullable=True),
            sa.Column("through_id", sa.Text(), nullable=True),
            sa.Column("started_at", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table(_CURSORS):
        op.drop_table(_CURSORS)
    if inspector.has_table(_ACTIVITY):
        op.drop_table(_ACTIVITY)
