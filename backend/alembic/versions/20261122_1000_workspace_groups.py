"""Workspace groups, and asking for a group's link to the identity provider.

* ``groups.workspace_id`` — the workspace that owns a group, whose admins manage it
  from the workspace; NULL for a platform group. ``groups.created_by`` — who made it.
  Plain ids, no foreign keys.
* ``idp_link_requests`` — one row per request to link a group to an identity-provider
  group, for a platform administrator to answer: ``pending``, then ``linked`` (with
  the mapping it made), ``declined`` or ``cancelled``. One pending per group, held by
  a partial unique index. No foreign keys: the group, workspace, provider and people
  are named by id.

Fresh installs get both from ``0001_baseline``'s create_all and never run this file,
so the DDL is guarded. Revision id is kept <=32 chars (alembic_version.version_num is
VARCHAR(32)).

Revision ID: 20261122_1000_workspace_groups
Revises: 20261121_1000_workspace_requests
Create Date: 2026-11-22 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261122_1000_workspace_groups"
down_revision: Union[str, None] = "20261121_1000_workspace_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PENDING = "status = 'pending'"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")

    op.add_column("groups", sa.Column("workspace_id", sa.Text(), nullable=True), if_not_exists=True)
    op.add_column("groups", sa.Column("created_by", sa.Text(), nullable=True), if_not_exists=True)
    op.create_index("idx_groups_workspace", "groups", ["workspace_id"], if_not_exists=True)

    if not sa.inspect(bind).has_table("idp_link_requests"):
        op.create_table(
            "idp_link_requests",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("group_id", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.Text(), nullable=False),
            sa.Column("idp_group", sa.Text(), nullable=False),
            sa.Column("provider_id", sa.Text(), nullable=True),
            sa.Column("requested_by", sa.Text(), nullable=False),
            sa.Column("requested_at", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("source", sa.Text(), nullable=False),
            sa.Column("source_id", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolution_note", sa.Text(), nullable=True),
            sa.Column("mapping_id", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "status IN ('pending', 'linked', 'declined', 'cancelled')",
                name="ck_idp_link_requests_status",
            ),
            sa.CheckConstraint(
                "source IN ('workspace', 'workspace_request')",
                name="ck_idp_link_requests_source",
            ),
        )
    op.create_index(
        "idx_idp_link_requests_status", "idp_link_requests", ["status", "requested_at"],
        if_not_exists=True,
    )
    op.create_index("idx_idp_link_requests_group", "idp_link_requests", ["group_id"], if_not_exists=True)
    op.create_index(
        "uq_idp_link_requests_one_pending", "idp_link_requests", ["group_id"],
        unique=True,
        postgresql_where=sa.text(_PENDING),
        sqlite_where=sa.text(_PENDING),
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("uq_idp_link_requests_one_pending", table_name="idp_link_requests", if_exists=True)
    op.drop_index("idx_idp_link_requests_group", table_name="idp_link_requests", if_exists=True)
    op.drop_index("idx_idp_link_requests_status", table_name="idp_link_requests", if_exists=True)
    op.drop_table("idp_link_requests")
    op.drop_index("idx_groups_workspace", table_name="groups", if_exists=True)
    op.drop_column("groups", "created_by")
    op.drop_column("groups", "workspace_id")
