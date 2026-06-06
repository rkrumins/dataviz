"""RBAC Phase 18 — workspace-scoped reads for ontology / provider / catalog.

Revision ID: 20260605_1200_phase18_workspace_reads
Revises: 20260603_1100_rbac_uplift
Create Date: 2026-06-05 12:00

Adds five new permissions so a workspace-bound user can **read** the
ontologies, providers, and catalog items their workspace touches —
without granting them the platform-admin write paths:

  * ``workspace:ontology:read``       — viewer / member / admin
  * ``workspace:ontology:manage``     — workspace_admin (via implication)
  * ``workspace:provider:read``       — viewer / member / admin
  * ``workspace:catalog:read``        — viewer / member / admin
  * ``workspace:catalog:manage``      — workspace_admin (via implication)

Provider ``manage`` is deliberately absent: provider rows carry
credentials, so create/edit/delete stays gated by ``system:admin``.

The ``workspace_admin`` role still stores only ``workspace:admin`` —
the resolver's auto-implication picks up the new manage leaves via the
extended ``_WORKSPACE_CATEGORY_LEAVES`` set in
``backend/app/services/permission_service.py``. We grant the new
**read** leaves explicitly to ``workspace_member`` / ``workspace_viewer``
in ``role_permissions`` so a session-build for those roles emits them
(viewer/member don't carry ``workspace:admin``).

For ``super_admin`` and ``org_admin``, we also grant the new perms
explicitly so the role-matrix admin UI displays them under those
roles (the global short-circuit already lets them through at request
time, but the explicit grant makes the audit and matrix views honest).

Idempotent: every INSERT uses ``ON CONFLICT DO NOTHING`` so re-running
the migration is a no-op.

Downgrade removes the role grants then the permission rows.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260605_1200_phase18_workspace_reads"
down_revision: Union[str, None] = "20260603_1100_rbac_uplift"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_PERMISSIONS: list[tuple[str, str, str]] = [
    # (id, category, description)
    (
        "workspace:ontology:read",
        "workspace",
        "Read ontologies (semantic layers) that the workspace's data sources reference.",
    ),
    (
        "workspace:ontology:manage",
        "workspace",
        "Create, edit, version, publish, and delete ontologies in the workspace.",
    ),
    (
        "workspace:provider:read",
        "workspace",
        "Read providers (database connections) that back the workspace's data sources.",
    ),
    (
        "workspace:catalog:read",
        "workspace",
        "Read catalog items (curated data assets) available to the workspace.",
    ),
    (
        "workspace:catalog:manage",
        "workspace",
        "Promote / edit / delete catalog items the workspace owns.",
    ),
]


_NEW_LONG_DESCRIPTIONS: dict[str, str] = {
    "workspace:ontology:read": (
        "Lets you view every ontology (entity types, relationships, "
        "versions, coverage) that any data source in your workspace is "
        "assigned to. You cannot create, edit, or publish ontologies."
    ),
    "workspace:ontology:manage": (
        "Lets you create new ontology drafts, edit definitions, "
        "version, publish, restore, clone, and delete ontologies "
        "within the workspaces you administer."
    ),
    "workspace:provider:read": (
        "Lets you see which providers (database connections) back the "
        "data sources in your workspace, including connection status "
        "and last-checked time. Credentials are NEVER returned. You "
        "cannot edit, test, or delete providers."
    ),
    "workspace:catalog:read": (
        "Lets you browse catalog items (curated, named data assets) "
        "available to your workspace, including provider links and "
        "binding state."
    ),
    "workspace:catalog:manage": (
        "Lets you promote raw provider namespaces into catalog items, "
        "edit their metadata, archive or delete them, within the "
        "workspaces you administer."
    ),
}


_NEW_EXAMPLES: dict[str, list[str]] = {
    "workspace:ontology:read": [
        "Open the Semantic Layers page and see the ontologies your "
        "workspace uses.",
        "Inspect entity/relationship definitions and coverage stats.",
    ],
    "workspace:ontology:manage": [
        "Create a new draft ontology.",
        "Publish a draft into a new immutable version.",
        "Delete an unused ontology.",
    ],
    "workspace:provider:read": [
        "Open the Ingestion → Providers tab and see the providers "
        "your workspace uses.",
        "Read the provider's status (ready / unavailable).",
    ],
    "workspace:catalog:read": [
        "Browse the catalog of curated data assets in the Ingestion "
        "page.",
    ],
    "workspace:catalog:manage": [
        "Promote a provider namespace into a catalog item.",
        "Archive a catalog item the workspace no longer needs.",
    ],
}


# Role -> permission_id rows we want to land. workspace_admin keeps its
# ``workspace:admin`` shorthand; the resolver auto-implies the new
# manage leaves via the extended ``_WORKSPACE_CATEGORY_LEAVES``.
_NEW_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    # Reads granted explicitly to every workspace-bound tier.
    ("workspace_viewer",  "workspace:ontology:read"),
    ("workspace_viewer",  "workspace:provider:read"),
    ("workspace_viewer",  "workspace:catalog:read"),
    ("workspace_member",  "workspace:ontology:read"),
    ("workspace_member",  "workspace:provider:read"),
    ("workspace_member",  "workspace:catalog:read"),
    # Global roles get every new perm explicitly so the role-matrix
    # admin UI shows the grants honestly (the short-circuit at request
    # time would have let them through anyway).
    ("org_admin",         "workspace:ontology:read"),
    ("org_admin",         "workspace:ontology:manage"),
    ("org_admin",         "workspace:provider:read"),
    ("org_admin",         "workspace:catalog:read"),
    ("org_admin",         "workspace:catalog:manage"),
    ("super_admin",       "workspace:ontology:read"),
    ("super_admin",       "workspace:ontology:manage"),
    ("super_admin",       "workspace:provider:read"),
    ("super_admin",       "workspace:catalog:read"),
    ("super_admin",       "workspace:catalog:manage"),
]


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Insert the new permission rows (with descriptions + examples).
    # NB on the API: use ``conn.execute(sa.text(...), {...})`` — NOT
    # ``conn.exec_driver_sql(...)``. The latter is the raw psycopg2
    # path; it expects ``%(name)s`` placeholders and crashes on
    # SQLAlchemy-style ``:name``. ``sa.text`` is what every other
    # migration in this codebase uses for parameterised INSERTs.
    import json as _json
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

    # 2. Grant the new perms to the appropriate roles.
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
    perm_ids = [p[0] for p in _NEW_PERMISSIONS]
    # role_permissions has FK CASCADE on permissions.id, so deleting
    # permissions also cleans the grants. Belt-and-suspenders: clear
    # the rows explicitly first so the downgrade is safe even if the
    # CASCADE policy is ever changed.
    for perm_id in perm_ids:
        conn.execute(
            sa.text("DELETE FROM role_permissions WHERE permission_id = :id"),
            {"id": perm_id},
        )
        conn.execute(
            sa.text("DELETE FROM permissions WHERE id = :id"),
            {"id": perm_id},
        )
