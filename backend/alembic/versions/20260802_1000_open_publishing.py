"""Publishing opens by default; restriction moves to the source.

Revision ID: 20260802_1000_open_publish
Revises: 20260801_1500_notifications
Create Date: 2026-08-02 10:00

Publishing shipped admin-only, and that was too tight for what this
platform holds. The graph is METADATA — names, types, and the lineage
between them. A product whose purpose is shared understanding of
lineage should not require a signature before anyone can share
lineage, and a gate that in practice always says yes is friction
without signal.

So the default posture inverts: ``workspaces.publish_policy`` defaults
to ``'open'``, where anyone who may change a view's visibility may
publish it. Control does not disappear — it moves after the fact.
Whoever holds ``workspace:view:publish`` is notified when something is
published in their workspace and can unpublish it. Workspaces that
want the human in the loop keep ``'request'``.

The risk that DID justify a gate is concentrated in a few sources, not
spread evenly across all of them: publishing exposes read-only access
to the whole source behind the view. So restriction lands on the
source. ``workspace_data_sources.is_restricted`` overrides an open
workspace — views over that source always need the permission — which
gates the HR warehouse without gating the workspace that contains it.

Existing rows are moved to the new default. ``publish_policy`` was
introduced earlier in this same unreleased line and nobody has
configured it yet, so leaving rows on the old value would ship a
default nobody chose. A released product would not be loosened this
way without asking.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260802_1000_open_publish"
down_revision: Union[str, None] = "20260801_1500_notifications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Guarded: a database built from ``0001_baseline``'s create_all already
    # has this column. The UPDATE below is data, not DDL, and still runs.
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE workspace_data_sources ADD COLUMN IF NOT EXISTS "
        "is_restricted BOOLEAN NOT NULL DEFAULT FALSE"
    ))
    # The ORM default is Python-side; a lingering server default reads as
    # permanent autogenerate drift.
    op.alter_column("workspace_data_sources", "is_restricted", server_default=None)

    op.execute("UPDATE workspaces SET publish_policy = 'open'")


def downgrade() -> None:
    op.execute("UPDATE workspaces SET publish_policy = 'request'")
    op.drop_column("workspace_data_sources", "is_restricted")
