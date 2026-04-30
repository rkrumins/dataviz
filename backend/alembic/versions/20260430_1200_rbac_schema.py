"""RBAC Phase 1 — Subject-Role-Scope binding model.

Revision ID: 20260430_1200_rbac_schema
Revises: 20260426_1600_job_event_log
Create Date: 2026-04-30 12:00

Lands the schema for the enterprise RBAC layer:

  * ``permissions`` — catalogue of every permission identifier
  * ``role_permissions`` — bundle a role into its permission set
  * ``groups`` and ``group_members`` — the second Subject type
  * ``role_bindings`` — the central (subject, role, scope) table
  * ``resource_grants`` — per-View explicit shares (Layer 3 ACL)

Also adds ``created_by`` audit columns to ``workspaces`` and
``workspace_data_sources``.

The migration is **idempotent on every step**:
  * Schema creation guards on ``inspector.has_table`` /
    ``inspector.has_column`` so partial reruns are safe.
  * Seed and backfill use ``ON CONFLICT DO NOTHING`` so re-running on a
    fresh deploy where 0001_baseline already created tables produces no
    duplicates and no errors.

No behavioural change ships with this migration. The new
``PermissionService``, ``requires(...)`` dependency, and Redis
revocation set land alongside the migration but are not yet wired into
existing endpoints — Phase 2 does that endpoint by endpoint behind
kill-switch env vars.

Membership backfill rule: every user with ``status = 'active'`` is
bound as ``user`` role in every workspace where ``deleted_at IS NULL``.
This preserves today's "everyone sees everything" until workspace
admins curate their member lists.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260430_1200_rbac_schema"
down_revision: Union[str, None] = "20260426_1600_job_event_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------- #
# Permission catalogue — kept here so the seed is part of the migration. #
# ---------------------------------------------------------------------- #

_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, description, category)
    ("system:admin",                  "Full system control; implies every other permission.", "system"),
    ("users:manage",                  "Create, approve, suspend, and change roles for users.", "system"),
    ("groups:manage",                 "Create, edit, delete groups and manage their members.",  "system"),
    ("workspaces:create",             "Create new workspaces.",                                  "system"),
    ("workspace:admin",               "Manage workspace settings, members, and deletion.",       "workspace"),
    ("workspace:datasource:manage",   "Connect, edit, and delete data sources in a workspace.",  "workspace"),
    ("workspace:datasource:read",     "List and use workspace data sources in views.",           "workspace"),
    ("workspace:view:create",         "Create new views in a workspace.",                        "workspace"),
    ("workspace:view:edit",           "Edit any view in a workspace.",                           "workspace"),
    ("workspace:view:delete",         "Soft-delete any view in a workspace.",                    "workspace"),
    ("workspace:view:read",           "List and open views in a workspace.",                     "workspace"),
]

# Role → permission bundles. Admin gets every permission.
_ADMIN_PERMS = [p[0] for p in _PERMISSIONS]
_USER_PERMS = [
    "workspace:datasource:manage",
    "workspace:datasource:read",
    "workspace:view:create",
    "workspace:view:edit",
    "workspace:view:delete",
    "workspace:view:read",
]
_VIEWER_PERMS = [
    "workspace:datasource:read",
    "workspace:view:read",
]
_ROLE_PERMISSIONS: list[tuple[str, str]] = (
    [("admin", p) for p in _ADMIN_PERMS]
    + [("user", p) for p in _USER_PERMS]
    + [("viewer", p) for p in _VIEWER_PERMS]
)


# ---------------------------------------------------------------------- #
# Idempotency helpers                                                     #
# ---------------------------------------------------------------------- #

def _has_table(inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _has_column(inspector, table: str, column: str) -> bool:
    return any(c["name"] == column for c in inspector.get_columns(table))


# ---------------------------------------------------------------------- #
# Upgrade                                                                 #
# ---------------------------------------------------------------------- #

def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ── audit columns ────────────────────────────────────────────────
    if _has_table(inspector, "workspaces") and not _has_column(inspector, "workspaces", "created_by"):
        op.add_column("workspaces", sa.Column("created_by", sa.Text(), nullable=True))
    if _has_table(inspector, "workspace_data_sources") and not _has_column(inspector, "workspace_data_sources", "created_by"):
        op.add_column("workspace_data_sources", sa.Column("created_by", sa.Text(), nullable=True))

    # ── permissions ──────────────────────────────────────────────────
    if not _has_table(inspector, "permissions"):
        op.create_table(
            "permissions",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column("category", sa.Text(), nullable=False),
            sa.CheckConstraint(
                "category IN ('system', 'workspace', 'resource')",
                name="ck_permissions_category",
            ),
        )

    # ── role_permissions ─────────────────────────────────────────────
    if not _has_table(inspector, "role_permissions"):
        op.create_table(
            "role_permissions",
            sa.Column("role_name", sa.Text(), primary_key=True),
            sa.Column(
                "permission_id",
                sa.Text(),
                sa.ForeignKey("permissions.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.CheckConstraint(
                "role_name IN ('admin', 'user', 'viewer')",
                name="ck_role_permissions_role_name",
            ),
        )
        op.create_index(
            "idx_role_permissions_role", "role_permissions", ["role_name"]
        )

    # ── groups ───────────────────────────────────────────────────────
    if not _has_table(inspector, "groups"):
        op.create_table(
            "groups",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("source", sa.Text(), nullable=False, server_default="local"),
            sa.Column("external_id", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("deleted_at", sa.Text(), nullable=True),
            sa.UniqueConstraint("name", name="uq_groups_name"),
            sa.CheckConstraint(
                "source IN ('local', 'scim')", name="ck_groups_source"
            ),
        )
        op.create_index("idx_groups_deleted_at", "groups", ["deleted_at"])
        op.create_index("idx_groups_external_id", "groups", ["external_id"])

    # ── group_members ────────────────────────────────────────────────
    if not _has_table(inspector, "group_members"):
        op.create_table(
            "group_members",
            sa.Column(
                "group_id",
                sa.Text(),
                sa.ForeignKey("groups.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("added_at", sa.Text(), nullable=False),
            sa.Column("added_by", sa.Text(), nullable=True),
        )
        op.create_index("idx_group_members_user", "group_members", ["user_id"])

    # ── role_bindings ────────────────────────────────────────────────
    if not _has_table(inspector, "role_bindings"):
        op.create_table(
            "role_bindings",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("subject_type", sa.Text(), nullable=False),
            sa.Column("subject_id", sa.Text(), nullable=False),
            sa.Column("role_name", sa.Text(), nullable=False),
            sa.Column("scope_type", sa.Text(), nullable=False),
            sa.Column("scope_id", sa.Text(), nullable=True),
            sa.Column("granted_at", sa.Text(), nullable=False),
            sa.Column("granted_by", sa.Text(), nullable=True),
            sa.Column("expires_at", sa.Text(), nullable=True),
            sa.UniqueConstraint(
                "subject_type", "subject_id", "role_name", "scope_type", "scope_id",
                name="uq_role_binding",
            ),
            sa.CheckConstraint(
                "subject_type IN ('user', 'group')",
                name="ck_role_bindings_subject_type",
            ),
            sa.CheckConstraint(
                "scope_type IN ('global', 'workspace')",
                name="ck_role_bindings_scope_type",
            ),
            sa.CheckConstraint(
                "(scope_type = 'global' AND scope_id IS NULL) "
                "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
                name="ck_role_bindings_scope_consistency",
            ),
            sa.CheckConstraint(
                "role_name IN ('admin', 'user', 'viewer')",
                name="ck_role_bindings_role_name",
            ),
        )
        op.create_index(
            "idx_role_bindings_subject",
            "role_bindings",
            ["subject_id", "scope_type", "scope_id"],
        )
        op.create_index(
            "idx_role_bindings_scope",
            "role_bindings",
            ["scope_type", "scope_id"],
        )
        op.create_index(
            "idx_role_bindings_role", "role_bindings", ["role_name"]
        )

    # ── resource_grants ──────────────────────────────────────────────
    if not _has_table(inspector, "resource_grants"):
        op.create_table(
            "resource_grants",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("resource_type", sa.Text(), nullable=False),
            sa.Column("resource_id", sa.Text(), nullable=False),
            sa.Column("subject_type", sa.Text(), nullable=False),
            sa.Column("subject_id", sa.Text(), nullable=False),
            sa.Column("role_name", sa.Text(), nullable=False),
            sa.Column("granted_at", sa.Text(), nullable=False),
            sa.Column("granted_by", sa.Text(), nullable=True),
            sa.UniqueConstraint(
                "resource_type", "resource_id", "subject_type", "subject_id",
                name="uq_resource_grant_subject",
            ),
            sa.CheckConstraint(
                "resource_type IN ('view')",
                name="ck_resource_grants_resource_type",
            ),
            sa.CheckConstraint(
                "subject_type IN ('user', 'group')",
                name="ck_resource_grants_subject_type",
            ),
            sa.CheckConstraint(
                "role_name IN ('editor', 'viewer')",
                name="ck_resource_grants_role_name",
            ),
        )
        op.create_index(
            "idx_resource_grants_resource",
            "resource_grants",
            ["resource_type", "resource_id"],
        )
        op.create_index(
            "idx_resource_grants_subject",
            "resource_grants",
            ["subject_type", "subject_id"],
        )

    # ── seed: permissions catalogue + role_permissions ───────────────
    _seed_permissions(bind)

    # ── backfill: existing UserRoleORM rows → role_bindings (global) ─
    _backfill_global_role_bindings(bind)

    # ── backfill: every active user × every live workspace as 'user' ─
    _backfill_workspace_memberships(bind)


def _seed_permissions(bind) -> None:
    """Insert the permission catalogue and role bundles. Idempotent
    via ON CONFLICT against the primary keys of both tables."""
    for pid, pdesc, pcat in _PERMISSIONS:
        bind.execute(
            sa.text(
                "INSERT INTO permissions (id, description, category) "
                "VALUES (:id, :description, :category) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"id": pid, "description": pdesc, "category": pcat},
        )
    for role_name, permission_id in _ROLE_PERMISSIONS:
        bind.execute(
            sa.text(
                "INSERT INTO role_permissions (role_name, permission_id) "
                "VALUES (:role_name, :permission_id) "
                "ON CONFLICT (role_name, permission_id) DO NOTHING"
            ),
            {"role_name": role_name, "permission_id": permission_id},
        )


def _backfill_global_role_bindings(bind) -> None:
    """Materialize each existing ``user_roles`` row as a global RoleBinding.

    Uses a stable id derived from the source row's id so the operation
    is idempotent across reruns. The ``ON CONFLICT DO NOTHING`` here
    is intentionally **untargeted** — a targeted clause only catches
    violations on the named constraint, but a rerun can collide on
    EITHER the primary key (deterministic id) OR the unique business
    key (subject_type, subject_id, role_name, scope_type, scope_id).
    Untargeted DO NOTHING catches both.
    """
    bind.execute(sa.text(
        """
        INSERT INTO role_bindings (
            id, subject_type, subject_id, role_name,
            scope_type, scope_id, granted_at, granted_by, expires_at
        )
        SELECT
            'bnd_legacy_' || ur.id,
            'user',
            ur.user_id,
            ur.role_name,
            'global',
            NULL,
            COALESCE(ur.created_at, to_char(now() AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')),
            NULL,
            NULL
        FROM user_roles ur
        WHERE ur.role_name IN ('admin', 'user', 'viewer')
        ON CONFLICT DO NOTHING
        """
    ))


def _backfill_workspace_memberships(bind) -> None:
    """Bind every active user as ``user`` role in every live workspace.

    Preserves today's "every authenticated user can act on every
    workspace" until workspace admins curate the member list. Soft-
    deleted workspaces and non-active users are skipped.

    Untargeted ``ON CONFLICT DO NOTHING`` for the same reason as the
    legacy backfill above: reruns can collide on the deterministic
    primary key OR on the unique business key, depending on which
    rows were committed by an earlier partial run.
    """
    bind.execute(sa.text(
        """
        INSERT INTO role_bindings (
            id, subject_type, subject_id, role_name,
            scope_type, scope_id, granted_at, granted_by, expires_at
        )
        SELECT
            'bnd_seed_' || substr(md5(u.id || ':' || w.id), 1, 16),
            'user',
            u.id,
            'user',
            'workspace',
            w.id,
            to_char(now() AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
            NULL,
            NULL
        FROM users u
        CROSS JOIN workspaces w
        WHERE u.status = 'active'
          AND u.deleted_at IS NULL
          AND w.deleted_at IS NULL
        ON CONFLICT DO NOTHING
        """
    ))


# ---------------------------------------------------------------------- #
# Downgrade                                                               #
# ---------------------------------------------------------------------- #

def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Drop in reverse-FK order. Tables that don't exist are skipped.
    for table_name, indexes in [
        ("resource_grants", ["idx_resource_grants_subject", "idx_resource_grants_resource"]),
        ("role_bindings", ["idx_role_bindings_role", "idx_role_bindings_scope", "idx_role_bindings_subject"]),
        ("group_members", ["idx_group_members_user"]),
        ("groups", ["idx_groups_external_id", "idx_groups_deleted_at"]),
        ("role_permissions", ["idx_role_permissions_role"]),
        ("permissions", []),
    ]:
        if _has_table(inspector, table_name):
            for idx in indexes:
                op.drop_index(idx, table_name=table_name)
            op.drop_table(table_name)

    # Audit columns — kept by default. Dropping them risks losing data
    # if downgrade is run after rows have populated `created_by`. The
    # next downgrade revision can drop them explicitly if needed.
