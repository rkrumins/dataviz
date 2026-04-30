"""RBAC Phase 3 — role-lifecycle: roles table + custom + scoped roles.

Revision ID: 20260430_1500_roles_lifecycle
Revises: 20260430_1200_rbac_schema
Create Date: 2026-04-30 15:00

Phase 1 baked admin/user/viewer into CHECK constraints on
``role_permissions.role_name`` and ``role_bindings.role_name``. That
made the schema safe but made custom roles physically impossible.

Phase 3 unlocks the full lifecycle:

  * New ``roles`` table is the canonical role definition. Each row is
    either a built-in (``is_system=true``, immutable) or admin-defined
    (``is_system=false``, editable + deletable when unused).
  * Each role has a scope: ``global`` (usable in any binding) or
    ``workspace`` (only valid inside that workspace's bindings — the
    "WS-Finance-Auditor" pattern). Application-level guards enforce
    that bindings can only reference a role whose scope matches.
  * The CHECK constraints on the three Phase-1 role names are dropped
    so app + DB FKs become the source of truth for the role enum.
  * The seven Phase-1 permissions stay; their bundles are unchanged.

The migration is idempotent (skip-if-exists) and safe to rerun.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260430_1500_roles_lifecycle"
down_revision: Union[str, None] = "20260430_1200_rbac_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_SYSTEM_ROLES: list[tuple[str, str]] = [
    ("admin",  "Full system access across every workspace and resource."),
    ("user",   "Standard workspace member — manage views and data sources."),
    ("viewer", "Read-only access to views and data sources."),
]


def _has_table(inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _has_constraint(bind, table: str, name: str) -> bool:
    """True if a CHECK constraint with the given name exists on the
    table. Postgres-only — the only DB this migration runs against."""
    row = bind.execute(
        sa.text(
            """
            SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = :table AND c.conname = :name
            LIMIT 1
            """
        ),
        {"table": table, "name": name},
    ).first()
    return row is not None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ── 1. Create the canonical roles table ─────────────────────────
    if not _has_table(inspector, "roles"):
        op.create_table(
            "roles",
            sa.Column("name", sa.Text(), primary_key=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("scope_type", sa.Text(), nullable=False, server_default="global"),
            sa.Column("scope_id", sa.Text(), nullable=True),
            sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("created_by", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "scope_type IN ('global', 'workspace')",
                name="ck_roles_scope_type",
            ),
            sa.CheckConstraint(
                "(scope_type = 'global' AND scope_id IS NULL) "
                "OR (scope_type = 'workspace' AND scope_id IS NOT NULL)",
                name="ck_roles_scope_consistency",
            ),
        )
        op.create_index("idx_roles_scope", "roles", ["scope_type", "scope_id"])
        op.create_index("idx_roles_is_system", "roles", ["is_system"])

    # ── 2. Seed the system roles ────────────────────────────────────
    for name, description in _SYSTEM_ROLES:
        bind.execute(
            sa.text(
                """
                INSERT INTO roles (
                    name, description, scope_type, scope_id, is_system,
                    created_at, updated_at, created_by
                )
                VALUES (
                    :name, :description, 'global', NULL, true,
                    to_char(now() AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
                    to_char(now() AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'),
                    NULL
                )
                ON CONFLICT (name) DO UPDATE SET
                    description = EXCLUDED.description,
                    is_system = true
                """
            ),
            {"name": name, "description": description},
        )

    # ── 3. Drop the Phase-1 CHECK constraints so custom names are
    #       physically possible.
    for table, constraint in [
        ("role_permissions", "ck_role_permissions_role_name"),
        ("role_bindings", "ck_role_bindings_role_name"),
    ]:
        if _has_table(inspector, table) and _has_constraint(bind, table, constraint):
            op.drop_constraint(constraint, table, type_="check")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Restore the CHECK constraints first — abort the downgrade if any
    # row references a role outside the Phase-1 enum (otherwise the
    # constraint would fail on add).
    for table in ("role_permissions", "role_bindings"):
        if not _has_table(inspector, table):
            continue
        bad = bind.execute(
            sa.text(
                f"SELECT COUNT(*) FROM {table} "
                "WHERE role_name NOT IN ('admin', 'user', 'viewer')"
            )
        ).scalar() or 0
        if bad:
            raise RuntimeError(
                f"Cannot downgrade: {bad} row(s) in {table} reference a "
                "non-system role. Delete those rows first or stay on "
                "the 20260430_1500 revision."
            )

    if _has_table(inspector, "role_permissions"):
        op.create_check_constraint(
            "ck_role_permissions_role_name", "role_permissions",
            "role_name IN ('admin', 'user', 'viewer')",
        )
    if _has_table(inspector, "role_bindings"):
        op.create_check_constraint(
            "ck_role_bindings_role_name", "role_bindings",
            "role_name IN ('admin', 'user', 'viewer')",
        )

    if _has_table(inspector, "roles"):
        op.drop_index("idx_roles_is_system", table_name="roles")
        op.drop_index("idx_roles_scope", table_name="roles")
        op.drop_table("roles")
