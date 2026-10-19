"""Layout templates: built-ins, soft delete, team sharing and their curator permission.

Templates are the ``context_models`` rows with ``is_template = true``. Until now
there were only global ones, seeded at startup and editable through a
``system:admin`` API with no UI. This revision gives them a lifecycle:

* ``context_models.system_key`` marks a **built-in** (product-owned, refreshed
  from ``seed_templates.py`` on every start, read-only). The four rows the old
  seeder wrote are adopted as built-ins: for each seeded name, the OLDEST row
  that has no key yet — never a second row for a key, so an admin's own
  "ETL Classic" made through the old API cannot break the unique index.
* ``deleted_at`` / ``deleted_by``: deleting a template is a soft delete, so the
  Undo puts back the same id with its shares and the views that name it.
* Every existing template becomes an **Organization** template
  (``visibility = 'enterprise'``): they were all visible to everyone before, and
  an admin-made one left at the column's ``private`` default would have become a
  template nobody owns or can see.
* ``resource_grants`` accepts ``resource_type = 'layout_template'`` — a template
  shared with a group is how a team gets its own.
* ``system:templates:manage`` — curate Organization templates and hide
  built-ins — for ``super_admin`` and ``org_admin``, exactly as
  ``rbac_seed.ROLE_GRANTS`` has it (``tests/test_rbac_migration.py`` holds the
  two paths together; pattern ``20260823_1200_analytics_perm``).

``resource_grants`` is read on every view access, so the revision bounds its
wait for locks (``_bound_lock_wait``) rather than queue that traffic behind a
long transaction. It runs after ``20261014_1200_aal_api_key``, which takes the
activity ledger's lock last on purpose: on a database upgrading through both in
one run, that lock is held for the moment this cheap revision takes too.

Guarded DDL (the columns exist on a ``create_all`` baseline), unguarded data.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261018_1200_layout_templates
Revises: 20261014_1200_aal_api_key
Create Date: 2026-10-18 12:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261018_1200_layout_templates"
down_revision: Union[str, None] = "20261014_1200_aal_api_key"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: (system_key, name) of the templates the old seeder wrote.
_LEGACY_BUILTINS: list[tuple[str, str]] = [
    ("data-engineering-flow", "Data Engineering Flow"),
    ("analytics-pipeline", "Analytics Pipeline"),
    ("data-mesh", "Data Mesh"),
    ("etl-classic", "ETL Classic"),
]

_PERMISSION = "system:templates:manage"
_DESCRIPTION = "Curate the organization's layout templates and the built-in ones."
_LONG_DESCRIPTION = (
    "Lets you publish, edit and delete layout templates offered to everyone in "
    "the organization, and hide or show the built-in starter templates for "
    "everyone. Deliberately SEPARATE from system:admin so curating the template "
    "library can be delegated to the people who own the house style, without "
    "handing them the platform. Workspace and personal templates follow their "
    "own rules: this grants no access to anyone's personal templates or to a "
    "workspace you are not otherwise in."
)
_EXAMPLES = [
    "Publish a team's medallion layout as an organization template.",
    "Hide a built-in template your organization does not use.",
]
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    ("org_admin", _PERMISSION),
    ("super_admin", _PERMISSION),
]


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock. ``resource_grants`` is read on
    every view access: a long transaction there makes this revision give up,
    to be run again, rather than queue every later read behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    for column in ("system_key", "deleted_at", "deleted_by"):
        op.add_column(
            "context_models", sa.Column(column, sa.Text(), nullable=True),
            if_not_exists=True,
        )

    conn.execute(sa.text(
        "UPDATE context_models SET visibility = 'enterprise' WHERE is_template = true"
    ))
    for key, name in _LEGACY_BUILTINS:
        conn.execute(
            sa.text(
                """
                UPDATE context_models SET system_key = :key
                WHERE id = (
                    SELECT id FROM context_models
                    WHERE is_template = true AND system_key IS NULL
                      AND workspace_id IS NULL AND name = :name
                    ORDER BY created_at, id
                    LIMIT 1
                )
                AND NOT EXISTS (SELECT 1 FROM context_models WHERE system_key = :key)
                """
            ),
            {"key": key, "name": name},
        )
    op.create_index(
        "uq_cm_system_key", "context_models", ["system_key"], unique=True,
        postgresql_where=sa.text("system_key IS NOT NULL"),
        if_not_exists=True,
    )

    op.execute("ALTER TABLE resource_grants DROP CONSTRAINT IF EXISTS ck_resource_grants_resource_type")
    op.create_check_constraint(
        "ck_resource_grants_resource_type", "resource_grants",
        "resource_type IN ('view', 'layout_template')",
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
            "category": "system",
            "long_description": _LONG_DESCRIPTION,
            "examples": json.dumps(_EXAMPLES),
        },
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

    conn.execute(sa.text("DELETE FROM resource_grants WHERE resource_type = 'layout_template'"))
    op.execute("ALTER TABLE resource_grants DROP CONSTRAINT IF EXISTS ck_resource_grants_resource_type")
    op.create_check_constraint(
        "ck_resource_grants_resource_type", "resource_grants", "resource_type IN ('view')",
    )

    conn.execute(sa.text("DELETE FROM role_permissions WHERE permission_id = :id"), {"id": _PERMISSION})
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})

    op.drop_index("uq_cm_system_key", table_name="context_models", if_exists=True)
    for column in ("deleted_by", "deleted_at", "system_key"):
        op.drop_column("context_models", column)
