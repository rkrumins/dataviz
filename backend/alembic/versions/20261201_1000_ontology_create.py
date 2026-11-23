"""Who may create a semantic layer, and a layer's audit trail names what really happened.

* ``workspace:ontology:create`` — start a new semantic layer: a blank draft, a clone, or a file
  imported as a new layer. Until now ``workspace:ontology:manage`` decided it, so every role that
  holds manage today gets create too — the built-in ones that the seed grants it to, and every
  other role, custom or an edited built-in one — and upgrading takes nothing away from anyone.
  ``workspace:admin`` implies it in code.
* ``ontology_audit_log.ck_oal_action_enum`` also allows ``versioned`` (a new version of a layer)
  and ``approved`` (a workspace's layer approved for everyone). Both used to be written as
  something else — ``cloned`` and ``updated`` — so the entries already written are renamed: a
  ``cloned`` entry on a version that shares an earlier one's ``schema_id`` was a new version (a
  real copy starts a lineage of its own), and an ``updated`` one that says it approved was an
  approval. The constraint, and so the rename, is Postgres only, as in
  ``20261129_1100_oal_imported``: SQLite databases are built from the ORM.

``role_permissions`` is read on every sign-in, so the revision bounds its wait for locks.
Idempotent data. Downgrade names the entries as they were, restores the old list and removes the
permission with its grants.

Revision ID: 20261201_1000_ontology_create
Revises: 20261130_1100_merge_watch_told
Create Date: 2026-12-01 10:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261201_1000_ontology_create"
down_revision: Union[str, None] = "20261130_1100_merge_watch_told"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "workspace:ontology:create"
_MANAGE = "workspace:ontology:manage"
_DESCRIPTION = "Create new semantic layers: a blank draft, a clone, or an imported file."
_LONG_DESCRIPTION = (
    "Start a new semantic layer: a blank draft, one built from a graph, a clone of an existing "
    "layer, or an exported file imported as a new layer. Changing, versioning and publishing a "
    "layer still needs workspace:ontology:manage, so a role that creates layers holds both. "
    "Everyone who manages layers has it by default; take it away from a role to keep the set of "
    "layers fixed while its holders go on looking after the ones their workspaces use. A "
    "Playground member's own layers are made in the Playground and don't need it."
)
_EXAMPLES = [
    "Create a new draft semantic layer from a graph.",
    "Clone the system layer to customise it.",
    "Import an exported layer file as a new layer.",
]
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    (role, _PERMISSION) for role in ("org_admin", "super_admin", "workspace_data_engineer")
]

_TABLE = "ontology_audit_log"
_CHECK = "ck_oal_action_enum"
_OLD = "'created', 'updated', 'published', 'deleted', 'restored', 'cloned', 'imported'"
_NEW = _OLD + ", 'versioned', 'approved'"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``role_permissions`` is read on
    every sign-in, and giving up (to be run again) beats queueing them."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _swap(actions: str) -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT IF EXISTS {_CHECK}")
    op.execute(f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CHECK} CHECK (action IN ({actions}))")


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()
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
    # Whoever could create a layer yesterday (manage decided it) still can — a custom role, and a
    # built-in one an administrator gave manage to.
    conn.execute(
        sa.text(
            """
            INSERT INTO role_permissions (role_name, permission_id)
            SELECT rp.role_name, :perm
            FROM role_permissions rp
            WHERE rp.permission_id = :manage
            ON CONFLICT (role_name, permission_id) DO NOTHING
            """
        ),
        {"perm": _PERMISSION, "manage": _MANAGE},
    )

    if conn.dialect.name == "postgresql":
        _swap(_NEW)
        op.execute(f"UPDATE {_TABLE} SET action = 'versioned' "
                   "WHERE action = 'cloned' AND ontology_id <> schema_id")
        op.execute(f"UPDATE {_TABLE} SET action = 'approved' "
                   "WHERE action = 'updated' AND summary LIKE 'Approved v% for everyone'")


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute(f"UPDATE {_TABLE} SET action = 'cloned' WHERE action = 'versioned'")
        op.execute(f"UPDATE {_TABLE} SET action = 'updated' WHERE action = 'approved'")
        _swap(_OLD)
    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :perm"), {"perm": _PERMISSION},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})
