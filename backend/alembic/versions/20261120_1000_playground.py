"""The Playground: one shared sandbox workspace anyone can join to build their own graphs.

* ``workspaces.kind`` — ``'standard'`` (a team's own workspace) or ``'playground'``;
  at most one playground (partial unique index ``uq_workspaces_one_playground``).
* ``workspaces.playground_settings`` — the playground's JSON settings: the sandbox
  provider its blank graphs go on, the starter data models, the per-person quota.
* The **Playground member** role (``workspace_playground_member``): build blank
  graphs and views in the playground and change only your own
  (``backend.app.services.playground_policy``). No people, no publishing, no admin.

Guarded DDL (a ``create_all`` baseline already has all of it), idempotent data.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261120_1000_playground
Revises: 20261119_1500_merge_view_members
Create Date: 2026-11-20 10:00
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261120_1000_playground"
down_revision: Union[str, None] = "20261119_1500_merge_view_members"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ROLE = "workspace_playground_member"
_ROLE_DESCRIPTION = (
    "Build your own graphs and views in the Playground, and change only what you made. "
    "No people, no publishing to everyone, no production data."
)
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    (_ROLE, perm) for perm in (
        "workspace:datasource:manage",
        "workspace:datasource:read",
        "workspace:native-query:read",
        "workspace:ontology:read",
        "workspace:provider:read",
        "workspace:view:create",
        "workspace:view:delete",
        "workspace:view:edit",
        "workspace:view:read",
    )
]
_ONE_PLAYGROUND = "kind = 'playground' AND deleted_at IS NULL"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")

    op.add_column(
        "workspaces",
        sa.Column("kind", sa.Text(), nullable=False, server_default="standard"),
        if_not_exists=True,
    )
    op.add_column("workspaces", sa.Column("playground_settings", sa.Text(), nullable=True), if_not_exists=True)
    op.execute("ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS ck_workspaces_kind")
    op.create_check_constraint("ck_workspaces_kind", "workspaces", "kind IN ('standard', 'playground')")
    op.create_index(
        "uq_workspaces_one_playground", "workspaces", ["kind"], unique=True,
        postgresql_where=sa.text(_ONE_PLAYGROUND), sqlite_where=sa.text(_ONE_PLAYGROUND),
        if_not_exists=True,
    )

    conn.execute(
        sa.text(
            """
            INSERT INTO roles
            (name, description, scope_type, scope_id, is_system, created_at, updated_at, created_by)
            VALUES (:name, :description, 'global', NULL, TRUE, :now, :now, NULL)
            ON CONFLICT (name) DO NOTHING
            """
        ),
        {"name": _ROLE, "description": _ROLE_DESCRIPTION, "now": _now()},
    )
    for role_name, perm_id in _ROLE_PERMISSIONS:
        conn.execute(
            sa.text(
                """
                INSERT INTO role_permissions (role_name, permission_id)
                VALUES (:role_name, :permission_id)
                ON CONFLICT (role_name, permission_id) DO NOTHING
                """
            ),
            {"role_name": role_name, "permission_id": perm_id},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for role_name, perm_id in _ROLE_PERMISSIONS:
        conn.execute(
            sa.text("DELETE FROM role_permissions WHERE role_name = :role AND permission_id = :perm"),
            {"role": role_name, "perm": perm_id},
        )
    # A role still bound somewhere stays, without its grants, rather than leave
    # bindings that name a role which no longer exists.
    conn.execute(
        sa.text(
            "DELETE FROM roles WHERE name = :name "
            "AND NOT EXISTS (SELECT 1 FROM role_bindings WHERE role_name = :name)"
        ),
        {"name": _ROLE},
    )
    op.drop_index("uq_workspaces_one_playground", table_name="workspaces", if_exists=True)
    op.execute("ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS ck_workspaces_kind")
    op.drop_column("workspaces", "playground_settings")
    op.drop_column("workspaces", "kind")
