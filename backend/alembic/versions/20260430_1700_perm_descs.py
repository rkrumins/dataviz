"""RBAC Phase 4.1 — plain-English permission descriptions.

Revision ID: 20260430_1700_perm_descs
Revises: 20260430_1500_roles_lifecycle
Create Date: 2026-04-30 17:00

Adds ``long_description`` and ``examples`` columns to the
``permissions`` table and backfills them for the eleven Phase-1
seeded permissions. The two new fields drive the
``PermissionTooltip`` UX added in 4.1: hovering any permission row in
the admin Permissions surface reveals a paragraph explanation + 2-3
concrete example actions, replacing the cryptic id like
``workspace:view:edit`` with something an auditor can read.

``examples`` is stored as a JSON-encoded TEXT blob to match the rest
of the schema's "JSON in TEXT" convention (see ``extra_config``,
``layers_config`` etc. in ``models.py``). The repo decodes it.

Naming note (production incident, 2026-04-30): an earlier draft used
the revision id ``20260430_1700_permission_descriptions`` (37 chars).
``alembic_version.version_num`` defaults to ``VARCHAR(32)`` in
Postgres; the migration's DDL applied cleanly but the final
``UPDATE alembic_version`` to stamp the new id failed with
``StringDataRightTruncation``, leaving the schema partially stamped
(columns + backfill present, version_num still pointing at
``20260430_1500_roles_lifecycle``). The shorter id keeps everything
under 32 chars. The migration is idempotent — re-running it against
a half-stamped DB no-ops the column-adds, repeats the (deterministic)
backfill UPDATEs, and the version stamp succeeds.

Idempotent on every step (column-add guard + UPDATE-not-INSERT for
the backfill) so partial reruns are safe.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260430_1700_perm_descs"
down_revision: Union[str, None] = "20260430_1500_roles_lifecycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (permission_id, long_description, [examples...])
_PERMISSION_DETAILS: list[tuple[str, str, list[str]]] = [
    (
        "system:admin",
        "Full administrative authority over the entire platform — implies every other "
        "permission. Reserved for trusted operators who oversee global configuration "
        "and security.",
        [
            "Manage every workspace's settings",
            "Change any user's role from User to Admin",
            "Create and delete workspaces",
            "Override every other permission check",
        ],
    ),
    (
        "users:manage",
        "Create, approve, suspend, and change roles for user accounts. Required to "
        "invite new users, complete signup approvals, and recover compromised accounts.",
        [
            "Approve new signups",
            "Change a user's role from User to Admin",
            "Suspend a compromised account",
            "Reset a user's password",
        ],
    ),
    (
        "groups:manage",
        "Create groups, manage their members, and delete groups. Use groups to grant "
        "the same role to many users at once via group bindings.",
        [
            "Create a 'Marketing' group and add ten users",
            "Bind the group as Editor in three workspaces",
            "Remove a user from a group when they leave the team",
        ],
    ),
    (
        "workspaces:create",
        "Mint new workspaces. The creator becomes the workspace's first admin and "
        "inherits the right to manage its data sources and members.",
        [
            "Create a new workspace for a project",
            "Spin up a sandbox workspace for a proof-of-concept",
        ],
    ),
    (
        "workspace:admin",
        "Full administrative authority within a single workspace — settings, members, "
        "deletion, and all data inside. Doesn't grant access to other workspaces.",
        [
            "Edit the workspace's name and description",
            "Add or revoke workspace members",
            "Delete the workspace",
            "Hard-delete views authored by other members",
        ],
    ),
    (
        "workspace:datasource:manage",
        "Connect new data sources, edit their configuration, and remove them from a "
        "workspace. Required for workspace setup and ongoing maintenance.",
        [
            "Connect a new FalkorDB graph",
            "Change the ontology assigned to a data source",
            "Delete a data source from the workspace",
        ],
    ),
    (
        "workspace:datasource:read",
        "List the data sources attached to a workspace and use them in views. "
        "Doesn't allow modification.",
        [
            "See which data sources are connected to the workspace",
            "Pick a data source when creating a new view",
            "Read cached statistics for a data source",
        ],
    ),
    (
        "workspace:view:create",
        "Create new views in a workspace. Doesn't grant the right to edit or delete "
        "views authored by other members — that requires `workspace:view:edit` / "
        "`workspace:view:delete`.",
        [
            "Create a new graph view",
            "Save a draft view as private",
            "Create an analytical dashboard",
        ],
    ),
    (
        "workspace:view:edit",
        "Edit any view in this workspace, including views authored by other workspace "
        "members. Cannot delete views — that requires `workspace:view:delete`.",
        [
            "Update an existing view's configuration",
            "Rename a view someone else created",
            "Change a view's data source",
        ],
    ),
    (
        "workspace:view:delete",
        "Soft-delete any view in this workspace. Hard-delete (`permanent=true`) "
        "requires `workspace:admin`. The view's creator can always delete their own "
        "work regardless of this permission.",
        [
            "Soft-delete an obsolete view",
            "Clean up old draft views",
            "Remove a colleague's deprecated dashboard",
        ],
    ),
    (
        "workspace:view:read",
        "List and open views in a workspace. Read-only — doesn't allow editing or "
        "managing explicit shares.",
        [
            "Browse the workspace's views catalogue",
            "Open a graph view to inspect the data",
            "Export a view as JSON",
        ],
    ),
]


def _has_column(inspector, table: str, column: str) -> bool:
    return any(c["name"] == column for c in inspector.get_columns(table))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_column(inspector, "permissions", "long_description") is False:
        op.add_column("permissions", sa.Column("long_description", sa.Text(), nullable=True))
    if _has_column(inspector, "permissions", "examples") is False:
        # JSON stored as TEXT to match the schema convention used throughout
        # the codebase (see models.py — extra_config, layers_config, etc).
        op.add_column("permissions", sa.Column("examples", sa.Text(), nullable=True))

    # Backfill the 11 system permissions.
    for pid, long_desc, examples in _PERMISSION_DETAILS:
        bind.execute(
            sa.text(
                "UPDATE permissions SET long_description = :ld, examples = :ex "
                "WHERE id = :id"
            ),
            {"ld": long_desc, "ex": json.dumps(examples), "id": pid},
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector, "permissions", "examples"):
        op.drop_column("permissions", "examples")
    if _has_column(inspector, "permissions", "long_description"):
        op.drop_column("permissions", "long_description")
