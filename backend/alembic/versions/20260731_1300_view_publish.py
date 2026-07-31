"""View-sharing rework — seed ``workspace:view:publish``.

Revision ID: 20260731_1300_view_publish
Revises: 20260731_1200_ctxmodel_vis
Create Date: 2026-07-31 13:00

Publishing a view to ``enterprise`` visibility now exposes it — and
read-only access to its underlying data source — to every signed-in
user on the platform. That is a governance act, so it moves behind a
dedicated permission instead of riding on view creatorship:

  * ``workspace:view:publish`` — required for any visibility transition
    to or from ``enterprise`` (and for creating a view directly as
    ``enterprise``). Private ↔ workspace transitions stay with the
    creator / workspace admin.

Grants: ``org_admin`` and ``super_admin`` explicitly (the global
short-circuit would let them through anyway; the explicit rows keep the
role-matrix admin UI honest — Phase-18 precedent). ``workspace_admin``
stores only ``workspace:admin``; the resolver auto-implies the new leaf
via the extended ``_WORKSPACE_CATEGORY_LEAVES`` in
``backend/app/services/permission_service.py``. No member/viewer tier
receives it.

The same commit adds the leaf to ``_SEED_LEAVES["workspace:view"]`` so
the wildcard collapser stops emitting ``workspace:view:*`` for roles
that hold only the four legacy leaves — otherwise every
workspace_member would satisfy a publish check through the wildcard.
Sessions minted before this deploys may still carry the collapsed
wildcard until their next refresh (bounded by the access-token TTL).

Fresh installs get the same rows from ``backend.app.config.rbac_seed``;
``backend/tests/test_rbac_migration.py`` holds the two paths together.

Idempotent: every INSERT uses ``ON CONFLICT DO NOTHING`` so re-running
the migration (chain-replay over a create_all baseline) is a no-op.

Downgrade removes the role grants then the permission row.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260731_1300_view_publish"
down_revision: Union[str, None] = "20260731_1200_ctxmodel_vis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, category, description)
    (
        "workspace:view:publish",
        "workspace",
        "Publish views to everyone in the organization (enterprise visibility).",
    ),
]


_NEW_LONG_DESCRIPTIONS: dict[str, str] = {
    "workspace:view:publish": (
        "Move views to and from enterprise visibility — making them "
        "visible to every signed-in user on the platform, with "
        "read-only access to the underlying data. Changing a view "
        "between private and workspace visibility does not need this "
        "permission."
    ),
}


_NEW_EXAMPLES: dict[str, list[str]] = {
    "workspace:view:publish": [
        "Publish a curated lineage view for the whole organization.",
        "Unpublish an enterprise view back to workspace visibility.",
    ],
}


# Role -> permission_id rows. workspace_admin keeps its
# ``workspace:admin`` shorthand; the resolver auto-implies the new leaf
# via the extended ``_WORKSPACE_CATEGORY_LEAVES``.
_NEW_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", "workspace:view:publish"),
    ("super_admin", "workspace:view:publish"),
]


def upgrade() -> None:
    conn = op.get_bind()

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
    for perm_id in [p[0] for p in _NEW_PERMISSIONS]:
        conn.execute(
            sa.text("DELETE FROM role_permissions WHERE permission_id = :id"),
            {"id": perm_id},
        )
        conn.execute(
            sa.text("DELETE FROM permissions WHERE id = :id"),
            {"id": perm_id},
        )
