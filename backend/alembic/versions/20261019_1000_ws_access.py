"""Workspace access: find a workspace, ask to join, stewards, and how access came about.

* ``workspaces.directory_listed`` — listed in the Find a workspace directory
  (while the deployment's switch is on). ``workspaces.access_mode`` — who
  decides membership: ``'app'`` (approvers here) or ``'idp'`` (the identity
  provider's groups). ``workspaces.access_note`` — shown to people asking.
* ``access_requests`` gains ``awaiting_idp`` (pointed to the identity-provider
  group that grants it) and ``withdrawn``, the approver's decision
  (``granted_role``, ``granted_group_id``, ``idp_group``, ``access_expires_at``,
  ``idp_exception``) and ``fulfilled_at``. One open request per person per
  workspace: earlier duplicate pending rows are kept as ``withdrawn``, then a
  partial unique index holds the rule.
* ``role_bindings.access_request_id`` / ``group_members.access_request_id`` —
  the approval behind a grant; ``role_bindings.idp_exception`` — a grant made
  in the app for a workspace whose access its identity provider decides.
* ``workspace:members:add`` and the **Workspace steward** role: answer access
  requests and add people as viewers or members. Org Admin and Super Admin
  carry the permission too; ``workspace:admin`` implies it in code.

``role_bindings`` and ``group_members`` are read on every sign-in, so the
revision bounds its wait for locks. Guarded DDL (a ``create_all`` baseline
already has all of it), idempotent data. Downgrade is lossy by necessity:
``awaiting_idp`` goes back to ``pending`` and ``withdrawn`` to ``denied``.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261019_1000_ws_access
Revises: 20261018_1300_tpl_lifecycle
Create Date: 2026-10-19 10:00
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261019_1000_ws_access"
down_revision: Union[str, None] = "20261018_1300_tpl_lifecycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "workspace:members:add"
_DESCRIPTION = "Answer access requests and add people to a workspace."
_LONG_DESCRIPTION = (
    "Answer requests to join a workspace and add people to it yourself. Holding "
    "only this permission, you can let people in as viewers or members; a "
    "workspace admin can grant any level they hold. Removing people, changing "
    "their roles and the workspace's settings stay with workspace:admin. The "
    "Workspace steward role carries it, so the people who know a team can let "
    "colleagues in without administering the workspace."
)
_EXAMPLES = [
    "Approve a colleague's request to join as a member",
    "Add a new analyst to the workspace as a viewer",
]
_ROLE = "workspace_steward"
_ROLE_DESCRIPTION = (
    "Everything a workspace member can do, plus answering access requests and "
    "adding people as viewers or members."
)
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", _PERMISSION),
    ("super_admin", _PERMISSION),
    *((_ROLE, perm) for perm in (
        "workspace:catalog:read",
        "workspace:datasource:manage",
        "workspace:datasource:read",
        _PERMISSION,
        "workspace:ontology:read",
        "workspace:provider:read",
        "workspace:view:create",
        "workspace:view:delete",
        "workspace:view:edit",
        "workspace:view:read",
    )),
]

_OPEN = "status IN ('pending', 'awaiting_idp')"
_STATUS = "status IN ('pending', 'awaiting_idp', 'approved', 'denied', 'withdrawn')"
_STATE = (
    "(status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) "
    "OR (status = 'awaiting_idp' AND resolved_at IS NOT NULL AND idp_group IS NOT NULL) "
    "OR (status IN ('approved', 'denied', 'withdrawn') AND resolved_at IS NOT NULL)"
)
_PREVIOUS_STATUS = "status IN ('pending', 'approved', 'denied')"
_PREVIOUS_STATE = (
    "(status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) "
    "OR (status IN ('approved', 'denied') AND resolved_at IS NOT NULL)"
)
_REQUEST_COLUMNS = ("granted_role", "granted_group_id", "idp_group", "access_expires_at", "fulfilled_at")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``role_bindings`` and
    ``group_members`` are read on every sign-in, and giving up (to be run
    again) beats queueing them behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _swap_check(table: str, name: str, condition: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.create_check_constraint(name, table, condition)


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    op.add_column(
        "workspaces",
        sa.Column("directory_listed", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        if_not_exists=True,
    )
    op.add_column(
        "workspaces",
        sa.Column("access_mode", sa.Text(), nullable=False, server_default="app"),
        if_not_exists=True,
    )
    op.add_column("workspaces", sa.Column("access_note", sa.Text(), nullable=True), if_not_exists=True)
    _swap_check("workspaces", "ck_workspaces_access_mode", "access_mode IN ('app', 'idp')")

    op.add_column(
        "role_bindings", sa.Column("access_request_id", sa.Text(), nullable=True), if_not_exists=True,
    )
    op.add_column(
        "role_bindings",
        sa.Column("idp_exception", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        if_not_exists=True,
    )
    op.add_column(
        "group_members", sa.Column("access_request_id", sa.Text(), nullable=True), if_not_exists=True,
    )

    for column in _REQUEST_COLUMNS:
        op.add_column("access_requests", sa.Column(column, sa.Text(), nullable=True), if_not_exists=True)
    op.add_column(
        "access_requests",
        sa.Column("idp_exception", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        if_not_exists=True,
    )
    _swap_check("access_requests", "ck_access_requests_status", _STATUS)
    _swap_check("access_requests", "ck_access_requests_state_consistency", _STATE)

    # Before the index: one open request per person per workspace. Keep each
    # person's newest; the rest read as withdrawn, in their own name.
    conn.execute(
        sa.text(
            f"""
            UPDATE access_requests
            SET status = 'withdrawn', resolved_at = :now, resolved_by = requester_id,
                resolution_note = 'Superseded by a later request from the same person'
            WHERE status = 'pending' AND EXISTS (
                SELECT 1 FROM access_requests newer
                WHERE newer.requester_id = access_requests.requester_id
                  AND newer.target_type = access_requests.target_type
                  AND newer.target_id = access_requests.target_id
                  AND newer.{_OPEN}
                  AND (newer.created_at > access_requests.created_at
                       OR (newer.created_at = access_requests.created_at
                           AND newer.id > access_requests.id))
            )
            """
        ),
        {"now": _now()},
    )
    op.create_index(
        "uq_access_requests_one_open", "access_requests",
        ["requester_id", "target_type", "target_id"],
        unique=True,
        postgresql_where=sa.text(_OPEN),
        sqlite_where=sa.text(_OPEN),
        if_not_exists=True,
    )

    conn.execute(
        sa.text(
            """
            INSERT INTO permissions (id, description, category, long_description, examples)
            VALUES (:id, :description, :category, :long_description, :examples)
            ON CONFLICT (id) DO NOTHING
            """
        ),
        {
            "id": _PERMISSION,
            "description": _DESCRIPTION,
            "category": "workspace",
            "long_description": _LONG_DESCRIPTION,
            "examples": json.dumps(_EXAMPLES),
        },
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
    _bound_lock_wait()
    conn = op.get_bind()

    for role_name, perm_id in _ROLE_PERMISSIONS:
        conn.execute(
            sa.text("DELETE FROM role_permissions WHERE role_name = :role AND permission_id = :perm"),
            {"role": role_name, "perm": perm_id},
        )
    # A steward role still bound somewhere stays, without its grants, rather
    # than leave bindings that name a role which no longer exists.
    conn.execute(
        sa.text(
            "DELETE FROM roles WHERE name = :name "
            "AND NOT EXISTS (SELECT 1 FROM role_bindings WHERE role_name = :name)"
        ),
        {"name": _ROLE},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})

    op.drop_index("uq_access_requests_one_open", table_name="access_requests", if_exists=True)
    # The older states can't say "waiting on the identity provider" or
    # "withdrawn": the first is still open, the second never will be.
    conn.execute(sa.text(
        "UPDATE access_requests SET status = 'pending', resolved_at = NULL, resolved_by = NULL "
        "WHERE status = 'awaiting_idp'"
    ))
    conn.execute(sa.text(
        "UPDATE access_requests SET status = 'denied', "
        "resolution_note = COALESCE(resolution_note, 'Withdrawn by the requester') "
        "WHERE status = 'withdrawn'"
    ))
    _swap_check("access_requests", "ck_access_requests_state_consistency", _PREVIOUS_STATE)
    _swap_check("access_requests", "ck_access_requests_status", _PREVIOUS_STATUS)
    op.drop_column("access_requests", "idp_exception")
    for column in reversed(_REQUEST_COLUMNS):
        op.drop_column("access_requests", column)

    op.drop_column("group_members", "access_request_id")
    op.drop_column("role_bindings", "idp_exception")
    op.drop_column("role_bindings", "access_request_id")

    op.execute("ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS ck_workspaces_access_mode")
    op.drop_column("workspaces", "access_note")
    op.drop_column("workspaces", "access_mode")
    op.drop_column("workspaces", "directory_listed")
