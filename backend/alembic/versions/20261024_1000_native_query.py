"""Native read-only queries: who may run them, and the per-share opt-in.

* ``workspace:native-query:read`` — run one's own read-only queries (Cypher,
  on FalkorDB and Neo4j) on a workspace's data sources. Granted to every
  system role that reads data sources — viewer, member, steward, data
  engineer, org admin, super admin; ``workspace:admin`` implies it in code and
  org auditors reach it as a ``:read`` permission. It is a new permission so
  an administrator can take it away from any role without touching data
  source access: every CUSTOM role that reads data sources gets it too, so
  upgrading takes nothing away from anyone who could read the data before.
* ``resource_grants.can_query_source`` — a view share that also lets its
  holder query the view's data source: off unless the person sharing ticks
  it, and only on view shares.

``role_permissions`` is read on every sign-in, so the revision bounds its
wait for locks. Guarded DDL (a ``create_all`` baseline already has it),
idempotent data. Revision id is kept <=32 chars (alembic_version.version_num
is VARCHAR(32)).

Revision ID: 20261024_1000_native_query
Revises: 20261023_1200_service_accounts
Create Date: 2026-10-24 10:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261024_1000_native_query"
down_revision: Union[str, None] = "20261023_1200_service_accounts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "workspace:native-query:read"
_DESCRIPTION = "Run your own read-only queries on a workspace's data sources."
_LONG_DESCRIPTION = (
    "Write a query in the data source's own language (Cypher, on FalkorDB and Neo4j) and run "
    "it, read-only, from the search panel. A query reads the whole data source, not only the "
    "view it was started from. Writes are refused, each run has row, time and size limits, "
    "and every run is recorded in the activity log. Readers of a workspace's data sources "
    "have it by default; an administrator can remove it from any role."
)
_EXAMPLES = [
    "Run MATCH (d:Dataset)-[:TRANSFORMS]->(t) RETURN d, t LIMIT 50 from the Cypher tab",
    "Copy the Cypher a search runs as, change it, and run it",
]
_ROLE_PERMISSIONS: list[tuple[str, str]] = [
    (role, _PERMISSION) for role in (
        "org_admin",
        "super_admin",
        "workspace_data_engineer",
        "workspace_member",
        "workspace_steward",
        "workspace_viewer",
    )
]
_CHECK = "ck_resource_grants_source_query"


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``role_permissions`` is read on
    every sign-in, and giving up (to be run again) beats queueing them."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    op.add_column(
        "resource_grants",
        sa.Column("can_query_source", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        if_not_exists=True,
    )
    op.execute(f"ALTER TABLE resource_grants DROP CONSTRAINT IF EXISTS {_CHECK}")
    op.create_check_constraint(
        _CHECK, "resource_grants", "can_query_source = false OR resource_type = 'view'",
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
    # Custom roles: whoever reads data sources today keeps being able to
    # read them their own way after the upgrade.
    conn.execute(
        sa.text(
            """
            INSERT INTO role_permissions (role_name, permission_id)
            SELECT rp.role_name, :perm
            FROM role_permissions rp
            JOIN roles r ON r.name = rp.role_name
            WHERE rp.permission_id = 'workspace:datasource:read' AND r.is_system = FALSE
            ON CONFLICT (role_name, permission_id) DO NOTHING
            """
        ),
        {"perm": _PERMISSION},
    )


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()
    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :perm"), {"perm": _PERMISSION},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})
    op.execute(f"ALTER TABLE resource_grants DROP CONSTRAINT IF EXISTS {_CHECK}")
    op.drop_column("resource_grants", "can_query_source")
