"""ACCESS R0 — seed ``workspace:datasource:publish`` and ``workspace_publisher``.

Revision ID: 20261017_1000_datasource_publish
Revises: 20261023_1200_service_accounts
Create Date: 2026-10-17 10:00

Advancing a versioned data source's Published version — publishing a
draft, merging a review, reverting, restoring or syncing — is a
governance act, so it gets its own permission instead of riding on
``workspace:datasource:manage``. Nothing checks it yet: enforcement is
ACCESS R3 (docs/versioning/13-access-and-review.md). This revision only
seeds the catalogue so admins can bind publishers before then.

Grants: ``org_admin``, ``super_admin`` and ``workspace_data_engineer``
explicitly; ``workspace_admin`` stores only ``workspace:admin`` and the
resolver auto-implies the new leaf via the extended
``_WORKSPACE_CATEGORY_LEAVES``. ``workspace_member`` does NOT receive it.
The new system role ``workspace_publisher`` gets the member bundle plus
publish. That bundle mirrors the SEED ``workspace_member`` grants, not a
member role an operator has customised.

The same commit adds the leaf to ``_SEED_LEAVES["workspace:datasource"]``
so the wildcard collapser stops emitting ``workspace:datasource:*`` for
roles that hold only read+manage — otherwise every member would satisfy
a publish check through the wildcard. Sessions minted before this deploys
may still carry the collapsed wildcard until their next refresh (bounded
by the access-token TTL); harmless until R3, which forces a refresh.

Every INSERT is unconditional ``ON CONFLICT DO NOTHING``. A custom role an
operator already named ``workspace_publisher`` is therefore kept as is,
but gains the publisher grants; rename it before upgrading if that is not
wanted.

Fresh installs get the same rows from ``backend.app.config.rbac_seed``;
``backend/tests/test_rbac_migration.py`` holds the two paths together.

Downgrade removes every publish grant and the permission; it removes the
role and its grants only while nothing binds it, so a bound publisher
keeps member access.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261017_1000_datasource_publish"
down_revision: Union[str, None] = "20261023_1200_service_accounts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERM = "workspace:datasource:publish"
_ROLE = "workspace_publisher"

_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, category, description)
    (_PERM, "workspace", "Advance a versioned data source's Published version."),
]


_NEW_LONG_DESCRIPTIONS: dict[str, str] = {
    _PERM: (
        "Publish drafts, merge reviewed changes, and revert, restore or "
        "sync the Published version of a versioned data source. Editing "
        "drafts and opening reviews only needs workspace:datasource:manage."
    ),
}


_NEW_EXAMPLES: dict[str, list[str]] = {
    _PERM: [
        "Publish a draft to the data source's Published version.",
        "Merge an approved review.",
        "Revert the Published version to an earlier commit.",
    ],
}


_NEW_ROLES: list[tuple[str, str, str]] = [
    # (name, description, scope_type)
    (
        _ROLE,
        "Workspace member who can also publish versioned data sources "
        "(advance their Published version).",
        "global",
    ),
]


# The seed workspace_member bundle plus publish.
_PUBLISHER_GRANTS: list[str] = [
    "workspace:catalog:read",
    "workspace:datasource:manage",
    _PERM,
    "workspace:datasource:read",
    "workspace:ontology:read",
    "workspace:provider:read",
    "workspace:view:create",
    "workspace:view:delete",
    "workspace:view:edit",
    "workspace:view:read",
]


_NEW_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", _PERM),
    ("super_admin", _PERM),
    ("workspace_data_engineer", _PERM),
] + [(_ROLE, p) for p in _PUBLISHER_GRANTS]


def upgrade() -> None:
    conn = op.get_bind()
    now = _now_iso()

    # ``conn.execute(sa.text(...), {...})`` — NOT exec_driver_sql; see
    # the Phase-18 migration for why.
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
                "examples": json.dumps(_NEW_EXAMPLES.get(perm_id, [])),
            },
        )

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
            {"name": role_name, "desc": role_desc, "scope": scope_type, "now": now},
        )

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
    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :id"),
        {"id": _PERM},
    )
    # The system role, only while nothing binds it: grants first, then
    # the row they hang off.
    removable = (
        "EXISTS (SELECT 1 FROM roles WHERE name = :name AND is_system) "
        "AND NOT EXISTS (SELECT 1 FROM role_bindings WHERE role_name = :name)"
    )
    conn.execute(
        sa.text(f"DELETE FROM role_permissions WHERE role_name = :name AND {removable}"),
        {"name": _ROLE},
    )
    conn.execute(
        sa.text(f"DELETE FROM roles WHERE name = :name AND {removable}"),
        {"name": _ROLE},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERM})


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
