"""Seed ``system:analytics:read`` and its role grants.

Revision ID: 20260823_1200_analytics_perm
Revises: 20260821_1200_event_subject
Create Date: 2026-08-23 12:00

The Analytics section is gated on a dedicated platform privilege rather than on
an audit grant: business reporting is not login history, and answering "who may
see growth metrics?" with "whoever may read the audit log" is the wrong answer
to a question operators ask on its own.

The permission was added to ``backend/app/config/rbac_seed.py`` and nowhere
else, which reaches FRESH installs only — ``seed_reference_data`` runs on the
virgin-database path and existing databases have always taken these rows from
the migration chain. So on every already-installed deployment the permission
row did not exist, the three grants did not exist, it could not be granted to a
custom role, and it never appeared in the role-matrix admin UI. The section kept
working solely through the three older permissions that ``analytics_scope``
retains as a compatibility net — which inverts the design: the dedicated
permission was the one that did nothing.

Grants mirror ``rbac_seed.ROLE_GRANTS`` exactly: ``org_admin`` and
``org_auditor`` are the two seeded roles whose job includes reading platform
figures, and ``super_admin`` holds it explicitly even though ``system:admin``
would short-circuit the check anyway — the explicit row is what keeps the
role-matrix admin UI honest (Phase-18 precedent, same as
``20260731_1300_view_publish``).

``backend/tests/test_rbac_migration.py`` holds the two paths together.

Idempotent: every INSERT is ``ON CONFLICT DO NOTHING``, so replaying the chain
over a ``create_all`` baseline is a no-op.

Downgrade removes the role grants then the permission row.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260823_1200_analytics_perm"
down_revision: Union[str, None] = "20260821_1200_event_subject"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, category, description)
    (
        "system:analytics:read",
        "system",
        "Read platform analytics — growth, engagement and adoption.",
    ),
]


_NEW_LONG_DESCRIPTIONS: dict[str, str] = {
    "system:analytics:read": (
        "Lets you open the Analytics section and see platform-wide growth, "
        "engagement and adoption, including per-person activity and "
        "operational health. Deliberately SEPARATE from system:audit:read: "
        "business metrics are not the audit log, and someone who should see "
        "how the platform is growing does not automatically need every login "
        "and RBAC mutation. Workspace-level detail still follows the normal "
        "workspace permissions — this grants no access to a workspace you are "
        "not otherwise entitled to."
    ),
}


_NEW_EXAMPLES: dict[str, list[str]] = {
    "system:analytics:read": [
        "See how many people signed up this quarter and how many are still active.",
        "Find which views the organisation actually opens.",
    ],
}


_NEW_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", "system:analytics:read"),
    ("org_auditor", "system:analytics:read"),
    ("super_admin", "system:analytics:read"),
]


def upgrade() -> None:
    conn = op.get_bind()

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
