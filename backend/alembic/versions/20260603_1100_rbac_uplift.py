"""RBAC Phase 5 — role taxonomy uplift: super/org/workspace tiers.

Revision ID: 20260603_1100_rbac_uplift
Revises: 20260530_1200_display_rules
Create Date: 2026-06-03 11:00

Reshapes the RBAC role model into three explicit tiers:

  * ``super_admin`` (renamed from ``admin``) — platform owner;
    carries ``system:admin`` short-circuit, implies everything.
  * ``org_admin`` (NEW) — cross-workspace operator; carries
    ``system:org-admin`` shortcut + workspace:* perms + the
    workspace-create / groups-manage / SSO-providers system perms,
    but NOT ``system:users:manage``.
  * ``workspace_admin`` (NEW), ``workspace_member`` (renamed
    from ``user``), ``workspace_viewer`` (renamed from ``viewer``)
    — per-workspace bindings.

Permission ids are renamed to a uniform ``system:*`` / ``workspace:*``
prefix so the category × scope filter in
``permission_service.resolve()`` has unambiguous classification:

  users:manage         -> system:users:manage
  groups:manage        -> system:groups:manage
  workspaces:create    -> system:workspaces:create
  (new)                   system:org-admin

``role_bindings``, ``user_roles``, ``role_permissions``, and ``roles``
are rewritten so every existing row lands on the new names. Legacy
``(role='user', scope='global')`` rows from Phase 1's
``_backfill_global_user_roles`` are **deleted** with a WARNING log
per row — those rows were always malformed (``user`` is a
workspace-scoped role; Phase 5's resolver category filter would
drop their permissions anyway) and surface as confusing audit data.

Downgrade reverses every rename + drops the new roles + drops the
new permission. Best-effort on the deleted legacy rows.
"""
from __future__ import annotations

import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260603_1100_rbac_uplift"
down_revision: Union[str, None] = "20260530_1200_display_rules"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


log = logging.getLogger("alembic.rbac_uplift")


# ── Rename maps ─────────────────────────────────────────────────────


_PERMISSION_RENAMES: list[tuple[str, str]] = [
    # (old_id, new_id)
    ("users:manage", "system:users:manage"),
    ("groups:manage", "system:groups:manage"),
    ("workspaces:create", "system:workspaces:create"),
]

# Two ROLE rename rules per old name — one per binding scope, since
# Phase-1 ``admin`` ambiguously meant both ``super_admin`` (global) and
# ``workspace_admin`` (workspace).
_ROLE_GLOBAL_RENAMES: list[tuple[str, str]] = [
    ("admin", "super_admin"),
]
_ROLE_WORKSPACE_RENAMES: list[tuple[str, str]] = [
    ("admin", "workspace_admin"),
    ("user", "workspace_member"),
    ("viewer", "workspace_viewer"),
]

_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    (
        "system:org-admin",
        "Cross-workspace operator; implies every workspace permission.",
        "system",
    ),
]

# All system roles are stored at scope_type='global' — the
# ``ck_roles_scope_consistency`` CHECK requires workspace-scoped roles
# to carry a concrete ``scope_id``, which template roles do not have.
# The resolver's category × scope filter still does the right thing
# semantically: binding a global ``workspace_admin`` template at
# workspace scope only emits workspace:* perms.
_NEW_ROLES: list[tuple[str, str, str]] = [
    # (name, description, scope_type)
    (
        "org_admin",
        "Cross-workspace operator — manage every workspace + create new ones, "
        "but no user/SSO admin.",
        "global",
    ),
    (
        "workspace_admin",
        "Workspace administrator — settings, members, deletion, and every "
        "workspace permission (via auto-implication).",
        "global",
    ),
    (
        "workspace_member",
        "Standard workspace member — manage views and data sources.",
        "global",
    ),
    (
        "workspace_viewer",
        "Read-only access to the bound workspace's views + data sources.",
        "global",
    ),
]

# Role -> permission id (post-rename) for the role definitions that
# the migration writes. ``workspace_admin`` deliberately stores only
# ``workspace:admin`` because the resolver auto-implies the rest at
# session-build time.
_ROLE_PERMISSIONS_AFTER: list[tuple[str, str]] = [
    # super_admin gets everything (every perm in the catalogue).
    ("super_admin", "system:admin"),
    ("super_admin", "system:org-admin"),
    ("super_admin", "system:users:manage"),
    ("super_admin", "system:groups:manage"),
    ("super_admin", "system:workspaces:create"),
    ("super_admin", "workspace:admin"),
    ("super_admin", "workspace:datasource:manage"),
    ("super_admin", "workspace:datasource:read"),
    ("super_admin", "workspace:view:create"),
    ("super_admin", "workspace:view:edit"),
    ("super_admin", "workspace:view:delete"),
    ("super_admin", "workspace:view:read"),
    # org_admin: cross-workspace operator. Note: NO system:users:manage.
    ("org_admin", "system:org-admin"),
    ("org_admin", "system:groups:manage"),
    ("org_admin", "system:workspaces:create"),
    ("org_admin", "workspace:admin"),
    ("org_admin", "workspace:datasource:manage"),
    ("org_admin", "workspace:datasource:read"),
    ("org_admin", "workspace:view:create"),
    ("org_admin", "workspace:view:edit"),
    ("org_admin", "workspace:view:delete"),
    ("org_admin", "workspace:view:read"),
    # workspace_admin: stores ``workspace:admin`` only. Auto-implies
    # the rest in resolve().
    ("workspace_admin", "workspace:admin"),
    # workspace_member: same as Phase-1 ``user`` role bundle.
    ("workspace_member", "workspace:datasource:manage"),
    ("workspace_member", "workspace:datasource:read"),
    ("workspace_member", "workspace:view:create"),
    ("workspace_member", "workspace:view:edit"),
    ("workspace_member", "workspace:view:delete"),
    ("workspace_member", "workspace:view:read"),
    # workspace_viewer: same as Phase-1 ``viewer`` role bundle.
    ("workspace_viewer", "workspace:datasource:read"),
    ("workspace_viewer", "workspace:view:read"),
]


def _has_table(inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── Upgrade ─────────────────────────────────────────────────────────


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "permissions"):
        # Pre-Phase-1 DB — nothing to rewrite. Caller has bigger
        # problems; we no-op gracefully.
        return

    # 1. Rename permissions. We INSERT the new ids first, then move
    #    the role_permissions + delete the old rows. INSERT-first
    #    keeps the FK from role_permissions valid across the swap.
    for old, new in _PERMISSION_RENAMES:
        row = bind.execute(
            sa.text("SELECT description, category FROM permissions WHERE id = :id"),
            {"id": old},
        ).first()
        if row is None:
            continue
        description, category = row
        bind.execute(
            sa.text(
                "INSERT INTO permissions (id, description, category) "
                "VALUES (:id, :desc, :cat) ON CONFLICT (id) DO NOTHING"
            ),
            {"id": new, "desc": description, "cat": category},
        )
        bind.execute(
            sa.text(
                "UPDATE role_permissions SET permission_id = :new "
                "WHERE permission_id = :old"
            ),
            {"new": new, "old": old},
        )
        bind.execute(
            sa.text("DELETE FROM permissions WHERE id = :id"),
            {"id": old},
        )

    # 2. Insert the new ``system:org-admin`` permission.
    for pid, pdesc, pcat in _NEW_PERMISSIONS:
        bind.execute(
            sa.text(
                "INSERT INTO permissions (id, description, category) "
                "VALUES (:id, :desc, :cat) ON CONFLICT (id) DO NOTHING"
            ),
            {"id": pid, "desc": pdesc, "cat": pcat},
        )

    if not _has_table(inspector, "roles"):
        return

    # 3. Rename roles. Two-phase: INSERT the new row, move bindings +
    #    role_permissions across, then DELETE the old row. Doing it
    #    in this order keeps the FKs valid throughout.
    now = _now()

    def _rename_role(old: str, new: str, description: str, scope: str) -> None:
        existing_new = bind.execute(
            sa.text("SELECT name FROM roles WHERE name = :n"),
            {"n": new},
        ).first()
        if existing_new is None:
            bind.execute(
                sa.text(
                    "INSERT INTO roles "
                    "(name, description, scope_type, scope_id, is_system, "
                    " created_at, updated_at, created_by) "
                    "VALUES (:name, :desc, :scope, NULL, TRUE, "
                    "        :now, :now, NULL) "
                    "ON CONFLICT (name) DO NOTHING"
                ),
                {"name": new, "desc": description, "scope": scope, "now": now},
            )

    # Rename ``admin`` per scope. All new role rows are global (the
    # CHECK constraint requires workspace-scoped roles to have a
    # concrete scope_id, which templates don't have).
    _rename_role(
        "admin", "super_admin",
        "Platform owner. Carries system:admin; implies every permission, every scope.",
        "global",
    )

    # Insert the remaining new roles (workspace_admin / workspace_member /
    # workspace_viewer / org_admin). ``admin`` itself was renamed to
    # ``super_admin`` above; ``user`` and ``viewer`` rows get cleaned
    # up after bindings are rewritten.
    for name, desc, scope in _NEW_ROLES:
        bind.execute(
            sa.text(
                "INSERT INTO roles "
                "(name, description, scope_type, scope_id, is_system, "
                " created_at, updated_at, created_by) "
                "VALUES (:name, :desc, :scope, NULL, TRUE, "
                "        :now, :now, NULL) "
                "ON CONFLICT (name) DO NOTHING"
            ),
            {"name": name, "desc": desc, "scope": scope, "now": now},
        )

    # 4. Rewrite role_permissions: drop the old role rows + insert the
    #    post-rename catalogue. We re-insert everything to make this
    #    idempotent on partial reruns.
    if _has_table(inspector, "role_permissions"):
        bind.execute(
            sa.text(
                "DELETE FROM role_permissions WHERE role_name IN "
                "('admin', 'user', 'viewer', "
                " 'super_admin', 'org_admin', 'workspace_admin', "
                " 'workspace_member', 'workspace_viewer')"
            )
        )
        for role_name, perm_id in _ROLE_PERMISSIONS_AFTER:
            bind.execute(
                sa.text(
                    "INSERT INTO role_permissions (role_name, permission_id) "
                    "VALUES (:r, :p) ON CONFLICT DO NOTHING"
                ),
                {"r": role_name, "p": perm_id},
            )

    # 5. Rewrite role_bindings to the new names. Drop the Phase-1
    #    legacy ``(role='user', scope='global')`` rows that
    #    _backfill_global_user_roles inserted — those were always
    #    malformed (``user`` is workspace-scoped) and would be
    #    dropped by the Phase-5 category filter anyway. WARNING-log
    #    each so operators can see what happened.
    if _has_table(inspector, "role_bindings"):
        legacy_user_global = bind.execute(
            sa.text(
                "SELECT id, subject_id FROM role_bindings "
                "WHERE role_name = 'user' AND scope_type = 'global'"
            )
        ).fetchall()
        for row in legacy_user_global:
            log.warning(
                "rbac_uplift: dropping legacy (role='user', scope='global') "
                "binding id=%s subject=%s",
                row[0], row[1],
            )
        bind.execute(
            sa.text(
                "DELETE FROM role_bindings "
                "WHERE role_name = 'user' AND scope_type = 'global'"
            )
        )
        # Same for any ``viewer`` at global scope (never seeded by
        # Phase 1 but defensive against operator-created rows).
        bind.execute(
            sa.text(
                "DELETE FROM role_bindings "
                "WHERE role_name = 'viewer' AND scope_type = 'global'"
            )
        )
        # Now the renames.
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'super_admin' "
                "WHERE role_name = 'admin' AND scope_type = 'global'"
            )
        )
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'workspace_admin' "
                "WHERE role_name = 'admin' AND scope_type = 'workspace'"
            )
        )
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'workspace_member' "
                "WHERE role_name = 'user' AND scope_type = 'workspace'"
            )
        )
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'workspace_viewer' "
                "WHERE role_name = 'viewer' AND scope_type = 'workspace'"
            )
        )

    # 6. Rewrite the legacy ``user_roles`` table (Phase-0 global roles
    #    table; still consulted by ``require_admin``). The CHECK
    #    constraint there (``ck_user_roles_role_name``) was dropped in
    #    Phase 3 — so an UPDATE is safe.
    if _has_table(inspector, "user_roles"):
        bind.execute(
            sa.text(
                "UPDATE user_roles SET role_name = 'super_admin' "
                "WHERE role_name = 'admin'"
            )
        )
        # Drop legacy ``user``/``viewer`` rows at the user_roles level
        # — they were never meaningful (user_roles is a global table)
        # and Phase 5 doesn't grant any global-scoped non-admin role.
        bind.execute(
            sa.text(
                "DELETE FROM user_roles WHERE role_name IN ('user', 'viewer')"
            )
        )

    # 7. Drop the old role rows.
    bind.execute(
        sa.text("DELETE FROM roles WHERE name IN ('admin', 'user', 'viewer')")
    )


# ── Downgrade ───────────────────────────────────────────────────────


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "roles"):
        return

    now = _now()

    # Re-create the old roles (best-effort; we lose the per-row
    # provenance for legacy ``user``/``viewer`` global rows).
    for name, desc, scope in (
        ("admin", "Full system access across every workspace and resource.", "global"),
        ("user", "Standard workspace member — manage views and data sources.", "workspace"),
        ("viewer", "Read-only access to views and data sources.", "workspace"),
    ):
        bind.execute(
            sa.text(
                "INSERT INTO roles "
                "(name, description, scope_type, scope_id, is_system, "
                " created_at, updated_at, created_by) "
                "VALUES (:name, :desc, :scope, NULL, TRUE, "
                "        :now, :now, NULL) "
                "ON CONFLICT (name) DO NOTHING"
            ),
            {"name": name, "desc": desc, "scope": scope, "now": now},
        )

    # Rewrite role_bindings back.
    if _has_table(inspector, "role_bindings"):
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'admin' "
                "WHERE role_name IN ('super_admin', 'workspace_admin')"
            )
        )
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'user' "
                "WHERE role_name = 'workspace_member'"
            )
        )
        bind.execute(
            sa.text(
                "UPDATE role_bindings SET role_name = 'viewer' "
                "WHERE role_name = 'workspace_viewer'"
            )
        )
        bind.execute(
            sa.text(
                "DELETE FROM role_bindings WHERE role_name = 'org_admin'"
            )
        )

    # user_roles back.
    if _has_table(inspector, "user_roles"):
        bind.execute(
            sa.text(
                "UPDATE user_roles SET role_name = 'admin' "
                "WHERE role_name = 'super_admin'"
            )
        )

    # role_permissions back to Phase-4 shape.
    if _has_table(inspector, "role_permissions"):
        bind.execute(
            sa.text(
                "DELETE FROM role_permissions WHERE role_name IN "
                "('super_admin', 'org_admin', 'workspace_admin', "
                " 'workspace_member', 'workspace_viewer')"
            )
        )
        # Re-seed Phase 1 bundles.
        phase1_perms = (
            [("admin", p) for p in (
                "system:admin", "users:manage", "groups:manage",
                "workspaces:create", "workspace:admin",
                "workspace:datasource:manage", "workspace:datasource:read",
                "workspace:view:create", "workspace:view:edit",
                "workspace:view:delete", "workspace:view:read",
            )]
            + [("user", p) for p in (
                "workspace:datasource:manage", "workspace:datasource:read",
                "workspace:view:create", "workspace:view:edit",
                "workspace:view:delete", "workspace:view:read",
            )]
            + [("viewer", p) for p in (
                "workspace:datasource:read", "workspace:view:read",
            )]
        )
        for role_name, perm_id in phase1_perms:
            bind.execute(
                sa.text(
                    "INSERT INTO role_permissions (role_name, permission_id) "
                    "VALUES (:r, :p) ON CONFLICT DO NOTHING"
                ),
                {"r": role_name, "p": perm_id},
            )

    # Drop the new roles.
    bind.execute(
        sa.text(
            "DELETE FROM roles WHERE name IN "
            "('super_admin', 'org_admin', 'workspace_admin', "
            " 'workspace_member', 'workspace_viewer')"
        )
    )

    # Rename permissions back.
    for old, new in _PERMISSION_RENAMES:
        row = bind.execute(
            sa.text("SELECT description, category FROM permissions WHERE id = :id"),
            {"id": new},
        ).first()
        if row is None:
            continue
        description, category = row
        bind.execute(
            sa.text(
                "INSERT INTO permissions (id, description, category) "
                "VALUES (:id, :desc, :cat) ON CONFLICT (id) DO NOTHING"
            ),
            {"id": old, "desc": description, "cat": category},
        )
        bind.execute(
            sa.text(
                "UPDATE role_permissions SET permission_id = :old "
                "WHERE permission_id = :new"
            ),
            {"new": new, "old": old},
        )
        bind.execute(
            sa.text("DELETE FROM permissions WHERE id = :id"),
            {"id": new},
        )

    # Drop the new permission.
    bind.execute(
        sa.text("DELETE FROM permissions WHERE id = 'system:org-admin'")
    )
