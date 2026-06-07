"""Phase 6 — role taxonomy expansion: workspace_data_engineer + org_auditor.

Revision ID: 20260606_0100_role_expansion
Revises: 20260605_1200_phase18_ws_reads
Create Date: 2026-06-06 01:00

Adds two new built-in roles and three new system-category permissions
on top of the post-Phase-5 taxonomy:

  * ``workspace_data_engineer`` — workspace-scoped. Owns the data
    products inside a workspace (datasources, views, ontology, catalog)
    WITHOUT being able to manage members or workspace settings.
    Slices the existing workspace permissions; no new workspace perms.

  * ``org_auditor`` — global-scoped, read-only across the whole tenancy.
    Sees every workspace's data + every role binding + the audit log,
    but cannot mutate anything.

New permissions (system category):

  * ``system:org-viewer``    — cross-workspace read shortcut. Parallel
                               to ``system:org-admin`` but read-only.
                               Implies ``workspace:*:read`` in any
                               workspace via the resolver.
  * ``system:audit:read``    — read the audit log.
  * ``system:bindings:read`` — list all role bindings + per-user access
                               maps cross-workspace.

The new shortcut is taught to the resolver in
``backend/app/services/permission_service.py``:
``has_permission`` / ``has_permission_any_workspace`` /
``compute_implied_by`` all gain a ``system:org-viewer`` clause parallel
to the existing ``system:org-admin`` one.

Idempotent — every INSERT uses ``ON CONFLICT DO NOTHING``.
Defensive — every DDL/INSERT uses ``conn.execute(sa.text(...))``,
never ``conn.exec_driver_sql`` (the Phase 18 trap).
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260606_0100_role_expansion"
down_revision: Union[str, None] = "20260605_1200_phase18_ws_reads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ── New permissions ─────────────────────────────────────────────────

_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, category, short description)
    (
        "system:org-viewer",
        "system",
        "Read-only operator across every workspace in the tenancy.",
    ),
    (
        "system:audit:read",
        "system",
        "Read the platform audit log (logins, RBAC mutations, sessions).",
    ),
    (
        "system:bindings:read",
        "system",
        "List role bindings and per-user effective access cross-workspace.",
    ),
]


_NEW_LONG_DESCRIPTIONS: dict[str, str] = {
    "system:org-viewer": (
        "Lets you see every workspace's data sources, views, ontologies, "
        "catalog items, and providers without being able to modify any of "
        "them. The resolver short-circuits every workspace:*:read in any "
        "workspace when this permission is held, so a single global "
        "binding covers cross-tenancy visibility."
    ),
    "system:audit:read": (
        "Lets you read the platform-wide audit log — successful and "
        "failed logins, RBAC mutations (role creates/updates, binding "
        "grants), and session revocations. Does NOT permit any mutation."
    ),
    "system:bindings:read": (
        "Lets you list every role binding in the system and inspect any "
        "user's effective permissions and group memberships. Powers the "
        "'By user' / 'By workspace' admin tabs for compliance reviewers."
    ),
}


_NEW_EXAMPLES: dict[str, list[str]] = {
    "system:org-viewer": [
        "Open any workspace and see its data sources, ontology, and views.",
        "Drill into a provider's status without being able to edit it.",
    ],
    "system:audit:read": [
        "Review who signed in over the last 30 days.",
        "Confirm a binding was revoked by checking the audit log.",
    ],
    "system:bindings:read": [
        "Answer 'why does Alice see Finance workspace?'",
        "Compile a per-workspace member roster for a compliance review.",
    ],
}


# ── New roles ───────────────────────────────────────────────────────
#
# Both rows are stored at scope_type='global'. The
# ``ck_roles_scope_consistency`` CHECK constraint forbids
# scope_type='workspace' with a NULL scope_id, so system *templates*
# (which can be bound into any workspace) must live at the global
# scope. Phase 5's rbac_uplift uses the same pattern for
# ``workspace_admin`` / ``workspace_member`` / ``workspace_viewer``
# — the resolver's category × scope filter does the right thing
# semantically when a binding emits the perms.
_NEW_ROLES: list[tuple[str, str, str]] = [
    # (name, description, scope_type)
    (
        "workspace_data_engineer",
        "Owns data products inside a workspace (datasources, ontology, "
        "catalog, views) without managing members or workspace settings.",
        "global",
    ),
    (
        "org_auditor",
        "Read-only operator across the whole tenancy. Sees every "
        "workspace + every binding + the audit log; cannot mutate.",
        "global",
    ),
]


# ── Role → permission grants ────────────────────────────────────────

_NEW_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    # workspace_data_engineer — workspace data products without admin/members.
    ("workspace_data_engineer", "workspace:datasource:read"),
    ("workspace_data_engineer", "workspace:datasource:manage"),
    ("workspace_data_engineer", "workspace:view:create"),
    ("workspace_data_engineer", "workspace:view:edit"),
    ("workspace_data_engineer", "workspace:view:delete"),
    ("workspace_data_engineer", "workspace:view:read"),
    ("workspace_data_engineer", "workspace:ontology:read"),
    ("workspace_data_engineer", "workspace:ontology:manage"),
    ("workspace_data_engineer", "workspace:catalog:read"),
    ("workspace_data_engineer", "workspace:catalog:manage"),
    ("workspace_data_engineer", "workspace:provider:read"),

    # org_auditor — cross-workspace reads + audit/binding introspection.
    ("org_auditor", "system:org-viewer"),
    ("org_auditor", "system:audit:read"),
    ("org_auditor", "system:bindings:read"),

    # super_admin gains explicit grants for the new system perms so the
    # role-matrix UI shows them honestly (system:admin already implies
    # everything, but explicit grants make the matrix honest — same
    # rationale Phase 18 used).
    ("super_admin", "system:org-viewer"),
    ("super_admin", "system:audit:read"),
    ("super_admin", "system:bindings:read"),
]


def upgrade() -> None:
    conn = op.get_bind()
    import json as _json

    # 1. New permissions (system category).
    for perm_id, category, short_desc in _NEW_PERMISSIONS:
        conn.execute(
            sa.text(
                """
                INSERT INTO permissions (id, description, category, long_description, examples)
                VALUES (:id, :description, :category, :long_description, :examples)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "id": perm_id,
                "description": short_desc,
                "category": category,
                "long_description": _NEW_LONG_DESCRIPTIONS.get(perm_id),
                "examples": _json.dumps(_NEW_EXAMPLES.get(perm_id, [])),
            },
        )

    # 2. New roles.
    for role_name, role_desc, scope_type in _NEW_ROLES:
        conn.execute(
            sa.text(
                """
                INSERT INTO roles
                (name, description, scope_type, scope_id, is_system,
                 created_at, updated_at, created_by)
                VALUES (:name, :desc, :scope, NULL, TRUE,
                        :now, :now, NULL)
                ON CONFLICT (name) DO NOTHING
                """
            ),
            {
                "name": role_name,
                "desc": role_desc,
                "scope": scope_type,
                "now": _now_iso(conn),
            },
        )

    # 3. Wire role → permission grants.
    for role_name, perm_id in _NEW_ROLE_PERMISSIONS:
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
    # role_permissions has FK CASCADE on permissions.id, so deleting
    # permissions also cleans the grants. Belt-and-suspenders: clear
    # the rows explicitly first.
    for role_name, perm_id in _NEW_ROLE_PERMISSIONS:
        conn.execute(
            sa.text(
                "DELETE FROM role_permissions "
                "WHERE role_name = :role AND permission_id = :perm"
            ),
            {"role": role_name, "perm": perm_id},
        )
    for role_name, _, _ in _NEW_ROLES:
        # Guard with binding-count check so the downgrade doesn't
        # orphan active bindings. Caller can force-clear bindings
        # before downgrading if needed.
        conn.execute(
            sa.text(
                "DELETE FROM roles "
                "WHERE name = :name "
                "  AND NOT EXISTS (SELECT 1 FROM role_bindings WHERE role_name = :name)"
            ),
            {"name": role_name},
        )
    for perm_id, _, _ in _NEW_PERMISSIONS:
        conn.execute(
            sa.text("DELETE FROM permissions WHERE id = :id"),
            {"id": perm_id},
        )


def _now_iso(conn) -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
